"""Teams meeting source: a self-hosted Attendee bot (https://github.com/attendee-labs/attendee) joins the
meeting, and its webhooks give us speaker-labelled utterances.

`AttendeeSource` creates the bot (POST /api/v1/bots), asks it to leave on Stop, and turns webhooks into
pipeline input. server.py verifies the signature of POST /api/attendee/webhook and calls `handle_webhook()`.

- transcript.partial         every change of a running caption {caption_id, seq, speaker_*, timestamp_ms, text, is_final}
                             (needs docs/attendee-teams.patch in Attendee)
- transcript.update          one finished utterance {speaker_name, timestamp_ms, transcription.transcript}
- participant_events.join_leave   a participant joined: they appear in the legend (the bot itself never does)
- bot.state_change           joining / waiting room / in meeting / ended / error, shown in the UI

Teams finalizes a caption ~1.5 s after a pause, so a long run-on sentence would reach the agents only when it is
over. With transcript.partial the running caption is shown live and cut into utterances while the person talks:
at a sentence end, every LW_TEAMS_CHUNK_WORDS (6) stable words, mid-sentence too (stable: unchanged across two
partials, as Teams revises recent words; the modeller and consolidator repair the board when the rest arrives), or
after LW_TEAMS_PAUSE_S without a new partial (if 3+ words or a clause wait). The final caption sends only what is
left. Words Teams revises after they were sent are corrected on screen but not sent again (sent words are aligned
to the new text). The cutting helpers (`next_cut`, `aligned_end`) live in chunking.py, shared with talk live.
transcript.update of a caption seen on the partial stream (same speaker_uuid and timestamp_ms) is ignored, or
finishes it if its final partial was lost; without partials (unpatched Attendee, openai transcription) each
transcript.update is one utterance, as before.

The bot joins paused (LW_TEAMS_START_PAUSED=1, the default), so nothing said while the meeting is still loading
reaches the screen or the agents. Two layers: a local gate drops every transcript.partial and transcript.update
until the user presses Resume (the guarantee), and the bot is paused in Attendee too as soon as Attendee allows it
(first joined_recording; a refusal is retried on the next state change), so the UI shows it paused with a Resume
button. Resume opens the gate (and calls resume_recording only if Attendee is paused). A caption already running
at that moment must not leak its earlier words: its words before the resume become a skipped baseline, like sent
words, so only what is said after it goes out. With the local gate alone the baseline is exactly the caption's text
when the gate opens (its partials keep arriving, gated). When Attendee was paused it drops captions, so a caption
that spans the resume first shows up after it with its earlier words; the first partial of a caption that appears
within RESUME_SETTLE_S of the resume is therefore taken as that baseline (a word or two said in that second can be
lost). After the first resume, Pause and Resume only drive Attendee, as before.

Retried webhooks are deduplicated on `idempotency_key`. Transcripts go to the pipeline as soon as they arrive:
Teams captions come in spoken order (measured ~0.15 s after Teams finalizes them), so holding them back for
reordering would only add delay.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import httpx2

from .chunking import CLAUSE_END, PAUSE_MIN_WORDS, _norm, aligned_end, next_cut  # noqa: F401 (shared with talk live)
from .sources import DEFAULT_TOPIC, is_meaningless

if TYPE_CHECKING:
    from .session import Session

log = logging.getLogger("attendee")

ATTENDEE_URL = os.getenv("ATTENDEE_URL", "http://localhost:8000").rstrip("/")
API_KEY = os.getenv("ATTENDEE_API_KEY", "")
WEBHOOK_SECRET = os.getenv("ATTENDEE_WEBHOOK_SECRET", "")
PUBLIC_URL = os.getenv("LW_PUBLIC_URL", "").rstrip("/")
BOT_NAME = os.getenv("LW_ATTENDEE_BOT_NAME", "").strip() or "Whiteboard"
TRANSCRIPTION = os.getenv("LW_ATTENDEE_TRANSCRIPTION", "captions").strip().lower()   # captions | openai
TEAMS_LANGUAGE = os.getenv("ATTENDEE_TEAMS_LANGUAGE", "").strip()                    # captions language, e.g. en-us
TEAMS_LOGIN = os.getenv("ATTENDEE_TEAMS_LOGIN", "0").strip() == "1"

WEBHOOK_PATH = "/api/attendee/webhook"
TRIGGERS = ["transcript.update", "transcript.partial", "participant_events.join_leave", "bot.state_change"]
CHUNK_WORDS = int(os.getenv("LW_TEAMS_CHUNK_WORDS", "6"))      # send a running caption every this many stable words
PAUSE_S = float(os.getenv("LW_TEAMS_PAUSE_S", "0.8"))          # ... or after this long without a new partial
START_PAUSED = os.getenv("LW_TEAMS_START_PAUSED", "1").strip() != "0"   # the bot joins paused; Resume starts listening
RESUME_SETTLE_S = 1.0       # after a resume of a paused Attendee: a caption first seen this soon started before it
LEAVE_TIMEOUT_S = 6.0       # how long stop() waits for the bot to report that it left
HTTP_TIMEOUT_S = 20.0
PARTICIPANT_COLORS = ["#e8590c", "#1971c2", "#2f9e44", "#9c36b5", "#c2255c", "#0c8599", "#f08c00", "#5f3dc4",
                      "#66a80f", "#a61e4d"]
# Attendee bot state -> what the UI shows
BOT_STATES = {"ready": "joining", "staged": "joining", "scheduled": "joining", "joining": "joining",
              "joining_breakout_room": "joining", "waiting_room": "waiting_room",
              "joined_not_recording": "in_meeting", "joined_recording": "in_meeting",
              "joined_recording_paused": "paused", "joined_recording_permission_denied": "in_meeting",
              "leaving_breakout_room": "in_meeting", "leaving": "leaving",
              "post_processing": "ended", "ended": "ended", "data_deleted": "ended", "fatal_error": "error"}
# Attendee leaves after this long without hearing anything (default 10 min). A paused bot hears nothing, so allow long pauses.
SILENCE_TIMEOUT_S = 70 * 60
FINISHED_STATES = {"post_processing", "ended", "data_deleted", "fatal_error"}   # no more transcript to expect


def config_error() -> str | None:
    """What is missing before a bot can be started (shown in the UI), or None."""
    if not API_KEY:
        return "ATTENDEE_API_KEY is not set (create an API key in the Attendee dashboard and add it to .env)"
    if not PUBLIC_URL:
        return "LW_PUBLIC_URL is not set (the URL Attendee uses to reach this app's webhook: http://host.docker.internal:8010 on one laptop, else an https tunnel)"
    if not WEBHOOK_SECRET:
        return "ATTENDEE_WEBHOOK_SECRET is not set (Attendee dashboard, Settings, Webhooks)"
    return None


def teams_meeting(topic: str | None) -> dict:
    topic = (topic or "").strip()[:200]
    return {
        "id": "teams", "source": "teams",
        "title": f"Teams meeting: {topic}" if topic else "Teams meeting",
        "topic": topic or DEFAULT_TOPIC,
        "participants": [],             # filled in as people join or speak
        "utterances": [],
    }


def sign_payload(payload: dict, secret: str) -> str:
    """Attendee's webhook signature: base64 HMAC-SHA256 of the canonical JSON, keyed by the base64-decoded secret."""
    body = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return base64.b64encode(hmac.new(base64.b64decode(secret), body.encode("utf-8"), hashlib.sha256).digest()).decode()


def verify_signature(payload: dict, signature: str | None, secret: str | None = None) -> bool:
    secret = WEBHOOK_SECRET if secret is None else secret
    if not secret or not signature:
        return False
    try:
        return hmac.compare_digest(sign_payload(payload, secret), signature)
    except (binascii.Error, ValueError):
        return False


@dataclass
class _Caption:
    """One running Teams caption (transcript.partial stream) and what of it went to the agents."""
    key: str
    speaker: str
    match: tuple                                     # (speaker uuid or name, timestamp_ms): finds its transcript.update
    seq: int = 0
    words: list[str] = field(default_factory=list)   # latest text
    prev: list[str] = field(default_factory=list)    # text of the partial before
    sent: list[str] = field(default_factory=list)    # normalized words already sent to the agents
    pieces: list[tuple[str, int, str]] = field(default_factory=list)   # (utterance id, words, text) of each sent piece
    line: str | None = None                          # transcript line showing the unsent rest live
    line_text: str = ""
    closed: bool = False
    gated: bool = False                              # first seen before the gate opened (start paused)
    timer: asyncio.Task | None = None


class AttendeeSource:
    kind = "teams"

    def __init__(self, meeting_url: str, topic: str | None = None, breakout_room: str | None = None) -> None:
        self.meeting_url = meeting_url
        self.breakout_room = (breakout_room or "").strip() or None   # e.g. "Room 4": the bot waits in the main meeting until it opens
        self.topic = topic
        self.session: "Session | None" = None
        self.bot_id: str | None = None
        self.bot_name = BOT_NAME
        self.state = "idle"        # idle | creating | joining | waiting_room | in_meeting | paused | leaving | ended | error
        self.error: str | None = None
        self.done = asyncio.Event()
        self.n = 0
        self.seen: set[str] = set()                  # idempotency keys already handled
        self.order = asyncio.Lock()                  # transcripts enter the pipeline in arrival order
        self.captions: dict[str, _Caption] = {}      # transcript.partial stream, by caption id
        self.by_match: dict[tuple, _Caption] = {}    # the same, by (speaker, timestamp_ms) of its transcript.update
        self.legacy: set[tuple] = set()              # transcript.update handled without the stream: ignore its partials
        self.stopping = False
        self.listening = not START_PAUSED            # the local gate: closed until the first Resume
        self.auto_pause = START_PAUSED               # pause in Attendee too, once it allows it
        self.attendee_paused = False                 # Attendee's recording is paused (last we heard)
        self.resumed_at: float | None = None         # when a resume of a paused Attendee opened the gate
        self.control = asyncio.Lock()                # pause / resume calls one at a time
        self.client: httpx2.AsyncClient | None = None

    # ---------------------------------------------------------------- source API
    async def run(self, session: "Session") -> None:
        self.session = session
        await self._create_bot()
        await self.done.wait()

    async def close(self) -> None:
        """Hard stop (reset): tell the bot to leave."""
        for cap in self.captions.values():
            if cap.timer is not None:
                cap.timer.cancel()
        if self.bot_id and self.state not in ("ended", "error"):
            await self._leave()
        self.done.set()
        if self.client is not None:
            await self.client.aclose()
            self.client = None

    async def stop(self) -> None:
        """Ask the bot to leave, wait a moment for the last transcripts, then finish the meeting."""
        if self.stopping or self.done.is_set():
            return
        self.stopping = True
        if self.bot_id and self.state not in ("ended", "error"):
            await self._set_state("leaving")
            await self._leave()
            deadline = time.perf_counter() + LEAVE_TIMEOUT_S
            while self.state != "ended" and time.perf_counter() < deadline and not self.done.is_set():
                await asyncio.sleep(0.1)
        await self._flush_captions()
        if self.state not in ("ended", "error"):
            await self._set_state("ended")
        self.done.set()

    async def set_listening(self, on: bool) -> dict:
        """Pause or resume listening. A paused bot stays in the meeting, but Attendee drops what it hears."""
        if not self.bot_id or self.state not in ("in_meeting", "paused"):
            return {"ok": False, "error": "The bot is not in the meeting"}
        async with self.control:
            if on and not self.listening:          # the first Resume of a bot that joined paused
                return await self._open_gate()
            verb, action = ("resume", "resume_recording") if on else ("pause", "pause_recording")
            res = await self._recording(action)
            if res.get("ok"):
                await self._set_state(BOT_STATES.get(res["state"], self.state))
            return {k: v for k, v in res.items() if k != "state"}

    async def _recording(self, action: str) -> dict:
        """POST pause_recording / resume_recording: {"ok", "state"} or {"ok": False, "error"}."""
        verb = action.split("_")[0]
        try:
            res = await self._http().post(f"/api/v1/bots/{self.bot_id}/{action}")
            data = res.json()
        except Exception as exc:
            log.warning("%s failed: %s", action, exc)
            return {"ok": False, "error": f"Could not {verb} the bot: {exc}"}
        if res.status_code >= 400:
            return {"ok": False, "error": f"Attendee could not {verb} the bot: {data.get('error') or res.text[:200]}"}
        state = data.get("state", "")
        self._track(state)
        return {"ok": True, "state": state}

    async def _open_gate(self) -> dict:
        """Start listening: resume Attendee if it is paused, then let transcripts through."""
        state = "in_meeting"
        if self.attendee_paused:
            res = await self._recording("resume_recording")
            if not res["ok"]:
                return res
            state = BOT_STATES.get(res["state"], "in_meeting")
            self.resumed_at = time.monotonic()
        async with self.order:
            for cap in self.captions.values():    # running captions: their words so far are never sent
                if not cap.closed:
                    self._skip(cap, cap.words)
            self.listening, self.auto_pause = True, False
        log.info("bot %s: listening", self.bot_id)
        await self._set_state(state)
        return {"ok": True}

    async def _pause_in_attendee(self) -> None:
        """The bot joined paused: pause it in Attendee too, once (a refusal is retried on the next state change)."""
        async with self.control:
            if not self.auto_pause or self.listening or self.attendee_paused or self.done.is_set():
                return
            res = await self._recording("pause_recording")
            if not res["ok"]:
                log.info("auto pause not possible yet: %s", res["error"])
                return
            self.auto_pause = False
            await self._set_state(BOT_STATES.get(res["state"], self.state))

    def _track(self, attendee_state: str) -> None:
        """Remember whether Attendee's recording is paused."""
        if attendee_state == "joined_recording_paused":
            self.attendee_paused = True
        elif attendee_state.startswith("joined") or attendee_state in FINISHED_STATES:
            self.attendee_paused = False

    def public_state(self) -> dict:
        return {"state": self.state, "error": self.error, "bot_name": self.bot_name, "bot_id": self.bot_id,
                "transcription": TRANSCRIPTION, "breakout_room": self.breakout_room, "listening": self.listening}

    async def _set_state(self, state: str, error: str | None = None) -> None:
        if state == "in_meeting" and not self.listening:     # joined paused: shown paused until Resume
            state = "paused"
        if state == self.state and error == self.error:
            return
        self.state, self.error = state, error
        if self.session is not None:
            await self.session.emit({"type": "bot_state", **self.public_state()}, record=False)

    # ------------------------------------------------------------------ Attendee API
    def _http(self) -> httpx2.AsyncClient:
        if self.client is None:
            self.client = httpx2.AsyncClient(base_url=ATTENDEE_URL, timeout=HTTP_TIMEOUT_S,
                                             headers={"Authorization": f"Token {API_KEY}"})
        return self.client

    def _transcription_settings(self) -> dict:
        if TRANSCRIPTION == "openai":      # per-speaker audio where the platform allows it; needs an OpenAI key in Attendee
            return {"openai": {"model": "gpt-4o-transcribe", "language": "en"}}
        captions = {"teams_language": TEAMS_LANGUAGE} if TEAMS_LANGUAGE else {}
        return {"meeting_closed_captions": captions}

    def _create_body(self) -> dict:
        body: dict[str, Any] = {
            "meeting_url": self.meeting_url, "bot_name": self.bot_name,
            "transcription_settings": self._transcription_settings(),
            "recording_settings": {"format": "none"},   # transcript only: no video file, so Attendee needs no S3 bucket
            "webhooks": [{"url": f"{PUBLIC_URL}{WEBHOOK_PATH}", "triggers": TRIGGERS}],
            "automatic_leave_settings": {"silence_timeout_seconds": SILENCE_TIMEOUT_S},
        }
        teams_settings: dict[str, Any] = {}
        if TEAMS_LOGIN:
            teams_settings["use_login"] = True
        if self.breakout_room:
            teams_settings["breakout_room"] = self.breakout_room
        if teams_settings:
            body["teams_settings"] = teams_settings
        return body

    async def _create_bot(self) -> None:
        err = config_error()
        if err:
            await self._set_state("error", err)
            self.done.set()
            return
        await self._set_state("creating")
        try:
            res = await self._http().post("/api/v1/bots", json=self._create_body())
            if res.status_code >= 400:
                raise RuntimeError(f"Attendee refused the bot ({res.status_code}): {res.text[:300]}")
            data = res.json()
        except Exception as exc:
            log.warning("create bot failed: %s", exc)
            await self._set_state("error", f"Could not start the bot: {exc}")
            self.done.set()
            return
        self.bot_id = data.get("id")
        log.info("bot %s created for %s", self.bot_id, self.meeting_url)
        new = data.get("state", "joining")
        self._track(new)
        await self._set_state(BOT_STATES.get(new, "joining"))
        if new == "joined_recording":
            await self._pause_in_attendee()

    async def _leave(self) -> None:
        try:
            res = await self._http().post(f"/api/v1/bots/{self.bot_id}/leave")
            if res.status_code >= 400:
                log.warning("leave failed (%s): %s", res.status_code, res.text[:200])
        except Exception as exc:
            log.warning("leave failed: %s", exc)

    # ---------------------------------------------------------------- webhooks
    async def handle_webhook(self, payload: dict) -> None:
        """One verified webhook payload. Cheap: a transcript is handed to the pipeline, which runs in the background."""
        if self.done.is_set() or not self.bot_id or payload.get("bot_id") != self.bot_id:
            return
        key = payload.get("idempotency_key")
        if key:
            if key in self.seen:
                return
            self.seen.add(key)
        trigger, data = payload.get("trigger"), payload.get("data") or {}
        if trigger == "transcript.partial":
            await self._on_partial(data)
        elif trigger == "transcript.update":
            await self._on_transcript(data)
        elif trigger == "participant_events.join_leave":
            if data.get("event_type") == "join":
                await self._add_participant(data.get("participant_name"))
        elif trigger == "bot.state_change":
            await self._on_bot_state(data)

    async def _on_bot_state(self, data: dict) -> None:
        new = data.get("new_state", "")
        if new in FINISHED_STATES:
            await self._flush_captions()
            if new == "fatal_error":
                why = data.get("event_sub_type") or data.get("event_type") or "unknown"
                await self._set_state("error", f"The bot hit an error ({why})")
            else:
                await self._set_state("ended")
            self.done.set()
        elif new in BOT_STATES:
            self._track(new)
            await self._set_state(BOT_STATES[new])
            if new == "joined_recording":
                await self._pause_in_attendee()

    async def _on_transcript(self, data: dict) -> None:
        text = ((data.get("transcription") or {}).get("transcript") or "").strip()
        speaker = (data.get("speaker_name") or "").strip() or "Unknown"
        if self._is_bot(speaker):
            return
        match = (data.get("speaker_uuid") or speaker, data.get("timestamp_ms"))
        async with self.order:
            if not self.listening:          # joined paused: dropped, and so are its late partials
                cap = self.by_match.get(match)
                if cap is not None:
                    cap.closed = True
                else:
                    self.legacy.add(match)
                return
            cap = self.by_match.get(match) or self._same_text(speaker, text)
            if cap is not None:             # seen on the partial stream: done, or this is its final we never got
                if not cap.closed:
                    await self._close_caption(cap, text.split())
                return
            if match in self.legacy:
                return
            self.legacy.add(match)
            if is_meaningless(text):
                return
            self.n += 1
            public = {"id": f"t{self.n:03d}", "speaker": speaker, "text": text}
            s = self.session
            await self._add_participant(speaker)
            await s.emit({"type": "utterance_start", "utt": public,
                          "duration_ms": max(300, min(int(data.get("duration_ms") or 0), 3000))})
            await s.emit({"type": "utterance_final", "id": public["id"]})
            await s.submit_utterance(public)

    def _same_text(self, speaker: str, text: str) -> _Caption | None:
        """The stream caption a transcript.update belongs to when its timestamp does not match (other Attendee builds)."""
        norm = [_norm(w) for w in text.split()]
        return next((c for c in reversed(list(self.captions.values()))
                     if c.speaker == speaker and norm and [_norm(w) for w in c.words] == norm), None)

    # ------------------------------------------------------- running captions
    async def _on_partial(self, data: dict) -> None:
        key = str(data.get("caption_id") or "")
        speaker = (data.get("speaker_name") or "").strip() or "Unknown"
        if not key or self._is_bot(speaker):
            return
        async with self.order:
            cap = self.captions.get(key)
            new = cap is None
            if new:
                match = (data.get("speaker_uuid") or speaker, data.get("timestamp_ms"))
                if match in self.legacy:            # its transcript.update came first and was used
                    return
                cap = self.captions[key] = self.by_match[match] = _Caption(key, speaker, match, gated=not self.listening)
                if self.listening:
                    await self._add_participant(speaker)
            seq = int(data.get("seq") or 0)
            if cap.closed or seq <= cap.seq:      # late or out of order
                return
            cap.seq = seq
            words = (data.get("text") or "").split()
            if not self.listening:                  # joined paused: follow the caption, show and send nothing
                cap.words, cap.closed = words, bool(data.get("is_final"))
                return
            if new and self.resumed_at is not None and time.monotonic() - self.resumed_at < RESUME_SETTLE_S:
                # Attendee was paused until a moment ago: this caption started before the resume
                self._skip(cap, words)
                cap.gated = True
                if data.get("is_final"):
                    cap.closed = True
                return
            if cap.gated:                           # began before listening: its speaker joins the legend now
                await self._add_participant(speaker)
            if data.get("is_final"):
                await self._close_caption(cap, words)
                return
            cap.prev, cap.words = cap.words, words
            stable = next((i for i, (a, b) in enumerate(zip(cap.words, cap.prev)) if a != b), min(len(cap.words), len(cap.prev)))
            start = aligned_end(cap.sent, cap.words)
            while (cut := next_cut(cap.words, start, stable, CHUNK_WORDS)) is not None:
                await self._send_piece(cap, cap.words[start:cut])
                start = max(cut, aligned_end(cap.sent, cap.words))
            await self._show_rest(cap)
            if cap.timer is not None:
                cap.timer.cancel()
            cap.timer = asyncio.create_task(self._after_pause(cap, seq))

    async def _after_pause(self, cap: _Caption, seq: int) -> None:
        """No new partial for a moment: the speaker paused, so send what they said so far."""
        await asyncio.sleep(PAUSE_S)
        async with self.order:
            if cap.seq == seq and not cap.closed and not self.done.is_set():
                rest = cap.words[aligned_end(cap.sent, cap.words):]
                if len(rest) >= PAUSE_MIN_WORDS or (rest and CLAUSE_END.search(rest[-1])):
                    await self._send_piece(cap, rest)

    async def _close_caption(self, cap: _Caption, words: list[str]) -> None:
        """The final text: send what was not sent yet, and correct the text of the sent pieces if Teams revised it."""
        cap.closed, cap.words = True, words
        if cap.timer is not None:
            cap.timer.cancel()
        earlier, start = list(cap.pieces), aligned_end(cap.sent, words)
        if words[start:]:
            await self._send_piece(cap, words[start:])
        if cap.line is not None:            # nothing left to send: Teams revised the live words away
            await self.session.emit({"type": "utterance_drop", "id": cap.line})
            cap.line = None
        n_sent = j = 0
        for uid, n, text in earlier:        # on screen only: the agents keep the words they got
            n_sent += n
            end = aligned_end(cap.sent[:n_sent], words)
            fixed, j = " ".join(words[j:end]), end
            if uid is not None and fixed and fixed != text:
                await self.session.emit({"type": "utterance_final", "id": uid, "text": fixed})

    def _skip(self, cap: _Caption, words: list[str]) -> None:
        """Words of a caption said before listening started: counted as sent (never shown or sent), as a piece without a line."""
        if words:
            cap.sent += [_norm(w) for w in words]
            cap.pieces.append((None, len(words), " ".join(words)))

    async def _send_piece(self, cap: _Caption, words: list[str]) -> None:
        """One piece of a running caption becomes an utterance for the agents."""
        s, text = self.session, " ".join(words)
        cap.sent += [_norm(w) for w in words]
        uid, cap.line = cap.line, None
        if is_meaningless(text):            # a lone "okay" between sentences
            cap.pieces.append((None, len(words), text))
            if uid is not None:
                await s.emit({"type": "utterance_drop", "id": uid})
            return
        if uid is None:
            uid = await self._open_line(cap, text)
            cap.line = None
        cap.pieces.append((uid, len(words), text))
        await s.emit({"type": "utterance_final", "id": uid, "text": text})
        await s.submit_utterance({"id": uid, "speaker": cap.speaker, "text": text})

    async def _show_rest(self, cap: _Caption) -> None:
        """The unsent rest of the caption, shown live in its own transcript line."""
        rest = " ".join(cap.words[aligned_end(cap.sent, cap.words):])
        if not rest:
            return
        if cap.line is None:
            await self._open_line(cap, rest)
        elif rest != cap.line_text:
            cap.line_text = rest
            await self.session.emit({"type": "utterance_interim", "id": cap.line, "text": rest})

    async def _open_line(self, cap: _Caption, text: str) -> str:
        self.n += 1
        cap.line, cap.line_text = f"t{self.n:03d}", text
        await self.session.emit({"type": "utterance_start", "live": True,
                                 "utt": {"id": cap.line, "speaker": cap.speaker, "text": text}})
        return cap.line

    async def _flush_captions(self) -> None:
        """The meeting is ending: captions still running are final as they are."""
        if self.session is None:
            return
        async with self.order:
            for cap in list(self.captions.values()):
                if not cap.closed and self.listening:
                    await self._close_caption(cap, cap.words)
                cap.closed = True

    def _is_bot(self, name: str | None) -> bool:
        name = (name or "").strip().casefold()
        return bool(name) and (name == self.bot_name.casefold() or name.startswith(self.bot_name.casefold() + " ("))

    async def _add_participant(self, name: str | None) -> None:
        """A new speaker or joiner goes into the legend and the agents' prompts (the bot never does)."""
        name = (name or "").strip()[:40]
        s = self.session
        if not name or self._is_bot(name) or s is None:
            return
        people = s.meeting["participants"]
        if any(p["name"] == name for p in people):
            return
        people.append({"name": name, "color": PARTICIPANT_COLORS[len(people) % len(PARTICIPANT_COLORS)],
                       "role": "Meeting participant"})
        await s.emit({"type": "meeting", "meeting": s._meeting_public()})
