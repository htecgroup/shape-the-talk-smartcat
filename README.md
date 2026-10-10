# Live Whiteboard: POC (iteration 1)

As people talk in a meeting, their words become an animated diagram that redraws itself when someone says "no, it works like this".

This POC simulates a 4-person brainstorm (a mock transcript, no audio and no meeting bot), and it has a
**🎙 Talk live** mode where you speak into your microphone and the board builds from what you say (see [Talk live](#talk-live-microphone-mode)). Both drive a real
agent pipeline on Anthropic `claude-sonnet-5-5` (effort `low`): **extractor → board modeller → typed ops → versioned board → animated renderer**,
with a background **analyst** that keeps the open-questions and disagreements lists, and a background **consolidator** that
periodically cleans up the modeller's incremental mistakes (duplicates, placeholders, hub edges instead of groups, loose nodes).

## Run it

```bash
cd live-whiteboard
uv sync                                   # Python 3.11+, deps from pyproject.toml
uv run uvicorn server:app --port 8010
```

Then open:

| URL | What it does |
|---|---|
| http://localhost:8010 | **Simulated (AI)**: press *Start meeting*; every agent call hits the Anthropic API |
| http://localhost:8010 → **🎙 Talk live** | Talk into the mic; OpenAI realtime transcription + the same (Anthropic) agents |
| http://localhost:8010/?replay=latest | **Replay**: autoplays the newest complete recorded run (simulated or talk-live) with **no API calls** (demo fallback). `?replay=<file>.json` plays a specific one |

Controls: the Simulated / Talk live / Replay toggle, Start, Pause/Resume (also the space bar), speed 1×/2×/4×, Reset, the Live/Replay toggle plus a run picker,
board tabs, ✨ Tidy (a full flow re-layout on demand), ⤢ Fit, and drag/scroll to pan and zoom. Hover a node for its note, status and who changed it.

`ANTHROPIC_API_KEY` (agents) and `OPENAI_API_KEY` (Talk live transcription and the test-audio script only) are read from `.env` and never logged.

Other entry points:

```bash
uv run --group dev pytest -q tests                # 36 tests: board ops, undo, disputes, audio/VAD/resampler, utterance sources
uv run python scripts/feed_audio.py               # stream data/test_audio/*.wav into talk-live mode as if it were the mic
uv run python scripts/make_test_audio.py          # regenerate the test monologue with OpenAI TTS
uv run python scripts/simulate.py --speed 2       # headless live run, prints final boards + latency
uv run python scripts/simulate.py --describe runs/<file>.json
curl -XPOST localhost:8010/api/control -d '{"cmd":"start","mode":"live","speed":2}' -H 'content-type: application/json'
```

Optional env vars: `LW_MODEL` (default `claude-sonnet-5-5`), `LW_EXTRACTOR_EFFORT` (`low`), `LW_MODELLER_EFFORT` (`low`),
`LW_ANALYST_EFFORT` (`low`). Consolidator: `LW_CONSOLIDATOR_MODEL` (default `LW_MODEL`), `LW_CONSOLIDATOR_EFFORT` (`medium`),
`LW_CONSOLIDATOR_THINKING` (`adaptive`), `LW_CONSOLIDATE_EVERY` (`6` meaningful utterances; `0` disables it). `LW_MODELLER_MODEL` / `LW_EXTRACTOR_MODEL` (default `LW_MODEL`) and `LW_MODELLER_THINKING` / `LW_EXTRACTOR_THINKING` (`adaptive`; `disabled` on Haiku, `between_tools` on Sonnet) tune each agent alone. `LW_EXTRACTOR_BACKEND=jev` swaps the extractor to TypeSafe Jev (key in `.env` as `JEV_API_KEY`, model `LW_JEV_MODEL`, default `jev-latest`). Talk live: `LW_STT_MODEL` (default `gpt-live-transcribe`), `LW_STT_SEGMENTATION`
(`local`/`server`, default picked from the model), `LW_VAD_SILENCE_MS` (`700`), `LW_VAD_MIN_RMS` (`220`),
`LW_STT_NOISE_REDUCTION` (`far_field`, `near_field` or `none`), `LW_STT_LANGUAGE` (`en`).

Recommended setup (Jev extractor, modeller on the default Sonnet with adaptive thinking):
`LW_EXTRACTOR_BACKEND=jev uv run uvicorn server:app --port 8010`

Fastest setup measured on the mock meeting (~2.1 s utterance to board ops vs ~4.4 s default, same score on the clean
scripted meeting): additionally `LW_MODELLER_MODEL=claude-haiku-5-5 LW_MODELLER_THINKING=disabled`. Avoid it for talk
live: on fragmented live speech Haiku without thinking leaves placeholder nodes and duplicates behind (compare
`runs/2026-10-10T09-26-01.json`, where Sonnet on the same transcript built a clean, connected board at the same latency).

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
                       │                       ├─ Analyst (async, every 4 meaningful utterances, never blocks):
                       │                       │  open questions, disagreements, dispute-mark fixes (stale-guarded)
                       │                       └─ Consolidator (async, every 6 meaningful utterances + once at the end,
                       │                          before the final analysis): full transcript + full active board →
                       │                          small cleanup diff (merge duplicates/placeholders, groups, connect loose nodes)
                       ▼
                     WebSocket ─► browser renderer (SVG + rough.js, stable incremental layout, animations)
                       │
                       └─► runs/<timestamp>.json   (every event with timing → replay without API)
```

| File | Role |
|---|---|
| `server.py` | FastAPI app: static files, `/ws` WebSocket (push + commands), `/ws/mic` (talk-live audio in), `/api/state`, `/api/runs`, `/api/control` |
| `whiteboard/session.py` | Pipeline: `submit_utterance()`, extractor fan-out, ordered/batched modeller worker, analyst and consolidator scheduling, recording, replay |
| `whiteboard/sources.py` | Pluggable utterance sources: `ScriptedSource` (mock meeting on the virtual clock) and `MicSource` (live speech) |
| `whiteboard/stt.py` | OpenAI Realtime transcription client (raw WebSocket, key stays on the server) |
| `whiteboard/audio.py` | PCM16 helpers, streaming resampler, adaptive energy VAD |
| `whiteboard/agents.py` | The agents (extractor, modeller, analyst, consolidator): prompts, structured-output JSON schemas, the Anthropic call wrapper |
| `whiteboard/board.py` | Op schema, validation, application, versioning, transactions, undo |
| `static/board.js` | Renderer: shapes per node type, statuses, speaker-coloured highlights, stable layout, camera |
| `static/app.js`, `static/index.html`, `static/style.css` | Meeting panel, tabs, agent activity feed, lists, controls, talk-live panel |
| `static/mic.js`, `static/pcm-worklet.js` | Mic capture: getUserMedia → AudioWorklet (resample to 24 kHz, PCM16) → `/ws/mic` |
| `scripts/feed_audio.py`, `scripts/make_test_audio.py`, `data/test_audio/` | Talk-live test harness: TTS monologue streamed through `/ws/mic` |
| `data/meeting_freshbite.json` | Mock meeting: 43 utterances, 4 roles (client PO, architect, backend dev, UX) |
| `tests/test_board.py`, `tests/test_audio.py`, `tests/test_sources.py`, `tests/test_consolidator.py`, `tests/test_agents.py` | Pytest: ops; PCM/resampler (incl. the browser worklet run in Node)/VAD; sources with faked agents and transcriber; consolidator trigger and guards; agent schemas/prompts |
| `runs/` | Recorded runs (the newest complete one is the replay fallback) |

### The board model (the contract)
- The LLM never draws. It emits ops, and `BoardState.apply_ops` validates each one (required fields, enums, ids that exist, no
  duplicates or self-loops). It applies the valid ones and **rejects invalid ones with a reason** without crashing. Rejections show in the activity feed (struck out in red).
- Every op carries `src` (the utterance id) and `by` (the speaker). `by` is filled in by the server from `src`, so the model cannot misattribute.
- Every mutation goes through primitives that record their inverse. Ops are grouped into one transaction per source utterance,
  so `{"op":"undo","target_src":"u19"}` reverts exactly what u19 did. It also works when later utterances changed other things, and it drops edges left dangling.
- Deterministic dispute lifecycle: an element can only leave `disputed` by becoming `resolved`, and `resolved` only exists for elements that were actually disputed.
- The **consolidator** fixes what the one-utterance-at-a-time modeller cannot see: a placeholder ("Agent one") next to the
  named node ("Extractor") is merged into one, "X consists of N parts" becomes a group instead of hub edges, and loose nodes
  are connected only when the transcript supports it (inferred relations as `ghost`). It uses the modeller's op vocabulary, but the
  server drops its `new_board`/`switch_board`/`undo` ops and anything that opens, closes or edits a dispute. It runs in the
  background, so the modeller may change the board meanwhile; ops on elements that are gone are rejected one by one.
- A `connect`/`reroute` endpoint that is a board (tab) id instead of a node (`live_whiteboard_architecture`) is mapped to the node
  it names (`live_whiteboard`, suffixes like `_architecture`, `_flow`, `_map` stripped) or rejected with a clear error.
- One `board` event per applied batch carries the full state. Boards are small, which keeps the renderer and replay simple.

### Renderer
- Five node types are visually distinct: actor (yellow pill with a person icon), system (blue window with a title bar), step (rounded box),
  decision (pink diamond), and data (green cylinder). Nodes are hand-drawn with rough.js using a seeded, stable wobble.
- `ghost` = dashed and grey with a "proposed" caption; `disputed` = red outline and wobbling ❗ badge (the hover note shows both sides);
  `resolved` = green ✓ badge with the agreed decision in the tooltip.
- Changed elements glow briefly in the **colour of the speaker who caused the change**, with a name chip. A toast shows the modeller's one-line summary.
- **Stable layout:** a new node is placed next to the node it is connected to, and existing nodes never move. When a row is full, the flow
  drops a row and continues in the other direction (snake layout), which keeps edges short. ✨ Tidy runs a full layered re-layout (flow order, groups kept together, long flows wrap to fit the panel) only when you ask for it, or after the consolidator restructured a board; nodes glide to their new places.

## Model findings (gpt-6-luna, measured 2026-10-02; the agents have since moved to `claude-sonnet-5-5`)

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
- Incremental layout is heuristic. Branch-heavy boards can get crossing edges. ✨ Tidy fixes this, but then every node moves (animated).
- Replay timing is the recorded wall-clock time (agent latency included); the speed buttons scale it. If a recording is made at 2×, then replay at 1× is the same pace as live at 2×.
- On page reload the layout is computed from the final state in one pass, so it can differ slightly from the live incremental layout.
- Single global session (one meeting at a time for every connected browser), no auth, no persistence across meetings, no MCP surface yet.
- Simulated mode has no STT/diarization: the transcript is perfect and already speaker-labelled. Talk-live mode has real STT but no diarization (see below).

## Talk live (microphone mode)

1. Start the server (`uv run uvicorn server:app --port 8010`) and open http://localhost:8010 (the mic needs `localhost` or https).
2. Click **🎙 Talk live**. Optionally type your name (default "You") and *What are we designing?* (default: the agents infer the topic).
3. Click **🎙 Start talking** and allow the microphone. The panel shows a red **Listening** indicator and a level meter.
4. Talk. Your words appear in the transcript in grey italics while you speak, and become final about 1.2–1.4 s after you pause.
   Each final utterance goes through the same extractor → modeller → board pipeline as the simulated meeting.
   Corrections ("actually, no, it goes through Stripe") fix the board in place, and "scratch that" undoes your previous statement.
5. Click **■ Stop**. The last utterance is flushed, the analyst runs once more, and the run is saved to `runs/` like a simulated run.
   Pick it in **Replay** (🎙 marks talk-live runs) to replay it without any API calls; interim text streams in the replay too.

If the OpenAI connection drops, the panel shows the error, the board stays, and the button becomes **↻ Reconnect mic**, which
continues the same session. Closing the tab ends the session the same way Stop does (flush, final analysis, save). Only one
browser can talk at a time; other browsers watch the same board live.

### Architecture

```
browser                                   our server (FastAPI)                         OpenAI
getUserMedia (echo cancel, noise supp., AGC)
  → AudioWorklet pcm-worklet.js
    low-pass FIR + resample to 24 kHz,
    float → PCM16, 50 ms chunks, RMS level ──► /ws/mic (binary frames) ──► MicSource ──► wss://api.openai.com/v1/realtime?intent=transcription
  level meter ◄─┘                                                   │  EnergyVAD           session.update {type: transcription,
                                                                    │  (20 ms frames,        model gpt-live-transcribe, pcm 24 kHz,
                                                                    │   adaptive floor)      turn_detection null, noise_reduction far_field}
                                                                    │  pause ≥ 700 ms ─────► input_audio_buffer.commit
                                                                    │  ◄──────────────────── ...transcription.delta   (while you speak)
                                                                    │  ◄──────────────────── ...transcription.completed (~0.55 s after commit)
 /ws ◄── utterance_start / utterance_interim / utterance_final ◄────┤
                                                                    └─► Session.submit_utterance() → extractor → modeller → board (unchanged)
```

- **The key never leaves the server.** The browser only talks to our `/ws/mic`; `whiteboard/stt.py` opens the upstream socket
  with `OPENAI_API_KEY` from `.env` and never logs it (connection errors are reported by exception type only).
  An ephemeral client secret + WebRTC straight from the browser would save one network hop (~tens of ms), but then the
  server would have to fetch the transcript events back from the browser to feed the pipeline. Proxying keeps the
  transcript where the agents run, and our own VAD needs the audio on the server anyway (see below).
- **Who splits utterances.** The best streaming model, `gpt-live-transcribe`, rejects server-side turn detection
  ("Turn detection is not supported for this transcription model"), so the server runs its own VAD (`EnergyVAD`) on the
  PCM it forwards and sends `input_audio_buffer.commit` after 700 ms of quiet. The noise floor is the quietest 20 ms frame of
  the last 3 s (speech always has gaps, steady room noise does not), so a fan or a noisy room raises the threshold by itself.
  Utterances longer than 20 s are cut at the next ≥ 280 ms pause and always at 40 s, so a long monologue still becomes
  digestible chunks for the modeller. Blips under 200 ms of voice are not committed. For models that do support it
  (`gpt-transcribe`, `gpt-4o-*`, `whisper-1`), `LW_STT_SEGMENTATION=server` (the default for them) uses OpenAI's `server_vad` instead.
- **Ordering.** Upstream items are mapped to our ids (`m001`, `m002`, …) and handed to the pipeline strictly in spoken order,
  even if OpenAI completes a later segment first. Empty or filler-only transcripts ("Um.") are dropped (`utterance_drop`).
- **Pluggable source.** `Session` no longer knows where utterances come from: `ScriptedSource` (the old simulator loop) and
  `MicSource` both call `session.submit_utterance()`, so queueing, batching, ordering, guards, analyst and recording are shared.
- **Agent context for live speech.** There is no title or participant list, so the meeting context is built from the name and
  the optional topic. When `meeting.source == "mic"`, the extractor and modeller prompts get an extra *LIVE SPEECH* section
  (one speaker who corrects themselves, fillers, fragments split by pauses, long utterances with several statements,
  "scratch that" plus a replacement in one utterance, no topic given). The simulated meeting's prompts are byte-identical to before.
- **Lifecycle.** Mic permission denied / no device / busy device → message in the panel. Upstream socket error or close →
  open utterances are finalized from their interim text (nothing said is lost), state `error`, Reconnect offered. Stop → commit
  what is still buffered (only if speech was heard since the last commit; committing pure silence can make the model invent a
  phrase), wait up to 5 s for the last `completed`, close upstream, finish the session. Tab closed → same as Stop.
  Reset → closes the upstream socket immediately.

### Transcription model findings (probed 2026-10-03 with the TTS monologue, real-time pace)

Throwaway probe scripts (not kept) opened `wss://api.openai.com/v1/realtime?intent=transcription`, sent
`session.update {"session": {"type": "transcription", "audio": {"input": {...}}}}` (the GA shape; the old beta
`transcription_session.update` is gone) and streamed the WAV in 100 ms chunks. "Speech end" = the true end of speech in the file
(energy detector), so the numbers include the pause the segmenter waits for.

| Model | Works? | Segmentation | Interim text while speaking | Speech end → final | Notes |
|---|---|---|---|---|---|
| **`gpt-live-transcribe`** (chosen) | ✅ | ours (commit after 600–700 ms quiet) | ✅ ~84% of deltas arrive mid-utterance | **~1.2 s** (commit → completed ~0.56 s) | Keeps fillers ("uh", "um"); accepts `prompt` and `noise_reduction`; `keywords` is silently ignored |
| `gpt-realtime-whisper` | ✅ | ours (VAD not supported) | ✅ same | ~1.3 s (commit → completed ~0.68 s) | Slightly better punctuation on this clip; `delay` param ("minimal" made no measurable difference); no `prompt` |
| `gpt-transcribe` | ✅ | OpenAI `server_vad` | ❌ deltas only after you stop | ~1.3 s (500 ms VAD) | Very clean text, drops some fillers; split "Okay." off as its own utterance |
| `gpt-4o-mini-transcribe` | ✅ | `server_vad` | ❌ after you stop | ~1.4 s | Good quality |
| `gpt-4o-transcribe` | ✅ | `server_vad` | ❌ after you stop | ~1.5 s | Drops fillers |
| `whisper-1` | ✅ | `server_vad` | ❌ one delta = the whole text | 0.5–2.6 s, erratic | |
| `gpt-transcribe` + `semantic_vad` (high) | ✅ | semantic | partly | 1.8–9.8 s | Merges sentences into long turns; too slow for a whiteboard |
| `gpt-4o-transcribe-diarize` | ❌ | – | – | – | "Your organization does not have access to this transcription model." So no diarization. |
| `gpt-realtime-2` | ❌ | – | – | – | Not a transcription model: "The model `gpt-realtime-2` does not exist or you do not have access to it." (as a transcription model) |
| `gpt-live-transcribe` / `gpt-realtime-whisper` with `server_vad` | ❌ | – | – | – | "Turn detection is not supported for this transcription model." |

Why `gpt-live-transcribe`: it is the only family that streams text *while* you talk (the requirement for live interim text),
and with our own VAD it is also the fastest to a final transcript. `gpt-realtime-whisper` is equivalent (a hair slower on
commit); switch with `LW_STT_MODEL=gpt-realtime-whisper`. `LW_STT_MODEL=gpt-transcribe` is the best fallback when the live
models are unavailable (no interim text while speaking, though).

### Verification and measured latency

The verification cannot use a real microphone, so `scripts/make_test_audio.py` generates a 95 s single-speaker monologue
with `gpt-4o-mini-tts` (voice "ash"; text in `data/test_audio/coffee_monologue.txt`): someone designs mobile ordering for a
coffee shop with fillers, a correction ("At checkout the app sends the payment straight to the bank." → "Actually, no, wait,
that's wrong. The payment goes through Stripe first…"), "Hmm. Scratch that, forget the SMS." followed by "We'll just send a
push notification through the app instead", a 17 s rambling utterance, and an open question.
`scripts/feed_audio.py` streams it at real-time pace through the same `/ws/mic` endpoint the browser uses, watches `/ws`
like a viewer, and measures latency against the true speech ends in the file.

Three full runs against the running server (`runs/2026-10-03T10-41-47.json`, `…10-44-11.json`, `…10-49-56.json`):

| Measure (client side, n = 11 utterances / 8–9 board updates) | Run 1 median | Run 2 median | Run 3 median | Range |
|---|---|---|---|---|
| speech end → transcript final | 1.21 s | 1.34 s | 1.32 s | 1.14–1.51 s |
| transcript final → board updated (extractor + modeller) | 3.17 s | 2.76 s | 2.82 s | 1.93–4.02 s |
| **speech end → board updated** | **4.40 s** | **4.21 s** | **4.15 s** | 3.26–5.16 s |

The final transcript costs 0.7 s of waiting for the pause plus ~0.55 s for OpenAI to finalize; interim text appeared before the
speaker finished in 11/11 utterances. The rest is the unchanged agent pipeline (extractor ~1.1–1.3 s + modeller ~1.6–1.9 s).
That is above the plan's 3 s budget: talk-live is roughly STT 1.3 s + agents 3 s.

What the board did (all three runs): checkout→bank was drawn, then the correction **rerouted it via Stripe** (Stripe → Bank kept,
as said); the SMS step was drawn and then removed by **`undo m006`** on "Scratch that. Forget the SMS."; the push notification
replaced it; "That's like way cheaper." was classified chit-chat; the long utterance became 3 nodes + 3 edges (orders database,
daily sales report, manager) with the details in notes; "what happens if the barista runs out of oat milk?" made no board change
and became the analyst's one open question. Final board: 12–13 nodes, one tab. Run 3 had one harmless rejected op (a duplicate `stripe->bank` connect after the reroute had already created that edge). The simulated meeting was re-run
headless afterwards (`runs/2026-10-03T10-46-29.json`) and still produced both tabs, the resolved and open disputes, and the undo.

Also verified: busy refusal for a second mic client; closing the mic socket mid-sentence (tab close) flushed the half
utterance, closed upstream, saved the run; in the desktop app's browser pane, the page renders with no console errors, the
real `pcm-worklet.js` turned a 48 kHz 1 kHz oscillator into 24 kHz PCM16 chunks of 1200 samples with the tone intact, interim
text rendered live in italics during a feed run, and a talk-live run replayed. Real microphone capture could not be tested
(the pane blocks mic access and nobody could speak); the permission-denied handling is in code but untested in a real browser.

### Talk-live limitations
- **Latency ~4.2–4.4 s** from the end of speech to the board update (budget was 3 s). Possible cuts: run the extractor on the
  interim text at commit time (the completed text rarely differs), a shorter pause (500 ms, but more mid-sentence splits),
  or merge extractor + modeller into one call in mic mode.
- **No diarization.** Everyone at the mic is one speaker; the diarize model is not available on this account, and the live models
  return no speaker labels. Disagreements between people in the room are therefore attributed to one name.
- **Pause-based utterances.** Our VAD splits on 700 ms pauses. A thinker who pauses mid-sentence gets two utterances (the prompts
  handle fragments, e.g. "We'll just send a push…" / "That's like way cheaper." worked), and someone who never pauses is cut at
  20–40 s. In a very noisy room the energy VAD can merge utterances; the browser's noise suppression helps.
- **TTS is not a person.** The test audio is clean TTS with clear pauses; real rooms, accents, crosstalk and far mics will be worse.
  `gpt-live-transcribe` misheard small words in probes ("an SMS" → "and SMS", "they pick" → "They'd pick").
- Only English is configured (`LW_STT_LANGUAGE=en`). One talk-live session at a time (single global session).
- A run ended by closing the tab is saved as complete, so it can become `?replay=latest`.
