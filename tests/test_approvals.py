"""Approval modes: Autopilot applies everything, Ask first holds node removals for a person (agents faked)."""

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import handle_command  # noqa: E402
from whiteboard.session import Session  # noqa: E402

SPOKEN = [{"id": "u01", "speaker": "Ana", "text": "x"}, {"id": "u02", "speaker": "Ben", "text": "y"}]


def make_session(mode: str) -> Session:
    s = Session()
    s.approval_mode = mode
    s.mode = "live"
    s.spoken = list(SPOKEN)
    s.board.apply_ops([{"op": "new_board", "id": "b", "title": "B", "src": "u01"},
                       {"op": "add_node", "id": "bank", "label": "Bank", "type": "system", "src": "u01"},
                       {"op": "add_node", "id": "checkout", "label": "Checkout", "type": "step", "src": "u01"},
                       {"op": "connect", "from": "checkout", "to": "bank", "src": "u01"}],
                      by_lookup={"u01": "Ana"})
    return s


def model(s: Session, ops: list[dict]):
    """Run the modeller path with a canned reply."""
    from whiteboard import agents
    async def fake(*a):
        return agents.CallResult({"summary": "s", "ops": ops}, 1)
    orig, agents.model = agents.model, fake
    try:
        item = {"utt": SPOKEN[1], "extraction": {"kind": "correction", "claims": []}}
        asyncio.run(s._run_modeller([item]))
    finally:
        agents.model = orig


REMOVE = [{"op": "add_node", "id": "gateway", "label": "Gateway", "type": "system", "src": "u02"},
          {"op": "remove_node", "id": "bank", "src": "u02"}]


def test_autopilot_applies_removals_right_away():
    s = make_session("auto")
    model(s, REMOVE)
    assert "bank" not in s.board.boards["b"]["nodes"] and s.approvals == []


def test_ask_first_holds_removal_but_applies_the_rest():
    s = make_session("ask")
    model(s, REMOVE + [{"op": "remove_node", "id": "nope", "src": "u02"}])
    nodes = s.board.boards["b"]["nodes"]
    assert "gateway" in nodes and "bank" in nodes
    [p] = s.approvals
    assert (p["target"], p["board"], p["label"], p["by"], p["agent"], p["edges"]) == ("bank", "b", "Bank", "Ben", "modeller", 1)
    act = [e["item"] for e in s.timeline if e["type"] == "activity"][-1]
    assert [o["op"] for o in act["held"]] == ["remove_node"]
    assert act["rejected"][0]["error"] == "remove_node: no node 'nope'"   # unknown nodes are not held
    assert s.snapshot()["approvals"][0]["target"] == "bank"

    model(s, [{"op": "remove_node", "id": "bank", "src": "u02"}])        # repeated proposal: no duplicate
    assert len(s.approvals) == 1


def test_approve_and_reject():
    s = make_session("ask")
    model(s, REMOVE)
    pid = s.approvals[0]["id"]
    assert asyncio.run(s.decide_approval(pid, False))["ok"]
    assert "bank" in s.board.boards["b"]["nodes"] and s.approvals == [] and s.view_approvals == []

    model(s, REMOVE[1:])                     # same removal, same reason (u02): a Keep sticks
    act = [e["item"] for e in s.timeline if e["type"] == "activity"][-1]
    assert s.approvals == [] and act["rejected"][0]["error"] == "remove_node: “Bank” was kept by a person"
    s.kept_by_person.clear()

    model(s, REMOVE[1:])
    assert asyncio.run(s.decide_approval("*", True))["ok"]
    b = s.board.boards["b"]
    assert "bank" not in b["nodes"] and "checkout->bank" not in b["edges"]
    act = [e["item"] for e in s.timeline if e["type"] == "activity"][-1]
    assert act["agent"] == "approval" and act["ops"][0]["by"] == "Ben"
    assert not asyncio.run(s.decide_approval("a99", True))["ok"]


def test_proposal_dropped_when_node_disappears():
    s = make_session("ask")
    model(s, REMOVE)
    # "scratch that" for u01 takes the bank node away before anyone decided
    s.board.apply_ops([{"op": "undo", "target_src": "u01", "src": "u02"}], by_lookup={"u02": "Ben"})
    asyncio.run(s._emit_board({"applied": [{}]}, "modeller"))
    assert s.approvals == []


def test_mode_command_survives_reset():
    async def run():
        import server
        server.session = Session()
        assert (await handle_command({"cmd": "approval_mode", "mode": "ask"}))["ok"]
        assert not (await handle_command({"cmd": "approval_mode", "mode": "yolo"}))["ok"]
        await handle_command({"cmd": "reset"})
        return server.session
    s = asyncio.run(run())
    assert s.approval_mode == "ask" and s.snapshot()["approval_mode"] == "ask"


def test_consolidator_id_rename_is_dropped_whole():
    """Seen live: the consolidator re-created "Visit Ljubljana" (id visit_bled) as visit_ljubljana. In ask mode the
    copy appeared at once while the original's removal waited, so the board showed the node twice."""
    s = make_session("ask")
    s.board.apply_ops([{"op": "update_node", "id": "bank", "label": "Visit Ljubljana", "src": "u02"}],
                      by_lookup={"u02": "Ben"})
    kept, rejected = s._consolidator_guard([
        {"op": "add_node", "id": "Visit_Ljubljana", "label": "visit  ljubljana", "type": "step", "src": "u02"},
        {"op": "connect", "from": "checkout", "to": "visit_ljubljana", "src": "u02"},
        {"op": "remove_node", "id": "bank", "src": "u02"},
        {"op": "add_node", "id": "gateway", "label": "Gateway", "type": "system", "src": "u02"}])
    assert [o["id"] for o in kept] == ["gateway"]
    assert [r["op"]["op"] for r in rejected] == ["add_node", "connect", "remove_node"]
    assert all("ids stay stable" in r["error"] for r in rejected)


def consolidate(s: Session, ops: list[dict], monkeypatch):
    """Run a consolidator pass on board "b" with a canned reply."""
    from whiteboard import agents
    async def fake(*a, **k):
        return agents.CallResult({"summary": "s", "ops": ops}, 1)
    monkeypatch.setattr(agents, "consolidate", fake)
    monkeypatch.setattr(agents.settings, "LAYOUT_HINTS", False)
    asyncio.run(s._run_consolidator("b"))


def add_gw(s: Session):
    s.board.apply_ops([{"op": "add_node", "id": "pgw", "label": "Payment GW", "type": "system", "src": "u01"},
                       {"op": "add_node", "id": "gw", "label": "Gateway", "type": "system", "src": "u01"},
                       {"op": "connect", "from": "checkout", "to": "pgw", "src": "u01"},
                       {"op": "connect", "from": "gw", "to": "bank", "src": "u01"}], by_lookup={"u01": "Ana"})


MERGE = [{"op": "add_node", "id": "payment_gateway", "label": "Payment Gateway", "type": "system", "src": "u02"},
         {"op": "connect", "from": "checkout", "to": "payment_gateway", "src": "u02"},
         {"op": "connect", "from": "payment_gateway", "to": "bank", "src": "u02"},
         {"op": "remove_node", "id": "pgw", "src": "u02"},
         {"op": "remove_node", "id": "gw", "src": "u02"},
         {"op": "update_node", "id": "checkout", "label": "Check out", "src": "u02"}]


def test_consolidator_merge_is_held_as_one_proposal(monkeypatch):
    s = make_session("ask")
    add_gw(s)
    consolidate(s, MERGE, monkeypatch)
    b = s.board.boards["b"]
    assert "payment_gateway" not in b["nodes"] and {"pgw", "gw"} <= b["nodes"].keys()   # no duplicate on the board
    assert b["nodes"]["checkout"]["label"] == "Check out"                                # unrelated ops still apply
    [p] = s.approvals
    assert (p["kind"], p["targets"], p["labels"], p["into"]) == ("merge", ["pgw", "gw"], ["Payment GW", "Gateway"],
                                                                  ["Payment Gateway"])
    assert [o["op"] for o in p["ops"]] == ["add_node", "connect", "connect", "remove_node", "remove_node"]
    assert asyncio.run(s.decide_approval(p["id"], True))["ok"]
    b = s.board.boards["b"]
    assert "payment_gateway" in b["nodes"] and not {"pgw", "gw"} & b["nodes"].keys()
    assert {"checkout->payment_gateway", "payment_gateway->bank"} <= b["edges"].keys()


def test_kept_merge_drops_the_whole_batch_and_sticks(monkeypatch):
    s = make_session("ask")
    add_gw(s)
    consolidate(s, MERGE, monkeypatch)
    asyncio.run(s.decide_approval(s.approvals[0]["id"], False))
    b = s.board.boards["b"]
    assert "payment_gateway" not in b["nodes"] and {"pgw", "gw"} <= b["nodes"].keys()
    consolidate(s, MERGE, monkeypatch)                      # the same merge again: refused, nothing applied
    assert s.approvals == [] and "payment_gateway" not in s.board.boards["b"]["nodes"]


def test_merge_of_same_label_nodes_never_half_applies(monkeypatch):
    """bank and bank_2 are both "Bank": re-creating "Bank" as bank_system must not remove either of them."""
    s = make_session("auto")
    s.board.apply_ops([{"op": "add_node", "id": "bank_2", "label": "Bank", "type": "system", "src": "u01"},
                       {"op": "add_node", "id": "ledger", "label": "Ledger", "type": "data", "src": "u01"},
                       {"op": "connect", "from": "bank_2", "to": "ledger", "src": "u01"}], by_lookup={"u01": "Ana"})
    consolidate(s, [{"op": "add_node", "id": "bank_system", "label": "Bank", "type": "system", "src": "u02"},
                    {"op": "connect", "from": "checkout", "to": "bank_system", "src": "u02"},
                    {"op": "remove_node", "id": "bank", "src": "u02"},
                    {"op": "remove_node", "id": "bank_2", "src": "u02"}], monkeypatch)
    b = s.board.boards["b"]
    assert {"bank", "bank_2"} <= b["nodes"].keys() and "bank_system" not in b["nodes"]
    assert {"checkout->bank", "bank_2->ledger"} <= b["edges"].keys()


def test_rename_merge_also_rejects_removal_of_a_node_it_reconnects():
    s = make_session("auto")
    s.board.apply_ops([{"op": "add_node", "id": "bank_api", "label": "Bank API", "type": "system", "src": "u01"},
                       {"op": "connect", "from": "checkout", "to": "bank_api", "src": "u01"},
                       {"op": "add_node", "id": "meta", "label": "Notes", "type": "data", "src": "u01"}],
                      by_lookup={"u01": "Ana"})
    kept, rejected = s._consolidator_guard([
        {"op": "add_node", "id": "bank_system", "label": "Bank", "type": "system", "src": "u02"},
        {"op": "connect", "from": "checkout", "to": "bank_system", "src": "u02"},
        {"op": "remove_node", "id": "bank", "src": "u02"},
        {"op": "remove_node", "id": "bank_api", "src": "u02"},     # same neighbour (checkout) re-pointed
        {"op": "remove_node", "id": "meta", "src": "u02"}], "b")   # unrelated: still goes through
    assert [o["id"] for o in kept] == ["meta"]
    assert [r["op"].get("id") for r in rejected if r["op"]["op"] == "remove_node"] == ["bank", "bank_api"]


def test_approval_rechecks_the_guard_and_missing_nodes(monkeypatch):
    s = make_session("ask")
    consolidate(s, [{"op": "remove_node", "id": "bank", "src": "u02"}], monkeypatch)
    [p] = s.approvals
    s.board.apply_ops([{"op": "mark", "target": "bank", "status": "disputed", "src": "u02"}], by_lookup={"u02": "Ben"})
    assert asyncio.run(s.decide_approval(p["id"], True))["ok"]
    assert "bank" in s.board.boards["b"]["nodes"] and s.approvals == []
    act = [e["item"] for e in s.timeline if e["type"] == "activity"][-1]
    assert act["ops"] == [] and "no longer applies" in act["rejected"][0]["error"]

    model(s, [{"op": "remove_node", "id": "checkout", "src": "u02"}])
    [p] = s.approvals
    del s.board.boards["b"]["nodes"]["checkout"]            # gone without a prune (e.g. a racing op)
    asyncio.run(s.decide_approval(p["id"], True))
    act = [e["item"] for e in s.timeline if e["type"] == "activity"][-1]
    assert "is gone" in act["rejected"][0]["error"] and s.approvals == []


def test_keep_is_keyed_by_node_not_src():
    s = make_session("ask")
    model(s, [{"op": "remove_node", "id": "bank", "src": "u02"}])
    asyncio.run(s.decide_approval(s.approvals[0]["id"], False))
    model(s, [{"op": "remove_node", "id": "bank", "src": "u01"}])        # same removal, another (fallback) src
    act = [e["item"] for e in s.timeline if e["type"] == "activity"][-1]
    assert s.approvals == [] and "kept by a person" in act["rejected"][0]["error"]


def test_board_switch_in_the_batch_moves_the_target_board():
    s = make_session("ask")
    s.board.apply_ops([{"op": "new_board", "id": "c", "title": "C", "src": "u01"},
                       {"op": "add_node", "id": "bank", "label": "Other bank", "type": "system", "src": "u01"},
                       {"op": "switch_board", "board": "b", "src": "u01"}], by_lookup={"u01": "Ana"})
    kept, held, _ = s._hold_destructive([{"op": "switch_board", "board": "c", "src": "u02"},
                                         {"op": "remove_node", "id": "bank", "src": "u02"}], "modeller")
    assert len(held) == 1 and s.approvals[0]["board"] == "c" and s.approvals[0]["label"] == "Other bank"
    kept, held, _ = s._hold_destructive([{"op": "new_board", "id": "d", "title": "D", "src": "u02"},
                                         {"op": "remove_node", "id": "bank", "src": "u02"}], "modeller")
    assert held == [] and len(kept) == 2                   # nothing to remove on the new board "d": not held


def test_switching_to_autopilot_applies_pending(monkeypatch, tmp_path):
    from whiteboard import recording
    monkeypatch.setattr(recording, "RUNS_DIR", tmp_path)
    s = make_session("ask")
    add_gw(s)
    model(s, [{"op": "remove_node", "id": "checkout", "src": "u02"}])
    consolidate(s, MERGE[:5], monkeypatch)
    consolidate(s, [{"op": "remove_node", "id": "bank", "src": "u02"}], monkeypatch)
    s.board.apply_ops([{"op": "mark", "target": "bank", "status": "disputed", "src": "u02"}], by_lookup={"u02": "Ben"})
    assert len(s.approvals) == 3
    s.status, s.run_file = "finished", "r.json"            # decided after the meeting ended
    s.timeline[-1]["t"] = 1.0
    s.t0 -= 600                                            # ten idle minutes
    assert asyncio.run(s.set_approval_mode("auto"))["ok"]
    b = s.board.boards["b"]
    assert s.approvals == [] and s.view_approvals == []
    assert "payment_gateway" in b["nodes"] and not {"pgw", "gw", "checkout"} & b["nodes"].keys()
    assert "bank" in b["nodes"]                            # became disputed while waiting: the re-check drops it
    assert (tmp_path / "r.json").exists() and s.timeline[-1]["t"] < 2.0   # saved, and no idle gap in replay


def test_keep_after_the_meeting_is_saved(monkeypatch, tmp_path):
    from whiteboard import recording
    monkeypatch.setattr(recording, "RUNS_DIR", tmp_path)
    s = make_session("ask")
    model(s, REMOVE)
    s.status, s.run_file = "finished", "r.json"
    asyncio.run(s.decide_approval("*", False))
    import json
    saved = json.loads((tmp_path / "r.json").read_text())
    assert [e for e in saved["events"] if e["type"] == "approvals"][-1]["pending"] == []
