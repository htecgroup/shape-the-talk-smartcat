# Findings and history

Research notes, measurements and tuning history moved out of the README. They are dated and kept for context;
some predate the move from OpenAI to Anthropic agents, the Jev extractor, the consolidator and the new Tidy layout.

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

## Transcription model findings (probed 2026-10-03 with the TTS monologue, real-time pace)

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

## Verification and measured latency

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

## Teams breakout rooms (tested 2026-10-11, anonymous Attendee bot, Teams web "light meetings" client)

- **Following the organizer's moves** works in Teams but not in Attendee as is: moving to a room hangs up the main call
  and starts a new one (about 16 s, "We'll move you to your assigned room in 10 seconds"). Audio keeps flowing, but
  captions stay off and the participant list freezes, because Attendee keeps using the first call object it saw. "Close
  rooms" moves everyone back the same way, and captions resume in the main meeting; a person's own "Return" doesn't move the bot.
- **What we built instead:** the bot reads the room list in the main meeting
  (`callingDebug.observableCall.breakoutDetails.mainMeetingProperties.allBreakoutRooms`: name, `isOpen`,
  `meetingJoinUrl`), visible even when it isn't assigned to a room. Each room is an ordinary `meetup-join` meeting that keeps its link
  between sessions. Joining it fresh gives working captions and participants with no call switching. Patch:
  `docs/attendee-teams.patch`.
- **Lobby:** a bot joining a room by link waits in that room's lobby until someone in the room admits it, even when
  the main meeting lets guests straight in.
- **Room-end signals:** inside a room the bot gets `conversationEnd` messages (subCode 5012/5020) for *other*
  conversations, with other call ids, while its own call stays connected. Attendee's meeting-id check correctly ignores
  them; don't relax it. When the bot's room emptied, the end message also carried a different id, so the bot left through
  Attendee's 60 s "only participant" rule instead.
- Not tested: signed-in bots, rooms with automatic moves turned off, a meeting run by another organisation (who may admit from the room lobby).

## New topics, new tabs (measured 2026-10-15)

Test material: a real 147-utterance team standup recorded in talk live (not in the repo: it is a client meeting), with
7 topic boundaries labelled by hand (the next person's update, a new problem), and the scripted FreshBite meeting (one
explicit "let me switch gears"). Few boundaries are announced; most just start.

- **Extractor alone** (Jev over the standup, a detection up to 3 utterances after a boundary counts): the old question
  ("does it *explicitly* move to another subject?", last 6 lines only) found 2 of 7 at p ≥ 0.5. With the board on
  screen in the question and implicit shifts in the criteria: 7 of 7 at 0.5 (6 false alarms), 5 of 7 at 0.6 (1).
  No threshold separates the two cleanly, so Jev only proposes (≥ 0.6 shift, 0.4-0.6 possible) and the modeller,
  which sees the whole board, decides.
- **Whole pipeline** (simulate.py, Sonnet modeller): the standup first stayed at 2 tabs, as in the original meeting.
  The flags were there, but a new subject usually starts vague ("going on with your bugs"): the modeller drew
  nothing for that utterance, the flag was used up, and the clearer next ones landed on the old board. A shift the
  modeller draws nothing for now waits for the next utterance with content (like one heard in small talk). Then:
  8 tabs, one per topic, 6 of the 7 boundaries within 5 utterances (the seventh, after a stretch of garbled speech,
  19 late); two tabs have a single node. FreshBite still has exactly its 2 tabs.
- **No splitting where the topic stays:** three single-topic meetings stay on one tab: a Teams architecture demo cut
  into 38 short pieces (one possible shift, ignored), a talk-live walkthrough where the speaker hands over ("now back
  to Philip", flagged as a shift twice) and the next person keeps editing the same diagram, and the TTS coffee monologue
  (no flags).
