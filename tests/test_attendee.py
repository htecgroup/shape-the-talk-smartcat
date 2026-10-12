"""Teams meeting source: Attendee webhooks become speaker-labelled utterances (no network; Attendee is faked)."""

import asyncio
import base64
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from test_sources import FakeWS, fake_pipeline, wait_for  # noqa: E402,F401
from whiteboard import attendee, recording  # noqa: E402
from whiteboard.attendee import AttendeeSource, aligned_end, next_cut, sign_payload, verify_signature  # noqa: E402
from whiteboard.session import Session  # noqa: E402

SECRET = base64.b64encode(b"test-secret").decode()
BOT = "bot_abc"


class FakeResponse:
    status_code = 200
    text = ""

    def __init__(self, data):
        self._data = data

    def json(self):
        return self._data


class FakeHttp:
    def __init__(self):
        self.calls = []

    async def post(self, url, json=None):
        self.calls.append((url, json))
        return FakeResponse({"id": BOT, "state": "joining"})

    async def aclose(self):
        pass


@pytest.fixture
def teams(fake_pipeline, monkeypatch):
    monkeypatch.setattr(attendee, "API_KEY", "key")
    monkeypatch.setattr(attendee, "WEBHOOK_SECRET", SECRET)
    monkeypatch.setattr(attendee, "PUBLIC_URL", "https://wb.example.com")
    monkeypatch.setattr(attendee, "START_PAUSED", False)      # these tests listen from the start; see "start paused" below
    http = FakeHttp()
    monkeypatch.setattr(AttendeeSource, "_http", lambda self: http)
    fake_pipeline["http"] = http
    return fake_pipeline


def hook(trigger, data, key, bot=BOT):
    return {"idempotency_key": key, "bot_id": bot, "bot_metadata": None, "trigger": trigger, "data": data}


def transcript(speaker, text, ts, key, **kw):
    return hook("transcript.update", {"speaker_name": speaker, "timestamp_ms": ts, "duration_ms": 1500,
                                      "transcription": {"transcript": text}}, key, **kw)


def partial(speaker, cid, seq, text, final=False, ts=1000, key=None):
    """A transcript.partial webhook, as the patched Attendee sends one per caption change."""
    return hook("transcript.partial", {"caption_id": cid, "seq": seq, "speaker_name": speaker, "speaker_uuid": speaker.lower(),
                                       "speaker_user_uuid": None, "speaker_is_host": False, "timestamp_ms": ts,
                                       "text": text, "is_final": final}, key or f"{cid}-{seq}")


def final_update(speaker, text, ts, key):
    """The transcript.update Attendee sends for a finished caption (matches its partials by speaker uuid + timestamp)."""
    ev = transcript(speaker, text, ts, key)
    ev["data"]["speaker_uuid"] = speaker.lower()
    return ev


async def grow(src, speaker, cid, texts, ts=1000, start_seq=1):
    """Partials of one caption, each text a newer version of the running caption."""
    for i, text in enumerate(texts):
        await src.handle_webhook(partial(speaker, cid, start_seq + i, text, ts=ts))


def texts(s):
    return [u["text"] for u in s.spoken]


def state(new, key, **extra):
    return hook("bot.state_change", {"new_state": new, "old_state": "joining", "event_type": "x", **extra}, key)


async def start_teams(s: Session) -> AttendeeSource:
    res = await s.start("teams", meeting_url="https://teams.microsoft.com/l/meetup-join/x", topic="orders")
    assert res["ok"], res
    src = s.source
    await wait_for(lambda: src.bot_id == BOT)
    return src


def test_signature_verification():
    payload = {"bot_id": BOT, "data": {"text": "héllo"}, "trigger": "transcript.update"}
    sig = sign_payload(payload, SECRET)
    assert verify_signature(payload, sig, SECRET)
    assert verify_signature(dict(reversed(list(payload.items()))), sig, SECRET)     # key order does not matter
    assert not verify_signature({**payload, "bot_id": "other"}, sig, SECRET)
    assert not verify_signature(payload, sign_payload(payload, base64.b64encode(b"x").decode()), SECRET)
    assert not verify_signature(payload, None, SECRET) and not verify_signature(payload, sig, "")
    assert not verify_signature(payload, sig, "not base64!")


def test_start_needs_config_and_a_link(fake_pipeline, monkeypatch):
    monkeypatch.setattr(attendee, "API_KEY", "")
    monkeypatch.setattr(attendee, "PUBLIC_URL", "")

    async def run():
        s = Session()
        res = await s.start("teams", meeting_url="https://teams.microsoft.com/l/x")
        assert not res["ok"] and "ATTENDEE_API_KEY" in res["error"]
        assert "ATTENDEE_API_KEY" in s.snapshot()["bot"]["error"]
        monkeypatch.setattr(attendee, "API_KEY", "k")
        assert "LW_PUBLIC_URL" in (await s.start("teams", meeting_url="https://teams.microsoft.com/l/x"))["error"]
        assert not (await s.start("teams", meeting_url="nonsense"))["ok"]

    asyncio.run(run())


def test_idle_bot_status_carries_the_configured_name(fake_pipeline, monkeypatch):
    monkeypatch.setattr(attendee, "BOT_NAME", "Klaudije Antropić")
    bot = Session().snapshot()["bot"]
    assert bot["state"] == "idle" and bot["bot_name"] == "Klaudije Antropić"


def test_create_bot_request(teams, monkeypatch):
    monkeypatch.setattr(attendee, "TEAMS_LOGIN", True)

    async def run():
        s = Session()
        src = await start_teams(s)
        url, body = teams["http"].calls[0]
        assert url == "/api/v1/bots" and body["meeting_url"].startswith("https://teams.microsoft.com")
        assert body["bot_name"] == "Whiteboard"
        assert body["transcription_settings"] == {"meeting_closed_captions": {}}
        assert body["webhooks"] == [{"url": "https://wb.example.com/api/attendee/webhook",
                                     "triggers": ["transcript.update", "transcript.partial",
                                                  "participant_events.join_leave", "bot.state_change"]}]
        assert body["teams_settings"] == {"use_login": True}
        assert body["automatic_leave_settings"] == {"silence_timeout_seconds": 70 * 60}   # a paused bot hears nothing
        assert s.mode == "teams" and s.meeting["source"] == "teams" and src.state == "joining"
        assert s.snapshot()["bot"]["state"] == "joining"
        await src.close()

    asyncio.run(run())


def test_create_bot_request_with_breakout_room(teams):
    async def run():
        s = Session()
        res = await s.start("teams", meeting_url="https://teams.microsoft.com/l/meetup-join/x", breakout_room=" Room 4 ")
        assert res["ok"], res
        src = s.source
        await wait_for(lambda: src.bot_id == BOT)
        _, body = teams["http"].calls[0]
        assert body["teams_settings"] == {"breakout_room": "Room 4"}
        assert s.snapshot()["bot"]["breakout_room"] == "Room 4"
        await src.close()

    asyncio.run(run())


def test_transcript_becomes_utterance_with_speaker_and_dedupes_retries(teams):
    async def run():
        s = Session()
        viewer = FakeWS()
        s.clients.add(viewer)
        src = await start_teams(s)
        await src.handle_webhook(transcript("Maja", "Let's sketch the order flow.", 1000, "k1"))
        await src.handle_webhook(transcript("Maja", "Let's sketch the order flow.", 1000, "k1"))      # retry
        await src.handle_webhook(transcript("Stefan", "Okay.", 1500, "k2"))                           # filler
        await src.handle_webhook(transcript("Stefan", "  ", 1600, "k3"))                              # empty
        await src.handle_webhook(transcript("Lena", "Wrong bot", 1700, "k4", bot="bot_other"))        # not our bot
        await wait_for(lambda: s.spoken)
        await asyncio.sleep(0.5)
        assert s.spoken == [{"id": "t001", "speaker": "Maja", "text": "Let's sketch the order flow."}]
        final = [e for e in viewer.events if e["type"] == "utterance_final"]
        assert [e["id"] for e in final] == ["t001"]
        assert not any(e["type"] == "utterance_interim" for e in viewer.events)
        await wait_for(lambda: "n_t001" in s.board.boards.get(s.board.active, {}).get("nodes", {}))
        assert s.board.boards[s.board.active]["nodes"]["n_t001"]["by"] == "Maja"
        await src.close()

    asyncio.run(run())


def test_utterances_go_out_at_once_in_arrival_order(teams):
    async def run():
        s = Session()
        src = await start_teams(s)
        await asyncio.gather(src.handle_webhook(transcript("Maja", "First thing.", 2000, "k1")),
                             src.handle_webhook(transcript("Nikola", "Second thing.", 5000, "k2")))
        assert [(u["id"], u["speaker"]) for u in s.spoken] == [("t001", "Maja"), ("t002", "Nikola")]   # no hold
        await src.close()

    asyncio.run(run())


def test_participants_are_added_with_new_colours_and_the_bot_is_ignored(teams):
    async def run():
        s = Session()
        viewer = FakeWS()
        s.clients.add(viewer)
        src = await start_teams(s)
        join = lambda name, key: hook("participant_events.join_leave", {"participant_name": name, "event_type": "join"}, key)
        await src.handle_webhook(join("Whiteboard", "j0"))              # the bot itself
        await src.handle_webhook(join("Maja", "j1"))
        await src.handle_webhook(transcript("Whiteboard", "I am the bot talking", 500, "t0"))
        await src.handle_webhook(transcript("Stefan", "A new speaker joins by speaking.", 1000, "t1"))
        await src.handle_webhook(transcript("Maja", "And Maja again.", 2000, "t2"))
        await src.handle_webhook(hook("participant_events.join_leave", {"participant_name": "Lena", "event_type": "leave"}, "j2"))
        await wait_for(lambda: len(s.spoken) == 2)
        people = s.meeting["participants"]
        assert [p["name"] for p in people] == ["Maja", "Stefan"]
        assert len({p["color"] for p in people}) == 2 and all(p["color"].startswith("#") for p in people)
        meetings = [e for e in viewer.events if e["type"] == "meeting"]
        assert [p["name"] for p in meetings[-1]["meeting"]["participants"]] == ["Maja", "Stefan"]
        assert [u["speaker"] for u in s.spoken] == ["Stefan", "Maja"]
        from whiteboard.agents.context import participants
        assert "- Stefan: Meeting participant" in participants(s.meeting)      # the agents' prompts see them
        await src.close()

    asyncio.run(run())


def test_bot_state_is_shown_and_ended_bot_ends_the_meeting(teams):
    async def run():
        s = Session()
        viewer = FakeWS()
        s.clients.add(viewer)
        src = await start_teams(s)
        await src.handle_webhook(state("waiting_room", "s1"))
        assert s.snapshot()["bot"]["state"] == "waiting_room"
        await src.handle_webhook(state("joined_recording", "s2"))
        assert src.state == "in_meeting"
        await src.handle_webhook(transcript("Maja", "The customer opens the app.", 1000, "t1"))
        await wait_for(lambda: s.spoken)
        await src.handle_webhook(state("post_processing", "s3", event_type="meeting_ended"))
        await wait_for(lambda: s.status == "finished")
        assert src.state == "ended"
        assert [e["state"] for e in viewer.events if e["type"] == "bot_state"][-3:] == ["waiting_room", "in_meeting", "ended"]
        assert any(e["type"] == "relayout" for e in s.timeline)               # normal end-of-meeting flow
        assert not any(t["type"] == "bot_state" for t in s.timeline)           # UI-only, not recorded
        await src.handle_webhook(transcript("Maja", "Too late", 9000, "t9"))   # after the end: ignored
        assert len(s.spoken) == 1
        return s.run_file

    run_file = asyncio.run(run())
    saved = json.loads((recording.RUNS_DIR / run_file).read_text())
    assert saved["meta"]["source"] == "teams" and saved["meta"]["complete"]
    assert [p["name"] for p in saved["meeting"]["participants"]] == ["Maja"]


def test_fatal_error_is_reported(teams):
    async def run():
        s = Session()
        src = await start_teams(s)
        await src.handle_webhook(state("fatal_error", "s1", event_sub_type="meeting_not_found"))
        await wait_for(lambda: s.status == "finished")
        assert src.state == "error" and "meeting_not_found" in src.error

    asyncio.run(run())


def test_stop_makes_the_bot_leave_then_finishes(teams, monkeypatch):
    monkeypatch.setattr(attendee, "LEAVE_TIMEOUT_S", 0.3)

    async def run():
        s = Session()
        src = await start_teams(s)
        await src.handle_webhook(transcript("Maja", "The customer opens the app.", 1000, "t1"))
        await s.stop_meeting()
        await wait_for(lambda: s.status == "finished")
        assert teams["http"].calls[-1][0] == f"/api/v1/bots/{BOT}/leave"
        assert [u["id"] for u in s.spoken] == ["t001"]
        assert src.state == "ended"

    asyncio.run(run())


def test_pause_and_resume_listening(teams):
    class PauseHttp(FakeHttp):
        async def post(self, url, json=None):
            self.calls.append((url, json))
            states = {"/pause_recording": "joined_recording_paused", "/resume_recording": "joined_recording"}
            return FakeResponse({"id": BOT, "state": next((v for k, v in states.items() if url.endswith(k)), "joining")})

    teams["http"].__class__ = PauseHttp

    async def run():
        s = Session()
        src = await start_teams(s)
        res = await s.set_listening(False)
        assert not res["ok"] and "not in the meeting" in res["error"]           # still joining: nothing to pause
        await src.handle_webhook(state("joined_recording", "s1"))
        assert (await s.set_listening(False))["ok"]
        assert teams["http"].calls[-1][0] == f"/api/v1/bots/{BOT}/pause_recording"
        assert src.state == "paused" and s.snapshot()["bot"]["state"] == "paused"
        assert (await s.set_listening(True))["ok"]
        assert teams["http"].calls[-1][0] == f"/api/v1/bots/{BOT}/resume_recording"
        assert src.state == "in_meeting"
        await src.handle_webhook(state("joined_recording_paused", "s2"))     # paused from elsewhere shows too
        assert src.state == "paused"
        await src.close()

    asyncio.run(run())


def test_create_bot_failure_is_reported(teams, monkeypatch):
    class Refuse(FakeHttp):
        async def post(self, url, json=None):
            r = FakeResponse({})
            r.status_code, r.text = 401, "Invalid token"
            return r

    monkeypatch.setattr(AttendeeSource, "_http", lambda self: Refuse())

    async def run():
        s = Session()
        res = await s.start("teams", meeting_url="https://teams.microsoft.com/l/x")
        assert res["ok"]
        await wait_for(lambda: s.status == "finished")
        assert s.source.state == "error" and "401" in s.source.error

    asyncio.run(run())


def test_recorded_meeting_events_keep_the_participants_of_their_moment(teams):
    """Replay shows people as they joined: each recorded meeting event holds its own copy of the list."""
    async def run():
        s = Session()
        src = await start_teams(s)
        join = lambda name, key: hook("participant_events.join_leave", {"participant_name": name, "event_type": "join"}, key)
        await src.handle_webhook(join("Maja", "j1"))
        await src.handle_webhook(join("Stefan", "j2"))
        counts = [len(e["meeting"]["participants"]) for e in s.timeline if e["type"] == "meeting"]
        assert counts[-2:] == [1, 2]
        await src.close()

    asyncio.run(run())


# ------------------------------------------------------------------ running captions (transcript.partial)
def test_cut_rules():
    w = "we need a way to track the order from the kitchen to the door".split()
    assert next_cut(w, 0, 5, 6) is None                               # few stable words, no sentence end: wait
    assert next_cut(w, 0, 13, 6) == 6                                 # 6 stable words go out, mid-sentence
    assert next_cut(w, 6, 13, 6) == 12                                # ... and the next 6
    w = "first the customer picks a dish, then they pay".split()
    assert next_cut(w, 0, 9, 6) == 6                                  # no preference for the clause comma
    w = "The customer pays. Then the kitchen".split()
    assert next_cut(w, 0, 0, 6) == 3                                  # a sentence end Teams moved past, before 6 words
    assert next_cut("The customer pays.".split(), 0, 2, 6) is None    # a fresh period at the very end may still change
    assert next_cut("The customer pays.".split(), 0, 3, 6) == 3       # ... unless it is stable
    assert aligned_end(["the", "customer", "pays"], "The client pays and then".split()) == 3   # revised word
    assert aligned_end(["ice", "cream"], "Ice-cream is sold".split()) == 1
    assert aligned_end([], "anything".split()) == 0
    assert aligned_end(["so", "the", "order"], "So the order. So the order goes".split()) == 3   # repeated words


def test_partials_show_live_text_and_cut_at_sentence_end(teams, monkeypatch):
    monkeypatch.setattr(attendee, "PAUSE_S", 5)

    async def run():
        s = Session()
        viewer = FakeWS()
        s.clients.add(viewer)
        src = await start_teams(s)
        await grow(src, "Maja", "c1", ["The customer", "The customer opens the app.", "The customer opens the app. Then"])
        assert texts(s) == ["The customer opens the app."]
        started = [e for e in viewer.events if e["type"] == "utterance_start"]
        assert started[0]["live"] and started[0]["utt"]["text"] == "The customer"
        interim = [e["text"] for e in viewer.events if e["type"] == "utterance_interim"]
        assert interim == ["The customer opens the app."]
        assert s.view_transcript[-1]["text"] == "Then" and not s.view_transcript[-1]["done"]     # the rest, live
        await grow(src, "Maja", "c1", ["The customer opens the app. Then she picks a dish"], start_seq=4)
        await src.handle_webhook(partial("Maja", "c1", 5, "The customer opens the app. Then she picks a dish.", final=True))
        assert texts(s) == ["The customer opens the app.", "Then she picks a dish."]
        assert [u["id"] for u in s.spoken] == ["t001", "t002"]
        assert [u["done"] for u in s.view_transcript] == [True, True]
        assert [p["name"] for p in s.meeting["participants"]] == ["Maja"]
        await src.close()

    asyncio.run(run())


def test_partials_go_out_every_chunk_of_stable_words(teams, monkeypatch):
    monkeypatch.setattr(attendee, "PAUSE_S", 5)
    assert attendee.CHUNK_WORDS == 6                                  # the default

    async def run():
        s = Session()
        src = await start_teams(s)
        words = "so the order goes from the app to the kitchen and then the courier picks it up".split()
        await grow(src, "Maja", "c1", [" ".join(words[:n]) for n in (3, 5, 7)])
        assert texts(s) == []                                         # 7 words, but only 5 of them seen twice
        await grow(src, "Maja", "c1", [" ".join(words[:9])], start_seq=4)
        assert texts(s) == ["so the order goes from the"]             # 6 stable words, cut mid-phrase
        await grow(src, "Maja", "c1", [" ".join(words[:12]), " ".join(words[:16])], start_seq=5)
        assert texts(s) == ["so the order goes from the", "app to the kitchen and then"]
        await src.handle_webhook(partial("Maja", "c1", 7, " ".join(words) + ".", final=True))
        assert texts(s)[-1] == "the courier picks it up."
        assert " ".join(texts(s)) == " ".join(words) + "."
        await src.close()

    asyncio.run(run())


def test_pause_sends_what_was_said_so_far(teams, monkeypatch):
    monkeypatch.setattr(attendee, "PAUSE_S", 0.1)

    async def run():
        s = Session()
        src = await start_teams(s)
        await grow(src, "Maja", "c0", ["Today I"])
        await asyncio.sleep(0.3)
        assert texts(s) == []                                         # too short to stand alone: wait for more
        await src.handle_webhook(partial("Maja", "c0", 2, "Today I start.", final=True))
        await grow(src, "Maja", "c1", ["The kitchen", "The kitchen gets a ticket"], ts=2000)
        assert texts(s) == ["Today I start."]
        await wait_for(lambda: texts(s) == ["Today I start.", "The kitchen gets a ticket"])
        await grow(src, "Maja", "c1", ["The kitchen gets a ticket and prints it"], start_seq=3, ts=2000)
        await src.handle_webhook(partial("Maja", "c1", 4, "The kitchen gets a ticket and prints it.", final=True, ts=2000))
        assert texts(s) == ["Today I start.", "The kitchen gets a ticket", "and prints it."]
        await asyncio.sleep(0.2)
        assert len(s.spoken) == 3                                     # the final cancelled the pause timer
        await src.close()

    asyncio.run(run())


def test_revised_words_are_corrected_on_screen_but_not_resent(teams, monkeypatch):
    monkeypatch.setattr(attendee, "PAUSE_S", 0.1)

    async def run():
        s = Session()
        viewer = FakeWS()
        s.clients.add(viewer)
        src = await start_teams(s)
        await grow(src, "Maja", "c1", ["The costumer", "The costumer pays online"])
        await wait_for(lambda: texts(s) == ["The costumer pays online"])
        await grow(src, "Maja", "c1", ["The customer pays online with a card"], start_seq=3)    # Teams fixes a sent word
        assert s.view_transcript[-1]["text"] == "with a card"          # only the new words are live
        await src.handle_webhook(partial("Maja", "c1", 4, "The customer pays online with a card.", final=True))
        assert texts(s) == ["The costumer pays online", "with a card."]   # the agents got each word once
        assert s.view_transcript[0]["text"] == "The customer pays online"  # the screen shows the final text
        assert [e.get("text") for e in viewer.events if e["type"] == "utterance_final"][-1] == "The customer pays online"
        await src.close()

    asyncio.run(run())


def test_transcript_update_of_a_streamed_caption_is_not_sent_twice(teams, monkeypatch):
    monkeypatch.setattr(attendee, "PAUSE_S", 5)

    async def run():
        s = Session()
        src = await start_teams(s)
        await grow(src, "Maja", "c1", ["Orders go", "Orders go to the kitchen."], ts=1000)
        await src.handle_webhook(partial("Maja", "c1", 3, "Orders go to the kitchen.", final=True, ts=1000))
        await src.handle_webhook(final_update("Maja", "Orders go to the kitchen.", 1000, "u1"))
        await src.handle_webhook(final_update("Maja", "Orders go to the kitchen.", 1000, "u1b"))   # a second delivery
        assert texts(s) == ["Orders go to the kitchen."]
        # final partial lost: transcript.update finishes the caption, and a late partial is ignored
        await grow(src, "Nikola", "c2", ["The courier", "The courier picks"], ts=3000)
        await src.handle_webhook(final_update("Nikola", "The courier picks it up.", 3000, "u2"))
        await src.handle_webhook(partial("Nikola", "c2", 3, "The courier picks it up.", final=True, ts=3000))
        assert texts(s) == ["Orders go to the kitchen.", "The courier picks it up."]
        # transcript.update first, its partials late: the update wins, the partials are dropped
        await src.handle_webhook(final_update("Lena", "We also need refunds.", 5000, "u3"))
        await grow(src, "Lena", "c3", ["We also", "We also need refunds."], ts=5000)
        await src.handle_webhook(partial("Lena", "c3", 3, "We also need refunds.", final=True, ts=5000))
        assert texts(s) == ["Orders go to the kitchen.", "The courier picks it up.", "We also need refunds."]
        await src.close()

    asyncio.run(run())


def test_without_partials_transcript_update_works_as_before(teams):
    async def run():
        s = Session()
        src = await start_teams(s)
        await src.handle_webhook(final_update("Maja", "First thing.", 1000, "u1"))
        await src.handle_webhook(final_update("Maja", "Second thing.", 2000, "u2"))
        assert texts(s) == ["First thing.", "Second thing."]
        await src.close()

    asyncio.run(run())


def test_two_speakers_at_once_keep_their_own_lines(teams, monkeypatch):
    monkeypatch.setattr(attendee, "PAUSE_S", 5)

    async def run():
        s = Session()
        src = await start_teams(s)
        await src.handle_webhook(partial("Maja", "m1", 1, "The menu", ts=1000))
        await src.handle_webhook(partial("Nikola", "n1", 1, "No wait", ts=1100))
        await src.handle_webhook(partial("Maja", "m1", 2, "The menu has prices", ts=1000))
        await src.handle_webhook(partial("Nikola", "n1", 2, "No wait, the cart", ts=1100))
        live = {u["speaker"]: u["text"] for u in s.view_transcript if not u["done"]}
        assert live == {"Maja": "The menu has prices", "Nikola": "No wait, the cart"}
        await src.handle_webhook(partial("Nikola", "n1", 3, "No wait, the cart has prices.", final=True, ts=1100))
        await src.handle_webhook(partial("Maja", "m1", 3, "The menu has prices.", final=True, ts=1000))
        assert [(u["speaker"], u["text"]) for u in s.spoken] == [("Nikola", "No wait, the cart has prices."),
                                                                 ("Maja", "The menu has prices.")]
        assert len({u["id"] for u in s.spoken}) == 2
        await src.close()

    asyncio.run(run())


def test_partials_retries_out_of_order_bot_and_filler(teams, monkeypatch):
    monkeypatch.setattr(attendee, "PAUSE_S", 5)

    async def run():
        s = Session()
        src = await start_teams(s)
        await src.handle_webhook(partial("Maja", "c1", 1, "Payment first.", key="p1"))
        await src.handle_webhook(partial("Maja", "c1", 2, "Payment first. Then", key="p2"))
        await src.handle_webhook(partial("Maja", "c1", 2, "Payment first. Then", key="p2"))      # retry
        await src.handle_webhook(partial("Maja", "c1", 1, "Payment", key="p1-late"))            # stale
        assert texts(s) == ["Payment first."]
        await src.handle_webhook(partial("Maja", "c1", 3, "Payment first. Then delivery.", final=True))
        await src.handle_webhook(partial("Maja", "c1", 3, "Payment first. Then delivery.", final=True, key="again"))
        assert texts(s) == ["Payment first.", "Then delivery."]
        await src.handle_webhook(partial("Whiteboard", "b1", 1, "I am the bot.", final=True))
        await src.handle_webhook(partial("Stefan", "f1", 1, "Okay.", final=True))
        await grow(src, "Stefan", "f2", ["Okay.", "Okay. So the", "Okay. So the menu"])
        await src.handle_webhook(partial("Stefan", "f2", 4, "Okay. So the menu.", final=True))
        assert texts(s) == ["Payment first.", "Then delivery.", "So the menu."]
        assert not any(u["text"].startswith("Okay") for u in s.view_transcript)            # the filler line is gone
        assert [p["name"] for p in s.meeting["participants"]] == ["Maja", "Stefan"]
        await src.close()

    asyncio.run(run())


def test_stop_sends_captions_that_are_still_running(teams, monkeypatch):
    monkeypatch.setattr(attendee, "PAUSE_S", 5)
    monkeypatch.setattr(attendee, "LEAVE_TIMEOUT_S", 0.2)

    async def run():
        s = Session()
        src = await start_teams(s)
        await grow(src, "Maja", "c1", ["One last", "One last thing about"])
        await s.stop_meeting()
        await wait_for(lambda: s.status == "finished")
        assert texts(s) == ["One last thing about"]

    asyncio.run(run())


# ------------------------------------------------------------------ start paused (LW_TEAMS_START_PAUSED)
class AttendeeHttp(FakeHttp):
    """Answers pause/resume like Attendee; `refuse_pause` pause calls are refused first (bot not recording yet)."""
    refuse_pause = 0

    async def post(self, url, json=None):
        self.calls.append((url, json))
        if url.endswith("/pause_recording"):
            if self.refuse_pause > 0:
                self.refuse_pause -= 1
                r = FakeResponse({"error": "Bot is in state joined_not_recording and cannot pause recording"})
                r.status_code = 400
                return r
            return FakeResponse({"id": BOT, "state": "joined_recording_paused"})
        if url.endswith("/resume_recording"):
            return FakeResponse({"id": BOT, "state": "joined_recording"})
        return FakeResponse({"id": BOT, "state": "joining"})


@pytest.fixture
def paused_teams(teams, monkeypatch):
    monkeypatch.setattr(attendee, "START_PAUSED", True)
    teams["http"].__class__ = AttendeeHttp
    return teams


def actions(teams):
    return [url.rsplit("/", 1)[-1] for url, _ in teams["http"].calls[1:]]     # after the create call


def test_start_paused_drops_transcripts_until_resume(paused_teams):
    paused_teams["http"].refuse_pause = 99                 # Attendee never pauses: the local gate alone holds

    async def run():
        s = Session()
        viewer = FakeWS()
        s.clients.add(viewer)
        src = await start_teams(s)
        assert src.state == "joining" and s.snapshot()["bot"]["listening"] is False     # the UI says: will start paused
        join = hook("participant_events.join_leave", {"participant_name": "Maja", "event_type": "join"}, "j1")
        await src.handle_webhook(join)                                      # joins still count
        await src.handle_webhook(state("joined_recording", "s1"))
        assert src.state == "paused" and not src.attendee_paused           # shown paused even though Attendee is not
        await src.handle_webhook(transcript("Stefan", "Can everyone hear me?", 500, "t0"))
        await src.handle_webhook(partial("Nikola", "c1", 1, "Is the bot here?", final=True))
        await asyncio.sleep(0.2)
        assert s.spoken == [] and s.view_transcript == []
        assert not any(e["type"].startswith("utterance") for e in viewer.events)
        assert [p["name"] for p in s.meeting["participants"]] == ["Maja"]   # nobody added by what they said
        assert (await s.set_listening(True))["ok"]
        assert "resume_recording" not in actions(paused_teams)             # Attendee was never paused
        assert src.state == "in_meeting" and src.listening
        await src.handle_webhook(transcript("Stefan", "Let's start with orders.", 2000, "t1"))
        await wait_for(lambda: texts(s) == ["Let's start with orders."])
        await src.close()

    asyncio.run(run())


def test_start_paused_pauses_the_bot_in_attendee_and_resume_resumes_it(paused_teams):
    async def run():
        s = Session()
        viewer = FakeWS()
        s.clients.add(viewer)
        src = await start_teams(s)
        await src.handle_webhook(state("joined_not_recording", "s0"))
        assert actions(paused_teams) == [] and src.state == "paused"
        await src.handle_webhook(state("joined_recording", "s1"))
        assert actions(paused_teams) == ["pause_recording"]
        assert src.attendee_paused and src.state == "paused" and s.snapshot()["bot"]["state"] == "paused"
        await src.handle_webhook(state("joined_recording_paused", "s2"))
        await src.handle_webhook(state("joined_recording", "s3"))      # resumed elsewhere: not paused again, the gate holds
        assert actions(paused_teams) == ["pause_recording"] and src.state == "paused"
        await src.handle_webhook(state("joined_recording_paused", "s4"))
        assert (await s.set_listening(True))["ok"]
        assert actions(paused_teams) == ["pause_recording", "resume_recording"]
        assert src.state == "in_meeting" and src.listening
        # after the first resume, Pause and Resume work as before (through Attendee)
        assert (await s.set_listening(False))["ok"] and src.state == "paused" and src.listening
        assert (await s.set_listening(True))["ok"] and src.state == "in_meeting"
        assert actions(paused_teams)[-2:] == ["pause_recording", "resume_recording"]
        assert [e["state"] for e in viewer.events if e["type"] == "bot_state"][-3:] == ["in_meeting", "paused", "in_meeting"]
        await src.close()

    asyncio.run(run())


def test_refused_auto_pause_is_retried_on_the_next_state_change(paused_teams):
    paused_teams["http"].refuse_pause = 1

    async def run():
        s = Session()
        src = await start_teams(s)
        await src.handle_webhook(state("joined_recording", "s1"))
        assert actions(paused_teams) == ["pause_recording"] and not src.attendee_paused and src.state == "paused"
        await src.handle_webhook(state("joined_not_recording", "s2"))
        await src.handle_webhook(state("joined_recording", "s3"))
        assert actions(paused_teams) == ["pause_recording", "pause_recording"] and src.attendee_paused
        await src.handle_webhook(state("joined_recording", "s4"))
        assert actions(paused_teams) == ["pause_recording", "pause_recording"]      # once it worked, never again
        await src.close()

    asyncio.run(run())


def test_auto_pause_when_the_create_response_is_already_recording(paused_teams):
    class Recording(AttendeeHttp):
        async def post(self, url, json=None):
            if url == "/api/v1/bots":
                self.calls.append((url, json))
                return FakeResponse({"id": BOT, "state": "joined_recording"})
            return await super().post(url, json)

    paused_teams["http"].__class__ = Recording

    async def run():
        s = Session()
        src = await start_teams(s)
        await wait_for(lambda: src.attendee_paused)
        assert actions(paused_teams) == ["pause_recording"] and src.state == "paused"
        await src.close()

    asyncio.run(run())


def test_caption_running_at_resume_sends_only_the_words_after_it(paused_teams, monkeypatch):
    monkeypatch.setattr(attendee, "PAUSE_S", 5)
    paused_teams["http"].refuse_pause = 99                 # local gate: the caption's partials arrive while gated

    async def run():
        s = Session()
        src = await start_teams(s)
        await src.handle_webhook(state("joined_recording", "s1"))
        await grow(src, "Maja", "c1", ["Hello is", "Hello is this thing on"])
        assert s.view_transcript == []
        assert (await s.set_listening(True))["ok"]
        await grow(src, "Maja", "c1", ["Hello is this thing on. Okay so the order", "Hello is this thing on. Okay so the order goes to the kitchen"],
                   start_seq=3)
        await src.handle_webhook(partial("Maja", "c1", 5, "Hello is this thing on. Okay so the order goes to the kitchen.", final=True))
        await src.handle_webhook(final_update("Maja", "Hello is this thing on. Okay so the order goes to the kitchen.", 1000, "u1"))
        assert " ".join(texts(s)) == "Okay so the order goes to the kitchen."
        assert not any("Hello" in u["text"] for u in s.view_transcript)
        assert [p["name"] for p in s.meeting["participants"]] == ["Maja"]
        await src.close()

    asyncio.run(run())


def test_caption_finished_while_gated_never_leaks(paused_teams):
    paused_teams["http"].refuse_pause = 99

    async def run():
        s = Session()
        src = await start_teams(s)
        await src.handle_webhook(state("joined_recording", "s1"))
        await src.handle_webhook(partial("Maja", "c1", 1, "Testing one two.", final=True, ts=1000))
        await src.handle_webhook(final_update("Nikola", "Can you see my screen?", 1500, "u0"))
        assert (await s.set_listening(True))["ok"]
        await src.handle_webhook(final_update("Maja", "Testing one two.", 1000, "u1"))          # late update
        await src.handle_webhook(partial("Nikola", "c2", 1, "Can you see my screen?", final=True, ts=1500))   # late partial
        await src.handle_webhook(final_update("Maja", "Now we begin.", 3000, "u2"))
        assert texts(s) == ["Now we begin."]
        await src.close()

    asyncio.run(run())


def test_caption_spanning_the_resume_of_a_paused_attendee_does_not_leak(paused_teams, monkeypatch):
    """Attendee drops captions while paused, so a caption running at the resume first arrives with its earlier words."""
    monkeypatch.setattr(attendee, "PAUSE_S", 5)
    monkeypatch.setattr(attendee, "RESUME_SETTLE_S", 0.3)

    async def run():
        s = Session()
        src = await start_teams(s)
        await src.handle_webhook(state("joined_recording", "s1"))
        assert src.attendee_paused
        assert (await s.set_listening(True))["ok"]
        await src.handle_webhook(partial("Maja", "c1", 1, "Before we start let me share", ts=1000))     # said while paused
        assert s.view_transcript == []
        await grow(src, "Maja", "c1", ["Before we start let me share my screen", "Before we start let me share my screen. The order"],
                   start_seq=2)
        await src.handle_webhook(partial("Maja", "c1", 4, "Before we start let me share my screen. The order flow.", final=True))
        assert " ".join(texts(s)) == "my screen. The order flow."
        await asyncio.sleep(0.35)
        await grow(src, "Nikola", "c2", ["Sounds", "Sounds good."], ts=2000)                         # after the settle time
        await src.handle_webhook(partial("Nikola", "c2", 3, "Sounds good to me.", final=True, ts=2000))
        assert texts(s)[-1] == "Sounds good to me."
        await src.close()

    asyncio.run(run())


def test_stop_while_gated_sends_nothing(paused_teams, monkeypatch):
    monkeypatch.setattr(attendee, "LEAVE_TIMEOUT_S", 0.2)

    async def run():
        s = Session()
        src = await start_teams(s)
        await src.handle_webhook(state("joined_recording", "s1"))
        await grow(src, "Maja", "c1", ["Just checking", "Just checking the sound"])
        await s.stop_meeting()
        await wait_for(lambda: s.status == "finished")
        assert s.spoken == []

    asyncio.run(run())


def test_start_paused_off_listens_from_the_start(teams):
    async def run():
        s = Session()
        src = await start_teams(s)
        assert src.listening and s.snapshot()["bot"]["listening"] is True
        await src.handle_webhook(state("joined_recording", "s1"))
        assert src.state == "in_meeting"
        assert [u for u, _ in teams["http"].calls] == ["/api/v1/bots"]             # no automatic pause
        await src.handle_webhook(transcript("Maja", "Right away.", 1000, "t1"))
        await wait_for(lambda: texts(s) == ["Right away."])
        await src.close()

    asyncio.run(run())
