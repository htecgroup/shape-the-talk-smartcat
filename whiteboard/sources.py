"""Utterance sources for a Session.

A source produces finished utterances and hands each one to `session.submit_utterance()`,
which runs the shared pipeline (extractor fan-out, ordered/batched modeller, analyst).
`run()` returns when there will be no more speech; the session then drains the pipeline,
runs the final analysis and saves the run.

- ScriptedSource: the mock meeting from data/meeting_*.json on the virtual clock.
- MicSource: live speech from the browser microphone, transcribed by the OpenAI Realtime API.
"""

from __future__ import annotations

import asyncio
import bisect
import logging
import os
import time
from typing import TYPE_CHECKING, Any, Callable

from . import chunking
from .audio import EnergyVAD
from .chunking import FILLER_ONLY, RunningCaption, is_meaningless  # noqa: F401 (re-exported)
from .stt import BENIGN_ERRORS, RealtimeTranscriber, UpstreamError

if TYPE_CHECKING:
    from .session import Session

log = logging.getLogger("mic")

WORDS_PER_SECOND = 2.6      # ~155 wpm at 1x (scripted meeting)
DEFAULT_SPEAKER = "You"
DEFAULT_TOPIC = ("Not given. Infer what is being designed from what the speaker says "
                 "(usually a process, a system or an architecture).")
SPEAKER_COLOR = "#e8590c"
FLUSH_TIMEOUT_S = 5.0       # how long stop() waits for the last transcript
PRE_CONNECT_BUFFER_S = 6.0  # audio kept while the upstream socket is still opening
CHUNK_WORDS = int(os.getenv("LW_MIC_CHUNK_WORDS", str(chunking.CHUNK_WORDS)))   # send a segment every this many stable words
PAUSE_S = float(os.getenv("LW_MIC_PAUSE_S", str(chunking.PAUSE_S)))           # ... or after this long without a new delta


class ScriptedSource:
    kind = "scripted"

    def __init__(self, meeting: dict) -> None:
        self.meeting = meeting

    async def run(self, session: "Session") -> None:
        clock = session.clock
        for utt in self.meeting["utterances"]:
            await clock.sleep(utt.get("pause", 1.0))
            words = len(utt["text"].split())
            dur_1x = words / WORDS_PER_SECOND + 0.3
            public = {"id": utt["id"], "speaker": utt["speaker"], "text": utt["text"]}
            await session.emit({"type": "utterance_start", "utt": public,
                                "duration_ms": int(dur_1x * 1000 / clock.speed)})
            await clock.sleep(dur_1x)
            await session.emit({"type": "utterance_final", "id": utt["id"]})
            await session.submit_utterance(public)

    async def close(self) -> None:
        pass

    def public_state(self) -> dict | None:
        return None


def mic_meeting(speaker: str | None, topic: str | None) -> dict:
    speaker = (speaker or "").strip()[:40] or DEFAULT_SPEAKER
    topic = (topic or "").strip()[:200]
    return {
        "id": "talk_live", "source": "mic",
        "title": f"Talk live: {topic}" if topic else "Talk live",
        "topic": topic or DEFAULT_TOPIC,
        "participants": [{"name": speaker, "color": SPEAKER_COLOR,
                          "role": "Talking at the microphone (others in the room may share it)"}],
        "utterances": [],
    }


class MicSource:
    """Live microphone utterances.

    Each upstream item (one committed audio segment) is a running transcript, cut into utterances
    (m001, m002, ...) while it streams in, like a Teams caption (chunking.RunningCaption): at a
    sentence end, every LW_MIC_CHUNK_WORDS (6) stable words (deltas only append, so every word but
    a trailing partial one is stable), or after LW_MIC_PAUSE_S (0.8 s) without a new delta. The
    completed transcript sends only what is left and fixes the sent pieces on screen.
    Spoken order holds: only the earliest unfinished item is cut and shown; a later item's deltas
    wait, and it catches up when the items before it complete (even if OpenAI completes it first).
    Server-VAD models stream no deltas mid-speech, so their items go out whole on completion.
    """

    kind = "mic"

    def __init__(self, speaker: str, topic: str | None = None,
                 transcriber_factory: Callable[..., Any] | None = None) -> None:
        self.speaker = speaker
        self.topic = topic
        self.factory = transcriber_factory or (lambda on_event: RealtimeTranscriber(
            on_event, prompt=f"Someone designing a system out loud. Topic: {topic}" if topic else None))
        self.session: "Session | None" = None
        self.state = "idle"        # idle | connecting | listening | stopping | stopped | error
        self.error: str | None = None
        self.warning: str | None = None
        self.tr = None
        self.vad = EnergyVAD()
        self.items: dict[str, dict] = {}
        self.order: list[str] = []
        self.head: str | None = None           # the item being cut live: order[0] once it was caught up
        self.lock = asyncio.Lock()             # upstream events, pause timers and the final flush, one at a time
        self.n = 0
        self.done = asyncio.Event()
        self.changed = asyncio.Event()
        self._pre: list[bytes] = []
        self._audio_s = 0.0                    # audio received (seconds)
        self._audio_marks: list[tuple[float, float]] = []   # (audio end s, wall perf_counter)
        self._commit_marks: list[float] = []   # speech-end wall times of commits awaiting `committed`
        self._since_commit_s = 0.0
        self._last_commit_audio_t = 0.0
        self.on_state: Callable[[dict], Any] | None = None
        self.stats = {"chunks": 0, "commits": 0}

    # ---------------------------------------------------------------- source API
    async def run(self, session: "Session") -> None:
        self.session = session
        await self.done.wait()

    async def close(self) -> None:
        """Hard stop (reset): no flush."""
        for it in self.items.values():
            it["cap"].cancel()
        if self.tr is not None:
            await self.tr.close()
        self.done.set()
        if self.state != "stopped":
            await self._set_state("stopped")   # tells the browser that owns the mic to stop capturing

    def rearm(self) -> None:
        """Make a stopped source reusable (continue after Stop). Keeps the id counter and items."""
        self.done = asyncio.Event()
        self.state = "idle"
        self.error = None

    def public_state(self) -> dict:
        model = self.tr.model if self.tr else None
        seg = self.tr.segmentation if self.tr else None
        return {"state": self.state, "error": self.error, "warning": self.warning, "speaker": self.speaker,
                "model": model, "segmentation": seg}

    async def _set_state(self, state: str, error: str | None = None) -> None:
        self.state = state
        self.error = error
        if self.session is not None:
            await self.session.emit({"type": "mic_state", **self.public_state()}, record=False)
        if self.on_state is not None:
            try:
                await self.on_state(self.public_state())
            except Exception:
                pass

    # -------------------------------------------------------------- lifecycle
    async def connect(self) -> bool:
        """Open (or re-open after an error) the upstream transcription session."""
        if self.tr is not None:
            await self.tr.close()
        self.vad = EnergyVAD()            # VAD audio time and _audio_s both restart at 0
        self._audio_s = 0.0
        self._audio_marks.clear()
        self._last_commit_audio_t = 0.0
        self._commit_marks.clear()
        self._since_commit_s = 0.0
        self.warning = None
        await self._set_state("connecting")
        self.tr = self.factory(self.handle_event)
        try:
            await self.tr.connect()
        except UpstreamError as exc:
            self._pre.clear()
            await self._set_state("error", str(exc))
            return False
        await self._set_state("listening")
        pre, self._pre = self._pre, []
        for chunk in pre:
            await self.feed(chunk)
        return True

    async def stop(self) -> None:
        """Flush: commit the audio still in the buffer, wait for the last transcripts, then finish."""
        if self.state in ("stopping", "stopped"):
            return
        was_listening = self.state == "listening"
        await self._set_state("stopping")
        if was_listening and self.tr is not None and self.tr.open:
            # only commit when there is something to transcribe; committing pure silence can make
            # the model hallucinate a phrase
            heard = self.vad.in_speech or self.vad.last_voiced_t > self._last_commit_audio_t
            if heard or any(self.items[i]["status"] == "open" and self.items[i]["text"].strip() for i in self.order):
                await self._commit(self._audio_to_wall(self.vad.last_voiced_t), "stop")
            deadline = time.perf_counter() + FLUSH_TIMEOUT_S
            while (self._open_items() or self._commit_marks) and time.perf_counter() < deadline:
                self.changed.clear()
                try:
                    await asyncio.wait_for(self.changed.wait(), max(0.05, deadline - time.perf_counter()))
                except asyncio.TimeoutError:
                    break
        async with self.lock:
            await self._finalize_open("stopped before the transcript completed")
        if self.tr is not None:
            await self.tr.close()
        await self._set_state("stopped")
        self.done.set()

    # ------------------------------------------------------------------ audio
    async def feed(self, pcm: bytes) -> None:
        """PCM16 mono 24 kHz from the browser (or scripts/feed_audio.py)."""
        if self.state == "connecting":
            self._pre.append(pcm)
            while sum(len(c) for c in self._pre) > PRE_CONNECT_BUFFER_S * 48000:
                self._pre.pop(0)
            return
        if self.state != "listening" or self.tr is None:
            return
        now = time.perf_counter()
        dur = len(pcm) / 48000
        self._audio_s += dur
        self._audio_marks.append((self._audio_s, now))
        if len(self._audio_marks) > 3000:
            del self._audio_marks[:1000]
        self.stats["chunks"] += 1
        await self.tr.append(pcm)
        self._since_commit_s += dur
        # The VAD runs in both modes (cheap). In "local" mode it decides the commits.
        for ev in self.vad.feed(pcm):
            if ev[0] == "commit" and self.tr.segmentation == "local":
                await self._commit(self._audio_to_wall(self.vad.last_voiced_t), ev[2])

    def _audio_to_wall(self, audio_t: float) -> float:
        """Wall time (perf_counter) when the audio at `audio_t` seconds was captured (approx.)."""
        if not self._audio_marks:
            return time.perf_counter()
        ends = [m[0] for m in self._audio_marks]
        i = bisect.bisect_left(ends, audio_t)
        if i >= len(ends):
            i = len(ends) - 1
        end, wall = self._audio_marks[i]
        return wall - max(0.0, end - audio_t)

    async def _commit(self, speech_end_wall: float, reason: str) -> None:
        self._commit_marks.append(speech_end_wall)
        self._since_commit_s = 0.0
        self._last_commit_audio_t = self.vad.t
        self.stats["commits"] += 1
        log.info("commit (%s)", reason)
        await self.tr.commit()

    # --------------------------------------------------------- upstream events
    def _item(self, item_id: str) -> dict:
        it = self.items.get(item_id)
        if it is None:
            it = {"item": item_id, "text": "", "status": "open", "speech_end": None, "speaking": False,
                  "cap": RunningCaption(self.session, self.speaker, self._new_id, self.lock, CHUNK_WORDS, PAUSE_S,
                                        active=lambda: not self.done.is_set())}
            self.items[item_id] = it
            self.order.append(item_id)
        return it

    def _new_id(self) -> str:
        self.n += 1
        return f"m{self.n:03d}"

    async def handle_event(self, ev: dict) -> None:
        async with self.lock:
            await self._handle(ev)
        self.changed.set()

    async def _handle(self, ev: dict) -> None:
        t = ev.get("type", "")
        if t == "conversation.item.input_audio_transcription.delta":
            it = self._item(ev["item_id"])
            if it["status"] != "open":
                return
            it["text"] += ev.get("delta", "")
            if self.order[0] == ev["item_id"]:
                self.head = ev["item_id"]
                await self._advance(it)
        elif t == "conversation.item.input_audio_transcription.completed":
            it = self._item(ev["item_id"])
            if it["status"] == "open":
                it["text"] = (ev.get("transcript") or "").strip()
                it["status"] = "completed"
                it["completed_at"] = time.perf_counter()
                await self._flush()
        elif t == "conversation.item.input_audio_transcription.failed":
            it = self._item(ev["item_id"])
            err = (ev.get("error") or {}).get("message", "transcription failed")
            log.warning("transcription failed for %s: %s", ev["item_id"], err)
            self.warning = f"A segment could not be transcribed: {err}"
            it["text"] = it["text"].strip()
            it["status"] = "completed"
            it["completed_at"] = time.perf_counter()
            await self._flush()
        elif t == "input_audio_buffer.committed":
            it = self._item(ev["item_id"])
            if self._commit_marks and it["speech_end"] is None:
                it["speech_end"] = self._commit_marks.pop(0)
        elif t == "input_audio_buffer.speech_started":       # server VAD mode
            it = self._item(ev["item_id"])
            it["speaking"] = True
            if self.order[0] == ev["item_id"]:
                self.head = ev["item_id"]
                await self._advance(it)
        elif t == "input_audio_buffer.speech_stopped":       # server VAD mode
            it = self._item(ev["item_id"])
            it["speech_end"] = self._audio_to_wall(ev.get("audio_end_ms", 0) / 1000)
        elif t == "error":
            err = ev.get("error") or {}
            if err.get("code") in BENIGN_ERRORS:
                if self._commit_marks:
                    self._commit_marks.pop(0)
                log.info("upstream: %s", err.get("code"))
            else:
                log.warning("upstream error: %s", err.get("message"))
                self.warning = err.get("message")
                await self._set_state(self.state, self.error)
        elif t == "upstream.closed":
            if self.state in ("stopping", "stopped"):
                return
            msg = f"OpenAI transcription connection closed (code {ev.get('code')}{', ' + ev['reason'] if ev.get('reason') else ''})"
            log.warning(msg)
            self._commit_marks.clear()
            await self._finalize_open("connection lost")
            await self._set_state("error", msg)

    async def _advance(self, it: dict) -> None:
        """Cut the head item's text so far: every word but a trailing partial one is stable (deltas only append)."""
        text, cap = it["text"], it["cap"]
        words = text.split()
        if not words:
            if it["speaking"] and cap.line is None:           # server VAD: show that someone is talking
                await cap.open_line("")
            return
        await cap.update(words, len(words) if text[-1].isspace() else len(words) - 1)

    def _open_items(self) -> list[dict]:
        # an item only counts as pending if it has text or was committed by us
        return [self.items[i] for i in self.order if self.items[i]["status"] == "open"
                and (self.items[i]["text"].strip() or self.items[i]["speech_end"] is not None)]

    async def _finalize_open(self, why: str) -> None:
        """Keep what we heard: open items become final with their interim text. Call with the lock held."""
        for item_id in self.order:
            it = self.items[item_id]
            if it["status"] == "open":
                it["text"] = it["text"].strip()
                it["status"] = "completed"
                it["completed_at"] = time.perf_counter()
                it["from_interim"] = True
                if it["text"]:
                    log.info("finalised %s from interim text (%s)", item_id, why)
        await self._flush()

    async def _flush(self) -> None:
        """Close completed items in spoken order, then catch up the new head with the deltas it got meanwhile."""
        while self.order and self.items[self.order[0]]["status"] == "completed":
            it = self.items[self.order.pop(0)]
            final: dict[str, Any] = {}
            if it.get("from_interim"):
                final["from_interim"] = True
            if it["speech_end"] is not None:
                final["speech_end_t"] = round(it["speech_end"] - self.session.t0, 3)
                final["stt_ms"] = int((it["completed_at"] - it["speech_end"]) * 1000)
            uid = await it["cap"].close(it["text"].split(), final)
            log.info("final %s (stt %s ms): %s", uid, final.get("stt_ms") if uid else None, it["text"][:120])
        if self.order and self.order[0] != self.head:
            self.head = self.order[0]
            await self._advance(self.items[self.head])
