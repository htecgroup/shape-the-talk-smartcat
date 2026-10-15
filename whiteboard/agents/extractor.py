"""Extractor: classifies one new utterance (kind, claims, refers_to, topic_shift). Fast and literal.

Runs on the Jev classifier by default (extractor_jev.py); LW_EXTRACTOR_BACKEND=claude runs it on Claude, which
also rewrites the utterance into clean, self-contained claims.
"""

from __future__ import annotations

from .. import language, vocabulary
from .context import is_live_speech, line, participants
from .extractor_jev import board_line, extract_jev
from .llm import CallResult, call_json
from .prompts.extractor import EXTRACTOR_SPEECH_NOTES, EXTRACTOR_SYSTEM
from .schemas import EXTRACTOR_SCHEMA
from .settings import EXTRACTOR_BACKEND, EXTRACTOR_EFFORT, EXTRACTOR_MODEL, EXTRACTOR_THINKING


def build_extractor_user(context: list[dict], utt: dict, board: dict | None = None) -> str:
    ctx = "\n".join(line(u) for u in context[-6:]) or "(meeting just started)"
    board = board or {"current": None, "others": []}
    return (f"Current board: {board_line(board['current'])}\nOther boards: {', '.join(board['others']) or 'none'}\n\n"
            f"Recent context:\n{ctx}\n\nNEW utterance to classify:\n{line(utt)}")


async def extract(meeting: dict, context: list[dict], utt: dict, board: dict | None = None) -> CallResult:
    """`board`: BoardState.brief(), the diagram on screen, for the topic-shift question."""
    if EXTRACTOR_BACKEND == "jev":
        return await extract_jev(meeting, context, utt, board)
    system = EXTRACTOR_SYSTEM.format(title=meeting["title"], topic=meeting["topic"],
                                     participants=participants(meeting), known_terms=vocabulary.prompt_section(),
                                     speech_notes=EXTRACTOR_SPEECH_NOTES if is_live_speech(meeting) else "")
    system += language.prompt_note(meeting)
    return await call_json("extraction", system, build_extractor_user(context, utt, board), EXTRACTOR_SCHEMA,
                           EXTRACTOR_EFFORT, model=EXTRACTOR_MODEL, thinking=EXTRACTOR_THINKING)
