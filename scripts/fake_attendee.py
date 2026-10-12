"""A fake Attendee server: try Teams mode end to end on localhost, with no Teams and no real Attendee.

It answers the two calls the app makes (POST /api/v1/bots, POST /api/v1/bots/{id}/leave) and then plays
data/meeting_freshbite.json back to the app's webhook URL, signed like Attendee signs them: bot.state_change
(joining, waiting room, joined), participant joins, one transcript.update per utterance, and at the end the
bot leaving. Leaving early (Stop in the UI) ends the replay. Extras: --shuffle sends neighbouring utterances
out of order and --retries re-sends some webhooks with the same idempotency key, as Attendee does after a timeout.
--partials plays each utterance as a running Teams caption (transcript.partial, as with
docs/attendee-teams.patch): the text grows at speaking pace, a sentence's period shows up once
the next word does, some words are first misheard and fixed a moment later, then the final caption and its
transcript.update follow about a second after the last word.

  uv run python scripts/fake_attendee.py --port 8099 --pace 2            # add --partials for running captions
  # the app, in another terminal (use the same secret in both):
  ATTENDEE_URL=http://localhost:8099 ATTENDEE_API_KEY=fake ATTENDEE_WEBHOOK_SECRET=ZmFrZS1zZWNyZXQ= \\
    LW_PUBLIC_URL=http://localhost:8011 uv run uvicorn server:app --port 8011
  # then open the app, pick "Teams meeting", paste any https link and press Join.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import httpx2  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, Header, HTTPException, Request  # noqa: E402

from whiteboard.attendee import sign_payload  # noqa: E402

DEFAULT_SECRET = "ZmFrZS1zZWNyZXQ="      # base64("fake-secret")
args: argparse.Namespace
app = FastAPI(title="Fake Attendee")
bots: dict[str, dict] = {}


def envelope(bot_id: str, trigger: str, data: dict) -> dict:
    return {"idempotency_key": str(uuid.uuid4()), "bot_id": bot_id, "bot_metadata": None, "trigger": trigger, "data": data}


async def deliver(bot: dict, trigger: str, data: dict, retry: bool = False) -> None:
    payload = envelope(bot["id"], trigger, data)
    body = json.dumps(payload, ensure_ascii=False)
    headers = {"Content-Type": "application/json", "X-Webhook-Signature": sign_payload(payload, args.secret)}
    for _ in range(2 if retry else 1):
        try:
            res = await bot["http"].post(bot["webhook"], content=body.encode(), headers=headers)
            if res.status_code != 200:
                print(f"  webhook {trigger} -> {res.status_code} {res.text[:80]}")
        except Exception as exc:
            print(f"  webhook {trigger} failed: {exc}")


async def state(bot: dict, new: str, event: str = "") -> None:
    old, bot["state"] = bot["state"], new
    await deliver(bot, "bot.state_change", {"new_state": new, "old_state": old, "event_type": event,
                                           "event_sub_type": None, "created_at": "2026-01-01T00:00:00Z"})
    print(f"bot {bot['id']}: {old} -> {new}")


async def play(bot: dict) -> None:
    meeting = json.loads(Path(args.file).read_text())
    utts = meeting["utterances"][: args.limit or None]
    try:
        await asyncio.sleep(0.5)        # let the create-bot response reach the app first
        await state(bot, "joining", "join_requested")
        await asyncio.sleep(args.lobby)
        await state(bot, "waiting_room", "bot_put_in_waiting_room")
        await asyncio.sleep(args.lobby)
        await state(bot, "joined_recording", "bot_joined_meeting")
        for i, p in enumerate(meeting["participants"] + [{"name": bot["name"]}]):   # the bot shows up as a participant too
            await deliver(bot, "participant_events.join_leave", {
                "id": f"pe_{i}", "participant_name": p["name"], "participant_uuid": f"uuid-{i}", "participant_user_uuid": None,
                "participant_is_host": i == 0, "event_type": "join", "event_data": {}, "timestamp_ms": i * 100})
        # timestamps follow the scripted pauses; sending order may be shuffled
        t_ms, events = 0, []
        for u in utts:
            t_ms += int(u.get("pause", 1.0) * 1000)
            dur = int(len(u["text"].split()) / 2.6 * 1000)
            events.append({"speaker_name": u["speaker"], "speaker_uuid": u["speaker"].lower(), "speaker_user_uuid": None,
                           "speaker_is_host": False, "timestamp_ms": t_ms, "duration_ms": dur,
                           "transcription": {"transcript": u["text"], "words": None}})
            t_ms += dur
        if args.shuffle:
            for i in range(0, len(events) - 1, 4):
                events[i], events[i + 1] = events[i + 1], events[i]
        for i, ev in enumerate(events):
            await asyncio.sleep(args.pace)
            if args.partials:
                await speak(bot, ev, i)
            await deliver(bot, "transcript.update", ev, retry=args.retries and i % 5 == 3)
        await asyncio.sleep(args.pace)
        await state(bot, "post_processing", "meeting_ended")
        await state(bot, "ended", "post_processing_completed")
    except asyncio.CancelledError:
        pass


MISHEARD = {"the": "a", "order": "older", "kitchen": "kitten", "menu": "many", "app": "up", "courier": "career"}


async def speak(bot: dict, ev: dict, n: int) -> None:
    """One utterance as Teams captions it: partials of the text so far (1-2 words at a time), then the final."""
    words, rng = ev["transcription"]["transcript"].split(), random.Random(n)
    data = {k: ev[k] for k in ("speaker_name", "speaker_uuid", "speaker_user_uuid", "speaker_is_host", "timestamp_ms")}
    data["caption_id"], seq, said, wrong = f"{ev['speaker_uuid']}:{n}", 0, 0, {}
    while said < len(words):
        step = rng.choice((1, 1, 2))
        await asyncio.sleep(step / 2.6 * rng.uniform(0.8, 1.1))   # Teams sends a partial every word or two
        said = min(len(words), said + step)
        if rng.random() < 0.15 and words[said - 1].lower() in MISHEARD:     # misheard now, fixed two partials later
            wrong[said - 1] = 2
        shown = []
        for i, w in enumerate(words[:said]):
            if wrong.get(i):
                w = MISHEARD[w.lower()]
            if i == said - 1 and w[-1] in ".?!":                             # Teams adds the period with the next word
                w = w[:-1]
            shown.append(w)
        wrong = {i: k - 1 for i, k in wrong.items() if k > 1}
        seq += 1
        await deliver(bot, "transcript.partial", {**data, "seq": seq, "text": " ".join(shown), "is_final": False})
    await asyncio.sleep(1.0)
    await deliver(bot, "transcript.partial", {**data, "seq": seq + 1, "text": " ".join(words), "is_final": True})
    await asyncio.sleep(0.15)


@app.post("/api/v1/bots")
async def create_bot(request: Request, authorization: str = Header(default="")) -> dict:
    if not authorization.startswith("Token ") or len(authorization) < 7:
        raise HTTPException(401, "bad Authorization header")
    body = await request.json()
    hooks = body.get("webhooks") or []
    if not body.get("meeting_url") or not hooks:
        raise HTTPException(400, "meeting_url and a webhook are required")
    bot_id = f"bot_{uuid.uuid4().hex[:12]}"
    bot = {"id": bot_id, "name": body.get("bot_name", "Bot"), "state": "ready", "webhook": hooks[0]["url"],
           "http": httpx2.AsyncClient(timeout=10)}
    bots[bot_id] = bot
    print(f"create bot {bot_id}: {body['meeting_url']} -> {bot['webhook']} transcription={list(body.get('transcription_settings', {}))}")
    bot["task"] = asyncio.create_task(play(bot))
    return {"id": bot_id, "meeting_url": body["meeting_url"], "state": "joining", "transcription_state": "not_started"}


@app.post("/api/v1/bots/{bot_id}/leave")
async def leave_bot(bot_id: str) -> dict:
    bot = bots.get(bot_id)
    if bot is None:
        raise HTTPException(404, "no such bot")
    bot["task"].cancel()
    await state(bot, "leaving", "leave_requested")
    await state(bot, "post_processing", "bot_left_meeting")
    await state(bot, "ended", "post_processing_completed")
    return {"id": bot_id, "state": "leaving"}


def main() -> None:
    global args
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--pace", type=float, default=2.0, help="seconds between utterances")
    ap.add_argument("--lobby", type=float, default=2.0, help="seconds in each of the joining and lobby states")
    ap.add_argument("--file", default=str(ROOT / "data" / "meeting_freshbite.json"))
    ap.add_argument("--limit", type=int, default=0, help="only the first N utterances")
    ap.add_argument("--shuffle", action="store_true", help="send some neighbouring utterances out of order")
    ap.add_argument("--retries", action="store_true", help="send some webhooks twice (same idempotency key)")
    ap.add_argument("--partials", action="store_true", help="also send running captions (transcript.partial) word by word")
    ap.add_argument("--secret", default=os.getenv("ATTENDEE_WEBHOOK_SECRET", DEFAULT_SECRET), help="base64 webhook secret")
    args = ap.parse_args()
    print(f"fake Attendee on :{args.port}; webhook secret {args.secret}")
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
