"""LLM agents. All use Anthropic `claude-sonnet-5-5` via the Messages API + structured outputs (json_schema).

  extractor     one call per utterance: kind, claims, refers_to, topic_shift (or the Jev backend)
  modeller      new utterances -> a minimal diff of typed board ops
  consolidator  background cleanup diff over the whole transcript and the whole active board,
                plus a semantic layout plan for it (LW_LAYOUT_HINTS)
  analyst       background open-questions / disagreements lists, closes stale dispute markers
  spec          on request (Export menu): a Markdown spec of the system/process the meeting designed

Prompt texts live in `prompts/` (one module per agent), JSON schemas in `schemas.py`, env settings in
`settings.py`, the model clients and the call wrapper in `llm.py`.

In talk-live mode (meeting["source"] == "mic") the extractor, modeller and consolidator prompts get an
extra LIVE SPEECH section for ASR text: one speaker, fillers, fragments, long utterances.

The session calls the agents through this package (`agents.extract(...)`), so tests can fake them here.
"""

from .analyst import analyse, build_analyst_user
from .consolidator import build_consolidator_user, consolidate
from .context import is_live_speech
from .extractor import build_extractor_user, extract
from .extractor_jev import build_jev_request, extract_jev, jev_to_extraction
from .llm import CallResult, call_json, warmup
from .modeller import build_modeller_user, model
from .schemas import (ANALYST_SCHEMA, CONSOLIDATOR_SCHEMA, EXTRACTOR_SCHEMA, FLAT_OP, KINDS, LAYOUT_SCHEMA,
                      MODELLER_SCHEMA, OP_SCHEMAS, SPEC_SCHEMA, clean_ops)
from .settings import (ANALYST_EFFORT, CONSOLIDATOR_EFFORT, CONSOLIDATOR_MODEL, CONSOLIDATOR_THINKING,
                       EXTRACTOR_BACKEND, EXTRACTOR_EFFORT, EXTRACTOR_MODEL, EXTRACTOR_THINKING, JEV_MODEL,
                       LAYOUT_HINTS, MAX_TOKENS, MODEL, MODELLER_EFFORT, MODELLER_MODEL, MODELLER_THINKING,
                       SPEC_EFFORT)
from .spec import build_spec_user, generate_spec

__all__ = [
    "extract", "extract_jev", "model", "consolidate", "analyse", "generate_spec", "warmup", "CallResult",
    "call_json", "build_extractor_user", "build_jev_request", "jev_to_extraction", "build_modeller_user",
    "build_consolidator_user", "build_analyst_user", "build_spec_user", "is_live_speech", "clean_ops",
    "EXTRACTOR_SCHEMA", "MODELLER_SCHEMA", "CONSOLIDATOR_SCHEMA", "LAYOUT_SCHEMA", "ANALYST_SCHEMA", "SPEC_SCHEMA",
    "FLAT_OP", "OP_SCHEMAS", "KINDS",
    "MODEL", "MAX_TOKENS", "EXTRACTOR_BACKEND", "EXTRACTOR_MODEL", "EXTRACTOR_EFFORT", "EXTRACTOR_THINKING",
    "MODELLER_MODEL", "MODELLER_EFFORT", "MODELLER_THINKING", "CONSOLIDATOR_MODEL", "CONSOLIDATOR_EFFORT",
    "CONSOLIDATOR_THINKING", "ANALYST_EFFORT", "SPEC_EFFORT", "JEV_MODEL", "LAYOUT_HINTS",
]
