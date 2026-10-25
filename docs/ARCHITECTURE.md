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
                 claims, refers_to, topic_shift (compared with the board on screen)
                                                                       chit_chat stops here (its topic shift is kept)
      │ in order; a backlog is batched (≤ 6 utterances per call)
      ▼
Board Modeller   compact board JSON + recent transcript → typed ops
                 (add_node update_node remove_node connect disconnect reroute mark add_group set_group
                  new_board switch_board undo); server guards: new_board needs a topic shift (or the New tab
                  button), undo needs kind=undo; ops for a detail board are routed to it
      ▼
BoardState       single source of truth: validated, versioned, undo per utterance
      ▲   ├─ Analyst       background, every 4 utterances: open questions, disagreements, closes stale disputes
      │   └─ Consolidator  background, every 4 utterances, on the board a topic shift leaves, and at the end on
      │                    every changed board: merges duplicates and placeholders, groups parts, connects
      │                    loose nodes, folds technology/attribute nodes into notes, drops meta nodes
      │                    (cleanup ops, never touches disputes or tabs); splits a big board into an
      │                    overview and detail boards (extract_subflow)
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

## New topics, new tabs

Each board is about one subject, and a new subject gets its own tab. Three parts decide when:

- **The extractor proposes.** Its topic-shift question gets the board on screen (`BoardState.brief()`: the active
  board's title, kind and newest node labels, and the other boards' titles), so it asks "does this belong on a
  different diagram than this one?" rather than "did someone announce a switch?". Real meetings rarely announce it:
  the next person's update or a new problem just starts. On Jev, p ≥ 0.6 is a topic shift and 0.4-0.6 a possible one.
- **The modeller decides.** It sees `TOPIC_SHIFT` (open a new board unless the talk clearly continues this one) or
  `POSSIBLE_TOPIC_SHIFT` (open one only if what is said has nothing to do with this board) on the utterance, and goes
  back to an earlier board with `switch_board` when the subject is one it already has.
- **The server guards.** `new_board` needs one of the flags; a possible shift only once the current board has 3 nodes
  (`POSSIBLE_SHIFT_MIN_NODES`), so it doesn't spawn tabs of one or two nodes. A shift heard in small talk ("okay, next
  topic", "Filip, you can continue") is carried to the next utterance with content instead of being dropped with it,
  and so is one the modeller drew nothing for (a new subject often starts vague: "going on with your bugs").

People can also ask for one: the **+** after the tabs (during a meeting) makes the next utterance with content start a
new board (`{"cmd": "new_tab"}`; the modeller titles it, and if it draws without opening one the server opens a "New
topic" board for it). The request shows as a dashed tab until the board opens; clicking it cancels.

## Overview and detail boards

A big topic is drawn the way a person would: an overview of 6-10 nodes, with a drill-down board for each
self-contained sub-flow (caller verification with its retries, fraud checks and 3-D Secure, refunds). The consolidator
decides: when the board it cleans up has more than ~14 nodes, or a sub-flow with its own decisions that joins the rest
through few edges, it emits `extract_subflow {nodes, id, label, title, note}` (also in the final pass at meeting end,
which is told it is the last chance; the new detail boards then get a pass of their own). `BoardState` does the rest
deterministically and undoably: the nodes, the edges between them and their groups move to a new detail board
(`parent` = the overview, its tab right after the overview's); one summary node (`detail` = the detail board) takes
their place and every edge across the cut (parallel ones merged, labels kept); on the detail board the outside ends are
reference nodes (same id, `ref_board` = the overview), so it reads on its own. One level only.

The modeller keeps the overview as the active board and sees its detail boards in full; an op for something on a
detail board carries `"board": "<detail id>"`. The server also routes ops whose nodes are only on one detail board
there, turns a `switch_board` to a detail board into ops on it, makes a connect across the cut a reference plus an
overview edge to the summary node, keeps references in sync with the overview node, and counts detail boards as the
same topic (the extractor's brief, `_fits_new_board`). The consolidator never removes references or summary nodes.

In the browser, detail tabs are small and indented (`↳ Verification`) under their overview, a tab that changed while
not shown gets a dot; a summary node is a stacked card with a `+N ▸` badge and opens its detail board, a reference
node is a stub-like pill ("from Orchestrator", "→ Human agent") and opens the overview. JSON export carries `parent`,
`detail` and `ref_board`; Mermaid puts each detail board in its own section after its overview.

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
running meeting, final summary or spec (`EMPTY_ROOM_IDLE_S`, 1 minute, for a room nothing was ever started in), through `Session.reset()` (closes the source, cancels its tasks).
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

Tidy has two layout engines and keeps whichever reads better on that board (`simplify.js` `layout()`): its own
(`tidy.js`, above) and [ELK](https://eclipse.dev/elk/)'s layered layout (`elk.js` on the vendored elkjs 0.9.3 in
`static/vendor/`): left to right, left to right wrapped into rows that fit the panel (each row reads left to right under
the one before), or top to bottom. ELK gets every node with its drawn size, groups as compound nodes (a task list as a
column), edge labels with their size (so it keeps room for them), and the back edges already turned round by the story
order (the plan's spine, else from the entry points); it minimises crossings (layer sweep), places nodes with
Brandes-Köpf and routes the edges orthogonally, which `routing.js` draws with rounded corners. Every candidate (with and
without stubs) is routed and costed: edge length (long edges count less), crossings, labels over nodes, stubs, edges
against the reading direction (right to left in a row, or up) and text that ends up small after fitting the panel. A
mind map keeps tidy.js' layout. ELK runs synchronously (its bundle's fake worker is called directly) and only on a full
re-layout, never while nodes are placed live; a busy board takes a few hundred ms per Tidy.

With a layout plan (`LW_LAYOUT_HINTS=1`, the default) the consolidator also returns the story's main line in reading
order (`spine`), `direction` (LR, or TB for hierarchies), `placements` of side nodes (before/after/above/below an
anchor) and group orientation (row/column). Tidy follows it as constraints and still does the geometry itself (ELK
uses the spine and before / after placements for order and straightness; above / below and group orientation are left
to its layering). Without
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
| `static/board/` | Renderer: `board.js` (state, render, camera), `tidy.js`, `elk.js` (ELK layered layout for Tidy), `place.js`, `routing.js`, `simplify.js` (stubs for far edges into shared sinks, one edge to a group, the choice between the Tidy layouts), `shapes.js`, `svg.js`, `export.js` |
| `static/vendor/` | elkjs 0.9.3 (`elk.bundled.js`, EPL-2.0, `elk.LICENSE.md`) |
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
- **Chunked utterances:** talk live and Teams send a running transcript in pieces (sentence ends, every 6 words, short
  pauses), so a sentence can reach the agents split; the modeller and consolidator repair the board when the rest arrives.
- **Batching:** when utterances arrive faster than the modeller, an utterance retracted within the same batch is never drawn.
- **Rooms, not accounts:** anyone with a room's link can watch and control its board; no auth, English only. Rooms
  live in memory (a restart empties them) and one server process holds them all.
