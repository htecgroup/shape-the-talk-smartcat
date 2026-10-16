"""Meeting language: what the people in a meeting speak (English or Serbian), chosen per meeting on the page.
LW_LANGUAGE sets the default (en).

The language sets what the transcriber listens for: the OpenAI transcription language in talk live and in Attendee,
and the Teams captions language. The board, the lists, the summary and the spec stay in English for every language;
the agents get a LANGUAGE note that tells them so (`prompt_note`).

Serbian transcripts are always shown and sent in Latin script: OpenAI often writes Serbian in Cyrillic, Teams
captions in Latin, and converting Cyrillic to Latin is exact, so `normalize` converts it wherever the vocabulary fix
runs (Session.emit for the viewers, Session.submit_utterance for the agents).
"""

from __future__ import annotations

import logging
import os
import unicodedata
from dataclasses import dataclass

log = logging.getLogger("language")


@dataclass(frozen=True)
class Language:
    code: str
    name: str
    stt: str                    # OpenAI transcription language (ISO 639-1)
    teams: str | None           # Teams captions language (Attendee's teams_language); None: the meeting's own
    latin: bool = False         # convert Cyrillic transcripts to Latin


LANGUAGES = {
    "en": Language("en", "English", stt="en", teams=None),
    "sr": Language("sr", "Serbian", stt="sr", teams="sr-rs", latin=True),
}


def _default(value: str) -> str:
    code = value.strip().lower()
    if code not in LANGUAGES:
        log.warning("LW_LANGUAGE=%r is not one of %s; using en", value, ", ".join(LANGUAGES))
        return "en"
    return code


DEFAULT = _default(os.getenv("LW_LANGUAGE", "en"))


def choose(code: str | None) -> str:
    """The meeting language for a code from the page or a meeting file: a known code, else the default."""
    code = (code or "").strip().lower()
    return code if code in LANGUAGES else DEFAULT


def get(code: str | None) -> Language:
    return LANGUAGES[choose(code)]


def public() -> list[dict]:
    """The choices the page offers."""
    return [{"code": lang.code, "name": lang.name} for lang in LANGUAGES.values()]


# ------------------------------------------------------------------ script
_CYRILLIC = dict(zip("абвгдђежзијклмнопрстћуфхцчш", "abvgdđežzijklmnoprstćufhcčš"))
_CYRILLIC.update({"љ": "lj", "њ": "nj", "џ": "dž"})


def to_latin(text: str) -> str:
    """Serbian Cyrillic to Latin (one-to-one; anything else is left as it is). Љ is "Lj" in a word, "LJ" in capitals."""
    out = []
    for i, ch in enumerate(text):
        low = ch.lower()
        lat = _CYRILLIC.get(low)
        if lat is None:
            out.append(ch)
        elif ch == low:
            out.append(lat)
        else:
            nxt = text[i + 1] if i + 1 < len(text) else ""
            out.append(lat.upper() if len(lat) > 1 and nxt.isupper() else lat.capitalize())
    return "".join(out)


def normalize(text: str, code: str | None) -> str:
    """Transcript text as viewers and agents get it in this meeting language."""
    return to_latin(text) if text and get(code).latin else text


def ascii_fold(text: str) -> str:
    """Letters for ids and file names: Cyrillic to Latin, đ to dj, other accents dropped (č -> c)."""
    text = to_latin(text).replace("đ", "dj").replace("Đ", "Dj")
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


# ----------------------------------------------------------------- prompts
_NOTES = {
    "sr": """

LANGUAGE: this meeting is held in Serbian. The transcript is Serbian (Latin script), with English technical terms mixed in, which speech recognition sometimes garbles. Understand it in Serbian, but write everything you output in English: labels, notes, titles, claims, questions, answers, summaries. Keep people's names and product names as they are.
Serbian cues: a correction "ne, zapravo...", "nije tako, nego...", "ispravka"; a retraction of one's own words "zaboravi to", "ignoriši to", "brišemo to"; agreement "važi", "može", "slažem se", "dogovoreno"; disagreement "ne slažem se", "nisam siguran da nam treba...", "ali onda..."; a move to another subject "pređimo na...", "sledeća tema", "ajmo sad...". Fillers ("ovaj", "znači", "pa", "dobro", "e") carry no content.""",
}


def prompt_note(meeting: dict) -> str:
    """The LANGUAGE section for the agents' system prompts ("" for English)."""
    return _NOTES.get(choose(meeting.get("language")), "")


def jev_note(meeting: dict) -> str | None:
    """The same for the Jev extractor's state (None for English)."""
    note = prompt_note(meeting).strip()
    return note.removeprefix("LANGUAGE: ") or None
