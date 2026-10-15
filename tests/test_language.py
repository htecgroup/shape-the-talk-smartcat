"""Meeting language (English or Serbian): transcription settings, Latin script, ids, fillers, the agents' note."""

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from test_attendee import BOT, teams, transcript  # noqa: E402,F401
from test_sources import FakeWS, fake_pipeline, wait_for  # noqa: E402,F401
from whiteboard import agents, attendee, export, language  # noqa: E402
from whiteboard.agents import CallResult, modeller  # noqa: E402
from whiteboard.board import slug  # noqa: E402
from whiteboard.session import Session  # noqa: E402
from whiteboard.sources import is_meaningless, mic_meeting, stt_prompt  # noqa: E402
from whiteboard.stt import RealtimeTranscriber, session_config  # noqa: E402

MEETING = {"title": "T", "topic": "orders", "participants": [{"name": "Ana", "role": "PM"}]}


def test_cyrillic_becomes_latin():
    assert language.to_latin("Корисник плаћа преко џепа, љубав и њива") == "Korisnik plaća preko džepa, ljubav i njiva"
    assert language.to_latin("Љубиша, ЉУБИША, Џон") == "Ljubiša, LJUBIŠA, Džon"
    assert language.to_latin("Kafka i API, 3 сервиса") == "Kafka i API, 3 servisa"     # Latin and digits stay


def test_normalize_only_for_serbian():
    assert language.normalize("Сервис шаље поруку", "sr") == "Servis šalje poruku"
    assert language.normalize("Сервис", "en") == "Сервис"
    assert language.normalize("", "sr") == ""


def test_choose_falls_back_to_the_default():
    assert language.choose("SR") == "sr" and language.choose("de") == language.DEFAULT
    assert language.choose(None) == language.DEFAULT
    assert {lang["code"] for lang in language.public()} == {"en", "sr"}


def test_ids_and_file_names_fold_serbian_letters():
    assert slug("Plaćanje karticom") == "placanje_karticom"
    assert slug("Ђак џеп") == "djak_dzep"
    assert slug("Корпа") == "korpa"                     # was "" (an empty id, rejected)
    assert export.slug("Sastanak: plaćanje") == "sastanak-placanje"


def test_serbian_fillers_are_meaningless():
    assert is_meaningless("Ovaj...") and is_meaningless("Znači.") and is_meaningless("Овај")
    assert not is_meaningless("Ovaj servis šalje poruku")


def test_stt_settings_follow_the_meeting_language():
    inp = session_config("gpt-live-transcribe", "local", language="sr")["session"]["audio"]["input"]
    assert inp["transcription"]["language"] == "sr"
    assert "language" not in session_config("gpt-live-transcribe", "local", language=None)["session"]["audio"]["input"]["transcription"]
    assert stt_prompt("naručivanje", "sr") == "Razgovor na srpskom o dizajnu sistema. Tema: naručivanje"
    assert stt_prompt(None, "en") is None


def test_mic_meeting_carries_its_language(fake_pipeline):
    assert mic_meeting("Ana", None, "sr")["language"] == "sr"

    async def run():
        s = Session()
        assert (await s.start("mic", speaker="Ana", lang="sr"))["ok"]
        assert s.meeting["language"] == "sr" and s.snapshot()["meeting"]["language"] == "sr"
        tr = s.source.factory(lambda ev: None)
        assert isinstance(tr, RealtimeTranscriber) and tr.language == "sr" and tr.prompt.startswith("Razgovor")
        await s.reset()
        snap = s.snapshot()
        assert snap["default_language"] == language.DEFAULT and len(snap["languages"]) == 2

    asyncio.run(run())


def test_agents_get_the_language_note_for_serbian_only(monkeypatch):
    systems = []

    async def call_json(name, system, user, *a, **k):
        systems.append(system)
        return CallResult({"summary": "", "ops": []}, 1)

    monkeypatch.setattr(modeller, "call_json", call_json)
    asyncio.run(modeller.model({**MEETING, "language": "sr"}, {"boards": []}, [], []))
    asyncio.run(modeller.model({**MEETING, "language": "en"}, {"boards": []}, [], []))
    assert "LANGUAGE: this meeting is held in Serbian" in systems[0] and "write everything you output in English" in systems[0]
    assert "LANGUAGE:" not in systems[1]
    state, _ = agents.build_jev_request({**MEETING, "language": "sr"}, [], {"id": "u1", "speaker": "Ana", "text": "x"})
    assert state["language_note"].startswith("this meeting is held in Serbian")
    assert "language_note" not in agents.build_jev_request(MEETING, [], {"id": "u1", "speaker": "Ana", "text": "x"})[0]


def test_serbian_teams_meeting_sets_the_captions_language(teams):
    async def run():
        s = Session()
        res = await s.start("teams", meeting_url="https://teams.microsoft.com/l/meetup-join/x", lang="sr")
        assert res["ok"], res
        await wait_for(lambda: s.source.bot_id == BOT)
        _, body = teams["http"].calls[0]
        assert body["transcription_settings"] == {"meeting_closed_captions": {
            "teams_language": "sr-rs", "teams_language_enforcement_duration_seconds": attendee.CAPTIONS_LANGUAGE_HOLD_S}}
        assert s.snapshot()["bot"]["language"] == "sr"
        await s.source.close()

    asyncio.run(run())


def test_openai_transcription_in_attendee_gets_the_language(teams, monkeypatch):
    monkeypatch.setattr(attendee, "TRANSCRIPTION", "openai")

    async def run():
        s = Session()
        await s.start("teams", meeting_url="https://teams.microsoft.com/l/meetup-join/x", lang="sr")
        await wait_for(lambda: s.source.bot_id == BOT)
        assert teams["http"].calls[0][1]["transcription_settings"] == {"openai": {"model": "gpt-4o-transcribe", "language": "sr"}}
        await s.source.close()

    asyncio.run(run())


def test_cyrillic_captions_reach_viewers_and_agents_in_latin(teams):
    async def run():
        s = Session()
        await s.start("teams", meeting_url="https://teams.microsoft.com/l/meetup-join/x", lang="sr")
        src = s.source
        await wait_for(lambda: src.bot_id == BOT)
        ws = FakeWS()
        s.clients.add(ws)
        await src.handle_webhook(transcript("Ana", "Корисник плаћа картицом.", 1000, "k1"))
        await wait_for(lambda: teams["extract"])
        assert teams["extract"] == ["Korisnik plaća karticom."]
        assert [u["text"] for u in s.view_transcript] == ["Korisnik plaća karticom."]
        shown = [e for e in ws.events if e["type"] == "utterance_start"]
        assert shown[0]["utt"]["text"] == "Korisnik plaća karticom."
        await src.close()

    asyncio.run(run())


def test_english_meeting_is_unchanged(teams):
    async def run():
        s = Session()
        await s.start("teams", meeting_url="https://teams.microsoft.com/l/meetup-join/x", lang="en")
        await wait_for(lambda: s.source.bot_id == BOT)
        assert teams["http"].calls[0][1]["transcription_settings"] == {"meeting_closed_captions": {}}
        await s.source.close()

    asyncio.run(run())


def test_meetings_without_a_language_are_english(monkeypatch, tmp_path):
    monkeypatch.setattr(language, "DEFAULT", "sr")          # even when new meetings start in Serbian
    from whiteboard import session as session_mod
    assert session_mod.load_meeting()["language"] == "en"
    f = tmp_path / "meeting_x.json"
    f.write_text('{"title": "X", "topic": "t", "participants": [], "utterances": [], "language": "sr"}')
    assert session_mod.load_meeting(f)["language"] == "sr"
