"""Diagram evaluation metrics (scripts/eval_metrics.py) on small synthetic boards and geometry; no API calls, no Node."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import eval_metrics as M  # noqa: E402


def board(nodes: dict[str, tuple], edges: list[tuple], groups: dict | None = None) -> dict:
    """nodes: id -> (label, type[, note]); edges: (from, to)."""
    return {
        "id": "b", "title": "B", "kind": "process", "groups": groups or {},
        "nodes": {nid: {"id": nid, "label": v[0], "type": v[1], "note": v[2] if len(v) > 2 else None, "status": "confirmed"}
                  for nid, v in nodes.items()},
        "edges": {f"{a}->{b}": {"id": f"{a}->{b}", "from": a, "to": b, "label": None} for a, b in edges},
    }


# ------------------------------------------------------------------ fuzzy matching
def test_matching_ignores_case_diacritics_and_inflection():
    assert M.matches("Verifikacija korisnika", ["verification", "verifikacija"])
    assert M.matches("Datum rođenja tačan?", "rodjenja")
    assert M.matches("Claims provider", "claim")
    assert M.matches("SEV1 incident", ["sev"])
    assert M.matches("Within working hours?", ["radno vreme", "working hours"])
    assert not M.matches("Working day", ["working hours"])           # every word of an alternative must be there
    assert not M.matches("Ops", "operator")                          # short label words don't prefix-match


# ------------------------------------------------------------------ structure
def test_structural_counts_hubs_orphans_decisions_and_long_notes():
    nodes = {f"s{i}": (f"Source {i}", "step") for i in range(6)}
    nodes |= {"hub": ("Hub", "system"), "d": ("Ok?", "decision"), "lonely": ("Lonely", "data"),
              "t": ("Write runbook", "task"), "n": ("Noted", "step", "one two three four five six seven eight nine ten eleven")}
    nodes |= {"tom": ("Tom", "actor")}       # owns a task list: not an orphan
    edges = [(f"s{i}", "hub") for i in range(6)] + [("hub", "d"), ("d", "n")]
    st = M.structural(board(nodes, edges, groups={"tl": {"id": "tl", "label": "Tom's tasks", "kind": "task_list", "owner": "tom"}}))
    assert st["nodes"] == 12 and st["edges"] == 8
    assert st["max_fan_in"] == 6 and st["hubs"] == 1 and st["max_fan_out"] == 1
    assert st["decisions"] == 1
    assert st["orphans"] == 1                 # "lonely"; a task in no flow is not an orphan
    assert st["long_notes"] == 1
    assert st["edges_per_node"] == round(8 / 12, 2)
    assert not st["too_big"]


def test_structural_ignores_dangling_and_self_edges():
    b = board({"a": ("A", "step"), "b": ("B", "step")}, [("a", "b"), ("a", "a"), ("a", "ghost")])
    assert M.structural(b)["edges"] == 1


# ------------------------------------------------------------------ expectations
def test_expectations_coverage_paths_and_absent():
    flow = board({"cart": ("Cart", "step"), "co": ("Checkout", "step"), "gw": ("Payment gateway", "system"),
                  "ok": ("Payment confirmed?", "decision"), "order": ("Create order", "step"),
                  "sms": ("SMS notification", "system")},
                 [("cart", "co"), ("co", "gw"), ("gw", "ok"), ("ok", "order")],
                 groups={"g": {"id": "g", "label": "Message bus"}})
    expect = {
        "boards": {"expected": 2, "min": 2, "max": 3},
        "decision_nodes": {"min": 1, "max": 3},
        "concepts": ["cart", ["payment gateway", "gateway"], "courier", ["message bus", "kafka"], ["restaurant", "food"]],
        "decisions": [["payment", "confirm"], ["accept"]],
        "edges": [{"from": ["cart"], "to": ["order"]},                  # 4 hops: too far
                  {"from": ["checkout"], "to": ["confirm"]},            # 2 hops
                  {"from": ["order"], "to": ["cart"]}],                 # wrong direction
        "absent": [["sms"], ["tablet"]],
    }
    r = M.check_expectations([flow], expect)
    assert r["boards"] == 1 and not r["boards_ok"]
    assert r["missing_concepts"] == ["courier", "restaurant"]          # the group label counts for "message bus"
    assert r["concept_coverage"] == 0.6
    assert r["missing_decisions"] == ["accept"] and r["decision_coverage"] == 0.5
    assert r["decision_nodes"] == 1 and r["decision_nodes_ok"]
    assert r["missing_edges"] == ["cart -> order", "order -> cart"]
    assert r["absent_present"] == ["sms"]


def test_concepts_count_in_notes_but_decisions_need_decision_nodes():
    b = board({"v": ("Verify caller", "step", "by phone number"), "d": ("Working hours", "step")}, [("v", "d")])
    r = M.check_expectations([b], {"concepts": [["phone"]], "decisions": [["working hours"]]})
    assert r["concept_coverage"] == 1.0
    assert r["missing_decisions"] == ["working hours"]


# ------------------------------------------------------------------ layout
def node(nid, x, y, w=100, h=50, type_="step"):
    return {"id": nid, "label": nid, "type": type_, "x": x, "y": y, "w": w, "h": h}


def edge(a, b, pts, label_box=None):
    return {"id": f"{a}->{b}", "from": a, "to": b, "label": "l" if label_box else None, "pts": pts, "label_box": label_box}


def test_segment_intersection():
    assert M.seg_intersection((0, 0), (10, 10), (0, 10), (10, 0)) == (5, 5)
    assert M.seg_intersection((0, 0), (10, 0), (0, 5), (10, 5)) is None       # parallel
    assert M.seg_intersection((0, 0), (4, 4), (6, 0), (10, -4)) is None       # apart


def test_layout_crossings_through_nodes_and_label_overlaps():
    nodes = [node("a", 0, 0), node("b", 400, 400), node("c", 400, 0), node("d", 0, 400), node("m", 200, 600)]
    edges = [
        edge("a", "b", [[50, 25], [350, 375]], label_box={"x": 200, "y": 200, "w": 40, "h": 20}),
        edge("c", "d", [[350, 25], [50, 375]], label_box={"x": 205, "y": 205, "w": 40, "h": 20}),   # crosses a->b, labels overlap
        edge("d", "b", [[0, 425], [0, 600], [400, 600], [400, 425]]),                               # through m
    ]
    lay = M.layout_metrics({"nodes": nodes, "edges": edges, "groups": []})
    assert lay["crossings"] == 1
    assert lay["label_overlaps"] == 1 and lay["label_node_overlaps"] == 0
    assert lay["edges_through_nodes"] == 1
    assert lay["width"] == 500 and lay["height"] == 650
    assert lay["fit_zoom"] == 1.0 and lay["aspect"] == round(500 / 650, 2)
    assert 0 < lay["edge_len_mean"] < lay["edge_len_max"]


def test_edges_meeting_at_a_shared_node_do_not_cross():
    nodes = [node("a", 0, 0), node("b", 300, -100), node("c", 300, 100)]
    edges = [edge("a", "b", [[50, 0], [40, 5], [250, -100]]), edge("a", "c", [[50, 5], [40, 0], [250, 100]])]
    assert M.layout_metrics({"nodes": nodes, "edges": edges, "groups": []})["crossings"] == 0


def test_diamond_corners_are_not_inside():
    d = node("d", 0, 0, w=100, h=100, type_="decision")
    assert M._inside(d, 0, 0) and not M._inside(d, 40, 40)
    assert M._inside(node("r", 0, 0, w=100, h=100), 40, 40)


def test_wide_board_needs_zoom():
    nodes = [node(f"n{i}", i * 300, 0) for i in range(12)]
    lay = M.layout_metrics({"nodes": nodes, "edges": [], "groups": []})
    assert lay["fit_zoom"] < 0.5


# ------------------------------------------------------------------ score
def test_score_rewards_coverage_and_penalizes_mess():
    exp = {"concept_coverage": 1.0, "decision_coverage": 1.0, "edge_coverage": 1.0, "boards_ok": True,
           "absent_present": [], "decision_nodes_ok": True}
    st = {"nodes": 10, "edges": 10, "hubs": 0, "orphans": 0, "long_notes": 0}
    clean = {"crossings": 0, "label_overlaps": 0, "label_node_overlaps": 0, "edges_through_nodes": 0,
             "edge_len_mean": 0.2, "fit_zoom": 1.0}
    best = M.score(exp, [{"structural": st, "layout": clean}])
    assert best == {"content": 40.0, "structure": 30.0, "layout": 30.0, "total": 100.0}
    messy = M.score({**exp, "concept_coverage": 0.5, "absent_present": ["sms"]},
                    [{"structural": {**st, "nodes": 25, "hubs": 1}, "layout": {**clean, "crossings": 10, "fit_zoom": 0.4}}])
    assert messy["content"] == 40 * (0.25 + 0.25 + 0.125 + 0.125) - 3
    assert messy["structure"] == 30 - 5 - 3
    assert messy["layout"] < 30 * 0.6


def test_expectation_files_are_valid():
    for p in (ROOT / "data" / "eval").glob("*.expect.json"):
        exp = json.loads(p.read_text())
        meeting = json.loads((ROOT / "data" / exp["meeting"]).read_text())
        assert meeting["utterances"] and exp["concepts"] and exp["boards"]["min"] <= exp["boards"]["expected"] <= exp["boards"]["max"]
        for spec in exp.get("edges", []):
            assert spec["from"] and spec["to"]


# ------------------------------------------------------------------ the real frontend layout in Node
@pytest.mark.skipif(not shutil.which("node"), reason="needs Node")
def test_render_board_lays_out_with_the_frontend_code(tmp_path):
    b = board({"a": ("Customer", "actor"), "b": ("Checkout", "step"), "c": ("Paid?", "decision"), "d": ("Order", "data")},
              [("a", "b"), ("b", "c"), ("c", "d")])
    b["edges"]["c->d"]["label"] = "yes"
    src = tmp_path / "board.json"
    src.write_text(json.dumps({"boards": [b]}))
    out = subprocess.run(["node", str(ROOT / "scripts" / "render_board.mjs"), str(src), "--out", str(tmp_path)],
                         capture_output=True, text=True, check=True).stdout
    [geom] = json.loads(out)
    assert {n["id"] for n in geom["nodes"]} == {"a", "b", "c", "d"}
    assert all(len(e["pts"]) >= 2 for e in geom["edges"]) and geom["edges"][2]["label_box"]
    assert Path(geom["svg"]).read_text().startswith("<svg")
    lay = M.layout_metrics(geom)
    assert lay["crossings"] == 0 and lay["edges_through_nodes"] == 0


def _render(b: dict, tmp_path: Path) -> dict:
    src = tmp_path / "board.json"
    src.write_text(json.dumps({"boards": [b]}))
    out = subprocess.run(["node", str(ROOT / "scripts" / "render_board.mjs"), str(src)], capture_output=True, text=True, check=True).stdout
    return json.loads(out)[0]


@pytest.mark.skipif(not shutil.which("node"), reason="needs Node")
def test_edges_to_most_of_a_group_are_drawn_as_one(tmp_path):
    nodes = {"o": ("Orchestrator", "system"), "x": ("Billing", "system"), "y": ("Claims", "system"), "z": ("Documents", "system"),
             "w": ("Knowledge base", "data")}
    b = board(nodes, [("o", "x"), ("o", "y"), ("o", "z"), ("y", "w")])
    for n in "xyz":
        b["nodes"][n]["group"] = "subs"
        b["edges"][f"o->{n}"]["label"] = "routes intent"
    b["groups"] = {"subs": {"id": "subs", "label": "Sub agents"}}
    geom = _render(b, tmp_path)
    [merged] = [e for e in geom["edges"] if e["to"] == "group:subs"]
    assert merged["from"] == "o" and merged["label"] == "routes intent" and sorted(merged["members"]) == ["o->x", "o->y", "o->z"]
    assert {(e["from"], e["to"]) for e in geom["edges"]} == {("o", "group:subs"), ("y", "w")}
    lay = M.layout_metrics(geom)
    assert lay["edges"] == 2 and lay["max_fan_in"] == 1 and lay["crossings"] == 0
    # a different label stays its own edge
    b["edges"]["o->z"]["label"] = "escalates"
    geom = _render(b, tmp_path)
    assert not any(e["to"] == "group:subs" for e in geom["edges"])


@pytest.mark.skipif(not shutil.which("node"), reason="needs Node")
def test_far_edges_into_a_shared_sink_end_at_stubs(tmp_path):
    # a long chain whose steps all can hand over to one person: the far ones get a stub next to them
    chain = [f"s{i}" for i in range(9)]
    nodes = {s: (f"Step {i}", "step") for i, s in enumerate(chain)} | {"h": ("Human agent", "actor")}
    edges = list(zip(chain, chain[1:])) + [("s0", "h"), ("s3", "h"), ("s6", "h"), ("s8", "h")]
    geom = _render(board(nodes, edges), tmp_path)
    stubs = [n for n in geom["nodes"] if n["type"] == "stub"]
    assert stubs and all(n["ref"] == "h" and n["label"] == "Human agent" for n in stubs)
    into_h = [e for e in geom["edges"] if e["to"] == "h"]
    assert len(into_h) + len(stubs) == 4 and len(into_h) >= 1
    for n in stubs:
        [e] = [e for e in geom["edges"] if e["to"] == n["id"]]
        assert e["ref"] == "h"
    assert M.layout_metrics(geom)["stubs"] == len(stubs)
