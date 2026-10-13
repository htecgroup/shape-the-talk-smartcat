"""Consolidator: a background cleanup pass over the whole transcript and the whole active board.

The modeller edits one utterance at a time and never looks back, so early guesses stay on the board
(placeholders like "Agent one" next to the named "Extractor", hub edges instead of a group, loose nodes,
a technology a component runs on drawn as its own node, the meeting's subject drawn as a hub).
The consolidator re-reads everything and returns a small cleanup diff in the modeller's op vocabulary.
It edits the board shown in full as "active_board" of the board JSON (the pipeline may pass a board that is not
the visible tab: the one a topic shift just left, or every changed board at the end of the meeting).
With LW_LAYOUT_HINTS on it also returns a semantic layout plan for the active board (story spine, direction,
placements, group orientation) that the browser's deterministic layout follows; see BoardState.set_layout.
"""

from __future__ import annotations

import json

from .. import vocabulary
from . import settings
from .context import is_live_speech, line, participants
from .llm import CallResult, call_json
from .prompts.consolidator import CONSOLIDATOR_LAYOUT_NOTES, CONSOLIDATOR_SPEECH_NOTES, CONSOLIDATOR_SYSTEM
from .schemas import CONSOLIDATOR_SCHEMA, MODELLER_SCHEMA, clean_ops
from .settings import CONSOLIDATOR_EFFORT, CONSOLIDATOR_MODEL, CONSOLIDATOR_THINKING


def build_consolidator_user(transcript: list[dict], board_compact: dict, layout: dict | None = None) -> str:
    user = ("TRANSCRIPT SO FAR:\n" + "\n".join(line(u) for u in transcript) +
            f"\n\nCURRENT BOARD JSON (you edit the active board):\n{json.dumps(board_compact, ensure_ascii=False)}")
    if settings.LAYOUT_HINTS:
        user += f"\n\nCURRENT LAYOUT PLAN of the active board:\n{json.dumps(layout, ensure_ascii=False) if layout else 'none yet'}"
        if layout:
            missing = uncovered(board_compact, layout)
            user += f"\nNOT COVERED BY THE PLAN (added since): {', '.join(missing) if missing else 'none'}"
    return user


def uncovered(board_compact: dict, layout: dict) -> list[str]:
    """Node ids of the active board that the plan does not mention: not on the spine, not placed, and not in
    a group the plan mentions. The prompt asks the consolidator to extend the plan to cover them."""
    board = next((b for b in board_compact.get("boards", []) if b["id"] == board_compact.get("active_board")), None)
    if not board:
        return []
    named = set(layout.get("spine") or [])
    for p in layout.get("placements") or []:
        named |= {p.get("node"), p.get("anchor")}
    return [n["id"] for n in board.get("nodes", []) if isinstance(n, dict)
            and n["id"] not in named and n.get("group") not in named]


async def consolidate(meeting: dict, transcript: list[dict], board_compact: dict,
                      layout: dict | None = None) -> CallResult:
    hints = settings.LAYOUT_HINTS
    system = CONSOLIDATOR_SYSTEM.format(title=meeting["title"], topic=meeting["topic"],
                                        participants=participants(meeting), known_terms=vocabulary.prompt_section(),
                                        speech_notes=CONSOLIDATOR_SPEECH_NOTES if is_live_speech(meeting) else "",
                                        layout_notes=CONSOLIDATOR_LAYOUT_NOTES if hints else "")
    res = await call_json("consolidation", system, build_consolidator_user(transcript, board_compact, layout),
                          CONSOLIDATOR_SCHEMA if hints else MODELLER_SCHEMA, CONSOLIDATOR_EFFORT,
                          model=CONSOLIDATOR_MODEL, thinking=CONSOLIDATOR_THINKING)
    res.data = clean_ops(res.data)
    return res
