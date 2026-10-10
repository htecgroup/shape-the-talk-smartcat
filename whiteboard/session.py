"""Meeting session: agent pipeline, broadcasting, record & replay.

Utterances come from a pluggable source (whiteboard/sources.py): the scripted mock
meeting ("live" mode) or the browser microphone ("mic" mode). Both feed the same
pipeline through `submit_utterance()`.

One global session drives the demo. Every event that reaches the browser goes
through `emit()`, which (a) folds it into a snapshot for late-joining clients,
(b) appends it to the run timeline, and (c) pushes it to all WebSockets.
Replay just re-emits a recorded timeline, so it makes no API calls.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from . import agents
from .board import BoardState
from .sources import MicSource, ScriptedSource, mic_meeting

log = logging.getLogger("session")

ROOT = Path(__file__).resolve().parents[1]
RUNS_DIR = ROOT / "runs"
DATA_DIR = ROOT / "data"

MAX_BATCH = 6               # max utterances per modeller call when a backlog builds
ANALYST_EVERY = 4           # meaningful utterances between analyst runs
WINDOW = 8                  # previous meaningful utterances shown to the modeller


def load_meeting(path: Path | None = None) -> dict:
    path = path or sorted(DATA_DIR.glob("meeting_*.json"))[0]
    return json.loads(path.read_text())


def list_runs() -> list[dict]:
    RUNS_DIR.mkdir(exist_ok=True)
    out = []
    for p in sorted(RUNS_DIR.glob("*.json"), reverse=True):
        try:
            meta = json.loads(p.read_text()).get("meta", {})
        except Exception:
            continue
        out.append({"file": p.name, "complete": meta.get("complete", False),
                    "speed": meta.get("speed"), "title": meta.get("title"),
                    "source": meta.get("source", "scripted"), "events": meta.get("event_count")})
    return out


class Clock:
    """Virtual meeting clock with speed and pause."""

    def __init__(self) -> None:
        self.speed = 1.0
        self.paused = False
        self._resume = asyncio.Event()
        self._resume.set()

    def pause(self) -> None:
        self.paused = True
        self._resume.clear()

    def resume(self) -> None:
        self.paused = False
        self._resume.set()

    async def sleep(self, seconds_at_1x: float) -> None:
        remaining = seconds_at_1x
        while remaining > 0:
            if self.paused:
                await self._resume.wait()
                continue
            step = min(0.05, remaining / self.speed)
            await asyncio.sleep(step)
            remaining -= step * self.speed


class Session:
    def __init__(self) -> None:
        self.clients: set[Any] = set()
        self.meeting = load_meeting()
        self._tasks: list[asyncio.Task] = []
        self._reset_state()

    # ------------------------------------------------------------------ state
    def _reset_state(self) -> None:
        self.mode = "idle"          # idle | live (scripted meeting) | mic (talk live) | replay
        self.status = "idle"        # idle | running | paused | finished
        self.clock = Clock()
        self.board = BoardState()
        self.spoken: list[dict] = []
        self.extractions: dict[str, dict] = {}
        self.pending: list[tuple[dict, asyncio.Task]] = []
        self.pending_event = asyncio.Event()
        self.speech_done = False
        self.analyst_task: asyncio.Task | None = None
        self.meaningful_since_analysis = 0
        self.questions: list[dict] = []
        self.disagreements: list[dict] = []
        # client snapshot view (built from emitted events, works for live and replay)
        self.view_transcript: list[dict] = []
        self.view_activity: list[dict] = []
        self.view_board: dict = self.board.to_dict()
        self.timeline: list[dict] = []
        self.t0 = time.perf_counter()
        self.run_file: str | None = None
        self.replay_name: str | None = None
        self.source: ScriptedSource | MicSource | None = None
        self.utt_timing: dict[str, dict] = {}   # mic mode: speech end / final / board times per utterance

    def snapshot(self) -> dict:
        return {
            "type": "snapshot", "mode": self.mode, "status": self.status, "speed": self.clock.speed,
            "meeting": self._meeting_public(), "transcript": self.view_transcript,
            "activity": self.view_activity[-150:], "board": self.view_board,
            "questions": self.questions, "disagreements": self.disagreements,
            "runs": list_runs(), "replay_name": self.replay_name, "model": agents.MODEL,
            "mic": self.source.public_state() if self.source else None,
        }

    def _meeting_public(self) -> dict:
        m = self.meeting
        return {"id": m.get("id"), "title": m["title"], "topic": m.get("topic"), "source": m.get("source", "scripted"),
                "participants": m["participants"], "total": len(m.get("utterances", []))}

    # -------------------------------------------------------------- broadcast
    async def emit(self, event: dict, record: bool = True) -> None:
        if "t" not in event:
            event["t"] = round(time.perf_counter() - self.t0, 3)
        self._reduce(event)
        if record and self.mode in ("live", "mic"):
            self.timeline.append(event)
        await self._send_all(event)

    async def _send_all(self, event: dict) -> None:
        dead = []
        data = json.dumps(event, ensure_ascii=False, default=str)
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    def _reduce(self, ev: dict) -> None:
        t = ev["type"]
        if t == "utterance_start":
            self.view_transcript.append({**ev["utt"], "done": False, "kind": None, "live": ev.get("live", False)})
        elif t == "utterance_interim":
            for u in self.view_transcript:
                if u["id"] == ev["id"]:
                    u["text"] = ev["text"]
        elif t == "utterance_final":
            for u in self.view_transcript:
                if u["id"] == ev["id"]:
                    u["done"] = True
                    if "text" in ev:
                        u["text"] = ev["text"]
        elif t == "utterance_drop":
            self.view_transcript = [u for u in self.view_transcript if u["id"] != ev["id"]]
        elif t == "extraction":
            for u in self.view_transcript:
                if u["id"] == ev["id"]:
                    u["kind"] = ev["kind"]
        elif t == "activity":
            self.view_activity.append(ev["item"])
        elif t == "board":
            self.view_board = ev["board"]
        elif t == "analysis":
            self.questions = ev["questions"]
            self.disagreements = ev["disagreements"]
        elif t == "status":
            self.status = ev["status"]

    async def emit_status(self) -> None:
        await self.emit({"type": "status", "status": self.status, "mode": self.mode,
                         "speed": self.clock.speed, "replay_name": self.replay_name}, record=False)

    # --------------------------------------------------------------- controls
    async def start(self, mode: str = "live", run: str | None = None, speed: float | None = None,
                    speaker: str | None = None, topic: str | None = None) -> dict:
        if self.status in ("running", "paused"):
            return {"ok": False, "error": "already running; reset first"}
        await self.reset(broadcast=False)
        if speed and mode != "mic":
            self.clock.speed = float(speed)
        if mode == "replay":
            path = self._resolve_run(run or "latest")
            if path is None:
                return {"ok": False, "error": "no recorded runs found"}
            data = json.loads(path.read_text())
            self.meeting = data.get("meeting", self.meeting)
            self.mode, self.replay_name = "replay", path.name
            self.status = "running"
            await self._send_all(self.snapshot())
            self._tasks = [asyncio.create_task(self._run_replay(data["events"]))]
        else:
            if mode == "mic":
                self.meeting = mic_meeting(speaker, topic)
                self.source = MicSource(self.meeting["participants"][0]["name"], topic)
                self.source.session = self      # the browser can connect before run() starts
                self.mode = "mic"
            else:
                self.meeting = load_meeting()
                self.source = ScriptedSource(self.meeting)
                self.mode = "live"
            self.status = "running"
            self.t0 = time.perf_counter()
            self.timeline = []
            await self._send_all(self.snapshot())
            self._tasks = [asyncio.create_task(self._run_source()),
                           asyncio.create_task(self._modeller_worker())]
        await self.emit_status()
        return {"ok": True, "mode": self.mode, "replay": self.replay_name}

    async def pause(self) -> None:
        if self.status == "running" and self.mode != "mic":   # you cannot pause someone talking
            self.clock.pause()
            self.status = "paused"
            await self.emit_status()

    async def resume(self) -> None:
        if self.status == "paused":
            self.clock.resume()
            self.status = "running"
            await self.emit_status()

    async def set_speed(self, speed: float) -> None:
        self.clock.speed = max(0.25, min(float(speed), 16.0))
        await self.emit_status()

    async def reset(self, broadcast: bool = True) -> None:
        if self.source is not None:
            await self.source.close()
        for task in self._tasks + ([self.analyst_task] if self.analyst_task else []):
            task.cancel()
        for _, task in self.pending:
            task.cancel()
        if self.mode in ("live", "mic") and self.status != "finished" and self.spoken:
            self._save_run(complete=False)
        self._tasks = []
        self._reset_state()
        if broadcast:
            await self._send_all(self.snapshot())

    def _resolve_run(self, run: str) -> Path | None:
        RUNS_DIR.mkdir(exist_ok=True)
        if run == "latest":
            runs = [r for r in list_runs() if r["complete"]] or list_runs()
            return RUNS_DIR / runs[0]["file"] if runs else None
        p = RUNS_DIR / Path(run).name
        return p if p.exists() else None

    # ---------------------------------------------------------------- replay
    async def _run_replay(self, events: list[dict]) -> None:
        try:
            prev_t = 0.0
            for ev in events:
                ev = dict(ev)
                await self.clock.sleep(max(0.0, ev["t"] - prev_t))
                prev_t = ev["t"]
                if ev["type"] == "utterance_start":
                    ev["duration_ms"] = int(ev.get("duration_ms", 2000) / self.clock.speed)
                await self.emit(ev, record=False)
            self.status = "finished"
            await self.emit_status()
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------ live
    async def _run_source(self) -> None:
        try:
            asyncio.create_task(agents.warmup())
            await self.emit({"type": "meeting", "meeting": self._meeting_public()})
            await self.source.run(self)
        except asyncio.CancelledError:
            return
        except Exception:
            log.exception("utterance source crashed")
        self.speech_done = True
        self.pending_event.set()

    async def submit_utterance(self, public: dict, speech_end_t: float | None = None) -> None:
        """Hand one finished utterance {id, speaker, text} to the pipeline (any source)."""
        context = list(self.spoken)
        self.spoken.append(public)
        if self.mode == "mic":
            self.utt_timing[public["id"]] = {"speech_end_t": speech_end_t,
                                             "final_t": round(time.perf_counter() - self.t0, 3)}
        task = asyncio.create_task(self._extract(context, public))
        self.pending.append((public, task))
        self.pending_event.set()

    async def _extract(self, context: list[dict], utt: dict) -> dict:
        res = await agents.extract(self.meeting, context, utt)
        if res.data is None:
            ex = {"kind": "new_info", "claims": [utt["text"]], "refers_to": None, "topic_shift": False,
                  "fallback": True}
        else:
            ex = res.data
        self.extractions[utt["id"]] = ex
        await self.emit({"type": "extraction", "id": utt["id"], "kind": ex["kind"],
                         "claims": ex.get("claims", []), "refers_to": ex.get("refers_to"),
                         "topic_shift": ex.get("topic_shift", False)})
        await self.emit({"type": "activity", "item": {
            "agent": "extractor", "utts": [utt["id"]], "speaker": utt["speaker"],
            "latency_ms": res.latency_ms, "kind": ex["kind"], "claims": ex.get("claims", []),
            "refers_to": ex.get("refers_to"), "topic_shift": ex.get("topic_shift", False), "error": res.error,
            "confidence": res.confidence, "tokens": [res.tokens_in, res.tokens_out], "t": round(time.perf_counter() - self.t0, 2)}})
        log.info("extract %s %-12s %5dms %s", utt["id"], ex["kind"], res.latency_ms,
                 "; ".join(ex.get("claims", []))[:120])
        return ex

    async def _modeller_worker(self) -> None:
        try:
            while True:
                if not self.pending:
                    if self.speech_done:
                        break
                    self.pending_event.clear()
                    await self.pending_event.wait()
                    continue
                await self.pending[0][1]  # in-order: wait for the oldest extraction
                batch = []
                while self.pending and self.pending[0][1].done() and len(batch) < MAX_BATCH:
                    batch.append(self.pending.pop(0))
                items = []
                for utt, task in batch:
                    ex = task.result()
                    if ex["kind"] != "chit_chat":
                        items.append({"utt": utt, "extraction": ex})
                if items:
                    await self._run_modeller(items)
                    self.meaningful_since_analysis += len(items)
                    if self.meaningful_since_analysis >= ANALYST_EVERY:
                        self._kick_analyst()
            # meeting over: final analysis, then save
            if self.analyst_task and not self.analyst_task.done():
                await self.analyst_task
            self._kick_analyst(force=True)
            if self.analyst_task:
                await self.analyst_task
            self.status = "finished"
            await self.emit_status()
            self._save_run(complete=True)
            await self.emit({"type": "run_saved", "file": self.run_file}, record=False)
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("modeller worker crashed")

    async def _run_modeller(self, items: list[dict]) -> None:
        batch_ids = {i["utt"]["id"] for i in items}
        meaningful = [u for u in self.spoken if u["id"] not in batch_ids
                      and self.extractions.get(u["id"], {}).get("kind") != "chit_chat"]
        window = [u for u in meaningful if u["id"] < min(batch_ids)][-WINDOW:]
        compact = self.board.compact()
        res = await agents.model(self.meeting, compact, window, items)
        ops = (res.data or {}).get("ops", [])
        by_lookup = {u["id"]: u["speaker"] for u in self.spoken}
        last_id = items[-1]["utt"]["id"]
        for op in ops:
            if isinstance(op, dict) and op.get("src") not in by_lookup:
                op["src"] = last_id
        # Guard: only open a new tab when the extractor saw an explicit topic shift
        # (or when there is no board yet). Weak reasoning settings sometimes open tabs too eagerly.
        # Same for undo: only when the extractor heard an explicit retraction ("scratch that").
        shift_ok = not self.board.boards or any(i["extraction"].get("topic_shift") for i in items)
        undo_ok = any(i["extraction"].get("kind") == "undo" for i in items)
        guard_rejected, kept = [], []
        for op in ops:
            name = op.get("op") if isinstance(op, dict) else None
            if name == "new_board" and not shift_ok:
                guard_rejected.append({"op": op, "error": "new_board: no topic shift detected in this batch"})
            elif name == "undo" and not undo_ok:
                guard_rejected.append({"op": op, "error": "undo: nobody retracted anything in this batch"})
            else:
                kept.append(op)
        ops = kept
        result = self.board.apply_ops(ops, by_lookup=by_lookup)
        result["rejected"] = guard_rejected + result["rejected"]
        summary = (res.data or {}).get("summary") or ("modeller error" if res.error else "")
        await self._emit_board(result, "modeller")
        if result["applied"]:
            now = round(time.perf_counter() - self.t0, 3)
            for uid in batch_ids:
                if uid in self.utt_timing:
                    self.utt_timing[uid]["board_t"] = now
        await self.emit({"type": "activity", "item": {
            "agent": "modeller", "utts": [i["utt"]["id"] for i in items],
            "speaker": items[-1]["utt"]["speaker"], "latency_ms": res.latency_ms,
            "summary": summary, "ops": result["applied"], "rejected": result["rejected"],
            "error": res.error, "batched": len(items), "version": self.board.version,
            "tokens": [res.tokens_in, res.tokens_out], "t": round(time.perf_counter() - self.t0, 2)}})
        log.info("model %s %5dms ops=%d rejected=%d | %s", ",".join(sorted(batch_ids)), res.latency_ms,
                 len(result["applied"]), len(result["rejected"]), summary)
        for op in result["applied"]:
            log.info("    + %s", json.dumps({k: v for k, v in op.items() if v is not None}, ensure_ascii=False))
        for rej in result["rejected"]:
            log.info("    x %s  <- %s", rej["error"], json.dumps(rej["op"], ensure_ascii=False)[:200])

    async def _emit_board(self, result: dict, agent: str) -> None:
        if not result["applied"]:
            return
        await self.emit({"type": "board", "agent": agent, "board": self.board.to_dict(),
                         "applied": result["applied"], "version": self.board.version})

    def _kick_analyst(self, force: bool = False) -> None:
        if self.analyst_task and not self.analyst_task.done():
            return  # one at a time; the next trigger catches up
        if not force and self.meaningful_since_analysis < ANALYST_EVERY:
            return
        self.meaningful_since_analysis = 0
        self.analyst_task = asyncio.create_task(self._run_analyst())

    async def _run_analyst(self) -> None:
        try:
            transcript = [u for u in self.spoken if self.extractions.get(u["id"], {}).get("kind") != "chit_chat"]
            if not transcript:
                return
            start_version = self.board.version
            compact = self.board.compact(full_boards=set(self.board.board_order))
            res = await agents.analyse(self.meeting, transcript, compact, self.questions, self.disagreements)
            if res.data is None:
                await self.emit({"type": "activity", "item": {"agent": "analyst", "latency_ms": res.latency_ms,
                                 "error": res.error, "t": round(time.perf_counter() - self.t0, 2)}})
                return
            qs = res.data.get("open_questions", [])
            ds = res.data.get("disagreements", [])
            await self.emit({"type": "analysis", "questions": qs, "disagreements": ds})
            marks = []
            for m in res.data.get("suggested_marks", []):
                found = self.board.find_target(m.get("board", ""), m.get("target", ""))
                # The analyst may only close a dispute the board still shows as open.
                # (Opening disputes is the modeller's job; in testing the analyst sometimes
                # marked accepted corrections as disputes.)
                if m.get("status") != "resolved" or not found or found[1]["status"] != "disputed":
                    continue
                marks.append({"op": "mark", **m})
            by_lookup = {u["id"]: u["speaker"] for u in self.spoken}
            result = self.board.apply_ops(marks, by_lookup=by_lookup, guard_version=start_version)
            await self._emit_board(result, "analyst")
            await self.emit({"type": "activity", "item": {
                "agent": "analyst", "utts": [transcript[-1]["id"]], "latency_ms": res.latency_ms,
                "summary": f"{sum(q['status'] == 'open' for q in qs)} open questions, "
                           f"{sum(d['status'] == 'open' for d in ds)} open disagreements",
                "ops": result["applied"], "rejected": result["rejected"],
                "tokens": [res.tokens_in, res.tokens_out], "t": round(time.perf_counter() - self.t0, 2)}})
            log.info("analyst %5dms q=%d d=%d marks=%d rejected=%d", res.latency_ms, len(qs), len(ds),
                     len(result["applied"]), len(result["rejected"]))
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("analyst crashed")

    # ------------------------------------------------------------------ save
    def _save_run(self, complete: bool) -> None:
        if not self.timeline:
            return
        RUNS_DIR.mkdir(exist_ok=True)
        name = datetime.now().strftime("%Y-%m-%dT%H-%M-%S") + ("" if complete else "_partial") + ".json"
        lat: dict[str, list[int]] = {}
        for ev in self.timeline:
            if ev["type"] == "activity" and ev["item"].get("latency_ms") is not None:
                lat.setdefault(ev["item"]["agent"], []).append(ev["item"]["latency_ms"])
        stats = {a: {"calls": len(v), "avg_ms": int(sum(v) / len(v)), "min_ms": min(v), "max_ms": max(v),
                     "p50_ms": sorted(v)[len(v) // 2]} for a, v in lat.items()}
        if self.utt_timing:
            stats["mic"] = self._mic_latency()
        data = {
            "meta": {"title": self.meeting["title"], "model": agents.MODEL,
                     "source": self.meeting.get("source", "scripted"),
                     "efforts": {"extractor": agents.EXTRACTOR_EFFORT, "modeller": agents.MODELLER_EFFORT,
                                 "analyst": agents.ANALYST_EFFORT},
                     "modeller": {"model": agents.MODELLER_MODEL, "thinking": agents.MODELLER_THINKING},
                     "extractor": {"backend": agents.EXTRACTOR_BACKEND,
                                   "model": agents.JEV_MODEL if agents.EXTRACTOR_BACKEND == "jev" else agents.EXTRACTOR_MODEL,
                                   "thinking": agents.EXTRACTOR_THINKING},
                     "speed": self.clock.speed, "complete": complete,
                     "saved_at": datetime.now().isoformat(timespec="seconds"),
                     "event_count": len(self.timeline), "latency": stats},
            "meeting": self.meeting,
            "final_board": self.board.to_dict(),
            "questions": self.questions, "disagreements": self.disagreements,
            "events": self.timeline,
        }
        (RUNS_DIR / name).write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str))
        self.run_file = name
        log.info("saved run %s (%d events) latency=%s", name, len(self.timeline), stats)

    def _mic_latency(self) -> dict:
        """speech end -> transcript final -> board updated, per utterance (mic mode)."""
        def summary(v: list[int]) -> dict | None:
            if not v:
                return None
            v = sorted(v)
            return {"n": len(v), "avg_ms": int(sum(v) / len(v)), "p50_ms": v[len(v) // 2], "min_ms": v[0], "max_ms": v[-1]}
        stt, e2e, f2b = [], [], []
        for t in self.utt_timing.values():
            if t.get("speech_end_t") is not None:
                stt.append(int((t["final_t"] - t["speech_end_t"]) * 1000))
                if t.get("board_t") is not None:
                    e2e.append(int((t["board_t"] - t["speech_end_t"]) * 1000))
            if t.get("board_t") is not None:
                f2b.append(int((t["board_t"] - t["final_t"]) * 1000))
        from .stt import STT_MODEL, segmentation_for
        return {"stt_model": STT_MODEL, "segmentation": segmentation_for(STT_MODEL),
                "speech_end_to_final": summary(stt), "final_to_board": summary(f2b),
                "speech_end_to_board": summary(e2e), "per_utterance": self.utt_timing}
