"""Stream an audio file into talk-live mode as if it were the microphone.

It uses the same /ws/mic endpoint as the browser (PCM16 mono 24 kHz, 50 ms chunks at real-time
pace) and listens on /ws like a viewer, then reports what arrived and the measured latencies:

  speech end -> transcript final      (true speech ends are found in the file by an energy detector)
  speech end -> board updated         (first board event that applied an op from that utterance)

uv run uvicorn server:app --port 8010              # in another terminal
uv run python scripts/feed_audio.py                # data/test_audio/coffee_monologue.wav
uv run python scripts/feed_audio.py my.wav --topic "coffee shop ordering" --url ws://localhost:8011
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
import wave
from array import array
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import websockets  # noqa: E402

from whiteboard.audio import TARGET_RATE, Resampler, float_to_pcm16, rms_pcm16  # noqa: E402

CHUNK_S = 0.05


def load_pcm24k(path: Path) -> bytes:
    with wave.open(str(path)) as w:
        ch, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise SystemExit("only 16-bit WAV files are supported")
    a = array("h")
    a.frombytes(raw)
    if ch > 1:
        a = array("h", [int(sum(a[i:i + ch]) / ch) for i in range(0, len(a), ch)])
    if rate == TARGET_RATE:
        return a.tobytes()
    rs = Resampler(rate, TARGET_RATE)
    return float_to_pcm16(rs.process([x / 32768 for x in a]))


def speech_segments(pcm: bytes, min_gap_s: float = 0.6, thr: float = 300) -> list[tuple[float, float]]:
    """True speech segments in the file (20 ms frames, gaps >= min_gap_s split segments)."""
    frame = int(TARGET_RATE * 0.02) * 2
    segs, start, last = [], None, 0.0
    for k in range(0, len(pcm) - frame, frame):
        t = k / 2 / TARGET_RATE
        if rms_pcm16(pcm[k:k + frame]) > thr:
            if start is None:
                start = t
            last = t + 0.02
        elif start is not None and t - last >= min_gap_s:
            segs.append((start, last))
            start = None
    if start is not None:
        segs.append((start, last))
    return segs


async def main(a: argparse.Namespace) -> None:
    pcm = load_pcm24k(Path(a.file))
    segs = speech_segments(pcm)
    print(f"audio {len(pcm) / 2 / TARGET_RATE:.1f}s, {len(segs)} speech segments in the file")

    seen: list[tuple[float, dict]] = []      # (wall time, event) from the viewer socket
    done = asyncio.Event()
    run_file: list[str] = []
    viewer = await websockets.connect(f"{a.url}/ws", max_size=None)

    async def watch() -> None:
        async for raw in viewer:
            ev = json.loads(raw)
            now = time.perf_counter()
            seen.append((now, ev))
            t = ev.get("type")
            if t == "utterance_interim" and a.verbose:
                print(f"   … {ev['id']}: {ev['text'][-90:]}")
            elif t == "utterance_final":
                print(f"[{now - t_start:6.2f}s] FINAL {ev['id']} (server stt {ev.get('stt_ms')} ms): {ev.get('text')}")
            elif t == "activity" and ev["item"]["agent"] == "extractor":
                it = ev["item"]
                print(f"           extractor {it['utts'][0]} {it['kind']}{' refers_to=' + it['refers_to'] if it.get('refers_to') else ''}")
            elif t == "activity" and ev["item"]["agent"] in ("modeller", "analyst"):
                it = ev["item"]
                ops = [o["op"] + ":" + str(o.get("id") or o.get("edge") or o.get("target") or o.get("target_src") or
                                          f"{o.get('from')}->{o.get('to')}") for o in it.get("ops", [])]
                rej = [r["error"][:60] for r in it.get("rejected", [])]
                print(f"[{now - t_start:6.2f}s] {it['agent']} {','.join(it.get('utts', []))} {it.get('latency_ms')}ms "
                      f"| {it.get('summary', '')} | {ops}{' REJECTED ' + str(rej) if rej else ''}")
            elif t == "mic_state":
                print(f"[{now - t_start:6.2f}s] mic {ev['state']} {ev.get('error') or ''}")
            elif t == "run_saved":
                run_file.append(ev["file"])
                done.set()

    t_start = time.perf_counter()
    watcher = asyncio.create_task(watch())
    async with websockets.connect(f"{a.url}/ws/mic", max_size=None) as mic:
        await mic.send(json.dumps({"type": "start", "speaker": a.speaker, "topic": a.topic}))
        while True:   # wait until the upstream session is open
            ev = json.loads(await mic.recv())
            if ev["type"] == "error" or ev.get("state") == "error":
                raise SystemExit(f"start refused: {ev}")
            if ev.get("state") == "listening":
                break
        t_start = time.perf_counter()     # audio clock starts with the first chunk
        step = int(TARGET_RATE * CHUNK_S) * 2
        for i in range(0, len(pcm), step):
            await mic.send(pcm[i:i + step])
            await asyncio.sleep(max(0.0, t_start + (i + step) / 2 / TARGET_RATE - time.perf_counter()))
        print(f"[{time.perf_counter() - t_start:6.2f}s] audio sent, stopping (flush)")
        await mic.send(json.dumps({"type": "stop"}))
        async for raw in mic:
            if json.loads(raw).get("state") == "stopped":
                break
    try:
        await asyncio.wait_for(done.wait(), a.timeout)
    except asyncio.TimeoutError:
        print("!! run was not saved in time")
    watcher.cancel()
    await viewer.close()

    # ------------------------------------------------------------- latency report
    ends = [e for _, e in segs]

    def speech_end_before(wall: float) -> float | None:
        audio_t = wall - t_start
        prior = [e for e in ends if e <= audio_t]
        return prior[-1] if prior else None

    finals, interim_before_end, interims = {}, 0, 0
    first_interim = {}
    for wall, ev in seen:
        if ev.get("type") == "utterance_interim":
            interims += 1
            first_interim.setdefault(ev["id"], wall)
        if ev.get("type") == "utterance_final":
            finals.setdefault(ev["id"], (wall, speech_end_before(wall)))   # a later one only fixes the text on screen
    for uid, wall in first_interim.items():
        if uid in finals and finals[uid][1] is not None and (wall - t_start) < finals[uid][1]:
            interim_before_end += 1
    stt = [int((w - t_start - e) * 1000) for w, e in finals.values() if e is not None]
    board = {}
    for wall, ev in seen:
        if ev.get("type") == "board":
            for op in ev.get("applied", []):
                board.setdefault(op.get("src"), wall)
    e2e = [int((board[u] - t_start - e) * 1000) for u, (w, e) in finals.items() if u in board and e is not None]
    f2b = [int((board[u] - w) * 1000) for u, (w, e) in finals.items() if u in board]

    def stat(v):
        return f"n={len(v)} median={statistics.median(v):.0f} ms min={min(v)} max={max(v)}" if v else "n/a"

    print("\n================ LATENCY (measured by this client) ================")
    print(f"interim events: {interims}; utterances whose first interim text arrived before their speech ended: "
          f"{interim_before_end}/{len(finals)}")
    print("speech end -> transcript final :", stat(stt), stt)
    print("transcript final -> board      :", stat(f2b))
    print("speech end -> board updated    :", stat(e2e), e2e)
    if run_file:
        from scripts.simulate import describe  # noqa: E402
        path = ROOT / "runs" / run_file[0]
        print(f"\nrun saved: {path}")
        describe(path)
        mic_lat = json.loads(path.read_text())["meta"]["latency"].get("mic", {})
        print("\nserver-side mic latency:", json.dumps({k: v for k, v in mic_lat.items() if k != "per_utterance"}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("file", nargs="?", default=str(ROOT / "data/test_audio/coffee_monologue.wav"))
    ap.add_argument("--url", default="ws://localhost:8010")
    ap.add_argument("--speaker", default="Alex")
    ap.add_argument("--topic", default="")
    ap.add_argument("--timeout", type=float, default=60)
    ap.add_argument("-v", "--verbose", action="store_true", help="print interim text too")
    asyncio.run(main(ap.parse_args()))
