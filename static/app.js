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
    source: "scripted",                       // what the current meeting is: scripted | mic
    mic: { state: "idle", error: null, warning: null, model: null }, micOwner: false,
    approvalMode: "auto", approvals: [],      // auto: agents edit freely | ask: removals wait for an OK
    serverMode: "idle",                       // the session's mode as the server reports it (S.mode is the toggle)
    deciding: new Set(), approvalsSig: null,  // proposals clicked, waiting to leave the list; last rendered panel
  };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
                  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
  const KIND_LABEL = { new_info: "new info", correction: "correction", disagreement: "disagreement", resolution: "resolution", question: "question", undo: "undo", chit_chat: "chit-chat · ignored" };
  const colorOf = (name) => S.colors[name] || "#868e96";
  const initials = (n) => n.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();

  Board.init({
    colorOf, onEmptyChange: (empty) => $("boardEmpty").classList.toggle("hide", !empty),
    layoutSig: (b) => `${shapeSig(b)}|${planSig(b)}`,   // the board's shape and plan, as far as Tidy uses them
  });

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
      case "utterance_final": return onUttFinal(ev.id, ev.text);
      case "utterance_interim": return onUttInterim(ev.id, ev.text);
      case "utterance_drop": return onUttDrop(ev.id);
      case "mic_state": return onMicState(ev);
      case "extraction": return onExtraction(ev);
      case "activity": return addActivity(ev.item, true);
      case "board": return onBoard(ev);
      case "relayout": return onRelayout(ev.boards);
      case "analysis": return renderLists(ev.questions, ev.disagreements);
      case "approval_mode": return setApprovalMode(ev.mode);
      case "approvals": return renderApprovals(ev.pending);
      case "status": setServerMode(ev.mode); return setStatus(ev.status, ev.mode, ev.speed);
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
      if (u.live && !u.done) e.el.classList.add("speaking", "interim");
      if (u.kind) setKind(u.id, u.kind);
    }
    $("activity").replaceChildren(); S.activity = [];
    for (const a of s.activity) addActivity(a, false);
    renderLists(s.questions, s.disagreements);
    S.board = null; S.knownBoards = new Set(); S.followActive = true;
    Board.reset();
    // a board that already has a layout plan is shown laid out by it
    Board.relayout(((s.board && s.board.boards) || []).filter((b) => b.layout).map((b) => b.id));
    onBoard({ board: s.board, silent: true });
    setApprovalMode(s.approval_mode);
    S.deciding.clear(); S.approvalsSig = null; setServerMode(s.mode);
    if (s.mic) S.mic = s.mic; else if (s.mode !== "mic") S.mic = { state: "idle" };
    setStatus(s.status, s.mode, s.speed);
    renderApprovals(s.approvals || []);
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
    S.source = m.source || "scripted";
    $("transcriptSub").textContent = S.source === "mic" ? "live microphone · OpenAI realtime" : "simulated · no audio";
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
    const body = u.live ? esc(u.text) : words.map((w) => `<span class="w${animate ? "" : " on"}">${esc(w)} </span>`).join("");
    div.innerHTML = `<div class="av">${initials(u.speaker)}</div>
      <div><div class="who">${esc(u.speaker)} <span class="uid">${u.id}</span><span class="kinds"></span></div>
      <div class="text">${body}</div></div>`;
    $("transcript").appendChild(div);
    const entry = { el: div, words: [...div.querySelectorAll(".w")], shown: animate ? 0 : words.length, timer: null, speaker: u.speaker, live: !!u.live };
    S.utts.set(u.id, entry);
    scrollTranscript();
    return entry;
  }

  function onUttStart(ev) {
    if (ev.live) {             // talk live: text streams in through utterance_interim events
      const entry = addUtt({ ...ev.utt, live: true }, false);
      entry.el.classList.add("speaking", "interim");
      setSpeaking(ev.utt.speaker, true);
      updateProgress();
      return;
    }
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

  function onUttInterim(id, text) {
    const e = S.utts.get(id); if (!e) return;
    e.el.querySelector(".text").textContent = text;
    scrollTranscript();
  }

  function onUttDrop(id) {
    const e = S.utts.get(id); if (!e) return;
    e.el.remove(); S.utts.delete(id);
    setSpeaking(null, false);
    updateProgress();
  }

  function onUttFinal(id, text) {
    const e = S.utts.get(id); if (!e) return;
    if (e.live) {
      if (text != null) e.el.querySelector(".text").textContent = text;
      e.el.classList.remove("speaking", "interim");
      setSpeaking(null, false);
      scrollTranscript();
      return;
    }
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
    $("uttCount").textContent = S.total ? `${n} / ${S.total} utterances` : `${n} utterance${n === 1 ? "" : "s"}`;
    $("progressBar").style.width = S.total ? `${(100 * n) / S.total}%` : "0";
  }

  // ------------------------------------------------------------------ board
  // consolidator ops that change the structure enough to warrant a full re-layout
  const RESTRUCTURE = new Set(["add_group", "set_group", "remove_node", "reroute"]);
  function restructured(ev) {
    if (ev.agent !== "consolidator" && ev.agent !== "approval") return false;
    const ops = ev.applied || [];
    return ops.some((o) => RESTRUCTURE.has(o.op)) || ops.filter((o) => o.op === "connect" || o.op === "disconnect").length > 2;
  }
  const shapeSig = (b) => JSON.stringify([
    Object.keys(b.nodes).sort().map((id) => `${id}@${b.nodes[id].group || ""}`),
    Object.values(b.edges).map((e) => `${e.from}>${e.to}`).sort(),
  ]);
  // the layout plan, as far as it moves anything (an identical plan must not make the board jump)
  const planSig = (b) => {
    const L = b.layout;
    if (!L) return "";
    return JSON.stringify([L.direction, L.spine, (L.placements || []).map((p) => `${p.node}:${p.side}:${p.anchor}`).sort(),
      (L.groups || []).map((g) => `${g.group}:${g.orientation}`).sort()]);
  };

  function onBoard(ev) {
    const state = ev.board;
    const before = new Map(((S.board && S.board.boards) || []).map((b) => [b.id, b]));
    // re-lay out every board whose shape changed after a consolidator restructuring, or whose
    // layout plan changed (the visible one now, others when shown)
    const stale = state.boards.filter((b) => {
      const old = before.get(b.id);
      if (!old) return false;
      return (restructured(ev) && shapeSig(old) !== shapeSig(b)) || planSig(old) !== planSig(b);
    });
    if (stale.length) Board.relayout(stale.map((b) => b.id));
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
    if (S.approvals.length) renderApprovals(S.approvals);   // labels may have changed (redrawn only if they did)
  }

  // meeting end: one full re-layout of every board that changed since its last layout in this browser (the shown
  // one now, the others when shown), so nodes added after the last plan change follow the plan too; a board that
  // didn't change keeps the layout it has
  function onRelayout(ids = []) {
    Board.relayoutChanged(((S.board && S.board.boards) || []).filter((b) => ids.includes(b.id)));
    const b = S.board && S.board.boards.find((x) => x.id === S.viewBoard);
    if (b) Board.render(b, { silent: true });
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
      renderApprovals(S.approvals);
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

  function fmtPlan(L) {
    const places = (L.placements || []).map((p) => `${p.node} ${p.side} ${p.anchor}`).join(", ");
    return `<div class="plan${L.changed ? "" : " same"}" title="layout plan${L.changed ? "" : " (unchanged)"}">⇢ ${esc(L.direction)}: ${esc((L.spine || []).join(" → ") || "no spine")}${places ? ` · ${esc(places)}` : ""}${L.changed ? "" : " · unchanged"}</div>`;
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
      const held = (a.held || []).map((o) => `<li class="held" title="waiting for approval">⏸ ${fmtOp(o)} — awaiting approval</li>`).join("");
      body = `${a.summary ? `<div>${esc(a.summary)}</div>` : ""}${ops || rej || held ? `<ul class="ops">${ops}${held}${rej}</ul>` : ""}`;
      if (a.layout) body += fmtPlan(a.layout);
    }
    if (a.error) body += `<div class="err">${esc(a.error)}</div>`;
    div.innerHTML = `<div class="act-head"><span class="agent-tag a-${a.agent}">${a.agent}</span>
      <span class="ids">${(a.utts || []).join(", ")}</span>${a.batched > 1 ? `<span class="batch">batched ×${a.batched}</span>` : ""}
      ${a.latency_ms != null ? `<span class="lat ${latClass(a.latency_ms)}">${a.latency_ms} ms</span>` : ""}</div><div class="body">${body}</div>`;
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
    const parts = ["extractor", "modeller", "consolidator", "analyst"].filter((k) => agg[k]).map((k) => {
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

  // -------------------------------------------------------------- approvals
  function setApprovalMode(mode) {
    S.approvalMode = mode || "auto";
    document.querySelectorAll("#approvalSeg button").forEach((b) => b.classList.toggle("on", b.dataset.approval === S.approvalMode));
  }

  // a replay shows proposals read-only; a live or talk-live session (also after it ended) can decide them
  function setServerMode(mode) {
    if (!mode || mode === S.serverMode) return;
    S.serverMode = mode;
    renderApprovals(S.approvals);
  }

  function renderApprovals(pending = []) {
    S.approvals = pending;
    const ids = new Set(pending.map((p) => p.id));
    for (const id of S.deciding) if (!ids.has(id)) S.deciding.delete(id);   // decided: it left the list
    const canDecide = S.serverMode === "live" || S.serverMode === "mic";
    const boardOf = (id) => (S.board && S.board.boards.find((b) => b.id === id)) || null;
    const tabTitle = (id) => (boardOf(id) || {}).title || id;
    const targets = (p) => p.targets || [p.target];
    const labelOf = (p, t) => ((boardOf(p.board) || { nodes: {} }).nodes[t] || {}).label || p.label;
    // redraw only when what the panel shows changed (board events come with every modeller op)
    const sig = JSON.stringify([canDecide, S.viewBoard, [...S.deciding], pending.map((p) => [p.id, targets(p).map((t) => labelOf(p, t))])]);
    if (sig === S.approvalsSig) return;
    S.approvalsSig = sig;
    Board.setPending(pending);
    const box = $("approvals");
    box.hidden = !pending.length;
    if (!pending.length) { box.replaceChildren(); return; }
    const quote = (x) => `<b>“${esc(x)}”</b>`;
    const what = (p) => p.kind === "merge"
      ? `Merge ${targets(p).map((t) => quote(labelOf(p, t))).join(" + ")} into ${(p.into || []).map(quote).join(", ")}`
      : `Remove ${quote(labelOf(p, p.target))} <span class="muted">${esc(p.type)}</span>`;
    const busy = (p) => S.deciding.has(p.id) ? "disabled" : "";
    box.innerHTML = `
      <div class="appr-head"><span>✋ Waiting for your OK</span><span class="count">${pending.length}</span>
        ${canDecide && pending.length > 1 ? `<button class="btn tiny" data-id="*" data-approve="1" ${S.deciding.size ? "disabled" : ""}>Apply all</button>
          <button class="btn tiny ghost" data-id="*" data-approve="0" ${S.deciding.size ? "disabled" : ""}>Keep all</button>` : ""}</div>
      ${pending.map((p) => `
        <div class="appr">
          <div class="appr-what">${what(p)}${p.edges ? ` <span class="muted">· ${p.edges} connection${p.edges === 1 ? "" : "s"}</span>` : ""}</div>
          <div class="appr-why"><span class="agent-tag a-${esc(p.agent)}">${esc(p.agent)}</span>
            ${p.by ? `<b style="color:${colorOf(p.by)}">${esc(p.by)}</b>` : ""} <span class="ids">${esc(p.src || "")}</span>
            ${p.board !== S.viewBoard ? `<span class="muted">on “${esc(tabTitle(p.board))}”</span>` : ""}</div>
          ${canDecide ? `<div class="appr-btns"><button class="btn tiny danger" data-id="${esc(p.id)}" data-approve="1" ${busy(p)}>${p.kind === "merge" ? "Merge" : "Remove"}</button>
            <button class="btn tiny" data-id="${esc(p.id)}" data-approve="0" ${busy(p)}>Keep</button></div>` : ""}
        </div>`).join("")}`;
    box.querySelectorAll("button[data-id]").forEach((b) => b.addEventListener("click", () => {
      if (!S.ws || S.ws.readyState !== 1) return toast("System", "Not connected to the server");
      // stays disabled until the proposal leaves the list (a board event may come before the approvals one)
      for (const p of S.approvals) if (b.dataset.id === "*" || b.dataset.id === p.id) S.deciding.add(p.id);
      send({ cmd: "approval", id: b.dataset.id, approve: b.dataset.approve === "1" });
      renderApprovals(S.approvals);
    }));
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
    if (status === "running") {
      pill.classList.add(S.mode === "replay" ? "replay" : "live");
      txt = S.mode === "replay" ? "Replay" : S.mode === "mic" ? (S.mic.state === "listening" ? "Talk live · REC" : "Talk live") : "Live · AI";
    }
    else if (status === "paused") { pill.classList.add("paused"); txt = "Paused"; }
    else if (status === "finished") { pill.classList.add("finished"); txt = "Meeting ended"; }
    $("statusText").textContent = txt;
    $("btnStart").disabled = running;
    $("btnPause").disabled = !running;
    $("btnPause").textContent = status === "paused" ? "▶ Resume" : "❚❚ Pause";
    if (status === "paused") setSpeaking(null, false);
    if (mode && mode !== "idle") setMode(mode, true);
    updateMicUI();
  }

  function setMode(mode, fromServer) {
    S.mode = mode;
    document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    $("runSelect").hidden = mode !== "replay";
    $("btnStart").textContent = mode === "replay" ? "▶ Play recording" : "▶ Start meeting";
    $("micBox").hidden = mode !== "mic";
    $("speedSeg").hidden = mode === "mic";
    $("btnPause").hidden = mode === "mic";
    if (!S.utts.size) {
      $("transcriptEmpty").innerHTML = mode === "mic"
        ? "Press <b>Start talking</b> and describe what you are designing, out loud. Your words appear here as you speak, and the whiteboard draws itself from them."
        : "Press <b>Start meeting</b>. Four people will brainstorm the FreshBite order flow, and the whiteboard will draw itself as they talk.";
    }
    if (mode === "replay" && !fromServer) loadRuns();
    updateMicUI();
  }

  // -------------------------------------------------------------- talk live
  const MIC_TEXT = { idle: "Mic off", connecting: "Connecting…", listening: "Listening", stopping: "Finishing…", stopped: "Mic off", error: "Mic stopped" };

  function onMicState(ev) {
    S.mic = { ...S.mic, ...ev };
    if (ev.state === "error" && ev.error) showMicError(ev.error);
    else if (ev.state === "listening") showMicError(ev.warning ? `Note: ${ev.warning}` : null);
    if (ev.state === "stopped" || ev.state === "error") S.micOwner = false;
    setStatus(S.status, S.mode, null);
  }

  function showMicError(msg) {
    $("micErr").hidden = !msg;
    $("micErr").textContent = msg || "";
  }

  function updateMicUI() {
    if (S.mode !== "mic") return;
    const running = S.status === "running";
    const st = running ? (S.mic.state || "idle") : "idle";
    const btn = $("btnStart");
    $("micRec").className = `rec rec-${st}`;
    $("micStateText").textContent = MIC_TEXT[st] || st;
    $("micName").disabled = $("micTopic").disabled = running || canContinue();
    const canMute = st === "listening" && S.micOwner && Mic.active;
    const muted = canMute && Mic.muted;
    $("btnMute").hidden = !canMute;
    $("btnMute").textContent = muted ? "🎙 Unmute" : "🔇 Mute";
    if (muted) { $("micRec").className = "rec rec-muted"; $("micStateText").textContent = "Muted"; }
    if (!running) {
      btn.disabled = false;
      btn.textContent = canContinue() ? "🎙 Continue talking" : "🎙 Start talking";
      if (canContinue()) $("micStateText").textContent = "Stopped · board kept";
      return;
    }
    if (st === "error") { btn.disabled = false; btn.textContent = "↻ Reconnect mic"; return; }
    if (st === "stopping") { btn.disabled = true; btn.textContent = "Finishing…"; return; }
    if (st === "connecting" || st === "listening") {
      btn.disabled = !S.micOwner;       // only the browser that owns the mic can stop it
      btn.textContent = "■ Stop";
      return;
    }
    btn.disabled = true; btn.textContent = "Finishing…";
  }

  function setLevel(rms) {
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    $("micLevel").style.width = `${pct}%`;
    $("micLevel").classList.toggle("hot", pct > 92);
  }

  // a stopped talk-live session can be continued on the same board (Reset starts fresh)
  function canContinue() { return S.mode === "mic" && S.status === "finished" && S.utts.size > 0; }

  async function micClick() {
    const running = S.status === "running";
    if (running && (S.mic.state === "listening" || S.mic.state === "connecting")) { Mic.stop(); return; }
    const resume = (running && S.mic.state === "error") || canContinue();
    const speaker = $("micName").value.trim() || "You";
    const topic = $("micTopic").value.trim();
    store.set("lw.micName", $("micName").value.trim()); store.set("lw.micTopic", topic);
    showMicError(null);
    $("btnStart").disabled = true;
    $("micStateText").textContent = "Allow the microphone…";   // the browser permission prompt may be open
    const ok = await Mic.start({ speaker, topic, resume }, {
      onState: (ev) => onMicState(ev),
      onLevel: (rms) => setLevel(rms),
      onError: (msg) => { S.micOwner = false; showMicError(msg); setLevel(0); updateMicUI(); },
    });
    S.micOwner = ok;
    updateMicUI();
  }

  async function loadRuns() {
    try { fillRuns(await (await fetch("/api/runs")).json()); } catch { /* offline */ }
  }
  function fillRuns(runs = []) {
    const sel = $("runSelect");
    const prev = sel.value;
    sel.innerHTML = `<option value="latest">Latest complete run</option>` + runs.map((r) =>
      `<option value="${esc(r.file)}">${r.source === "mic" ? "🎙 " : ""}${esc(r.file.replace(".json", ""))}${r.complete ? "" : " (partial)"}${r.source === "mic" ? "" : ` · ${r.speed}×`}</option>`).join("");
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
    if (S.mode === "mic") return micClick();
    send({ cmd: "start", mode: S.mode, run: S.mode === "replay" ? $("runSelect").value : undefined, speed: S.speed });
  });
  $("micName").value = store.get("lw.micName") || "";
  $("micTopic").value = store.get("lw.micTopic") || "";
  $("btnPause").addEventListener("click", () => send({ cmd: S.status === "paused" ? "resume" : "pause" }));
  $("btnReset").addEventListener("click", () => {
    if (S.utts.size > 0 && S.mode !== "replay" && !confirm("Clear the whiteboard and transcript and start fresh?")) return;
    send({ cmd: "reset" });
  });
  function toggleMute() {
    if ($("btnMute").hidden) return;
    Mic.setMuted(!Mic.muted);
    updateMicUI();
  }
  $("btnMute").addEventListener("click", toggleMute);
  // Focus: hide setup fields, hint and participants so the transcript gets the space (remembered per browser)
  function setFocus(on) {
    document.querySelector(".panel.meeting").classList.toggle("focus", on);
    $("btnFocus").textContent = on ? "⤓ Show details" : "⤒ Focus";
    store.set("lw.focus", on ? "1" : "");
  }
  $("btnFocus").addEventListener("click", () => setFocus(!document.querySelector(".panel.meeting").classList.contains("focus")));
  setFocus(store.get("lw.focus") === "1");
  $("btnTidy").addEventListener("click", () => Board.tidy());
  document.querySelectorAll("#approvalSeg button").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.approval !== S.approvalMode) send({ cmd: "approval_mode", mode: b.dataset.approval });
  }));
  $("btnFit").addEventListener("click", () => Board.fit());
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
    if (S.mode === "mic") {              // no space-bar shortcut while talking live; M toggles mute
      if (e.code === "KeyM" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); toggleMute(); }
      return;
    }
    if (e.code === "Space") { e.preventDefault(); if (S.status === "running" || S.status === "paused") $("btnPause").click(); else $("btnStart").click(); }
  });

  if (S.autoReplay) setMode("replay");
  renderTabs();
  connect();
})();
