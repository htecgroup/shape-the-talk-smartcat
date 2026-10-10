"""Run files: every live/mic session is saved to runs/<timestamp>.json (events with timing, final board,
lists, settings and latency stats), so it can be replayed later without API calls."""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from . import agents, pipeline

if TYPE_CHECKING:
    from .session import Session

log = logging.getLogger("session")

ROOT = Path(__file__).resolve().parents[1]
RUNS_DIR = ROOT / "runs"


def list_runs() -> list[dict]:
    RUNS_DIR.mkdir(exist_ok=True)
    out = []
    for p in sorted(RUNS_DIR.glob("*.json"), reverse=True):
        try:
            meta = json.loads(p.read_text()).get("meta", {})
        except Exception:
            continue
        out.append({"file": p.name, "complete": meta.get("complete", False),
                    "speed": meta.get("speed"), "title": meta.get("title"),
                    "source": meta.get("source", "scripted"), "events": meta.get("event_count")})
    return out


def resolve_run(run: str) -> Path | None:
    """A run file by name, or "latest" (the newest complete run, else the newest one)."""
    RUNS_DIR.mkdir(exist_ok=True)
    if run == "latest":
        runs = [r for r in list_runs() if r["complete"]] or list_runs()
        return RUNS_DIR / runs[0]["file"] if runs else None
    p = RUNS_DIR / Path(run).name
    return p if p.exists() else None


def save_run(s: Session, complete: bool) -> str | None:
    """Write the session's timeline to a new run file; returns its name (None if nothing was recorded)."""
    if not s.timeline:
        return None
    RUNS_DIR.mkdir(exist_ok=True)
    # a continued talk-live session saves again into its own file (the timeline is cumulative)
    name = s.run_file or datetime.now().strftime("%Y-%m-%dT%H-%M-%S") + ("" if complete else "_partial") + ".json"
    stats = agent_latency(s.timeline)
    if s.utt_timing:
        stats["mic"] = mic_latency(s.utt_timing)
    data = {
        "meta": {"title": s.meeting["title"], "model": agents.MODEL,
                 "source": s.meeting.get("source", "scripted"),
                 "efforts": {"extractor": agents.EXTRACTOR_EFFORT, "modeller": agents.MODELLER_EFFORT,
                             "analyst": agents.ANALYST_EFFORT, "consolidator": agents.CONSOLIDATOR_EFFORT},
                 "modeller": {"model": agents.MODELLER_MODEL, "thinking": agents.MODELLER_THINKING},
                 "consolidator": {"model": agents.CONSOLIDATOR_MODEL, "thinking": agents.CONSOLIDATOR_THINKING,
                                  "every": pipeline.CONSOLIDATE_EVERY, "layout_hints": agents.settings.LAYOUT_HINTS},
                 "extractor": {"backend": agents.EXTRACTOR_BACKEND,
                               "model": agents.JEV_MODEL if agents.EXTRACTOR_BACKEND == "jev" else agents.EXTRACTOR_MODEL,
                               "thinking": agents.EXTRACTOR_THINKING},
                 "speed": s.clock.speed, "complete": complete,
                 "saved_at": datetime.now().isoformat(timespec="seconds"),
                 "event_count": len(s.timeline), "latency": stats},
        "meeting": s.meeting,
        "final_board": s.board.to_dict(),
        "questions": s.questions, "disagreements": s.disagreements,
        "events": s.timeline,
    }
    (RUNS_DIR / name).write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str))
    log.info("saved run %s (%d events) latency=%s", name, len(s.timeline), stats)
    return name


def agent_latency(timeline: list[dict]) -> dict:
    lat: dict[str, list[int]] = {}
    for ev in timeline:
        if ev["type"] == "activity" and ev["item"].get("latency_ms") is not None:
            lat.setdefault(ev["item"]["agent"], []).append(ev["item"]["latency_ms"])
    return {a: {"calls": len(v), "avg_ms": int(sum(v) / len(v)), "min_ms": min(v), "max_ms": max(v),
                "p50_ms": sorted(v)[len(v) // 2]} for a, v in lat.items()}


def mic_latency(utt_timing: dict[str, dict]) -> dict:
    """speech end -> transcript final -> board updated, per utterance (mic mode)."""
    def summary(v: list[int]) -> dict | None:
        if not v:
            return None
        v = sorted(v)
        return {"n": len(v), "avg_ms": int(sum(v) / len(v)), "p50_ms": v[len(v) // 2], "min_ms": v[0], "max_ms": v[-1]}
    stt, e2e, f2b = [], [], []
    for t in utt_timing.values():
        if t.get("speech_end_t") is not None:
            stt.append(int((t["final_t"] - t["speech_end_t"]) * 1000))
            if t.get("board_t") is not None:
                e2e.append(int((t["board_t"] - t["speech_end_t"]) * 1000))
        if t.get("board_t") is not None:
            f2b.append(int((t["board_t"] - t["final_t"]) * 1000))
    from .stt import STT_MODEL, segmentation_for
    return {"stt_model": STT_MODEL, "segmentation": segmentation_for(STT_MODEL),
            "speech_end_to_final": summary(stt), "final_to_board": summary(f2b),
            "speech_end_to_board": summary(e2e), "per_utterance": utt_timing}
