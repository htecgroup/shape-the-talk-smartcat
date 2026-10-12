"""Extractor: classifies one new utterance (kind, claims, refers_to, topic_shift). Fast and literal.

Runs on the Jev classifier by default (extractor_jev.py); LW_EXTRACTOR_BACKEND=claude runs it on Claude, which
also rewrites the utterance into clean, self-contained claims.
"""

from __future__ import annotations

from .. import vocabulary
from .context import is_live_speech, line, participants
from .extractor_jev import extract_jev
from .llm import CallResult, call_json
from .prompts.extractor import EXTRACTOR_SPEECH_NOTES, EXTRACTOR_SYSTEM
from .schemas import EXTRACTOR_SCHEMA
from .settings import EXTRACTOR_BACKEND, EXTRACTOR_EFFORT, EXTRACTOR_MODEL, EXTRACTOR_THINKING


def build_extractor_user(context: list[dict], utt: dict) -> str:
    ctx = "\n".join(line(u) for u in context[-6:]) or "(meeting just started)"
    return f"Recent context:\n{ctx}\n\nNEW utterance to classify:\n{line(utt)}"


async def extract(meeting: dict, context: list[dict], utt: dict) -> CallResult:
    if EXTRACTOR_BACKEND == "jev":
        return await extract_jev(meeting, context, utt)
    system = EXTRACTOR_SYSTEM.format(title=meeting["title"], topic=meeting["topic"],
                                     participants=participants(meeting), known_terms=vocabulary.prompt_section(),
                                     speech_notes=EXTRACTOR_SPEECH_NOTES if is_live_speech(meeting) else "")
    return await call_json("extraction", system, build_extractor_user(context, utt), EXTRACTOR_SCHEMA,
                           EXTRACTOR_EFFORT, model=EXTRACTOR_MODEL, thinking=EXTRACTOR_THINKING)
