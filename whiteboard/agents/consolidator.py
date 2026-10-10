"""Consolidator: a background cleanup pass over the whole transcript and the whole active board.

The modeller edits one utterance at a time and never looks back, so early guesses stay on the board
(placeholders like "Agent one" next to the named "Extractor", hub edges instead of a group, loose nodes).
The consolidator re-reads everything and returns a small cleanup diff in the modeller's op vocabulary.
"""

from __future__ import annotations

import json

from .context import is_live_speech, line, participants
from .llm import CallResult, call_json
from .prompts.consolidator import CONSOLIDATOR_SPEECH_NOTES, CONSOLIDATOR_SYSTEM
from .schemas import MODELLER_SCHEMA, clean_ops
from .settings import CONSOLIDATOR_EFFORT, CONSOLIDATOR_MODEL, CONSOLIDATOR_THINKING


def build_consolidator_user(transcript: list[dict], board_compact: dict) -> str:
    return ("TRANSCRIPT SO FAR:\n" + "\n".join(line(u) for u in transcript) +
            f"\n\nCURRENT BOARD JSON (you edit the active board):\n{json.dumps(board_compact, ensure_ascii=False)}")


async def consolidate(meeting: dict, transcript: list[dict], board_compact: dict) -> CallResult:
    system = CONSOLIDATOR_SYSTEM.format(title=meeting["title"], topic=meeting["topic"],
                                        participants=participants(meeting),
                                        speech_notes=CONSOLIDATOR_SPEECH_NOTES if is_live_speech(meeting) else "")
    res = await call_json("consolidation", system, build_consolidator_user(transcript, board_compact),
                          MODELLER_SCHEMA, CONSOLIDATOR_EFFORT, model=CONSOLIDATOR_MODEL, thinking=CONSOLIDATOR_THINKING)
    res.data = clean_ops(res.data)
    return res
