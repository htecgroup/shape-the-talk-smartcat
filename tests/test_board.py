import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from whiteboard.board import BoardState  # noqa: E402

BY = {"u1": "Ana", "u2": "Marko", "u3": "Ana", "u4": "Ivan", "u5": "Ana"}


def nodes(state, board=None):
    return state.boards[board or state.active]["nodes"]


def edges(state, board=None):
    return state.boards[board or state.active]["edges"]


def base():
    s = BoardState()
    r = s.apply_ops([
        {"op": "new_board", "id": "flow", "title": "Order flow", "kind": "process", "src": "u1"},
        {"op": "add_node", "id": "checkout", "label": "Checkout", "type": "step", "src": "u1"},
        {"op": "add_node", "id": "bank", "label": "Bank", "type": "system", "src": "u1"},
        {"op": "connect", "from": "checkout", "to": "bank", "label": "pays", "src": "u1"},
    ], by_lookup=BY)
    assert not r["rejected"], r["rejected"]
    return s


def test_add_and_connect_stamps_speaker_and_source():
    s = base()
    assert set(nodes(s)) == {"checkout", "bank"}
    e = edges(s)["checkout->bank"]
    assert e["label"] == "pays" and e["by"] == "Ana" and e["src"] == "u1"
    assert nodes(s)["bank"]["status"] == "confirmed"
    assert s.version == 1


def test_reroute_via_inserts_node_into_edge():
    s = base()
    r = s.apply_ops([
        {"op": "add_node", "id": "gw", "label": "Payment gateway", "type": "system", "src": "u2"},
        {"op": "reroute", "edge": "checkout->bank", "via": "gw", "src": "u2"},
    ], by_lookup=BY)
    assert not r["rejected"]
    assert set(edges(s)) == {"checkout->gw", "gw->bank"}
    assert edges(s)["checkout->gw"]["label"] == "pays"
    assert edges(s)["gw->bank"]["by"] == "Marko"


def test_reroute_reverse_direction():
    s = base()
    r = s.apply_ops([{"op": "reroute", "edge": "checkout -> bank", "new_from": "bank",
                      "new_to": "checkout", "src": "u2"}], by_lookup=BY)
    assert not r["rejected"], r
    assert set(edges(s)) == {"bank->checkout"}


def test_undo_reverts_only_that_utterance():
    s = base()
    s.apply_ops([{"op": "add_node", "id": "sms", "label": "SMS", "type": "system", "src": "u3"},
                 {"op": "connect", "from": "bank", "to": "sms", "src": "u3"}], by_lookup=BY)
    s.apply_ops([{"op": "add_node", "id": "push", "label": "Push", "type": "system", "src": "u4"}], by_lookup=BY)
    r = s.apply_ops([{"op": "undo", "target_src": "u3", "src": "u5"}], by_lookup=BY)
    assert not r["rejected"]
    assert "sms" not in nodes(s) and "bank->sms" not in edges(s)
    assert "push" in nodes(s) and "checkout->bank" in edges(s)
    # undoing again is rejected, not crashed
    r = s.apply_ops([{"op": "undo", "target_src": "u3", "src": "u5"}], by_lookup=BY)
    assert r["applied"] == [] and "nothing to undo" in r["rejected"][0]["error"]


def test_undo_restores_removed_node_with_edges():
    s = base()
    s.apply_ops([{"op": "remove_node", "id": "bank", "src": "u2"}], by_lookup=BY)
    assert "bank" not in nodes(s) and not edges(s)
    s.apply_ops([{"op": "undo", "target_src": "u2", "src": "u3"}], by_lookup=BY)
    assert "bank" in nodes(s) and "checkout->bank" in edges(s)


def test_undo_last_and_update_node():
    s = base()
    s.apply_ops([{"op": "update_node", "id": "bank", "label": "Card issuer", "src": "u2"}], by_lookup=BY)
    assert nodes(s)["bank"]["label"] == "Card issuer"
    assert s.undo_last()
    assert nodes(s)["bank"]["label"] == "Bank"


def test_mark_disputed_then_resolved():
    s = base()
    s.apply_ops([{"op": "mark", "target": "bank", "status": "disputed", "note": "Marko: use gateway", "src": "u2"}], by_lookup=BY)
    assert nodes(s)["bank"]["status"] == "disputed"
    s.apply_ops([{"op": "mark", "target": "bank", "status": "resolved", "note": "Agreed", "src": "u4"}], by_lookup=BY)
    n = nodes(s)["bank"]
    assert n["status"] == "resolved" and n["note"] == "Agreed" and n["by"] == "Ivan"


def test_mark_guard_rejects_stale_analyst_marks():
    s = base()
    s.apply_ops([{"op": "mark", "target": "bank", "status": "disputed", "src": "u2"}], by_lookup=BY)
    v0 = s.version
    s.apply_ops([{"op": "mark", "target": "bank", "status": "resolved", "src": "u4"}], by_lookup=BY)
    r = s.apply_ops([{"op": "mark", "target": "bank", "status": "disputed", "src": "u2"}],
                    by_lookup=BY, guard_version=v0)
    assert r["rejected"] and "stale" in r["rejected"][0]["error"]
    assert nodes(s)["bank"]["status"] == "resolved"


def test_invalid_ops_are_rejected_and_others_still_applied():
    s = base()
    v = s.version
    r = s.apply_ops([
        {"op": "fly_to_moon", "src": "u2"},
        {"op": "add_node", "id": "x", "label": "X", "type": "spaceship", "src": "u2"},
        {"op": "add_node", "id": "checkout", "label": "Dup", "type": "step", "src": "u2"},
        {"op": "connect", "from": "checkout", "to": "ghost", "src": "u2"},
        {"op": "connect", "from": "checkout", "to": "bank", "label": "pays", "src": "u2"},
        {"op": "add_node", "label": "No id", "type": "step", "src": "u2"},
        {"op": "remove_node", "id": "nope", "src": "u2"},
        {"op": "add_node", "id": "y", "label": "Y", "type": "step", "src": "u99"},
        "not even a dict",
        {"op": "add_node", "id": "ok", "label": "Fine", "type": "data", "src": "u2"},
    ], by_lookup=BY)
    assert len(r["rejected"]) == 9
    assert [o["id"] for o in r["applied"]] == ["ok"]
    assert "ok" in nodes(s) and s.version == v + 1


def test_failed_reroute_rolls_back_partial_changes():
    s = base()
    r = s.apply_ops([{"op": "reroute", "edge": "checkout->bank", "via": "missing", "src": "u2"}], by_lookup=BY)
    assert r["rejected"] and not r["applied"]
    assert set(edges(s)) == {"checkout->bank"}


def test_new_board_and_switch():
    s = base()
    s.apply_ops([{"op": "new_board", "id": "systems", "title": "System map", "kind": "architecture", "src": "u2"},
                 {"op": "add_node", "id": "api", "label": "API", "type": "system", "src": "u2"}], by_lookup=BY)
    assert s.active == "systems" and "api" in nodes(s, "systems") and "api" not in nodes(s, "flow")
    s.apply_ops([{"op": "switch_board", "board": "flow", "src": "u3"}], by_lookup=BY)
    assert s.active == "flow"
    s.apply_ops([{"op": "undo", "target_src": "u2", "src": "u4"}], by_lookup=BY)
    assert "systems" not in s.boards and s.board_order == ["flow"]


def test_groups():
    s = base()
    r = s.apply_ops([{"op": "add_group", "id": "pay", "label": "Payments", "src": "u2"},
                     {"op": "set_group", "node": "bank", "group": "pay", "src": "u2"},
                     {"op": "set_group", "node": "bank", "group": "nope", "src": "u2"}], by_lookup=BY)
    assert len(r["rejected"]) == 1
    assert nodes(s)["bank"]["group"] == "pay"


def test_compact_view_is_small_and_has_ids():
    s = base()
    c = s.compact()
    assert c["active_board"] == "flow"
    assert {n["id"] for n in c["boards"][0]["nodes"]} == {"checkout", "bank"}
    assert c["boards"][0]["edges"][0]["id"] == "checkout->bank"


def test_undo_drops_edges_that_later_utterances_attached():
    s = base()
    s.apply_ops([{"op": "add_node", "id": "rest", "label": "Restaurant", "type": "actor", "src": "u2"}], by_lookup=BY)
    s.apply_ops([{"op": "connect", "from": "rest", "to": "checkout", "src": "u3"}], by_lookup=BY)
    s.apply_ops([{"op": "undo", "target_src": "u2", "src": "u4"}], by_lookup=BY)
    assert "rest" not in nodes(s)
    assert all(e["from"] in nodes(s) and e["to"] in nodes(s) for e in edges(s).values())


def test_disputed_then_confirmed_becomes_resolved():
    s = base()
    s.apply_ops([{"op": "mark", "target": "bank", "status": "disputed", "src": "u2"}], by_lookup=BY)
    r = s.apply_ops([{"op": "mark", "target": "bank", "status": "confirmed", "src": "u4"}], by_lookup=BY)
    assert r["applied"][0]["status"] == "resolved"
    assert nodes(s)["bank"]["status"] == "resolved"


def test_dispute_lifecycle_rules():
    s = base()
    # resolved without a prior dispute is just confirmed (rejected as no-op here)
    r = s.apply_ops([{"op": "mark", "target": "bank", "status": "resolved", "src": "u2"}], by_lookup=BY)
    assert r["rejected"] and nodes(s)["bank"]["status"] == "confirmed"
    s.apply_ops([{"op": "mark", "target": "bank", "status": "disputed", "note": "A vs B", "src": "u2"}], by_lookup=BY)
    # an open dispute does not silently become a ghost
    s.apply_ops([{"op": "mark", "target": "bank", "status": "ghost", "note": "new idea", "src": "u3"}], by_lookup=BY)
    assert nodes(s)["bank"]["status"] == "disputed" and nodes(s)["bank"]["note"] == "new idea"
    s.apply_ops([{"op": "mark", "target": "bank", "status": "confirmed", "note": "Agreed", "src": "u4"}], by_lookup=BY)
    assert nodes(s)["bank"]["status"] == "resolved"


def test_reroute_reverse_with_new_label():
    s = base()
    s.apply_ops([{"op": "reroute", "edge": "checkout->bank", "new_from": "bank", "new_to": "checkout",
                  "label": "pushes", "src": "u2"}], by_lookup=BY)
    assert edges(s)["bank->checkout"]["label"] == "pushes"


def test_reroute_same_ends_changes_label_only():
    s = base()
    r = s.apply_ops([{"op": "reroute", "edge": "checkout->bank", "new_from": "checkout", "new_to": "bank",
                      "label": "pushes", "src": "u2"}], by_lookup=BY)
    assert not r["rejected"] and edges(s)["checkout->bank"]["label"] == "pushes"


def test_resolved_stays_resolved_when_confirmed_again():
    s = base()
    s.apply_ops([{"op": "mark", "target": "bank", "status": "disputed", "src": "u2"}], by_lookup=BY)
    s.apply_ops([{"op": "mark", "target": "bank", "status": "resolved", "note": "Agreed", "src": "u3"}], by_lookup=BY)
    s.apply_ops([{"op": "mark", "target": "bank", "status": "confirmed", "note": "Agreed again", "src": "u4"}], by_lookup=BY)
    assert nodes(s)["bank"]["status"] == "resolved"
