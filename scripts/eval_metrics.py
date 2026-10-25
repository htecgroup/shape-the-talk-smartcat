"""Diagram quality metrics for scripts/eval_diagrams.py. Pure functions on board dicts (as in a run's final_board)
and on the geometry scripts/render_board.mjs prints (the real frontend layout and routing).

- structural(board): size, density, hubs, orphans, decision nodes, long notes
- check_expectations(boards, expect): boards count, concept / decision / edge coverage, retracted things still shown.
  A topic may be an overview board and detail boards (board["parent"]; board.py extract_subflow): the board count is
  the topic (top-level) boards, detail boards are counted apart, and coverage looks across a topic's whole tree (a
  summary node stands for its detail board's contents, a reference node on a detail board is the overview's node)
- layout_metrics(geom): edge crossings, label overlaps, edges through nodes, edge length, aspect ratio, fit zoom, and
  the drawn edges, stubs and fan-in (what is drawn: static/board/simplify.js draws far edges into a shared sink to a
  stub next to their source and edges to most of a group as one edge to the group box; structural() counts the data)
- score(...): one 0-100 number from all of it (weights are a judgement call; compare the raw metrics too)
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections import deque

MAX_NODES = 20          # more than this on one board reads as a wall of boxes
HUB_FAN_IN = 6          # a node with this many incoming edges is a hub that tangles the layout
NOTE_WORDS = 10         # notes longer than this get cut off on the board
PANEL = (1500, 1000)    # the board panel layout_metrics measures the fit zoom for
READABLE_ZOOM = 0.6     # below this the 16 px labels are hard to read


# ------------------------------------------------------------------ fuzzy label matching
def norm(s: str) -> str:
    s = str(s or "").lower().replace("đ", "dj")
    s = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))
    s = re.sub(r"(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])", " ", s)     # sev1 -> sev 1
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def tokens(s: str) -> list[str]:
    return norm(s).split()


def _token_match(t: str, w: str) -> bool:
    """Alternative token t matches label token w: equal, or (4+ letters) w starts with t's stem, so
    inflections match (verification / verifikacija / verifikacije, claim / claims)."""
    if t == w:
        return True
    return len(t) >= 4 and w.startswith(t[:max(4, len(t) - 2)])


def matches(label: str, concept) -> bool:
    """concept: a string or a list of alternatives; matches when every token of one alternative is in the label."""
    alts = [concept] if isinstance(concept, str) else concept
    words = tokens(label)
    for alt in alts:
        ts = tokens(alt)
        if ts and all(any(_token_match(t, w) for w in words) for t in ts):
            return True
    return False


def concept_name(concept) -> str:
    return concept if isinstance(concept, str) else concept[0]


# ------------------------------------------------------------------ structure
def _edges(board: dict) -> list[dict]:
    nodes = board.get("nodes", {})
    return [e for e in board.get("edges", {}).values() if e["from"] in nodes and e["to"] in nodes and e["from"] != e["to"]]


def structural(board: dict) -> dict:
    """Reference nodes of a detail board (small "from X" / "-> X" pills for nodes of its overview) are counted apart."""
    nodes, edges = board.get("nodes", {}), _edges(board)
    refs = sum(1 for n in nodes.values() if n.get("ref_board"))
    fan_in = {nid: 0 for nid in nodes}
    fan_out = {nid: 0 for nid in nodes}
    for e in edges:
        fan_out[e["from"]] += 1
        fan_in[e["to"]] += 1
    # tasks live in task lists, unconnected by design, and so may the people who own them
    owners = {g.get("owner") for g in (board.get("groups") or {}).values()} | {n.get("assignee") for n in nodes.values()}
    orphans = [nid for nid, n in nodes.items()
               if n.get("type") != "task" and nid not in owners and not fan_in[nid] and not fan_out[nid] and not n.get("ref_board")]
    long_notes = [nid for nid, n in nodes.items() if len(str(n.get("note") or "").split()) > NOTE_WORDS]
    n = len(nodes) - refs
    return {
        "nodes": n,
        "edges": len(edges),
        "edges_per_node": round(len(edges) / n, 2) if n else 0.0,
        "max_fan_in": max(fan_in.values(), default=0),
        "max_fan_out": max(fan_out.values(), default=0),
        "hubs": sum(1 for v in fan_in.values() if v >= HUB_FAN_IN),
        "decisions": sum(1 for x in nodes.values() if x.get("type") == "decision"),
        "orphans": len(orphans),
        "long_notes": len(long_notes),
        "groups": len(board.get("groups") or {}),
        "refs": refs,
        "summaries": sum(1 for x in nodes.values() if x.get("detail")),
        "too_big": n > MAX_NODES,
    }


# ------------------------------------------------------------------ expectations
def _nodes_matching(boards: list[dict], concept, types: set[str] | None = None, notes: bool = False) -> list[tuple[int, str]]:
    """(board index, node id) of the nodes whose label (or, with notes, label or note) matches the concept."""
    return [(i, nid) for i, b in enumerate(boards) for nid, n in b.get("nodes", {}).items()
            if (types is None or n.get("type") in types)
            and (matches(n.get("label", ""), concept) or (notes and matches(n.get("note") or "", concept)))]


def topics(boards: list[dict]) -> list[list[dict]]:
    """The boards per topic: each top-level board followed by its detail boards (a detail board whose overview is
    missing is a topic of its own)."""
    ids = {b.get("id") for b in boards}
    tops = [b for b in boards if not b.get("parent") or b["parent"] not in ids]
    return [[t] + [b for b in boards if b.get("parent") == t.get("id") and b is not t] for t in tops]


def _tree_graph(tree: list[dict]) -> tuple[dict, dict]:
    """One graph for a topic's boards. Keys are (board id, node id); a reference node is the overview's node it
    stands for; a summary node and its detail board's nodes are joined both ways at no cost (the summary node is
    equivalent to its contents). Returns (key -> node, key -> [(key, cost)])."""
    top = tree[0].get("id")
    key = lambda b, nid: (top, nid) if b["nodes"][nid].get("ref_board") else (b.get("id"), nid)  # noqa: E731
    nodes, adj = {}, {}
    for b in tree:
        for nid in b.get("nodes", {}):
            if not b["nodes"][nid].get("ref_board"):
                nodes[key(b, nid)] = b["nodes"][nid]
        for e in _edges(b):
            adj.setdefault(key(b, e["from"]), []).append((key(b, e["to"]), 1))
    for nid, n in tree[0].get("nodes", {}).items():
        d = next((b for b in tree[1:] if b.get("id") == n.get("detail")), None)
        for inner in (d or {}).get("nodes", {}):
            if not d["nodes"][inner].get("ref_board"):
                adj.setdefault((top, nid), []).append(((d["id"], inner), 0))
                adj.setdefault((d["id"], inner), []).append(((top, nid), 0))
    return nodes, adj


def _reachable(adj: dict, src: set, dst: set, max_hops: int) -> bool:
    """A directed path of 1..max_hops edges from src to dst; 0-cost links (summary <-> contents) are free but a path
    needs at least one real edge (0-1 BFS over (node, moved))."""
    inf = 1 << 30
    best = {(s, False): 0 for s in src}
    q = deque((s, 0, False) for s in src)
    while q:
        u, d, moved = q.popleft()
        if d > best.get((u, moved), inf):
            continue
        if moved and u in dst:
            return True
        for v, c in adj.get(u, []):
            nd, nm = d + c, moved or c > 0
            if nd <= max_hops and nd < best.get((v, nm), inf):
                best[(v, nm)] = nd
                (q.appendleft if c == 0 else q.append)((v, nd, nm))
    return False


def check_expectations(boards: list[dict], expect: dict) -> dict:
    """How the final boards meet a scenario's expectations (data/eval/<name>.expect.json). A concept counts when a
    node label, a node note or a group label shows it; decisions only as decision nodes; an expected edge when a
    directed path of at most max_hops (3) edges joins two matching nodes in one topic (an overview and its detail
    boards, see _tree_graph). The board count is the topic boards; detail boards are counted apart."""
    rng = expect.get("boards", {})
    trees = topics(boards)
    nb = len(trees)
    group_labels = [g.get("label", "") for b in boards for g in (b.get("groups") or {}).values()]
    missing = [concept_name(c) for c in expect.get("concepts", [])
               if not _nodes_matching(boards, c, notes=True) and not any(matches(lab, c) for lab in group_labels)]
    missing_dec = [concept_name(c) for c in expect.get("decisions", []) if not _nodes_matching(boards, c, {"decision"})]
    missing_edges = []
    graphs = [_tree_graph(t) for t in trees]
    for spec in expect.get("edges", []):
        hops = spec.get("max_hops", 3)
        ok = False
        for nodes, adj in graphs:
            src = {k for k, n in nodes.items() if matches(n.get("label", ""), spec["from"])}
            dst = {k for k, n in nodes.items() if matches(n.get("label", ""), spec["to"])}
            if src and dst and _reachable(adj, src, dst, hops):
                ok = True
                break
        if not ok:
            missing_edges.append(f"{concept_name(spec['from'])} -> {concept_name(spec['to'])}")
    present_absent = [concept_name(c) for c in expect.get("absent", []) if _nodes_matching(boards, c)]
    dec_nodes = sum(1 for b in boards for n in b.get("nodes", {}).values() if n.get("type") == "decision" and not n.get("ref_board"))
    dr = expect.get("decision_nodes", {})
    cov = lambda total, miss: round(1 - len(miss) / total, 3) if total else 1.0  # noqa: E731
    return {
        "boards": nb,
        "detail_boards": len(boards) - nb,
        "boards_expected": rng.get("expected"),
        "boards_ok": rng.get("min", 0) <= nb <= rng.get("max", 99),
        "concept_coverage": cov(len(expect.get("concepts", [])), missing),
        "missing_concepts": missing,
        "decision_coverage": cov(len(expect.get("decisions", [])), missing_dec),
        "missing_decisions": missing_dec,
        "decision_nodes": dec_nodes,
        "decision_nodes_ok": dr.get("min", 0) <= dec_nodes <= dr.get("max", 999),
        "edge_coverage": cov(len(expect.get("edges", [])), missing_edges),
        "missing_edges": missing_edges,
        "absent_present": present_absent,
    }


# ------------------------------------------------------------------ layout (geometry from render_board.mjs)
def _inside(node: dict, x: float, y: float, inset: float = 0.0) -> bool:
    hw, hh = node["w"] / 2 - inset, node["h"] / 2 - inset
    if hw <= 0 or hh <= 0:
        return False
    dx, dy = abs(x - node["x"]), abs(y - node["y"])
    if node.get("type") == "decision":          # a diamond
        return dx / hw + dy / hh < 1
    return dx < hw and dy < hh


def _box(node: dict) -> tuple[float, float, float, float]:
    return node["x"] - node["w"] / 2, node["y"] - node["h"] / 2, node["x"] + node["w"] / 2, node["y"] + node["h"] / 2


def _overlap(a: tuple, b: tuple, tol: float = 1.0) -> bool:
    return a[0] + tol < b[2] and b[0] + tol < a[2] and a[1] + tol < b[3] and b[1] + tol < a[3]


def _label_box(lb: dict) -> tuple[float, float, float, float]:
    return lb["x"] - lb["w"] / 2, lb["y"] - lb["h"] / 2, lb["x"] + lb["w"] / 2, lb["y"] + lb["h"] / 2


def seg_intersection(p1, p2, p3, p4):
    """The point where segments p1-p2 and p3-p4 cross (proper crossings only; parallel or touching: None)."""
    d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0])
    if abs(d) < 1e-9:
        return None
    t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d
    u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d
    if 0 < t < 1 and 0 < u < 1:
        return p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])
    return None


def _bbox(pts) -> tuple[float, float, float, float]:
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def crossings(edges: list[dict], nodes: dict[str, dict], near: float = 14.0) -> int:
    """Edge crossings. Edges that share a node meet at it: crossings close to that node don't count;
    crossing points of one pair closer than `near` count once."""
    total = 0
    boxes = [_bbox(e["pts"]) for e in edges]
    for i in range(len(edges)):
        for j in range(i + 1, len(edges)):
            a, b = edges[i], edges[j]
            if len(a["pts"]) < 2 or len(b["pts"]) < 2 or not _overlap(boxes[i], boxes[j], tol=-1):
                continue
            shared = [nodes[n] for n in {a["from"], a["to"]} & {b["from"], b["to"]} if n in nodes]
            found: list[tuple[float, float]] = []
            for k in range(1, len(a["pts"])):
                p1, p2 = a["pts"][k - 1], a["pts"][k]
                sa = _bbox([p1, p2])
                for m in range(1, len(b["pts"])):
                    p3, p4 = b["pts"][m - 1], b["pts"][m]
                    if not _overlap(sa, _bbox([p3, p4]), tol=-0.5):
                        continue
                    x = seg_intersection(p1, p2, p3, p4)
                    if x is None or any(_inside({**s, "type": "box", "w": s["w"] + 2 * near, "h": s["h"] + 2 * near}, *x) for s in shared):
                        continue
                    if all(math.dist(x, f) >= near for f in found):
                        found.append(x)
            total += len(found)
    return total


def _densify(pts, step: float = 8.0):
    for k in range(1, len(pts)):
        (x0, y0), (x1, y1) = pts[k - 1], pts[k]
        n = max(1, math.ceil(math.dist((x0, y0), (x1, y1)) / step))
        for s in range(n + 1):
            yield x0 + (x1 - x0) * s / n, y0 + (y1 - y0) * s / n


def _length(pts) -> float:
    return sum(math.dist(pts[k - 1], pts[k]) for k in range(1, len(pts)))


def layout_metrics(geom: dict, panel: tuple[int, int] = PANEL) -> dict:
    """geom: one board from render_board.mjs ({nodes: [...], edges: [...], groups: [...]}). Stubs count as nodes; an
    edge end "group:<id>" is that group's box."""
    nodes = {n["id"]: n for n in geom["nodes"]}
    edges = [e for e in geom["edges"] if len(e.get("pts") or []) >= 2]
    fan_in: dict[str, int] = {}
    for e in edges:
        fan_in[e["to"]] = fan_in.get(e["to"], 0) + 1
    out = {"crossings": 0, "label_overlaps": 0, "label_node_overlaps": 0, "edges_through_nodes": 0,
           "edge_len_mean": 0.0, "edge_len_max": 0.0, "aspect": 1.0, "width": 0, "height": 0, "fit_zoom": 1.0,
           "edges": len(edges), "stubs": sum(1 for n in nodes.values() if n.get("type") == "stub"),
           "max_fan_in": max(fan_in.values(), default=0)}
    if not nodes:
        return out
    boxes = [_box(n) for n in nodes.values()] + [(g["x0"], g["y0"], g["x1"], g["y1"]) for g in geom.get("groups", [])]
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    x1, y1 = max(b[2] for b in boxes), max(b[3] for b in boxes)
    w, h = x1 - x0, y1 - y0
    diag = math.hypot(w, h) or 1.0
    out.update(width=round(w), height=round(h), aspect=round(w / h, 2) if h else 0.0)
    # the zoom the board shows at when fitted into the panel (margins as in tidy.js)
    pw, ph = max(320, panel[0] - 168), max(240, panel[1] - 142)
    out["fit_zoom"] = round(min(1.0, pw / max(1.0, w), ph / max(1.0, h)), 2)

    ends = nodes | {f"group:{g['id']}": {"x": (g["x0"] + g["x1"]) / 2, "y": (g["y0"] + g["y1"]) / 2,
                                         "w": g["x1"] - g["x0"], "h": g["y1"] - g["y0"]} for g in geom.get("groups", [])}
    out["crossings"] = crossings(edges, ends)
    through = 0
    for e in edges:
        for nid, n in nodes.items():
            if nid in (e["from"], e["to"]):
                continue
            if any(_inside(n, x, y, inset=4) for x, y in _densify(e["pts"])):
                through += 1
    out["edges_through_nodes"] = through
    labels = [_label_box(e["label_box"]) for e in geom["edges"] if e.get("label_box")]
    out["label_overlaps"] = sum(1 for i in range(len(labels)) for j in range(i + 1, len(labels)) if _overlap(labels[i], labels[j]))
    out["label_node_overlaps"] = sum(1 for lb in labels for n in nodes.values() if _overlap(lb, _box(n), tol=2))
    lens = [_length(e["pts"]) / diag for e in edges]
    if lens:
        out["edge_len_mean"] = round(sum(lens) / len(lens), 3)
        out["edge_len_max"] = round(max(lens), 3)
    return out


# ------------------------------------------------------------------ one number
def board_layout_score(st: dict, lay: dict) -> float:
    """0..1 for one board's layout: fewer crossings / overlaps / edges through nodes per drawn edge, readable when fitted."""
    e = max(1, lay.get("edges", st["edges"]))
    pen = (0.35 * lay["crossings"] / e + 0.08 * lay["label_overlaps"] + 0.05 * lay["label_node_overlaps"]
           + 0.1 * lay["edges_through_nodes"] + 0.5 * max(0.0, lay["edge_len_mean"] - 0.3)
           + 0.6 * max(0.0, READABLE_ZOOM - lay["fit_zoom"]))
    return max(0.0, 1.0 - pen)


def score(exp: dict, boards: list[dict]) -> dict:
    """0-100: content 40 (what was said is on the board), structure 30 (boards that read), layout 30 (how they draw).
    boards: [{"structural": {...}, "layout": {...} or None}]."""
    content = 40 * (0.5 * exp["concept_coverage"] + 0.25 * exp["decision_coverage"] + 0.125 * exp["edge_coverage"]
                    + 0.125 * exp["boards_ok"]) - 3 * len(exp["absent_present"])
    pen = 0.0
    for b in boards:
        st = b["structural"]
        pen += min(10, max(0, st["nodes"] - MAX_NODES)) + 3 * st["hubs"] + st["orphans"] + 0.5 * st["long_notes"]
    pen += 0 if exp["decision_nodes_ok"] else 3
    structure = max(0.0, 30 - pen)
    laid = [b for b in boards if b.get("layout")]
    weight = sum(max(1, b["structural"]["nodes"]) for b in laid)
    layout = 30 * sum(board_layout_score(b["structural"], b["layout"]) * max(1, b["structural"]["nodes"]) for b in laid) / weight if laid else 0.0
    content = max(0.0, content)
    return {"content": round(content, 1), "structure": round(structure, 1), "layout": round(layout, 1),
            "total": round(content + structure + layout, 1)}
