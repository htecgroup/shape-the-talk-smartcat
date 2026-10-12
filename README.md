# Live Whiteboard

As people talk in a meeting, their words become an animated diagram that redraws itself when someone says
"no, it works like this".

Four modes share one agent pipeline:
- **Simulated (AI):** a scripted 4-person brainstorm (`data/meeting_freshbite.json`) on a virtual clock.
- **🎙 Talk live:** speak into your microphone; OpenAI realtime transcription feeds the agents.
- **👥 Teams meeting:** a self-hosted [Attendee](https://github.com/attendee-labs/attendee) bot joins a Microsoft Teams call and
  its webhooks give speaker-labelled utterances for everyone in it.
- **Replay:** plays back a recorded run with no API calls (demo fallback).

## Quick start

```bash
uv sync                                   # Python 3.11+
cp .env.example .env                      # add ANTHROPIC_API_KEY, JEV_API_KEY, OPENAI_API_KEY (talk live)
uv run uvicorn server:app --port 8010
```

Open http://localhost:8010 and pick a mode. `http://localhost:8010/?replay=latest` autoplays the newest complete run
(`?replay=<file>.json` for a specific one).

Controls: mode toggle, Start, Pause/Resume (space), speed 1×/2×/4×, Reset, run picker, board tabs, ✨ Tidy, ⤢ Fit,
drag/scroll to pan and zoom. Hover a node for its note, status and who changed it.

**Agent edits** (board toolbar): **⚡ Autopilot** lets the agents edit the whole board freely. **✋ Ask first** still
applies additions and changes right away, but holds every node removal (modeller or consolidator) until someone clicks
Remove or Keep on the card in the board's corner. Until then the node stays on the board, dimmed and struck through. A
consolidator merge (a new node that replaces old ones) is held whole as one Merge card, so the board never shows both.
Switching back to Autopilot applies what is still waiting. The
mode is a room setting (survives Reset; start value `LW_APPROVAL_MODE`). Which ops need approval is the `DESTRUCTIVE`
set in `whiteboard/approvals.py`.

## Configuration

Every setting is listed with its default in [`.env.example`](.env.example). Shell variables override `.env`.
The defaults are the recommended setup: Jev extractor, Claude Sonnet 5.5 with adaptive thinking for the modeller.
A Haiku modeller without thinking is faster but leaves placeholders and duplicates on live speech.
`LW_LAYOUT_HINTS=1` (default) lets the consolidator also return a layout plan for the active board: the story's
main line in reading order (`spine`), `direction` (LR, or TB for hierarchies), `placements` of side nodes
(before/after/above/below an anchor) and group orientation (row/column). The browser's Tidy follows it as constraints
and still does the geometry itself. `LW_LAYOUT_HINTS=0` turns it off (graph-only layout, for comparison).

## Development

```bash
uv run --group dev pytest -q tests                  # 102 tests, no network
uv run python scripts/simulate.py --speed 2         # headless simulated run: final boards + latency
uv run python scripts/simulate.py --describe runs/<file>.json
uv run python scripts/feed_audio.py [file.wav]      # stream a WAV into talk-live mode as if it were the mic
uv run python scripts/make_test_audio.py            # regenerate the TTS test monologue
uv run python scripts/fake_attendee.py              # fake Attendee server for the Teams mode, no Teams needed
```

## How it works

```
utterance source ── ScriptedSource (mock meeting) | MicSource (mic → OpenAI realtime STT, our own VAD)
      │ final utterance
      ▼
Extractor        one call per utterance, concurrent (Jev by default, or Claude)
                 kind: new_info | correction | disagreement | resolution | question | undo | chit_chat
                 claims, refers_to, topic_shift                        chit_chat stops here
      │ in order; a backlog is batched (≤ 6 utterances per call)
      ▼
Board Modeller   compact board JSON + recent transcript → typed ops
                 (add_node update_node remove_node connect disconnect reroute mark add_group set_group
                  new_board switch_board undo); server guards: new_board needs topic_shift, undo needs kind=undo
      ▼
BoardState       single source of truth: validated, versioned, undo per utterance
      ▲   ├─ Analyst       background, every 4 utterances: open questions, disagreements, closes stale disputes
      │   └─ Consolidator  background, every 4 utterances, on the board a topic shift leaves, and at the end on
      │                    every changed board: merges duplicates and placeholders, groups parts, connects
      │                    loose nodes, folds technology/attribute nodes into notes, drops meta nodes
      │                    (cleanup ops, never touches disputes or tabs)
      │                    + a layout plan that covers the board: spine, direction, placements (LW_LAYOUT_HINTS)
      ▼
WebSocket → browser renderer (SVG + rough.js)       runs/<timestamp>.json → replay
```

**The board contract.** The LLMs never draw; they emit ops. `BoardState.apply_ops` validates each op, applies the valid
ones and rejects the rest with a reason (shown struck out in the activity feed). Every op carries the utterance id
(`src`), and the server fills in the speaker, so attribution can't be wrong. Ops are grouped per utterance, so
`undo` reverts exactly what one utterance did. A disputed element can only end up `resolved`. A connection to a tab id
is mapped to the node it names or rejected.

**The renderer.** Five node types (actor, system, step, decision, data), hand-drawn with a stable wobble; `ghost`
proposals are dashed, `disputed` elements get a red outline and ❗ badge, `resolved` a ✓. Changes glow in the speaker's
colour. New nodes are placed next to what they connect to and existing nodes never move. ✨ Tidy re-lays out the
whole board (flow order, groups together, long flows wrapped to fit the panel, edges routed round nodes) when you click
it, automatically after the consolidator restructured the board or changed its layout plan, and when the meeting
ends for every board that changed since its last layout in that browser (a recorded `relayout` event, so Replay does
it too; a board that didn't change keeps its layout). Wrapped rows snake: they alternate left-to-right and
right-to-left, and a group in a right-to-left row is mirrored so the flow enters at its first member. With a plan, the
story's spine sets the flow order (and where it wraps), side nodes go where the plan puts them, and TB boards run top
to bottom; without one (or for ids it doesn't know) Tidy falls back to the graph structure.

## Project layout

| Path | What it holds |
|---|---|
| `server.py` | FastAPI app: static files, `/ws` (push + commands), `/ws/mic` (audio in), `/api/attendee/webhook`, `/api/state`, `/api/runs`, `/api/control` |
| `whiteboard/session.py` | `Session`: state, snapshot, broadcasting, controls, replay |
| `whiteboard/pipeline.py` | Agent workers: extractor fan-out, batched modeller, analyst and consolidator scheduling, op guards |
| `whiteboard/approvals.py` | Approval modes: holds destructive ops in Ask-first mode, applies or drops them on a decision |
| `whiteboard/recording.py` | Run files in `runs/`: list, resolve, save with settings and latency |
| `whiteboard/board.py` | Board state: op validation, application, versioning, undo |
| `whiteboard/sources.py`, `stt.py`, `audio.py` | Utterance sources, OpenAI realtime transcription, PCM/resampler/VAD |
| `whiteboard/attendee.py` | Teams source: creates/leaves the Attendee bot, verifies webhook signatures, turns webhooks into utterances and participants |
| `whiteboard/agents/` | One module per agent (`extractor`, `extractor_jev`, `modeller`, `consolidator`, `analyst`), plus `llm.py`, `schemas.py`, `settings.py` |
| `whiteboard/agents/prompts/` | Prompt texts only, one module per agent |
| `static/board/` | Renderer: `board.js` (state, render, camera), `tidy.js`, `place.js`, `routing.js`, `shapes.js`, `svg.js` |
| `static/app.js`, `mic.js`, `pcm-worklet.js` | UI and WebSocket client; mic capture (AudioWorklet → 24 kHz PCM16) |
| `scripts/`, `data/`, `tests/` | Simulator, audio test harness, fake Attendee, mock meeting and test audio, pytest suite |
| `runs/` | Recorded runs (the newest complete one is the replay fallback) |
| `docs/FINDINGS.md` | Model and transcription measurements, prompt-tuning history, verification notes |

## Talk live

1. Click **🎙 Talk live**, optionally enter your name and what you're designing, then **🎙 Start talking** (the mic needs
   `localhost` or https).
2. Talk in short thoughts with small pauses. Interim text appears while you speak; an utterance is final about 1.3 s
   after you pause. "Actually, no…" corrects the board in place, "scratch that" undoes your last statement.
3. **■ Stop** flushes the last utterance, runs the final cleanup and analysis, and saves the run for Replay.

The OpenAI key never leaves the server: the browser streams audio to `/ws/mic` and the server talks to OpenAI.
`gpt-live-transcribe` doesn't support server-side turn detection, so the server's own energy VAD commits an utterance
after 700 ms of quiet.

## Teams meeting (Attendee)

A bot joins the call through [Attendee](https://github.com/attendee-labs/attendee) (self-hosted, Elastic License 2.0:
free to run for yourself, not to resell as a hosted service) and posts webhooks to this app.

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
   (Settings, API Keys) and copy the webhook secret (Settings, Webhooks). By default Attendee only sends webhooks to https URLs (step 2).
2. **Let Attendee reach this app.** Attendee and the app on one laptop need no tunnel: add
   `REQUIRE_HTTPS_WEBHOOKS=false` to Attendee's `.env`; `LW_PUBLIC_URL=http://host.docker.internal:8010` is already the default in `.env.example`.
   Attendee on another machine needs an https tunnel: `cloudflared tunnel --url http://localhost:8010` (or
   `ngrok http 8010`), and the https URL it prints is `LW_PUBLIC_URL`. No AWS bucket is needed: the bot is created
   with `recording_settings.format = "none"`, so there is no recording to upload.
3. **Configure:** set `ATTENDEE_URL`, `ATTENDEE_API_KEY`, `ATTENDEE_WEBHOOK_SECRET`, `LW_PUBLIC_URL` in `.env`
   (see `.env.example`), start the app, click **👥 Teams meeting**, paste the meeting link, **Join meeting**.
4. **Admit the bot:** it waits in the lobby unless the meeting lets everyone in (the status line says so). Stop makes
   the bot leave and runs the usual end-of-meeting cleanup and saves the run; if the meeting ends or someone removes
   the bot, that happens by itself.

Speakers keep their Teams names and colours and are added to the legend as they join or speak. The Teams web client
exposes only one mixed audio stream, so Attendee gets "who is speaking" from Teams speaker events rather than from
separate audio per person, which makes diarization good but not perfect when people talk over each other.
`LW_ATTENDEE_TRANSCRIPTION=captions` (default) uses the Teams closed captions: free, low latency, lower quality.
`openai` uses OpenAI transcription inside Attendee: better text, higher latency, needs an OpenAI key there.
Signed in bots (`ATTENDEE_TEAMS_LOGIN=1`) help with meetings that require an account.

**Breakout rooms:** fill in **Breakout room** under the link (`Room 4`, or just `4`). The bot joins the main meeting,
waits until that room is open, then joins the room with its own link and leaves when the room is over. Nobody has to
assign the bot to the room, but it waits in the room's lobby, so someone in the room must admit it. Needs the
Attendee patch below; it adds `teams_settings.breakout_room` to Attendee's create-bot API.

**Live captions:** Teams finalizes a caption about 1.5 s after a pause, so a long sentence would reach the agents only
when it is over. The Attendee patch below adds a `transcript.partial` webhook: every change of
a running caption, posted straight from the bot (not stored, not retried). The app then shows the caption as it grows
and sends it to the agents in pieces: at a sentence end, every `LW_TEAMS_CHUNK_WORDS` (6) words Teams has stopped
revising (mid-sentence too; the modeller and consolidator repair the board when the rest arrives), or after a
`LW_TEAMS_PAUSE_S` (0.8 s) pause. The final caption sends only what is left; words Teams
corrects later are fixed on screen but not sent again. Without the patch, each finished caption is one utterance.

**Attendee patch:** both features need a change to Attendee that isn't upstream, `docs/attendee-teams.patch` (made
against Attendee `6e8ad6f`). In the Attendee clone:

```bash
git apply /path/to/shape-the-talk/docs/attendee-teams.patch
docker compose -f dev.docker-compose.yaml exec attendee-app-local python manage.py migrate
docker compose -f dev.docker-compose.yaml restart attendee-worker-local attendee-app-local
```

**Try it without Teams:** `scripts/fake_attendee.py` plays the Freshbite meeting as a fake Attendee, with a lobby delay,
signed webhooks, the bot as a participant, and optional `--shuffle` / `--retries` / `--partials` (running captions
word by word, with some words misheard and fixed, as with the live-captions patch):

```bash
uv run python scripts/fake_attendee.py --port 8099 --pace 2
ATTENDEE_URL=http://localhost:8099 ATTENDEE_API_KEY=fake ATTENDEE_WEBHOOK_SECRET=ZmFrZS1zZWNyZXQ= \
  LW_PUBLIC_URL=http://localhost:8011 uv run uvicorn server:app --port 8011
```

Open http://localhost:8011, pick Teams meeting, paste any https link, Join.

## Limitations

- **LLM variance:** runs differ in small ways; the guards and validation contain the damage.
- **Latency:** about 4 s from end of speech to board update in talk live (≈1.3 s transcription + extractor + modeller).
- **No diarization at the microphone:** everyone at the microphone is one speaker (Teams mode labels speakers).
- **Pause-based utterances:** a mid-sentence pause splits a sentence in two; someone who never pauses is cut at 20–40 s.
- **Batching:** when utterances arrive faster than the modeller, an utterance retracted within the same batch is never drawn.
- **One global session:** one meeting at a time for every browser, no auth, English only.
