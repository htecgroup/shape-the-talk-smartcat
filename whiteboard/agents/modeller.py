"""Board Modeller: keeps the board in sync with the meeting by emitting a minimal diff of typed ops."""

from __future__ import annotations

import json

from .. import vocabulary
from .context import is_live_speech, line, participants
from .llm import CallResult, call_json
from .prompts.modeller import FIRST_BOARD_LIVE, FIRST_BOARD_SCRIPTED, MODELLER_SPEECH_NOTES, MODELLER_SYSTEM
from .schemas import MODELLER_SCHEMA, clean_ops
from .settings import MODELLER_EFFORT, MODELLER_MODEL, MODELLER_THINKING


def build_modeller_user(board_compact: dict, window: list[dict], new_items: list[dict]) -> str:
    lines = []
    for item in new_items:
        u, ex = item["utt"], item.get("extraction") or {}
        claims = "; ".join(ex.get("claims") or []) or "-"
        ref = f" refers_to={ex['refers_to']}" if ex.get("refers_to") else ""
        shift = (" NEW_TAB_REQUESTED" if ex.get("new_tab_requested") else
                 " TOPIC_SHIFT" if ex.get("topic_shift") else " POSSIBLE_TOPIC_SHIFT" if ex.get("possible_shift") else "")
        lines.append(f"{line(u)}\n    extractor: kind={ex.get('kind', '?')}{ref}{shift} | claims: {claims}")
    ctx = "\n".join(line(u) for u in window) or "(none)"
    disputes = [f'{b["id"]}/{x["id"]}: {x.get("note") or ""}' for b in board_compact["boards"]
                for x in (b.get("nodes", []) + b.get("edges", [])) if isinstance(x, dict) and x.get("status") == "disputed"]
    return (f"CURRENT BOARD JSON:\n{json.dumps(board_compact, ensure_ascii=False)}\n\n"
            f"OPEN DISPUTES: {'; '.join(disputes) or 'none'}\n\n"
            f"RECENT TRANSCRIPT (already reflected on the board):\n{ctx}\n\n"
            f"NEW UTTERANCES to apply now (in order):\n" + "\n".join(lines))


async def model(meeting: dict, board_compact: dict, window: list[dict], new_items: list[dict]) -> CallResult:
    live = is_live_speech(meeting)
    system = MODELLER_SYSTEM.format(title=meeting["title"], topic=meeting["topic"],
                                    participants=participants(meeting), known_terms=vocabulary.prompt_section(),
                                    first_board=FIRST_BOARD_LIVE if live else FIRST_BOARD_SCRIPTED,
                                    speech_notes=MODELLER_SPEECH_NOTES if live else "")
    user = build_modeller_user(board_compact, window, new_items)
    res = await call_json("board_ops", system, user, MODELLER_SCHEMA, MODELLER_EFFORT,
                          model=MODELLER_MODEL, thinking=MODELLER_THINKING)
    res.data = clean_ops(res.data)
    return res
