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


def test_connect_to_board_id_uses_the_node_it_names():
    s = BoardState()
    r = s.apply_ops([
        {"op": "new_board", "id": "live_whiteboard_architecture", "title": "Arch", "kind": "architecture", "src": "u1"},
        {"op": "add_node", "id": "teams_bot", "label": "Teams bot", "type": "system", "src": "u1"},
        {"op": "add_node", "id": "live_whiteboard", "label": "Live whiteboard", "type": "system", "src": "u1"},
        {"op": "add_node", "id": "stt", "label": "STT", "type": "system", "src": "u1"},
        {"op": "connect", "from": "teams_bot", "to": "live_whiteboard_architecture", "src": "u2"},
        {"op": "reroute", "edge": "teams_bot->live_whiteboard", "via": "live_whiteboard_architecture", "src": "u2"},
        {"op": "reroute", "edge": "teams_bot->live_whiteboard", "new_from": "stt", "src": "u2"},
    ], by_lookup=BY)
    assert r["rejected"][0]["error"] == "reroute: via must differ from the edge ends"
    assert len(r["rejected"]) == 1 and r["applied"][4]["to"] == "live_whiteboard"
    assert set(edges(s)) == {"stt->live_whiteboard"}


def test_connect_to_board_id_without_matching_node_is_rejected_clearly():
    s = base()
    s.apply_ops([{"op": "new_board", "id": "system_map", "title": "Systems", "kind": "architecture", "src": "u1"},
                 {"op": "add_node", "id": "api", "label": "API", "type": "system", "src": "u1"},
                 {"op": "add_node", "id": "db", "label": "DB", "type": "data", "src": "u1"},
                 {"op": "connect", "from": "api", "to": "db", "src": "u1"}], by_lookup=BY)
    r = s.apply_ops([{"op": "connect", "from": "api", "to": "flow", "src": "u2"},
                     {"op": "reroute", "edge": "api->db", "new_to": "system_map", "src": "u2"},
                     {"op": "connect", "from": "api", "to": "nowhere", "src": "u2"}], by_lookup=BY)
    assert [x["error"] for x in r["rejected"]] == [
        "connect: 'flow' is a board (tab) id, not a node",
        "reroute: 'system_map' is a board (tab) id, not a node",
        "connect: no node 'nowhere'"]
    assert set(edges(s)) == {"api->db"}


def test_layout_plan_is_validated_and_stored_on_the_board():
    s = base()
    s.apply_ops([{"op": "add_node", "id": "db", "label": "Orders DB", "type": "data", "src": "u2"},
                 {"op": "add_group", "id": "pay", "label": "Payment", "src": "u2"}], by_lookup=BY)
    v = s.version
    raw = {"direction": "tb", "spine": ["checkout", "Bank", "nope", "checkout"],
           "placements": [{"node": "db", "side": "below", "anchor": "bank"},
                          {"node": "db", "side": "after", "anchor": "bank"},        # one placement per node
                          {"node": "bank", "side": "after", "anchor": "checkout"},  # on the spine: spine wins
                          {"node": "ghost", "side": "below", "anchor": "bank"},
                          {"node": "pay", "side": "sideways", "anchor": "bank"}],
           "groups": [{"group": "pay", "orientation": "column"}, {"group": "nope", "orientation": "row"},
                      {"group": "pay", "orientation": "diagonal"}]}
    plan = s.set_layout("flow", raw)
    assert plan == {"direction": "TB", "spine": ["checkout", "bank"],
                    "placements": [{"node": "db", "side": "below", "anchor": "bank"}],
                    "groups": [{"group": "pay", "orientation": "column"}], "v": v + 1}
    assert s.to_dict()["boards"][0]["layout"] == plan and "layout" not in s.compact()["boards"][0]
    assert s.set_layout("flow", raw) is None and s.version == v + 1          # same plan: no change, no event
    assert s.set_layout("nope", raw) is None and s.set_layout("flow", "spine") is None
    fallback = s.set_layout("flow", {"direction": "diagonal", "spine": ["bank"], "placements": [], "groups": []})
    assert fallback["direction"] == "LR" and fallback["spine"] == []         # a spine needs two entries


# ------------------------------------------------------------------ tasks
def task_board():
    s = BoardState()
    r = s.apply_ops([
        {"op": "new_board", "id": "plan", "title": "Launch plan", "kind": "process", "src": "u1"},
        {"op": "add_node", "id": "ivan", "label": "Ivan", "type": "actor", "src": "u1"},
        {"op": "add_task_list", "id": "launch", "label": "Launch checklist", "src": "u1"},
        {"op": "add_node", "id": "api_spec", "label": "Draft API spec", "type": "task",
         "group": "launch", "assignee": "ivan", "src": "u1"},
    ], by_lookup=BY)
    assert not r["rejected"], r["rejected"]
    return s


def test_task_links_to_an_existing_actor():
    s = task_board()
    assert nodes(s)["api_spec"]["assignee"] == "ivan"
    assert s.boards["plan"]["groups"]["launch"]["kind"] == "task_list"
    compact = s.compact()["boards"][0]
    assert {"id": "launch", "label": "Launch checklist", "kind": "task_list"} in compact["groups"]
    assert next(n for n in compact["nodes"] if n["id"] == "api_spec")["assignee"] == "ivan"


def test_task_assignee_that_is_not_an_actor_is_left_out():
    s = task_board()
    r = s.apply_ops([
        {"op": "add_node", "id": "venue", "label": "Book venue", "type": "task", "assignee": "marko", "src": "u2"},
        {"op": "add_node", "id": "deploy", "label": "Deploy", "type": "step", "assignee": "ivan", "src": "u2"},
    ], by_lookup=BY)
    assert not r["rejected"]
    assert "assignee" not in nodes(s)["venue"] and "assignee" not in nodes(s)["deploy"]


def test_assign_sets_and_clears_and_checks_the_actor():
    s = task_board()
    r = s.apply_ops([
        {"op": "add_node", "id": "marko", "label": "Marko", "type": "actor", "src": "u2"},
        {"op": "assign", "node": "api_spec", "assignee": "marko", "src": "u2"},
    ], by_lookup=BY)
    assert not r["rejected"] and nodes(s)["api_spec"]["assignee"] == "marko"
    r = s.apply_ops([
        {"op": "assign", "node": "api_spec", "assignee": "launch", "src": "u3"},   # a group, not an actor
        {"op": "assign", "node": "ivan", "assignee": "marko", "src": "u3"},        # not a task
    ], by_lookup=BY)
    assert len(r["rejected"]) == 2
    r = s.apply_ops([{"op": "assign", "node": "api_spec", "assignee": "", "src": "u4"}], by_lookup=BY)
    assert not r["rejected"] and "assignee" not in nodes(s)["api_spec"]


def test_task_list_holds_tasks_only():
    s = task_board()
    r = s.apply_ops([
        {"op": "add_node", "id": "crm", "label": "CRM", "type": "system", "group": "launch", "src": "u2"},
        {"op": "set_group", "node": "ivan", "group": "launch", "src": "u2"},
        {"op": "update_node", "id": "api_spec", "type": "step", "src": "u2"},
    ], by_lookup=BY)
    assert [x["op"]["op"] for x in r["rejected"]] == ["add_node", "set_group", "update_node"]


def test_removing_the_actor_unassigns_its_tasks_and_undo_restores():
    s = task_board()
    r = s.apply_ops([{"op": "remove_node", "id": "ivan", "src": "u2"}], by_lookup=BY)
    assert not r["rejected"] and "assignee" not in nodes(s)["api_spec"]
    s.undo_last()
    assert nodes(s)["api_spec"]["assignee"] == "ivan"
    r = s.apply_ops([{"op": "update_node", "id": "ivan", "type": "system", "src": "u3"}], by_lookup=BY)
    assert not r["rejected"] and "assignee" not in nodes(s)["api_spec"]


def test_assigned_task_moves_into_the_persons_list_and_back():
    s = task_board()
    g = s.boards["plan"]["groups"]
    # api_spec was added to the shared launch list with assignee ivan: it went to Ivan's own list instead
    assert nodes(s)["api_spec"]["group"] == "ivan_tasks"
    assert g["ivan_tasks"] == {**g["ivan_tasks"], "label": "Ivan's tasks", "kind": "task_list", "owner": "ivan"}
    r = s.apply_ops([
        {"op": "add_node", "id": "venue", "label": "Book venue", "type": "task", "group": "launch", "src": "u2"},
        {"op": "add_node", "id": "ana", "label": "Ana", "type": "actor", "src": "u2"},
        {"op": "assign", "node": "venue", "assignee": "ana", "src": "u2"},
    ], by_lookup=BY)
    assert not r["rejected"], r["rejected"]
    assert nodes(s)["venue"]["group"] == "ana_tasks" and g["ana_tasks"]["owner"] == "ana"
    # re-assigning moves it to the other person's list; un-assigning puts it back into the shared list
    s.apply_ops([{"op": "assign", "node": "venue", "assignee": "ivan", "src": "u3"}], by_lookup=BY)
    assert nodes(s)["venue"]["group"] == "ivan_tasks"
    s.apply_ops([{"op": "assign", "node": "venue", "assignee": "", "src": "u4"}], by_lookup=BY)
    assert nodes(s)["venue"]["group"] == "launch" and "assignee" not in nodes(s)["venue"]
    s.undo_last()
    assert nodes(s)["venue"]["group"] == "ivan_tasks" and nodes(s)["venue"]["assignee"] == "ivan"


def test_a_persons_task_list_owns_its_tasks():
    s = task_board()
    r = s.apply_ops([
        {"op": "add_node", "id": "ana", "label": "Ana", "type": "actor", "src": "u2"},
        {"op": "add_task_list", "id": "ana_list", "label": "Ana's list", "owner": "ana", "src": "u2"},
        {"op": "add_node", "id": "venue", "label": "Book venue", "type": "task", "group": "ana_list", "src": "u2"},
        {"op": "set_group", "node": "api_spec", "group": "ana_list", "src": "u2"},
        {"op": "add_node", "id": "flyer", "label": "Print flyers", "type": "task", "assignee": "ana", "src": "u2"},
    ], by_lookup=BY)
    assert not r["rejected"], r["rejected"]
    assert nodes(s)["venue"]["assignee"] == "ana" and nodes(s)["api_spec"]["assignee"] == "ana"
    assert nodes(s)["flyer"]["group"] == "ana_list"          # her existing list, no second one
    r = s.apply_ops([{"op": "set_group", "node": "venue", "group": "launch", "src": "u3"}], by_lookup=BY)
    assert not r["rejected"] and "assignee" not in nodes(s)["venue"]   # back on the shared list: unassigned


def test_assigning_an_existing_list_to_a_person_assigns_its_tasks():
    s = task_board()
    r = s.apply_ops([
        {"op": "add_node", "id": "venue", "label": "Book venue", "type": "task", "group": "launch", "src": "u2"},
        {"op": "add_node", "id": "ana", "label": "Ana", "type": "actor", "src": "u2"},
        {"op": "assign", "node": "launch", "assignee": "ana", "src": "u2"},
    ], by_lookup=BY)
    assert not r["rejected"], r["rejected"]
    assert s.boards["plan"]["groups"]["launch"]["owner"] == "ana" and nodes(s)["venue"]["assignee"] == "ana"
    s.apply_ops([{"op": "remove_node", "id": "ana", "src": "u3"}], by_lookup=BY)
    assert "owner" not in s.boards["plan"]["groups"]["launch"] and "assignee" not in nodes(s)["venue"]
    s.undo_last()
    assert s.boards["plan"]["groups"]["launch"]["owner"] == "ana" and nodes(s)["venue"]["assignee"] == "ana"


def test_unknown_list_owner_is_left_out():
    s = task_board()
    r = s.apply_ops([{"op": "add_task_list", "id": "misc", "label": "Misc", "owner": "nobody", "src": "u2"}], by_lookup=BY)
    assert not r["rejected"] and "owner" not in s.boards["plan"]["groups"]["misc"]


def test_completed_task_stays_on_the_board_checked():
    s = task_board()
    r = s.apply_ops([{"op": "complete_task", "node": "api_spec", "src": "u2"}], by_lookup=BY)
    assert not r["rejected"]
    assert nodes(s)["api_spec"]["done"] is True and nodes(s)["api_spec"]["group"] == "ivan_tasks"
    assert next(n for n in s.compact()["boards"][0]["nodes"] if n["id"] == "api_spec")["done"] is True
    r = s.apply_ops([
        {"op": "complete_task", "node": "api_spec", "src": "u3"},   # already done
        {"op": "complete_task", "node": "ivan", "src": "u3"},       # not a task
    ], by_lookup=BY)
    assert len(r["rejected"]) == 2
    r = s.apply_ops([{"op": "reopen_task", "node": "api_spec", "src": "u4"}], by_lookup=BY)
    assert not r["rejected"] and "done" not in nodes(s)["api_spec"]
