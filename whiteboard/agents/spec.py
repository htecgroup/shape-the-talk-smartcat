"""Spec writer: an on-demand agent (Export menu) that turns the boards and the transcript into a Markdown spec."""

from __future__ import annotations

import json

from .context import line, participants
from .llm import CallResult, call_json
from .prompts.spec import SPEC_SYSTEM
from .schemas import SPEC_SCHEMA
from .settings import SPEC_EFFORT

SPEC_TIMEOUT = 120   # seconds; a whole spec takes far longer than the live agents' 30 s client timeout


def build_spec_user(transcript: list[dict], boards_full: dict, questions: list, disagreements: list) -> str:
    return ("TRANSCRIPT:\n" + "\n".join(line(u) for u in transcript) +
            f"\n\nBOARDS:\n{json.dumps(boards_full, ensure_ascii=False)}"
            f"\n\nANALYST LISTS:\nopen_questions={json.dumps(questions, ensure_ascii=False)}"
            f"\ndisagreements={json.dumps(disagreements, ensure_ascii=False)}")


async def generate_spec(meeting: dict, transcript: list[dict], boards_full: dict,
                        questions: list, disagreements: list) -> CallResult:
    system = SPEC_SYSTEM.format(title=meeting["title"], topic=meeting.get("topic") or "",
                                participants=participants(meeting))
    user = build_spec_user(transcript, boards_full, questions, disagreements)
    return await call_json("spec", system, user, SPEC_SCHEMA, SPEC_EFFORT, timeout=SPEC_TIMEOUT)
