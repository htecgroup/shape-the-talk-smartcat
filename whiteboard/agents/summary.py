"""Meeting summarizer: runs once when the meeting ends and turns the whole conversation (every utterance, with
who said it) into a Markdown meeting summary: attendees, discussion, decisions, action items, open questions."""

from __future__ import annotations

import json

from .context import participants
from .llm import CallResult, call_json
from .prompts.summary import SUMMARY_SYSTEM
from .schemas import SUMMARY_SCHEMA
from .settings import SUMMARY_EFFORT

SUMMARY_TIMEOUT = 120   # seconds; like the spec, a whole summary takes far longer than the client's 30 s


def summary_line(u: dict, roles: dict[str, str]) -> str:
    role = roles.get(u["speaker"])
    small = " (small talk)" if u.get("kind") == "chit_chat" else ""
    return f'[{u["id"]}] {u["speaker"]}{f" ({role})" if role else ""}{small}: {u["text"]}'


def board_lines(boards: list[dict]) -> list[str]:
    """One line per non-empty board: its title and node labels (with non-confirmed statuses)."""
    out = []
    for b in boards:
        nodes = b["nodes"].values() if isinstance(b["nodes"], dict) else b["nodes"]
        labels = [n["label"] + (f' ({n["status"]})' if n.get("status", "confirmed") != "confirmed" else "")
                  for n in nodes]
        if labels:
            out.append(f'- {b["title"]}: ' + "; ".join(labels))
    return out


def build_summary_user(meeting: dict, transcript: list[dict], boards: list[dict],
                       questions: list, disagreements: list) -> str:
    roles = {p["name"]: p.get("role") for p in meeting.get("participants", [])}
    return ("TRANSCRIPT:\n" + "\n".join(summary_line(u, roles) for u in transcript) +
            f"\n\nANALYST LISTS:\nopen_questions={json.dumps(questions, ensure_ascii=False)}"
            f"\ndisagreements={json.dumps(disagreements, ensure_ascii=False)}"
            "\n\nBOARDS:\n" + ("\n".join(board_lines(boards)) or "(none)"))


async def generate_summary(meeting: dict, transcript: list[dict], boards: list[dict],
                           questions: list, disagreements: list) -> CallResult:
    system = SUMMARY_SYSTEM.format(title=meeting["title"], topic=meeting.get("topic") or "",
                                   participants=participants(meeting))
    user = build_summary_user(meeting, transcript, boards, questions, disagreements)
    return await call_json("summary", system, user, SUMMARY_SCHEMA, SUMMARY_EFFORT, timeout=SUMMARY_TIMEOUT)
