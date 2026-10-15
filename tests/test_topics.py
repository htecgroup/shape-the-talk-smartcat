"""New tabs for new topics: the board-aware topic-shift question, the possible-shift band, a shift heard in small
talk carried to the next utterance, and the New tab button (agents faked, no API calls)."""

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from whiteboard import agents  # noqa: E402
from whiteboard.agents import CallResult  # noqa: E402
from whiteboard.agents.extractor_jev import board_line  # noqa: E402
from whiteboard.board import BRIEF_NODES, BoardState  # noqa: E402
from whiteboard.session import Session  # noqa: E402

MEETING = {"title": "T", "topic": "Order flow", "participants": [{"name": "Ana", "role": "PO"}]}
UTT = {"id": "u03", "speaker": "Ana", "text": "Now the release plan."}
BY = {f"u{i:02d}": "Ana" for i in range(1, 20)}


def board_with(n_nodes: int, extra_board: bool = False) -> BoardState:
    b = BoardState()
    ops = [{"op": "new_board", "id": "flow", "title": "Order flow", "kind": "process", "src": "u01"}]
    ops += [{"op": "add_node", "id": f"n{i}", "label": f"Step {i}", "type": "step", "src": "u01"} for i in range(n_nodes)]
    if extra_board:
        ops = [{"op": "new_board", "id": "systems", "title": "System map", "kind": "architecture", "src": "u01"}] + ops
    assert not b.apply_ops(ops, by_lookup=BY)["rejected"]
    return b


def ex(**flags) -> dict:
    return {"kind": "new_info", "claims": ["x"], "refers_to": None, "topic_shift": False, **flags}


# ------------------------------------------------------------------ the extractor sees the board
def test_brief_has_the_active_board_and_the_other_titles():
    assert BoardState().brief() == {"current": None, "others": []}
    b = board_with(BRIEF_NODES + 5, extra_board=True)
    brief = b.brief()
    assert brief["current"]["title"] == "Order flow" and brief["current"]["kind"] == "process"
    assert len(brief["current"]["nodes"]) == BRIEF_NODES and brief["current"]["nodes"][-1] == f"Step {BRIEF_NODES + 4}"
    assert brief["others"] == ["System map"]
    assert board_line(brief["current"]).startswith("Order flow (process): Step 5, Step 6")
    assert board_line(None) == "none yet"


def test_jev_and_claude_extractors_get_the_board():
    brief = board_with(2, extra_board=True).brief()
    state, _ = agents.build_jev_request(MEETING, [], UTT, brief)
    assert state["current_board"] == "Order flow (process): Step 0, Step 1"
    assert state["other_boards"] == ["System map"]
    state, _ = agents.build_jev_request(MEETING, [], UTT)
    assert state["current_board"] == "none yet" and state["other_boards"] == ["none"]
    user = agents.build_extractor_user([], UTT, brief)
    assert "Current board: Order flow (process): Step 0, Step 1" in user and "Other boards: System map" in user


def test_jev_topic_shift_bands():
    shift = lambda p: {k: v for k, v in agents.jev_to_extraction(UTT, "new_info", None, p).items()  # noqa: E731
                       if k in ("topic_shift", "possible_shift")}
    assert shift(0.8) == {"topic_shift": True, "possible_shift": False}
    assert shift(0.5) == {"topic_shift": False, "possible_shift": True}
    assert shift(0.2) == {"topic_shift": False, "possible_shift": False}


def test_modeller_sees_the_strongest_flag():
    items = [{"utt": {"id": "u01", "speaker": "Ana", "text": "a"}, "extraction": ex(topic_shift=True, possible_shift=True)},
             {"utt": {"id": "u02", "speaker": "Ana", "text": "b"}, "extraction": ex(possible_shift=True)},
             {"utt": {"id": "u03", "speaker": "Ana", "text": "c"}, "extraction": ex(topic_shift=True, new_tab_requested=True)},
             {"utt": {"id": "u04", "speaker": "Ana", "text": "d"}, "extraction": ex()}]
    lines = [ln for ln in agents.build_modeller_user({"boards": []}, [], items).splitlines() if "extractor:" in ln]
    assert lines[0].endswith(" TOPIC_SHIFT | claims: x") and "POSSIBLE" not in lines[0]
    assert "POSSIBLE_TOPIC_SHIFT" in lines[1]
    assert "NEW_TAB_REQUESTED" in lines[2] and " TOPIC_SHIFT" not in lines[2]
    assert "SHIFT" not in lines[3] and "NEW_TAB" not in lines[3]


# --------------------------------------------------------------------------- the server's guard
def guard(board: BoardState, extraction: dict) -> list:
    s = Session()
    s.board = board
    items = [{"utt": {"id": "u05"}, "extraction": extraction}]
    kept, rejected = s._modeller_guard([{"op": "new_board", "id": "release", "title": "Release", "src": "u05"}], items)
    return [r["error"] for r in rejected]


def test_new_board_needs_a_shift_and_a_possible_one_a_board_worth_leaving():
    assert guard(board_with(1), ex()) == ["new_board: no topic shift detected in this batch"]
    assert guard(board_with(1), ex(topic_shift=True)) == []
    assert guard(board_with(2), ex(possible_shift=True)) == ["new_board: the current board is still small"]
    assert guard(board_with(3), ex(possible_shift=True)) == []
    assert guard(board_with(1), ex(new_tab_requested=True)) == []
    assert guard(BoardState(), ex()) == []                       # the first board needs no shift


# --------------------------------------------------- a shift heard in small talk is not lost
def test_shift_in_small_talk_is_carried_to_the_next_utterance_with_content():
    async def run():
        s = Session()
        loop = asyncio.get_running_loop()

        n = iter(range(1, 99))

        def queue(*extractions):
            for e in extractions:
                fut = loop.create_future()
                fut.set_result(e)
                s.pending.append(({"id": f"u{next(n):02d}", "speaker": "Ana", "text": "t"}, fut))

        chit = lambda **f: {**ex(**f), "kind": "chit_chat", "claims": []}  # noqa: E731
        queue(chit(possible_shift=True), chit(topic_shift=True), chit(), ex())
        first = s._next_batch()
        queue(chit(topic_shift=True))
        only_chit = s._next_batch()
        queue(ex(possible_shift=True))
        second = s._next_batch()
        queue(ex())
        third = s._next_batch()
        return first, only_chit, second, third, s

    first, only_chit, second, third, s = asyncio.run(run())
    assert len(first) == 1 and first[0]["extraction"]["topic_shift"] and first[0]["extraction"]["shift_carried"]
    assert only_chit == [] and s.carried_shift is None
    assert second[0]["extraction"]["topic_shift"] is True        # a stronger carried flag wins
    assert not third[0]["extraction"].get("topic_shift")          # used once


# ------------------------------------------------------------------------------ the New tab button
def test_new_tab_request_opens_a_board_and_clears_itself(monkeypatch):
    calls = []

    async def model(meeting, compact, window, items):
        calls.append(items[0]["extraction"].get("new_tab_requested"))
        uid = items[0]["utt"]["id"]
        if len(calls) == 1:            # nothing to draw yet: the request waits for the next utterance
            return CallResult({"summary": "No board change", "ops": []}, 1)
        return CallResult({"summary": "s", "ops": [{"op": "add_node", "id": "deploy", "label": "Deploy",
                                                    "type": "step", "src": uid}]}, 1)
    monkeypatch.setattr(agents, "model", model)

    async def run():
        s = Session()
        sent = []

        async def emit(ev, record=True):
            sent.append(ev)
        s.emit = emit
        assert not (await s.request_new_tab(True))["ok"]             # no meeting running
        s.status, s.mode = "running", "mic"
        assert "opens by itself" in (await s.request_new_tab(True))["error"]
        s.board = board_with(2)
        assert (await s.request_new_tab(True))["ok"] and s.snapshot()["new_tab_pending"]
        for uid in ("u02", "u03"):
            s.spoken.append({"id": uid, "speaker": "Ana", "text": "t"})
            items = [{"utt": s.spoken[-1], "extraction": {**ex(), "new_tab_requested": s.new_tab_requested}}]
            await s._run_modeller(items)
        return s, sent

    s, sent = asyncio.run(run())
    assert calls == [True, True]
    assert s.board.active == "new_topic" and s.board.boards["new_topic"]["title"] == "New topic"   # opened for them
    assert "deploy" in s.board.boards["new_topic"]["nodes"]
    assert not s.new_tab_requested
    assert [e["pending"] for e in sent if e["type"] == "new_tab"] == [True, False]


def test_a_click_during_a_modeller_call_waits_for_the_next_batch(monkeypatch):
    async def run():
        s = Session()
        s.status, s.mode, s.board = "running", "mic", board_with(2)

        async def model(meeting, compact, window, items):     # the + is clicked while this call runs
            s.new_tab_requested = True
            return CallResult({"summary": "s", "ops": [{"op": "add_node", "id": "late", "label": "Late",
                                                        "type": "step", "src": items[0]["utt"]["id"]}]}, 1)
        monkeypatch.setattr(agents, "model", model)
        s.spoken.append({"id": "u02", "speaker": "Ana", "text": "t"})
        await s._run_modeller([{"utt": s.spoken[-1], "extraction": ex()}])
        return s

    s = asyncio.run(run())
    assert list(s.board.boards) == ["flow"] and "late" in s.board.boards["flow"]["nodes"]   # drawn where it belongs
    assert s.new_tab_requested                                                             # still waiting


def test_a_shift_the_modeller_drew_nothing_for_waits_for_the_next_batch(monkeypatch):
    drawn = iter([[], [{"op": "add_node", "id": "x", "label": "X", "type": "step", "src": "u03"}]])

    async def model(meeting, compact, window, items):
        return CallResult({"summary": "s", "ops": next(drawn)}, 1)
    monkeypatch.setattr(agents, "model", model)

    async def run():
        s = Session()
        s.status, s.mode, s.board = "running", "mic", board_with(3)
        for uid in ("u02", "u03"):
            s.spoken.append({"id": uid, "speaker": "Ana", "text": "t"})
        await s._run_modeller([{"utt": s.spoken[0], "extraction": ex(possible_shift=True)}])   # too vague to draw
        kept = s.carried_shift
        fut = asyncio.get_running_loop().create_future()
        fut.set_result(ex())
        s.pending.append((s.spoken[1], fut))
        items = s._next_batch()                                                                # the next one gets it
        await s._run_modeller(items)                                                           # and draws something
        return kept, items[0]["extraction"].get("possible_shift"), s.carried_shift

    assert asyncio.run(run()) == ("possible_shift", True, None)
