/* Live Whiteboard renderer.
 *
 * Deterministic: it draws whatever board JSON the server sends.
 * Layout is STABLE: a node gets a position once (next to the nodes it is
 * connected to) and keeps it. Only the "Tidy" button re-lays out a board.
 */
const Board = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const COLW = 250, ROWH = 128;

  const TYPE = {
    actor:    { fill: "#fff3bf", stroke: "#f08c00" },
    system:   { fill: "#e7f5ff", stroke: "#1864ab" },
    step:     { fill: "#ffffff", stroke: "#343a40" },
    decision: { fill: "#fff0f6", stroke: "#c2255c" },
    data:     { fill: "#ebfbee", stroke: "#2b8a3e" },
  };

  let svg, camera, groupsLayer, edgesLayer, nodesLayer, fxLayer, container, rc, tooltip;
  let colorOf = () => "#868e96";
  let onEmptyChange = () => {};

  const pos = new Map();       // "board:node" -> target {x, y}
  const cur = new Map();       // "board:node" -> drawn {x, y}
  const nodeEls = new Map();   // node id -> {g, inner, sig, w, h, data}
  const edgeEls = new Map();   // edge id -> {g, line, glow, labelG, data}
  const groupEls = new Map();
  const lastSeen = new Map();  // board id -> board data last rendered
  let shown = null;            // board id currently drawn
  let shownData = null;
  let cam = { x: 0, y: 0, k: 1 }, camT = { x: 0, y: 0, k: 1 };
  let autoFit = true, rafOn = false;

  // ------------------------------------------------------------ helpers
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  const key = (b, id) => `${b}:${id}`;
  const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return Math.abs(h) % 100000 + 1; };
  const measureCtx = document.createElement("canvas").getContext("2d");
  const textW = (t, font) => { measureCtx.font = font; return measureCtx.measureText(t).width; };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function wrap(label, max = 17) {
    const words = String(label).split(/\s+/);
    const lines = [""];
    for (const w of words) {
      const cand = lines[lines.length - 1] ? lines[lines.length - 1] + " " + w : w;
      if (cand.length > max && lines[lines.length - 1]) lines.push(w); else lines[lines.length - 1] = cand;
    }
    if (lines.length > 2) { lines[1] = lines.slice(1).join(" "); lines.length = 2; if (lines[1].length > max + 3) lines[1] = lines[1].slice(0, max + 1) + "…"; }
    return lines;
  }

  function roundedRect(w, h, r) {
    const x = -w / 2, y = -h / 2;
    return `M${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x + r},${y + h} Q${x},${y + h} ${x},${y + h - r} L${x},${y + r} Q${x},${y} ${x + r},${y} Z`;
  }

  // ------------------------------------------------------------- init
  function init(opts) {
    svg = document.getElementById("svg");
    camera = document.getElementById("camera");
    groupsLayer = document.getElementById("groupsLayer");
    edgesLayer = document.getElementById("edgesLayer");
    nodesLayer = document.getElementById("nodesLayer");
    fxLayer = document.getElementById("fxLayer");
    container = document.getElementById("board");
    tooltip = document.getElementById("tooltip");
    colorOf = opts.colorOf || colorOf;
    onEmptyChange = opts.onEmptyChange || onEmptyChange;
    rc = window.rough ? rough.svg(svg) : null;
    setupPanZoom();
    window.addEventListener("resize", () => { if (autoFit) fit(); });
  }

  function setupPanZoom() {
    let drag = null;
    svg.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".node")) return;
      drag = { x: e.clientX, y: e.clientY, cx: camT.x, cy: camT.y };
      svg.classList.add("panning");
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      autoFit = false;
      camT.x = drag.cx + (e.clientX - drag.x); camT.y = drag.cy + (e.clientY - drag.y);
      cam.x = camT.x; cam.y = camT.y; kick();
    });
    const end = () => { drag = null; svg.classList.remove("panning"); };
    svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end);
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      autoFit = false;
      const r = svg.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const f = Math.exp(-e.deltaY * 0.0015);
      const k = Math.min(2.5, Math.max(0.2, camT.k * f));
      camT.x = mx - (mx - camT.x) * (k / camT.k); camT.y = my - (my - camT.y) * (k / camT.k); camT.k = k;
      cam = { ...camT }; kick();
    }, { passive: false });
  }

  // ----------------------------------------------------------- layout
  function occupied(boardId, ids, x, y, self) {
    for (const id of ids) {
      if (id === self) continue;
      const p = pos.get(key(boardId, id));
      if (p && Math.abs(p.x - x) < COLW * 0.82 && Math.abs(p.y - y) < ROWH * 0.8) return true;
    }
    return false;
  }

  function findFree(boardId, ids, x, y, self) {
    const offs = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, 6, 7, 8];
    for (const o of offs) {
      const yy = y + o * ROWH;
      if (!occupied(boardId, ids, x, yy, self)) return { x, y: yy };
    }
    return { x: x + COLW, y };
  }

  function maxCols() {
    const r = container.getBoundingClientRect();
    const ratio = r.width / Math.max(300, r.height);
    return Math.max(4, Math.min(8, Math.round(ratio * 3.4)));
  }

  /* Place nodes that have no position yet. Existing nodes never move.
   * Flows run left-to-right; when a row is full the flow drops one row and
   * continues right-to-left (snake layout), so edges stay short. */
  function placeNew(board) {
    const ids = Object.keys(board.nodes);
    const pending = ids.filter((id) => !pos.has(key(board.id, id)));
    if (!pending.length) return;
    pending.sort((a, b) => (board.nodes[a].created_v || 0) - (board.nodes[b].created_v || 0));
    const edges = Object.values(board.edges);
    const placed = (id) => pos.has(key(board.id, id));
    const P = (id) => pos.get(key(board.id, id));
    const cols = maxCols();
    const col = (x) => Math.round(x / COLW);
    const inRange = (x) => col(x) >= 0 && col(x) < cols;

    const placeAfter = (pred, id) => {
      const dir = pred.dir || 1;
      const x = pred.x + dir * COLW;
      if (inRange(x)) {
        const p = findFree(board.id, ids, x, pred.y, id);
        if (p.x === x) return { ...p, dir };
      }
      // row is full: drop below and turn around
      const p = findFree(board.id, ids, pred.x, pred.y + ROWH, id);
      return { ...p, dir: -dir };
    };

    let guard = 0;
    while (pending.length && guard++ < 500) {
      let progressed = false;
      for (const id of [...pending]) {
        const preds = edges.filter((e) => e.to === id && e.from !== id && placed(e.from)).map((e) => P(e.from));
        const succs = edges.filter((e) => e.from === id && e.to !== id && placed(e.to)).map((e) => P(e.to));
        let p = null;
        if (preds.length) {
          // follow the right-most / lowest predecessor in flow order
          const pred = preds.reduce((a, b) => (b.y > a.y || (b.y === a.y && b.x * (b.dir || 1) > a.x * (a.dir || 1)) ? b : a));
          p = placeAfter(pred, id);
        } else if (succs.length) {
          const s = succs[0];
          const dir = s.dir || 1;
          const x = s.x - dir * COLW;
          p = inRange(x) ? { ...findFree(board.id, ids, x, s.y, id), dir } : { ...findFree(board.id, ids, s.x, s.y - ROWH, id), dir };
        }
        if (p) {
          pos.set(key(board.id, id), p);
          pending.splice(pending.indexOf(id), 1);
          progressed = true;
        }
      }
      if (!progressed) {
        // an unconnected node: start a new row under everything else
        const id = pending.shift();
        const all = ids.filter(placed).map(P);
        const p = all.length
          ? { ...findFree(board.id, ids, 0, Math.max(...all.map((q) => q.y)) + ROWH, id), dir: 1 }
          : { x: 0, y: 0, dir: 1 };
        pos.set(key(board.id, id), p);
      }
    }
  }

  function tidy() {
    if (!shownData || !window.dagre) return;
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 34, ranksep: 70, marginx: 10, marginy: 10 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const [id, n] of Object.entries(shownData.nodes)) {
      const ne = nodeEls.get(id);
      g.setNode(id, { width: ne ? ne.w : 160, height: ne ? ne.h : 60 });
    }
    for (const e of Object.values(shownData.edges)) g.setEdge(e.from, e.to);
    dagre.layout(g);
    for (const id of g.nodes()) {
      const n = g.node(id);
      if (n) pos.set(key(shown, id), { x: n.x, y: n.y, dir: 1 });
    }
    autoFit = true; fit(); kick();
  }

  // ----------------------------------------------------------- shapes
  function buildNode(n) {
    const t = TYPE[n.type] || TYPE.step;
    const lines = wrap(n.label);
    const tw = Math.max(...lines.map((l) => textW(l, "700 16px Kalam")));
    const showNote = n.note && !["disputed", "resolved"].includes(n.status);
    const note = showNote ? (n.note.length > 34 ? n.note.slice(0, 33) + "…" : n.note) : null;
    const nw = note ? textW(note, "10.5px Inter") : 0;
    let w = Math.max(128, Math.min(236, Math.max(tw, nw) + 40));
    let h = lines.length === 1 ? 54 : 72;
    if (note) h += 14;
    if (n.type === "actor") w += 30;
    if (n.type === "decision") { w += 52; h += 34; }
    if (n.type === "data") h += 16;

    const ghost = n.status === "ghost";
    const disputed = n.status === "disputed";
    const stroke = disputed ? "#e03131" : ghost ? "#adb5bd" : t.stroke;
    const opts = {
      seed: hash(n.id), roughness: 1.15, bowing: 0.9, stroke, strokeWidth: disputed ? 2.6 : 1.9,
      fill: ghost ? "#ffffff" : t.fill, fillStyle: "solid",
    };
    if (ghost) opts.strokeLineDash = [7, 6];

    const inner = el("g", { class: "inner" });
    const halo = el("path", { class: "halo" }, inner);
    let shape;
    const hw = w / 2, hh = h / 2;
    if (n.type === "decision") {
      const pts = [[0, -hh], [hw, 0], [0, hh], [-hw, 0]];
      shape = rc ? rc.polygon(pts, opts) : el("polygon", { points: pts.join(" "), fill: opts.fill, stroke });
      halo.setAttribute("d", `M0,${-hh - 6} L${hw + 8},0 L0,${hh + 6} L${-hw - 8},0 Z`);
    } else if (n.type === "data") {
      const ry = 9, top = -hh + ry, bot = hh - ry;
      const d = `M${-hw},${top} A${hw},${ry} 0 0,1 ${hw},${top} L${hw},${bot} A${hw},${ry} 0 0,1 ${-hw},${bot} Z`;
      shape = rc ? rc.path(d, opts) : el("path", { d, fill: opts.fill, stroke });
      const lid = rc ? rc.path(`M${-hw},${top} A${hw},${ry} 0 0,0 ${hw},${top}`, { ...opts, fill: undefined }) : el("path", { d: `M${-hw},${top} A${hw},${ry} 0 0,0 ${hw},${top}`, fill: "none", stroke });
      const sg = el("g", { class: "shape" }); sg.appendChild(shape); sg.appendChild(lid); shape = sg;
      halo.setAttribute("d", roundedRect(w + 12, h + 12, 16));
    } else if (n.type === "actor") {
      const d = roundedRect(w, h, Math.min(hh, 26));
      shape = rc ? rc.path(d, opts) : el("path", { d, fill: opts.fill, stroke });
      halo.setAttribute("d", roundedRect(w + 12, h + 12, Math.min(hh, 26) + 6));
    } else if (n.type === "system") {
      const d = roundedRect(w, h, 4);
      shape = rc ? rc.path(d, opts) : el("path", { d, fill: opts.fill, stroke });
      const bar = rc ? rc.line(-hw, -hh + 11, hw, -hh + 11, { ...opts, strokeWidth: 1.3 }) : el("line", { x1: -hw, y1: -hh + 11, x2: hw, y2: -hh + 11, stroke });
      const sg = el("g", { class: "shape" }); sg.appendChild(shape); sg.appendChild(bar);
      for (let i = 0; i < 3; i++) el("circle", { cx: -hw + 9 + i * 7, cy: -hh + 5.5, r: 2, fill: stroke, opacity: 0.7 }, sg);
      shape = sg;
      halo.setAttribute("d", roundedRect(w + 12, h + 12, 8));
    } else {
      const d = roundedRect(w, h, 12);
      shape = rc ? rc.path(d, opts) : el("path", { d, fill: opts.fill, stroke });
      halo.setAttribute("d", roundedRect(w + 12, h + 12, 16));
    }
    shape.classList.add("shape");
    inner.appendChild(shape);

    // label
    const shift = n.type === "actor" ? 13 : 0;
    const top = n.type === "system" ? 5 : 0;
    const lineH = 19;
    const startY = -((lines.length - 1) * lineH) / 2 - (note ? 7 : 0) + top;
    lines.forEach((l, i) => {
      const tx = el("text", { class: "node-label", x: shift, y: startY + i * lineH }, inner);
      tx.textContent = l;
    });
    if (note) {
      const nt = el("text", { class: "node-note", x: shift, y: startY + (lines.length - 1) * lineH + 20 }, inner);
      nt.textContent = note;
    }
    if (n.type === "actor") {
      const ix = -hw + 20, iy = 0, c = ghost ? "#adb5bd" : t.stroke;
      el("circle", { cx: ix, cy: iy - 6, r: 5, fill: "none", stroke: c, "stroke-width": 2 }, inner);
      el("path", { d: `M${ix - 8},${iy + 11} Q${ix},${iy - 3} ${ix + 8},${iy + 11}`, fill: "none", stroke: c, "stroke-width": 2, "stroke-linecap": "round" }, inner);
    }
    if (ghost) {
      const cap = el("text", { class: "node-note", x: -hw + 4, y: -hh - 7, "text-anchor": "start", "font-style": "italic" }, inner);
      cap.textContent = "proposed";
    }
    if (disputed || n.status === "resolved") {
      const bx = n.type === "decision" ? hw * 0.55 : hw - 4, by = n.type === "decision" ? -hh * 0.55 : -hh + 2;
      const holder = el("g", { transform: `translate(${bx},${by})` }, inner);
      const b = el("g", { class: disputed ? "badge-disputed" : "badge-resolved" }, holder);
      el("circle", { r: 12, fill: disputed ? "#e03131" : "#2b8a3e", stroke: "#fff", "stroke-width": 2.5 }, b);
      const bt = el("text", { "text-anchor": "middle", "dominant-baseline": "central", fill: "#fff", "font-weight": 800, "font-size": 14, "font-family": "Inter" }, b);
      bt.textContent = disputed ? "!" : "✓";
    }
    return { inner, w, h };
  }

  function nodeSig(n) { return [n.label, n.type, n.status, n.note, n.group].join("|"); }

  // ------------------------------------------------------------ edges
  function geom(id) {
    const p = cur.get(key(shown, id)); const ne = nodeEls.get(id);
    if (!p || !ne) return null;
    return { x: p.x, y: p.y, w: ne.w, h: ne.h };
  }

  function edgePath(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    let sx, sy, tx, ty, c1x, c1y, c2x, c2y;
    if (Math.abs(dx) >= Math.abs(dy) * 1.1 || Math.abs(dx) > (a.w + b.w) / 2 + 30) {
      const s = Math.sign(dx) || 1;
      sx = a.x + s * a.w / 2; sy = a.y; tx = b.x - s * (b.w / 2 + 3); ty = b.y;
      const c = Math.max(36, Math.abs(tx - sx) * 0.45);
      c1x = sx + s * c; c1y = sy; c2x = tx - s * c; c2y = ty;
    } else {
      const s = Math.sign(dy) || 1;
      sx = a.x; sy = a.y + s * a.h / 2; tx = b.x; ty = b.y - s * (b.h / 2 + 3);
      const c = Math.max(30, Math.abs(ty - sy) * 0.45);
      c1x = sx; c1y = sy + s * c; c2x = tx; c2y = ty - s * c;
    }
    const m = (t) => {
      const u = 1 - t;
      return { x: u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * tx,
               y: u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ty };
    };
    return { d: `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`, mid: m(0.5) };
  }

  function drawEdge(ee) {
    const a = geom(ee.data.from), b = geom(ee.data.to);
    if (!a || !b) { ee.g.style.display = "none"; return; }
    ee.g.style.display = "";
    const { d, mid } = edgePath(a, b);
    ee.line.setAttribute("d", d); ee.glow.setAttribute("d", d);
    if (ee.labelG) ee.labelG.setAttribute("transform", `translate(${mid.x},${mid.y})`);
  }

  function buildEdge(e) {
    const g = el("g", { class: `edge ${e.status}` });
    const glow = el("path", { class: "glow" }, g);
    const marker = e.status === "ghost" ? "arrow-ghost" : e.status === "disputed" ? "arrow-disputed" : "arrow";
    const line = el("path", { class: "line", "marker-end": `url(#${marker})` }, g);
    let labelG = null;
    if (e.label) {
      labelG = el("g", { class: "edge-label" }, g);
      const w = textW(e.label, "13px Kalam") + 10;
      el("rect", { x: -w / 2, y: -10, width: w, height: 20, rx: 6 }, labelG);
      el("text", {}, labelG).textContent = e.label;
    }
    const tip = el("title", {}, g);
    tip.textContent = `${e.from} → ${e.to}${e.label ? ` (${e.label})` : ""}${e.note ? `\n${e.note}` : ""}\nby ${e.by || "?"} (${e.src || "?"})`;
    return { g, line, glow, labelG, data: e };
  }

  // ----------------------------------------------------------- render
  function clearAll() {
    for (const layer of [groupsLayer, edgesLayer, nodesLayer, fxLayer]) layer.replaceChildren();
    nodeEls.clear(); edgeEls.clear(); groupEls.clear();
  }

  /**
   * Draw `board`. opts: {version, by, silent}
   *  - elements stamped with this version (or new) flash in their speaker's colour
   *  - silent: no flashes (tab switch, page load)
   */
  function render(board, opts = {}) {
    if (!board) { clearAll(); shown = null; shownData = null; onEmptyChange(true); return; }
    const switching = board.id !== shown;
    if (switching) { clearAll(); shown = board.id; autoFit = true; }
    const prev = switching ? null : shownData;
    shownData = board;
    placeNew(board);
    const silent = opts.silent || switching;
    const flashColor = (item) => colorOf(item.v === opts.version ? item.by : (opts.by || item.by));

    // nodes
    for (const [id, n] of Object.entries(board.nodes)) {
      let ne = nodeEls.get(id);
      const k = key(board.id, id);
      const isNew = !ne;
      const changed = ne && ne.sig !== nodeSig(n);
      if (isNew || changed) {
        const { inner, w, h } = buildNode(n);
        if (isNew) {
          const g = el("g", { class: "node enter" }, nodesLayer);
          g.dataset.id = id;
          g.addEventListener("mouseenter", (ev) => showTip(ev, id));
          g.addEventListener("mousemove", moveTip);
          g.addEventListener("mouseleave", hideTip);
          ne = { g, inner, w, h, sig: nodeSig(n), data: n };
          nodeEls.set(id, ne);
          g.appendChild(inner);
          if (!cur.has(k) || switching) cur.set(k, { ...pos.get(k) });
          setTimeout(() => g.classList.remove("enter"), 700);
        } else {
          ne.g.replaceChild(inner, ne.inner);
          Object.assign(ne, { inner, w, h, sig: nodeSig(n) });
        }
      }
      ne.data = n;
      // keep transient animation classes (enter/flash); only swap type and status
      const transient = ["enter", "flash"].filter((c) => ne.g.classList.contains(c));
      ne.g.setAttribute("class", ["node", n.type, n.status, ...transient].join(" "));
      const prevN = prev && prev.nodes[id];
      if (!silent && (!prevN || prevN.v !== n.v || nodeSig(prevN) !== nodeSig(n))) flash(ne, flashColor(n));
    }
    for (const [id, ne] of [...nodeEls]) {
      if (!board.nodes[id]) {
        nodeEls.delete(id);
        ne.g.classList.add("exit");
        setTimeout(() => ne.g.remove(), 460);
        pos.delete(key(board.id, id)); cur.delete(key(board.id, id));
      }
    }

    // edges
    for (const [id, e] of Object.entries(board.edges)) {
      let ee = edgeEls.get(id);
      const prevE = prev && prev.edges[id];
      const sig = [e.label, e.status, e.note].join("|");
      if (!ee || ee.sig !== sig) {
        const fresh = buildEdge(e);
        if (ee) edgesLayer.replaceChild(fresh.g, ee.g); else { edgesLayer.appendChild(fresh.g); if (!silent) fresh.g.classList.add("enter"); }
        ee = { ...fresh, sig };
        edgeEls.set(id, ee);
      }
      ee.data = e;
      if (!silent && (!prevE || prevE.v !== e.v)) {
        ee.glow.setAttribute("stroke", flashColor(e));
        ee.g.classList.remove("flash"); void ee.g.getBoundingClientRect(); ee.g.classList.add("flash");
        setTimeout(() => ee.g.classList.remove("flash"), 3300);
      }
      drawEdge(ee);
    }
    for (const [id, ee] of [...edgeEls]) {
      if (!board.edges[id]) {
        edgeEls.delete(id);
        ee.g.classList.add("exit");
        setTimeout(() => ee.g.remove(), 460);
      }
    }

    lastSeen.set(board.id, board);
    onEmptyChange(Object.keys(board.nodes).length === 0);
    if (autoFit) fit();
    kick();
  }

  function flash(ne, color) {
    const halo = ne.inner.querySelector(".halo");
    if (halo) halo.setAttribute("stroke", color);
    ne.g.classList.remove("flash"); void ne.g.getBBox(); ne.g.classList.add("flash");
    clearTimeout(ne.flashT);
    ne.flashT = setTimeout(() => ne.g.classList.remove("flash"), 3300);
    // floating speaker chip
    const p = pos.get(key(shown, ne.data.id));
    if (!p || !ne.data.by) return;
    const name = ne.data.by;
    const w = textW(name, "700 11px Inter") + 14;
    const chip = el("g", { class: "bychip" }, fxLayer);
    const inner = el("g", { transform: `translate(${p.x + ne.w / 2 - w + 6},${p.y - ne.h / 2 - 22})` }, chip);
    el("rect", { width: w, height: 18, rx: 9, fill: color }, inner);
    el("text", { class: "byline", x: w / 2, y: 12.5, "text-anchor": "middle" }, inner).textContent = name;
    setTimeout(() => chip.remove(), 3300);
  }

  function drawGroups() {
    if (!shownData) return;
    const groups = Object.values(shownData.groups || {});
    for (const [gid, ge] of [...groupEls]) if (!shownData.groups[gid]) { ge.remove(); groupEls.delete(gid); }
    for (const g of groups) {
      const members = Object.values(shownData.nodes).filter((n) => n.group === g.id);
      let ge = groupEls.get(g.id);
      if (!members.length) { if (ge) ge.style.display = "none"; continue; }
      if (!ge) {
        ge = el("g", { class: "group" }, groupsLayer);
        el("rect", { rx: 18 }, ge); el("text", {}, ge);
        groupEls.set(g.id, ge);
      }
      ge.style.display = "";
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const m of members) {
        const gm = geom(m.id); if (!gm) continue;
        x0 = Math.min(x0, gm.x - gm.w / 2); x1 = Math.max(x1, gm.x + gm.w / 2);
        y0 = Math.min(y0, gm.y - gm.h / 2); y1 = Math.max(y1, gm.y + gm.h / 2);
      }
      const r = ge.querySelector("rect"), t = ge.querySelector("text");
      r.setAttribute("x", x0 - 22); r.setAttribute("y", y0 - 36); r.setAttribute("width", x1 - x0 + 44); r.setAttribute("height", y1 - y0 + 58);
      t.setAttribute("x", x0 - 10); t.setAttribute("y", y0 - 18); t.textContent = g.label;
    }
  }

  // --------------------------------------------------------- camera
  function fit() {
    if (!shownData) return;
    const ids = Object.keys(shownData.nodes);
    const r = container.getBoundingClientRect();
    if (!ids.length || !r.width) { camT = { x: r.width / 2, y: r.height / 2, k: 1 }; kick(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ids) {
      const p = pos.get(key(shown, id)); const ne = nodeEls.get(id);
      if (!p) continue;
      const w = ne ? ne.w : 160, h = ne ? ne.h : 60;
      x0 = Math.min(x0, p.x - w / 2); x1 = Math.max(x1, p.x + w / 2);
      y0 = Math.min(y0, p.y - h / 2 - 26); y1 = Math.max(y1, p.y + h / 2);
    }
    const pad = 56;
    const k = Math.min(1.25, (r.width - pad * 2) / (x1 - x0 || 1), (r.height - pad * 2 - 30) / (y1 - y0 || 1));
    camT = { k, x: r.width / 2 - ((x0 + x1) / 2) * k, y: (r.height - 30) / 2 - ((y0 + y1) / 2) * k };
    kick();
  }
  function setAutoFit() { autoFit = true; fit(); }

  // -------------------------------------------------------- animate
  function kick() { if (!rafOn) { rafOn = true; requestAnimationFrame(frame); } }
  function frame() {
    let moving = false;
    for (const [id, ne] of nodeEls) {
      const k = key(shown, id);
      const t = pos.get(k); if (!t) continue;
      let c = cur.get(k); if (!c) { c = { ...t }; cur.set(k, c); }
      const dx = t.x - c.x, dy = t.y - c.y;
      if (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3) { c.x += dx * 0.16; c.y += dy * 0.16; moving = true; } else { c.x = t.x; c.y = t.y; }
      ne.g.setAttribute("transform", `translate(${c.x},${c.y})`);
    }
    for (const ee of edgeEls.values()) drawEdge(ee);
    drawGroups();
    const f = 0.12;
    const dk = camT.k - cam.k, dxx = camT.x - cam.x, dyy = camT.y - cam.y;
    if (Math.abs(dk) > 0.001 || Math.abs(dxx) > 0.4 || Math.abs(dyy) > 0.4) {
      cam.k += dk * f; cam.x += dxx * f; cam.y += dyy * f; moving = true;
    } else cam = { ...camT };
    camera.setAttribute("transform", `translate(${cam.x},${cam.y}) scale(${cam.k})`);
    if (moving) requestAnimationFrame(frame); else rafOn = false;
  }

  // -------------------------------------------------------- tooltip
  function showTip(ev, id) {
    const ne = nodeEls.get(id); if (!ne) return;
    const n = ne.data;
    const typeName = { actor: "Actor", system: "System", step: "Step", decision: "Decision", data: "Data" }[n.type] || n.type;
    const statusTxt = { confirmed: "", ghost: " · proposed (not confirmed yet)", disputed: " · DISPUTED", resolved: " · resolved" }[n.status] || "";
    tooltip.innerHTML = `<div class="tt-title">${esc(n.label)}</div>
      <div class="tt-meta">${typeName}${statusTxt}</div>
      <div class="tt-meta">last change by <b style="color:${colorOf(n.by)}">${esc(n.by || "?")}</b> · ${esc(n.src || "")}</div>
      ${n.note ? `<div class="tt-note ${n.status}">${esc(n.note)}</div>` : ""}`;
    tooltip.hidden = false;
    moveTip(ev);
  }
  function moveTip(ev) {
    const r = container.getBoundingClientRect();
    let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
    if (x + 300 > r.width) x = ev.clientX - r.left - 300;
    tooltip.style.left = x + "px"; tooltip.style.top = y + "px";
  }
  function hideTip() { tooltip.hidden = true; }

  function reset() { clearAll(); pos.clear(); cur.clear(); lastSeen.clear(); shown = null; shownData = null; autoFit = true; onEmptyChange(true); }

  return { init, render, tidy, fit: setAutoFit, reset, get shown() { return shown; } };
})();
