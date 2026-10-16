"""Cutting a running transcript into utterances while the person is still talking.

A running transcript (a Teams caption, a talk-live audio segment) grows word by word and is revised near its end.
It goes to the agents in pieces: at a sentence end, every `chunk_words` stable words (mid-sentence too; the modeller
and consolidator repair the board when the rest arrives), or after a pause if 3+ words or a clause wait. The final
text sends only what is left; words revised after they were sent are corrected on screen but not sent again.

`aligned_end` and `next_cut` are shared by both sources. `RunningCaption` is the talk-live driver; attendee.py keeps
its own copy of the same logic (`_Caption`), unchanged.
"""

from __future__ import annotations

import asyncio
import difflib
import re
from typing import TYPE_CHECKING, Any, Callable

from .language import to_latin

if TYPE_CHECKING:
    from .session import Session

CHUNK_WORDS = 6             # default: send a running transcript every this many stable words
PAUSE_S = 0.8               # default: ... or after this long without new text
PAUSE_MIN_WORDS = 3         # a pause sends fewer words only after a clause end ("Today I" waits for the rest)
SENTENCE_END = re.compile(r"[.?!…][\"')\]]*$")
CLAUSE_END = re.compile(r"[,;:.?!…—][\"')\]]*$")


def _norm(word: str) -> str:
    return word.strip(".,;:!?…—-\"'()[]").casefold()


def aligned_end(sent: list[str], words: list[str]) -> int:
    """How many of `words` (a newer caption text) the already sent words cover. The transcriber may have revised
    them ("costumer" -> "customer", "ice cream" -> "ice-cream"), so the texts are aligned by characters, not counted."""
    if not sent:
        return 0
    a, norm = " ".join(sent), [_norm(w) for w in words]
    b, n, pos = " ".join(norm), len(" ".join(sent)), 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if i1 >= n:
            break
        if tag == "equal":
            pos = j1 + min(n, i2) - i1
        elif tag == "replace":
            pos = j2 if i2 <= n else j1 + min(j2 - j1, n - i1)
        else:                   # delete: sent text that was dropped; insert: text added in between
            pos = j2
    count = k = 0               # words of the new text up to pos; one cut in the middle counts if mostly covered
    for w in norm:
        if not (k + len(w) <= pos or pos - k >= len(w) / 2):
            break
        count, k = count + 1, k + len(w) + 1
    return count


def next_cut(words: list[str], start: int, stable: int, chunk_words: int) -> int | None:
    """Where to cut the unsent words[start:] of a running caption, or None to wait. words[:stable] were unchanged
    since the previous partial. A sentence end counts once the text has moved past it (or it is stable); otherwise
    every chunk_words stable words go out as they are, mid-sentence too: the board feels live, and the modeller
    and consolidator repair it when the rest of the sentence arrives."""
    for i in range(len(words) - 1, start - 1, -1):
        if SENTENCE_END.search(words[i]) and (i < stable or i < len(words) - 1):
            return i + 1
    if stable - start >= chunk_words:
        return start + chunk_words
    return None


class RunningCaption:
    """One running transcript and what of it went to the agents. Each piece is its own utterance; the unsent rest
    is shown live in a transcript line. The owner serializes calls with `lock` (the pause timer takes it too)."""

    def __init__(self, session: "Session", speaker: str, new_id: Callable[[], str], lock: asyncio.Lock,
                 chunk_words: int = CHUNK_WORDS, pause_s: float = PAUSE_S,
                 active: Callable[[], bool] = lambda: True) -> None:
        self.session, self.speaker, self.new_id, self.lock = session, speaker, new_id, lock
        self.chunk_words, self.pause_s, self.active = chunk_words, pause_s, active
        self.words: list[str] = []                   # latest text
        self.sent: list[str] = []                    # normalized words already sent to the agents
        self.pieces: list[tuple[str | None, int, str]] = []   # (utterance id, words, text) of each sent piece
        self.line: str | None = None                 # transcript line showing the unsent rest live
        self.line_text = ""
        self.closed = False
        self.gen = 0                                 # bumped by every update: the pause timer checks it
        self.timer: asyncio.Task | None = None

    async def update(self, words: list[str], stable: int) -> None:
        """A newer text (words[:stable] won't change): send the pieces that are ready, show the rest live, and
        restart the pause timer."""
        self.words, self.gen = words, self.gen + 1
        start = aligned_end(self.sent, words)
        while (cut := next_cut(words, start, stable, self.chunk_words)) is not None:
            await self._send_piece(words[start:cut])
            start = max(cut, aligned_end(self.sent, words))
        await self._show_rest()
        self.cancel()
        self.timer = asyncio.create_task(self._after_pause(self.gen))

    async def _after_pause(self, gen: int) -> None:
        """No new text for a moment: the speaker paused, so send what they said so far."""
        await asyncio.sleep(self.pause_s)
        async with self.lock:
            if self.gen == gen and not self.closed and self.active():
                rest = self.words[aligned_end(self.sent, self.words):]
                if len(rest) >= PAUSE_MIN_WORDS or (rest and CLAUSE_END.search(rest[-1])):
                    await self._send_piece(rest)

    async def close(self, words: list[str], final: dict[str, Any] | None = None) -> str | None:
        """The final text: send what was not sent yet (with `final` extras such as speech_end_t on its event),
        and correct the text of the sent pieces on screen. Returns the id of the last piece sent, if any."""
        self.closed, self.words = True, words
        self.cancel()
        earlier, start, last = list(self.pieces), aligned_end(self.sent, words), None
        if words[start:]:
            last = await self._send_piece(words[start:], final or {})
        if self.line is not None:            # nothing left to send: the live words were revised away
            await self.session.emit({"type": "utterance_drop", "id": self.line})
            self.line = None
        n_sent = j = 0
        for uid, n, text in earlier:         # on screen only: the agents keep the words they got
            n_sent += n
            end = aligned_end(self.sent[:n_sent], words)
            fixed, j = " ".join(words[j:end]), end
            if uid is not None and fixed and fixed != text:
                await self.session.emit({"type": "utterance_final", "id": uid, "text": fixed})
        return last

    def cancel(self) -> None:
        if self.timer is not None:
            self.timer.cancel()
            self.timer = None

    async def open_line(self, text: str) -> str:
        self.line, self.line_text = self.new_id(), text
        await self.session.emit({"type": "utterance_start", "live": True,
                                 "utt": {"id": self.line, "speaker": self.speaker, "text": text}})
        return self.line

    async def _send_piece(self, words: list[str], final: dict[str, Any] | None = None) -> str | None:
        """One piece becomes an utterance for the agents (a lone "okay" is dropped)."""
        s, text = self.session, " ".join(words)
        self.sent += [_norm(w) for w in words]
        uid, self.line = self.line, None
        if is_meaningless(text):
            self.pieces.append((None, len(words), text))
            if uid is not None:
                await s.emit({"type": "utterance_drop", "id": uid})
            return None
        if uid is None:
            uid = await self.open_line(text)
            self.line = None
        self.pieces.append((uid, len(words), text))
        final = final or {}
        await s.emit({"type": "utterance_final", "id": uid, "text": text, **final})
        await s.submit_utterance({"id": uid, "speaker": self.speaker, "text": text},
                                 speech_end_t=final.get("speech_end_t"))
        return uid

    async def _show_rest(self) -> None:
        """The unsent rest, shown live in its own transcript line."""
        rest = " ".join(self.words[aligned_end(self.sent, self.words):])
        if not rest:
            return
        if self.line is None:
            await self.open_line(rest)
        elif rest != self.line_text:
            self.line_text = rest
            await self.session.emit({"type": "utterance_interim", "id": self.line, "text": rest})


FILLER_ONLY = {"", "um", "uh", "hmm", "mm", "mhm", "ah", "oh", "okay", "ok", "so", "yeah", "right",
               "ovaj", "znači", "znaci", "dobro", "okej", "aha", "hm", "e", "pa", "da", "eto", "ajde"}   # + Serbian


def is_meaningless(text: str) -> bool:
    """Empty transcripts or a lone filler word (VAD noise, a cough) never reach the pipeline."""
    words = [w.strip(".,!?…-\"' ").lower() for w in to_latin(text).split()]
    words = [w for w in words if w]
    return not words or (len(words) == 1 and words[0] in FILLER_ONLY)
