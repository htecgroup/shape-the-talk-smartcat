/* AudioWorklet: microphone float32 at the device rate -> PCM16 mono 24 kHz chunks for /ws/mic.
 *
 * The AudioContext runs at the device rate (usually 48 kHz; Firefox cannot connect a mic to a
 * context with a different rate), so we resample here: windowed-sinc low-pass FIR (cutoff 0.9 x the
 * output Nyquist, so nothing above 12 kHz folds back into the speech band), then linear interpolation.
 * Same algorithm as whiteboard/audio.py:Resampler; tests/test_audio.py runs this file in Node.
 *
 * Posts {pcm: ArrayBuffer (Int16 LE), rms, peak} every ~50 ms (1200 output samples).
 */

class PcmResampler {
  constructor(inRate, outRate = 24000, taps = 31) {
    this.step = inRate / outRate;
    this.passthrough = inRate === outRate;
    const cutoff = 0.5 * Math.min(1, outRate / inRate) * 0.9;
    const half = Math.floor(taps / 2);
    const k = new Float64Array(taps);
    let norm = 0;
    for (let n = 0; n < taps; n++) {
      const m = n - half;
      const sinc = m === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * m) / (Math.PI * m);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (taps - 1));
      k[n] = sinc * w;
      norm += k[n];
    }
    for (let n = 0; n < taps; n++) k[n] /= norm;
    this.kernel = k;
    this.hist = new Float64Array(taps - 1); // last taps-1 raw input samples
    this.prev = 0;                           // last filtered sample of the previous block
    this.pos = 0;                            // next output position relative to the current block
  }

  process(input) {
    if (this.passthrough) return Float32Array.from(input);
    const k = this.kernel, taps = k.length, h = this.hist.length, n = input.length;
    const buf = new Float64Array(h + n);
    buf.set(this.hist, 0);
    buf.set(input, h);
    const f = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = 0; j < taps; j++) acc += k[j] * buf[i + j];
      f[i] = acc;
    }
    this.hist = buf.slice(buf.length - h);
    const out = [];
    let pos = this.pos;
    while (n && pos < n - 1 + 1e-9) {
      const i = Math.floor(pos), frac = pos - i;
      const a = i < 0 ? this.prev : f[i];
      const b = i + 1 < n ? f[i + 1] : f[i];
      out.push(a + (b - a) * frac);
      pos += this.step;
    }
    if (n) { this.prev = f[n - 1]; this.pos = pos - n; }
    return Float32Array.from(out);
  }
}

function floatToPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}

if (typeof AudioWorkletProcessor !== "undefined") {
  class PcmWorklet extends AudioWorkletProcessor {
    constructor() {
      super();
      this.rs = new PcmResampler(sampleRate, 24000); // `sampleRate` is a global in the worklet scope
      this.chunk = 1200;                              // 50 ms at 24 kHz
      this.pending = new Float32Array(0);
      this.sumSq = 0; this.count = 0; this.peak = 0;
    }

    process(inputs) {
      const chans = inputs[0];
      if (!chans || !chans.length || !chans[0]) return true;
      let x = chans[0];
      if (chans.length > 1) {          // mix down to mono
        x = new Float32Array(x.length);
        for (const c of chans) for (let i = 0; i < c.length; i++) x[i] += c[i] / chans.length;
      }
      for (let i = 0; i < x.length; i++) {
        const v = x[i];
        this.sumSq += v * v; this.count++;
        if (Math.abs(v) > this.peak) this.peak = Math.abs(v);
      }
      const y = this.rs.process(x);
      const merged = new Float32Array(this.pending.length + y.length);
      merged.set(this.pending, 0); merged.set(y, this.pending.length);
      let off = 0;
      while (merged.length - off >= this.chunk) {
        const pcm = floatToPcm16(merged.subarray(off, off + this.chunk));
        off += this.chunk;
        const rms = Math.sqrt(this.sumSq / Math.max(1, this.count));
        this.port.postMessage({ pcm: pcm.buffer, rms, peak: this.peak }, [pcm.buffer]);
        this.sumSq = 0; this.count = 0; this.peak = 0;
      }
      this.pending = merged.slice(off);
      return true;
    }
  }
  registerProcessor("pcm-worklet", PcmWorklet);
}

if (typeof module !== "undefined" && module.exports) module.exports = { PcmResampler, floatToPcm16 };
