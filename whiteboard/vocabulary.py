"""Custom vocabulary: product names that speech-to-text mishears ("Geoff classifier" for JEV classifier, "cloud code"
for Claude Code). Teams captions take no custom vocabulary, so the fix is on our side, from one file:
data/vocabulary.json (or the file in LW_VOCABULARY) maps the correct spelling to its misheard variants.

- `fix(text)` replaces every variant in a transcript text (case-insensitive, whole words, longest variant first, any
  whitespace or a hyphen between its words). Session.emit() applies it to the transcript text the viewers see, and
  Session.submit_utterance() to the text the agents get, for every source (scripted, talk live, Teams).
- `glossary()` is the KNOWN TERMS section the modeller, consolidator and extractor prompts get, so a variant the text
  fix misses (a phrase split over two Teams chunks, a new mishearing) still ends up spelled right on the board.

A missing or empty file is a no-op. Loaded once at import.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

log = logging.getLogger("vocabulary")

DEFAULT_PATH = Path(__file__).resolve().parents[1] / "data" / "vocabulary.json"


class Vocabulary:
    def __init__(self, terms: dict[str, list[str]] | None = None) -> None:
        # correct term -> variants; keys starting with "_" are comments
        self.terms = {k.strip(): [v.strip() for v in vs if isinstance(v, str) and v.strip()]
                      for k, vs in (terms or {}).items()
                      if isinstance(k, str) and k.strip() and not k.startswith("_") and isinstance(vs, list)}
        self.lookup: dict[str, str] = {}             # normalized variant -> correct term
        for term, variants in self.terms.items():
            for v in variants:
                self.lookup.setdefault(_key(v), term)
        alts = [r"[\s-]+".join(re.escape(w) for w in v.split()) for v in sorted(self.lookup, key=len, reverse=True)]
        self.pattern = re.compile(r"(?<!\w)(?:" + "|".join(alts) + r")(?!\w)", re.IGNORECASE) if alts else None

    def fix(self, text: str) -> str:
        if not self.pattern or not text:
            return text
        return self.pattern.sub(lambda m: self.lookup.get(_key(m.group(0)), m.group(0)), text)

    def glossary(self) -> str:
        """The KNOWN TERMS prompt section, or "" when there are no terms."""
        if not self.terms:
            return ""
        lines = []
        for term, variants in self.terms.items():
            heard = ", ".join('"' + v + '"' for v in variants if _key(v) != _key(term))
            lines.append(f"- {term}" + (f" (may be heard as {heard})" if heard else ""))
        return ("KNOWN TERMS (names speech-to-text often mishears; always write them with this exact spelling in labels, "
                "notes and claims, also when the transcript has a misheard form):\n" + "\n".join(lines))


def _key(phrase: str) -> str:
    return " ".join(phrase.replace("-", " ").split()).casefold()


def load(path: Path | str | None = None) -> Vocabulary:
    """The vocabulary in `path`, else LW_VOCABULARY, else data/vocabulary.json. Missing or broken file: empty."""
    path = Path(path or os.getenv("LW_VOCABULARY", "").strip() or DEFAULT_PATH)
    if not path.exists():
        return Vocabulary()
    try:
        data = json.loads(path.read_text())
        return Vocabulary(data if isinstance(data, dict) else {})
    except (OSError, ValueError) as exc:
        log.warning("vocabulary %s not loaded: %s", path, exc)
        return Vocabulary()


VOCAB = load()


def fix(text: str) -> str:
    return VOCAB.fix(text)


def glossary() -> str:
    return VOCAB.glossary()


def prompt_section() -> str:
    """The glossary as an extra prompt section ("\\n\\n" + glossary), "" when empty. A format() value, so its
    braces are never parsed."""
    g = glossary()
    return f"\n\n{g}" if g else ""
