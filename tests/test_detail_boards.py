"""Overview and detail boards: the extract_subflow op (cut, references, merged edges, groups, undo), the board views
the agents get, cross-board connects, the modeller's routing to detail boards, the consolidator guards, the exports
and the eval metrics over a topic's tree (agents faked, no API calls)."""

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import eval_metrics as M  # noqa: E402
from whiteboard import agents, export  # noqa: E402
from whiteboard.agents import CallResult  # noqa: E402
from whiteboard.agents.consolidator import board_size  # noqa: E402
from whiteboard.board import BoardState  # noqa: E402
from whiteboard.session import Session  # noqa: E402

BY = {f"u{i}": ("Ana" if i % 2 else "Marko") for i in range(1, 20)}
SPLIT = {"op": "extract_subflow", "nodes": "verify, birth, policy", "id": "verification", "label": "Verification",
         "title": "Caller verification", "note": "phone, birth date, policy", "src": "u2"}


def agent_board() -> BoardState:
    """A voice agent: the orchestrator verifies callers (three nodes with retries) before the specialist."""
    s = BoardState()
    ops = [{"op": "new_board", "id": "agent", "title": "Voice agent", "kind": "process", "src": "u1"},
           {"op": "add_group", "id": "checks", "label": "Checks", "src": "u1"}]
    for nid, label, typ, group in [("orch", "Orchestrator", "system", None), ("verify", "Verify caller", "step", None),
                                   ("birth", "Birth date OK?", "decision", "checks"),
                                   ("policy", "Policy number OK?", "decision", "checks"),
                                   ("spec", "Specialist", "system", None), ("human", "Human agent", "actor", None)]:
        ops.append({"op": "add_node", "id": nid, "label": label, "type": typ, "group": group, "src": "u1"})
    for a, z, label in [("orch", "verify", "verify first"), ("verify", "birth", None), ("verify", "policy", "no match"),
                        ("birth", "spec", "ok"), ("policy", "spec", "ok"), ("birth", "human", "after 3 fails"),
                        ("policy", "human", "after 2 fails"), ("spec", "orch", "new question")]:
        ops.append({"op": "connect", "from": a, "to": z, "label": label, "src": "u1"})
    r = s.apply_ops(ops, by_lookup=BY)
    assert not r["rejected"], r["rejected"]
    return s


# ------------------------------------------------------------------ the op
def test_extract_subflow_moves_the_cut_to_a_detail_board_behind_one_summary_node():
    s = agent_board()
    r = s.apply_ops([SPLIT], by_lookup=BY)
    assert not r["rejected"] and s.active == "agent"
    over, det = s.boards["agent"], s.boards["verification_detail"]
    assert s.board_order == ["agent", "verification_detail"] and det["parent"] == "agent"
    assert det["title"] == "Caller verification" and det["kind"] == "process" and det["by"] == "Marko"
    # overview: the summary node instead of the three, with every edge across the cut re-pointed to it
    assert set(over["nodes"]) == {"orch", "spec", "human", "verification"}
    summary = over["nodes"]["verification"]
    assert summary["detail"] == "verification_detail" and summary["type"] == "step" and summary["by"] == "Marko"
    assert summary["note"] == "phone, birth date, policy"
    assert set(over["edges"]) == {"orch->verification", "verification->spec", "verification->human", "spec->orch"}
    assert over["edges"]["orch->verification"]["label"] == "verify first"
    assert over["edges"]["verification->spec"]["label"] == "ok"                       # parallel edges merged
    assert over["edges"]["verification->human"]["label"] == "after 3 fails / after 2 fails"
    # detail: the nodes keep who said them; the outside ends are references; the edges are the original ones
    assert det["nodes"]["birth"]["by"] == "Ana" and det["nodes"]["birth"]["group"] == "checks"
    refs = {nid for nid, n in det["nodes"].items() if n.get("ref_board")}
    assert refs == {"orch", "spec", "human"} and all(det["nodes"][r]["ref_board"] == "agent" for r in refs)
    assert det["nodes"]["human"]["label"] == "Human agent" and det["nodes"]["human"]["type"] == "actor"
    assert set(det["edges"]) == {"orch->verify", "verify->birth", "verify->policy", "birth->spec", "policy->spec",
                                 "birth->human", "policy->human"}
    # a group whose members all moved moves with them
    assert "checks" in det["groups"] and "checks" not in over["groups"]


def test_extract_subflow_is_one_undoable_change():
    s = agent_board()
    before = json.dumps(s.to_dict()["boards"], sort_keys=True)
    s.apply_ops([SPLIT], by_lookup=BY)
    assert s.undo_last()
    assert s.board_order == ["agent"] and json.dumps(s.to_dict()["boards"], sort_keys=True) == before
    s.apply_ops([SPLIT], by_lookup=BY)                                     # and through "scratch that" of its utterance
    s.apply_ops([{"op": "undo", "target_src": "u2", "src": "u3"}], by_lookup=BY)
    assert s.board_order == ["agent"] and set(s.boards["agent"]["nodes"]) == {"orch", "verify", "birth", "policy", "spec", "human"}


def test_extract_subflow_rejections():
    s = agent_board()
    def err(**kw):
        return s.apply_ops([{**SPLIT, **kw}], by_lookup=BY)["rejected"][0]["error"]
    assert "no node 'nope'" in err(nodes="verify, birth, nope")
    assert "at least 3" in err(nodes="verify, birth")
    assert "nothing on the board" in err(nodes="orch, verify, birth, policy, spec, human")
    assert "already exists" in err(id="orch")
    assert "already exists" in err(id="checks")                           # a group id: the layout plan shares them
    assert not s.apply_ops([SPLIT], by_lookup=BY)["rejected"]
    assert "one level only" in err(board="verification_detail", nodes="verify, birth, policy", id="x")
    s.apply_ops([{"op": "add_node", "id": "a", "label": "A", "type": "step", "src": "u3"}], by_lookup=BY)
    assert "summary node stays" in err(nodes="verification, a, orch", id="y")


def test_summary_id_may_be_a_cut_node_and_a_shared_group_stays():
    s = agent_board()
    s.apply_ops([{"op": "set_group", "node": "verify", "group": "checks", "src": "u3"},
                 {"op": "add_node", "id": "kb", "label": "Knowledge base", "type": "data", "group": "checks", "src": "u3"}],
                by_lookup=BY)
    r = s.apply_ops([{**SPLIT, "id": "verify"}], by_lookup=BY)
    assert not r["rejected"]
    over, det = s.boards["agent"], s.boards["verify_detail"]
    assert over["nodes"]["verify"]["detail"] == "verify_detail" and "verify" in det["nodes"]
    # "checks" keeps a member on the overview: it stays there (with the summary node) and is copied to the detail board
    assert "checks" in over["groups"] and "checks" in det["groups"] and over["nodes"]["verify"]["group"] == "checks"
    s.apply_ops([{**SPLIT, "nodes": "orch, spec, kb", "id": "verify2"}], by_lookup=BY)
    assert s.board_order == ["agent", "verify_detail", "verify2_detail"]   # each detail tab right after its overview


def test_detail_tabs_follow_their_overview_and_a_new_topic_comes_after_them():
    s = agent_board()
    s.apply_ops([{"op": "new_board", "id": "eval", "title": "Evaluation", "src": "u3"},
                 {"op": "add_node", "id": "dataset", "label": "Dataset", "type": "data", "src": "u3"},
                 {"op": "switch_board", "board": "agent", "src": "u3"}], by_lookup=BY)
    s.apply_ops([SPLIT], by_lookup=BY)
    assert s.board_order == ["agent", "verification_detail", "eval"] and s.top_level() == ["agent", "eval"]
    assert s.children("agent") == ["verification_detail"]


def test_nodes_added_on_the_overview_after_the_split_can_join_its_detail_board():
    s = agent_board()
    s.apply_ops([SPLIT,                       # later talk added a fallback check on the overview, wired to the summary
                 {"op": "add_node", "id": "otp", "label": "SMS code OK?", "type": "decision", "src": "u3"},
                 {"op": "add_node", "id": "otp_sent", "label": "Send SMS code", "type": "step", "src": "u3"},
                 {"op": "connect", "from": "verification", "to": "otp_sent", "src": "u3"},
                 {"op": "connect", "from": "otp_sent", "to": "otp", "src": "u3"},
                 {"op": "connect", "from": "otp", "to": "human", "label": "fails", "src": "u3"}], by_lookup=BY)
    r = s.apply_ops([{"op": "extract_subflow", "nodes": "otp_sent, otp", "id": "verification", "label": "Verification",
                      "note": "phone, birth date, policy, SMS", "src": "u4"}], by_lookup=BY)
    assert not r["rejected"], r["rejected"]
    over, det = s.boards["agent"], s.boards["verification_detail"]
    assert s.board_order == ["agent", "verification_detail"] and set(over["nodes"]) == {"orch", "spec", "human", "verification"}
    assert over["nodes"]["verification"]["note"] == "phone, birth date, policy, SMS"
    assert {"otp", "otp_sent"} <= set(det["nodes"]) and "otp->human" in det["edges"] and "otp_sent->otp" in det["edges"]
    assert "verification->otp_sent" not in over["edges"] and "verification->human" in over["edges"]
    assert s.undo_last() and {"otp", "otp_sent"} <= set(over["nodes"]) and "otp" not in det["nodes"]
    # a node that is a reference on the detail board becomes the node itself there
    r = s.apply_ops([{"op": "extract_subflow", "nodes": "spec", "id": "verification", "label": "V", "src": "u4"}], by_lookup=BY)
    assert not r["rejected"] and not det["nodes"]["spec"].get("ref_board") and "spec" not in over["nodes"]
    assert "verification->spec" not in over["edges"] and "spec->orch" in det["edges"] and "spec->orch" not in over["edges"]
    assert over["edges"]["verification->orch"]["label"] == "new question"


# ------------------------------------------------------------------ what the agents see
def test_compact_shows_the_active_board_and_its_details_in_full_and_brief_counts_them_as_one_topic():
    s = agent_board()
    s.apply_ops([SPLIT, {"op": "new_board", "id": "eval", "title": "Evaluation", "src": "u3"},
                 {"op": "add_node", "id": "dataset", "label": "Dataset", "type": "data", "src": "u3"},
                 {"op": "switch_board", "board": "agent", "src": "u3"}], by_lookup=BY)
    c = {b["id"]: b for b in s.compact()["boards"]}
    assert c["verification_detail"]["parent"] == "agent" and isinstance(c["verification_detail"]["nodes"][0], dict)
    assert next(n for n in c["agent"]["nodes"] if n["id"] == "verification")["detail"] == "verification_detail"
    assert next(n for n in c["verification_detail"]["nodes"] if n["id"] == "orch")["ref_board"] == "agent"
    assert isinstance(c["eval"]["nodes"][0], str)                       # another topic: labels only
    brief = s.brief()
    assert brief["others"] == ["Evaluation"] and "Birth date OK?" in brief["current"]["nodes"]
    assert brief["current"]["nodes"].count("Orchestrator") == 1         # references are not repeated
    line = board_size({**s.compact(full_boards={"agent"}), "active_board": "agent"})
    assert "4 nodes" in line and "verification_detail (Caller verification)" in line
    line = board_size({**s.compact(full_boards={"verification_detail"}), "active_board": "verification_detail"})
    assert "3 nodes (+3 references)" in line and "never extract_subflow here" in line


def test_connect_across_the_cut_adds_the_reference_and_the_overview_edge():
    s = agent_board()
    s.apply_ops([SPLIT, {"op": "add_node", "id": "kb", "label": "Knowledge base", "type": "data", "src": "u3"}], by_lookup=BY)
    # on the overview, to a node that lives on the detail board
    r = s.apply_ops([{"op": "connect", "from": "policy", "to": "kb", "label": "looks up", "src": "u3"}], by_lookup=BY)
    assert not r["rejected"]
    det, over = s.boards["verification_detail"], s.boards["agent"]
    assert det["nodes"]["kb"]["ref_board"] == "agent" and det["edges"]["policy->kb"]["label"] == "looks up"
    assert over["edges"]["verification->kb"]["label"] == "looks up"
    # on the detail board, from an overview node (the existing overview edge is kept, not doubled)
    r = s.apply_ops([{"op": "connect", "board": "verification_detail", "from": "orch", "to": "policy", "src": "u3"}],
                    by_lookup=BY)
    assert not r["rejected"] and "orch->policy" in det["edges"] and "orch->verification" in over["edges"]
    # renaming or removing the overview node updates or drops its references
    s.apply_ops([{"op": "update_node", "id": "human", "label": "Live agent", "src": "u3"}], by_lookup=BY)
    assert det["nodes"]["human"]["label"] == "Live agent"
    s.apply_ops([{"op": "remove_node", "id": "kb", "src": "u3"}], by_lookup=BY)
    assert "kb" not in det["nodes"] and "policy->kb" not in det["edges"]


def session_with_split(monkeypatch=None) -> Session:
    s = Session()
    s.board = agent_board()
    s.board.apply_ops([SPLIT], by_lookup=BY)
    s.spoken = [{"id": f"u{i}", "speaker": BY[f"u{i}"], "text": "x"} for i in range(1, 10)]
    return s


def test_modeller_ops_for_a_detail_board_are_routed_there():
    s = session_with_split()
    ops = s._route_to_details([
        {"op": "update_node", "id": "birth", "note": "3 tries", "src": "u4"},           # only on the detail board
        {"op": "update_node", "id": "orch", "note": "entry", "src": "u4"},              # on the overview (and a ref)
        {"op": "add_node", "id": "sms", "label": "SMS code?", "type": "decision", "src": "u4"},
        {"op": "connect", "from": "policy", "to": "sms", "src": "u4"},                  # sms goes where policy is
        {"op": "add_node", "id": "billing", "label": "Billing", "type": "system", "src": "u4"},
        {"op": "connect", "from": "orch", "to": "billing", "src": "u4"},
        {"op": "mark", "target": "birth->human", "status": "disputed", "note": "Ana vs Marko", "src": "u4"},
    ])
    assert [op.get("board") for op in ops] == ["verification_detail", None, "verification_detail", "verification_detail",
                                               None, None, "verification_detail"]
    r = s.board.apply_ops(ops, by_lookup=BY)
    assert not r["rejected"], r["rejected"]
    assert "sms" in s.board.boards["verification_detail"]["nodes"] and "billing" in s.board.boards["agent"]["nodes"]


def test_a_new_cluster_goes_where_it_connects_even_through_other_new_nodes():
    """A modeller call that started before the split: a review step connected to a node that has moved."""
    s = session_with_split()
    ops = s._route_to_details([
        {"op": "add_node", "id": "review", "label": "Needs review?", "type": "decision", "src": "u4"},
        {"op": "add_node", "id": "manual", "label": "Manual check", "type": "step", "src": "u4"},
        {"op": "connect", "from": "review", "to": "manual", "label": "yes", "src": "u4"},
        {"op": "connect", "from": "manual", "to": "birth", "src": "u4"},
        {"op": "connect", "from": "manual", "to": "human", "src": "u4"}])     # human: on both (a reference there)
    assert [op.get("board") for op in ops] == ["verification_detail"] * 5
    r = s.board.apply_ops(ops, by_lookup=BY)
    assert not r["rejected"], r["rejected"]
    assert {"review", "manual"} <= set(s.board.boards["verification_detail"]["nodes"])
    assert "manual->human" in s.board.boards["verification_detail"]["edges"]


def test_a_switch_to_a_detail_board_keeps_the_overview_active():
    s = session_with_split()
    ops = s._route_to_details([{"op": "switch_board", "board": "verification_detail", "src": "u4"},
                               {"op": "add_node", "id": "otp", "label": "One-time code", "type": "step", "src": "u4"}])
    assert ops == [{"op": "add_node", "id": "otp", "label": "One-time code", "type": "step", "src": "u4",
                    "board": "verification_detail"}]
    s.board.apply_ops([{"op": "new_board", "id": "eval", "title": "Evaluation", "src": "u5"},
                       {"op": "add_node", "id": "dataset", "label": "Dataset", "type": "data", "src": "u5"}], by_lookup=BY)
    ops = s._route_to_details([{"op": "switch_board", "board": "verification_detail", "src": "u6"},
                               {"op": "add_node", "id": "otp", "label": "One-time code", "type": "step", "src": "u6"}])
    assert ops[0] == {"op": "switch_board", "board": "agent", "src": "u6"} and ops[1]["board"] == "verification_detail"


def test_ops_on_a_detail_board_do_not_start_a_new_topic_and_the_modeller_cannot_split():
    s = session_with_split()
    assert not s._fits_new_board([{"op": "update_node", "id": "birth", "note": "x", "src": "u4"}])
    assert not s._fits_new_board([{"op": "add_node", "id": "x", "label": "X", "type": "step", "board": "verification_detail"}])
    assert s._fits_new_board([{"op": "add_node", "id": "release", "label": "Release", "type": "step", "src": "u4"}])
    items = [{"utt": {"id": "u4", "speaker": "Ana", "text": "x"}, "extraction": {"kind": "new_info", "claims": []}}]
    kept, rejected = s._modeller_guard([{**SPLIT, "src": "u4"}], items)
    assert not kept and "only the consolidator" in rejected[0]["error"]


def test_consolidator_leaves_references_and_summary_nodes_alone():
    s = session_with_split()
    kept, rejected = s._consolidator_guard([
        {"op": "remove_node", "id": "orch", "src": "u4"}, {"op": "update_node", "id": "human", "label": "H", "src": "u4"},
        {"op": "remove_node", "id": "birth", "src": "u4"}], "verification_detail")
    assert [o["id"] for o in kept] == ["birth"] and all("reference" in r["error"] for r in rejected)
    kept, rejected = s._consolidator_guard([{"op": "remove_node", "id": "verification", "src": "u4"},
                                            {**SPLIT, "nodes": "orch, spec, human", "id": "rest", "src": "u4"}], "agent")
    assert [o["op"] for o in kept] == ["extract_subflow"] and "detail board" in rejected[0]["error"]


def test_final_pass_splits_then_cleans_up_the_new_detail_board(monkeypatch):
    """At the end: the topic board's pass (told it is the final one) splits it, then the new detail board gets its own."""
    s = Session()
    s.board = agent_board()
    s.spoken = [{"id": f"u{i}", "speaker": BY[f"u{i}"], "text": "x"} for i in range(1, 4)]
    passes = []

    async def consolidate(meeting, transcript, compact, layout=None):
        passes.append((compact["active_board"], compact.get("final_pass", False)))
        ops = [SPLIT] if compact["active_board"] == "agent" else []
        return CallResult({"summary": "s", "ops": ops}, 1)

    async def noop(*a, **k):
        return None

    events = []
    async def emit(ev, record=True):
        events.append(ev)
    monkeypatch.setattr(s, "emit", emit)
    monkeypatch.setattr(agents, "consolidate", consolidate)
    monkeypatch.setattr(agents.settings, "LAYOUT_HINTS", False)
    for name in ("_kick_analyst", "_save_run"):
        monkeypatch.setattr(s, name, lambda *a, **k: None)
    for name in ("_write_summary", "emit_status"):
        monkeypatch.setattr(s, name, noop)
    asyncio.run(s._finish_meeting())
    assert passes == [("agent", True), ("verification_detail", True)]
    relayout = [e for e in events if e["type"] == "relayout"][-1]
    assert relayout["boards"] == ["agent", "verification_detail"]


# ------------------------------------------------------------------ exports
def test_exports_carry_the_tree():
    s = agent_board()
    s.apply_ops([SPLIT], by_lookup=BY)
    state = s.to_dict()
    data = export.board_json({"title": "T"}, state)
    assert [b.get("parent") for b in data["boards"]] == [None, "agent"]
    assert next(n for n in data["boards"][0]["nodes"] if n["id"] == "verification")["detail"] == "verification_detail"
    md = export.all_mermaid({"title": "T"}, state)
    assert "## Voice agent" in md and "### Caller verification (detail of Voice agent)" in md
    assert 'n_verification["Verification ▸"]' in md and "class n_verification detail" in md
    assert 'n_orch>"from Orchestrator"]' in md and 'n_human>"→ Human agent"]' in md


# ------------------------------------------------------------------ eval metrics
def test_metrics_count_topics_and_follow_expected_edges_into_detail_boards():
    s = agent_board()
    s.apply_ops([SPLIT], by_lookup=BY)
    boards = s.to_dict()["boards"]
    exp = {"boards": {"expected": 1, "min": 1, "max": 1},
           "concepts": ["verification", "birth date", "human"],
           "decisions": ["policy number"],
           "edges": [{"from": "orchestrator", "to": "birth date"},        # via the summary node into the detail board
                     {"from": "policy", "to": "human"},                    # on the detail board, to a reference
                     {"from": "birth date", "to": "orchestrator"},         # out through a reference and the overview
                     {"from": "human", "to": "orchestrator"}]}             # no such path
    ex = M.check_expectations(boards, exp)
    assert ex["boards"] == 1 and ex["detail_boards"] == 1 and ex["boards_ok"]
    assert ex["concept_coverage"] == 1.0 and ex["decision_coverage"] == 1.0
    assert ex["missing_edges"] == ["human -> orchestrator"]
    st = M.structural(boards[1])
    assert st["nodes"] == 3 and st["refs"] == 3 and st["orphans"] == 0
    assert M.structural(boards[0])["summaries"] == 1
    assert [len(t) for t in M.topics(boards)] == [2]
