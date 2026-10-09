# Live Whiteboard — Plan

**Pitch:** As people talk in a meeting, their words become animated diagrams that redraw themselves when someone says "no, it works like this".

Usage happens from the AI tools people already use (Claude, ChatGPT, Codex) through an MCP server or plugin. The complex parts stay behind the plugin.

## 1. Joining the call

| Option | How | Good | Bad |
|---|---|---|---|
| **A. Meeting bot API** (Recall.ai, MeetingBaas, Attendee (open source)) | Bot joins Teams/Zoom/Meet as a participant and streams real-time audio and speaker events to our server | Works on all platforms. Speaker names come from the platform, not diarization. Recall can stream a web page as the bot's camera, so the whiteboard appears in the meeting | Paid per hour. Company IT may block outside bots. Someone must admit the bot |
| **B. Local capture, no bot** | Browser page captures mic or shared tab audio, or a desktop helper captures system audio | No admission step, works for in-person workshops, cheap | Needs diarization. Someone must screen-share the board |
| **C. Native meeting apps** (Teams meeting extension, Meet Add-ons, Zoom RTMS) | Board inside the meeting UI | Best UX long term | App review and approval. Roadmap, not hackathon |

**Decision:** A for remote demos, B as fallback and for in-person workshops. Both produce the same utterance stream: `{speaker, text, start, end, is_final}`.

**To check:** Does company Teams allow outside bots? Does output media (bot camera = web page) work on the demo platform?

**Transcription:** streaming STT (Deepgram, AssemblyAI, OpenAI realtime transcription, or the one built into Recall). Final segments arrive about 0.5–1 s after speech. Interim segments can drive "ghost" previews.

## 2. Generating the whiteboard

**The key rule:** the LLM never draws. It edits a structured board model, and a deterministic renderer draws it.

```
utterances ─► Extractor (fast, every utterance)
                 │  new_info | correction | question | chit-chat → ignore
                 ▼
              Board Modeller (strong)
                 │  input: compact board JSON + new claims
                 │  output: typed operations (diff)
                 ▼
              Board state (single source of truth, versioned)
                 ├─► Renderer (deterministic, animated)
                 ├─► Background agents (async)
                 └─► MCP server (Claude / ChatGPT / Codex)
```

Example operations:
```json
{"op":"add_node","id":"gw","label":"Payment gateway","type":"system","by":"Ana"}
{"op":"connect","from":"checkout","to":"gw","label":"pays via"}
{"op":"reroute","edge":"checkout->bank","via":"gw"}
{"op":"mark","target":"gw","status":"disputed","note":"Marko: we call the bank directly"}
```
Benefits: no flicker, cheap corrections, every change credited to a speaker, undo ("scratch that"), and a measurable result.

- **Renderer:** tldraw SDK (whiteboard look, programmatic shapes, multiplayer, humans can drag), Excalidraw (hand-drawn), or React Flow (clean). Use Mermaid only for export because it jumps on re-render.
- **Layout:** ELK.js or dagre auto-layout. Pin existing nodes and place only new ones. Animate changes. Highlight recent changes in the speaker's colour.
- **Confidence:** low-confidence items appear dashed ("ghost") and become solid when confirmed.
- **Diagram types:** a router picks process flow, architecture, stakeholder map, timeline, or mind map. Topic changes open a new board tab.
- **Background agents (async):** conflict detector (disputed marker), open-questions list, tidy-up re-layout during pauses, recap writer.
- **Latency budget:** under 3 s from the end of speech to the board update (STT 0.5–1 s, extractor about 0.3 s, modeller 1–1.5 s, render instant). Batch operations per update.
- **Humans in control:** board edits from people feed back into the board state, so the AI and humans share one truth.

## 3. Plugin / MCP surface
- `start_whiteboard(meeting_url | "local")` sends the bot and returns the board link
- `get_board(meeting_id)` returns live board JSON or Mermaid, so Claude can reason during the call
- `edit_board(instruction)`, for example "split this into frontend and backend"
- `export(format)` to Excalidraw, draw.io, PNG, or a narrated recap video

Inline in ChatGPT (Apps SDK) and Claude (artifact or link).
**Memory:** a persistent board per client or project, so the next meeting continues from the last one. A client glossary improves extraction (memclaw as a component).

## 4. Evaluation
10–15 scripted meetings with ground-truth diagrams, voiced with several TTS voices and including corrections. Metrics: node/edge F1 against ground truth, update latency, churn (unnecessary moves). Shown on one slide.

## 5. 48 h split (4 people)
| Person | Owns |
|---|---|
| P1 | Ingestion: Recall bot, streaming STT, speaker mapping, local-mic fallback |
| P2 | Agents: extractor, modeller, op schema, corrections, background agents |
| P3 | Renderer: tldraw, pinned incremental layout, animations, bot camera output |
| P4 | MCP server, memory, eval harness and synthetic meeting set, demo script and pitch |

First 2 hours: P2 and P3 agree the op schema, which is the contract that unblocks parallel work.

**Risks:** bot video lag, overreaction to chit-chat, messy layout, IT blocking bots. Have a recorded fallback demo and local-mic mode.

**Open questions:** Which meeting platform does the company use? Will the demo be in person (local mic and projector, simpler, judges can speak corrections) or over a call?

## 6. POC (iteration 1)
No meeting joining. A mock brainstorming transcript is replayed utterance by utterance in a browser page that simulates the meeting live. The whiteboard updates in real time through the extractor → modeller → ops → renderer pipeline. All agents use OpenAI `gpt-6-luna`.
