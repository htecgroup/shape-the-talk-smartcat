# Using Shape the Talk

Setup is in the [README](../README.md#run-it). This page covers the modes, the controls and the developer scripts.

## Modes

- **🎙 Talk live** (the default): speak into your microphone; OpenAI realtime transcription feeds the agents.
- **👥 Teams meeting:** a self-hosted Attendee bot joins a Microsoft Teams call and its webhooks give speaker-labelled
  utterances for everyone in it. Setup: [TEAMS.md](TEAMS.md).

## Rooms

Every visitor gets their own board: the page adds a random `?room=<id>` to its URL (the room button next to the status
copies the link). Whoever opens the same link sees the same board live and can control it (Start, Reset, approvals).
Without a room (scripts, `curl /api/control`) the server uses the `default`
room. At most `LW_MAX_ROOMS` rooms (20) are open at once; a room with no one connected and nothing running is dropped
after 30 minutes (after 1 minute if nothing was ever started in it), and its link then opens an empty board.

The server still supports scripted meetings (`data/meeting_*.json`) for `scripts/simulate.py`.

## Talk live

1. Click **🎙 Talk live**, optionally enter your name and what you're designing, then **🎙 Start talking** (the mic needs
   `localhost` or https).
2. Talk in short thoughts with small pauses. Interim text appears while you speak and goes to the agents in pieces
   while you talk: at a sentence end, every 6 words (`LW_MIC_CHUNK_WORDS`), or after a 0.8 s pause (`LW_MIC_PAUSE_S`). "Actually, no…" corrects the board in place, "scratch that" undoes your last statement.
3. Talk live takes the mic raw (no echo cancellation, noise suppression or auto gain), so a Teams/Zoom call on the
   same Mac keeps hearing you: on macOS Chrome's processing isn't limited to the tab, it switches the shared mic into
   voice-processing mode and turns the system input volume down. The server denoises instead
   (`LW_STT_NOISE_REDUCTION`). On a call, use headphones, or the others' voices from your speakers get transcribed as yours.
4. **■ Stop** flushes the last utterance, runs the final cleanup and analysis, writes the meeting summary and saves the
   run to `runs/`.

The OpenAI key never leaves the server: the browser streams audio to `/ws/mic` and the server talks to OpenAI.
`gpt-live-transcribe` doesn't support server-side turn detection, so the server's own energy VAD commits a segment
after 700 ms of quiet; its final transcript sends only what is left and fixes the earlier pieces on screen. Server-VAD
models stream no text mid-speech, so their segments go out whole.

## Custom vocabulary

Speech-to-text (Teams captions especially, which take no custom vocabulary) mishears product names: "Geoff classifier"
for JEV classifier, "cloud code" for Claude Code. `data/vocabulary.json` maps each correct spelling to its misheard
variants (case-insensitive, whole words). The server fixes them in the transcript before the viewers and the agents see
it, for every mode, and lists the terms as KNOWN TERMS in the modeller, consolidator and extractor prompts, so the board
is spelled right even when a variant slips through (e.g. split over two Teams chunks). Keep variants of real words
multi-word ("java classifier", never bare "java"). `LW_VOCABULARY` points to another file; read at server start.

## Controls

- Mode toggle (Talk live / Teams meeting), Start, Reset, Feedback, board tabs.
- **✨ Tidy** re-lays out the board, **⤢ Fit** fits it to the panel; drag/scroll to pan and zoom. Hover a node for its
  note, status and who changed it.
- **⚡ Autopilot / ✋ Ask first:** whether the agents may remove nodes on their own or must ask first
  (see [ARCHITECTURE.md](ARCHITECTURE.md#approval-modes)).
- **Export:** PNG of the current board, JSON or Mermaid of all boards, an AI-generated short spec, and the meeting
  summary once the meeting has ended.
- **Feedback:** opens a short anonymous form (a Microsoft Form that doesn't record names) for feedback and feature
  requests. After a meeting ends a small callout points at it ("How was it?"), once; nothing blocks the board. `LW_FEEDBACK_URL` sets another
  form, empty hides the button.

## Development

```bash
uv run --group dev pytest -q tests                  # pytest suite, no network
uv run python scripts/simulate.py --speed 2         # headless simulated run: final boards + latency
uv run python scripts/simulate.py --describe runs/<file>.json
uv run python scripts/feed_audio.py [file.wav]      # stream a WAV into talk-live mode as if it were the mic
uv run python scripts/make_test_audio.py            # regenerate the TTS test monologue
uv run python scripts/fake_attendee.py              # fake Attendee server for the Teams mode, no Teams needed
```
