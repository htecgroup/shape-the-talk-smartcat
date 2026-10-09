/* Live Whiteboard UI: WebSocket client, meeting panel, tabs, agent feed. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const params = new URLSearchParams(location.search);

  const S = {
    ws: null, mode: "live", status: "idle", speed: 1,
    participants: [], colors: {}, total: 0,
    board: null, viewBoard: null, followActive: true, knownBoards: new Set(),
    utts: new Map(), activity: [], paused: false, autoReplay: params.get("replay"),
  };
  const KIND_LABEL = { new_info: "new info", correction: "correction", disagreement: "disagreement", resolution: "resolution", question: "question", undo: "undo", chit_chat: "chit-chat · ignored" };
  const colorOf = (name) => S.colors[name] || "#868e96";
  const initials = (n) => n.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();

  Board.init({ colorOf, onEmptyChange: (empty) => $("boardEmpty").classList.toggle("hide", !empty) });

  // ------------------------------------------------------------------ socket
  function connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    S.ws = ws;
    ws.onmessage = (m) => handle(JSON.parse(m.data));
    ws.onclose = () => setTimeout(connect, 1200);
  }
  const send = (msg) => S.ws && S.ws.readyState === 1 && S.ws.send(JSON.stringify(msg));

  function handle(ev) {
    switch (ev.type) {
      case "snapshot": return onSnapshot(ev);
      case "meeting": return setMeeting(ev.meeting);
      case "utterance_start": return onUttStart(ev);
      case "utterance_final": return onUttFinal(ev.id);
      case "extraction": return onExtraction(ev);
      case "activity": return addActivity(ev.item, true);
      case "board": return onBoard(ev);
      case "analysis": return renderLists(ev.questions, ev.disagreements);
      case "status": return setStatus(ev.status, ev.mode, ev.speed);
      case "run_saved": toast("System", `Run recorded → runs/${ev.file}. Replay it with ?replay=latest`); return loadRuns();
      case "error": return toast("System", ev.error);
    }
  }

  function onSnapshot(s) {
    setMeeting(s.meeting);
    $("transcript").querySelectorAll(".utt").forEach((e) => e.remove());
    S.utts.clear();
    $("transcriptEmpty").hidden = s.transcript.length > 0;
    for (const u of s.transcript) {
      const e = addUtt(u, false);
      if (u.kind) setKind(u.id, u.kind);
    }
    $("activity").replaceChildren(); S.activity = [];
    for (const a of s.activity) addActivity(a, false);
    renderLists(s.questions, s.disagreements);
    S.board = null; S.knownBoards = new Set(); S.followActive = true;
    Board.reset();
    onBoard({ board: s.board, silent: true });
    setStatus(s.status, s.mode, s.speed);
    fillRuns(s.runs);
    updateProgress();
    if (S.autoReplay && (s.status === "idle" || s.status === "finished")) {
      setMode("replay");
      send({ cmd: "start", mode: "replay", run: S.autoReplay, speed: S.speed });
      S.autoReplay = null;
    }
  }

  // ---------------------------------------------------------------- meeting
  function setMeeting(m) {
    if (!m) return;
    $("meetingTitle").textContent = m.title;
    S.total = m.total || 0;
    S.participants = m.participants;
    for (const p of m.participants) S.colors[p.name] = p.color;
    $("participants").innerHTML = m.participants.map((p) => `
      <div class="person" id="p-${esc(p.name)}" style="--pc:${p.color}">
        <div class="avatar">${initials(p.name)}</div>
        <div><div class="name">${esc(p.name)} <span class="bars"><i></i><i></i><i></i></span></div>
        <div class="role">${esc(p.role)}</div></div>
      </div>`).join("");
    updateProgress();
  }

  function setSpeaking(name, on) {
    document.querySelectorAll(".person").forEach((p) => p.classList.remove("speaking"));
    if (on && name) { const p = document.getElementById(`p-${name}`); if (p) p.classList.add("speaking"); }
  }

  function addUtt(u, animate) {
    $("transcriptEmpty").hidden = true;
    const div = document.createElement("div");
    div.className = "utt";
    div.style.setProperty("--pc", colorOf(u.speaker));
    const words = u.text.split(/\s+/);
    div.innerHTML = `<div class="av">${initials(u.speaker)}</div>
      <div><div class="who">${esc(u.speaker)} <span class="uid">${u.id}</span><span class="kinds"></span></div>
      <div class="text">${words.map((w) => `<span class="w${animate ? "" : " on"}">${esc(w)} </span>`).join("")}</div></div>`;
    $("transcript").appendChild(div);
    const entry = { el: div, words: [...div.querySelectorAll(".w")], shown: animate ? 0 : words.length, timer: null, speaker: u.speaker };
    S.utts.set(u.id, entry);
    scrollTranscript();
    return entry;
  }

  function onUttStart(ev) {
    const entry = addUtt(ev.utt, true);
    entry.el.classList.add("speaking");
    setSpeaking(ev.utt.speaker, true);
    const per = Math.max(30, (ev.duration_ms || 2000) / Math.max(1, entry.words.length));
    entry.timer = setInterval(() => {
      if (S.paused) return;
      if (entry.shown < entry.words.length) { entry.words[entry.shown++].classList.add("on"); scrollTranscript(); }
      else clearInterval(entry.timer);
    }, per);
    updateProgress();
  }

  function onUttFinal(id) {
    const e = S.utts.get(id); if (!e) return;
    clearInterval(e.timer);
    e.words.forEach((w) => w.classList.add("on"));
    e.el.classList.remove("speaking");
    setSpeaking(null, false);
    scrollTranscript();
  }

  function onExtraction(ev) {
    setKind(ev.id, ev.kind, ev.topic_shift);
  }

  function setKind(id, kind, shift) {
    const e = S.utts.get(id); if (!e) return;
    const k = e.el.querySelector(".kinds");
    k.innerHTML = `<span class="kind k-${kind}">${KIND_LABEL[kind] || kind}</span>` + (shift ? `<span class="kind k-shift">topic shift</span>` : "");
    if (kind === "chit_chat") e.el.classList.add("ignored");
  }

  function scrollTranscript() { const t = $("transcript"); t.scrollTop = t.scrollHeight; }
  function updateProgress() {
    const n = S.utts.size;
    $("uttCount").textContent = `${n} / ${S.total || "?"} utterances`;
    $("progressBar").style.width = S.total ? `${(100 * n) / S.total}%` : "0";
  }

  // ------------------------------------------------------------------ board
  function onBoard(ev) {
    const state = ev.board;
    S.board = state;
    const ids = state.boards.map((b) => b.id);
    const fresh = ids.filter((id) => !S.knownBoards.has(id));
    if (state.active && (fresh.includes(state.active) || S.followActive)) { S.viewBoard = state.active; S.followActive = true; }
    if (!ids.includes(S.viewBoard)) S.viewBoard = state.active;
    renderTabs(ev.silent ? [] : fresh);
    ids.forEach((id) => S.knownBoards.add(id));
    const lastOp = (ev.applied || [])[ev.applied ? ev.applied.length - 1 : 0];
    const b = state.boards.find((x) => x.id === S.viewBoard) || null;
    Board.render(b, { version: ev.version, by: lastOp && lastOp.by, silent: ev.silent });
  }

  function renderTabs(fresh = []) {
    const tabs = $("tabs");
    if (!S.board || !S.board.boards.length) { tabs.innerHTML = `<div class="tab on">Whiteboard</div>`; return; }
    tabs.innerHTML = S.board.boards.map((b) => `
      <button class="tab ${b.id === S.viewBoard ? "on" : ""} ${fresh.includes(b.id) ? "new" : ""}" data-id="${esc(b.id)}">
        ${esc(b.title)} <span class="kind-tag">${esc(b.kind)}</span><span class="n">${Object.keys(b.nodes).length}</span>
      </button>`).join("");
    tabs.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
      S.viewBoard = t.dataset.id;
      S.followActive = t.dataset.id === S.board.active;
      renderTabs();
      Board.render(S.board.boards.find((x) => x.id === S.viewBoard), { silent: true });
    }));
  }

  // ---------------------------------------------------------------- agents
  function fmtOp(op) {
    const by = op.by ? ` <span class="by" style="--pc:${colorOf(op.by)}">${esc(op.by)}</span>` : "";
    const o = op.op || "?";
    let s;
    switch (o) {
      case "add_node": s = `+ ${op.type} “${op.label}”${op.status === "ghost" ? " (proposed)" : ""}`; break;
      case "update_node": s = `✎ ${op.id}${op.label ? ` → “${op.label}”` : ""}${op.note ? ` note` : ""}`; break;
      case "remove_node": s = `− ${op.id}`; break;
      case "connect": s = `→ ${op.from} → ${op.to}${op.label ? ` “${op.label}”` : ""}`; break;
      case "disconnect": s = `✂ ${op.edge}`; break;
      case "reroute": s = `↪ ${op.edge} ${op.via ? `via ${op.via}` : `⇒ ${op.new_from || "·"}→${op.new_to || "·"}`}`; break;
      case "mark": s = `⚑ ${op.target} = ${op.status}`; break;
      case "undo": s = `↶ undo ${op.target_src}`; break;
      case "new_board": s = `▣ new tab “${op.title}”`; break;
      case "switch_board": s = `⇄ tab ${op.board}`; break;
      case "add_group": s = `▢ group “${op.label}”`; break;
      case "set_group": s = `▢ ${op.node} ∈ ${op.group}`; break;
      default: s = JSON.stringify(op);
    }
    return esc(s) + by;
  }

  function latClass(ms) { return ms < 1600 ? "fast" : ms < 3500 ? "ok" : "slow"; }

  function addActivity(a, live) {
    S.activity.push(a);
    const div = document.createElement("div");
    const chit = a.agent === "extractor" && a.kind === "chit_chat";
    div.className = `act${chit ? " chit" : ""}`;
    let body = "";
    if (a.agent === "extractor") {
      body = `<span class="kind k-${a.kind}">${KIND_LABEL[a.kind] || a.kind}</span>${a.topic_shift ? ` <span class="kind k-shift">topic shift</span>` : ""}
        ${a.claims && a.claims.length ? `<div class="claims">${a.claims.map(esc).join("<br>")}</div>` : ""}`;
    } else {
      const ops = (a.ops || []).map((o) => `<li>${fmtOp(o)}</li>`).join("");
      const rej = (a.rejected || []).map((r) => `<li class="rej" title="${esc(r.error)}">${fmtOp(r.op || {})} — ${esc(r.error)}</li>`).join("");
      body = `${a.summary ? `<div>${esc(a.summary)}</div>` : ""}${ops || rej ? `<ul class="ops">${ops}${rej}</ul>` : ""}`;
    }
    if (a.error) body += `<div class="err">${esc(a.error)}</div>`;
    div.innerHTML = `<div class="act-head"><span class="agent-tag a-${a.agent}">${a.agent}</span>
      <span class="ids">${(a.utts || []).join(", ")}</span>${a.batched > 1 ? `<span class="batch">batched ×${a.batched}</span>` : ""}
      <span class="lat ${latClass(a.latency_ms)}">${a.latency_ms} ms</span></div><div class="body">${body}</div>`;
    const feed = $("activity");
    feed.prepend(div);
    while (feed.children.length > 160) feed.lastChild.remove();
    updateLatency();
    if (live && a.agent !== "extractor" && (a.ops || []).length) {
      const by = a.ops[a.ops.length - 1].by || a.speaker;
      toast(by, a.summary || `${a.ops.length} change(s)`, a.agent);
    }
  }

  function updateLatency() {
    const agg = {};
    for (const a of S.activity) if (a.latency_ms != null) (agg[a.agent] ||= []).push(a.latency_ms);
    const parts = ["extractor", "modeller", "analyst"].filter((k) => agg[k]).map((k) => {
      const v = agg[k]; return `${k} ${(v.reduce((s, x) => s + x, 0) / v.length / 1000).toFixed(1)}s`;
    });
    $("latencyStats").textContent = parts.length ? `avg · ${parts.join(" · ")}` : "gpt-6-luna";
  }

  function renderLists(qs = [], ds = []) {
    const order = { open: 0, parked: 1, answered: 2, resolved: 2 };
    qs = [...qs].sort((a, b) => order[a.status] - order[b.status]);
    ds = [...ds].sort((a, b) => order[a.status] - order[b.status]);
    $("qCount").textContent = qs.filter((q) => q.status !== "answered").length;
    $("dCount").textContent = ds.filter((d) => d.status === "open").length;
    $("questions").innerHTML = qs.length ? qs.map((q) => `
      <li class="${q.status}"><span class="st st-${q.status}">${q.status}</span>${esc(q.question)}
      <div class="by">asked by <b style="color:${colorOf(q.asked_by)}">${esc(q.asked_by)}</b> · ${esc(q.src)}</div>
      ${q.answer ? `<div class="ans">↳ ${esc(q.answer)}</div>` : ""}</li>`).join("") : `<li class="muted">None yet</li>`;
    $("disagreements").innerHTML = ds.length ? ds.map((d) => `
      <li class="${d.status}"><span class="st st-${d.status}">${d.status}</span><b>${esc(d.topic)}</b>
      ${(d.positions || []).map((p) => `<div class="pos"><b style="color:${colorOf(p.who)}">${esc(p.who)}:</b> ${esc(p.position)}</div>`).join("")}
      ${d.resolution ? `<div class="res">✓ ${esc(d.resolution)}</div>` : ""}</li>`).join("") : `<li class="muted">None yet</li>`;
  }

  function toast(who, text, agent) {
    const t = document.createElement("div");
    t.className = "toast";
    t.style.setProperty("--pc", colorOf(who));
    t.innerHTML = `<b>${esc(who)}</b><span>${esc(text)}</span>`;
    const box = $("toasts");
    box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => t.remove(), 6200);
  }

  // --------------------------------------------------------------- controls
  function setStatus(status, mode, speed) {
    S.status = status; if (mode) S.mode = mode === "idle" ? S.mode : mode;
    if (speed) { S.speed = speed; document.querySelectorAll("#speedSeg button").forEach((b) => b.classList.toggle("on", +b.dataset.speed === +speed)); }
    S.paused = status === "paused";
    const pill = $("statusPill");
    pill.className = "pill";
    const running = status === "running" || status === "paused";
    let txt = "Idle";
    if (status === "running") { pill.classList.add(S.mode === "replay" ? "replay" : "live"); txt = S.mode === "replay" ? "Replay" : "Live · AI"; }
    else if (status === "paused") { pill.classList.add("paused"); txt = "Paused"; }
    else if (status === "finished") { pill.classList.add("finished"); txt = "Meeting ended"; }
    $("statusText").textContent = txt;
    $("btnStart").disabled = running;
    $("btnPause").disabled = !running;
    $("btnPause").textContent = status === "paused" ? "▶ Resume" : "❚❚ Pause";
    if (status === "paused") setSpeaking(null, false);
    if (mode && mode !== "idle") setMode(mode, true);
  }

  function setMode(mode, fromServer) {
    S.mode = mode;
    document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    $("runSelect").hidden = mode !== "replay";
    $("btnStart").textContent = mode === "replay" ? "▶ Play recording" : "▶ Start meeting";
    if (mode === "replay" && !fromServer) loadRuns();
  }

  async function loadRuns() {
    try { fillRuns(await (await fetch("/api/runs")).json()); } catch { /* offline */ }
  }
  function fillRuns(runs = []) {
    const sel = $("runSelect");
    const prev = sel.value;
    sel.innerHTML = `<option value="latest">Latest complete run</option>` + runs.map((r) =>
      `<option value="${esc(r.file)}">${esc(r.file.replace(".json", ""))}${r.complete ? "" : " (partial)"} · ${r.speed}×</option>`).join("");
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }

  document.querySelectorAll("#modeSeg button").forEach((b) => b.addEventListener("click", () => {
    if (S.status === "running" || S.status === "paused") return;
    setMode(b.dataset.mode);
  }));
  document.querySelectorAll("#speedSeg button").forEach((b) => b.addEventListener("click", () => {
    S.speed = +b.dataset.speed;
    document.querySelectorAll("#speedSeg button").forEach((x) => x.classList.toggle("on", x === b));
    if (S.status === "running" || S.status === "paused") send({ cmd: "speed", speed: S.speed });
  }));
  $("btnStart").addEventListener("click", () => {
    send({ cmd: "start", mode: S.mode, run: S.mode === "replay" ? $("runSelect").value : undefined, speed: S.speed });
  });
  $("btnPause").addEventListener("click", () => send({ cmd: S.status === "paused" ? "resume" : "pause" }));
  $("btnReset").addEventListener("click", () => send({ cmd: "reset" }));
  $("btnTidy").addEventListener("click", () => Board.tidy());
  $("btnFit").addEventListener("click", () => Board.fit());
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "SELECT") return;
    if (e.code === "Space") { e.preventDefault(); if (S.status === "running" || S.status === "paused") $("btnPause").click(); else $("btnStart").click(); }
  });

  if (S.autoReplay) setMode("replay");
  renderTabs();
  connect();
})();
