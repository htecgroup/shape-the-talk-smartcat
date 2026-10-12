# Architecture

How Shape the Talk turns speech into a board. For running the app see [USAGE.md](USAGE.md); for the Teams bot see
[TEAMS.md](TEAMS.md).

## Pipeline

```
utterance source ── ScriptedSource (mock meeting) | MicSource (mic → OpenAI realtime STT, our own VAD)
                    | AttendeeSource (Teams bot webhooks, speaker-labelled)
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

## The board contract

The LLMs never draw; they emit ops. `BoardState.apply_ops` validates each op, applies the valid ones and rejects the
rest with a reason (shown struck out in the activity feed). Every op carries the utterance id (`src`), and the server
fills in the speaker, so attribution can't be wrong. Ops are grouped per utterance, so `undo` reverts exactly what one
utterance did. A disputed element can only end up `resolved`. A connection to a tab id is mapped to the node it names
or rejected.

## Approval modes

**⚡ Autopilot** lets the agents edit the whole board freely. **✋ Ask first** still applies additions and changes right
away, but holds every node removal (modeller or consolidator) until someone clicks Remove or Keep on the card in the
board's corner. Until then the node stays on the board, dimmed and struck through. A consolidator merge (a new node
that replaces old ones) is held whole as one Merge card, so the board never shows both. Switching back to Autopilot
applies what is still waiting. The mode is a room setting (survives Reset; start value `LW_APPROVAL_MODE`). Which ops
need approval is the `DESTRUCTIVE` set in `whiteboard/approvals.py`.

## Rooms

`server.py` keeps one `Session` per room (`?room=<id>`, `[a-z0-9-]{1,32}`) in `rooms`, created on first use: the page,
both sockets, `/api/state`, `/api/control` and `/api/export/*` all take the room, and no room means `default`. Each
session has its own board, pipeline, approvals, spec guard and viewers, so a command or event never leaves its room.
Attendee posts every bot's webhooks to one URL; the server hands each to the room whose bot has that `bot_id`. A
background sweep (every minute, and when the cap is hit) drops a room after 30 minutes without viewers, mic socket,
running meeting, final summary or spec, through `Session.reset()` (closes the source, cancels its tasks).
`LW_MAX_ROOMS` caps the rooms (the default room is extra); past it a new room is refused with a message the page shows.

## The renderer

Five node types (actor, system, step, decision, data) plus tasks, hand-drawn with a stable wobble; `ghost` proposals are
dashed, `disputed` elements get a red outline and ❗ badge, `resolved` a ✓. Changes glow in the speaker's colour. New
nodes are placed next to what they connect to and existing nodes never move.

✨ Tidy re-lays out the whole board (flow order, groups together, long flows wrapped to fit the panel, edges routed
round nodes) when you click it, automatically after the consolidator restructured the board or changed its layout plan,
and when the meeting ends for every board that changed since its last layout in that browser (a recorded `relayout`
event, so Replay does it too; a board that didn't change keeps its layout). Wrapped rows snake: they alternate
left-to-right and right-to-left, and a group in a right-to-left row is mirrored so the flow enters at its first member.

With a layout plan (`LW_LAYOUT_HINTS=1`, the default) the consolidator also returns the story's main line in reading
order (`spine`), `direction` (LR, or TB for hierarchies), `placements` of side nodes (before/after/above/below an
anchor) and group orientation (row/column). Tidy follows it as constraints and still does the geometry itself. Without
a plan (or for ids it doesn't know) Tidy falls back to the graph structure. `LW_LAYOUT_HINTS=0` turns it off, for
comparison.

## Configuration

Every setting is listed with its default in [`.env.example`](../.env.example). Shell variables override `.env`. The
defaults are the recommended setup: Jev extractor, Claude Sonnet 5.5 with adaptive thinking for the modeller. A Haiku
modeller without thinking is faster but leaves placeholders and duplicates on live speech.

## Project layout

| Path | What it holds |
|---|---|
| `server.py` | FastAPI app: rooms, static files, `/ws` (push + commands), `/ws/mic` (audio in), `/api/attendee/webhook`, `/api/state`, `/api/runs`, `/api/control` |
| `whiteboard/session.py` | `Session`: state, snapshot, broadcasting, controls, replay |
| `whiteboard/pipeline.py` | Agent workers: extractor fan-out, batched modeller, analyst and consolidator scheduling, op guards |
| `whiteboard/approvals.py` | Approval modes: holds destructive ops in Ask-first mode, applies or drops them on a decision |
| `whiteboard/recording.py` | Run files in `runs/`: list, resolve, save with settings and latency |
| `whiteboard/board.py` | Board state: op validation, application, versioning, undo |
| `whiteboard/sources.py`, `stt.py`, `audio.py` | Utterance sources, OpenAI realtime transcription, PCM/resampler/VAD |
| `whiteboard/attendee.py` | Teams source: creates/leaves the Attendee bot, verifies webhook signatures, turns webhooks into utterances and participants |
| `whiteboard/agents/` | One module per agent (`extractor`, `extractor_jev`, `modeller`, `consolidator`, `analyst`), plus `llm.py`, `schemas.py`, `settings.py` |
| `whiteboard/agents/prompts/` | Prompt texts only, one module per agent |
| `static/board/` | Renderer: `board.js` (state, render, camera), `tidy.js`, `place.js`, `routing.js`, `shapes.js`, `svg.js`, `export.js` |
| `static/app.js`, `mic.js`, `pcm-worklet.js` | UI and WebSocket client; mic capture (AudioWorklet → 24 kHz PCM16) |
| `claude-mod/shapethetalk/` | Claude Code plugin: the same board drawn live in a pane next to the conversation |
| `scripts/`, `data/`, `tests/` | Simulator, audio test harness, fake Attendee, mock meetings and test audio, pytest suite |
| `runs/` | Recorded runs (the newest complete one is the replay fallback) |
| `docs/FINDINGS.md` | Model and transcription measurements, prompt-tuning history, verification notes |
| `PLAN.md` | The original hackathon plan and options considered |

## Limitations

- **LLM variance:** runs differ in small ways; the guards and validation contain the damage.
- **Latency:** about 4 s from end of speech to board update in talk live (≈1.3 s transcription + extractor + modeller).
- **No diarization at the microphone:** everyone at the microphone is one speaker (Teams mode labels speakers).
- **Pause-based utterances:** a mid-sentence pause splits a sentence in two; someone who never pauses is cut at 20–40 s.
- **Batching:** when utterances arrive faster than the modeller, an utterance retracted within the same batch is never drawn.
- **Rooms, not accounts:** anyone with a room's link can watch and control its board; no auth, English only. Rooms
  live in memory (a restart empties them) and one server process holds them all.
