"""Exports of the current session: versioned board JSON (for other tools) and Mermaid flowcharts.

Pure functions over the board dicts of `BoardState.to_dict()`, so they are easy to test. Node coordinates
live only in the browser, so neither export carries positions; the PNG/SVG image is made client-side.
"""

from __future__ import annotations

import re
import time

FORMAT = "shape-the-talk/board"
VERSION = 1

_INTERNAL = ("created_v", "v")     # bookkeeping fields of the op log, meaningless outside the app
_DASHED = ("ghost", "disputed")    # statuses drawn as dashed edges in Mermaid
_SHAPES = {                        # node type -> Mermaid shape brackets
    "step": ("[", "]"),
    "decision": ("{", "}"),
    "data": ("[(", ")]"),
    "actor": ("([", "])"),
    "system": ("[[", "]]"),
}


def _clean(item: dict) -> dict:
    return {k: v for k, v in item.items() if k not in _INTERNAL}


def _export_board(b: dict) -> dict:
    return {"id": b["id"], "title": b["title"], "kind": b["kind"],
            "groups": [_clean(g) for g in b.get("groups", {}).values()],
            "nodes": [_clean(n) for n in b["nodes"].values()],
            "edges": [_clean(e) for e in b["edges"].values()]}


def board_json(meeting: dict, state: dict) -> dict:
    """The integration export: all boards as node/edge/group lists (no transcript)."""
    return {
        "format": FORMAT, "version": VERSION,
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "meeting": {"title": meeting.get("title"), "topic": meeting.get("topic"),
                    "participants": [{"name": p["name"], "role": p.get("role")}
                                     for p in meeting.get("participants", [])]},
        "active": state.get("active"),
        "boards": [_export_board(b) for b in state.get("boards", [])],
    }


# ------------------------------------------------------------------ Mermaid
def _mid(raw: str, prefix: str = "n_") -> str:
    """A Mermaid-safe id (letters, digits, underscore; never a bare keyword like `end`)."""
    return prefix + re.sub(r"\W", "_", raw)


def _text(s: str | None) -> str:
    """A label inside double quotes; Mermaid has no escaping for `"`, so use its entity code."""
    return (s or "").replace('"', "#quot;").replace("\n", " ")


def board_mermaid(board: dict) -> str:
    direction = ((board.get("layout") or {}).get("direction") or "LR").upper()
    lines = [f"flowchart {direction if direction in ('LR', 'RL', 'TB', 'BT') else 'LR'}"]

    def node_line(n: dict, indent: str) -> str:
        left, right = _SHAPES.get(n["type"], ("[", "]"))
        return f'{indent}{_mid(n["id"])}{left}"{_text(n["label"])}"{right}'

    nodes = list(board["nodes"].values())
    for g in board.get("groups", {}).values():
        members = [n for n in nodes if n.get("group") == g["id"]]
        if not members:
            continue
        lines.append(f'  subgraph {_mid(g["id"], "sg_")}["{_text(g["label"])}"]')
        lines += [node_line(n, "    ") for n in members]
        lines.append("  end")
    lines += [node_line(n, "  ") for n in nodes if not n.get("group") or n["group"] not in board.get("groups", {})]

    for e in board["edges"].values():
        arrow = "-.->" if e["status"] in _DASHED else "-->"
        label = f'|"{_text(e["label"])}"|' if e.get("label") else ""
        lines.append(f'  {_mid(e["from"])} {arrow}{label} {_mid(e["to"])}')

    for n in nodes:
        if n["status"] in _DASHED:
            lines.append(f'  class {_mid(n["id"])} {n["status"]}')
    if any(n["status"] in _DASHED for n in nodes):
        lines.append("  classDef ghost stroke-dasharray: 5 5,opacity:0.7")
        lines.append("  classDef disputed stroke:#e03131,stroke-width:2px")
    return "\n".join(lines) + "\n"


def all_mermaid(meeting: dict, state: dict) -> str:
    """One fenced Mermaid block per board, under its title (pastes into GitHub, Notion, Confluence)."""
    out = [f"# {meeting.get('title') or 'Whiteboard'}\n"]
    for b in state.get("boards", []):
        out.append(f"## {b['title']}\n\n```mermaid\n{board_mermaid(b)}```\n")
    return "\n".join(out)


def slug(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "whiteboard").lower()).strip("-") or "whiteboard"
