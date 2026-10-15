"""Consolidator: a background cleanup pass over the whole transcript and the whole active board.

The modeller edits one utterance at a time and never looks back, so early guesses stay on the board
(placeholders like "Agent one" next to the named "Extractor", hub edges instead of a group, loose nodes,
a technology a component runs on drawn as its own node, the meeting's subject drawn as a hub).
The consolidator re-reads everything and returns a small cleanup diff in the modeller's op vocabulary.
It edits the board shown in full as "active_board" of the board JSON (the pipeline may pass a board that is not
the visible tab: the one a topic shift just left, or every changed board at the end of the meeting).
With LW_LAYOUT_HINTS on it also returns a semantic layout plan for the active board (story spine, direction,
placements, group orientation) that the browser's deterministic layout follows; see BoardState.set_layout.
A board that grew too big to read is split into an overview and detail boards (extract_subflow, BoardState).
"""

from __future__ import annotations

import json

from .. import language, vocabulary
from . import settings
from .context import is_live_speech, line, participants
from .llm import CallResult, call_json
from .prompts.consolidator import CONSOLIDATOR_LAYOUT_NOTES, CONSOLIDATOR_SPEECH_NOTES, CONSOLIDATOR_SYSTEM
from .schemas import CONSOLIDATOR_OPS_SCHEMA, CONSOLIDATOR_SCHEMA, clean_ops
from .settings import CONSOLIDATOR_EFFORT, CONSOLIDATOR_MODEL, CONSOLIDATOR_THINKING

SPLIT_OVER = 14     # a topic board with more nodes (tasks aside) is told it is too big to read: split it


def build_consolidator_user(transcript: list[dict], board_compact: dict, layout: dict | None = None) -> str:
    board_compact = dict(board_compact)
    final = board_compact.pop("final_pass", False)
    user = ("TRANSCRIPT SO FAR:\n" + "\n".join(line(u) for u in transcript) +
            f"\n\nCURRENT BOARD JSON (you edit the active board):\n{json.dumps(board_compact, ensure_ascii=False)}"
            f"\n\n{board_size(board_compact)}")
    if final:
        user += ("\nFINAL PASS: the meeting is over. This is the last chance to restructure this board: if it is too big "
                 "to read, split it into an overview and detail boards now (see OVERVIEW AND DETAIL BOARDS).")
    if settings.LAYOUT_HINTS:
        user += f"\n\nCURRENT LAYOUT PLAN of the active board:\n{json.dumps(layout, ensure_ascii=False) if layout else 'none yet'}"
        if layout:
            missing = uncovered(board_compact, layout)
            user += f"\nNOT COVERED BY THE PLAN (added since): {', '.join(missing) if missing else 'none'}"
    return user


def board_size(board_compact: dict) -> str:
    """How big the active board is and where it sits (overview or detail board): the split rule's input."""
    boards = board_compact.get("boards", [])
    board = next((b for b in boards if b["id"] == board_compact.get("active_board")), None)
    if not board:
        return "ACTIVE BOARD SIZE: no board"
    nodes = [n for n in board.get("nodes", []) if isinstance(n, dict)]
    own = [n for n in nodes if not n.get("ref_board")]
    if board.get("parent"):
        return (f"ACTIVE BOARD SIZE: {len(own)} nodes (+{len(nodes) - len(own)} references). It is a detail board of "
                f"{board['parent']!r}: never extract_subflow here.")
    details = [f'{b["id"]} ({b["title"]})' for b in boards if b.get("parent") == board["id"]]
    line = (f"ACTIVE BOARD SIZE: {len(own)} nodes, {sum(n.get('type') == 'decision' for n in own)} decisions. "
            f"Detail boards: {', '.join(details) or 'none'}.")
    drawn = [n for n in own if n.get("type") != "task"]
    if len(drawn) > SPLIT_OVER:
        line += (" That is too big to read at a glance: split its self-contained sub-flows into detail boards (or move "
                 "nodes into an existing one) now, until the overview has ~6-10 nodes.")
    return line


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
    system += language.prompt_note(meeting)
    res = await call_json("consolidation", system, build_consolidator_user(transcript, board_compact, layout),
                          CONSOLIDATOR_SCHEMA if hints else CONSOLIDATOR_OPS_SCHEMA, CONSOLIDATOR_EFFORT,
                          model=CONSOLIDATOR_MODEL, thinking=CONSOLIDATOR_THINKING)
    res.data = clean_ops(res.data)
    return res
