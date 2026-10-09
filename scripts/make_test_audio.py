"""Generate the test monologue for talk-live mode with the OpenAI TTS API.

uv run python scripts/make_test_audio.py            # writes data/test_audio/coffee_monologue.wav (+ .txt)

One speaker designs a mobile-ordering flow out loud, with filler words, a correction
("actually no, the payment goes through Stripe"), a retraction ("scratch that, forget the SMS"),
a long rambling utterance and an open question. Segments are joined with short silences,
like the pauses a person makes while thinking, so server-side VAD can split them.
"""

from __future__ import annotations

import argparse
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

from openai import OpenAI  # noqa: E402

RATE = 24000
SEGMENTS = [
    "Okay, so, um, let me sketch out how the mobile ordering for our coffee shop should work.",
    "So the customer opens the app, they pick their drinks, and then they, uh, they go to checkout.",
    "At checkout, the app sends the payment straight to the bank.",
    "Actually, no, wait, that's wrong. The payment goes through Stripe first, and Stripe talks to the bank. We never call the bank directly.",
    "Once the payment is confirmed, the order goes to the order service, and the order service, you know, it pushes the order to the barista tablet behind the counter.",
    "And then we text the customer an SMS when the drink is ready.",
    "Hmm. Scratch that, forget the SMS.",
    "We'll just send a push notification through the app instead. That's, like, way cheaper.",
    "And the order service should also store every order in an orders database, so that, um, later on the manager can see "
    "a daily sales report, which, I mean, it doesn't have to be fancy, just the totals per day and maybe the most popular drinks, "
    "that kind of thing.",
    "Okay, I think that's the basic flow. Oh, one open question: what happens if the barista runs out of oat milk? I don't know yet.",
]
PAUSES = [1.2, 1.0, 1.4, 1.1, 1.2, 1.5, 1.0, 1.3, 1.4, 0]   # seconds of silence after each segment
INSTRUCTIONS = ("Speak like an engineer thinking out loud at a whiteboard: relaxed, natural pace, "
                "with real hesitation on the filler words and a self-correcting tone on 'actually, no, wait'.")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default="ash")
    ap.add_argument("--model", default="gpt-4o-mini-tts")
    ap.add_argument("--out", default=str(ROOT / "data/test_audio/coffee_monologue.wav"))
    a = ap.parse_args()
    client = OpenAI()
    pcm = bytearray(b"\x00\x00" * int(RATE * 0.8))  # lead-in silence
    for text, pause in zip(SEGMENTS, PAUSES):
        resp = client.audio.speech.create(model=a.model, voice=a.voice, input=text,
                                          instructions=INSTRUCTIONS, response_format="pcm")
        pcm += resp.content                              # raw PCM16 mono 24 kHz
        pcm += b"\x00\x00" * int(RATE * pause)
        print(f"{len(resp.content) / 2 / RATE:5.1f}s  {text[:70]}")
    pcm += b"\x00\x00" * int(RATE * 1.5)
    out = Path(a.out)
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(pcm))
    out.with_suffix(".txt").write_text("\n".join(SEGMENTS) + "\n")
    print(f"wrote {out} ({len(pcm) / 2 / RATE:.1f}s)")


if __name__ == "__main__":
    main()
