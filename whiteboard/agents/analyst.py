"""Analyst: a background agent that keeps the open-questions and disagreements lists, and suggests
closing dispute markers whose disagreement was resolved."""

from __future__ import annotations

import json

from .context import line, participants
from .llm import CallResult, call_json
from .prompts.analyst import ANALYST_SYSTEM
from .schemas import ANALYST_SCHEMA
from .settings import ANALYST_EFFORT


def build_analyst_user(transcript: list[dict], board_compact: dict,
                       prev_questions: list, prev_disagreements: list) -> str:
    return ("TRANSCRIPT SO FAR:\n" + "\n".join(line(u) for u in transcript) +
            f"\n\nCURRENT BOARDS:\n{json.dumps(board_compact, ensure_ascii=False)}"
            f"\n\nYOUR PREVIOUS LISTS:\nopen_questions={json.dumps(prev_questions, ensure_ascii=False)}"
            f"\ndisagreements={json.dumps(prev_disagreements, ensure_ascii=False)}")


async def analyse(meeting: dict, transcript: list[dict], board_compact: dict,
                  prev_questions: list, prev_disagreements: list) -> CallResult:
    system = ANALYST_SYSTEM.format(title=meeting["title"], topic=meeting["topic"],
                                   participants=participants(meeting))
    user = build_analyst_user(transcript, board_compact, prev_questions, prev_disagreements)
    return await call_json("analysis", system, user, ANALYST_SCHEMA, ANALYST_EFFORT)
