"""Audio helpers for talk-live mode (pure Python, no numpy).

The OpenAI realtime transcription API takes PCM16 little-endian, mono, 24 kHz.
The browser does the float -> PCM16 conversion and resampling in an AudioWorklet
(static/pcm-worklet.js); `Resampler` here is the same algorithm, used by
scripts/feed_audio.py for files that are not 24 kHz and by the tests.

`EnergyVAD` splits speech into utterances on the server. The streaming
transcription models (gpt-live-transcribe, gpt-realtime-whisper) reject
server-side turn detection, so the server commits the audio buffer itself
when the speaker pauses.
"""

from __future__ import annotations

import math
import os
from array import array
from collections import deque

TARGET_RATE = 24000


# ------------------------------------------------------------------ PCM16
def float_to_pcm16(samples) -> bytes:
    """[-1, 1] floats -> PCM16 LE bytes. Values outside the range are clipped."""
    out = array("h", bytes(2 * len(samples)))
    for i, s in enumerate(samples):
        s = -1.0 if s < -1.0 else (1.0 if s > 1.0 else s)
        out[i] = int(round(s * 32767)) if s >= 0 else int(round(s * 32768))
    return out.tobytes()


def pcm16_to_float(data: bytes) -> list[float]:
    a = array("h")
    a.frombytes(data[: len(data) // 2 * 2])
    return [x / 32768.0 for x in a]


def rms_pcm16(data: bytes) -> float:
    """Root mean square of PCM16 samples, on the int16 scale (0..32768)."""
    a = array("h")
    a.frombytes(data[: len(data) // 2 * 2])
    if not a:
        return 0.0
    return math.sqrt(sum(x * x for x in a) / len(a))


def dbfs(rms: float) -> float:
    return 20 * math.log10(max(rms, 1e-9) / 32768.0)


# --------------------------------------------------------------- resampler
class Resampler:
    """Streaming resampler: windowed-sinc low-pass FIR at the input rate, then linear interpolation.

    Downsampling (48 kHz -> 24 kHz) needs the low-pass, or everything above 12 kHz folds back
    into the speech band (aliasing). After the low-pass the signal has almost no energy near the
    input Nyquist frequency, so linear interpolation between samples is accurate enough for speech.
    State carries over between chunks, so chunk boundaries are seamless.
    Mirrors PcmResampler in static/pcm-worklet.js.
    """

    def __init__(self, in_rate: int, out_rate: int = TARGET_RATE, taps: int = 31) -> None:
        self.in_rate, self.out_rate = in_rate, out_rate
        self.step = in_rate / out_rate                      # input samples per output sample
        self.passthrough = in_rate == out_rate
        cutoff = 0.5 * min(1.0, out_rate / in_rate) * 0.9    # normalised to the input rate
        half = taps // 2
        k = []
        for n in range(taps):
            m = n - half
            sinc = 2 * cutoff if m == 0 else math.sin(2 * math.pi * cutoff * m) / (math.pi * m)
            window = 0.42 - 0.5 * math.cos(2 * math.pi * n / (taps - 1)) + 0.08 * math.cos(4 * math.pi * n / (taps - 1))
            k.append(sinc * window)
        norm = sum(k)
        self.kernel = [x / norm for x in k]
        self.hist = [0.0] * (taps - 1)   # last taps-1 raw input samples
        self.prev = 0.0                  # last filtered sample of the previous chunk
        self.pos = 0.0                   # next output position, relative to the current chunk (may be < 0)

    def process(self, samples) -> list[float]:
        if self.passthrough:
            return list(samples)
        taps = len(self.kernel)
        buf = self.hist + list(samples)
        filtered = []
        kernel = self.kernel
        for i in range(len(samples)):
            acc = 0.0
            for j in range(taps):
                acc += kernel[j] * buf[i + j]
            filtered.append(acc)
        self.hist = buf[len(buf) - (taps - 1):]
        out = []
        n = len(filtered)
        pos = self.pos
        while pos < n - 1 + 1e-9 and n:
            i = math.floor(pos)
            frac = pos - i
            a = self.prev if i < 0 else filtered[i]
            b = filtered[i + 1] if i + 1 < n else filtered[i]
            out.append(a + (b - a) * frac)
            pos += self.step
        if n:
            self.prev = filtered[-1]
            self.pos = pos - n
        return out


# --------------------------------------------------------------------- VAD
class EnergyVAD:
    """Adaptive energy VAD over 20 ms frames.

    Speech = frame RMS above max(min_rms, noise_floor * ratio). The noise floor is the quietest
    frame of the last few seconds (minimum statistics): speech always has short gaps, steady room
    noise or a fan does not, so the floor settles on the noise level even if it starts loud.
    The first 300 ms only calibrate. After speech, `silence_ms` of quiet ends the utterance ("commit"). Very long
    utterances are cut at the next short pause after `soft_max_s`, and always at `hard_max_s`,
    so one rambling monologue still becomes several utterances the modeller can digest.

    feed() returns a list of events: ("speech_start", t) / ("commit", t, reason), where t is
    the audio time in seconds. `last_voiced_t` is the audio time of the end of the last voiced frame.
    """

    FRAME_S = 0.02

    def __init__(self, rate: int = TARGET_RATE, silence_ms: int | None = None, min_rms: float | None = None,
                 ratio: float = 3.0, min_speech_ms: int = 200, soft_max_s: float = 20.0,
                 soft_pause_ms: int = 280, hard_max_s: float = 40.0, floor_window_s: float = 3.0) -> None:
        self.rate = rate
        self.frame = int(rate * self.FRAME_S)
        self.silence_s = (silence_ms if silence_ms is not None else int(os.getenv("LW_VAD_SILENCE_MS", "700"))) / 1000
        self.min_rms = min_rms if min_rms is not None else float(os.getenv("LW_VAD_MIN_RMS", "220"))
        self.ratio = ratio
        self.min_speech_s = min_speech_ms / 1000
        self.soft_max_s, self.soft_pause_s, self.hard_max_s = soft_max_s, soft_pause_ms / 1000, hard_max_s
        self.noise_floor = 0.0
        self._recent = deque(maxlen=int(floor_window_s / self.FRAME_S))
        self._warmup = int(0.3 / self.FRAME_S)
        self._buf = b""
        self.t = 0.0                    # audio time consumed so far
        self.in_speech = False          # an utterance is open (speech seen, not yet committed)
        self.utt_start = 0.0
        self.voiced_s = 0.0             # voiced time inside the open utterance
        self.last_voiced_t = 0.0
        self.last_rms = 0.0

    def threshold(self) -> float:
        return max(self.min_rms, self.noise_floor * self.ratio)

    def feed(self, pcm: bytes) -> list[tuple]:
        self._buf += pcm
        events: list[tuple] = []
        size = self.frame * 2
        while len(self._buf) >= size:
            frame, self._buf = self._buf[:size], self._buf[size:]
            rms = rms_pcm16(frame)
            self.last_rms = rms
            t_end = self.t + self.FRAME_S
            self._recent.append(rms)
            self.noise_floor = min(self._recent)
            voiced = len(self._recent) > self._warmup and rms > self.threshold()
            if voiced:
                if not self.in_speech:
                    self.in_speech, self.utt_start, self.voiced_s = True, self.t, 0.0
                    events.append(("speech_start", self.t))
                self.voiced_s += self.FRAME_S
                self.last_voiced_t = t_end
            elif self.in_speech:
                quiet = t_end - self.last_voiced_t
                long_utt = t_end - self.utt_start >= self.soft_max_s
                if quiet >= self.silence_s or (long_utt and quiet >= self.soft_pause_s):
                    events.append(self._end(t_end, "silence" if quiet >= self.silence_s else "long_utterance"))
            if self.in_speech and t_end - self.utt_start >= self.hard_max_s:
                events.append(self._end(t_end, "max_length"))
            self.t = t_end
        return events

    def _end(self, t: float, reason: str) -> tuple:
        enough = self.voiced_s >= self.min_speech_s
        self.in_speech = False
        return ("commit", t, reason) if enough else ("discard", t, reason)
