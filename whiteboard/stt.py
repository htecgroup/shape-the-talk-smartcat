"""OpenAI Realtime API, transcription mode, over a raw WebSocket.

The key stays on the server: the browser streams PCM16 to our /ws/mic endpoint and
this client forwards it upstream. See docs/FINDINGS.md for the model probe results.

Two segmentation modes:
- "local": the model streams text while the person speaks but does not accept turn
  detection (gpt-live-transcribe, gpt-realtime-whisper). Our EnergyVAD decides when an
  utterance ends and sends input_audio_buffer.commit; the model then sends `completed`.
- "server": OpenAI's server_vad splits utterances (gpt-transcribe, gpt-4o-transcribe,
  gpt-4o-mini-transcribe, whisper-1). These models transcribe only after the pause, so
  interim text appears after the speaker stops, not while they speak.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from typing import Awaitable, Callable

import websockets

log = logging.getLogger("stt")

URL = "wss://api.openai.com/v1/realtime?intent=transcription"
STT_MODEL = os.getenv("LW_STT_MODEL", "gpt-live-transcribe")
LOCAL_VAD_MODELS = {"gpt-live-transcribe", "gpt-realtime-whisper"}
NO_PROMPT_MODELS = {"gpt-realtime-whisper", "gpt-4o-transcribe-diarize"}
NOISE_REDUCTION = os.getenv("LW_STT_NOISE_REDUCTION", "far_field")   # near_field | far_field | none
LANGUAGE = os.getenv("LW_STT_LANGUAGE", "en")
SERVER_VAD_SILENCE_MS = int(os.getenv("LW_VAD_SILENCE_MS", "700"))

# errors that do not break the session (e.g. a stop right after a commit)
BENIGN_ERRORS = {"input_audio_buffer_commit_empty"}


def segmentation_for(model: str) -> str:
    override = os.getenv("LW_STT_SEGMENTATION")
    if override in ("local", "server"):
        return override
    return "local" if model in LOCAL_VAD_MODELS else "server"


def session_config(model: str, segmentation: str, prompt: str | None = None) -> dict:
    transcription: dict = {"model": model}
    if LANGUAGE:
        transcription["language"] = LANGUAGE
    if prompt and model not in NO_PROMPT_MODELS:
        transcription["prompt"] = prompt
    audio_in: dict = {
        "format": {"type": "audio/pcm", "rate": 24000},
        "transcription": transcription,
        "turn_detection": None if segmentation == "local" else {
            "type": "server_vad", "threshold": 0.5, "prefix_padding_ms": 300,
            "silence_duration_ms": SERVER_VAD_SILENCE_MS},
    }
    audio_in["noise_reduction"] = None if NOISE_REDUCTION in ("", "none") else {"type": NOISE_REDUCTION}
    return {"type": "session.update", "session": {"type": "transcription", "audio": {"input": audio_in}}}


class UpstreamError(Exception):
    pass


class RealtimeTranscriber:
    """One upstream transcription session. Server events are passed to `on_event` as dicts.

    When the socket closes without close() having been called, on_event receives
    {"type": "upstream.closed", "code": ..., "reason": ...}.
    """

    def __init__(self, on_event: Callable[[dict], Awaitable[None]], model: str = STT_MODEL,
                 prompt: str | None = None) -> None:
        self.model = model
        self.segmentation = segmentation_for(model)
        self.prompt = prompt
        self.on_event = on_event
        self.ws = None
        self._reader: asyncio.Task | None = None
        self._closing = False

    async def connect(self, timeout: float = 10.0) -> None:
        key = os.getenv("OPENAI_API_KEY")
        if not key:
            raise UpstreamError("OPENAI_API_KEY is not set on the server")
        try:
            self.ws = await asyncio.wait_for(websockets.connect(
                URL, additional_headers={"Authorization": f"Bearer {key}"}, max_size=None,
                ping_interval=20, ping_timeout=20), timeout)
        except Exception as exc:  # never include headers in the message
            raise UpstreamError(f"could not connect to OpenAI realtime: {type(exc).__name__}") from None
        await self.ws.send(json.dumps(session_config(self.model, self.segmentation, self.prompt)))
        # wait until the session is configured, so a bad model name fails here and not mid-speech
        try:
            while True:
                ev = json.loads(await asyncio.wait_for(self.ws.recv(), timeout))
                if ev["type"] == "session.updated":
                    break
                if ev["type"] == "error":
                    await self.ws.close()
                    raise UpstreamError(f"OpenAI rejected the session: {ev['error'].get('message')}")
        except asyncio.TimeoutError:
            await self.ws.close()
            raise UpstreamError("OpenAI realtime did not confirm the session in time") from None
        except websockets.ConnectionClosed as exc:
            raise UpstreamError(f"OpenAI realtime closed the connection ({exc.code})") from None
        self._reader = asyncio.create_task(self._read())
        log.info("upstream transcription session open: model=%s segmentation=%s", self.model, self.segmentation)

    async def _read(self) -> None:
        code, reason = None, ""
        try:
            async for raw in self.ws:
                try:
                    await self.on_event(json.loads(raw))
                except Exception:
                    log.exception("stt event handler failed")
        except websockets.ConnectionClosed as exc:
            code, reason = exc.code, exc.reason
        except asyncio.CancelledError:
            return
        if not self._closing:
            if code is None and self.ws is not None and self.ws.close_code is not None:
                code, reason = self.ws.close_code, self.ws.close_reason or ""
            await self.on_event({"type": "upstream.closed", "code": code, "reason": reason})

    @property
    def open(self) -> bool:
        return self.ws is not None and not self._closing and self.ws.close_code is None

    async def append(self, pcm: bytes) -> None:
        if self.open:
            await self.ws.send(json.dumps({"type": "input_audio_buffer.append",
                                           "audio": base64.b64encode(pcm).decode()}))

    async def commit(self) -> None:
        if self.open:
            await self.ws.send(json.dumps({"type": "input_audio_buffer.commit"}))

    async def close(self) -> None:
        self._closing = True
        if self.ws is not None:
            try:
                await asyncio.wait_for(self.ws.close(), 3)
            except Exception:
                pass
        if self._reader is not None:
            self._reader.cancel()
