/* Live Whiteboard UI: WebSocket client, meeting panel, tabs, agent feed. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const params = new URLSearchParams(location.search);
  // an icon from the sprite in index.html (#i-<name>), optionally followed by a label
  const ico = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const setLabel = (el, name, text) => { el.innerHTML = (name ? ico(name) : "") + esc(text); };

  const S = {
    ws: null, mode: "mic", status: "idle", speed: 1,
    participants: [], colors: {}, total: 0,
    board: null, viewBoard: null, followActive: true, knownBoards: new Set(),
    utts: new Map(), activity: [], paused: false, autoReplay: params.get("replay"),
    source: "idle",                           // what the current meeting is: idle (none yet) | scripted | mic | teams
    meetingTitle: "",  // the server's title, used in export filenames
    mic: { state: "idle", error: null, warning: null, model: null }, micOwner: false,
    approvalMode: "auto", approvals: [],      // auto: agents edit freely | ask: removals wait for an OK
    serverMode: "idle",                       // the session's mode as the server reports it (S.mode is the toggle)
    deciding: new Set(), approvalsSig: null,  // proposals clicked, waiting to leave the list; last rendered panel
    summary: null, summaryWriting: false,     // {title, markdown, filename}, written when the meeting ends
    bot: { state: "idle", error: null },     // the Teams meeting bot
  };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
                  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
  const KIND_LABEL = { new_info: "new info", correction: "correction", disagreement: "disagreement", resolution: "resolution", question: "question", undo: "undo", chit_chat: "chit-chat · ignored" };
  const colorOf = (name) => S.colors[name] || "#868e96";
  const initials = (n) => n.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();

  Board.init({
    colorOf, onEmptyChange: (empty) => $("boardEmpty").classList.toggle("hide", !empty),
    layoutSig: (b) => `${shapeSig(b)}|${planSig(b)}|${ownerSig(b)}`,   // the board's shape and plan, as far as Tidy uses them
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
      case "bot_state": return onBotState(ev);
      case "extraction": return onExtraction(ev);
      case "activity": return addActivity(ev.item, true);
      case "board": return onBoard(ev);
      case "relayout": return onRelayout(ev.boards);
      case "analysis": return renderLists(ev.questions, ev.disagreements);
      case "approval_mode": return setApprovalMode(ev.mode);
      case "approvals": return renderApprovals(ev.pending);
      case "summary_writing":
        S.summaryWriting = true; setSummaryItem(); return toast("System", "Writing the meeting summary…");
      case "summary": toast("System", "Meeting summary ready. Find it under Export"); return setSummary(ev.summary);
      case "status": setServerMode(ev.mode); return setStatus(ev.status, ev.mode, ev.speed);
      case "run_saved":   // saved after the summary, so writing it is over (done or failed)
        S.summaryWriting = false; setSummaryItem();
        toast("System", `Run recorded → runs/${ev.file}. Replay it with ?replay=latest`); return loadRuns();
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
    S.summaryWriting = false; setSummary(s.summary);
    S.board = null; S.knownBoards = new Set(); S.followActive = true;
    Board.reset();
    // a board that already has a layout plan is shown laid out by it
    Board.relayout(((s.board && s.board.boards) || []).filter((b) => b.layout).map((b) => b.id));
    onBoard({ board: s.board, silent: true });
    setApprovalMode(s.approval_mode);
    S.deciding.clear(); S.approvalsSig = null; setServerMode(s.mode);
    S.bot = s.bot || { state: "idle", error: null };
    if (s.mic) S.mic = s.mic; else if (s.mode !== "mic") S.mic = { state: "idle" };
    setStatus(s.status, s.mode, s.speed);
    renderApprovals(s.approvals || []);
    fillRuns(s.runs);
    setFeedback(s.feedback_url);
    updateProgress();
    if (S.autoReplay && (s.status === "idle" || s.status === "finished")) {
      setMode("replay");
      send({ cmd: "start", mode: "replay", run: S.autoReplay, speed: S.speed });
      S.autoReplay = null;
    }
  }

  // --------------------------------------------------------------- feedback
  // The button opens the team's anonymous form (LW_FEEDBACK_URL; hidden without one). Nothing pops up over the work:
  // once a live meeting has ended (once per page) a callout points at the button ("How was it?") and its dot pulses,
  // until the form is opened, the callout is dismissed, or the next meeting starts.
  function setFeedback(url) {
    S.feedbackUrl = url || null;
    $("btnFeedback").hidden = !S.feedbackUrl;
  }
  function nudgeFeedback(on) {
    if (on && (S.feedbackNudged || !S.feedbackUrl)) return;
    if (on) S.feedbackNudged = true;
    $("btnFeedback").classList.toggle("nudge", on);
    $("feedbackCallout").hidden = !on;
  }
  function openFeedback() {
    if (S.feedbackUrl) window.open(S.feedbackUrl, "_blank", "noopener");
    nudgeFeedback(false);
  }
  $("btnFeedback").title = "Feedback or a feature request? Opens a short anonymous form (your name isn't recorded)";
  $("btnFeedback").addEventListener("click", openFeedback);
  $("feedbackCalloutGo").addEventListener("click", openFeedback);
  $("feedbackCalloutClose").addEventListener("click", () => nudgeFeedback(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") nudgeFeedback(false); });

  // ---------------------------------------------------------------- meeting
  function setMeeting(m) {
    if (!m) return;
    S.meetingTitle = m.title;
    S.source = m.source || "scripted";
    renderTranscriptSub();
    S.total = m.total || 0;
    S.participants = m.participants;
    for (const p of m.participants) S.colors[p.name] = p.color;
    $("participants").innerHTML = m.participants.map((p) => `
      <div class="person" id="p-${esc(p.name)}" style="--pc:${p.color}">
        <div class="avatar">${initials(p.name)}</div>
        <div><div class="name">${esc(p.name)} <span class="bars"><i></i><i></i><i></i></span></div>
        <div class="role">${esc(p.role)}</div></div>
      </div>`).join("");
    renderMeetingHead();
    updateProgress();
  }

  // The server's meeting only changes when one starts, so before that the mode toggle can point
  // at a different kind of meeting (e.g. Talk live while the FreshBite one is loaded). Until it
  // starts, hide the other meeting's participants.
  // where the transcript comes from; before a meeting (and after Reset) it describes the chosen mode
  function renderTranscriptSub() {
    const kind = S.source === "idle" ? S.mode : S.source;
    $("transcriptSub").textContent = { mic: "live microphone · OpenAI realtime", teams: "Teams meeting · Attendee bot",
                                       replay: "recorded meeting" }[kind] || "simulated · no audio";
  }

  function renderMeetingHead() {
    const started = S.status === "running" || S.status === "paused";
    const matches = started || (S.mode === "replay" ? S.serverMode === "replay" : (S.mode === "mic") === (S.source === "mic"));
    $("participants").hidden = !matches;
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
    $("uttCountRail").textContent = n;
    $("uttCount").textContent = S.total ? `${n} / ${S.total} utterances` : `${n} utterance${n === 1 ? "" : "s"}`;
    $("progressBar").style.width = S.total ? `${(100 * n) / S.total}%` : "0";
  }

  // ------------------------------------------------------------------ board
  // consolidator ops that change the structure enough to warrant a full re-layout
  const RESTRUCTURE = new Set(["add_group", "add_task_list", "set_group", "remove_node", "reroute"]);
  function restructured(ev) {
    if (ev.agent !== "consolidator" && ev.agent !== "approval") return false;
    const ops = ev.applied || [];
    return ops.some((o) => RESTRUCTURE.has(o.op)) || ops.filter((o) => o.op === "connect" || o.op === "disconnect").length > 2;
  }
  const shapeSig = (b) => JSON.stringify([
    Object.keys(b.nodes).sort().map((id) => `${id}@${b.nodes[id].group || ""}`),
    Object.values(b.edges).map((e) => `${e.from}>${e.to}`).sort(),
  ]);
  // which actor each task list belongs to: an owned list is laid out next to its owner
  const ownerSig = (b) => JSON.stringify(Object.values(b.groups || {}).filter((g) => g.owner).map((g) => `${g.id}:${g.owner}`).sort());
  // a task that changed list (assigning moves it into its assignee's list): its old place no longer fits
  const taskMoved = (old, b) => Object.values(b.nodes).some((n) => n.type === "task" && old.nodes[n.id] && (old.nodes[n.id].group || "") !== (n.group || ""));
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
      return (restructured(ev) && shapeSig(old) !== shapeSig(b)) || planSig(old) !== planSig(b) || ownerSig(old) !== ownerSig(b) || taskMoved(old, b);
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
      case "add_node": s = `+ ${op.type} “${op.label}”${op.assignee ? ` @${op.assignee}` : ""}${op.status === "ghost" ? " (proposed)" : ""}`; break;
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
      case "add_task_list": s = `☑ task list “${op.label}”${op.owner ? ` @${op.owner}` : ""}`; break;
      case "complete_task": s = `☑ done: ${op.node}`; break;
      case "reopen_task": s = `☐ reopened: ${op.node}`; break;
      case "assign": s = op.assignee ? `@ ${op.node} → ${op.assignee}` : `@ ${op.node} unassigned`; break;
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
    const nq = qs.filter((q) => q.status !== "answered").length, nd = ds.filter((d) => d.status === "open").length;
    // while the right panel is collapsed, flash its rail when something new needs attention
    if (isCollapsed("right") && (nq > +$("qCountRail").textContent || nd > +$("dCountRail").textContent)) {
      const rail = $("btnRailRight");
      rail.classList.remove("ping"); void rail.offsetWidth; rail.classList.add("ping");
    }
    $("qCount").textContent = $("qCountRail").textContent = nq;
    $("dCount").textContent = $("dCountRail").textContent = nd;
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

  // a replay shows proposals read-only; a live, talk-live or Teams session (also after it ended) can decide them
  function setServerMode(mode) {
    if (!mode || mode === S.serverMode) return;
    S.serverMode = mode;
    renderApprovals(S.approvals);
  }

  function renderApprovals(pending = []) {
    S.approvals = pending;
    const ids = new Set(pending.map((p) => p.id));
    for (const id of S.deciding) if (!ids.has(id)) S.deciding.delete(id);   // decided: it left the list
    const canDecide = ["live", "mic", "teams"].includes(S.serverMode);
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
      <div class="appr-head"><span>${ico("hand")}Waiting for your OK</span><span class="count">${pending.length}</span>
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
    const was = S.status;
    S.status = status; if (mode) S.mode = mode === "idle" ? S.mode : mode;
    if ((was === "running" || was === "paused") && status === "finished" && S.mode !== "replay") nudgeFeedback(true);
    else if (status === "running") nudgeFeedback(false);
    if (speed) { S.speed = speed; document.querySelectorAll("#speedSeg button").forEach((b) => b.classList.toggle("on", +b.dataset.speed === +speed)); }
    S.paused = status === "paused";
    const pill = $("statusPill");
    pill.className = "pill";
    const running = status === "running" || status === "paused";
    document.querySelector(".panel.meeting").classList.toggle("in-meeting", running);
    // with no meeting there is nothing to focus on (and the setup fields stay visible anyway)
    $("btnFocus").disabled = status === "idle";
    $("btnFocus").title = status === "idle" ? "Focus works once a meeting has started"
      : "Hide setup and participants to focus on the transcript";
    let txt = "Idle";
    if (status === "running") {
      pill.classList.add(S.mode === "replay" ? "replay" : "live");
      txt = S.mode === "replay" ? "Replay" : S.mode === "mic" ? (S.mic.state === "listening" ? "Talk live · REC" : "Talk live")
        : S.mode === "teams" ? ({ in_meeting: "Teams · in meeting", paused: "Teams · paused" }[S.bot.state] || "Teams") : "Live · AI";
    }
    else if (status === "paused") { pill.classList.add("paused"); txt = "Paused"; }
    else if (status === "finished") { pill.classList.add("finished"); txt = "Meeting ended"; }
    $("statusText").textContent = txt;
    $("btnStart").disabled = running;
    $("btnPause").disabled = !running;
    setLabel($("btnPause"), status === "paused" ? "play" : "pause", status === "paused" ? "Resume" : "Pause");
    if (status === "paused") setSpeaking(null, false);
    if (mode && mode !== "idle") setMode(mode, true);
    renderMeetingHead();
    if (running) S.summaryWriting = false;
    setSummaryItem();
    updateMicUI();
    updateTeamsUI();
  }

  function setMode(mode, fromServer) {
    S.mode = mode;
    renderMeetingHead();
    renderTranscriptSub();
    document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    $("runSelect").hidden = mode !== "replay";
    setLabel($("btnStart"), "play", mode === "replay" ? "Play recording" : "Start meeting");
    $("micBox").hidden = mode !== "mic";
    $("teamsBox").hidden = mode !== "teams";
    $("btnStart").hidden = mode === "teams";        // Teams joins from its own panel (Join meeting next to the link)
    $("speedSeg").hidden = mode === "mic" || mode === "teams";
    $("btnPause").hidden = mode === "mic" || mode === "teams";
    if (!S.utts.size) {
      $("transcriptEmpty").innerHTML = mode === "teams"
        ? "Paste a Teams meeting link and press <b>Join meeting</b>. A bot joins (admit it from the lobby), and the whiteboard draws itself from what everyone says."
        : mode === "mic"
        ? "Press <b>Start talking</b> and describe what you are designing, out loud. Your words appear here as you speak, and the whiteboard draws itself from them."
        : "Press <b>Start meeting</b>. Four people will brainstorm the FreshBite order flow, and the whiteboard will draw itself as they talk.";
    }
    if (mode === "replay" && !fromServer) loadRuns();
    updateMicUI();
    updateTeamsUI();
  }

  // ---------------------------------------------------------- Teams meeting
  const BOT_TEXT = { idle: "Bot not started", creating: "Starting the bot…", joining: "Joining the meeting…",
                     waiting_room: "Waiting in the lobby · admit “{bot}”", in_meeting: "In the meeting",
                     paused: "Paused · not listening",
                     leaving: "Leaving…", ended: "Bot left", error: "Bot stopped" };

  function onBotState(ev) {
    S.bot = { ...S.bot, ...ev };
    setStatus(S.status, S.mode, null);
  }

  function updateTeamsUI() {
    if (S.mode !== "teams") return;
    const running = S.status === "running";
    const st = running || S.status === "finished" ? (S.bot.state || "idle") : "idle";
    const name = S.bot.bot_name || "the bot";   // the server sends the name (LW_ATTENDEE_BOT_NAME)
    $("botRec").className = `rec rec-${st}`;
    const room = S.bot.breakout_room;
    $("botStateText").textContent = st === "joining" && room
      ? `Joining · moves to “${room}” when it opens`
      : (BOT_TEXT[st] || st).replace("{bot}", name);
    $("botName").textContent = name;
    $("botErr").hidden = !S.bot.error;
    $("botErr").textContent = S.bot.error || "";
    $("teamsUrl").disabled = $("teamsRoom").disabled = running;
    syncUrlClear();
    // once the bot is on its way the panel shrinks to the status row and Stop; the link comes back afterwards
    $("teamsFields").hidden = $("botHint").hidden = running;
    $("btnTeamsPause").hidden = !running || (st !== "in_meeting" && st !== "paused");
    setLabel($("btnTeamsPause"), st === "paused" ? "play" : "pause", st === "paused" ? "Resume" : "Pause");
    const btn = $("btnTeamsJoin");
    if (!running) {
      btn.disabled = !!S.bot.error && st === "idle";      // missing Attendee settings: nothing to start yet
      setLabel(btn, "users", S.status === "finished" ? "Join another meeting" : "Join meeting");
      return;
    }
    btn.disabled = st === "leaving";
    setLabel(btn, "stop", "Stop");
  }

  function syncUrlClear() {
    $("teamsUrlClear").hidden = !$("teamsUrl").value || $("teamsUrl").disabled;
  }

  function teamsClick() {
    if (S.status === "running") { send({ cmd: "stop" }); return; }
    const url = $("teamsUrl").value.trim();
    const room = $("teamsRoom").value.trim();
    store.set("lw.teamsUrl", url);   // the room is not remembered: a stale one would make the bot wait for it
    send({ cmd: "start", mode: "teams", meeting_url: url, breakout_room: room || null });   // no topic: the agents infer it from the talk
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
    setLabel($("btnMute"), muted ? "mic" : "mic-off", muted ? "Unmute" : "Mute");
    if (muted) { $("micRec").className = "rec rec-muted"; $("micStateText").textContent = "Muted"; }
    if (!running) {
      btn.disabled = false;
      setLabel(btn, "mic", canContinue() ? "Continue talking" : "Start talking");
      if (canContinue()) $("micStateText").textContent = "Stopped · board kept";
      return;
    }
    if (st === "error") { btn.disabled = false; setLabel(btn, "refresh", "Reconnect mic"); return; }
    if (st === "stopping") { btn.disabled = true; btn.textContent = "Finishing…"; return; }
    if (st === "connecting" || st === "listening") {
      btn.disabled = !S.micOwner;       // only the browser that owns the mic can stop it
      setLabel(btn, "stop", "Stop");
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
      `<option value="${esc(r.file)}">${r.source === "mic" ? "Talk live · " : ""}${esc(r.file.replace(".json", ""))}${r.complete ? "" : " (partial)"}${r.source === "mic" ? "" : ` · ${r.speed}×`}</option>`).join("");
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
    if (S.mode !== "live" && S.mode !== "replay") return;   // Teams joins from its panel; never start an unknown mode
    send({ cmd: "start", mode: S.mode, run: S.mode === "replay" ? $("runSelect").value : undefined, speed: S.speed });
  });
  $("micName").value = store.get("lw.micName") || "";
  $("micTopic").value = store.get("lw.micTopic") || "";
  $("teamsUrl").value = store.get("lw.teamsUrl") || "";
  syncUrlClear();
  // the remembered link is selected when you click into it, so a pasted link replaces it; a second click edits
  $("teamsUrl").addEventListener("mousedown", (e) => {
    if (document.activeElement === e.target || !e.target.value) return;
    e.preventDefault(); e.target.focus();
  });
  $("teamsUrl").addEventListener("focus", (e) => e.target.select());
  $("teamsUrl").addEventListener("input", syncUrlClear);
  $("teamsUrlClear").addEventListener("click", () => {
    $("teamsUrl").value = "";
    store.set("lw.teamsUrl", "");   // a reload starts empty too
    syncUrlClear();
    $("teamsUrl").focus();
  });
  $("btnTeamsJoin").addEventListener("click", teamsClick);
  $("btnTeamsPause").addEventListener("click", () => send({ cmd: "listen", on: S.bot.state === "paused" }));
  $("teamsUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !$("btnTeamsJoin").disabled && S.status !== "running") { e.preventDefault(); teamsClick(); }
  });
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
  // Focus: hide participants, and during a meeting the setup fields and hint, so the transcript gets the space
  // (remembered per browser)
  function setFocus(on) {
    document.querySelector(".panel.meeting").classList.toggle("focus", on);
    setLabel($("btnFocus"), on ? "download" : "focus", on ? "Show details" : "Focus");
    store.set("lw.focus", on ? "1" : "");
  }
  $("btnFocus").addEventListener("click", () => setFocus(!document.querySelector(".panel.meeting").classList.contains("focus")));
  setFocus(store.get("lw.focus") === "1");
  // Collapse a side panel to a rail so the diagram gets its room (each side remembered per browser;
  // the right one keeps the old Expand key); the board re-fits itself as it resizes
  const COLLAPSE_KEY = { left: "lw.collapsedLeft", right: "lw.expanded" };
  function isCollapsed(side) { return document.querySelector(".layout").classList.contains(`collapsed-${side}`); }
  function setCollapsed(side, on) {
    document.querySelector(".layout").classList.toggle(`collapsed-${side}`, on);
    if (on && side === "right") $("btnRailRight").classList.remove("ping");
    store.set(COLLAPSE_KEY[side], on ? "1" : "");
    const both = isCollapsed("left") && isCollapsed("right");
    setLabel($("btnExpand"), both ? "columns" : "expand", both ? "Show panels" : "Expand");
  }
  // Expand collapses both panels; once both are collapsed it brings both back
  function toggleExpand() {
    const on = !(isCollapsed("left") && isCollapsed("right"));
    setCollapsed("left", on); setCollapsed("right", on);
  }
  $("btnExpand").addEventListener("click", toggleExpand);
  $("btnCollapseLeft").addEventListener("click", () => setCollapsed("left", true));
  $("btnCollapseRight").addEventListener("click", () => setCollapsed("right", true));
  $("btnRailLeft").addEventListener("click", () => setCollapsed("left", false));
  $("btnRailRight").addEventListener("click", () => setCollapsed("right", false));
  setCollapsed("left", store.get(COLLAPSE_KEY.left) === "1");
  setCollapsed("right", store.get(COLLAPSE_KEY.right) === "1");
  $("btnTidy").addEventListener("click", () => Board.tidy());
  document.querySelectorAll("#approvalSeg button").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.approval !== S.approvalMode) send({ cmd: "approval_mode", mode: b.dataset.approval });
  }));
  $("btnFit").addEventListener("click", () => Board.fit());

  // Export menu: images of the shown board are made here (positions exist only in this browser);
  // JSON and Mermaid of all boards come from the server (/api/export/*).
  const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "whiteboard";
  function exportName(ext) {
    const b = S.board && S.board.boards.find((x) => x.id === S.viewBoard);
    return `${slug(S.meetingTitle)}-${slug(b && b.title)}.${ext}`;
  }
  async function fetchExport(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.blob();
  }
  function setExportMenu(open) {
    $("exportMenu").hidden = !open;
    $("btnExport").setAttribute("aria-expanded", open);
    // Only PNG exports the board on screen; the rest cover all boards, and the server reports when all are empty
    const empty = !$("boardEmpty").classList.contains("hide");
    $("exportMenu").querySelectorAll("[data-export]").forEach((b) => {
      b.disabled = b.dataset.export === "png" && empty;
    });
    if (spec.busy) $("btnSpec").disabled = true;
    setSummaryItem();
  }

  // Generated spec: one request at a time (the server refuses a second one too); shown in a modal
  const spec = { busy: false, markdown: "", filename: "spec.md" };
  async function generateSpec() {
    spec.busy = true;
    $("btnSpec").firstElementChild.innerHTML = `<svg class="i spin" aria-hidden="true"><use href="#i-loader"/></svg>Generating spec…`;
    toast("System", "Writing the spec from the boards and the transcript…");
    try {
      const r = await fetch("/api/export/spec", { method: "POST" });
      const res = await r.json().catch(() => ({ ok: false, error: `${r.status} ${r.statusText}` }));
      if (!res.ok) return toast("System", res.error || "Spec generation failed");
      openSpec(res);
    } finally {
      spec.busy = false;
      setLabel($("btnSpec").firstElementChild, "sparkles", "Generate spec…");
    }
  }
  function openSpec({ title, markdown, filename }) {
    Object.assign(spec, { markdown, filename });
    $("specTitle").textContent = title;
    $("specBody").textContent = markdown;
    $("specModal").hidden = false;
  }
  // Meeting-end summary (recorded, so replay has it too): Export -> Meeting summary opens it in the spec modal.
  // Disabled until one exists; a continued talk-live meeting makes it out of date (the server drops it too).
  function setSummary(summary) {
    S.summary = summary || null;
    if (S.summary) S.summaryWriting = false;
    setSummaryItem();
  }
  function setSummaryItem() {
    const running = S.status === "running" || S.status === "paused";
    const ready = !!S.summary && !running;
    $("btnSummary").disabled = !ready;
    $("btnSummary").lastElementChild.textContent = ready ? "whole meeting" : S.summaryWriting ? "writing…" : "after the meeting";
  }
  const closeSpec = () => { $("specModal").hidden = true; };
  $("specClose").addEventListener("click", closeSpec);
  $("specModal").addEventListener("click", (e) => { if (e.target === $("specModal")) closeSpec(); });
  $("specDownload").addEventListener("click", () =>
    BoardExport.download(new Blob([spec.markdown], { type: "text/markdown" }), spec.filename));
  $("specCopy").addEventListener("click", async () => {
    try {  // navigator.clipboard is missing over plain http:// on a LAN IP
      await navigator.clipboard.writeText(spec.markdown);
      toast("System", "Copied as Markdown");
    } catch (e) {
      console.error(e);
      toast("System", "Couldn't copy here. Use Download instead");
    }
  });
  async function runExport(kind) {
    setExportMenu(false);
    try {
      const meeting = slug(S.meetingTitle);
      if (kind === "png") {
        const blob = await BoardExport.png();
        if (!blob) return toast("System", "The board is empty, nothing to export");
        BoardExport.download(blob, exportName("png"));
      } else if (kind === "json") {
        BoardExport.download(await fetchExport("/api/export/board.json"), `${meeting}-board.json`);
      } else if (kind === "mermaid") {
        BoardExport.download(await fetchExport("/api/export/board.mmd"), `${meeting}-mermaid.md`);
      } else if (kind === "spec" && !spec.busy) {
        await generateSpec();
      } else if (kind === "summary" && S.summary) {
        openSpec(S.summary);
      }
    } catch (e) {
      console.error(e);
      toast("System", `Export failed: ${e.message || e}`);
    }
  }
  $("btnExport").addEventListener("click", (e) => { e.stopPropagation(); setExportMenu($("exportMenu").hidden); });
  $("exportMenu").addEventListener("click", (e) => {
    const item = e.target.closest("[data-export]");
    if (item && !item.disabled) runExport(item.dataset.export);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".export")) setExportMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { setExportMenu(false); closeSpec(); } });
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
    if (!$("specModal").hidden) return;  // reading the spec: Space scrolls it, not start/pause
    if (e.code === "KeyE" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); toggleExpand(); return; }
    if (S.mode === "teams") return;
    if (S.mode === "mic") {              // no space-bar shortcut while talking live; M toggles mute
      if (e.code === "KeyM" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); toggleMute(); }
      return;
    }
    if (e.code === "Space") { e.preventDefault(); if (S.status === "running" || S.status === "paused") $("btnPause").click(); else $("btnStart").click(); }
  });

  setMode(S.autoReplay ? "replay" : "mic");
  renderTabs();
  connect();
})();
