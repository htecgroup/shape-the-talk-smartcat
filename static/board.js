/* Live Whiteboard renderer.
 *
 * Deterministic: it draws whatever board JSON the server sends.
 * Layout is STABLE: a node gets a position once (next to the nodes it is
 * connected to) and keeps it. Only "Tidy" (and a consolidator pass that
 * restructured the board) re-lays out a board, with an animated move.
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
  const tweens = new Map();    // "board:node" -> {x, y, t0}: eased move after a re-layout
  const stale = new Set();     // board ids waiting for a full re-layout
  const routes = new Map();    // "board:edge" -> {pts, a, b}: waypoints from the last tidy
  const TWEEN_MS = 560;
  let camTween = null;

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
        let preds = edges.filter((e) => e.to === id && e.from !== id && placed(e.from)).map((e) => e.from);
        let succs = edges.filter((e) => e.from === id && e.to !== id && placed(e.to)).map((e) => e.to);
        // a node that joins an existing group goes next to its group mates
        const grp = board.nodes[id].group;
        const mates = grp ? ids.filter((m) => m !== id && placed(m) && board.nodes[m].group === grp) : [];
        if (mates.length) {
          const mp = preds.filter((m) => mates.includes(m)), ms = succs.filter((m) => mates.includes(m));
          if (mp.length || ms.length) { preds = mp; succs = ms; } else { preds = [mates[mates.length - 1]]; succs = []; }
        }
        preds = preds.map(P); succs = succs.map(P);
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

  // ------------------------------------------------------------- tidy
  /* Full re-layout of a board (the Tidy button, and after the consolidator
   * restructured a board). A layered flow layout in the spirit of Sugiyama:
   *  1. every group is collapsed into one block and laid out on its own, so
   *     its members stay together in flow order and the group box is tight
   *  2. cycles are broken by a DFS from the entry points (sources, actors)
   *  3. rank = longest path from the entry points; sources are pulled next
   *     to what they feed
   *  4. order inside a rank by barycenter sweeps (edges that skip ranks get
   *     dummy nodes, so they keep a free corridor); fewest crossings wins
   *  5. the ranks are cut into bands that fit the panel, preferably where few
   *     edges have to cross (a small DP); bands alternate left-to-right /
   *     right-to-left (snake, like placeNew) and each starts right under the
   *     end of the previous one, so a long flow turns straight down instead of
   *     running off into a thin strip
   *  6. y inside a band: weighted relaxation towards the neighbours plus an
   *     order-preserving projection (isotonic regression). Main-line edges
   *     weigh more, so the spine stays straight and side branches fan out
   *     beside it.
   * The band width is chosen by trying candidates and keeping the one that
   * reads best in the current panel (zoom after fit, few turns). Unconnected
   * nodes end up in a row at the bottom; a mind map grows to both sides of
   * its root. Edges that skip ranks follow their dummy nodes as waypoints;
   * edges that would still run through nodes are routed round them (see
   * edgePath). Deterministic for a given board + panel size. */
  const GX = 64, GY = 30, BANDGAP = 70, COMPGAP = 84, GPAD = { l: 22, r: 22, t: 36, b: 22 };

  // order-preserving projection: y[i+1] - y[i] >= gap[i], closest to t (weighted)
  function project(t, wt, gap) {
    const off = [0];
    for (let i = 0; i < gap.length; i++) off.push(off[i] + gap[i]);
    const st = [];
    t.forEach((v, i) => {
      st.push({ s: (v - off[i]) * wt[i], w: wt[i], n: 1 });
      while (st.length > 1 && st[st.length - 2].s / st[st.length - 2].w > st[st.length - 1].s / st[st.length - 1].w) {
        const b = st.pop(), a = st[st.length - 1];
        a.s += b.s; a.w += b.w; a.n += b.n;
      }
    });
    const y = [];
    for (const b of st) for (let j = 0; j < b.n; j++) y.push(b.s / b.w + off[y.length]);
    return y;
  }

  /* One connected component: items [{id, w, h, v, actor}], edges [{from, to, lw}].
   * Returns positions relative to the component's top-left corner. */
  function layoutComponent(items, edges, B) {
    const it = new Map(items.map((i) => [i.id, i]));
    const V = new Map(items.map((i) => [i.id, i.v]));
    const cmp = (a, b) => V.get(a) - V.get(b);
    const ids = items.map((i) => i.id).sort(cmp);

    // 1. break cycles: DFS from the entry points, back edges get reversed
    const out = new Map(ids.map((id) => [id, []]));
    const indeg = new Map(ids.map((id) => [id, 0]));
    for (const e of edges) { out.get(e.from).push(e); indeg.set(e.to, indeg.get(e.to) + 1); }
    for (const l of out.values()) l.sort((a, b) => cmp(a.to, b.to));
    // entry points: sources and actors, in the order they were mentioned
    const entry = (id) => (indeg.get(id) === 0 || it.get(id).actor ? 0 : 1);
    const roots = [...ids].sort((a, b) => entry(a) - entry(b) || cmp(a, b));
    const state = new Map(), dag = [];
    const visit = (u) => {
      state.set(u, 1);
      for (const e of out.get(u)) {
        const s = state.get(e.to);
        if (s === 1) dag.push({ from: e.to, to: u, lw: e.lw, rev: true });
        else { dag.push({ from: u, to: e.to, lw: e.lw }); if (!s) visit(e.to); }
      }
      state.set(u, 2);
    };
    for (const r of roots) if (!state.get(r)) visit(r);

    // 2. ranks: longest path, then sources sit right before what they feed
    const succ = new Map(ids.map((id) => [id, []])), pred = new Map(ids.map((id) => [id, []]));
    for (const d of dag) { succ.get(d.from).push(d.to); pred.get(d.to).push(d.from); }
    const topo = [], left = new Map(ids.map((id) => [id, pred.get(id).length]));
    let ready = ids.filter((id) => !left.get(id));
    while (ready.length) {
      ready.sort(cmp);
      const u = ready.shift(); topo.push(u);
      for (const s of succ.get(u)) { left.set(s, left.get(s) - 1); if (!left.get(s)) ready.push(s); }
    }
    const rank = new Map();
    for (const u of topo) rank.set(u, Math.max(0, ...pred.get(u).map((p) => rank.get(p) + 1)));
    for (const u of [...topo].reverse()) if (!pred.get(u).length && succ.get(u).length) rank.set(u, Math.min(...succ.get(u).map((s) => rank.get(s))) - 1);
    const r0 = Math.min(...rank.values());
    for (const u of ids) rank.set(u, rank.get(u) - r0);

    // 3. dummy nodes for edges that skip ranks: they keep a free corridor and
    //    become the edge's waypoints (long back edges just take a direct curve)
    const N = new Map(ids.map((id) => [id, { id, w: it.get(id).w, h: it.get(id).h, r: rank.get(id), v: V.get(id) }]));
    const aS = new Map(ids.map((id) => [id, []])), aP = new Map(ids.map((id) => [id, []]));
    const links = [], chains = [];
    let nd = 0;
    for (const d of dag) {
      const span = rank.get(d.to) - rank.get(d.from);
      let a = d.from;
      const chain = [];
      for (let i = 1; i < span && !(d.rev && span > 2); i++) {
        const id = `\u0001${nd++}`;
        N.set(id, { id, w: 0, h: 12, r: rank.get(d.from) + i, v: V.get(d.from) + 0.5, dummy: true });
        aS.set(id, []); aP.set(id, []); chain.push(id);
      }
      if (chain.length) chains.push({ from: d.rev ? d.to : d.from, to: d.rev ? d.from : d.to, rev: !!d.rev, ids: chain });
      for (const b of [...chain, d.to]) {
        links.push({ a, b, lw: span === 1 ? d.lw : 0 });
        aS.get(a).push(b); aP.get(b).push(a); a = b;
      }
    }
    const R = Math.max(...[...N.values()].map((n) => n.r)) + 1;
    const vOf = (id) => N.get(id).v;
    const byV = (a, b) => vOf(a) - vOf(b);

    // main line: u -> v is a spine edge when v is u's longest continuation and u is v's earliest feeder
    const toEnd = new Map();
    for (const id of [...N.keys()].sort((a, b) => N.get(b).r - N.get(a).r)) toEnd.set(id, Math.max(0, ...aS.get(id).map((s) => toEnd.get(s) + 1)));
    const best = (l, score) => l.reduce((a, b) => (a == null || score(b) > score(a) || (score(b) === score(a) && vOf(b) < vOf(a)) ? b : a), null);
    // (a fan of equally long branches has no main line: it stays centred)
    const bestS = new Map([...N.keys()].map((id) => {
      const l = aS.get(id), b = best(l, (s) => toEnd.get(s));
      return [id, l.filter((s) => toEnd.get(s) === toEnd.get(b)).length === 1 ? b : null];
    }));
    const bestP = new Map([...N.keys()].map((id) => [id, best(aP.get(id), () => 0)]));
    for (const l of links) l.wt = bestS.get(l.a) === l.b && bestP.get(l.b) === l.a ? 8 : 1;

    // 4. order inside the ranks: DFS discovery (main line first), then barycenter sweeps
    const disc = new Map();
    const dfs = (u) => {
      if (disc.has(u)) return; disc.set(u, disc.size);
      for (const s of [...aS.get(u)].sort((a, b) => toEnd.get(b) - toEnd.get(a) || byV(a, b))) dfs(s);
    };
    for (const r of [...ids].sort((a, b) => rank.get(a) - rank.get(b) || entry(a) - entry(b) || cmp(a, b))) dfs(r);
    let layers = Array.from({ length: R }, () => []);
    for (const n of N.values()) layers[n.r].push(n.id);
    layers.forEach((l) => l.sort((a, b) => disc.get(a) - disc.get(b)));
    const idx = new Map();
    const index = () => layers.forEach((l) => l.forEach((u, i) => idx.set(u, i)));
    const crossings = () => {
      let c = 0;
      for (let i = 0; i < links.length; i++) for (let j = i + 1; j < links.length; j++) {
        const p = links[i], q = links[j];
        if (N.get(p.a).r !== N.get(q.a).r) continue;
        if ((idx.get(p.a) - idx.get(q.a)) * (idx.get(p.b) - idx.get(q.b)) < 0) c++;
      }
      return c;
    };
    index();
    let bestLayers = layers.map((l) => [...l]), bestC = crossings();
    for (let sweep = 0; sweep < 8 && bestC > 0; sweep++) {
      const down = sweep % 2 === 0;
      const rs = [...Array(R).keys()];
      for (const r of down ? rs.slice(1) : rs.reverse().slice(1)) {
        const nb = down ? aP : aS;
        const bary = new Map(layers[r].map((u) => {
          const l = nb.get(u);
          return [u, l.length ? l.reduce((s, x) => s + idx.get(x), 0) / l.length : idx.get(u)];
        }));
        layers[r].sort((a, b) => bary.get(a) - bary.get(b) || idx.get(a) - idx.get(b));
        layers[r].forEach((u, i) => idx.set(u, i));
      }
      const c = crossings();
      if (c < bestC) { bestC = c; bestLayers = layers.map((l) => [...l]); }
    }
    layers = bestLayers; index();

    // 5. bands: cut the ranks into bands at most B wide. Where to cut is a small
    //    DP: every cut costs the edges it has to carry round the turn (so the
    //    flow turns at its bottlenecks), plus a little for uneven bands.
    const colW = layers.map((l) => Math.max(40, ...l.map((u) => N.get(u).w)));
    const gapW = Array.from({ length: R }, () => GX);
    for (const l of links) if (l.lw) gapW[N.get(l.a).r] = Math.max(gapW[N.get(l.a).r], l.lw + 40);
    const crossAt = Array(R).fill(0);
    for (const d of dag) for (let r = rank.get(d.from); r < rank.get(d.to); r++) crossAt[r]++;
    const span = (s, e) => { let w = colW[s]; for (let r = s + 1; r <= e; r++) w += gapW[r - 1] + colW[r]; return w; };
    const full = span(0, R - 1), Bf = Math.min(B, full);
    const f = [0], from = [0];
    for (let e = 1; e <= R; e++) {
      f[e] = Infinity;
      for (let s = e - 1; s >= 0; s--) {
        const w = span(s, e - 1);
        if (w > B && s < e - 1) break;
        const c = f[s] + (s ? crossAt[s - 1] + 0.6 : 0) + 0.15 * Math.pow(Math.max(0, Bf - w) / Bf, 2);
        if (c < f[e] - 1e-9) { f[e] = c; from[e] = s; }
      }
    }
    const bands = [];
    for (let e = R; e > 0; e = from[e]) bands.unshift([...Array(e - from[e]).keys()].map((i) => from[e] + i));
    const bandOf = new Map();
    bands.forEach((rs, b) => rs.forEach((r) => bandOf.set(r, b)));
    // at a turn, what continues into the next band sits at the bottom of the
    // band's last rank, and what it feeds at the top of the next band
    const bandN = (u) => bandOf.get(N.get(u).r);
    bands.forEach((rs, b) => {
      const first = layers[rs[0]], last = layers[rs[rs.length - 1]];
      const into = (u) => (aP.get(u).some((p) => bandN(p) < b) ? 0 : 1);
      const onward = (u) => (aS.get(u).some((s) => bandN(s) > b) ? 1 : 0);
      if (b > 0) first.sort((x, z) => into(x) - into(z) || idx.get(x) - idx.get(z));
      if (b < bands.length - 1) last.sort((x, z) => onward(x) - onward(z) || idx.get(x) - idx.get(z));
    });

    // 6. y inside each band, x by column; odd bands run right-to-left
    const y = new Map(), pos = new Map(), dpos = new Map();
    // x: each band starts right under the end of the previous one, so the flow
    // turns straight down; it is nudged back inside the width used so far
    const bx = [];
    let lo = 0, hi = 0;
    bands.forEach((rs, b) => {
      const dir = b % 2 ? -1 : 1, xs = [];
      let x = b ? bx[b - 1][bx[b - 1].length - 1] : colW[rs[0]] / 2;
      rs.forEach((r, i) => { if (i) x += dir * (colW[r - 1] / 2 + gapW[r - 1] + colW[r] / 2); xs.push(x); });
      let l = Math.min(...rs.map((r, i) => xs[i] - colW[r] / 2)), h = Math.max(...rs.map((r, i) => xs[i] + colW[r] / 2));
      if (b) {
        const shift = h - l <= hi - lo ? (l < lo ? lo - l : h > hi ? hi - h : 0) : dir > 0 ? lo - l : hi - h;
        xs.forEach((_, i) => { xs[i] += shift; }); l += shift; h += shift;
      }
      lo = Math.min(lo, l); hi = Math.max(hi, h);
      bx.push(xs);
    });
    const W = hi - lo;
    let top = 0;
    bands.forEach((rs, b) => {
      const inBand = (u) => bandOf.get(N.get(u).r) === b;
      const L = rs.map((r) => layers[r].filter(inBand));
      const nbs = new Map();
      for (const l of L.flat()) nbs.set(l, []);
      for (const l of links) if (nbs.has(l.a) && nbs.has(l.b)) { nbs.get(l.a).push([l.b, l.wt]); nbs.get(l.b).push([l.a, l.wt]); }
      const sep = (a, c) => (N.get(a).h + N.get(c).h) / 2 + (N.get(a).dummy || N.get(c).dummy ? GY / 2 : GY);
      for (const l of L) {
        let yy = 0;
        l.forEach((u, i) => { if (i) yy += sep(l[i - 1], u); y.set(u, yy); });
        const mid = yy / 2;
        l.forEach((u) => y.set(u, y.get(u) - mid));
      }
      for (let iter = 0; iter < 40; iter++) {
        const order = iter % 2 ? [...L].reverse() : L;
        for (const l of order) {
          if (!l.length) continue;
          const t = [], wt = [];
          for (const u of l) {
            let s = 0, w = 0;
            for (const [v, k] of nbs.get(u)) { s += y.get(v) * k; w += k; }
            t.push(w ? s / w : y.get(u)); wt.push(w || 0.25);
          }
          const res = project(t, wt, l.slice(1).map((u, i) => sep(l[i], u)));
          l.forEach((u, i) => y.set(u, res[i]));
        }
      }
      let y0 = Infinity, y1 = -Infinity;
      for (const u of L.flat()) { y0 = Math.min(y0, y.get(u) - N.get(u).h / 2); y1 = Math.max(y1, y.get(u) + N.get(u).h / 2); }
      const dir = b % 2 ? -1 : 1;
      rs.forEach((r, i) => {
        for (const u of L[i]) {
          const p = { x: bx[b][i] - lo, y: top + y.get(u) - y0, dir };
          if (N.get(u).dummy) dpos.set(u, { ...p, half: colW[r] / 2 }); else pos.set(u, p);
        }
      });
      top += y1 - y0 + BANDGAP;
    });
    // waypoints of the long edges, in edge direction; dir = direction of travel
    const routes = chains.map((c) => {
      const pts = c.ids.map((u) => { const p = dpos.get(u); return { ...p, dir: c.rev ? -p.dir : p.dir }; });
      return { from: c.from, to: c.to, rev: c.rev, pts: c.rev ? pts.reverse() : pts };
    });
    const cuts = dag.filter((d) => bandOf.get(rank.get(d.from)) !== bandOf.get(rank.get(d.to))).length;
    return { pos, routes, w: W, h: top - BANDGAP, bands: bands.length, cuts };
  }

  /* Mind map: the root in the middle, its branches split over a right and a
   * left side (each a normal tree layout, the left one mirrored). Falls back to
   * the flow layout when the component is not a tree hanging off one root. */
  function layoutMindmap(items, edges, B) {
    const indeg = new Map(items.map((i) => [i.id, 0])), kids = new Map(items.map((i) => [i.id, []]));
    for (const e of edges) { indeg.set(e.to, indeg.get(e.to) + 1); kids.get(e.from).push(e.to); }
    const roots = items.filter((i) => !indeg.get(i.id));
    const root = roots.length === 1 ? roots[0].id : null;
    if (!root || kids.get(root).length < 4) return layoutComponent(items, edges, B);
    const owner = new Map([[root, root]]);
    const sizes = [];
    for (const c of kids.get(root)) {
      const st = [c]; let n = 0;
      while (st.length) {
        const u = st.pop();
        if (owner.has(u)) { if (owner.get(u) !== c) return layoutComponent(items, edges, B); continue; }
        owner.set(u, c); n += kids.get(u).length ? 0 : 1; st.push(...kids.get(u));
      }
      sizes.push([c, Math.max(1, n)]);
    }
    if (owner.size !== items.length) return layoutComponent(items, edges, B);
    const total = sizes.reduce((s, [, n]) => s + n, 0);
    const right = new Set();
    let acc = 0;
    for (const [c, n] of sizes) { if (acc + n / 2 > total / 2 && right.size) break; right.add(c); acc += n; }
    const byId = new Map(items.map((i) => [i.id, i]));
    const side = (inR) => {
      const ids = items.filter((i) => i.id === root || right.has(owner.get(i.id)) === inR).map((i) => i.id);
      const set = new Set(ids);
      return layoutComponent(ids.map((u) => byId.get(u)), edges.filter((e) => set.has(e.from) && set.has(e.to)), Infinity);
    };
    const R = side(true), Lf = side(false);
    const rr = R.pos.get(root), rl = Lf.pos.get(root);
    const pos = new Map(), routes = [];
    const fromL = (q) => ({ ...q, x: -(q.x - rl.x), y: q.y - rl.y, dir: -(q.dir || 1) });
    const fromR = (q) => ({ ...q, x: q.x - rr.x, y: q.y - rr.y });
    for (const [u, q] of Lf.pos) pos.set(u, fromL(q));
    for (const [u, q] of R.pos) pos.set(u, fromR(q));
    for (const rt of Lf.routes) routes.push({ ...rt, pts: rt.pts.map(fromL) });
    for (const rt of R.routes) routes.push({ ...rt, pts: rt.pts.map(fromR) });
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [u, q] of pos) {
      const i = byId.get(u);
      x0 = Math.min(x0, q.x - i.w / 2); x1 = Math.max(x1, q.x + i.w / 2); y0 = Math.min(y0, q.y - i.h / 2); y1 = Math.max(y1, q.y + i.h / 2);
    }
    const shift = (q) => ({ ...q, x: q.x - x0, y: q.y - y0 });
    for (const [u, q] of pos) pos.set(u, shift(q));
    return { pos, routes: routes.map((rt) => ({ ...rt, pts: rt.pts.map(shift) })), w: x1 - x0, h: y1 - y0, bands: 1, cuts: 0 };
  }

  /* Several components stacked under each other, unconnected items in a row at the end. */
  function layoutFlow(items, edges, B, mindmap = false) {
    const V = new Map(items.map((i) => [i.id, i.v]));
    const nbr = new Map(items.map((i) => [i.id, []]));
    for (const e of edges) { nbr.get(e.from).push(e.to); nbr.get(e.to).push(e.from); }
    const seen = new Set(), comps = [], lone = [];
    for (const i of [...items].sort((a, b) => a.v - b.v)) {
      if (seen.has(i.id)) continue;
      const c = [], st = [i.id];
      seen.add(i.id);
      while (st.length) { const u = st.pop(); c.push(u); for (const w of nbr.get(u)) if (!seen.has(w)) { seen.add(w); st.push(w); } }
      if (c.length === 1) lone.push(c[0]); else comps.push(c);
    }
    comps.sort((a, b) => b.length - a.length || Math.min(...a.map((u) => V.get(u))) - Math.min(...b.map((u) => V.get(u))));
    const byId = new Map(items.map((i) => [i.id, i]));
    const pos = new Map(), routes = [];
    let top = 0, W = 0, bands = 0, cuts = 0;
    for (const c of comps) {
      const cs = new Set(c);
      const res = (mindmap ? layoutMindmap : layoutComponent)(c.map((u) => byId.get(u)), edges.filter((e) => cs.has(e.from)), B);
      for (const [u, p] of res.pos) pos.set(u, { ...p, y: p.y + top });
      for (const rt of res.routes) routes.push({ ...rt, pts: rt.pts.map((q) => ({ ...q, y: q.y + top })) });
      top += res.h + COMPGAP; W = Math.max(W, res.w); bands += res.bands; cuts += res.cuts;
    }
    if (lone.length) {
      const rowW = Math.max(W, B);
      let x = 0, rowTop = top, rowH = 0;
      for (const u of lone) {
        const i = byId.get(u);
        if (x && x + i.w > rowW) { rowTop += rowH + GY * 1.5; x = 0; rowH = 0; bands++; }
        pos.set(u, { x: x + i.w / 2, y: rowTop + i.h / 2, dir: 1 });
        x += i.w + GX / 2; rowH = Math.max(rowH, i.h); W = Math.max(W, x - GX / 2);
      }
      top = rowTop + rowH + COMPGAP; bands++;
    }
    return { pos, routes, w: W, h: Math.max(0, top - COMPGAP), bands: Math.max(1, bands), cuts };
  }

  function layoutBoard(board) {
    const ids = Object.keys(board.nodes);
    const order = new Map(ids.map((id, i) => [id, (board.nodes[id].created_v || 0) * 1e4 + i]));
    const item = (id) => {
      const ne = nodeEls.get(id);
      return { id, w: ne ? ne.w : 160, h: ne ? ne.h : 60, v: order.get(id), actor: board.nodes[id].type === "actor" };
    };
    const lw = (e) => (e.label ? textW(e.label, "13px Kalam") + 10 : 0);
    const edges = Object.values(board.edges).filter((e) => board.nodes[e.from] && board.nodes[e.to] && e.from !== e.to);
    const groups = new Map();
    for (const id of ids) {
      const g = board.nodes[id].group;
      if (g && board.groups && board.groups[g]) { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(id); }
    }
    const gkey = (g) => `\u0002${g}`;
    const block = (id) => (groups.has(board.nodes[id].group) ? gkey(board.nodes[id].group) : id);

    const at = (B) => {
      const inner = new Map(), items = [];
      for (const [g, members] of groups) {
        const ms = new Set(members);
        const res = layoutFlow(members.map(item), edges.filter((e) => ms.has(e.from) && ms.has(e.to)).map((e) => ({ from: e.from, to: e.to, lw: lw(e) })), B - GPAD.l - GPAD.r);
        inner.set(gkey(g), res);
        items.push({ id: gkey(g), w: res.w + GPAD.l + GPAD.r, h: res.h + GPAD.t + GPAD.b, v: Math.min(...members.map((m) => order.get(m))), actor: false });
      }
      for (const id of ids) if (block(id) === id) items.push(item(id));
      const seen = new Map();
      for (const e of edges) {
        const a = block(e.from), b = block(e.to);
        if (a === b) continue;
        const k = `${a}\u0003${b}`;
        seen.set(k, { from: a, to: b, lw: Math.max(lw(e), seen.has(k) ? seen.get(k).lw : 0) });
      }
      const res = layoutFlow(items, [...seen.values()], B, board.kind === "mindmap");
      const pos = new Map(), wp = new Map();   // wp: "from>to" -> waypoints
      for (const rt of res.routes) wp.set(`${rt.from}>${rt.to}`, rt);
      let bands = res.bands, cuts = res.cuts;
      for (const [u, p] of res.pos) {
        const sub = inner.get(u);
        if (!sub) { pos.set(u, p); continue; }
        bands += sub.bands - 1; cuts += sub.cuts;
        const x0 = p.x - (sub.w + GPAD.l + GPAD.r) / 2 + GPAD.l, y0 = p.y - (sub.h + GPAD.t + GPAD.b) / 2 + GPAD.t;
        const place = (q) => ({ ...q, x: x0 + (p.dir < 0 ? sub.w - q.x : q.x), y: y0 + q.y, dir: p.dir * (q.dir || 1) });
        for (const [m, q] of sub.pos) pos.set(m, place(q));
        for (const rt of sub.routes) wp.set(`${rt.from}>${rt.to}`, { ...rt, pts: rt.pts.map(place) });
      }
      const routes = new Map();
      for (const e of edges) {
        const rt = wp.get(`${block(e.from)}>${block(e.to)}`) || wp.get(`${e.from}>${e.to}`);
        if (rt) routes.set(e.id, rt);
      }
      return { pos, routes, w: res.w, h: res.h, bands, cuts };
    };

    // try band widths from "one long row" down to "one column". Score: text
    // readable after fit (zoom >= READ counts as fully readable), minus a bit
    // for every turn of the flow and every edge that has to cross a turn.
    const READ = 0.9;
    const r = container.getBoundingClientRect();
    const PW = Math.max(320, r.width - 168), PH = Math.max(240, r.height - 112 - 30);
    const full = at(Infinity);
    let best = null;
    for (let i = 0; i <= 14; i++) {
      const B = i === 0 ? Infinity : full.w * (1 - i / 15);
      const res = i === 0 ? full : at(B);
      const k = Math.min(PW / Math.max(1, res.w), PH / Math.max(1, res.h + 26));
      const score = (Math.min(k, READ) / READ) * (1 - 0.03 * (res.bands - 1) - 0.035 * res.cuts);
      if (!best || score > best.score + 1e-6 || (score > best.score - 1e-6 && k > best.k)) best = { ...res, score, k };
    }
    return best;
  }

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

  const cubic = (sx, sy, c1x, c1y, c2x, c2y, tx, ty) => {
    const m = (t) => {
      const u = 1 - t;
      return { x: u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * tx,
               y: u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ty };
    };
    return { d: `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`, mid: m(0.5), at: m };
  };
  // how many other nodes a route runs through
  function blocked(route, a, b, boxes) {
    let n = 0;
    for (const o of boxes) {
      if (o.id === a.id || o.id === b.id) continue;
      for (let i = 1; i < 16; i++) {
        const p = route.at(i / 16);
        if (Math.abs(p.x - o.x) < o.w / 2 + 6 && Math.abs(p.y - o.y) < o.h / 2 + 6) { n++; break; }
      }
    }
    return n;
  }

  /* Edge from a to b. The direct curve, unless it runs through other nodes:
   * then try to go around (a U-turn past the side of a column, or an arc over
   * or under a row) and keep the route that crosses the fewest nodes. */
  function edgePath(a, b, boxes = [], ekey = null) {
    const direct = directPath(a, b);
    if (!boxes.length || !blocked(direct, a, b, boxes)) return direct;
    const dx = b.x - a.x, dy = b.y - a.y, routes = [direct];
    const sameCol = Math.abs(dx) < (a.w + b.w) / 2, sameRow = Math.abs(dy) < Math.max(a.h, b.h);
    for (const s of sameCol ? [a.dir || 1, -(a.dir || 1)] : []) {   // U-turn beside the column
      const sx = a.x + s * a.w / 2, tx = b.x + s * (b.w / 2 + 3);
      const edge = s > 0 ? Math.max(sx, tx) : Math.min(sx, tx);
      const X = edge + s * (26 + Math.abs(dy) * 0.04) / 0.75;
      routes.push(cubic(sx, a.y, X, a.y, X, b.y, tx, b.y));
    }
    for (const s of sameRow ? [-1, 1] : []) {               // arc over / under the row
      const sy = a.y + s * a.h / 2, ty = b.y + s * (b.h / 2 + 3);
      const edge = s > 0 ? Math.max(sy, ty) : Math.min(sy, ty);
      const Y = edge + s * (30 + Math.abs(dx) * 0.06) / 0.75;
      routes.push(cubic(a.x, sy, a.x + dx * 0.15, Y, b.x - dx * 0.15, Y, b.x, ty));
    }
    let best = direct, bestN = Infinity;
    for (const r of routes) { const n = blocked(r, a, b, boxes); if (n < bestN) { best = r; bestN = n; } }
    if (!bestN || !boxes.settled || !ekey) return best;
    // nothing simple is free: find a way round the nodes on a grid (cached until something moves)
    const c = gridCache.get(ekey);
    if (c && c.sig === boxes.sig) return c.res || best;
    const res = gridRoute(a, b, boxes);
    gridCache.set(ekey, { sig: boxes.sig, res });
    return res || best;
  }

  /* A* on a coarse grid around the nodes (ports on all four sides, turns
   * cost extra), then the corners are rounded so it still looks hand drawn. */
  const gridCache = new Map();
  function gridRoute(a, b, boxes) {
    const C = 14, M = 70;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of boxes) { x0 = Math.min(x0, o.x - o.w / 2); x1 = Math.max(x1, o.x + o.w / 2); y0 = Math.min(y0, o.y - o.h / 2); y1 = Math.max(y1, o.y + o.h / 2); }
    x0 -= M; y0 -= M; x1 += M; y1 += M;
    const W = Math.ceil((x1 - x0) / C) + 1, H = Math.ceil((y1 - y0) / C) + 1;
    if (W * H > 60000) return null;
    const cx = (x) => Math.max(0, Math.min(W - 1, Math.round((x - x0) / C))), cy = (y) => Math.max(0, Math.min(H - 1, Math.round((y - y0) / C)));
    const wall = new Uint8Array(W * H), near = new Uint8Array(W * H);
    for (const o of boxes) {
      for (let j = cy(o.y - o.h / 2 - 22); j <= cy(o.y + o.h / 2 + 22); j++) for (let i = cx(o.x - o.w / 2 - 22); i <= cx(o.x + o.w / 2 + 22); i++) near[j * W + i] = 1;
      for (let j = cy(o.y - o.h / 2 - 7); j <= cy(o.y + o.h / 2 + 7); j++) for (let i = cx(o.x - o.w / 2 - 7); i <= cx(o.x + o.w / 2 + 7); i++) wall[j * W + i] = 1;
    }
    const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
    const ports = (n, out) => [0, 1, 2, 3].map((d) => {
      const px = n.x + DX[d] * (n.w / 2 + 14), py = n.y + DY[d] * (n.h / 2 + 14);
      return { i: cx(px), j: cy(py), d: out ? d : (d + 2) % 4, side: d };
    });
    const src = ports(a, true), dst = ports(b, false);
    const goal = new Map(dst.map((p) => [(p.j * W + p.i) * 4 + p.d, p]));
    for (const p of [...src, ...dst]) wall[p.j * W + p.i] = 0;
    const g = new Float64Array(W * H * 4).fill(Infinity), prev = new Int32Array(W * H * 4).fill(-1);
    const heap = [];
    const push = (s, f) => { heap.push([f, s]); let i = heap.length - 1; while (i) { const q = (i - 1) >> 1; if (heap[q][0] <= heap[i][0]) break; [heap[q], heap[i]] = [heap[i], heap[q]]; i = q; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const hx = cx(b.x), hy = cy(b.y);
    const h = (i, j) => Math.abs(i - hx) + Math.abs(j - hy);
    const flow = a.dir || 1;
    for (const p of src) {
      const s = (p.j * W + p.i) * 4 + p.d, c0 = p.side === (flow > 0 ? 0 : 2) ? 0 : 3;
      g[s] = c0; push(s, c0 + h(p.i, p.j));
    }
    let end = -1, n = 0;
    while (heap.length && n++ < 200000) {
      const [, s] = pop();
      if (goal.has(s)) { end = s; break; }
      const d = s & 3, cell = s >> 2, i = cell % W, j = (cell - i) / W;
      for (const nd of [d, (d + 1) % 4, (d + 3) % 4]) {
        const ni = i + DX[nd], nj = j + DY[nd];
        if (ni < 0 || nj < 0 || ni >= W || nj >= H || wall[nj * W + ni]) continue;
        const t = (nj * W + ni) * 4 + nd, cost = g[s] + 1 + (nd !== d ? 5 : 0) + (near[nj * W + ni] ? 0.6 : 0);
        if (cost < g[t]) { g[t] = cost; prev[t] = s; push(t, cost + h(ni, nj)); }
      }
    }
    if (end < 0) return null;
    // corners in world coordinates
    const cells = [];
    for (let s = end; s >= 0; s = prev[s]) cells.push(s);
    cells.reverse();
    const P = (s) => { const cell = s >> 2, i = cell % W; return { x: x0 + i * C, y: y0 + ((cell - i) / W) * C }; };
    const sp = src.find((p) => (p.j * W + p.i) * 4 + p.d === cells[0]) || src[0], ep = goal.get(end);
    const Q = [P(cells[0])];
    for (let k = 1; k < cells.length - 1; k++) if ((cells[k] & 3) !== (cells[k + 1] & 3)) Q.push(P(cells[k]));
    Q.push(P(cells[cells.length - 1]));
    // the end legs leave / arrive at the middle of a side: move them onto the
    // node's axis, together with the rest of their straight run
    const snap = (i, step, axis, val) => {
      for (let k = i; k >= 0 && k < Q.length; k += step) {
        const old = Q[k][axis]; Q[k][axis] = val;
        if (!Q[k + step] || Math.abs(Q[k + step][axis] - old) > 0.5) break;
      }
    };
    snap(0, 1, DX[sp.side] ? "y" : "x", DX[sp.side] ? a.y : a.x);
    snap(Q.length - 1, -1, DX[ep.side] ? "y" : "x", DX[ep.side] ? b.y : b.x);
    const pts = [{ x: a.x + DX[sp.side] * a.w / 2, y: a.y + DY[sp.side] * a.h / 2 }, ...Q, { x: b.x + DX[ep.side] * (b.w / 2 + 3), y: b.y + DY[ep.side] * (b.h / 2 + 3) }];
    // drop repeated and collinear points
    const out = [];
    for (const q of pts) {
      const p = out[out.length - 1], o = out[out.length - 2];
      if (p && Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5) continue;
      if (o && ((Math.abs(o.x - p.x) < 0.5 && Math.abs(p.x - q.x) < 0.5) || (Math.abs(o.y - p.y) < 0.5 && Math.abs(p.y - q.y) < 0.5))) out.pop();
      out.push(q);
    }
    return roundedPolyline(out);
  }
  function roundedPolyline(pts) {
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i - 1], q = pts[i], r = pts[i + 1];
      const l1 = Math.hypot(q.x - p.x, q.y - p.y), l2 = Math.hypot(r.x - q.x, r.y - q.y);
      const rad = Math.min(26, l1 / 2, l2 / 2);
      const ax = q.x + (p.x - q.x) * rad / (l1 || 1), ay = q.y + (p.y - q.y) * rad / (l1 || 1);
      const bx = q.x + (r.x - q.x) * rad / (l2 || 1), by = q.y + (r.y - q.y) * rad / (l2 || 1);
      d += ` L${ax},${ay} Q${q.x},${q.y} ${bx},${by}`;
    }
    const z = pts[pts.length - 1];
    d += ` L${z.x},${z.y}`;
    // label at half the length
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    let acc = 0, mid = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (acc + l >= total / 2) { const t = (total / 2 - acc) / (l || 1); mid = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }; break; }
      acc += l;
    }
    return { d, mid };
  }

  /* A long edge through its tidy waypoints. Every waypoint has a direction of
   * travel; consecutive waypoints in opposite directions make a U-turn round
   * the end of a band. While the nodes glide, the waypoints glide with them. */
  function routedPath(a, b, rt, pa, pb) {
    const n = rt.pts.length;
    const pts = rt.pts.map((q, i) => {
      const f = (i + 1) / (n + 1);
      return { ...q, x: q.x + (a.x - pa.x) * (1 - f) + (b.x - pb.x) * f, y: q.y + (a.y - pa.y) * (1 - f) + (b.y - pb.y) * f };
    });
    const sgn = rt.rev ? -1 : 1, d0 = (pa.dir || 1) * sgn, d1 = (pb.dir || 1) * sgn;
    const P = [{ x: a.x + d0 * a.w / 2, y: a.y, dir: d0, half: 0 }, ...pts, { x: b.x - d1 * (b.w / 2 + 3), y: b.y, dir: d1, half: 0 }];
    let d = `M${P[0].x},${P[0].y}`, mid = null;
    const segs = [];
    for (let i = 1; i < P.length; i++) {
      const p = P[i - 1], q = P[i];
      let c1x, c2x;
      if (p.dir !== q.dir) {           // U-turn past the end of the band
        const out = p.dir > 0 ? Math.max(p.x + p.half, q.x + q.half) : Math.min(p.x - p.half, q.x - q.half);
        const X = out + p.dir * 34 / 0.75;
        c1x = X; c2x = X;
      } else {
        const c = Math.max(24, Math.abs(q.x - p.x) * 0.45);
        c1x = p.x + p.dir * c; c2x = q.x - q.dir * c;
      }
      segs.push(cubic(p.x, p.y, c1x, p.y, c2x, q.y, q.x, q.y));
      d += ` C${c1x},${p.y} ${c2x},${q.y} ${q.x},${q.y}`;
    }
    mid = segs[Math.floor(segs.length / 2)].mid;
    return { d, mid };
  }

  function directPath(a, b) {
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
    return cubic(sx, sy, c1x, c1y, c2x, c2y, tx, ty);
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

  function reset() { clearAll(); pos.clear(); cur.clear(); lastSeen.clear(); stale.clear(); routes.clear(); gridCache.clear(); shown = null; shownData = null; autoFit = true; onEmptyChange(true); }

  return { init, render, tidy: () => tidy(), relayout, fit: setAutoFit, reset, get shown() { return shown; } };
})();
