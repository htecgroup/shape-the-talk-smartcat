"""Extractor on the Jev backend (TypeSafe System One), the default (LW_EXTRACTOR_BACKEND=jev).

Jev answers typed questions (choice / noul) about a `state`; it cannot write text, so claims are the
utterance itself.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from typesafe_sdk import Choice, Noul

from .context import is_live_speech, line, participants
from .llm import CallResult, jev_client
from .prompts.extractor_jev import (JEV_KIND_CRITERIA, JEV_KIND_INSTRUCTIONS, JEV_REFERS_TO_INSTRUCTIONS,
                                    JEV_REFERS_TO_NONE, JEV_SPEECH_NOTE, JEV_TOPIC_SHIFT_CRITERIA,
                                    JEV_TOPIC_SHIFT_INSTRUCTIONS)
from .schemas import KINDS

log = logging.getLogger("agents")

JEV_REFERS_KINDS = {"correction", "disagreement", "resolution", "undo"}
JEV_TOPIC_SHIFT_THRESHOLD = 0.5


def build_jev_request(meeting: dict, context: list[dict], utt: dict) -> tuple[dict, dict]:
    """state + questions (kind, refers_to, topic_shift) for one Jev System One call."""
    ctx = context[-6:]
    state: dict[str, Any] = {
        "meeting": {"title": meeting["title"], "topic": meeting["topic"], "participants": participants(meeting)},
        "context": [line(u) for u in ctx],
        "new_utterance": line(utt),
    }
    if is_live_speech(meeting):
        state["speech_note"] = JEV_SPEECH_NOTE
    questions: dict[str, Any] = {
        "kind": Choice(instructions=JEV_KIND_INSTRUCTIONS, criteria=JEV_KIND_CRITERIA),
        "topic_shift": Noul(instructions=JEV_TOPIC_SHIFT_INSTRUCTIONS, criteria=JEV_TOPIC_SHIFT_CRITERIA),
    }
    if ctx:
        questions["refers_to"] = Choice(instructions=JEV_REFERS_TO_INSTRUCTIONS,
                                        criteria={**{u["id"]: line(u) for u in ctx}, "none": JEV_REFERS_TO_NONE})
    return state, questions


def jev_to_extraction(utt: dict, kind: str, refers_to: str | None, topic_shift_p: float) -> dict:
    """Map Jev answers to the Claude extractor's shape."""
    if kind not in KINDS:
        kind = "new_info"
    return {"kind": kind,
            "claims": [] if kind == "chit_chat" else [utt["text"]],
            "refers_to": refers_to if kind in JEV_REFERS_KINDS and refers_to not in (None, "none") else None,
            "topic_shift": topic_shift_p >= JEV_TOPIC_SHIFT_THRESHOLD}


async def extract_jev(meeting: dict, context: list[dict], utt: dict) -> CallResult:
    start = time.perf_counter()
    try:
        state, questions = build_jev_request(meeting, context, utt)
        resp = await jev_client().system_one(state=state, questions=questions)
        ms = int((time.perf_counter() - start) * 1000)
        kind = resp.choices["kind"]
        ref = resp.choices["refers_to"].choice if "refers_to" in questions else None
        data = jev_to_extraction(utt, kind.choice, ref, resp.nouls["topic_shift"].noul)
        return CallResult(data, ms, resp.usage.input_tokens or 0, resp.usage.output_tokens or 0,
                          confidence=round(kind.confidence, 3))
    except Exception as exc:  # network, auth, bad answer: never crash the live loop
        ms = int((time.perf_counter() - start) * 1000)
        log.warning("extraction (jev) failed after %sms: %s", ms, type(exc).__name__)
        return CallResult(None, ms, error=f"{type(exc).__name__}: {str(exc)[:200]}")
