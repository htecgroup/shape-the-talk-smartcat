"""Board state: the single source of truth for every whiteboard.

The LLM never draws. It emits typed operations; this module validates and
applies them to a versioned state. Every change goes through a small set of
primitives that record their own inverse, so any utterance's changes can be
undone ("scratch that") without snapshots.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from typing import Any

NODE_TYPES = {"actor", "system", "step", "decision", "data"}
STATUSES = {"confirmed", "ghost", "disputed", "resolved"}
BOARD_KINDS = {"process", "architecture", "stakeholder", "mindmap", "timeline"}

OP_FIELDS: dict[str, tuple[set[str], set[str]]] = {
    # op name: (required fields, optional fields) -- "op", "src", "by", "board" always allowed
    "add_node": ({"id", "label", "type"}, {"status", "group", "note"}),
    "update_node": ({"id"}, {"label", "type", "note", "group"}),
    "remove_node": ({"id"}, set()),
    "connect": ({"from", "to"}, {"label", "status", "note"}),
    "disconnect": ({"edge"}, set()),
    "reroute": ({"edge"}, {"via", "new_from", "new_to", "label"}),
    "mark": ({"target", "status"}, {"note"}),
    "add_group": ({"id", "label"}, set()),
    "set_group": ({"node"}, {"group"}),
    "new_board": ({"id", "title"}, {"kind"}),
    "switch_board": ({"board"}, set()),
    "undo": ({"target_src"}, set()),
}
COMMON_FIELDS = {"op", "src", "by", "board"}
# Board ids often are "<subject>_<kind>"; a model that connects to the board id usually means the subject node.
BOARD_ID_SUFFIXES = ("_system_map", "_architecture", "_process", "_diagram", "_board", "_arch", "_flow", "_map")
# Layout plan (from the consolidator, LW_LAYOUT_HINTS): semantic hints the browser's layout follows.
LAYOUT_DIRECTIONS = {"LR", "TB"}
LAYOUT_SIDES = {"before", "after", "above", "below"}
LAYOUT_ORIENTATIONS = {"row", "column"}
LAYOUT_MAX = 24             # max spine entries / placements / group entries kept


class OpError(ValueError):
    """Raised when an op is invalid. The op is rejected, nothing is changed."""


def slug(value: Any) -> str:
    s = re.sub(r"[^a-z0-9_]+", "_", str(value).strip().lower()).strip("_")
    return s[:48]


def edge_id(src: str, dst: str) -> str:
    return f"{src}->{dst}"


def _clean(value: Any) -> Any:
    """Treat empty strings like missing values (LLMs often send "" for null)."""
    if isinstance(value, str) and not value.strip():
        return None
    return value


@dataclass
class Transaction:
    """All ops applied for one source utterance in one modeller call."""

    src: str | None
    by: str | None
    version: int
    ops: list[dict] = field(default_factory=list)
    inverse: list[tuple] = field(default_factory=list)
    undone: bool = False


class BoardState:
    def __init__(self) -> None:
        self.version = 0
        self.boards: dict[str, dict] = {}
        self.board_order: list[str] = []
        self.active: str | None = None
        self.transactions: list[Transaction] = []
        self._txn: Transaction | None = None

    # ------------------------------------------------------------------ views
    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "active": self.active,
            "boards": [copy.deepcopy(self.boards[b]) for b in self.board_order],
        }

    def compact(self, full_boards: set[str] | None = None) -> dict:
        """Small JSON for prompts. Full detail for the active board, labels for the rest."""
        full_boards = full_boards or ({self.active} if self.active else set())
        out = {"active_board": self.active, "boards": []}
        for bid in self.board_order:
            b = self.boards[bid]
            if bid in full_boards:
                nodes = []
                for n in b["nodes"].values():
                    item = {"id": n["id"], "label": n["label"], "type": n["type"], "src": n["src"]}
                    if n["status"] != "confirmed":
                        item["status"] = n["status"]
                    if n.get("note"):
                        item["note"] = n["note"]
                    if n.get("group"):
                        item["group"] = n["group"]
                    nodes.append(item)
                edges = []
                for e in b["edges"].values():
                    item = {"id": e["id"], "src": e["src"]}
                    if e.get("label"):
                        item["label"] = e["label"]
                    if e["status"] != "confirmed":
                        item["status"] = e["status"]
                    if e.get("note"):
                        item["note"] = e["note"]
                    edges.append(item)
                out["boards"].append({
                    "id": bid, "title": b["title"], "kind": b["kind"],
                    "nodes": nodes, "edges": edges,
                    "groups": [{"id": g["id"], "label": g["label"]} for g in b["groups"].values()],
                })
            else:
                out["boards"].append({
                    "id": bid, "title": b["title"], "kind": b["kind"],
                    "nodes": [f'{n["id"]} ({n["label"]})' for n in b["nodes"].values()],
                })
        return out

    def find_target(self, board_id: str, target: str) -> tuple[str, dict] | None:
        b = self.boards.get(board_id)
        if not b:
            return None
        if target in b["nodes"]:
            return "node", b["nodes"][target]
        if target in b["edges"]:
            return "edge", b["edges"][target]
        return None

    # ------------------------------------------------------------ layout plan
    def normalize_layout(self, board_id: str, raw: Any) -> dict | None:
        """A cleaned layout plan for a board, or None when the board is unknown or raw is not a plan.

        Unknown ids are dropped; a spine needs two entries; a placement needs a node and an anchor that both
        exist (node or group ids), a valid side, and a node that is not on the spine (spine order wins)."""
        b = self.boards.get(board_id)
        if b is None or not isinstance(raw, dict):
            return None
        known = lambda i: i in b["nodes"] or i in b["groups"]  # noqa: E731
        ids = lambda v: [slug(x) for x in v if isinstance(x, str)] if isinstance(v, list) else []  # noqa: E731
        direction = str(raw.get("direction") or "LR").strip().upper()
        spine: list[str] = []
        for i in ids(raw.get("spine")):
            if known(i) and i not in spine:
                spine.append(i)
        spine = spine[:LAYOUT_MAX] if len(spine) >= 2 else []
        placements: list[dict] = []
        for p in raw.get("placements") or []:
            if not isinstance(p, dict) or len(placements) >= LAYOUT_MAX:
                continue
            node, anchor, side = slug(p.get("node") or ""), slug(p.get("anchor") or ""), p.get("side")
            if (known(node) and known(anchor) and node != anchor and side in LAYOUT_SIDES and node not in spine
                    and all(q["node"] != node for q in placements)):
                placements.append({"node": node, "side": side, "anchor": anchor})
        groups: list[dict] = []
        for g in raw.get("groups") or []:
            gid = slug(g.get("group") or "") if isinstance(g, dict) else ""
            if gid in b["groups"] and g.get("orientation") in LAYOUT_ORIENTATIONS and all(q["group"] != gid for q in groups):
                groups.append({"group": gid, "orientation": g["orientation"]})
        return {"direction": direction if direction in LAYOUT_DIRECTIONS else "LR",
                "spine": spine, "placements": placements, "groups": groups[:LAYOUT_MAX]}

    def set_layout(self, board_id: str, raw: Any) -> dict | None:
        """Store a validated layout plan on the board (board["layout"], so it is part of to_dict(), snapshots
        and saved runs). Returns the stored plan if it changed, else None. Not part of undo: a plan only
        orders what is on the board, and the browser ignores ids that are gone."""
        plan = self.normalize_layout(board_id, raw)
        if plan is None or plan == self.layout_of(board_id):
            return None
        self.version += 1
        plan["v"] = self.version
        self.boards[board_id]["layout"] = plan
        return plan

    def layout_of(self, board_id: str | None) -> dict | None:
        """The board's current plan without its version stamp (what the consolidator sees)."""
        plan = (self.boards.get(board_id) or {}).get("layout") if board_id else None
        return {k: v for k, v in plan.items() if k != "v"} if plan else None

    # ------------------------------------------------------------- primitives
    # Every mutation goes through these. Each records the primitive that undoes it.
    def _record(self, inverse: tuple) -> None:
        if self._txn is not None:
            self._txn.inverse.append(inverse)

    def _put_node(self, bid: str, node: dict | None, nid: str) -> None:
        nodes = self.boards[bid]["nodes"]
        self._record(("node", bid, nid, copy.deepcopy(nodes.get(nid))))
        if node is None:
            nodes.pop(nid, None)
        else:
            nodes[nid] = node

    def _put_edge(self, bid: str, edge: dict | None, eid: str) -> None:
        edges = self.boards[bid]["edges"]
        self._record(("edge", bid, eid, copy.deepcopy(edges.get(eid))))
        if edge is None:
            edges.pop(eid, None)
        else:
            edges[eid] = edge

    def _put_group(self, bid: str, group: dict | None, gid: str) -> None:
        groups = self.boards[bid]["groups"]
        self._record(("group", bid, gid, copy.deepcopy(groups.get(gid))))
        if group is None:
            groups.pop(gid, None)
        else:
            groups[gid] = group

    def _put_board(self, bid: str, board: dict | None) -> None:
        self._record(("board", bid, copy.deepcopy(self.boards.get(bid)), list(self.board_order)))
        if board is None:
            self.boards.pop(bid, None)
            self.board_order = [b for b in self.board_order if b != bid]
        else:
            self.boards[bid] = board
            if bid not in self.board_order:
                self.board_order.append(bid)

    def _set_active(self, bid: str | None) -> None:
        self._record(("active", self.active))
        self.active = bid

    def _revert(self, inv: tuple) -> None:
        kind = inv[0]
        if kind == "node":
            _, bid, nid, old = inv
            if bid in self.boards:
                self._put_node(bid, copy.deepcopy(old), nid)
        elif kind == "edge":
            _, bid, eid, old = inv
            if bid in self.boards:
                self._put_edge(bid, copy.deepcopy(old), eid)
        elif kind == "group":
            _, bid, gid, old = inv
            if bid in self.boards:
                self._put_group(bid, copy.deepcopy(old), gid)
        elif kind == "board":
            _, bid, old, order = inv
            self._put_board(bid, copy.deepcopy(old))
            if old is not None:
                self.board_order = [b for b in order if b in self.boards] + [
                    b for b in self.board_order if b not in order
                ]
        elif kind == "active":
            self._set_active(inv[1] if (inv[1] is None or inv[1] in self.boards) else self.active)

    # ------------------------------------------------------------- validation
    def normalize(self, raw: dict) -> dict:
        """Return a cleaned copy of an op, or raise OpError."""
        if not isinstance(raw, dict):
            raise OpError("op is not an object")
        name = raw.get("op")
        if name not in OP_FIELDS:
            raise OpError(f"unknown op {name!r}")
        required, optional = OP_FIELDS[name]
        op = {k: _clean(v) for k, v in raw.items() if k in required | optional | COMMON_FIELDS}
        missing = [f for f in sorted(required) if op.get(f) is None]
        if missing:
            raise OpError(f"{name}: missing {', '.join(missing)}")
        for k in ("id", "from", "to", "via", "new_from", "new_to", "node", "group", "board"):
            if op.get(k) is not None:
                op[k] = slug(op[k])
                if not op[k]:
                    raise OpError(f"{name}: empty {k}")
        if "type" in op and op["type"] is not None and op["type"] not in NODE_TYPES:
            raise OpError(f"{name}: bad node type {op['type']!r}")
        if "status" in op and op["status"] is not None and op["status"] not in STATUSES:
            raise OpError(f"{name}: bad status {op['status']!r}")
        if name == "new_board" and op.get("kind") not in BOARD_KINDS:
            op["kind"] = "process" if op.get("kind") is None else op["kind"]
            if op["kind"] not in BOARD_KINDS:
                raise OpError(f"new_board: bad kind {op['kind']!r}")
        for k in ("label", "title", "note"):
            if op.get(k) is not None:
                op[k] = str(op[k]).strip()[:120]
        return op

    # ---------------------------------------------------------------- applying
    def apply_ops(self, ops: list[dict], default_by: str | None = None,
                  by_lookup: dict[str, str] | None = None,
                  guard_version: int | None = None) -> dict:
        """Validate and apply ops in order. Invalid ops are rejected, the rest applied.

        Ops are grouped into transactions by their `src` utterance so undo can
        revert one utterance's effect. Returns {"applied": [...], "rejected": [...]}.
        `guard_version`: if set, mark ops on elements changed after that version
        are rejected as stale (used by the async analyst).
        """
        applied: list[dict] = []
        rejected: list[dict] = []
        if not ops:
            return {"applied": applied, "rejected": rejected, "version": self.version}
        self.version += 1
        txns: dict[str | None, Transaction] = {}
        for raw in ops:
            try:
                op = self.normalize(raw)
                src = op.get("src")
                if by_lookup is not None and src is not None:
                    if src not in by_lookup:
                        raise OpError(f"unknown src utterance {src!r}")
                    op["by"] = by_lookup[src]
                op.setdefault("by", default_by)
                if op.get("by") is None:
                    op["by"] = default_by
                txn = txns.get(src)
                if txn is None:
                    txn = Transaction(src=src, by=op.get("by"), version=self.version)
                    txns[src] = txn
                self._txn = txn
                mark_len = len(txn.inverse)
                try:
                    self._apply_one(op, guard_version)
                except OpError:
                    # roll back any partial primitives of this op
                    while len(txn.inverse) > mark_len:
                        inv = txn.inverse.pop()
                        self._txn = None
                        self._revert(inv)
                        self._txn = txn
                    raise
                txn.ops.append(op)
                applied.append(op)
            except OpError as exc:
                rejected.append({"op": raw, "error": str(exc)})
            finally:
                self._txn = None
        for txn in txns.values():
            if txn.ops:
                self.transactions.append(txn)
        if not applied:
            self.version -= 1
        return {"applied": applied, "rejected": rejected, "version": self.version}

    def _board_for(self, op: dict) -> str:
        bid = op.get("board") or self.active
        if bid is None:
            # first content op ever: create a default board
            self._put_board("main", self._empty_board("main", "Whiteboard", "process"))
            self._set_active("main")
            bid = "main"
        if bid not in self.boards:
            raise OpError(f"unknown board {bid!r}")
        return bid

    @staticmethod
    def _empty_board(bid: str, title: str, kind: str) -> dict:
        return {"id": bid, "title": title, "kind": kind, "nodes": {}, "edges": {}, "groups": {}}

    def _stamp(self, item: dict, op: dict) -> None:
        item["by"] = op.get("by")
        item["src"] = op.get("src")
        item["v"] = self.version

    def _apply_one(self, op: dict, guard_version: int | None) -> None:
        name = op["op"]
        handler = getattr(self, f"_op_{name}")
        handler(op, guard_version) if name == "mark" else handler(op)

    def _op_add_node(self, op: dict) -> None:
        bid = self._board_for(op)
        b = self.boards[bid]
        if op["id"] in b["nodes"]:
            raise OpError(f"add_node: node {op['id']!r} already exists")
        group = op.get("group")
        if group and group not in b["groups"]:
            raise OpError(f"add_node: unknown group {group!r}")
        node = {"id": op["id"], "label": op["label"], "type": op["type"],
                "status": op.get("status") or "confirmed", "note": op.get("note"),
                "group": group, "created_v": self.version}
        self._stamp(node, op)
        self._put_node(bid, node, op["id"])

    def _op_update_node(self, op: dict) -> None:
        bid = self._board_for(op)
        b = self.boards[bid]
        old = b["nodes"].get(op["id"])
        if old is None:
            raise OpError(f"update_node: no node {op['id']!r}")
        node = copy.deepcopy(old)
        changed = False
        for k in ("label", "type", "note", "group"):
            if op.get(k) is not None and op[k] != node.get(k):
                if k == "group" and op[k] not in b["groups"]:
                    raise OpError(f"update_node: unknown group {op[k]!r}")
                node[k] = op[k]
                changed = True
        if not changed:
            raise OpError("update_node: nothing to change")
        self._stamp(node, op)
        self._put_node(bid, node, op["id"])

    def _op_remove_node(self, op: dict) -> None:
        bid = self._board_for(op)
        b = self.boards[bid]
        if op["id"] not in b["nodes"]:
            raise OpError(f"remove_node: no node {op['id']!r}")
        for eid, e in list(b["edges"].items()):
            if e["from"] == op["id"] or e["to"] == op["id"]:
                self._put_edge(bid, None, eid)
        self._put_node(bid, None, op["id"])

    def _add_edge(self, bid: str, src: str, dst: str, op: dict, label=None, status=None, note=None):
        b = self.boards[bid]
        for end in (src, dst):
            if end not in b["nodes"]:
                raise OpError(f"{op['op']}: no node {end!r}")
        if src == dst:
            raise OpError(f"{op['op']}: self-loop on {src!r}")
        eid = edge_id(src, dst)
        old = b["edges"].get(eid)
        edge = {"id": eid, "from": src, "to": dst, "label": label,
                "status": status or "confirmed", "note": note}
        if old is not None:
            if old.get("label") == label and old["status"] == edge["status"]:
                raise OpError(f"{op['op']}: edge {eid!r} already exists")
            edge["label"] = label if label is not None else old.get("label")
        self._stamp(edge, op)
        self._put_edge(bid, edge, eid)

    def _node_ref(self, bid: str, op: dict, key: str) -> None:
        """Endpoint that is a board (tab) id, not a node: use the node it names, or reject clearly."""
        ref = op.get(key)
        if not ref or ref in self.boards[bid]["nodes"] or ref not in self.boards:
            return
        for suffix in BOARD_ID_SUFFIXES:
            if ref.endswith(suffix) and ref[:-len(suffix)] in self.boards[bid]["nodes"]:
                op[key] = ref[:-len(suffix)]
                return
        raise OpError(f"{op['op']}: {ref!r} is a board (tab) id, not a node")

    def _op_connect(self, op: dict) -> None:
        bid = self._board_for(op)
        for key in ("from", "to"):
            self._node_ref(bid, op, key)
        self._add_edge(bid, op["from"], op["to"], op, op.get("label"), op.get("status"), op.get("note"))

    def _resolve_edge(self, bid: str, ref: str, opname: str) -> dict:
        b = self.boards[bid]
        if ref in b["edges"]:
            return b["edges"][ref]
        if "->" in ref:  # tolerate spacing / case differences
            a, _, z = ref.partition("->")
            key = edge_id(slug(a), slug(z))
            if key in b["edges"]:
                return b["edges"][key]
        raise OpError(f"{opname}: no edge {ref!r}")

    def _op_disconnect(self, op: dict) -> None:
        bid = self._board_for(op)
        edge = self._resolve_edge(bid, op["edge"], "disconnect")
        self._put_edge(bid, None, edge["id"])

    def _op_reroute(self, op: dict) -> None:
        bid = self._board_for(op)
        edge = self._resolve_edge(bid, op["edge"], "reroute")
        for key in ("via", "new_from", "new_to"):
            self._node_ref(bid, op, key)
        via, new_from, new_to = op.get("via"), op.get("new_from"), op.get("new_to")
        label = op.get("label") if op.get("label") is not None else edge.get("label")
        if via:
            if via in (edge["from"], edge["to"]):
                raise OpError("reroute: via must differ from the edge ends")
            self._put_edge(bid, None, edge["id"])
            self._add_edge(bid, edge["from"], via, op, label)
            if edge_id(via, edge["to"]) not in self.boards[bid]["edges"]:
                self._add_edge(bid, via, edge["to"], op)
        elif new_from or new_to:
            a, z = new_from or edge["from"], new_to or edge["to"]
            if (a, z) == (edge["from"], edge["to"]):
                if op.get("label") is None or op["label"] == edge.get("label"):
                    raise OpError("reroute: endpoints unchanged")
                relabeled = copy.deepcopy(edge)  # same ends, new meaning ("pulls" -> "pushes")
                relabeled["label"] = op["label"]
                self._stamp(relabeled, op)
                self._put_edge(bid, relabeled, edge["id"])
                return
            self._put_edge(bid, None, edge["id"])
            self._add_edge(bid, a, z, op, label, edge["status"] if edge["status"] != "disputed" else None)
        else:
            raise OpError("reroute: needs via or new_from/new_to")

    def _op_mark(self, op: dict, guard_version: int | None = None) -> None:
        bid = self._board_for(op)
        found = self.find_target(bid, op["target"])
        if found is None and "->" in op["target"]:
            try:
                found = ("edge", self._resolve_edge(bid, op["target"], "mark"))
            except OpError:
                found = None
        if found is None:
            raise OpError(f"mark: no node or edge {op['target']!r}")
        kind, item = found
        if guard_version is not None and item.get("v", 0) > guard_version:
            raise OpError(f"mark: {item['id']!r} changed since analysis started (stale)")
        if item["status"] == op["status"] and (op.get("note") in (None, item.get("note"))):
            raise OpError(f"mark: {item['id']!r} already {op['status']}")
        status = self._dispute_rule(item, op["status"])
        if status == item["status"] and op.get("note") in (None, item.get("note")):
            raise OpError(f"mark: {item['id']!r} already {status}")
        op["status"] = status
        new = copy.deepcopy(item)
        new["status"] = status
        if status == "disputed":
            new["was_disputed"] = True
        if op.get("note") is not None:
            new["note"] = op["note"]
        self._stamp(new, op)
        if kind == "node":
            self._put_node(bid, new, new["id"])
        else:
            self._put_edge(bid, new, new["id"])

    @staticmethod
    def _dispute_rule(item: dict, status: str) -> str:
        """Deterministic dispute lifecycle: disputed -> (still disputed) -> resolved.

        - an open dispute cannot silently fall back to "ghost"
        - a once-disputed element that gets confirmed shows as "resolved"
        - "resolved" only exists for elements that were actually disputed
        """
        was = item.get("was_disputed") or item["status"] == "disputed"
        if item["status"] == "disputed" and status == "ghost":
            return "disputed"
        if status == "confirmed" and was:
            return "resolved"
        if status == "resolved" and not was:
            return "confirmed"
        return status

    def _op_add_group(self, op: dict) -> None:
        bid = self._board_for(op)
        if op["id"] in self.boards[bid]["groups"]:
            raise OpError(f"add_group: group {op['id']!r} already exists")
        group = {"id": op["id"], "label": op["label"]}
        self._stamp(group, op)
        self._put_group(bid, group, op["id"])

    def _op_set_group(self, op: dict) -> None:
        bid = self._board_for(op)
        b = self.boards[bid]
        node = b["nodes"].get(op["node"])
        if node is None:
            raise OpError(f"set_group: no node {op['node']!r}")
        group = op.get("group")
        if group is not None and group not in b["groups"]:
            raise OpError(f"set_group: unknown group {group!r}")
        if node.get("group") == group:
            raise OpError("set_group: already in that group")
        new = copy.deepcopy(node)
        new["group"] = group
        self._stamp(new, op)
        self._put_node(bid, new, new["id"])

    def _op_new_board(self, op: dict) -> None:
        if op["id"] in self.boards:
            raise OpError(f"new_board: board {op['id']!r} already exists")
        board = self._empty_board(op["id"], op["title"], op.get("kind") or "process")
        board["by"], board["src"] = op.get("by"), op.get("src")
        self._put_board(op["id"], board)
        self._set_active(op["id"])

    def _op_switch_board(self, op: dict) -> None:
        if op["board"] not in self.boards:
            raise OpError(f"switch_board: no board {op['board']!r}")
        if op["board"] == self.active:
            raise OpError("switch_board: already active")
        self._set_active(op["board"])

    def _op_undo(self, op: dict) -> None:
        target = op["target_src"]
        txns = [t for t in self.transactions if t.src == target and not t.undone]
        if not txns:
            raise OpError(f"undo: nothing to undo for {target!r}")
        for t in reversed(txns):
            for inv in reversed(t.inverse):
                self._revert(inv)
            t.undone = True
        self._drop_dangling_edges()

    def _drop_dangling_edges(self) -> None:
        """Edges added later by other utterances may point at nodes the undo removed."""
        for bid, b in list(self.boards.items()):
            for eid, e in list(b["edges"].items()):
                if e["from"] not in b["nodes"] or e["to"] not in b["nodes"]:
                    self._put_edge(bid, None, eid)

    def undo_last(self) -> bool:
        """Revert the most recent transaction (manual undo button / tests)."""
        for t in reversed(self.transactions):
            if not t.undone:
                self.version += 1
                for inv in reversed(t.inverse):
                    self._revert(inv)
                t.undone = True
                self._drop_dangling_edges()
                return True
        return False
