/* Talk-live microphone: getUserMedia -> AudioWorklet (PCM16 24 kHz) -> /ws/mic.
 * The OpenAI key never reaches the browser; the server proxies the audio to OpenAI.
 *
 * Mic.start({speaker, topic, resume}, {onState, onLevel, onError}) -> Promise<boolean>
 * Mic.stop()   asks the server to flush the last utterance; capture stops immediately.
 */
const Mic = (() => {
  let stream = null, ctx = null, node = null, src = null, sink = null, ws = null;
  let h = {}, active = false, stopTimer = null;

  const supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioWorkletNode);

  function permissionMessage(e) {
    const n = e && e.name;
    if (n === "NotAllowedError" || n === "SecurityError") return "Microphone permission was denied. Allow the mic for this page (address bar → site settings) and try again.";
    if (n === "NotFoundError" || n === "OverconstrainedError") return "No microphone was found.";
    if (n === "NotReadableError") return "The microphone is busy in another app.";
    return `Could not open the microphone: ${e && e.message ? e.message : e}`;
  }

  async function start(opts, handlers) {
    h = handlers || {};
    if (active) return false;
    if (!supported()) { h.onError?.("This browser cannot capture audio here (needs getUserMedia + AudioWorklet, and https or localhost)."); return false; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) { h.onError?.(permissionMessage(e)); return false; }
    try {
      ctx = new AudioContext();               // device rate; the worklet resamples to 24 kHz
      await ctx.audioWorklet.addModule("/static/pcm-worklet.js");
      src = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, "pcm-worklet");
      sink = ctx.createGain(); sink.gain.value = 0;   // keep the graph pulling without playing the mic back
      src.connect(node); node.connect(sink); sink.connect(ctx.destination);
      if (ctx.state === "suspended") await ctx.resume();
    } catch (e) { release(); h.onError?.(`Audio setup failed: ${e.message || e}`); return false; }

    active = true;
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/mic`);
    ws.binaryType = "arraybuffer";
    const sock = ws;
    sock.onopen = () => sock.send(JSON.stringify({ type: "start", speaker: opts.speaker, topic: opts.topic, resume: !!opts.resume }));
    sock.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.type === "error") { h.onError?.(ev.error); teardown(); return; }
      if (ev.type === "mic_state") {
        h.onState?.(ev);
        if (ev.state === "error") { release(); closeSocket(); }
        if (ev.state === "stopped") { release(); closeSocket(); }
      }
    };
    sock.onclose = () => {
      if (ws === sock && active) { h.onError?.("Lost the connection to the server. The mic was stopped."); }
      if (ws === sock) teardown();
    };
    node.port.onmessage = (e) => {
      h.onLevel?.(e.data.rms, e.data.peak);
      if (sock.readyState === 1 && active) sock.send(e.data.pcm);
    };
    return true;
  }

  function stop() {
    if (!ws) { release(); return; }
    release();                                       // stop capturing right away
    try { ws.send(JSON.stringify({ type: "stop" })); } catch { /* closed */ }
    clearTimeout(stopTimer);
    stopTimer = setTimeout(closeSocket, 10000);      // the server answers with state "stopped"
  }

  function release() {
    active = false;
    try { node && (node.port.onmessage = null); } catch { /* ignore */ }
    try { src && src.disconnect(); node && node.disconnect(); sink && sink.disconnect(); } catch { /* ignore */ }
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx && ctx.state !== "closed") ctx.close().catch(() => {});
    stream = ctx = node = src = sink = null;
    h.onLevel?.(0, 0);
  }

  function closeSocket() {
    clearTimeout(stopTimer);
    const s = ws; ws = null;
    if (s && s.readyState <= 1) s.close();
  }

  function teardown() { release(); closeSocket(); }

  // Tab closing: closing the socket makes the server flush and close the upstream session.
  window.addEventListener("pagehide", () => { if (ws) ws.close(); });

  return { start, stop, supported, get active() { return active; } };
})();
