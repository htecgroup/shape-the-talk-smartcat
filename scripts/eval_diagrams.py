"""Diagram evaluation: run the scripted meetings through the real agents (or take existing run files), score the final
boards against data/eval/<scenario>.expect.json, lay every board out with the real frontend code
(scripts/render_board.mjs) and measure how it draws. Writes runs/eval/<timestamp>/report.json (+ SVG / PNG per board).

uv run python scripts/eval_diagrams.py                                    # all scenarios, once each, speed 4
uv run python scripts/eval_diagrams.py --scenarios checkout hiring --repeat 3 --speed 6
uv run python scripts/eval_diagrams.py --runs runs/2026-10-24T13-58-45.json   # metrics only, no API calls
uv run python scripts/eval_diagrams.py --runs runs/eval/<ts>/*.json --judge     # + LLM judge (API calls)
uv run python scripts/eval_diagrams.py --compare runs/eval/<a>/report.json runs/eval/<b>/report.json

Metrics are in scripts/eval_metrics.py. LLM output varies run to run: compare means over --repeat N, not single runs.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import os
import shutil
import statistics
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import eval_metrics as M  # noqa: E402

EVAL_DIR = ROOT / "data" / "eval"
OUT_ROOT = ROOT / "runs" / "eval"
RENDER = ROOT / "scripts" / "render_board.mjs"
RUN_TIMEOUT_S = 1500


# ------------------------------------------------------------------ scenarios
def scenarios() -> dict[str, dict]:
    """name -> expectations (with "meeting_path" and "meeting_id" added)."""
    out = {}
    for p in sorted(EVAL_DIR.glob("*.expect.json")):
        exp = json.loads(p.read_text())
        mp = ROOT / "data" / exp["meeting"]
        exp["meeting_path"] = str(mp)
        exp["meeting_id"] = json.loads(mp.read_text())["id"]
        out[p.name.removesuffix(".expect.json")] = exp
    return out


def scenario_of(run: dict, all_: dict[str, dict]) -> str | None:
    mid = (run.get("meeting") or {}).get("id")
    return next((name for name, exp in all_.items() if exp["meeting_id"] == mid), None)


# ------------------------------------------------------------------ one headless run (child process)
async def simulate_one(meeting: str, speed: float, out: Path) -> None:
    """The scripted meeting through the real agents, as scripts/simulate.py; the run file is moved to `out`."""
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    os.environ["LW_MEETING"] = meeting
    from whiteboard import recording
    from whiteboard.session import Session
    tmp = out.parent / f".{out.stem}"
    tmp.mkdir(parents=True, exist_ok=True)
    recording.RUNS_DIR = tmp            # save_run writes here, so parallel runs never share a file name
    s = Session()
    await s.start("live", speed=speed)
    t0 = time.monotonic()
    while s.status != "finished" or not s.run_file:
        if time.monotonic() - t0 > RUN_TIMEOUT_S:
            raise SystemExit(f"timed out after {RUN_TIMEOUT_S}s")
        await asyncio.sleep(0.5)
    shutil.move(str(tmp / s.run_file), out)
    shutil.rmtree(tmp, ignore_errors=True)


async def run_all(jobs: list[tuple[str, int]], all_: dict, speed: float, parallel: int, out_dir: Path) -> list[Path]:
    """Each job in its own process (a Session per process), `parallel` at a time."""
    sem = asyncio.Semaphore(parallel)

    async def one(name: str, rep: int) -> Path | None:
        out = out_dir / f"{name}_r{rep}.json"
        async with sem:
            print(f"  start {out.name}", flush=True)
            t0 = time.monotonic()
            with open(out.with_suffix(".log"), "w") as log:
                p = await asyncio.create_subprocess_exec(
                    sys.executable, __file__, "--_simulate", all_[name]["meeting_path"], "--speed", str(speed),
                    "--_out", str(out), stdout=log, stderr=log, cwd=ROOT)
                rc = await p.wait()
            ok = rc == 0 and out.exists()
            print(f"  {'done ' if ok else 'FAILED'} {out.name} in {time.monotonic() - t0:.0f}s"
                  + ("" if ok else f" (see {out.with_suffix('.log')})"), flush=True)
            return out if ok else None

    res = await asyncio.gather(*(one(n, r) for n, r in jobs))
    return [p for p in res if p]


# ------------------------------------------------------------------ render + metrics
def render(run_path: Path, out_dir: Path, png: bool) -> list[dict]:
    """Geometry per board from the real frontend layout; SVG (and PNG via macOS Quick Look, if available)."""
    try:
        r = subprocess.run(["node", str(RENDER), str(run_path), "--out", str(out_dir)],
                           capture_output=True, text=True, check=True, timeout=300)
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"  render failed for {run_path.name}: {exc}", file=sys.stderr)
        return []
    geoms = json.loads(r.stdout)
    if png and shutil.which("qlmanage"):
        svgs = [g["svg"] for g in geoms if g.get("svg")]
        if svgs:
            subprocess.run(["qlmanage", "-t", "-s", "1600", "-o", str(out_dir), *svgs], capture_output=True, timeout=300)
        for g in geoms:
            p = Path(f"{g['svg']}.png") if g.get("svg") else None
            g["png"] = str(p) if p and p.exists() else None
    return geoms


def evaluate_run(run_path: Path, name: str | None, exp: dict | None, out_dir: Path, png: bool) -> dict:
    run = json.loads(run_path.read_text())
    boards = run["final_board"]["boards"]
    bdir = out_dir / "boards" / run_path.stem
    geoms = {g["id"]: g for g in render(run_path, bdir, png)}
    per_board = []
    for b in boards:
        g = geoms.get(b["id"])
        per_board.append({"id": b["id"], "title": b.get("title"), "kind": b.get("kind"), "parent": b.get("parent"),
                          "structural": M.structural(b), "layout": M.layout_metrics(g) if g else None,
                          "svg": g and g.get("svg"), "png": g and g.get("png")})
    res = {"scenario": name, "file": str(run_path), "boards": per_board,
           "meta": {k: run["meta"].get(k) for k in ("model", "speed", "complete", "saved_at", "efforts", "modeller", "consolidator", "extractor")}}
    if exp:
        res["expect"] = M.check_expectations(boards, exp)
        res["score"] = M.score(res["expect"], per_board)
    return res


# ------------------------------------------------------------------ LLM judge
JUDGE_SYSTEM = """You review diagrams that an AI drew live from a meeting transcript. The meeting may be in any language.
A good result: each separate topic of the talk on its own board; each board small enough to read (about 20 nodes at most),
decomposed into parts that match how the people described it; branches as decision nodes; the corrections in the talk
applied (retracted things gone); labels short and clear; no duplicates; nothing important missing; nothing invented.
A big topic may be drawn as an overview board plus detail boards (drill-down tabs): a board with "parent" is a detail
board of that overview; on the overview, a node with "detail" is a summary node standing for that detail board's
contents (drawn as a stacked card with a "+N" badge); on a detail board, nodes with "ref_board" are references to nodes of
the overview (drawn as small "from X" / "-> X" pills). Judge a topic as its overview and detail boards together.
Score each criterion 1 (bad) to 5 (excellent) and give a one-sentence reason. Be strict and concrete."""

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {k: {"type": "object", "properties": {"score": {"type": "integer"}, "reason": {"type": "string"}},
                       "required": ["score", "reason"], "additionalProperties": False}
                   for k in ("correctness", "decomposition", "readability")}
    | {"biggest_problem": {"type": "string"}},
    "required": ["correctness", "decomposition", "readability", "biggest_problem"],
    "additionalProperties": False,
}


def compact_boards(boards: list[dict]) -> list[dict]:
    out = []
    for b in boards:
        out.append({
            "id": b.get("id"), "title": b.get("title"), "kind": b.get("kind"), **({"parent": b["parent"]} if b.get("parent") else {}),
            "nodes": [{"id": n["id"], "label": n["label"], "type": n["type"], **({"note": n["note"]} if n.get("note") else {}),
                       **({"group": n["group"]} if n.get("group") else {}), **({"status": n["status"]} if n.get("status") != "confirmed" else {}),
                       **{k: n[k] for k in ("detail", "ref_board") if n.get(k)}}
                      for n in b["nodes"].values()],
            "edges": [{"from": e["from"], "to": e["to"], **({"label": e["label"]} if e.get("label") else {})} for e in b["edges"].values()],
            "groups": [g.get("label") for g in (b.get("groups") or {}).values()],
        })
    return out


async def judge(run: dict, exp: dict | None, pngs: list[str]) -> dict:
    """Readability / correctness / decomposition 1-5 from the transcript, the expectations and the boards (and PNGs)."""
    from whiteboard.agents.llm import client
    from whiteboard.agents.settings import MAX_TOKENS, MODEL
    transcript = "\n".join(f"{u['id']} {u['speaker']}: {u['text']}" for u in run["meeting"].get("utterances", []))
    expect = {k: exp[k] for k in ("note", "boards", "concepts", "decisions", "absent") if k in exp} if exp else None
    text = (f"TRANSCRIPT\n{transcript}\n\nWHAT A REVIEWER EXPECTS (rough guide, labels may differ)\n"
            f"{json.dumps(expect, ensure_ascii=False)}\n\nFINAL BOARDS\n{json.dumps(compact_boards(run['final_board']['boards']), ensure_ascii=False)}")
    content: list[dict] = [{"type": "text", "text": text}]
    for p in pngs:
        content.append({"type": "text", "text": f"Rendered board: {Path(p).name}"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                    "data": base64.b64encode(Path(p).read_bytes()).decode()}})
    try:
        resp = await client().beta.messages.create(
            model=MODEL, max_tokens=MAX_TOKENS, system=JUDGE_SYSTEM, messages=[{"role": "user", "content": content}],
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": JUDGE_SCHEMA}},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default", timeout=180)
        data = json.loads(next(b.text for b in resp.content if b.type == "text"))
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {str(exc)[:200]}"}
    data["mean"] = round(statistics.mean(data[k]["score"] for k in ("correctness", "decomposition", "readability")), 2)
    return data


# ------------------------------------------------------------------ report
def summarize(results: list[dict]) -> dict:
    by: dict[str, list[dict]] = {}
    for r in results:
        if r.get("score"):
            by.setdefault(r["scenario"], []).append(r)
    mean = lambda xs: round(statistics.mean(xs), 3) if xs else None  # noqa: E731
    sd = lambda xs: round(statistics.stdev(xs), 2) if len(xs) > 1 else 0.0  # noqa: E731
    per = {}
    for name, rs in by.items():
        lay = [b["layout"] for r in rs for b in r["boards"] if b["layout"]]
        st = [b["structural"] for r in rs for b in r["boards"]]
        totals = [r["score"]["total"] for r in rs]
        judged = [r["judge"]["mean"] for r in rs if r.get("judge", {}).get("mean") is not None]
        per[name] = {
            "n": len(rs), "total": mean(totals), "total_sd": sd(totals),
            **{k: mean([r["score"][k] for r in rs]) for k in ("content", "structure", "layout")},
            "boards": mean([r["expect"]["boards"] for r in rs]),
            "detail_boards": mean([r["expect"].get("detail_boards", 0) for r in rs]),
            "concept_coverage": mean([r["expect"]["concept_coverage"] for r in rs]),
            "decision_coverage": mean([r["expect"]["decision_coverage"] for r in rs]),
            "edge_coverage": mean([r["expect"]["edge_coverage"] for r in rs]),
            "max_nodes": mean([max((b["structural"]["nodes"] for b in r["boards"]), default=0) for r in rs]),
            "max_overview_nodes": mean([max((b["structural"]["nodes"] for b in r["boards"] if not b.get("parent")), default=0) for r in rs]),
            "max_fan_in": mean([s["max_fan_in"] for s in st]),
            "drawn_fan_in": mean([x.get("max_fan_in", 0) for x in lay]),
            "crossings_per_edge": mean([b["layout"]["crossings"] / max(1, b["layout"].get("edges", b["structural"]["edges"])) for r in rs for b in r["boards"] if b["layout"]]),
            "label_overlaps": mean([x["label_overlaps"] for x in lay]),
            "edges_through_nodes": mean([x["edges_through_nodes"] for x in lay]),
            "fit_zoom_min": mean([min((b["layout"]["fit_zoom"] for b in r["boards"] if b["layout"]), default=1) for r in rs]),
            "judge": mean(judged),
        }
    agg = {k: mean([v[k] for v in per.values() if v[k] is not None]) for k in ("total", "content", "structure", "layout", "judge")}
    return {"scenarios": per, "aggregate": agg}


def git_state() -> dict:
    try:
        commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        dirty = bool(subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=ROOT, capture_output=True, text=True).stdout.strip())
        return {"commit": commit, "dirty": dirty}
    except OSError:
        return {}


def print_tables(results: list[dict], summary: dict) -> None:
    for r in results:
        ex, sc = r.get("expect"), r.get("score")
        head = f"\n== {r['scenario'] or '?'}  {Path(r['file']).name}"
        if ex:
            head += (f"  boards {ex['boards']} (exp {ex['boards_expected']}{'' if ex['boards_ok'] else ' ✗'})"
                     + (f" + {ex['detail_boards']} detail" if ex.get("detail_boards") else "")
                     + f"  concepts {ex['concept_coverage']:.0%}  decisions {ex['decision_coverage']:.0%}"
                     + f" ({ex['decision_nodes']} nodes{'' if ex['decision_nodes_ok'] else ' ✗'})  edges {ex['edge_coverage']:.0%}")
        print(head)
        if sc:
            j = r.get("judge", {})
            print(f"   score {sc['total']:5.1f}  = content {sc['content']} + structure {sc['structure']} + layout {sc['layout']}"
                  + (f"   judge {j['mean']} (corr {j['correctness']['score']}, decomp {j['decomposition']['score']}, read {j['readability']['score']})" if j.get("mean") else ""))
        if ex and (ex["missing_concepts"] or ex["missing_decisions"] or ex["missing_edges"] or ex["absent_present"]):
            for k in ("missing_concepts", "missing_decisions", "missing_edges", "absent_present"):
                if ex[k]:
                    print(f"   {k}: {', '.join(ex[k])}")
        print(f"   {'board':<30} {'nodes':>5} {'edges':>5} {'dec':>3} {'fanin':>5} {'orph':>4} {'notes':>5} | "
              f"{'cross':>5} {'lbl/lbl':>7} {'lbl/node':>8} {'thru':>4} {'len':>5} {'aspect':>6} {'zoom':>5} {'stubs':>5} {'fanin':>5}")
        for b in r["boards"]:
            s, lay = b["structural"], b["layout"] or {}
            title = ("↳ " if b.get("parent") else "") + str(b["title"])
            print(f"   {title[:30]:<30} {s['nodes']:>5} {s['edges']:>5} {s['decisions']:>3} {s['max_fan_in']:>5} {s['orphans']:>4} {s['long_notes']:>5} | "
                  f"{lay.get('crossings', '-'):>5} {lay.get('label_overlaps', '-'):>7} {lay.get('label_node_overlaps', '-'):>8} "
                  f"{lay.get('edges_through_nodes', '-'):>4} {lay.get('edge_len_mean', '-'):>5} {lay.get('aspect', '-'):>6} {lay.get('fit_zoom', '-'):>5} "
                  f"{lay.get('stubs', '-'):>5} {lay.get('max_fan_in', '-'):>5}")
    if summary["scenarios"]:
        print(f"\n{'scenario':<12} {'n':>2} {'total':>6} {'±sd':>5} {'content':>7} {'struct':>6} {'layout':>6} {'boards':>6} "
              f"{'concepts':>8} {'decis':>5} {'edges':>5} {'maxN':>5} {'x/edge':>6} {'zoom':>5} {'judge':>5}")
        fmt = lambda v, f: format(v, f) if v is not None else "-"  # noqa: E731
        for name, v in summary["scenarios"].items():
            print(f"{name:<12} {v['n']:>2} {v['total']:>6.1f} {v['total_sd']:>5.1f} {v['content']:>7.1f} {v['structure']:>6.1f} {v['layout']:>6.1f} "
                  f"{v['boards']:>6.1f} {v['concept_coverage']:>8.0%} {v['decision_coverage']:>5.0%} {v['edge_coverage']:>5.0%} "
                  f"{v['max_nodes']:>5.1f} {fmt(v['crossings_per_edge'], '6.2f'):>6} {v['fit_zoom_min']:>5.2f} {fmt(v['judge'], '5.2f'):>5}")
        a = summary["aggregate"]
        print(f"{'AGGREGATE':<12} {'':>2} {a['total']:>6.1f} {'':>5} {a['content']:>7.1f} {a['structure']:>6.1f} {a['layout']:>6.1f}"
              + (f"   judge {a['judge']:.2f}" if a.get("judge") is not None else ""))


def compare(a_path: Path, b_path: Path) -> None:
    a, b = json.loads(a_path.read_text())["summary"], json.loads(b_path.read_text())["summary"]
    keys = ["total", "content", "structure", "layout", "boards", "detail_boards", "concept_coverage", "decision_coverage", "edge_coverage",
            "max_nodes", "max_overview_nodes", "max_fan_in", "drawn_fan_in", "crossings_per_edge", "label_overlaps", "edges_through_nodes", "fit_zoom_min", "judge"]
    print(f"A = {a_path}\nB = {b_path}\n")
    print(f"{'scenario':<12} {'metric':<20} {'A':>8} {'B':>8} {'B-A':>8}")
    for name in sorted(set(a["scenarios"]) | set(b["scenarios"])):
        sa, sb = a["scenarios"].get(name, {}), b["scenarios"].get(name, {})
        for k in keys:
            va, vb = sa.get(k), sb.get(k)
            if va is None and vb is None:
                continue
            d = f"{vb - va:+8.2f}" if va is not None and vb is not None else ""
            print(f"{name:<12} {k:<20} {'-' if va is None else f'{va:8.2f}':>8} {'-' if vb is None else f'{vb:8.2f}':>8} {d:>8}")
        print(f"{'':<12} {'(runs)':<20} {sa.get('n', 0):>8} {sb.get('n', 0):>8}")
    print()
    for k in ("total", "content", "structure", "layout", "judge"):
        va, vb = a["aggregate"].get(k), b["aggregate"].get(k)
        if va is not None or vb is not None:
            d = f"{vb - va:+8.2f}" if va is not None and vb is not None else ""
            print(f"{'AGGREGATE':<12} {k:<20} {'-' if va is None else f'{va:8.2f}':>8} {'-' if vb is None else f'{vb:8.2f}':>8} {d:>8}")


# ------------------------------------------------------------------ main
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenarios", nargs="+", help="scenario names (data/eval/<name>.expect.json); default all")
    ap.add_argument("--repeat", type=int, default=1, help="runs per scenario (LLM output varies)")
    ap.add_argument("--speed", type=float, default=4, help="meeting clock speed (default 4)")
    ap.add_argument("--parallel", type=int, default=4, help="runs at the same time")
    ap.add_argument("--runs", nargs="+", type=Path, help="evaluate these run files instead (no agent API calls)")
    ap.add_argument("--judge", action="store_true", help="also score each run with an LLM judge (API calls)")
    ap.add_argument("--judge-images", action="store_true", help="send the board PNGs to the judge too")
    ap.add_argument("--no-png", action="store_true", help="SVG only")
    ap.add_argument("--compare", nargs=2, type=Path, metavar=("A", "B"), help="print the deltas of two report.json files")
    ap.add_argument("--_simulate", help=argparse.SUPPRESS)
    ap.add_argument("--_out", type=Path, help=argparse.SUPPRESS)
    a = ap.parse_args()

    if a._simulate:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")
        logging.getLogger("httpx").setLevel(logging.WARNING)
        asyncio.run(simulate_one(a._simulate, a.speed, a._out))
        return
    if a.compare:
        compare(*a.compare)
        return

    all_ = scenarios()
    out_dir = OUT_ROOT / datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    if a.runs:
        files = [(p, scenario_of(json.loads(p.read_text()), all_)) for p in a.runs if p.suffix == ".json" and p.name != "report.json"]
    else:
        names = a.scenarios or list(all_)
        unknown = [n for n in names if n not in all_]
        if unknown:
            raise SystemExit(f"unknown scenario(s) {unknown}; have {list(all_)}")
        jobs = [(n, r) for n in names for r in range(1, a.repeat + 1)]
        print(f"running {len(jobs)} meeting(s) at speed {a.speed}, {a.parallel} at a time -> {out_dir}")
        done = asyncio.run(run_all(jobs, all_, a.speed, a.parallel, out_dir))
        files = [(p, p.stem.rsplit("_r", 1)[0]) for p in done]

    results = []
    for path, name in files:
        exp = all_.get(name) if name else None
        if not exp:
            print(f"  {path.name}: no expectations for this meeting, structure and layout only", file=sys.stderr)
        results.append(evaluate_run(path, name, exp, out_dir, png=not a.no_png))
    if a.judge:
        async def judge_all():
            return await asyncio.gather(*(judge(json.loads(Path(r["file"]).read_text()), all_.get(r["scenario"]),
                                                [b["png"] for b in r["boards"] if b.get("png")] if a.judge_images else [])
                                          for r in results))
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
        for r, j in zip(results, asyncio.run(judge_all())):
            r["judge"] = j
    summary = summarize(results)
    report = {"created": datetime.now().isoformat(timespec="seconds"), "git": git_state(),
              "settings": {"speed": None if a.runs else a.speed, "repeat": a.repeat, "judge": a.judge},
              "summary": summary, "runs": results}
    (out_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print_tables(results, summary)
    print(f"\nreport: {out_dir / 'report.json'}")


if __name__ == "__main__":
    main()
