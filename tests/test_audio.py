import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from whiteboard.audio import EnergyVAD, Resampler, float_to_pcm16, pcm16_to_float, rms_pcm16  # noqa: E402
from whiteboard.stt import segmentation_for, session_config  # noqa: E402


def tone(freq, rate, seconds, amp=0.5):
    return [amp * math.sin(2 * math.pi * freq * i / rate) for i in range(int(rate * seconds))]


def amplitude(samples):
    return math.sqrt(2 * sum(x * x for x in samples) / len(samples))


def test_float_to_pcm16_scales_and_clips():
    pcm = float_to_pcm16([0.0, 1.0, -1.0, 2.0, -3.0, 0.5])
    assert len(pcm) == 12
    back = pcm16_to_float(pcm)
    assert back[0] == 0 and back[1] == pytest.approx(32767 / 32768)
    assert back[2] == -1.0 and back[3] == back[1] and back[4] == -1.0   # clipped
    assert back[5] == pytest.approx(0.5, abs=1e-4)


def test_rms_pcm16():
    assert rms_pcm16(b"") == 0
    assert rms_pcm16(float_to_pcm16([0.5] * 100)) == pytest.approx(16384, rel=1e-3)


def test_resampler_48k_to_24k_keeps_speech_band_and_rate():
    rs = Resampler(48000, 24000)
    src = tone(1000, 48000, 0.5)
    out = []
    for i in range(0, len(src), 128):            # worklet-sized blocks: state must carry over
        out += rs.process(src[i:i + 128])
    assert abs(len(out) - 12000) <= 2
    steady = out[200:-200]
    assert amplitude(steady) == pytest.approx(0.5, rel=0.03)
    # still a 1 kHz tone: count zero crossings (2 per period)
    crossings = sum(1 for a, b in zip(steady, steady[1:]) if a < 0 <= b or a >= 0 > b)
    assert crossings / (len(steady) / 24000) == pytest.approx(2000, rel=0.03)


def test_resampler_removes_content_above_new_nyquist():
    rs = Resampler(48000, 24000)
    out = rs.process(tone(15000, 48000, 0.3))      # would alias to 9 kHz without the low-pass
    assert amplitude(out[100:]) < 0.02


def test_resampler_44k1_and_passthrough():
    rs = Resampler(44100, 24000)
    out = []
    src = tone(440, 44100, 1.0)
    for i in range(0, len(src), 441):
        out += rs.process(src[i:i + 441])
    assert abs(len(out) - 24000) <= 2
    assert amplitude(out[200:-200]) == pytest.approx(0.5, rel=0.03)
    assert Resampler(24000).process([0.1, 0.2]) == [0.1, 0.2]


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_browser_worklet_resampler_matches_python():
    """static/pcm-worklet.js (what the browser runs) produces the same samples as the Python port."""
    src = tone(1000, 48000, 0.05) + tone(15000, 48000, 0.05)
    js = f"""
      const {{ PcmResampler, floatToPcm16 }} = require({json.dumps(str(ROOT / 'static/pcm-worklet.js'))});
      const src = {json.dumps(src)};
      const rs = new PcmResampler(48000, 24000); let out = [];
      for (let i = 0; i < src.length; i += 128) out = out.concat(Array.from(rs.process(src.slice(i, i + 128))));
      console.log(JSON.stringify({{ out, pcm: Array.from(floatToPcm16([0, 1, -1, 2, 0.5])) }}));
    """
    res = json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)
    rs = Resampler(48000, 24000)
    py = []
    for i in range(0, len(src), 128):
        py += rs.process(src[i:i + 128])
    assert len(res["out"]) == len(py)
    assert max(abs(a - b) for a, b in zip(res["out"], py)) < 1e-6
    assert res["pcm"] == [0, 32767, -32768, 32767, 16384]


def speech(seconds, amp=0.3):
    """Syllable-like bursts: 160 ms of voice, 60 ms of near-silence (real speech always has gaps)."""
    t = tone(220, 24000, seconds, amp)
    return float_to_pcm16([x if (i % 5280) < 3840 else x * 0.01 for i, x in enumerate(t)])


def silence(seconds):
    return b"\x00\x00" * int(24000 * seconds)


def test_vad_commits_after_pause_and_ignores_blips():
    vad = EnergyVAD(silence_ms=600, min_rms=200)
    events = []
    for chunk in [silence(0.5), speech(1.5), silence(0.3), speech(1.0), silence(1.0),   # one utterance (0.3 s gap)
                  speech(0.1), silence(1.0),                                            # 100 ms blip: discarded
                  speech(2.0), silence(0.8)]:
        events += vad.feed(chunk)
    kinds = [e[0] for e in events]
    assert kinds == ["speech_start", "commit", "speech_start", "discard", "speech_start", "commit"]
    first_commit = events[1]
    assert first_commit[1] == pytest.approx(0.5 + 1.5 + 0.3 + 1.0 + 0.6, abs=0.05)
    assert vad.last_voiced_t == pytest.approx(0.5 + 1.5 + 0.3 + 1.0 + 1.0 + 0.1 + 1.0 + 2.0, abs=0.03)


def test_vad_splits_very_long_utterances_at_a_short_pause():
    vad = EnergyVAD(silence_ms=700, min_rms=200, soft_max_s=5, soft_pause_ms=280, hard_max_s=12)
    events = []
    for _ in range(4):                                # 4 x (3 s speech + 0.35 s pause): never a 700 ms silence
        events += vad.feed(speech(3.0)) + vad.feed(silence(0.35))
    commits = [e for e in events if e[0] == "commit"]
    assert commits and commits[0][2] == "long_utterance"
    vad2 = EnergyVAD(silence_ms=700, min_rms=200, soft_max_s=5, hard_max_s=8)
    ev2 = vad2.feed(speech(10))
    assert [e[2] for e in ev2 if e[0] == "commit"] == ["max_length"]


def test_vad_adapts_to_noise_floor():
    import random
    random.seed(1)
    noise = float_to_pcm16([random.uniform(-0.03, 0.03) for _ in range(24000 * 2)])  # rms ~ 570 > min_rms
    vad = EnergyVAD(silence_ms=600, min_rms=200)
    events = vad.feed(noise)
    events += vad.feed(noise)
    assert vad.threshold() > 1000
    assert [e[0] for e in events if e[0] == "commit"] == []   # steady room noise is not speech


def test_stt_session_config():
    assert segmentation_for("gpt-live-transcribe") == "local"
    assert segmentation_for("gpt-realtime-whisper") == "local"
    assert segmentation_for("gpt-4o-transcribe") == "server"
    local = session_config("gpt-live-transcribe", "local", prompt="coffee shop")
    inp = local["session"]["audio"]["input"]
    assert local["session"]["type"] == "transcription"
    assert inp["format"] == {"type": "audio/pcm", "rate": 24000}
    assert inp["turn_detection"] is None and inp["transcription"]["prompt"] == "coffee shop"
    server = session_config("gpt-4o-transcribe", "server")["session"]["audio"]["input"]
    assert server["turn_detection"]["type"] == "server_vad"
    assert "prompt" not in session_config("gpt-realtime-whisper", "local", prompt="x")["session"]["audio"]["input"]["transcription"]
