"""Modeller output schema: flat ops (Anthropic structured outputs) mapped back to the per-op shape."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from whiteboard import agents  # noqa: E402


def test_modeller_flat_ops_become_per_op_shape():
    data = {"summary": "s", "ops": [
        {"op": "connect", "src": "u01", "from": "a", "to": "b", "label": "", "status": "",
         "id": "", "type": "", "note": "", "target": "", "kind": ""},
        {"op": "update_node", "src": "u02", "id": "a", "label": "", "type": "system", "note": "x"},
    ]}
    ops = agents._clean_ops(data)["ops"]
    assert ops[0] == {"op": "connect", "src": "u01", "from": "a", "to": "b", "label": None, "status": None}
    assert ops[1] == {"op": "update_node", "src": "u02", "id": "a", "label": None, "type": "system", "note": "x"}


def test_modeller_schema_fields_are_all_required():
    op = agents.MODELLER_SCHEMA["properties"]["ops"]["items"]
    assert set(op["required"]) == set(op["properties"])
    assert all("anyOf" not in p and not isinstance(p.get("type"), list) for p in op["properties"].values())
