"""Model clients and the one call wrapper every Claude agent uses.

All Claude agents go through the Messages API with structured outputs (json_schema).
Refusals fall back server-side (fallbacks="default") so the live loop keeps getting answers.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any

from anthropic import AsyncAnthropic
from typesafe_sdk import AsyncTypeSafeClient, RetryPolicy

from .settings import EXTRACTOR_BACKEND, JEV_MODEL, MAX_TOKENS, MODEL, MODELLER_MODEL

log = logging.getLogger("agents")

_client: AsyncAnthropic | None = None
_jev_client: AsyncTypeSafeClient | None = None


def client() -> AsyncAnthropic:
    global _client
    if _client is None:
        _client = AsyncAnthropic(timeout=30, max_retries=1)
    return _client


def jev_client() -> AsyncTypeSafeClient:
    global _jev_client
    if _jev_client is None:
        _jev_client = AsyncTypeSafeClient(api_key=os.getenv("JEV_API_KEY"), model=JEV_MODEL,
                                          retry=RetryPolicy(max_retries=1, timeout=15))
    return _jev_client


@dataclass
class CallResult:
    data: dict | None
    latency_ms: int
    tokens_in: int = 0
    tokens_out: int = 0
    error: str | None = None
    confidence: float | None = None  # Jev only: confidence of the chosen kind


async def call_json(name: str, system: str, user: str, schema: dict, effort: str,
                    model: str = MODEL, thinking: str = "adaptive") -> CallResult:
    start = time.perf_counter()
    extra: dict[str, Any] = {}
    if thinking != "adaptive":
        extra["thinking"] = {"type": thinking}
    if not model.startswith("claude-haiku"):  # Haiku has no server-side refusal fallback
        extra.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    try:
        resp = await client().beta.messages.create(
            model=model,
            max_tokens=MAX_TOKENS,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
            **extra,
        )
        ms = int((time.perf_counter() - start) * 1000)
        usage = resp.usage
        if resp.stop_reason in ("refusal", "max_tokens"):
            return CallResult(None, ms, usage.input_tokens, usage.output_tokens,
                              error=f"stop_reason={resp.stop_reason}")
        content = next((b.text for b in resp.content if b.type == "text"), "{}")
        return CallResult(json.loads(content), ms, usage.input_tokens, usage.output_tokens)
    except Exception as exc:  # network, refusal, bad JSON: never crash the live loop
        ms = int((time.perf_counter() - start) * 1000)
        log.warning("%s call failed after %sms: %s", name, ms, type(exc).__name__)
        return CallResult(None, ms, error=f"{type(exc).__name__}: {str(exc)[:200]}")


async def warmup() -> None:
    """Open the HTTP connection early so the first live call is not slower."""
    try:
        await asyncio.wait_for(client().models.retrieve(MODELLER_MODEL), timeout=10)
    except Exception:
        pass
    if EXTRACTOR_BACKEND == "jev":
        try:
            await asyncio.wait_for(jev_client().models.list(), timeout=10)
        except Exception:
            pass
