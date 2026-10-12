# Using Shape the Talk

Setup is in the [README](../README.md#run-it). This page covers the modes, the controls and the developer scripts.

## Modes

- **🎙 Talk live** (the default): speak into your microphone; OpenAI realtime transcription feeds the agents.
- **👥 Teams meeting:** a self-hosted Attendee bot joins a Microsoft Teams call and its webhooks give speaker-labelled
  utterances for everyone in it. Setup: [TEAMS.md](TEAMS.md).
- **Replay:** plays back a recorded run from `runs/` with no API calls (demo fallback).
  `http://localhost:8010/?replay=latest` autoplays the newest complete run (`?replay=<file>.json` for a specific one).

The server still supports scripted meetings (`data/meeting_*.json`) for `scripts/simulate.py`.

## Talk live

1. Click **🎙 Talk live**, optionally enter your name and what you're designing, then **🎙 Start talking** (the mic needs
   `localhost` or https).
2. Talk in short thoughts with small pauses. Interim text appears while you speak; an utterance is final about 1.3 s
   after you pause. "Actually, no…" corrects the board in place, "scratch that" undoes your last statement.
3. **■ Stop** flushes the last utterance, runs the final cleanup and analysis, writes the meeting summary and saves the
   run for Replay.

The OpenAI key never leaves the server: the browser streams audio to `/ws/mic` and the server talks to OpenAI.
`gpt-live-transcribe` doesn't support server-side turn detection, so the server's own energy VAD commits an utterance
after 700 ms of quiet.

## Controls

- Mode toggle, Start, Pause/Resume (space), speed 1×/2×/4× (replay), Reset, run picker, board tabs.
- **✨ Tidy** re-lays out the board, **⤢ Fit** fits it to the panel; drag/scroll to pan and zoom. Hover a node for its
  note, status and who changed it.
- **⚡ Autopilot / ✋ Ask first:** whether the agents may remove nodes on their own or must ask first
  (see [ARCHITECTURE.md](ARCHITECTURE.md#approval-modes)).
- **Export:** PNG of the current board, JSON or Mermaid of all boards, an AI-generated short spec, and the meeting
  summary once the meeting has ended.

## Development

```bash
uv run --group dev pytest -q tests                  # pytest suite, no network
uv run python scripts/simulate.py --speed 2         # headless simulated run: final boards + latency
uv run python scripts/simulate.py --describe runs/<file>.json
uv run python scripts/feed_audio.py [file.wav]      # stream a WAV into talk-live mode as if it were the mic
uv run python scripts/make_test_audio.py            # regenerate the TTS test monologue
uv run python scripts/fake_attendee.py              # fake Attendee server for the Teams mode, no Teams needed
```
