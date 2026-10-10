"""Consolidator: prompt/schema formatting, session trigger, op guards (agents faked, no API calls)."""

import asyncio
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from whiteboard import agents, session as session_mod  # noqa: E402
from whiteboard.agents import CallResult  # noqa: E402
from whiteboard.session import Session  # noqa: E402

MEETING = {"id": "t", "title": "T", "topic": "x", "participants": [{"name": "Ana", "role": "r", "color": "#000"}],
           "utterances": [{"id": f"u{i:02d}", "speaker": "Ana", "text": f"part {i}", "pause": 0} for i in range(1, 14)]}


def test_consolidator_prompt_formats_and_reuses_modeller_schema(monkeypatch):
    seen = {}

    async def fake_call(name, system, user, schema, effort, model, thinking):
        seen.update(system=system, user=user, schema=schema, effort=effort, thinking=thinking)
        return CallResult({"summary": "s", "ops": [{"op": "remove_node", "src": "u01", "id": "agent_one", "from": ""}]}, 5)

    monkeypatch.setattr(agents, "call_json", fake_call)
    for meeting in (MEETING, {**MEETING, "source": "mic"}):
        res = asyncio.run(agents.consolidate(meeting, [{"id": "u01", "speaker": "Ana", "text": "hi"}],
                                             {"active_board": "b", "boards": []}))
        assert res.data["ops"] == [{"op": "remove_node", "src": "u01", "id": "agent_one"}]   # _clean_ops applied
        assert ("LIVE SPEECH" in seen["system"]) == (meeting.get("source") == "mic")
        assert "{" not in seen["system"].split("Participants:")[0]                          # all placeholders filled
    assert seen["schema"] is agents.MODELLER_SCHEMA and seen["effort"] == agents.CONSOLIDATOR_EFFORT
    assert "[u01] Ana: hi" in seen["user"] and '"active_board": "b"' in seen["user"]


@pytest.fixture
def fake_agents(monkeypatch, tmp_path):
    calls = {"consolidate": [], "order": []}

    async def extract(meeting, context, utt):
        return CallResult({"kind": "new_info", "claims": [utt["text"]], "refers_to": None, "topic_shift": False}, 1)

    async def model(meeting, compact, window, items):
        ops = [] if compact["boards"] else [{"op": "new_board", "id": "b", "title": "B", "kind": "process",
                                             "src": items[0]["utt"]["id"]}]
        ops += [{"op": "add_node", "id": f"n_{i['utt']['id']}", "label": "x", "type": "step", "src": i["utt"]["id"]}
                for i in items]
        return CallResult({"summary": "ok", "ops": ops}, 1)

    async def analyse(meeting, transcript, compact, *a):
        calls["order"].append(("analyst", len(transcript)))
        return CallResult({"open_questions": [], "disagreements": [], "suggested_marks": []}, 1)

    async def consolidate(meeting, transcript, compact):
        calls["consolidate"].append(len(transcript))
        calls["order"].append(("consolidator", len(transcript)))
        ops = [{"op": "remove_node", "id": "n_u01", "src": "u01"},
               {"op": "connect", "from": "n_u02", "to": "n_u03", "status": "ghost", "src": "bogus"},
               {"op": "undo", "target_src": "u02", "src": "u02"},
               {"op": "new_board", "id": "x", "title": "X", "src": "u02"},
               {"op": "mark", "target": "n_u04", "status": "disputed", "src": "u02"},
               {"op": "remove_node", "id": "n_u05", "src": "u05"},
               {"op": "remove_node", "id": "gone", "src": "u02"}] if len(calls["consolidate"]) == 1 else []
        return CallResult({"summary": "cleanup", "ops": ops}, 7, 10, 2)

    async def warmup():
        return None

    for name, fn in [("extract", extract), ("model", model), ("analyse", analyse),
                     ("consolidate", consolidate), ("warmup", warmup)]:
        monkeypatch.setattr(agents, name, fn)
    monkeypatch.setattr(session_mod, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(session_mod, "load_meeting", lambda: MEETING)
    return calls


async def wait_for(cond, timeout=10.0):
    for _ in range(int(timeout / 0.01)):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition not reached")


def test_consolidator_runs_every_n_and_at_the_end_with_guards(fake_agents, monkeypatch):
    monkeypatch.setattr(session_mod, "CONSOLIDATE_EVERY", 6)
    seeded = {}

    async def run():
        s = Session()
        orig = s._run_consolidator

        async def seeded_run():  # an open dispute on n_u05 that the consolidator must leave alone
            if not seeded:
                s.board.apply_ops([{"op": "mark", "target": "n_u05", "status": "disputed", "src": "u05"}],
                                  by_lookup={u["id"]: u["speaker"] for u in s.spoken})
                seeded["done"] = True
            await orig()
        s._run_consolidator = seeded_run
        assert (await s.start("live", speed=16))["ok"]
        await wait_for(lambda: s.status == "finished")
        return s

    s = asyncio.run(run())
    # 13 meaningful utterances: periodic runs (when 6 had arrived since the last one) + one final run
    assert len(fake_agents["consolidate"]) >= 2 and fake_agents["consolidate"][-1] == 13
    assert fake_agents["order"][-2:] == [("consolidator", 13), ("analyst", 13)]  # final cleanup before final analysis
    acts = [e["item"] for e in s.timeline if e["type"] == "activity" and e["item"]["agent"] == "consolidator"]
    first = acts[0]
    assert [o["op"] for o in first["ops"]] == ["remove_node", "connect"]
    assert first["ops"][1]["src"] == first["utts"][0] and first["ops"][1]["status"] == "ghost"   # src repaired
    errors = [r["error"] for r in first["rejected"]]
    assert errors[:3] == ["undo: not allowed for the consolidator", "new_board: not allowed for the consolidator",
                          "mark: the consolidator never opens or closes disputes"]
    assert "disputed/resolved" in errors[3] and errors[4] == "remove_node: no node 'gone'"
    assert first["latency_ms"] == 7 and first["tokens"] == [10, 2] and first["summary"] == "cleanup"
    assert any(e["type"] == "board" and e["agent"] == "consolidator" for e in s.timeline)
    nodes = s.board.boards["b"]["nodes"]
    assert "n_u01" not in nodes and nodes["n_u05"]["status"] == "disputed" and "x" not in s.board.boards
    saved = json.loads((session_mod.RUNS_DIR / s.run_file).read_text())
    assert saved["meta"]["consolidator"]["every"] == 6 and saved["meta"]["latency"]["consolidator"]["calls"] == len(acts)


def test_consolidator_disabled_with_zero(fake_agents, monkeypatch):
    monkeypatch.setattr(session_mod, "CONSOLIDATE_EVERY", 0)

    async def run():
        s = Session()
        assert (await s.start("live", speed=16))["ok"]
        await wait_for(lambda: s.status == "finished")
        return s

    s = asyncio.run(run())
    assert fake_agents["consolidate"] == [] and s.consolidator_task is None
