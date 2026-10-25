/* Node and edge shapes: hand-drawn (rough.js) SVG per node type and status, edge groups with labels. */
const BoardShapes = (() => {
  const { el, hash, textW } = BoardSvg;

  const TYPE = {
    actor:    { fill: "#fff3bf", stroke: "#f08c00" },
    system:   { fill: "#e7f5ff", stroke: "#1864ab" },
    step:     { fill: "#ffffff", stroke: "#343a40" },
    decision: { fill: "#fff0f6", stroke: "#c2255c" },
    data:     { fill: "#ebfbee", stroke: "#2b8a3e" },
    task:     { fill: "#f3f0ff", stroke: "#6741d9" },
  };

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

  /* A stub (simplify.js): a small pill next to an edge's source that stands for its far target,
   * with the edge's label (if any) small above "→ target". */
  const cut = (t, n) => { const s = String(t || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const stubText = (label) => `→ ${cut(label, 24)}`;
  const stubSize = (label, edgeLabel, text = stubText(label)) => ({
    w: Math.max(72, textW(text, "700 13px Kalam") + 26, edgeLabel ? textW(cut(edgeLabel, 30), "10.5px Inter") + 26 : 0),
    h: edgeLabel ? 42 : 30,
  });
  function buildStub(n, rc, text = stubText(n.label), type = n.refType) {
    const t = TYPE[type] || TYPE.step, { w, h } = stubSize(n.label, n.edgeLabel, text);
    const ghost = n.status === "ghost", stroke = ghost ? "#adb5bd" : t.stroke;
    const inner = el("g", { class: "inner" });
    el("path", { class: "halo", d: roundedRect(w + 12, h + 12, 21) }, inner);
    const d = roundedRect(w, h, 15), opts = { seed: hash(n.id), roughness: 0.8, stroke, strokeWidth: 1.5, fill: t.fill, fillStyle: "solid", strokeLineDash: [5, 4] };
    const shape = rc ? rc.path(d, opts) : el("path", { d, fill: t.fill, stroke, "stroke-dasharray": "5 4" });
    shape.classList.add("shape");
    inner.appendChild(shape);
    if (n.edgeLabel) el("text", { class: "node-note", x: 0, y: -6 }, inner).textContent = cut(n.edgeLabel, 30);
    el("text", { class: "stub-label", x: 0, y: n.edgeLabel ? 8 : 0, fill: stroke }, inner).textContent = text;
    return { inner, w, h };
  }

  /* A reference on a detail board to a node of its overview (board.py extract_subflow): drawn like a stub,
   * "from X" where the sub-flow is entered, "→ X" where it leaves to X (refDir: simplify.js view). */
  const refText = (n) => `${n.refDir === "out" ? "from" : n.refDir === "both" ? "↔" : "→"} ${cut(n.label, 24)}`;
  const refSize = (n) => stubSize(n.label, "", refText(n));
  function buildRef(n, rc) { return buildStub({ ...n, edgeLabel: "" }, rc, refText(n), n.type); }

  /* A summary node (it stands for a detail board): a second card behind it and a "+N ▸" badge with the number of
   * nodes on the detail board (detailN, set by the renderer), so it reads as "there is more inside". */
  function addDetailMarks(n, inner, w, h, opts, rc) {
    if (n.type !== "decision") {
      const d = roundedRect(w, h, n.type === "system" ? 4 : 12);
      const back = rc ? rc.path(d, { ...opts, seed: hash(n.id) + 1 }) : el("path", { d, fill: opts.fill, stroke: opts.stroke });
      const g = el("g", { class: "detail-back", transform: "translate(6,6)" });
      g.appendChild(back);
      inner.insertBefore(g, inner.children[1] || null);    // behind the shape, after the halo
    }
    const text = `${n.detailN ? `+${n.detailN} ` : ""}▸`, bw = textW(text, "700 11px Inter") + 14;
    const b = el("g", { class: "detail-badge", transform: `translate(${w / 2 - bw / 2 - 6},${h / 2})` }, inner);
    el("rect", { x: -bw / 2, y: -9, width: bw, height: 18, rx: 9, fill: opts.stroke, stroke: "#fff", "stroke-width": 1.5 }, b);
    el("text", { x: 0, y: 0.5, fill: "#fff", "text-anchor": "middle", "dominant-baseline": "central", "font-weight": 700, "font-size": 11, "font-family": "Inter, Helvetica, sans-serif" }, b).textContent = text;
  }

  /* The inner SVG of a node (shape, label, note, badges) and its size. rc: rough.js canvas or null. */
  function buildNode(n, rc) {
    if (n.type === "stub") return buildStub(n, rc);
    if (n.ref_board) return buildRef(n, rc);
    const t = TYPE[n.type] || TYPE.step;
    const lines = wrap(n.label);
    const tw = Math.max(...lines.map((l) => textW(l, "700 16px Kalam")));
    const showNote = n.note && !["disputed", "resolved"].includes(n.status);
    const note = showNote ? (n.note.length > 34 ? n.note.slice(0, 33) + "…" : n.note) : null;
    const nw = note ? textW(note, "10.5px Inter") : 0;
    let w = Math.max(128, Math.min(236, Math.max(tw, nw) + 40));
    let h = lines.length === 1 ? 54 : 72;
    if (note) h += 14;
    if (n.type === "actor" || n.type === "task") w += 30;
    if (n.type === "decision") { w += 52; h += 34; }
    if (n.type === "data") h += 16;

    const ghost = n.status === "ghost";
    const disputed = n.status === "disputed";
    const stroke = disputed ? "#e03131" : ghost ? "#adb5bd" : t.stroke;
    const opts = {
      seed: hash(n.id), roughness: 1.15, bowing: 0.9, stroke, strokeWidth: disputed ? 2.6 : 1.9,
      fill: ghost || n.done ? "#ffffff" : t.fill, fillStyle: "solid",
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
    } else if (n.type === "task") {
      const d = roundedRect(w, h, 6);
      shape = rc ? rc.path(d, opts) : el("path", { d, fill: opts.fill, stroke });
      halo.setAttribute("d", roundedRect(w + 12, h + 12, 10));
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
    if (n.detail) addDetailMarks(n, inner, w, h, opts, rc);

    // label
    const shift = n.type === "actor" || n.type === "task" ? 13 : 0;
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
    if (n.type === "task") {
      const ix = -hw + 20, c = ghost ? "#adb5bd" : t.stroke;
      el("rect", { x: ix - 7, y: -7, width: 14, height: 14, rx: 3, fill: n.done ? c : "#fff", stroke: c, "stroke-width": 2 }, inner);
      if (n.done) el("path", { d: `M${ix - 4},0 L${ix - 1},3.5 L${ix + 4.5},-3.5`, fill: "none", stroke: "#fff", "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" }, inner);
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

  function nodeSig(n) { return [n.label, n.type, n.status, n.note, n.group, !!n.done, n.refType, n.edgeLabel, n.detail, n.detailN, n.ref_board, n.refDir].join("|"); }

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
    const end = (id) => String(id).replace(/^\u0002/, "group ");   // a group end (simplify.js)
    tip.textContent = `${end(e.from)} → ${e.ref || end(e.to)}${e.label ? ` (${e.label})` : ""}${e.note ? `\n${e.note}` : ""}\nby ${e.by || "?"} (${e.src || "?"})`;
    return { g, line, glow, labelG, data: e };
  }

  return { buildNode, nodeSig, buildEdge, stubSize, refSize };
})();
