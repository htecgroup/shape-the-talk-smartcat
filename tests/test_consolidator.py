"""Consolidator: prompt/schema formatting, session trigger, op guards (agents faked, no API calls)."""

import asyncio
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from whiteboard import agents, pipeline, recording, session as session_mod  # noqa: E402
from whiteboard.agents import CallResult  # noqa: E402
from whiteboard.session import Session  # noqa: E402

MEETING = {"id": "t", "title": "T", "topic": "x", "participants": [{"name": "Ana", "role": "r", "color": "#000"}],
           "utterances": [{"id": f"u{i:02d}", "speaker": "Ana", "text": f"part {i}", "pause": 0} for i in range(1, 14)]}


def test_consolidator_prompt_formats_and_reuses_modeller_schema(monkeypatch):
    monkeypatch.setattr(agents.settings, "LAYOUT_HINTS", False)
    seen = {}

    async def fake_call(name, system, user, schema, effort, model, thinking):
        seen.update(system=system, user=user, schema=schema, effort=effort, thinking=thinking)
        return CallResult({"summary": "s", "ops": [{"op": "remove_node", "src": "u01", "id": "agent_one", "from": ""}]}, 5)

    monkeypatch.setattr(agents.consolidator, "call_json", fake_call)
    for meeting in (MEETING, {**MEETING, "source": "mic"}):
        res = asyncio.run(agents.consolidate(meeting, [{"id": "u01", "speaker": "Ana", "text": "hi"}],
                                             {"active_board": "b", "boards": []}))
        assert res.data["ops"] == [{"op": "remove_node", "src": "u01", "id": "agent_one"}]   # clean_ops applied
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

    async def consolidate(meeting, transcript, compact, layout=None):
        calls["consolidate"].append(len(transcript))
        calls.setdefault("layouts", []).append(layout)
        calls["order"].append(("consolidator", len(transcript)))
        ops = [{"op": "remove_node", "id": "n_u01", "src": "u01"},
               {"op": "connect", "from": "n_u02", "to": "n_u03", "status": "ghost", "src": "bogus"},
               {"op": "undo", "target_src": "u02", "src": "u02"},
               {"op": "new_board", "id": "x", "title": "X", "src": "u02"},
               {"op": "mark", "target": "n_u04", "status": "disputed", "src": "u02"},
               {"op": "remove_node", "id": "n_u05", "src": "u05"},
               {"op": "remove_node", "id": "gone", "src": "u02"}] if len(calls["consolidate"]) == 1 else []
        plan = {"direction": "LR", "spine": ["n_u03", "n_u02", "ghost_id"], "groups": [],
                "placements": [{"node": "n_u04", "side": "below", "anchor": "n_u02"}]}
        return CallResult({"summary": "cleanup", "ops": ops, "layout": plan}, 7, 10, 2)

    async def generate_spec(*a):
        raise AssertionError("the spec writer runs only on request")

    async def generate_summary(meeting, transcript, boards, questions, disagreements):
        calls["order"].append(("summary", len(transcript)))
        calls.setdefault("summary_in", []).append(transcript)
        return CallResult({"title": "T: meeting summary", "markdown": "## Decisions\n- Use B (Ana)"}, 3)

    async def warmup():
        return None

    for name, fn in [("extract", extract), ("model", model), ("analyse", analyse),
                     ("consolidate", consolidate), ("generate_spec", generate_spec),
                     ("generate_summary", generate_summary), ("warmup", warmup)]:
        monkeypatch.setattr(agents, name, fn)
    monkeypatch.setattr(recording, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(session_mod, "load_meeting", lambda: MEETING)
    return calls


async def wait_for(cond, timeout=10.0):
    for _ in range(int(timeout / 0.01)):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition not reached")


def test_consolidator_runs_every_n_and_at_the_end_with_guards(fake_agents, monkeypatch):
    monkeypatch.setattr(pipeline, "CONSOLIDATE_EVERY", 6)
    seeded = {}

    async def run():
        s = Session()
        orig = s._run_consolidator

        async def seeded_run(board_id=None):  # an open dispute on n_u05 that the consolidator must leave alone
            if not seeded:
                s.board.apply_ops([{"op": "mark", "target": "n_u05", "status": "disputed", "src": "u05"}],
                                  by_lookup={u["id"]: u["speaker"] for u in s.spoken})
                seeded["done"] = True
            await orig(board_id)
        s._run_consolidator = seeded_run
        assert (await s.start("live", speed=16))["ok"]
        await wait_for(lambda: s.status == "finished")
        return s

    s = asyncio.run(run())
    # 13 meaningful utterances: periodic runs (when 6 had arrived since the last one) + one final run
    assert len(fake_agents["consolidate"]) >= 2 and fake_agents["consolidate"][-1] == 13
    # final cleanup, then final analysis, then the meeting summary
    assert fake_agents["order"][-3:] == [("consolidator", 13), ("analyst", 13), ("summary", 13)]
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
    saved = json.loads((recording.RUNS_DIR / s.run_file).read_text())
    assert saved["meta"]["consolidator"]["every"] == 6 and saved["meta"]["latency"]["consolidator"]["calls"] == len(acts)


def test_consolidator_disabled_with_zero(fake_agents, monkeypatch):
    monkeypatch.setattr(pipeline, "CONSOLIDATE_EVERY", 0)

    async def run():
        s = Session()
        assert (await s.start("live", speed=16))["ok"]
        await wait_for(lambda: s.status == "finished")
        return s

    s = asyncio.run(run())
    assert fake_agents["consolidate"] == [] and s.consolidator_task is None


def test_layout_plan_schema_is_flat_and_prompt_follows_the_flag(monkeypatch):
    lay = agents.CONSOLIDATOR_SCHEMA["properties"]["layout"]
    assert agents.CONSOLIDATOR_SCHEMA["properties"]["ops"] == agents.MODELLER_SCHEMA["properties"]["ops"]
    assert sorted(lay["required"]) == ["direction", "groups", "placements", "spine"]
    text = json.dumps(agents.CONSOLIDATOR_SCHEMA)
    assert "anyOf" not in text and '"null"' not in text          # the grammar compiler rejects both
    for sub in (lay, lay["properties"]["placements"]["items"], lay["properties"]["groups"]["items"]):
        assert sub["additionalProperties"] is False and sorted(sub["required"]) == sorted(sub["properties"])
    seen = {}

    async def fake_call(name, system, user, schema, effort, model, thinking):
        seen.update(system=system, user=user, schema=schema)
        return CallResult({"summary": "s", "ops": [], "layout": {"direction": "LR", "spine": ["a", "b"],
                                                                   "placements": [], "groups": []}}, 5)

    monkeypatch.setattr(agents.consolidator, "call_json", fake_call)
    utt = [{"id": "u01", "speaker": "Ana", "text": "hi"}]
    for hints in (True, False):
        monkeypatch.setattr(agents.settings, "LAYOUT_HINTS", hints)
        res = asyncio.run(agents.consolidate(MEETING, utt, {"active_board": "b", "boards": []},
                                             layout={"direction": "TB", "spine": ["x", "y"]}))
        assert (seen["schema"] is agents.CONSOLIDATOR_SCHEMA) == hints
        assert ("LAYOUT PLAN" in seen["system"]) == hints and ("CURRENT LAYOUT PLAN" in seen["user"]) == hints
        assert ('"spine": ["x", "y"]' in seen["user"]) == hints
        assert res.data["layout"]["spine"] == ["a", "b"]                                      # passed through
        assert "{" not in seen["system"].split("Participants:")[0]


def test_layout_plan_is_stored_emitted_and_recorded(fake_agents, monkeypatch):
    monkeypatch.setattr(pipeline, "CONSOLIDATE_EVERY", 6)
    monkeypatch.setattr(agents.settings, "LAYOUT_HINTS", True)

    async def run():
        s = Session()
        assert (await s.start("live", speed=16))["ok"]
        await wait_for(lambda: s.status == "finished")
        return s

    s = asyncio.run(run())
    plan = s.board.layout_of("b")
    # validated against the board after the ops: unknown ids dropped, the placement anchors on a spine node
    assert plan == {"direction": "LR", "spine": ["n_u03", "n_u02"], "groups": [],
                    "placements": [{"node": "n_u04", "side": "below", "anchor": "n_u02"}]}
    assert fake_agents["layouts"][0] is None and fake_agents["layouts"][-1] == plan   # the next pass sees the plan
    boards = [e for e in s.timeline if e["type"] == "board" and e["agent"] == "consolidator"]
    assert [e["layout"]["spine"] for e in boards if "layout" in e] == [["n_u03", "n_u02"]]   # sent once, when it changed
    assert boards[0]["board"]["boards"][0]["layout"]["spine"] == ["n_u03", "n_u02"]          # and part of the board
    acts = [e["item"] for e in s.timeline if e["type"] == "activity" and e["item"]["agent"] == "consolidator"]
    assert acts[0]["layout"]["changed"] and not any(a["layout"]["changed"] for a in acts[1:])
    assert s.snapshot()["board"]["boards"][0]["layout"]["spine"] == ["n_u03", "n_u02"]
    saved = json.loads((recording.RUNS_DIR / s.run_file).read_text())
    assert saved["final_board"]["boards"][0]["layout"]["spine"] == ["n_u03", "n_u02"]
    assert saved["meta"]["consolidator"]["layout_hints"] is True

    async def replay():   # replay re-emits the recorded board events, plan included
        r = Session()
        r.clients.add(sink := _Sink())
        assert (await r.start("replay", run=s.run_file, speed=16))["ok"]
        await wait_for(lambda: r.status == "finished")
        return sink.events
    got = asyncio.run(replay())
    assert any(e["type"] == "board" and e.get("layout", {}).get("spine") == ["n_u03", "n_u02"] for e in got)


def test_layout_hints_off_stores_no_plan(fake_agents, monkeypatch):
    monkeypatch.setattr(pipeline, "CONSOLIDATE_EVERY", 6)
    monkeypatch.setattr(agents.settings, "LAYOUT_HINTS", False)

    async def run():
        s = Session()
        assert (await s.start("live", speed=16))["ok"]
        await wait_for(lambda: s.status == "finished")
        return s

    s = asyncio.run(run())
    assert s.board.layout_of("b") is None and all(x is None for x in fake_agents["layouts"])
    assert not any("layout" in e for e in s.timeline if e["type"] == "board")
    assert not any("layout" in e["item"] for e in s.timeline if e["type"] == "activity")


def test_summary_is_written_at_the_end_recorded_and_replayed(fake_agents, monkeypatch):
    async def extract(meeting, context, utt):   # small talk too: the summary reads the whole conversation
        kind = "chit_chat" if utt["id"] == "u01" else "new_info"
        return CallResult({"kind": kind, "claims": [utt["text"]], "refers_to": None, "topic_shift": False}, 1)
    monkeypatch.setattr(agents, "extract", extract)

    async def run():
        s = Session()
        assert (await s.start("live", speed=16))["ok"]
        await wait_for(lambda: s.status == "finished" and s.run_file)
        return s

    s = asyncio.run(run())
    summary = s.summary
    assert summary == {"title": "T: meeting summary", "markdown": "## Decisions\n- Use B (Ana)",
                       "filename": "t-summary.md"}                       # the agent's text as is, no diagrams
    (given,) = fake_agents["summary_in"]
    assert [u["id"] for u in given] == [f"u{i:02d}" for i in range(1, 14)]   # every finished utterance, in order
    assert given[0]["kind"] == "chit_chat" and all(u["speaker"] == "Ana" for u in given)
    events = [e for e in s.timeline if e["type"] == "summary"]
    assert len(events) == 1 and s.timeline[-1] is events[0]
    assert events[0]["t"] == s.timeline[-2]["t"]          # replay shows it right away, not after the model's latency
    assert s.snapshot()["summary"] == summary
    saved = json.loads((recording.RUNS_DIR / s.run_file).read_text())
    assert saved["summary"] == summary and saved["meta"]["efforts"]["summary"] == agents.SUMMARY_EFFORT

    async def replay():
        r = Session()
        r.clients.add(sink := _Sink())
        assert (await r.start("replay", run=s.run_file, speed=16))["ok"]
        await wait_for(lambda: r.status == "finished")
        return r, sink.events
    r, got = asyncio.run(replay())
    assert r.summary == summary and any(e["type"] == "summary" for e in got)
    assert fake_agents["order"].count(("summary", 13)) == 1  # the live run only; replay makes no calls


def test_no_summary_for_an_empty_meeting(fake_agents, monkeypatch):
    async def extract(meeting, context, utt):   # nothing but small talk
        return CallResult({"kind": "chit_chat", "claims": [], "refers_to": None, "topic_shift": False}, 1)
    monkeypatch.setattr(agents, "extract", extract)

    async def run():
        s = Session()
        assert (await s.start("live", speed=16))["ok"]
        await wait_for(lambda: s.status == "finished" and s.run_file)
        return s

    s = asyncio.run(run())
    assert s.summary is None and not any(o[0] == "summary" for o in fake_agents["order"])
    assert not any(e["type"] == "summary" for e in s.timeline)


class _Sink:
    def __init__(self):
        self.events = []

    async def send_text(self, data):
        self.events.append(json.loads(data))


def test_prompts_carry_the_general_modelling_rules():
    from whiteboard.agents.prompts.consolidator import CONSOLIDATOR_LAYOUT_NOTES, CONSOLIDATOR_SYSTEM
    from whiteboard.agents.prompts.modeller import MODELLER_SYSTEM
    for rule in ("subject of the meeting", "Framing and summary sentences", "runs on / uses / is powered by",
                 "in the background", "One thing, one node", "count announced without names", "add_group for X",
                 "board (tab) id"):
        assert rule in MODELLER_SYSTEM
    for rule in ("Simplify", "Attribute and technology nodes", "Same thing, different names", "Meta and framing nodes",
                 "Background components", "At most ~12 ops"):
        assert rule in CONSOLIDATOR_SYSTEM
    assert "NOT COVERED BY THE PLAN" in CONSOLIDATOR_LAYOUT_NOTES
    for text in (MODELLER_SYSTEM, CONSOLIDATOR_SYSTEM, CONSOLIDATOR_LAYOUT_NOTES):   # general, not one transcript's
        for word in ("Shape the Talk", "Jev", "Sonnet", "Board modeller", "Consolidator ("):
            assert word not in text


def test_consolidator_is_told_which_nodes_the_plan_misses(monkeypatch):
    monkeypatch.setattr(agents.settings, "LAYOUT_HINTS", True)
    compact = {"active_board": "b", "boards": [
        {"id": "a", "title": "A", "kind": "process", "nodes": ["x (X)"]},
        {"id": "b", "title": "B", "kind": "architecture", "groups": [{"id": "g", "label": "G"}], "edges": [], "nodes": [
            {"id": "mic", "label": "Mic"}, {"id": "srv", "label": "Server"}, {"id": "one", "label": "1", "group": "g"},
            {"id": "store", "label": "Store"}, {"id": "late", "label": "Late"}, {"id": "later", "label": "Later"}]}]}
    plan = {"direction": "LR", "spine": ["mic", "srv", "g"], "placements": [{"node": "store", "side": "below", "anchor": "srv"}]}
    assert agents.consolidator.uncovered(compact, plan) == ["late", "later"]
    user = agents.build_consolidator_user([{"id": "u01", "speaker": "Ana", "text": "hi"}], compact, plan)
    assert "NOT COVERED BY THE PLAN (added since): late, later" in user
    assert "NOT COVERED" not in agents.build_consolidator_user([], compact, None)       # no plan yet: nothing to extend


def test_final_pass_covers_every_changed_board_and_relayouts(fake_agents, monkeypatch):
    """A board left by a topic shift gets a cleanup pass (when it is left, and at the end if it changed again),
    ops are pinned to the board they were made for, and the meeting ends with one recorded relayout event."""
    monkeypatch.setattr(pipeline, "CONSOLIDATE_EVERY", 100)        # no periodic passes: only leave + final
    monkeypatch.setattr(agents.settings, "LAYOUT_HINTS", True)
    seen = []

    async def model(meeting, compact, window, items):
        ops = []
        for i in items:
            uid = i["utt"]["id"]
            if uid == "u01":
                ops.append({"op": "new_board", "id": "a", "title": "A", "kind": "process", "src": uid})
            if uid == "u08":
                ops.append({"op": "new_board", "id": "b", "title": "B", "kind": "architecture", "src": uid})
            ops.append({"op": "add_node", "id": f"n_{uid}", "label": "x", "type": "step", "src": uid})
        return CallResult({"summary": "ok", "ops": ops}, 1)

    async def consolidate(meeting, transcript, compact, layout=None):
        bid = compact["active_board"]
        full = next(b for b in compact["boards"] if b["id"] == bid)
        seen.append((bid, len(transcript), isinstance(full["nodes"][0], dict)))
        first = full["nodes"][0]["id"]
        return CallResult({"summary": "s", "ops": [{"op": "update_node", "id": first, "note": f"seen {bid}", "src": "u01"}],
                           "layout": {"direction": "LR", "spine": [n["id"] for n in full["nodes"][:2]],
                                      "placements": [], "groups": []}}, 3)

    async def extract(meeting, context, utt):   # u08 switches to a new diagram
        return CallResult({"kind": "new_info", "claims": [utt["text"]], "refers_to": None,
                           "topic_shift": utt["id"] == "u08"}, 1)

    monkeypatch.setattr(agents, "extract", extract)
    monkeypatch.setattr(agents, "model", model)
    monkeypatch.setattr(agents, "consolidate", consolidate)

    async def run():
        s = Session()
        assert (await s.start("live", speed=16))["ok"]
        await wait_for(lambda: s.status == "finished")
        return s

    s = asyncio.run(run())
    assert seen[0][0] == "a" and seen[0][2]                        # left board "a": cleaned up, shown in full
    assert seen[-1][0] == "b" and seen[-1][1] == 13               # final pass on the active board
    assert all(bid in ("a", "b") for bid, _, _ in seen) and seen.count(("a", seen[0][1], True)) == 1
    assert s.board.active == "b"
    assert s.board.boards["a"]["nodes"]["n_u01"]["note"] == "seen a"   # pinned to "a" although "b" was active
    assert s.board.layout_of("a")["spine"] and s.board.layout_of("b")["spine"]
    kinds = [e["type"] for e in s.timeline]
    relayout = [e for e in s.timeline if e["type"] == "relayout"]
    assert len(relayout) == 1 and relayout[0]["boards"] == ["a", "b"]
    last_cons = max(i for i, e in enumerate(s.timeline) if e["type"] == "activity" and e["item"]["agent"] == "consolidator")
    assert kinds.index("relayout") > last_cons                      # after the final cleanup
    saved = json.loads((recording.RUNS_DIR / s.run_file).read_text())
    assert any(e["type"] == "relayout" for e in saved["events"])

    async def replay():   # replay re-emits it, so the browser re-lays out there too
        r = Session()
        r.clients.add(sink := _Sink())
        assert (await r.start("replay", run=s.run_file, speed=16))["ok"]
        await wait_for(lambda: r.status == "finished")
        return sink.events
    assert any(e["type"] == "relayout" and e["boards"] == ["a", "b"] for e in asyncio.run(replay()))
