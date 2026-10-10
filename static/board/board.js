/* Live Whiteboard renderer.
 *
 * Deterministic: it draws whatever board JSON the server sends.
 * Layout is STABLE: a node gets a position once (next to the nodes it is
 * connected to) and keeps it. Only "Tidy" (and a consolidator pass that
 * restructured the board) re-lays out a board, with an animated move.
 *
 * This module owns the state (positions, drawn elements, camera) and the
 * render/animation loop. The pieces it uses, loaded before it:
 *   board/svg.js      small SVG/text helpers
 *   board/shapes.js   node and edge shapes
 *   board/place.js    stable placement of new nodes
 *   board/tidy.js     the full re-layout (Tidy)
 *   board/routing.js  edge paths round the nodes
 */
const Board = (() => {
  const { el, key, textW, esc } = BoardSvg;
  const { buildNode, nodeSig, buildEdge } = BoardShapes;
  const { edgePath, routedPath, clearCache: clearRouteCache } = BoardRouting;

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
  const tweens = new Map();    // "board:node" -> {x, y, t0}: eased move after a re-layout
  const stale = new Set();     // board ids waiting for a full re-layout
  const routes = new Map();    // "board:edge" -> {pts, a, b}: waypoints from the last tidy
  const TWEEN_MS = 560;
  let camTween = null;

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
      camTween = null;
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
      cam = { ...camT }; camTween = null; kick();
    }, { passive: false });
  }

  // ----------------------------------------------------------- layout
  function maxCols() {
    const r = container.getBoundingClientRect();
    const ratio = r.width / Math.max(300, r.height);
    return Math.max(4, Math.min(8, Math.round(ratio * 3.4)));
  }

  const placeNew = (board) => BoardPlace.placeNew(board, pos, maxCols);
  const layoutBoard = (board) => BoardTidy.layoutBoard(board, nodeEls, container.getBoundingClientRect());

  // ------------------------------------------------------------- tidy
  function tidy(board = shownData) {
    if (!board || board.id !== shown) return;
    const next = layoutBoard(board);
    const now = performance.now();
    for (const [id, p] of next.pos) {
      const k = key(shown, id), c = cur.get(k);
      if (c && (Math.abs(c.x - p.x) > 1 || Math.abs(c.y - p.y) > 1)) tweens.set(k, { x: c.x, y: c.y, t0: now });
      pos.set(k, { x: p.x, y: p.y, dir: p.dir || 1 });
    }
    // long edges follow their waypoints while both ends stay where tidy put them
    for (const k of [...routes.keys()]) if (k.startsWith(`${shown}:`)) routes.delete(k);
    for (const [eid, rt] of next.routes) {
      const e = board.edges[eid];
      routes.set(key(shown, eid), { pts: rt.pts, rev: rt.rev, a: { ...next.pos.get(e.from) }, b: { ...next.pos.get(e.to) } });
    }
    autoFit = true; fit();
    camTween = { ...cam, t0: now };   // the camera glides in step with the nodes
    kick();
  }

  /* Ask for a full re-layout of these boards: right away if shown, otherwise when next shown. */
  function relayout(ids) { for (const id of ids) stale.add(id); }

  // ------------------------------------------------------------ edges
  function geom(id) {
    const p = cur.get(key(shown, id)); const ne = nodeEls.get(id);
    if (!p || !ne) return null;
    const t = pos.get(key(shown, id));
    return { id, x: p.x, y: p.y, w: ne.w, h: ne.h, dir: (t && t.dir) || 1 };
  }
  function nodeBoxes() {
    const boxes = [...nodeEls.keys()].map(geom).filter(Boolean);
    boxes.settled = [...nodeEls.keys()].every((id) => {
      const k = key(shown, id), c = cur.get(k), t = pos.get(k);
      return !tweens.has(k) && (!c || !t || (Math.abs(c.x - t.x) < 0.5 && Math.abs(c.y - t.y) < 0.5));
    });
    boxes.sig = boxes.map((o) => `${o.id}:${Math.round(o.x)},${Math.round(o.y)},${Math.round(o.w)},${Math.round(o.h)}`).join("|");
    return boxes;
  }

  function drawEdge(ee, boxes) {
    const a = geom(ee.data.from), b = geom(ee.data.to);
    if (!a || !b) { ee.g.style.display = "none"; return; }
    ee.g.style.display = "";
    const rt = routes.get(key(shown, ee.data.id));
    const pa = pos.get(key(shown, ee.data.from)), pb = pos.get(key(shown, ee.data.to));
    const same = (p, q) => p && q && Math.abs(p.x - q.x) < 1 && Math.abs(p.y - q.y) < 1;
    const { d, mid } = rt && same(pa, rt.a) && same(pb, rt.b) ? routedPath(a, b, rt, pa, pb) : edgePath(a, b, boxes, key(shown, ee.data.id));
    ee.line.setAttribute("d", d); ee.glow.setAttribute("d", d);
    if (ee.labelG) ee.labelG.setAttribute("transform", `translate(${mid.x},${mid.y})`);
  }

  // ----------------------------------------------------------- render
  function clearAll() {
    for (const layer of [groupsLayer, edgesLayer, nodesLayer, fxLayer]) layer.replaceChildren();
    nodeEls.clear(); edgeEls.clear(); groupEls.clear(); tweens.clear();
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
        const { inner, w, h } = buildNode(n, rc);
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
    const boxes = nodeBoxes();
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
      drawEdge(ee, boxes);
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
    if (stale.delete(board.id)) tidy(board);   // fits too
    else if (autoFit) fit();
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
    const pad = 56, padX = 84;   // a little extra on the sides for edges that turn around a column
    const k = Math.min(1.25, (r.width - padX * 2) / (x1 - x0 || 1), (r.height - pad * 2 - 30) / (y1 - y0 || 1));
    camT = { k, x: r.width / 2 - ((x0 + x1) / 2) * k, y: (r.height - 30) / 2 - ((y0 + y1) / 2) * k };
    kick();
  }
  function setAutoFit() { autoFit = true; fit(); }

  // -------------------------------------------------------- animate
  function kick() { if (!rafOn) { rafOn = true; requestAnimationFrame(frame); } }
  const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  function frame() {
    let moving = false;
    const now = performance.now();
    for (const [id, ne] of nodeEls) {
      const k = key(shown, id);
      const t = pos.get(k); if (!t) continue;
      let c = cur.get(k); if (!c) { c = { ...t }; cur.set(k, c); }
      const tw = tweens.get(k);
      if (tw) {
        const u = Math.min(1, (now - tw.t0) / TWEEN_MS), e = ease(u);
        c.x = tw.x + (t.x - tw.x) * e; c.y = tw.y + (t.y - tw.y) * e;
        if (u < 1) moving = true; else tweens.delete(k);
      } else {
        const dx = t.x - c.x, dy = t.y - c.y;
        if (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3) { c.x += dx * 0.16; c.y += dy * 0.16; moving = true; } else { c.x = t.x; c.y = t.y; }
      }
      ne.g.setAttribute("transform", `translate(${c.x},${c.y})`);
    }
    const boxes = nodeBoxes();
    for (const ee of edgeEls.values()) drawEdge(ee, boxes);
    drawGroups();
    const f = 0.12;
    const dk = camT.k - cam.k, dxx = camT.x - cam.x, dyy = camT.y - cam.y;
    if (camTween) {
      const u = Math.min(1, (now - camTween.t0) / TWEEN_MS), e = ease(u);
      cam = { k: camTween.k + (camT.k - camTween.k) * e, x: camTween.x + (camT.x - camTween.x) * e, y: camTween.y + (camT.y - camTween.y) * e };
      if (u < 1) moving = true; else camTween = null;
    } else if (Math.abs(dk) > 0.001 || Math.abs(dxx) > 0.4 || Math.abs(dyy) > 0.4) {
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

  function reset() { clearAll(); pos.clear(); cur.clear(); lastSeen.clear(); stale.clear(); routes.clear(); clearRouteCache(); shown = null; shownData = null; autoFit = true; onEmptyChange(true); }

  return { init, render, tidy: () => tidy(), relayout, fit: setAutoFit, reset, get shown() { return shown; } };
})();
