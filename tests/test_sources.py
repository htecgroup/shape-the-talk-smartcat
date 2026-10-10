"""Pluggable utterance sources: scripted meeting and live mic share one pipeline (agents faked)."""

import asyncio
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from whiteboard import agents, recording, session as session_mod, sources  # noqa: E402
from whiteboard.agents import CallResult  # noqa: E402
from whiteboard.audio import float_to_pcm16  # noqa: E402
from whiteboard.session import Session  # noqa: E402
from whiteboard.sources import MicSource, is_meaningless, mic_meeting  # noqa: E402


class FakeWS:
    def __init__(self):
        self.events = []

    async def send_text(self, data):
        self.events.append(json.loads(data))


@pytest.fixture
def fake_pipeline(monkeypatch, tmp_path):
    calls = {"extract": [], "model": [], "meetings": []}

    async def extract(meeting, context, utt):
        calls["extract"].append(utt["text"])
        calls["meetings"].append(meeting)
        kind = "undo" if "scratch that" in utt["text"].lower() else "new_info"
        return CallResult({"kind": kind, "claims": [utt["text"]], "refers_to": None, "topic_shift": False}, 1)

    async def model(meeting, compact, window, items):
        calls["model"].append([i["utt"]["id"] for i in items])
        ops = [] if compact["boards"] else [{"op": "new_board", "id": "b", "title": "B", "kind": "process", "src": items[0]["utt"]["id"]}]
        for i in items:
            ops.append({"op": "add_node", "id": f"n_{i['utt']['id']}", "label": i["utt"]["text"][:20], "type": "step",
                        "status": "confirmed", "group": None, "note": None, "src": i["utt"]["id"]})
        return CallResult({"summary": "ok", "ops": ops}, 1)

    async def analyse(*a, **k):
        return CallResult({"open_questions": [], "disagreements": [], "suggested_marks": []}, 1)

    async def consolidate(meeting, transcript, compact):
        calls.setdefault("consolidate", []).append(transcript[-1]["id"])
        return CallResult({"summary": "No cleanup needed", "ops": []}, 1)

    async def warmup():
        return None

    monkeypatch.setattr(agents, "extract", extract)
    monkeypatch.setattr(agents, "model", model)
    monkeypatch.setattr(agents, "analyse", analyse)
    monkeypatch.setattr(agents, "consolidate", consolidate)
    monkeypatch.setattr(agents, "warmup", warmup)
    monkeypatch.setattr(recording, "RUNS_DIR", tmp_path)
    return calls


class FakeTranscriber:
    instances = []

    def __init__(self, on_event, fail=False):
        self.on_event, self.fail = on_event, fail
        self.model, self.segmentation = "fake-live", "local"
        self.open = False
        self.appended = 0
        self.commits = 0
        FakeTranscriber.instances.append(self)

    async def connect(self):
        if self.fail:
            from whiteboard.stt import UpstreamError
            raise UpstreamError("nope")
        self.open = True

    async def append(self, pcm):
        self.appended += len(pcm)

    async def commit(self):
        self.commits += 1

    async def close(self):
        self.open = False


async def wait_for(cond, timeout=3.0):
    for _ in range(int(timeout / 0.01)):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition not reached")


async def start_mic(s: Session, **kw) -> MicSource:
    res = await s.start("mic", speaker=kw.get("speaker", "Ana"), topic=kw.get("topic"))
    assert res["ok"]
    mic = s.source
    mic.factory = lambda on_event: FakeTranscriber(on_event)
    assert await mic.connect()
    return mic


def delta(item, text):
    return {"type": "conversation.item.input_audio_transcription.delta", "item_id": item, "delta": text}


def completed(item, text):
    return {"type": "conversation.item.input_audio_transcription.completed", "item_id": item, "transcript": text}


def test_mic_meeting_context():
    m = mic_meeting("  ", "")
    assert m["participants"][0]["name"] == "You" and m["source"] == "mic"
    assert m["title"] == "Talk live" and "Infer" in m["topic"]
    m = mic_meeting("Ana", "coffee ordering")
    assert m["title"] == "Talk live: coffee ordering" and m["topic"] == "coffee ordering"
    assert agents.is_live_speech(m) and not agents.is_live_speech(session_mod.load_meeting())


def test_meaningless_transcripts_are_dropped():
    assert is_meaningless("") and is_meaningless("  Um. ") and is_meaningless("Okay.")
    assert not is_meaningless("Okay, the app sends the order") and not is_meaningless("Stripe")


def test_mic_interim_final_order_and_pipeline(fake_pipeline):
    async def run():
        s = Session()
        viewer = FakeWS()
        s.clients.add(viewer)
        mic = await start_mic(s, topic="coffee")
        assert s.mode == "mic" and mic.state == "listening"
        await mic.handle_event(delta("itA", "The customer"))
        await mic.handle_event(delta("itA", " opens the app"))
        await mic.handle_event(delta("itB", "Then checkout"))
        await mic.handle_event(completed("itB", "Then checkout."))          # B completes first ...
        assert [u["id"] for u in s.spoken] == []                            # ... but must wait for A
        await mic.handle_event(completed("itA", "The customer opens the app."))
        assert [u["text"] for u in s.spoken] == ["The customer opens the app.", "Then checkout."]
        assert [u["id"] for u in s.spoken] == ["m001", "m002"]
        await mic.handle_event(delta("itC", "um"))
        await mic.handle_event(completed("itC", "Um."))                    # noise: dropped, not modelled
        await wait_for(lambda: s.board.version >= 1 and not s.pending)
        await mic.stop()
        await wait_for(lambda: s.status == "finished")
        types = [e["type"] for e in viewer.events]
        assert "utterance_interim" in types and "utterance_drop" in types
        interim = [e for e in viewer.events if e["type"] == "utterance_interim" and e["id"] == "m001"]
        assert interim[-1]["text"] == "The customer opens the app"
        final = [e for e in viewer.events if e["type"] == "utterance_final"]
        assert [e["text"] for e in final] == ["The customer opens the app.", "Then checkout."]
        nodes = s.board.boards[s.board.active]["nodes"]
        assert set(nodes) == {"n_m001", "n_m002"} and nodes["n_m001"]["by"] == "Ana"
        assert fake_pipeline["meetings"][0]["source"] == "mic"
        assert not any(t["type"] == "mic_state" for t in s.timeline)        # UI-only events are not recorded
        return s.run_file

    run_file = asyncio.run(run())
    saved = json.loads((recording.RUNS_DIR / run_file).read_text())
    assert saved["meta"]["source"] == "mic" and saved["meta"]["complete"]
    assert saved["meeting"]["title"] == "Talk live: coffee"
    assert any(e["type"] == "utterance_interim" for e in saved["events"])   # replay shows text streaming in
    assert recording.list_runs()[0]["source"] == "mic"


def test_mic_continue_after_stop_keeps_board(fake_pipeline):
    async def run():
        s = Session()
        mic = await start_mic(s)
        await mic.handle_event(completed("itA", "The customer opens the app."))
        await wait_for(lambda: s.board.version >= 1 and not s.pending)
        await mic.stop()
        await wait_for(lambda: s.status == "finished")
        first_file = s.run_file

        assert not (await Session().continue_mic())["ok"]                  # nothing to continue on a fresh session
        res = await s.continue_mic()
        assert res["ok"] and s.status == "running" and s.source is mic
        assert await mic.connect() and mic.state == "listening"
        await mic.handle_event(completed("itB", "Then checkout."))
        assert [u["id"] for u in s.spoken] == ["m001", "m002"]             # ids keep counting
        await wait_for(lambda: not s.pending and "n_m002" in s.board.boards[s.board.active]["nodes"])
        await mic.stop()
        await wait_for(lambda: s.status == "finished")
        assert set(s.board.boards[s.board.active]["nodes"]) == {"n_m001", "n_m002"}
        assert s.run_file == first_file                                     # same run file, saved again
        assert [e["type"] for e in s.timeline].count("meeting") == 1
        return s.run_file

    run_file = asyncio.run(run())
    saved = json.loads((recording.RUNS_DIR / run_file).read_text())
    assert [e["id"] for e in saved["events"] if e["type"] == "utterance_final"] == ["m001", "m002"]
    assert len(list(recording.RUNS_DIR.glob("*.json"))) == 1


def test_mic_vad_commits_and_stop_flushes_last_utterance(fake_pipeline):
    async def run():
        s = Session()
        mic = await start_mic(s)
        tr = FakeTranscriber.instances[-1]
        # 1 s of syllable-like voice: 160 ms loud, 60 ms quiet
        voice = float_to_pcm16([(0.3 if (i // 40) % 2 else -0.3) * (1 if i % 5280 < 3840 else 0.01) for i in range(24000)])
        await mic.feed(voice)
        await mic.feed(b"\x00\x00" * 24000)                                # 1 s silence -> VAD commit
        assert tr.commits == 1 and tr.appended == 96000
        await mic.handle_event({"type": "input_audio_buffer.committed", "item_id": "it1"})
        await mic.handle_event(completed("it1", "First thought about the order flow."))
        await mic.feed(voice)                                               # still talking when stop is pressed
        await mic.handle_event(delta("it2", "and the barista"))

        async def finish_later():
            await asyncio.sleep(0.05)
            await mic.handle_event({"type": "input_audio_buffer.committed", "item_id": "it2"})
            await mic.handle_event(completed("it2", "And the barista gets a tablet."))
        asyncio.create_task(finish_later())
        await mic.stop()                                                    # commits + waits for it2
        assert tr.commits == 2 and not tr.open and mic.state == "stopped"
        await wait_for(lambda: s.status == "finished")
        assert [u["text"] for u in s.spoken] == ["First thought about the order flow.", "And the barista gets a tablet."]
        assert s.utt_timing["m001"]["speech_end_t"] is not None
        lat = recording.mic_latency(s.utt_timing)
        assert lat["speech_end_to_final"]["n"] == 2

    asyncio.run(run())


def test_mic_upstream_loss_keeps_interim_text_and_can_reconnect(fake_pipeline):
    async def run():
        s = Session()
        mic = await start_mic(s)
        await mic.handle_event(delta("it1", "Payment goes through Stripe"))
        await mic.handle_event({"type": "upstream.closed", "code": 1011, "reason": "server error"})
        assert mic.state == "error" and "1011" in mic.error
        assert [u["text"] for u in s.spoken] == ["Payment goes through Stripe"]   # not lost
        assert s.status == "running"                                                # board survives
        await mic.feed(b"\x01\x00" * 2400)                                          # ignored while in error
        assert await mic.connect()                                                  # "Reconnect mic"
        assert mic.state == "listening"
        await mic.handle_event(completed("it9", "Then the order service."))
        assert [u["id"] for u in s.spoken] == ["m001", "m002"]
        await s.reset()                                                             # reset closes upstream
        assert not FakeTranscriber.instances[-1].open

    asyncio.run(run())


def test_mic_connect_failure_reports_error(fake_pipeline):
    async def run():
        s = Session()
        await s.start("mic", speaker="Ana")
        states = []

        async def on_state(st):
            states.append(st["state"])
        s.source.on_state = on_state
        s.source.factory = lambda on_event: FakeTranscriber(on_event, fail=True)
        assert not await s.source.connect()
        assert states == ["connecting", "error"] and s.source.error == "nope"
        await s.reset()

    asyncio.run(run())


def test_scripted_source_uses_same_pipeline(fake_pipeline, monkeypatch):
    meeting = {"id": "t", "title": "T", "topic": "x", "participants": [{"name": "Ana", "role": "r", "color": "#000"}],
               "utterances": [{"id": "u01", "speaker": "Ana", "text": "one two", "pause": 0},
                              {"id": "u02", "speaker": "Ana", "text": "three", "pause": 0}]}
    monkeypatch.setattr(session_mod, "load_meeting", lambda: meeting)

    async def run():
        s = Session()
        assert (await s.start("live", speed=16))["ok"]
        assert isinstance(s.source, sources.ScriptedSource)
        await wait_for(lambda: s.status == "finished", 10)
        assert set(s.board.boards["b"]["nodes"]) == {"n_u01", "n_u02"}
        assert s.timeline[0]["type"] == "meeting"
        assert "mic" not in json.loads((recording.RUNS_DIR / s.run_file).read_text())["meta"]["latency"]

    asyncio.run(run())
