"""How meetings and utterances are written into the agents' prompts."""

from __future__ import annotations


def participants(meeting: dict) -> str:
    return "\n".join(f"- {p['name']}: {p['role']}" for p in meeting["participants"])


def line(u: dict) -> str:
    return f'[{u["id"]}] {u["speaker"]}: {u["text"]}'


def is_live_speech(meeting: dict) -> bool:
    """Talk-live mode (meeting["source"] == "mic"): prompts get an extra LIVE SPEECH section for ASR text."""
    return meeting.get("source") == "mic"
