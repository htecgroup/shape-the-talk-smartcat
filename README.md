# Live Whiteboard

As people talk in a meeting, their words become an animated diagram that redraws itself when someone says
"no, it works like this".

Three modes share one agent pipeline:
- **Simulated (AI):** a scripted 4-person brainstorm (`data/meeting_freshbite.json`) on a virtual clock.
- **🎙 Talk live:** speak into your microphone; OpenAI realtime transcription feeds the agents.
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

## Configuration

Every setting is listed with its default in [`.env.example`](.env.example). Shell variables override `.env`.
The defaults are the recommended setup: Jev extractor, Claude Sonnet 5.5 with adaptive thinking for the modeller.
A Haiku modeller without thinking is faster but leaves placeholders and duplicates on live speech.

## Development

```bash
uv run --group dev pytest -q tests                  # 45 tests, no network
uv run python scripts/simulate.py --speed 2         # headless simulated run: final boards + latency
uv run python scripts/simulate.py --describe runs/<file>.json
uv run python scripts/feed_audio.py [file.wav]      # stream a WAV into talk-live mode as if it were the mic
uv run python scripts/make_test_audio.py            # regenerate the TTS test monologue
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
      │   └─ Consolidator  background, every 6 utterances + at the end: merges duplicates and placeholders,
      │                    groups parts, connects loose nodes (cleanup ops, never touches disputes or tabs)
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
it, or automatically after the consolidator restructured the board.

## Project layout

| Path | What it holds |
|---|---|
| `server.py` | FastAPI app: static files, `/ws` (push + commands), `/ws/mic` (audio in), `/api/state`, `/api/runs`, `/api/control` |
| `whiteboard/session.py` | `Session`: state, snapshot, broadcasting, controls, replay |
| `whiteboard/pipeline.py` | Agent workers: extractor fan-out, batched modeller, analyst and consolidator scheduling, op guards |
| `whiteboard/recording.py` | Run files in `runs/`: list, resolve, save with settings and latency |
| `whiteboard/board.py` | Board state: op validation, application, versioning, undo |
| `whiteboard/sources.py`, `stt.py`, `audio.py` | Utterance sources, OpenAI realtime transcription, PCM/resampler/VAD |
| `whiteboard/agents/` | One module per agent (`extractor`, `extractor_jev`, `modeller`, `consolidator`, `analyst`), plus `llm.py`, `schemas.py`, `settings.py` |
| `whiteboard/agents/prompts/` | Prompt texts only, one module per agent |
| `static/board/` | Renderer: `board.js` (state, render, camera), `tidy.js`, `place.js`, `routing.js`, `shapes.js`, `svg.js` |
| `static/app.js`, `mic.js`, `pcm-worklet.js` | UI and WebSocket client; mic capture (AudioWorklet → 24 kHz PCM16) |
| `scripts/`, `data/`, `tests/` | Simulator, audio test harness, mock meeting and test audio, pytest suite |
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

## Limitations

- **LLM variance:** runs differ in small ways; the guards and validation contain the damage.
- **Latency:** about 4 s from end of speech to board update in talk live (≈1.3 s transcription + extractor + modeller).
- **No diarization:** everyone at the microphone is one speaker.
- **Pause-based utterances:** a mid-sentence pause splits a sentence in two; someone who never pauses is cut at 20–40 s.
- **Batching:** when utterances arrive faster than the modeller, an utterance retracted within the same batch is never drawn.
- **One global session:** one meeting at a time for every browser, no auth, English only.
