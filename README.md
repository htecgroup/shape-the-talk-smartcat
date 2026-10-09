# Live Whiteboard: POC (iteration 1)

As people talk in a meeting, their words become an animated diagram that redraws itself when someone says "no, it works like this".

This POC simulates a 4-person brainstorm (a mock transcript, no audio and no meeting bot). It drives a real
agent pipeline on OpenAI `gpt-6-luna`: **extractor → board modeller → typed ops → versioned board → animated renderer**,
with a background **analyst** that keeps the open-questions and disagreements lists.

## Run it

```bash
cd live-whiteboard
uv sync                                   # Python 3.11+, deps from pyproject.toml
uv run uvicorn server:app --port 8010
```

Then open:

| URL | What it does |
|---|---|
| http://localhost:8010 | **Live (AI)**: press *Start meeting*; every agent call hits the OpenAI API |
| http://localhost:8010/?replay=latest | **Replay**: autoplays the newest complete recorded run with **no API calls** (demo fallback) |

Controls: Start, Pause/Resume (also the space bar), speed 1×/2×/4×, Reset, the Live/Replay toggle plus a run picker,
board tabs, ✨ Tidy (a full dagre re-layout on demand), ⤢ Fit, and drag/scroll to pan and zoom. Hover a node for its note, status and who changed it.

`OPENAI_API_KEY` is read from `.env` and never logged.

Other entry points:

```bash
uv run --group dev pytest -q tests                # 19 tests: op validation/application, undo, disputes
uv run python scripts/simulate.py --speed 2       # headless live run, prints final boards + latency
uv run python scripts/simulate.py --describe runs/<file>.json
curl -XPOST localhost:8010/api/control -d '{"cmd":"start","mode":"live","speed":2}' -H 'content-type: application/json'
```

Optional env vars: `LW_MODEL` (default `gpt-6-luna`), `LW_EXTRACTOR_EFFORT` (`none`), `LW_MODELLER_EFFORT` (`none`),
`LW_ANALYST_EFFORT` (`low`).

## Architecture

```
data/meeting_freshbite.json ──► Meeting simulator (virtual clock: speed, pause; reveals words, then "final")
                                       │ utterance final (like an STT final segment)
                                       ▼
                     Extractor  (1 call per utterance, all run concurrently)
                       kind: new_info | correction | disagreement | resolution | question | undo | chit_chat
                       claims[], refers_to, topic_shift          chit_chat stops here
                                       │ in-order queue; backlog → one batched call (≤6 utterances)
                                       ▼
                     Board Modeller (compact board JSON + recent transcript + new claims)
                       → typed ops: add_node update_node remove_node connect disconnect reroute
                                    mark add_group set_group new_board switch_board undo
                                       │ server guards (new_board needs topic_shift, undo needs kind=undo)
                                       ▼
                     BoardState  (single source of truth: versioned, validated, undo via inverse primitives)
                       │                       ▲
                       │                       └─ Analyst (async, every 4 meaningful utterances, never blocks):
                       │                          open questions, disagreements, dispute-mark fixes (stale-guarded)
                       ▼
                     WebSocket ─► browser renderer (SVG + rough.js, stable incremental layout, animations)
                       │
                       └─► runs/<timestamp>.json   (every event with timing → replay without API)
```

| File | Role |
|---|---|
| `server.py` | FastAPI app: static files, `/ws` WebSocket (push + commands), `/api/state`, `/api/runs`, `/api/control` |
| `whiteboard/session.py` | Simulator clock, extractor fan-out, ordered/batched modeller worker, analyst scheduling, recording, replay |
| `whiteboard/agents.py` | The three agents: prompts, strict JSON schemas, the OpenAI call wrapper |
| `whiteboard/board.py` | Op schema, validation, application, versioning, transactions, undo |
| `static/board.js` | Renderer: shapes per node type, statuses, speaker-coloured highlights, stable layout, camera |
| `static/app.js`, `static/index.html`, `static/style.css` | Meeting panel, tabs, agent activity feed, lists, controls |
| `data/meeting_freshbite.json` | Mock meeting: 43 utterances, 4 roles (client PO, architect, backend dev, UX) |
| `tests/test_board.py` | Pytest suite for ops |
| `runs/` | Recorded runs (the newest complete one is the replay fallback) |

### The board model (the contract)
- The LLM never draws. It emits ops, and `BoardState.apply_ops` validates each one (required fields, enums, ids that exist, no
  duplicates or self-loops). It applies the valid ones and **rejects invalid ones with a reason** without crashing. Rejections show in the activity feed (struck out in red).
- Every op carries `src` (the utterance id) and `by` (the speaker). `by` is filled in by the server from `src`, so the model cannot misattribute.
- Every mutation goes through primitives that record their inverse. Ops are grouped into one transaction per source utterance,
  so `{"op":"undo","target_src":"u19"}` reverts exactly what u19 did. It also works when later utterances changed other things, and it drops edges left dangling.
- Deterministic dispute lifecycle: an element can only leave `disputed` by becoming `resolved`, and `resolved` only exists for elements that were actually disputed.
- One `board` event per applied batch carries the full state. Boards are small, which keeps the renderer and replay simple.

### Renderer
- Five node types are visually distinct: actor (yellow pill with a person icon), system (blue window with a title bar), step (rounded box),
  decision (pink diamond), and data (green cylinder). Nodes are hand-drawn with rough.js using a seeded, stable wobble.
- `ghost` = dashed and grey with a "proposed" caption; `disputed` = red outline and wobbling ❗ badge (the hover note shows both sides);
  `resolved` = green ✓ badge with the agreed decision in the tooltip.
- Changed elements glow briefly in the **colour of the speaker who caused the change**, with a name chip. A toast shows the modeller's one-line summary.
- **Stable layout:** a new node is placed next to the node it is connected to, and existing nodes never move. When a row is full, the flow
  drops a row and continues in the other direction (snake layout), which keeps edges short. ✨ Tidy runs dagre only when you ask for it.

## Model findings (gpt-6-luna, measured 2026-10-02)

Small probe calls (throwaway scripts, not kept; 5 samples each, short prompt):

| Variant | Median latency |
|---|---|
| Chat Completions, `json_schema` strict, `reasoning_effort=none` | ~1.30 s |
| Responses API, `text.format json_schema`, `reasoning.effort=none` | ~1.35 s |
| Chat Completions, `reasoning_effort=low` | ~1.28 s (on a tiny prompt; much slower on the real modeller prompt) |
| Chat Completions, `service_tier=priority` | ~1.12 s (costs more; not used) |

- Both APIs work, strict `json_schema` works (including `anyOf` op variants), and the two APIs have the same latency, so the code uses **Chat Completions**.
- `reasoning_effort` accepts `none | low | medium | high | xhigh` (Responses adds `max`); `minimal` is rejected.
  `temperature` can only be the default.
- On the real modeller prompt, `low` averaged **3.7 s** per call (4× run). That caused heavy batching, and batching swallowed the undo.
  `none` averages **~1.5 s** with equal or better results once the server guards were added. Default: `none` for extractor and modeller, `low` for the background analyst.

Measured per-call latency in the full live runs after prompt tuning (43 utterances at 2× speed; the last three runs).
The final run is `runs/2026-10-02T11-25-59.json`:

| Agent | Calls/run | Avg | p50 | Min–max |
|---|---|---|---|---|
| Extractor (`none`) | 43 | 1.36–1.42 s | ~1.35–1.40 s | 0.9–2.8 s |
| Modeller (`none`) | 35 | 1.49–1.70 s | ~1.45–1.71 s | 0.8–3.2 s |
| Analyst (`low`, background) | 9 | 3.8–5.3 s | ~4.2–5.5 s | 1.2–8.3 s |

The end-to-end time from "utterance final" to "board updated" is extractor + modeller, about **2.5–3 s**. That is inside the plan's
budget of under 3 s, before STT is added. The exact numbers for each run are in `runs/<file>.json` → `meta.latency`.

## Results in the final live run (`runs/2026-10-02T11-25-59.json`)
- Chit-chat (mic check, coffee, door, frozen video, leaving early, goodbye) is classified `chit_chat` and never reaches the modeller.
- Correction 1, "the payment goes through the gateway first": `reroute checkout->bank via payment_gateway`, and order creation is moved behind the gateway.
- Correction 2, "restaurants use the POS integration, not a tablet app": a POS integration node is added in front of "Accept order".
- Correction 3, "the courier app pushes; dispatch doesn't pull": `reroute` reverses the edge and relabels it "pulls locations" → "pushes locations".
- The courier-timing disagreement (Nikola vs Maja, u12–u14) is marked **disputed** at u13, stays open through 13 utterances,
  and is **resolved** at u27: its edge is rerouted from "Create order" to "Accept order" with the note "Agreed: assign on acceptance, timed by prep estimate".
- "Scratch that, forget the SMS" (u20): `undo u19` removes the SMS service and its two edges, which were drawn 3 s earlier.
- The topic shift at u30 opens a second tab, **System map** (11 nodes), and the renderer switches to it.
- The event bus vs nightly export disagreement stays open (disputed) at the end, as in the meeting.
- The analyst lists the 4 unanswered questions (payment failure, refunds, events vs batch, POS ownership), the 2 answered ones, and both disagreements (1 resolved, 1 open).
- Flaws in that run: the accepted proposal also left a redundant "Assign on acceptance" step and a leftover ghost edge, and
  "Create order" got an unnecessary "Agreed: …" note. Earlier runs showed other small variations (see below).

## Prompt-iteration history (what the guards are for)
Five full live runs were used to tune the prompts. Problems found and how each was fixed:
1. Process steps were split too finely, and one statement fanned out to 5–7 edges → "keep it readable" rules (details go in notes, at most 2 edges per new node).
2. Stated requirements were drawn as ghosts → ghost status only for hedged proposals.
3. With `reasoning_effort=none`, the modeller opened a new tab when a system was merely mentioned → the extractor emits `topic_shift`, and the server rejects `new_board` without it.
4. A correction was modelled as `undo` of an earlier utterance and wiped 3 nodes → `undo` is only allowed when the extractor heard a retraction. Undo now also drops dangling edges (a real board bug, now covered by a test).
5. A dispute ended `confirmed` (via `ghost`) instead of `resolved`, and "agreed, push only" resolved an unrelated dispute →
   a deterministic dispute lifecycle in `board.py`, plus an `OPEN DISPUTES` list in the modeller input.
6. The analyst marked an accepted correction as a dispute → the analyst can now only close disputes, never open them.
7. A reversed edge kept its old label → `reroute` takes a `label`, and a same-ends reroute just relabels the edge.

## Known limitations / weak spots
- **LLM variance:** runs differ. Typical small flaws: an extra helper node ("Live tracking" as a step), an actor left as `ghost`,
  or a rejected no-op op. The server rules (guards, dispute lifecycle, validation) contain the damage, but the diagram is not identical each time.
- Batching: when utterances arrive faster than the modeller (4× speed), several are modelled in one call. That is correct, but an
  utterance retracted within the same batch is simply never drawn, so the undo animation is not visible.
- The analyst works from the transcript and can briefly disagree with the board. Its dispute marks are guarded: stale marks are rejected, and it can only open or close disputes.
- Incremental layout is heuristic. Branch-heavy boards can get crossing edges. ✨ Tidy (dagre) fixes this, but then every node moves.
- Replay timing is the recorded wall-clock time (agent latency included); the speed buttons scale it. If a recording is made at 2×, then replay at 1× is the same pace as live at 2×.
- On page reload the layout is computed from the final state in one pass, so it can differ slightly from the live incremental layout.
- Single global session (one meeting at a time for every connected browser), no auth, no persistence across meetings, no MCP surface yet.
- No STT/diarization: the transcript is perfect and already speaker-labelled.
