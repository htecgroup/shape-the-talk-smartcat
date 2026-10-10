"""Meeting session: state, broadcasting, controls, replay.

Utterances come from a pluggable source (whiteboard/sources.py): the scripted mock
meeting ("live" mode) or the browser microphone ("mic" mode). Both feed the same
agent pipeline (whiteboard/pipeline.py) through `submit_utterance()`.

One global session drives the demo. Every event that reaches the browser goes
through `emit()`, which (a) folds it into a snapshot for late-joining clients,
(b) appends it to the run timeline, and (c) pushes it to all WebSockets.
Live and mic runs are saved to runs/ (whiteboard/recording.py); replay just
re-emits a recorded timeline, so it makes no API calls.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any

from . import agents
from .approvals import DEFAULT_APPROVAL_MODE, ApprovalGate
from .board import BoardState
from .pipeline import AgentPipeline
from .recording import list_runs, resolve_run, save_run
from .sources import MicSource, ScriptedSource, mic_meeting

log = logging.getLogger("session")

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"


def load_meeting(path: Path | None = None) -> dict:
    path = path or sorted(DATA_DIR.glob("meeting_*.json"))[0]
    return json.loads(path.read_text())


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


class Session(AgentPipeline, ApprovalGate):
    def __init__(self) -> None:
        self.clients: set[Any] = set()
        self.meeting = load_meeting()
        self.approval_mode = DEFAULT_APPROVAL_MODE   # a room setting: survives Reset
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
        self.consolidator_task: asyncio.Task | None = None
        self.meaningful_since_consolidation = 0
        self.consolidated: dict[str, str] = {}   # board id -> its shape after the last cleanup pass
        self.questions: list[dict] = []
        self.disagreements: list[dict] = []
        self.approvals: list[dict] = []            # destructive ops waiting for a person (ask mode)
        self._approval_seq = 0
        self.kept_by_person: set[tuple] = set()    # (board, node, "remove_node") / (board, nodes, "merge") a person kept
        # client snapshot view (built from emitted events, works for live and replay)
        self.view_transcript: list[dict] = []
        self.view_activity: list[dict] = []
        self.view_board: dict = self.board.to_dict()
        self.view_approvals: list[dict] = []
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
            "approval_mode": self.approval_mode, "approvals": self.view_approvals,
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
        elif t == "approvals":
            self.view_approvals = ev["pending"]
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
            path = resolve_run(run or "latest")
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

    async def continue_mic(self) -> dict:
        """Talk live: reopen the mic after Stop and keep adding to the same board."""
        if self.mode != "mic" or self.status != "finished" or not isinstance(self.source, MicSource):
            return {"ok": False, "error": "nothing to continue; press Start talking"}
        self.source.rearm()                 # same source, so utterance ids keep counting (m001, m002, ...)
        self.speech_done = False
        self.pending_event = asyncio.Event()
        self._close_idle_gap()
        self.status = "running"
        self._tasks = [asyncio.create_task(self._run_source(announce=False)),
                       asyncio.create_task(self._modeller_worker())]
        await self.emit_status()
        return {"ok": True, "mode": self.mode}

    def _close_idle_gap(self) -> None:
        """Pick the clock up where the recorded timeline stopped, so replay does not sit through the idle
        time after the meeting ended (talk live continued, an approval decided later)."""
        self.t0 = time.perf_counter() - (self.timeline[-1]["t"] if self.timeline else 0.0)

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
        for task in self._tasks + [t for t in (self.analyst_task, self.consolidator_task) if t]:
            task.cancel()
        for _, task in self.pending:
            task.cancel()
        if self.mode in ("live", "mic") and self.status != "finished" and self.spoken:
            self._save_run(complete=False)
        self._tasks = []
        self._reset_state()
        if broadcast:
            await self._send_all(self.snapshot())

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
    async def _run_source(self, announce: bool = True) -> None:
        try:
            if announce:
                asyncio.create_task(agents.warmup())
                await self.emit({"type": "meeting", "meeting": self._meeting_public()})
            await self.source.run(self)
        except asyncio.CancelledError:
            return
        except Exception:
            log.exception("utterance source crashed")
        self.speech_done = True
        self.pending_event.set()

    # ------------------------------------------------------------------ save
    def _save_run(self, complete: bool) -> None:
        name = save_run(self, complete)
        if name is not None:
            self.run_file = name
