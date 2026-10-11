"""Exports: board JSON, Mermaid, the spec writer prompt, and the /api/export routes (agents faked, no API calls).

Routes are called as plain async functions on a prepared session (no HTTP client needed)."""

import asyncio
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from whiteboard import agents, export, session as session_mod  # noqa: E402
from whiteboard.agents import CallResult  # noqa: E402
from whiteboard.board import BoardState  # noqa: E402
from whiteboard.session import Session  # noqa: E402

MEETING = {"id": "t", "title": "Order Flow: v2", "topic": "orders",
           "participants": [{"name": "Ana", "role": "PM", "color": "#000"},
                            {"name": "Marko", "role": "Dev", "color": "#111"}],
           "utterances": []}
BY = {"u1": "Ana", "u2": "Marko", "u3": "Ana"}
TRANSCRIPT = [
    {"id": "u1", "speaker": "Ana", "text": "Checkout pays the bank.", "done": True, "kind": "new_info"},
    {"id": "u2", "speaker": "Marko", "text": "Can you hear me?", "done": True, "kind": "chit_chat"},
    {"id": "u3", "speaker": "Ana", "text": "Maybe we store orders.", "done": True, "kind": "new_info"},
    {"id": "u4", "speaker": "Marko", "text": "And then", "done": False, "kind": None},   # still being spoken
]


def board_state() -> BoardState:
    s = BoardState()
    r = s.apply_ops([
        {"op": "new_board", "id": "flow", "title": "Order flow", "kind": "process", "src": "u1"},
        {"op": "add_group", "id": "pay", "label": "Payments", "src": "u1"},
        {"op": "add_node", "id": "checkout", "label": "Checkout", "type": "step", "src": "u1"},
        {"op": "add_node", "id": "bank", "label": 'Bank "X" [EU]', "type": "system", "group": "pay", "src": "u1"},
        {"op": "add_node", "id": "db", "label": "Orders", "type": "data", "status": "ghost", "src": "u3"},
        {"op": "add_node", "id": "ok", "label": "OK?", "type": "decision", "src": "u3"},
        {"op": "connect", "from": "checkout", "to": "bank", "label": 'pays "now"', "src": "u1"},
        {"op": "connect", "from": "checkout", "to": "db", "status": "ghost", "src": "u3"},
        {"op": "connect", "from": "bank", "to": "ok", "src": "u3"},
        {"op": "mark", "target": "bank->ok", "status": "disputed", "src": "u3"},
    ], by_lookup=BY)
    assert not r["rejected"], r["rejected"]
    return s


# ------------------------------------------------------------------ JSON
def test_board_json_lists_boards_strips_internals_and_keeps_sources():
    data = export.board_json(MEETING, board_state().to_dict())
    assert data["format"] == "shape-the-talk/board" and data["version"] == 1
    assert data["meeting"] == {"title": "Order Flow: v2", "topic": "orders",
                               "participants": [{"name": "Ana", "role": "PM"}, {"name": "Marko", "role": "Dev"}]}
    assert data["active"] == "flow"
    (b,) = data["boards"]
    assert (b["id"], b["title"], b["kind"]) == ("flow", "Order flow", "process")
    assert b["groups"] == [{"id": "pay", "label": "Payments", "by": "Ana", "src": "u1"}]
    assert [n["id"] for n in b["nodes"]] == ["checkout", "bank", "db", "ok"]
    for item in b["nodes"] + b["edges"]:
        assert "v" not in item and "created_v" not in item
        assert item["src"] in {"u1", "u3"}                     # links back to the transcript
    edge = next(e for e in b["edges"] if e["id"] == "checkout->bank")
    assert (edge["from"], edge["to"], edge["label"], edge["by"]) == ("checkout", "bank", 'pays "now"', "Ana")
    assert "transcript" not in data
    json.dumps(data)                                           # serialisable as-is


# --------------------------------------------------------------- Mermaid
def test_board_mermaid_shapes_groups_dashed_edges_and_escaping():
    lines = export.board_mermaid(board_state().to_dict()["boards"][0]).splitlines()
    assert lines[0] == "flowchart LR"
    sub = lines.index('  subgraph sg_pay["Payments"]')
    assert lines[sub + 1:sub + 3] == ['    n_bank[["Bank #quot;X#quot; [EU]"]]', "  end"]
    for expected in ['  n_checkout["Checkout"]', '  n_db[("Orders")]', '  n_ok{"OK?"}',
                     '  n_checkout -->|"pays #quot;now#quot;"| n_bank',
                     "  n_checkout -.-> n_db",              # ghost edge: dashed
                     "  n_bank -.-> n_ok",                  # disputed edge: dashed
                     "  class n_db ghost"]:
        assert expected in lines
    assert any(line.startswith("  classDef ghost") for line in lines)
    assert not any("n_bank[[" in line for line in lines[sub + 3:])   # grouped node drawn once, inside its subgraph


def test_board_mermaid_direction_and_safe_ids():
    board = {"id": "b", "title": "B", "kind": "process", "layout": {"direction": "tb"}, "groups": {},
             "nodes": {"end": {"id": "end", "label": "End", "type": "step", "status": "confirmed"},
                       "a-b c": {"id": "a-b c", "label": "", "type": "unknown", "status": "confirmed"}},
             "edges": {}}
    lines = export.board_mermaid(board).splitlines()
    assert lines[0] == "flowchart TB"
    assert '  n_end["End"]' in lines                # never a bare `end` keyword
    assert '  n_a_b_c[""]' in lines                 # sanitised id, unknown type falls back to a box
    assert export.board_mermaid({**board, "layout": {"direction": "diagonal"}}).startswith("flowchart LR")


def test_all_mermaid_one_fenced_block_per_board():
    s = board_state()
    s.apply_ops([{"op": "new_board", "id": "arch", "title": "Architecture", "kind": "architecture", "src": "u3"}],
                by_lookup=BY)
    md = export.all_mermaid(MEETING, s.to_dict())
    assert md.startswith("# Order Flow: v2\n")
    assert "## Order flow\n\n```mermaid\nflowchart LR\n" in md and "## Architecture\n\n```mermaid\n" in md
    assert md.count("```mermaid") == 2 and md.count("```") == 4


def test_slug():
    assert export.slug("Order Flow: v2") == "order-flow-v2"
    assert export.slug("") == export.slug(None) == export.slug("!!!") == "whiteboard"


# ----------------------------------------------------------- spec writer
def test_spec_prompt_formats_and_uses_long_timeout(monkeypatch):
    seen = {}

    async def fake_call(name, system, user, schema, effort, **kw):
        seen.update(name=name, system=system, user=user, schema=schema, effort=effort, **kw)
        return CallResult({"title": "T", "markdown": "# T"}, 5)

    monkeypatch.setattr(agents.spec, "call_json", fake_call)
    boards = {"boards": export.board_json(MEETING, board_state().to_dict())["boards"]}
    res = asyncio.run(agents.generate_spec(MEETING, TRANSCRIPT[:1], boards,
                                           [{"question": "Which bank?"}], [{"topic": "Store orders?"}]))
    assert res.data == {"title": "T", "markdown": "# T"}
    assert seen["schema"] is agents.SPEC_SCHEMA and seen["effort"] == agents.SPEC_EFFORT
    assert seen["timeout"] == agents.spec.SPEC_TIMEOUT > 30
    assert "Order Flow: v2" in seen["system"] and "- Ana: PM" in seen["system"]
    assert "{title}" not in seen["system"] and "{participants}" not in seen["system"]
    assert "[u1] Ana: Checkout pays the bank." in seen["user"]
    assert '"Order flow"' in seen["user"] and "Which bank?" in seen["user"] and "Store orders?" in seen["user"]


# ---------------------------------------------------------------- routes
@pytest.fixture
def sess(monkeypatch):
    monkeypatch.setattr(session_mod, "load_meeting", lambda: MEETING)
    s = Session()
    s.view_board = board_state().to_dict()
    s.view_transcript = [dict(u) for u in TRANSCRIPT]
    s.questions = [{"question": "Which bank?"}]
    s.disagreements = []
    monkeypatch.setattr(server, "session", s)
    monkeypatch.setattr(server, "spec_running", False)
    return s


def test_export_json_route(sess):
    r = asyncio.run(server.export_json())
    assert r.headers["content-disposition"] == 'attachment; filename="order-flow-v2-board.json"'
    data = json.loads(r.body)
    assert data["boards"][0]["id"] == "flow"
    assert "transcript" not in data


def test_export_mermaid_route(sess):
    r = asyncio.run(server.export_mermaid())
    assert r.headers["content-disposition"] == 'attachment; filename="order-flow-v2-mermaid.md"'
    assert r.media_type == "text/markdown"
    assert "```mermaid\nflowchart LR\n" in r.body.decode()


def test_export_spec_route_passes_meaningful_transcript_and_all_boards(sess, monkeypatch):
    seen = {}

    async def fake_spec(meeting, transcript, boards, questions, disagreements):
        seen.update(transcript=transcript, boards=boards, questions=questions)
        return CallResult({"title": "Order flow spec", "markdown": "## Overview"}, 5)

    monkeypatch.setattr(agents, "generate_spec", fake_spec)
    r = asyncio.run(server.export_spec())
    assert r.status_code == 200
    assert json.loads(r.body) == {"ok": True, "title": "Order flow spec", "markdown": "## Overview",
                                  "filename": "order-flow-v2-spec.md"}
    assert [u["id"] for u in seen["transcript"]] == ["u1", "u3"]          # no chit-chat, no unfinished utterance
    assert [b["id"] for b in seen["boards"]["boards"]] == ["flow"]
    assert seen["questions"] == [{"question": "Which bank?"}]
    assert server.spec_running is False


def test_export_spec_route_errors(sess, monkeypatch):
    async def failing_spec(*a):
        return CallResult(None, 5, error="APITimeoutError: Request timed out.")

    monkeypatch.setattr(agents, "generate_spec", failing_spec)
    r = asyncio.run(server.export_spec())
    assert r.status_code == 502 and "APITimeoutError" in json.loads(r.body)["error"]
    assert server.spec_running is False                                  # guard released after a failure

    monkeypatch.setattr(server, "spec_running", True)
    r = asyncio.run(server.export_spec())
    assert r.status_code == 409 and json.loads(r.body)["ok"] is False

    monkeypatch.setattr(server, "spec_running", False)
    sess.view_board = BoardState().to_dict()
    r = asyncio.run(server.export_spec())
    assert r.status_code == 400 and "empty" in json.loads(r.body)["error"]
