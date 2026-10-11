"""Structured-output JSON schemas of the agents, and the mapping of flat modeller ops back to the per-op shape."""

from __future__ import annotations


def _obj(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props,
            "required": required if required is not None else list(props), "additionalProperties": False}


S = {"type": "string"}
NS = {"type": ["string", "null"]}

KINDS = ["new_info", "correction", "disagreement", "resolution", "question", "undo", "chit_chat"]


# ======================================================================= Extractor
EXTRACTOR_SCHEMA = _obj({
    "kind": {"type": "string", "enum": KINDS},
    "claims": {"type": "array", "items": S},
    "refers_to": NS,
    "topic_shift": {"type": "boolean"},
})


# ===================================================== Modeller (and consolidator)
NODE_TYPE = {"type": "string", "enum": ["actor", "system", "step", "decision", "data", "task"]}
NEW_STATUS = {"type": "string", "enum": ["confirmed", "ghost"]}
MARK_STATUS = {"type": "string", "enum": ["confirmed", "ghost", "disputed", "resolved"]}

# Per-op fields. The Anthropic grammar compiler rejects a 12-way anyOf of op objects (and also
# many nullable or optional fields) as too complex, so the schema is one flat op object with every
# field required and "" meaning "not used for this op". clean_ops turns that back into the per-op
# shape (only that op's fields, "" -> null); Board.normalize still rejects ops missing a required field.
OP_SCHEMAS = {
    "add_node": {"id": S, "label": S, "type": NODE_TYPE, "status": NEW_STATUS, "group": NS, "note": NS, "assignee": NS},
    "update_node": {"id": S, "label": NS, "type": NODE_TYPE, "note": NS},
    "remove_node": {"id": S},
    "connect": {"from": S, "to": S, "label": NS, "status": NEW_STATUS},
    "disconnect": {"edge": S},
    "reroute": {"edge": S, "via": NS, "new_from": NS, "new_to": NS, "label": NS},
    "mark": {"target": S, "status": MARK_STATUS, "note": NS},
    "add_group": {"id": S, "label": S},
    "add_task_list": {"id": S, "label": S, "owner": NS},
    "set_group": {"node": S, "group": NS},
    "assign": {"node": S, "assignee": NS},
    "complete_task": {"node": S},
    "reopen_task": {"node": S},
    "new_board": {"id": S, "title": S, "kind": {"type": "string", "enum": ["process", "architecture", "stakeholder", "mindmap"]}},
    "switch_board": {"board": S},
    "undo": {"target_src": S},
}


def _or_empty(prop: dict) -> dict:
    return {"type": "string", "enum": [*prop["enum"], ""]} if "enum" in prop else {"type": "string"}


def _signature(name: str, props: dict) -> str:
    def one(k: str, v: dict) -> str:
        optional = v is NS or (name == "update_node" and k != "id")  # update_node changes only what is given
        values = "|".join(v["enum"]) + ("|\"\"" if optional else "") if "enum" in v else ("or \"\"" if optional else "")
        return f"{k} ({values})" if values else k
    return f"{name}: " + ", ".join(one(k, v) for k, v in props.items())


def _flat_op_fields() -> dict[str, dict]:
    """Every field of every op, as a string ("" = not used), described with the ops that use it."""
    fields: dict[str, dict] = {}
    for props in OP_SCHEMAS.values():
        for k, v in props.items():
            fields[k] = _or_empty(MARK_STATUS if k == "status" else v)
    for k, v in fields.items():
        v["description"] = "used by " + ", ".join(n for n, p in OP_SCHEMAS.items() if k in p) + "; else \"\""
    return fields


# The descriptions carry what the per-op schemas used to say: which fields each op uses.
OP_HELP = ("Fill only the fields this op uses; every other field is \"\". "
           + "; ".join(_signature(n, p) for n, p in OP_SCHEMAS.items()))
FLAT_OP = {**_obj({"op": {"type": "string", "enum": list(OP_SCHEMAS)}, "src": S, **_flat_op_fields()}),
           "description": OP_HELP}

MODELLER_SCHEMA = _obj({
    "summary": S,
    "ops": {"type": "array", "items": FLAT_OP},
})


# ==================================================== Consolidator (layout plan)
# The plan is semantic, never coordinates: the browser's deterministic layout follows it as constraints.
# Flat and without nullable fields for the same grammar-compiler reason as FLAT_OP; empty lists = no hint.
LAYOUT_SIDES = ["before", "after", "above", "below"]
LAYOUT_SCHEMA = _obj({
    "direction": {"type": "string", "enum": ["LR", "TB"]},
    "spine": {"type": "array", "items": S,
              "description": "node/group ids of the main story line, in reading order"},
    "placements": {"type": "array", "items": _obj({
        "node": S, "side": {"type": "string", "enum": LAYOUT_SIDES}, "anchor": S})},
    "groups": {"type": "array", "items": _obj({
        "group": S, "orientation": {"type": "string", "enum": ["row", "column"]}})},
})
CONSOLIDATOR_SCHEMA = _obj({
    "summary": S,
    "ops": {"type": "array", "items": FLAT_OP},
    "layout": LAYOUT_SCHEMA,
})


def clean_ops(data: dict | None) -> dict | None:
    """Give each op only its own fields, with "" (not used) as null: the shape Board expects."""
    if not data or not isinstance(data.get("ops"), list):
        return data
    ops = []
    for op in data["ops"]:
        fields = OP_SCHEMAS.get(op.get("op"))
        if fields is None:
            ops.append(op)
            continue
        ops.append({"op": op["op"], "src": op.get("src"),
                    **{k: (op.get(k) if op.get(k) != "" else None) for k in fields}})
    return {**data, "ops": ops}


# ===================================================================== Spec writer
SPEC_SCHEMA = _obj({"title": S, "markdown": S})


# ========================================================================= Analyst
ANALYST_SCHEMA = _obj({
    "open_questions": {"type": "array", "items": _obj({
        "question": S, "asked_by": S, "src": S,
        "status": {"type": "string", "enum": ["open", "answered", "parked"]},
        "answer": NS,
    })},
    "disagreements": {"type": "array", "items": _obj({
        "topic": S,
        "positions": {"type": "array", "items": _obj({"who": S, "position": S})},
        "status": {"type": "string", "enum": ["open", "resolved"]},
        "resolution": NS, "src": S,
    })},
    "suggested_marks": {"type": "array", "items": _obj({
        "board": S, "target": S, "status": {"type": "string", "enum": ["resolved"]},
        "note": S, "src": S,
    })},
})
