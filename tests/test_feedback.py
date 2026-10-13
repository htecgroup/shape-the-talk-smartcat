"""Feedback button: which form it opens (LW_FEEDBACK_URL) and that the page gets it."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from whiteboard import session  # noqa: E402
from whiteboard.session import DEFAULT_FEEDBACK_URL, Session, feedback_url  # noqa: E402


def test_feedback_url_setting():
    assert feedback_url(None) == DEFAULT_FEEDBACK_URL                     # unset: the team's form
    assert feedback_url("  https://forms.example.com/x  ") == "https://forms.example.com/x"
    assert feedback_url("") is None                                       # empty hides the button
    assert feedback_url("javascript:alert(1)") is None                    # only web links are opened
    assert DEFAULT_FEEDBACK_URL.startswith("https://forms.cloud.microsoft/")


def test_snapshot_tells_the_page_which_form_to_open(monkeypatch):
    monkeypatch.setattr(session, "FEEDBACK_URL", "https://forms.example.com/x")
    assert Session().snapshot()["feedback_url"] == "https://forms.example.com/x"
    monkeypatch.setattr(session, "FEEDBACK_URL", None)
    assert Session().snapshot()["feedback_url"] is None
