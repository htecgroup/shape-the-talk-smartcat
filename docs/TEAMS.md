# Teams meeting (Attendee)

A bot joins the call through [Attendee](https://github.com/attendee-labs/attendee) (self-hosted, Elastic License 2.0:
free to run for yourself, not to resell as a hosted service) and posts webhooks to this app.

## Setup

1. **Run Attendee** (needs a Docker engine: Docker Desktop, or Colima on a Mac where Docker Desktop isn't allowed:
   `brew install colima docker docker-compose docker-buildx`, `softwareupdate --install-rosetta`, then
   `colima start --vm-type vz --vz-rosetta --cpu 6 --memory 8`; Attendee's image is amd64, and Rosetta runs it much
   faster than QEMU. From a clone of `https://github.com/attendee-labs/attendee`):
   ```bash
   docker compose -f dev.docker-compose.yaml build
   docker compose -f dev.docker-compose.yaml run --rm attendee-app-local python init_env.py > .env
   docker compose -f dev.docker-compose.yaml up
   docker compose -f dev.docker-compose.yaml exec attendee-app-local python manage.py migrate
   ```
   Sign up at http://localhost:8000 (the confirmation link is printed in the server logs), create an API key
   (Settings, API Keys) and copy the webhook secret (Settings, Webhooks). By default Attendee only sends webhooks to
   https URLs (step 2).
2. **Let Attendee reach this app.** Attendee and the app on one laptop need no tunnel: add
   `REQUIRE_HTTPS_WEBHOOKS=false` to Attendee's `.env`; `LW_PUBLIC_URL=http://host.docker.internal:8010` is already the
   default in `.env.example`. Attendee on another machine needs an https tunnel: `cloudflared tunnel --url
   http://localhost:8010` (or `ngrok http 8010`), and the https URL it prints is `LW_PUBLIC_URL`. No AWS bucket is
   needed: the bot is created with `recording_settings.format = "none"`, so there is no recording to upload.
3. **Configure:** set `ATTENDEE_URL`, `ATTENDEE_API_KEY`, `ATTENDEE_WEBHOOK_SECRET`, `LW_PUBLIC_URL` in `.env`
   (see `.env.example`), start the app, click **👥 Teams meeting**, paste the meeting link, **Join meeting**.
4. **Admit the bot:** it waits in the lobby unless the meeting lets everyone in (the status line says so). Stop makes
   the bot leave and runs the usual end-of-meeting cleanup and saves the run; if the meeting ends or someone removes
   the bot, that happens by itself.

As soon as it has joined, also while it is still paused, the bot introduces itself in the meeting chat ("Hi everyone, I'm Klaudije, an AI bot
that listens to this meeting..."), so nobody wonders who is listening. `LW_ATTENDEE_INTRO=0` turns that off, and
`LW_ATTENDEE_INTRO_TEXT` sets your own text (`{bot_name}` is replaced by the bot's name).

## Starts paused

The bot joins **paused** (`LW_TEAMS_START_PAUSED=1`, the default), so whatever people say while the meeting is still
loading never reaches the board. The status line says "will start paused" while it joins; once it is in, it shows
"Paused · not listening" and a **Resume** button. Until Resume, the app drops every transcript it gets (captions and
finished utterances alike; joins still show in the legend), and the bot is also paused in Attendee as soon as
Attendee allows it (once it is recording; if Attendee refuses, the next state change tries again). Resume resumes
Attendee if it was paused and starts listening. A caption already running at that moment sends only the words said
after Resume. After that, Pause and Resume work as usual. `LW_TEAMS_START_PAUSED=0` makes the bot listen as soon as
it is in the meeting.

## Speakers and transcription

Speakers keep their Teams names and colours and are added to the legend as they join or speak. The Teams web client
exposes only one mixed audio stream, so Attendee gets "who is speaking" from Teams speaker events rather than from
separate audio per person, which makes diarization good but not perfect when people talk over each other.
`LW_ATTENDEE_TRANSCRIPTION=captions` (default) uses the Teams closed captions: free, low latency, lower quality.
`openai` uses OpenAI transcription inside Attendee: better text, higher latency, needs an OpenAI key there.
Signed in bots (`ATTENDEE_TEAMS_LOGIN=1`) help with meetings that require an account.

## Breakout rooms

Fill in **Breakout room** under the link (`Room 4`, or just `4`). The bot joins the main meeting, waits until that
room is open, then joins the room with its own link and leaves when the room is over. Nobody has to assign the bot to
the room, but it waits in the room's lobby, so someone in the room must admit it. Needs the Attendee patch below; it
adds `teams_settings.breakout_room` to Attendee's create-bot API.

## Live captions

Teams finalizes a caption about 1.5 s after a pause, so a long sentence would reach the agents only when it is over.
The Attendee patch below adds a `transcript.partial` webhook: every change of a running caption, posted straight from
the bot (not stored, not retried). The app then shows the caption as it grows and sends it to the agents in pieces: at
a sentence end, every `LW_TEAMS_CHUNK_WORDS` (6) words Teams has stopped revising (mid-sentence too; the modeller and
consolidator repair the board when the rest arrives), or after a `LW_TEAMS_PAUSE_S` (0.8 s) pause. The final caption
sends only what is left; words Teams corrects later are fixed on screen but not sent again. Without the patch, each
finished caption is one utterance.

## Attendee patch

Breakout rooms and live captions need a change to Attendee that isn't upstream, [`attendee-teams.patch`](attendee-teams.patch)
(made against Attendee `6e8ad6f`). In the Attendee clone:

```bash
git apply /path/to/shape-the-talk/docs/attendee-teams.patch
docker compose -f dev.docker-compose.yaml exec attendee-app-local python manage.py migrate
docker compose -f dev.docker-compose.yaml restart attendee-worker-local attendee-app-local
```

## Try it without Teams

`scripts/fake_attendee.py` plays the Freshbite meeting as a fake Attendee, with a lobby delay, signed webhooks, the bot
as a participant, and optional `--shuffle` / `--retries` / `--partials` (running captions word by word, with some words
misheard and fixed, as with the live-captions patch):

```bash
uv run python scripts/fake_attendee.py --port 8099 --pace 2
ATTENDEE_URL=http://localhost:8099 ATTENDEE_API_KEY=fake ATTENDEE_WEBHOOK_SECRET=ZmFrZS1zZWNyZXQ= \
  LW_PUBLIC_URL=http://localhost:8011 uv run uvicorn server:app --port 8011
```

Open http://localhost:8011, pick Teams meeting, paste any https link, Join.
