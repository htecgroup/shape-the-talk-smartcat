"""The agent pipeline of a session: extractor fan-out, the ordered/batched modeller worker, and the
background analyst and consolidator with the server-side guards on what each agent may change.

`AgentPipeline` is a mixin of `Session` (session.py); it works on the session's state (`spoken`,
`extractions`, `pending`, `board`, the analyst/consolidator tasks and counters) and reports through
`Session.emit()`. Agents are called through the `agents` package, so tests can fake them there.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any

from . import agents

log = logging.getLogger("session")

MAX_BATCH = 6               # max utterances per modeller call when a backlog builds
ANALYST_EVERY = 4           # meaningful utterances between analyst runs
WINDOW = 8                  # previous meaningful utterances shown to the modeller
CONSOLIDATE_EVERY = int(os.getenv("LW_CONSOLIDATE_EVERY", "6"))  # meaningful utterances between cleanup passes; 0 = off
CONSOLIDATOR_BLOCKED = {"new_board", "switch_board", "undo"}     # the consolidator only edits the active board


class AgentPipeline:
    # ------------------------------------------------------------ extractor
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
            "confidence": res.confidence, "tokens": [res.tokens_in, res.tokens_out], "t": self._elapsed()}})
        log.info("extract %s %-12s %5dms %s", utt["id"], ex["kind"], res.latency_ms,
                 "; ".join(ex.get("claims", []))[:120])
        return ex

    # ------------------------------------------------------------- modeller
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
                items = self._next_batch()
                if items:
                    await self._run_modeller(items)
                    self.meaningful_since_analysis += len(items)
                    self.meaningful_since_consolidation += len(items)
                    if self.meaningful_since_analysis >= ANALYST_EVERY:
                        self._kick_analyst()
                    self._kick_consolidator()
            await self._finish_meeting()
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("modeller worker crashed")

    def _next_batch(self) -> list[dict]:
        """Take the finished extractions at the head of the queue (at most MAX_BATCH); drop chit-chat."""
        batch = []
        while self.pending and self.pending[0][1].done() and len(batch) < MAX_BATCH:
            batch.append(self.pending.pop(0))
        items = []
        for utt, task in batch:
            ex = task.result()
            if ex["kind"] != "chit_chat":
                items.append({"utt": utt, "extraction": ex})
        return items

    async def _finish_meeting(self) -> None:
        """Meeting over: final cleanup (so the saved board and the analysis see it), final analysis, then save."""
        for task in (self.consolidator_task, self.analyst_task):
            if task and not task.done():
                await task
        self._kick_consolidator(force=True)
        if self.consolidator_task and not self.consolidator_task.done():
            await self.consolidator_task
        self._kick_analyst(force=True)
        if self.analyst_task:
            await self.analyst_task
        self.status = "finished"
        await self.emit_status()
        self._save_run(complete=True)
        await self.emit({"type": "run_saved", "file": self.run_file}, record=False)

    async def _run_modeller(self, items: list[dict]) -> None:
        batch_ids = {i["utt"]["id"] for i in items}
        meaningful = [u for u in self.spoken if u["id"] not in batch_ids
                      and self.extractions.get(u["id"], {}).get("kind") != "chit_chat"]
        window = [u for u in meaningful if u["id"] < min(batch_ids)][-WINDOW:]
        compact = self.board.compact()
        res = await agents.model(self.meeting, compact, window, items)
        ops = (res.data or {}).get("ops", [])
        by_lookup = self._speakers()
        last_id = items[-1]["utt"]["id"]
        for op in ops:
            if isinstance(op, dict) and op.get("src") not in by_lookup:
                op["src"] = last_id
        ops, guard_rejected = self._modeller_guard(ops, items)
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
            "tokens": [res.tokens_in, res.tokens_out], "t": self._elapsed()}})
        log.info("model %s %5dms ops=%d rejected=%d | %s", ",".join(sorted(batch_ids)), res.latency_ms,
                 len(result["applied"]), len(result["rejected"]), summary)
        _log_ops(result)

    def _modeller_guard(self, ops: list, items: list[dict]) -> tuple[list, list]:
        """Only open a new tab when the extractor saw an explicit topic shift (or when there is no board yet).
        Weak reasoning settings sometimes open tabs too eagerly. Same for undo: only when the extractor
        heard an explicit retraction ("scratch that")."""
        shift_ok = not self.board.boards or any(i["extraction"].get("topic_shift") for i in items)
        undo_ok = any(i["extraction"].get("kind") == "undo" for i in items)
        kept, rejected = [], []
        for op in ops:
            name = op.get("op") if isinstance(op, dict) else None
            if name == "new_board" and not shift_ok:
                rejected.append({"op": op, "error": "new_board: no topic shift detected in this batch"})
            elif name == "undo" and not undo_ok:
                rejected.append({"op": op, "error": "undo: nobody retracted anything in this batch"})
            else:
                kept.append(op)
        return kept, rejected

    async def _emit_board(self, result: dict, agent: str, layout: dict | None = None) -> None:
        """Board event after an agent changed the board. `layout`: the plan the consolidator just stored
        (a changed plan is sent even without ops, so the browser can re-lay out; it is in the board too)."""
        if not result["applied"] and layout is None:
            return
        ev = {"type": "board", "agent": agent, "board": self.board.to_dict(),
              "applied": result["applied"], "version": self.board.version}
        if layout is not None:
            ev["layout"] = {"board": layout["board"], **layout["plan"]}
        await self.emit(ev)

    # -------------------------------------------------------------- analyst
    def _kick_analyst(self, force: bool = False) -> None:
        if self.analyst_task and not self.analyst_task.done():
            return  # one at a time; the next trigger catches up
        if not force and self.meaningful_since_analysis < ANALYST_EVERY:
            return
        self.meaningful_since_analysis = 0
        self.analyst_task = asyncio.create_task(self._run_analyst())

    async def _run_analyst(self) -> None:
        try:
            transcript = self._meaningful_transcript()
            if not transcript:
                return
            start_version = self.board.version
            compact = self.board.compact(full_boards=set(self.board.board_order))
            res = await agents.analyse(self.meeting, transcript, compact, self.questions, self.disagreements)
            if res.data is None:
                await self.emit({"type": "activity", "item": {"agent": "analyst", "latency_ms": res.latency_ms,
                                 "error": res.error, "t": self._elapsed()}})
                return
            qs = res.data.get("open_questions", [])
            ds = res.data.get("disagreements", [])
            await self.emit({"type": "analysis", "questions": qs, "disagreements": ds})
            marks = self._analyst_marks(res.data.get("suggested_marks", []))
            result = self.board.apply_ops(marks, by_lookup=self._speakers(), guard_version=start_version)
            await self._emit_board(result, "analyst")
            await self.emit({"type": "activity", "item": {
                "agent": "analyst", "utts": [transcript[-1]["id"]], "latency_ms": res.latency_ms,
                "summary": f"{sum(q['status'] == 'open' for q in qs)} open questions, "
                           f"{sum(d['status'] == 'open' for d in ds)} open disagreements",
                "ops": result["applied"], "rejected": result["rejected"],
                "tokens": [res.tokens_in, res.tokens_out], "t": self._elapsed()}})
            log.info("analyst %5dms q=%d d=%d marks=%d rejected=%d", res.latency_ms, len(qs), len(ds),
                     len(result["applied"]), len(result["rejected"]))
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("analyst crashed")

    def _analyst_marks(self, suggested: list[dict]) -> list[dict]:
        """The analyst may only close a dispute the board still shows as open. (Opening disputes is the
        modeller's job; in testing the analyst sometimes marked accepted corrections as disputes.)"""
        marks = []
        for m in suggested:
            found = self.board.find_target(m.get("board", ""), m.get("target", ""))
            if m.get("status") != "resolved" or not found or found[1]["status"] != "disputed":
                continue
            marks.append({"op": "mark", **m})
        return marks

    # --------------------------------------------------------- consolidator
    def _kick_consolidator(self, force: bool = False) -> None:
        if CONSOLIDATE_EVERY <= 0 or (self.consolidator_task and not self.consolidator_task.done()):
            return  # disabled, or one at a time; the next trigger catches up
        if not force and self.meaningful_since_consolidation < CONSOLIDATE_EVERY:
            return
        self.meaningful_since_consolidation = 0
        self.consolidator_task = asyncio.create_task(self._run_consolidator())

    def _consolidator_guard(self, ops: list) -> tuple[list, list]:
        """Drop ops the consolidator may not emit: tab changes, undo, and anything touching a dispute."""
        b = self.board.boards.get(self.board.active) or {"nodes": {}, "edges": {}}
        def disputed(ref: Any) -> bool:
            item = b["nodes"].get(ref) or b["edges"].get(ref)
            return bool(item) and item["status"] in ("disputed", "resolved")
        kept, rejected = [], []
        for op in ops:
            name = op.get("op") if isinstance(op, dict) else None
            if name in CONSOLIDATOR_BLOCKED:
                rejected.append({"op": op, "error": f"{name}: not allowed for the consolidator"})
            elif name == "mark" and op.get("status") in ("disputed", "resolved"):
                rejected.append({"op": op, "error": "mark: the consolidator never opens or closes disputes"})
            elif name in ("mark", "remove_node", "update_node", "disconnect", "reroute") and disputed(
                    op.get("target") or op.get("id") or op.get("edge")):
                rejected.append({"op": op, "error": f"{name}: element is disputed/resolved; left alone"})
            else:
                kept.append(op)
        return kept, rejected

    async def _run_consolidator(self) -> None:
        try:
            transcript = self._meaningful_transcript()
            if not transcript or not self.board.active:
                return
            bid, hints = self.board.active, agents.settings.LAYOUT_HINTS
            res = await agents.consolidate(self.meeting, transcript, self.board.compact(),
                                           layout=self.board.layout_of(bid) if hints else None)
            ops = [op for op in (res.data or {}).get("ops", []) if isinstance(op, dict)]
            by_lookup = self._speakers()
            for op in ops:
                if op.get("src") not in by_lookup:
                    op["src"] = transcript[-1]["id"]
            # The modeller may have changed the board meanwhile; ops on elements that are gone are rejected per op.
            ops, guard_rejected = self._consolidator_guard(ops)
            result = self.board.apply_ops(ops, by_lookup=by_lookup)
            result["rejected"] = guard_rejected + result["rejected"]
            summary = (res.data or {}).get("summary") or ("consolidator error" if res.error else "")
            # layout plan: validated against the board after the ops (it may use a group the ops just added)
            changed = self.board.set_layout(bid, (res.data or {}).get("layout")) if hints else None
            await self._emit_board(result, "consolidator", {"board": bid, "plan": changed} if changed else None)
            item = {"agent": "consolidator", "utts": [transcript[-1]["id"]], "latency_ms": res.latency_ms,
                    "summary": summary, "ops": result["applied"], "rejected": result["rejected"], "error": res.error,
                    "tokens": [res.tokens_in, res.tokens_out], "t": self._elapsed()}
            if hints and self.board.layout_of(bid):
                item["layout"] = {"board": bid, "changed": changed is not None, **self.board.layout_of(bid)}
            await self.emit({"type": "activity", "item": item})
            log.info("consolidator %5dms ops=%d rejected=%d layout=%s | %s", res.latency_ms, len(result["applied"]),
                     len(result["rejected"]), _plan_line(self.board.layout_of(bid)) if hints else "off", summary)
            _log_ops(result)
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("consolidator crashed")

    # -------------------------------------------------------------- helpers
    def _meaningful_transcript(self) -> list[dict]:
        return [u for u in self.spoken if self.extractions.get(u["id"], {}).get("kind") != "chit_chat"]

    def _speakers(self) -> dict[str, str]:
        """utterance id -> speaker, for `src` checks and `by` attribution."""
        return {u["id"]: u["speaker"] for u in self.spoken}

    def _elapsed(self) -> float:
        """Seconds since the session started, for activity items."""
        return round(time.perf_counter() - self.t0, 2)


def _plan_line(plan: dict | None) -> str:
    if not plan:
        return "none"
    places = ", ".join(f'{p["node"]} {p["side"]} {p["anchor"]}' for p in plan["placements"])
    return f'{plan["direction"]} {" > ".join(plan["spine"]) or "-"}' + (f" [{places}]" if places else "")


def _log_ops(result: dict) -> None:
    for op in result["applied"]:
        log.info("    + %s", json.dumps({k: v for k, v in op.items() if v is not None}, ensure_ascii=False))
    for rej in result["rejected"]:
        log.info("    x %s  <- %s", rej["error"], json.dumps(rej["op"], ensure_ascii=False)[:200])
