"""Custom vocabulary: misheard product names are fixed in the transcript and named in the agents' prompts."""

import asyncio
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from test_attendee import grow, partial, start_teams, teams, transcript  # noqa: E402,F401
from test_sources import FakeWS, fake_pipeline, wait_for  # noqa: E402,F401
from whiteboard import attendee, vocabulary  # noqa: E402
from whiteboard.agents import CallResult, modeller  # noqa: E402
from whiteboard.session import Session  # noqa: E402
from whiteboard.vocabulary import Vocabulary  # noqa: E402

TERMS = {
    "_comment": "ignored",
    "JEV classifier": ["geoff classifier", "jeff classifier", "jav classifier", "java classifier", "jev classifier"],
    "JEV": ["jav"],
    "Claude Agent SDK": ["cloud agent sdk"],
    "Claude Code": ["cloud code"],
}


@pytest.fixture
def vocab(monkeypatch):
    v = Vocabulary(TERMS)
    monkeypatch.setattr(vocabulary, "VOCAB", v)
    return v


@pytest.mark.parametrize("heard, fixed", [
    ("and Geoff Classifier or jav.", "and JEV classifier or JEV."),
    ("java classifier", "JEV classifier"),
    ("We used the Jeff  classifier, then cloud code plugin!", "We used the JEV classifier, then Claude Code plugin!"),
    ("(cloud Agent SDK)", "(Claude Agent SDK)"),
    ("Jav-classifier it is", "JEV classifier it is"),
    ("We write Java. Jeff and Geoff agreed.", "We write Java. Jeff and Geoff agreed."),     # bare names stay
    ("the cloud is down, code freeze", "the cloud is down, code freeze"),
    ("javascript and Javier", "javascript and Javier"),                                  # whole words only
    ("", ""),
])
def test_fix(vocab, heard, fixed):
    assert vocab.fix(heard) == fixed


def test_empty_vocabulary_is_a_no_op(tmp_path):
    empty = Vocabulary({})
    assert empty.fix("Geoff classifier") == "Geoff classifier" and empty.glossary() == ""
    assert vocabulary.load(tmp_path / "missing.json").fix("cloud code") == "cloud code"
    broken = tmp_path / "broken.json"
    broken.write_text("{not json")
    assert vocabulary.load(broken).terms == {}


def test_env_var_overrides_the_file(tmp_path, monkeypatch):
    path = tmp_path / "v.json"
    path.write_text(json.dumps({"Kubernetes": ["cube burnetties"]}))
    monkeypatch.setenv("LW_VOCABULARY", str(path))
    assert vocabulary.load().fix("on cube burnetties") == "on Kubernetes"


def test_shipped_vocabulary_file():
    v = vocabulary.load(vocabulary.DEFAULT_PATH)
    assert v.fix("and Geoff Classifier or jav.") == "and JEV classifier or JEV."
    assert v.fix("the java classifier, cloud code and the cloud agent SDK") == \
        "the JEV classifier, Claude Code and the Claude Agent SDK"
    assert v.fix("Java and Jeff") == "Java and Jeff"


def test_glossary_is_in_the_agent_prompts(vocab, monkeypatch):
    g = vocab.glossary()
    assert g.startswith("KNOWN TERMS")
    assert '- JEV classifier (may be heard as "geoff classifier", "jeff classifier", "jav classifier", "java classifier")' in g
    assert '- Claude Code (may be heard as "cloud code")' in g
    seen = {}

    async def fake_call(name, system, user, *a, **k):
        seen[name] = system
        return CallResult({"summary": "", "ops": []}, 1)

    monkeypatch.setattr(modeller, "call_json", fake_call)
    meeting = {"title": "T", "topic": "x", "participants": [{"name": "Ana", "role": "PM"}]}
    asyncio.run(modeller.model(meeting, {"boards": []}, [], []))
    assert g in seen["board_ops"] and "Participants:\n- Ana: PM\n\nKNOWN TERMS" in seen["board_ops"]
    from whiteboard.agents import consolidator, extractor
    monkeypatch.setattr(consolidator, "call_json", fake_call)
    monkeypatch.setattr(extractor, "call_json", fake_call)
    monkeypatch.setattr(extractor, "EXTRACTOR_BACKEND", "claude")
    asyncio.run(consolidator.consolidate(meeting, [], {"boards": []}))
    asyncio.run(extractor.extract(meeting, [], {"id": "u1", "speaker": "Ana", "text": "hi"}))
    assert g in seen["consolidation"] and g in seen["extraction"]
    monkeypatch.setattr(vocabulary, "VOCAB", Vocabulary({}))                  # no terms: no section
    asyncio.run(modeller.model(meeting, {"boards": []}, [], []))
    assert "KNOWN TERMS" not in seen["board_ops"]


def test_teams_utterances_are_fixed_on_screen_and_for_the_agents(teams, vocab, fake_pipeline, monkeypatch):
    monkeypatch.setattr(attendee, "PAUSE_S", 5)

    async def run():
        s = Session()
        viewer = FakeWS()
        s.clients.add(viewer)
        src = await start_teams(s)
        await src.handle_webhook(transcript("Maja", "We use cloud code daily.", 500, "k1"))       # no partials
        await grow(src, "Maja", "c1", ["and Geoff Classifier", "and Geoff Classifier or jav.", "and Geoff Classifier or jav. Then"])
        await src.handle_webhook(partial("Maja", "c1", 4, "and Geoff Classifier or jav. Then done.", final=True))
        await wait_for(lambda: len(fake_pipeline["extract"]) == 3)
        assert [u["text"] for u in s.spoken] == ["We use Claude Code daily.", "and JEV classifier or JEV.", "Then done."]
        assert fake_pipeline["extract"] == [u["text"] for u in s.spoken]                  # what the agents got
        shown = [e["utt"]["text"] for e in viewer.events if e["type"] == "utterance_start"]
        shown += [e["text"] for e in viewer.events if e["type"] in ("utterance_interim", "utterance_final") and "text" in e]
        assert "We use Claude Code daily." in shown and "and JEV classifier or JEV." in shown
        assert not any("Geoff" in t or "cloud code" in t for t in shown)
        assert [u["text"] for u in s.view_transcript] == [u["text"] for u in s.spoken]
        await src.close()

    asyncio.run(run())
