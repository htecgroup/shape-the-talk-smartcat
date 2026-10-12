"""Approval modes: how freely the agents may edit the board.

- "auto" (Autopilot): every valid op an agent emits is applied right away.
- "ask" (Ask first): destructive ops are held as proposals until someone in the room approves or rejects them.
  Everything else still applies right away, so the board keeps up with the talk.

A proposal is one removal ("remove") or one consolidator merge ("merge": new node(s), the edges to them and the
removal of the nodes they replace). A merge is held whole, so the board never shows the replacement next to the
nodes it replaces; approving applies the whole batch, Keep drops it.

`ApprovalGate` is a mixin of `Session` (like `AgentPipeline`); it works on `board`, `approvals` and
`approval_mode` and reports through `Session.emit()`.
"""

from __future__ import annotations

import copy
import os

from .board import slug

APPROVAL_MODES = ("auto", "ask")
DEFAULT_APPROVAL_MODE = os.getenv("LW_APPROVAL_MODE", "auto")
if DEFAULT_APPROVAL_MODE not in APPROVAL_MODES:
    DEFAULT_APPROVAL_MODE = "auto"
DESTRUCTIVE = {"remove_node"}   # ops held for approval in "ask" mode; add disconnect, undo, ... here later
NODE_REFS = ("id", "from", "to", "via", "new_from", "new_to", "node")   # op fields that name a node


class ApprovalGate:
    async def set_approval_mode(self, mode: str) -> dict:
        if mode not in APPROVAL_MODES:
            return {"ok": False, "error": f"unknown approval mode {mode!r}"}
        self.approval_mode = mode
        await self._send_all({"type": "approval_mode", "mode": mode})
        if mode == "auto" and self.approvals:
            await self._decide(list(self.approvals), True, via="autopilot")   # Autopilot: nothing waits any more
        return {"ok": True}

    def _hold_destructive(self, ops: list, agent: str) -> tuple[list, list, list]:
        """Ask mode: take destructive ops out of `ops` and queue them as proposals. Returns (kept, held, refused).
        An op on an element that does not exist is kept, so the board rejects it with its usual reason.
        A removal (or merge) someone already said Keep to is refused when it comes back."""
        if self.approval_mode != "ask":
            return ops, [], []
        kept, removals, refused = [], [], []
        active = self.board.active     # the batch's own switch_board/new_board move it for the ops after them
        for op in ops:
            name = op.get("op") if isinstance(op, dict) else None
            if name == "new_board" and op.get("id") and slug(op["id"]) not in self.board.boards:
                active = slug(op["id"])
            elif name == "switch_board" and op.get("board") and slug(op["board"]) in self.board.boards:
                active = slug(op["board"])
            if name not in DESTRUCTIVE:
                kept.append(op)
                continue
            bid = slug(op["board"]) if op.get("board") else active
            nid = slug(op.get("id") or "")
            node = (self.board.boards.get(bid) or {}).get("nodes", {}).get(nid)
            if node is None:
                kept.append(op)
                continue
            removals.append((op, bid, nid))
        if not removals:
            return kept, [], refused
        if agent == "consolidator":
            merge = self._merge_of(kept, removals)
            if merge is not None:
                return merge
        held = []
        for op, bid, nid in removals:
            if (bid, nid, op["op"]) in self.kept_by_person:
                label = self.board.boards[bid]["nodes"][nid]["label"]
                refused.append({"op": op, "error": f"{op['op']}: “{label}” was kept by a person"})
                continue
            held.append(op)
            self._propose("remove", [{**op, "board": bid, "id": nid}], bid, [nid], agent, op.get("src"))
        return kept, held, refused

    def _merge_of(self, kept: list, removals: list) -> tuple[list, list, list] | None:
        """Consolidator batch that removes nodes and adds a replacement: hold the new node(s), every op that
        names them, and the removals as one merge proposal. Returns (kept, held, refused), or None when the
        batch adds no node. (The consolidator's ops are all pinned to one board.)"""
        bid = removals[0][1]
        nodes = self.board.boards[bid]["nodes"]
        new = {slug(op["id"]) for op in kept
               if isinstance(op, dict) and op.get("op") == "add_node" and op.get("id") and slug(op["id"]) not in nodes}
        if not new:
            return None
        part = [op for op in kept if isinstance(op, dict) and _refs(op) & new]
        rest = [op for op in kept if not any(op is q for q in part)]
        targets = [nid for _, _, nid in removals]
        held = part + [{**op, "board": bid, "id": nid} for op, _, nid in removals]
        # a node someone kept (alone or in this merge) is not merged away either: refuse the whole merge
        if (bid, tuple(sorted(targets)), "merge") in self.kept_by_person or any(
                (bid, t, "remove_node") in self.kept_by_person for t in targets):
            labels = " + ".join(f"“{nodes[t]['label']}”" for t in targets)
            return rest, [], [{"op": op, "error": f"merge of {labels} was kept by a person"} for op in held]
        self._propose("merge", held, bid, targets, "consolidator", removals[0][0].get("src"))
        return rest, held, []

    def _propose(self, kind: str, ops: list, bid: str, targets: list, agent: str, src: str | None) -> None:
        if any(p["kind"] == kind and p["board"] == bid and p["targets"] == targets for p in self.approvals):
            return   # already waiting for a decision (the agents often repeat themselves)
        nodes = self.board.boards[bid]["nodes"]
        self._approval_seq += 1
        edges = sum(bool({e["from"], e["to"]} & set(targets)) for e in self.board.boards[bid]["edges"].values())
        p = {"id": f"a{self._approval_seq}", "kind": kind, "ops": ops, "agent": agent,
             "by": self._speakers().get(src), "src": src, "board": bid, "targets": targets, "target": targets[0],
             "label": ", ".join(nodes[t]["label"] for t in targets), "type": nodes[targets[0]]["type"],
             "edges": edges, "t": self._elapsed()}
        if kind == "merge":
            p["labels"] = [nodes[t]["label"] for t in targets]
            p["into"] = [op.get("label") or op["id"] for op in ops if op.get("op") == "add_node"]
        self.approvals.append(p)

    async def decide_approval(self, aid: str, approve: bool) -> dict:
        """Apply (approve) or drop (reject) one proposal, or every one with aid "*"."""
        chosen = [p for p in self.approvals if aid in ("*", p["id"])]
        if not chosen:
            return {"ok": False, "error": f"no pending approval {aid!r}"}
        await self._decide(chosen, approve)
        return {"ok": True}

    async def _decide(self, chosen: list, approve: bool, via: str = "person") -> None:
        if self.status == "finished":
            self._close_idle_gap()      # a decision after the meeting ended: no idle gap in replay
        self.approvals = [p for p in self.approvals if p not in chosen]
        result, stale = {"applied": [], "rejected": []}, []
        if approve:
            for p in chosen:   # one at a time: an earlier one may change what a later one finds
                why = self._still_applies(p)
                if why:
                    stale.append(p)
                    result["rejected"].append({"op": p["ops"][-1], "error": f"no longer applies: {why}"})
                    continue
                res = self.board.apply_ops([dict(op) for op in p["ops"]], by_lookup=self._speakers())
                result["applied"] += res["applied"]
                result["rejected"] += res["rejected"]
            await self._emit_board(result, "approval")
        else:
            self.kept_by_person |= {_kept_key(p) for p in chosen}
        done = [p for p in chosen if p not in stale]
        names = ", ".join(_describe(p) for p in done) or "nothing (no longer applies)"
        if not approve:
            summary = "Kept " + ", ".join(f"“{p['label']}”" for p in chosen)
        else:
            summary = f"Autopilot: {names}" if via == "autopilot" else f"Approved: {names}"
        await self.emit({"type": "activity", "item": {
            "agent": "approval", "utts": sorted({p["src"] for p in chosen if p["src"]}),
            "summary": summary, "ops": result["applied"], "rejected": result["rejected"],
            "latency_ms": None, "t": self._elapsed()}})
        await self._emit_approvals()
        if self.status == "finished" and self.run_file and self.mode in ("live", "mic", "teams"):
            self._save_run(complete=True)   # keep the saved run in step with the board

    def _still_applies(self, p: dict) -> str | None:
        """Re-check a proposal before applying it: the board may have changed while it waited. Returns why not."""
        b = self.board.boards.get(p["board"])
        if b is None:
            return f"board {p['board']!r} is gone"
        gone = [t for t in p["targets"] if t not in b["nodes"]]
        if gone:
            return f"node {gone[0]!r} is gone"
        if p["agent"] == "consolidator":
            _, rejected = self._consolidator_guard([dict(op) for op in p["ops"]], p["board"])
            if rejected:
                return rejected[0]["error"]
        if p["kind"] == "merge":   # all or nothing: try it on a copy first
            trial = copy.deepcopy(self.board).apply_ops([dict(op) for op in p["ops"]], by_lookup=self._speakers())
            failed = [r for r in trial["rejected"] if r["op"].get("op") in ("add_node", "remove_node")]
            if failed:
                return failed[0]["error"]
        return None

    def _prune_approvals(self) -> bool:
        """Drop proposals whose element is already gone (undone, removed by another op, board removed)."""
        alive = [p for p in self.approvals
                 if all(t in (self.board.boards.get(p["board"]) or {}).get("nodes", {}) for t in p["targets"])]
        changed = len(alive) != len(self.approvals)
        self.approvals = alive
        return changed

    async def _emit_approvals(self) -> None:
        await self.emit({"type": "approvals", "pending": [dict(p) for p in self.approvals]})


def _refs(op: dict) -> set[str]:
    """Node ids an op names (edge ids "a->b" count as both ends)."""
    refs = {slug(op[k]) for k in NODE_REFS if op.get(k)} if op.get("op") not in ("new_board", "add_group") else set()
    for k in ("edge", "target"):
        if isinstance(op.get(k), str):
            refs |= {slug(x) for x in op[k].split("->")}
    return refs


def _kept_key(p: dict) -> tuple:
    """What a Keep sticks to: the node(s) and the op, not the utterance (its src can be a fallback)."""
    if p["kind"] == "merge":
        return p["board"], tuple(sorted(p["targets"])), "merge"
    return p["board"], p["target"], "remove_node"


def _describe(p: dict) -> str:
    if p["kind"] == "merge":
        return f'merge {" + ".join(f"“{x}”" for x in p["labels"])} into {", ".join(f"“{x}”" for x in p["into"])}'
    return f'remove “{p["label"]}”'
