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


MEETING = {"title": "T", "topic": "Order flow", "participants": [{"name": "Ana", "role": "PO"}]}
CTX = [{"id": "u01", "speaker": "Ana", "text": "We charge the bank."},
       {"id": "u02", "speaker": "Ana", "text": "No, via the gateway."}]
UTT = {"id": "u03", "speaker": "Ana", "text": "Right, the gateway."}


def test_jev_request_has_state_and_all_questions():
    state, questions = agents.build_jev_request(MEETING, CTX, UTT)
    assert state["new_utterance"] == "[u03] Ana: Right, the gateway."
    assert state["context"] == ["[u01] Ana: We charge the bank.", "[u02] Ana: No, via the gateway."]
    assert "speech_note" not in state
    assert set(questions) == {"kind", "refers_to", "topic_shift"}
    assert set(questions["kind"].criteria) == set(agents.KINDS)
    assert list(questions["refers_to"].criteria) == ["u01", "u02", "none"]
    state, questions = agents.build_jev_request({**MEETING, "source": "mic"}, [], UTT)
    assert "refers_to" not in questions and "speech_note" in state


def test_jev_answers_map_to_extraction_shape():
    assert agents.jev_to_extraction(UTT, "resolution", "u02", 0.1) == {
        "kind": "resolution", "claims": ["Right, the gateway."], "refers_to": "u02", "topic_shift": False}
    assert agents.jev_to_extraction(UTT, "correction", "none", 0.0)["refers_to"] is None
    assert agents.jev_to_extraction(UTT, "new_info", "u02", 0.7) == {
        "kind": "new_info", "claims": ["Right, the gateway."], "refers_to": None, "topic_shift": True}
    assert agents.jev_to_extraction(UTT, "chit_chat", None, 0.0)["claims"] == []
