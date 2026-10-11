"""Agent settings, read once from the environment (LW_* variables).

Extractor, modeller and analyst run at effort "low" (output_config.effort); the background consolidator,
which periodically cleans up the modeller's incremental mistakes, at "medium". Override with LW_*_EFFORT env vars.
"""

from __future__ import annotations

import os

MODEL = os.getenv("LW_MODEL", "claude-sonnet-5-5")
EXTRACTOR_EFFORT = os.getenv("LW_EXTRACTOR_EFFORT", "low")
MODELLER_EFFORT = os.getenv("LW_MODELLER_EFFORT", "low")
ANALYST_EFFORT = os.getenv("LW_ANALYST_EFFORT", "low")
# The spec writer runs only on request (Export -> Generate spec) and writes a short one-screen summary.
SPEC_EFFORT = os.getenv("LW_SPEC_EFFORT", "low")
# The modeller is on the live path (utterance -> board), so its model and thinking can be tuned alone.
# LW_MODELLER_THINKING: "adaptive" (default) or "between_tools" (no thinking; Sonnet 5.5 only, effort <= high).
MODELLER_MODEL = os.getenv("LW_MODELLER_MODEL", MODEL)
MODELLER_THINKING = os.getenv("LW_MODELLER_THINKING", "adaptive")
EXTRACTOR_MODEL = os.getenv("LW_EXTRACTOR_MODEL", MODEL)
EXTRACTOR_THINKING = os.getenv("LW_EXTRACTOR_THINKING", "adaptive")
# LW_EXTRACTOR_BACKEND: "jev" (default; TypeSafe System One classifier, key in JEV_API_KEY) or "claude".
EXTRACTOR_BACKEND = os.getenv("LW_EXTRACTOR_BACKEND", "jev")
# The consolidator runs in the background (never blocks the board), so it defaults to more effort.
CONSOLIDATOR_MODEL = os.getenv("LW_CONSOLIDATOR_MODEL", MODEL)
CONSOLIDATOR_EFFORT = os.getenv("LW_CONSOLIDATOR_EFFORT", "medium")
CONSOLIDATOR_THINKING = os.getenv("LW_CONSOLIDATOR_THINKING", "adaptive")
# LW_LAYOUT_HINTS: "1" (default) the consolidator also returns a semantic layout plan for the active board
# (story spine, direction, placements, group orientation) that the browser's Tidy follows; "0" = graph-only layout.
LAYOUT_HINTS = os.getenv("LW_LAYOUT_HINTS", "1") != "0"
JEV_MODEL = os.getenv("LW_JEV_MODEL", "jev-latest")
MAX_TOKENS = 16000
