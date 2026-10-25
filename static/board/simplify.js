/* The board as drawn, a little simpler than the board data (presentation only, deterministic):
 *
 *  - a shared sink (a node many branches end at, like "Human agent") keeps the edges from sources
 *    near it; an edge from far away ends at a small stub next to its source instead ("→ Human
 *    agent" under the edge's label, an off-page connector in the target's colours, in the source's
 *    group if it has one), so it doesn't cross the whole board. Which edges are far depends on the
 *    layout (see layout()); the stubs take part in it as nodes of their own, next to their source.
 *  - a node with edges to all (or most, >= 3) members of a group with the same label gets one
 *    edge to the group box instead; the same for edges from most members of a group to one node.
 *
 * view(board, stubs) is that view: nodes (with the stubs), edges for the layout (stubbed edges end
 * at their stub; edges into a group stay per member, tidy merges them into one block edge anyway)
 * and drawn (what is drawn: merged edges instead of their members), and each reference node of a detail board
 * with refDir (in / out / both: how its edges run). layout() is tidy with the
 * stubs worked out, route() routes its result. A group end of an edge is the id groupRef(gid).
 * Loaded after svg, shapes, tidy, elk and routing. */
const BoardSimplify = (() => {
  const STUB_FAN_IN = 3;   // edges from this many sources make a node a shared sink
  const FAR = 260;         // an edge whose ends are further apart (gap between the boxes, px) gets a stub
  const GROUP_MIN = 3;     // edges to (or from) at least this many members of a group, and
  const GROUP_SHARE = 0.75;   // at least this share of its members, are one edge to the group box
  const GPAD = { l: 22, r: 22, t: 36, b: 22 };   // the group box round its members (as board.js draws it)

  const groupRef = (gid) => `\u0002${gid}`;
  const groupOf = (ref) => (typeof ref === "string" && ref[0] === "\u0002" ? ref.slice(1) : null);
  const stubId = (eid) => `stub:${eid}`;   // printable: it ends up in the DOM (data-id), and so in the PNG export's XML
  const normLabel = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  /* Edges between a node outside a group and most of its members, with one label, as one edge. */
  function mergeGroups(board, edges) {
    const merged = [], hidden = new Set();
    for (const gid of Object.keys(board.groups || {})) {
      const ms = new Set(Object.keys(board.nodes).filter((id) => board.nodes[id].group === gid));
      if (ms.size < GROUP_MIN) continue;
      for (const out of [true, false]) {   // out: node -> members; else members -> node
        const by = new Map();
        for (const e of edges) {
          const [o, m] = out ? [e.from, e.to] : [e.to, e.from];
          if (!ms.has(m) || ms.has(o) || hidden.has(e.id)) continue;
          if (!by.has(o)) by.set(o, []);
          by.get(o).push(e);
        }
        for (const [o, es] of by) {
          // one label: the most common one, with the unlabelled edges
          const keys = [...new Set(es.map((e) => normLabel(e.label)).filter(Boolean))];
          let best = es.filter((e) => !normLabel(e.label));
          for (const k of keys) {
            const c = es.filter((e) => !normLabel(e.label) || normLabel(e.label) === k);
            if (c.length > best.length) best = c;
          }
          const covered = new Set(best.map((e) => (out ? e.to : e.from)));
          if (covered.size < GROUP_MIN || covered.size < GROUP_SHARE * ms.size) continue;
          const lab = best.find((e) => e.label);
          const st = new Set(best.map((e) => e.status));
          best.forEach((e) => hidden.add(e.id));
          merged.push({
            id: out ? `\u0005${o}>${gid}` : `\u0005${gid}>${o}`, from: out ? o : groupRef(gid), to: out ? groupRef(gid) : o,
            label: lab ? lab.label : "", status: st.size === 1 ? [...st][0] : "confirmed",
            note: `${covered.size} of ${ms.size} in ${board.groups[gid].label || gid}`,
            by: best[best.length - 1].by, src: best.map((e) => e.src).filter(Boolean).join(", "),
            v: Math.max(...best.map((e) => e.v || 0)), members: best.map((e) => e.id),
          });
        }
      }
    }
    return { merged, hidden };
  }

  /* stubs: ids of the edges drawn to a stub (from layout(); others are ignored). */
  function view(board, stubs = new Set()) {
    const ok = (e) => board.nodes[e.from] && board.nodes[e.to] && e.from !== e.to;
    const edges = Object.values(board.edges).filter(ok);
    const { merged, hidden } = mergeGroups(board, edges);
    const stubOf = new Map();
    for (const e of edges) if (stubs.has(e.id) && !hidden.has(e.id)) stubOf.set(e.id, stubId(e.id));
    // nodes, each stub right after its source (tidy orders by creation, then by key order)
    const after = new Map();
    for (const e of edges) {
      if (!stubOf.has(e.id)) continue;
      const t = board.nodes[e.to], f = board.nodes[e.from];
      // in its source's group, if any: right beside it, inside the group's box
      const s = { id: stubOf.get(e.id), type: "stub", label: t.label, ref: e.to, refType: t.type, edge: e.id, edgeLabel: e.label || "", status: e.status,
                  created_v: f.created_v, v: e.v, by: e.by, src: e.src, ...(f.group ? { group: f.group } : {}) };
      if (!after.has(e.from)) after.set(e.from, []);
      after.get(e.from).push(s);
    }
    // a reference to a node of the overview (on a detail board) reads "from X" where the edges leave it, "→ X" where they reach it
    const refDir = (id) => {
      const i = edges.some((e) => e.to === id), o = edges.some((e) => e.from === id);
      return i && o ? "both" : o ? "out" : "in";
    };
    const nodes = {};
    for (const [id, n] of Object.entries(board.nodes)) {
      nodes[id] = n.ref_board ? { ...n, refDir: refDir(id) } : n;
      for (const s of after.get(id) || []) nodes[s.id] = s;
    }
    const lay = {}, drawn = {};
    for (const e of edges) {
      // the stub shows the edge's label: the short edge to it has none
      const x = stubOf.has(e.id) ? { ...e, to: stubOf.get(e.id), ref: e.to, label: "" } : e;
      lay[e.id] = x;
      if (!hidden.has(e.id)) drawn[e.id] = x;
    }
    for (const m of merged) drawn[m.id] = m;
    return { ...board, nodes, edges: lay, drawn };
  }

  // the gap between two boxes (0 when they touch or overlap)
  const gap = (a, b, sa, sb) => Math.hypot(Math.max(0, Math.abs(a.x - b.x) - (sa.w + sb.w) / 2), Math.max(0, Math.abs(a.y - b.y) - (sa.h + sb.h) / 2));

  /* Which edges into a shared sink are far in this layout (pos: id -> {x, y}): all but the nearest
   * one, if further than far. Not the edges from inside the sink's own group, nor merged ones.
   * v: a view without stubs (every edge to its real target). */
  function chooseStubs(v, pos, size, far) {
    const into = new Map();
    for (const e of Object.values(v.drawn)) {
      if (!v.nodes[e.from] || !v.nodes[e.to]) continue;   // group ends
      const g = v.nodes[e.to].group;
      if (g && v.nodes[e.from].group === g) continue;
      if (!into.has(e.to)) into.set(e.to, []);
      into.get(e.to).push(e);
    }
    const out = new Set();
    for (const [t, es] of into) {
      if (new Set(es.map((e) => e.from)).size < STUB_FAN_IN || !pos.get(t)) continue;
      const by = es.map((e) => ({ e, d: pos.get(e.from) ? gap(pos.get(e.from), pos.get(t), size(e.from), size(t)) : 0 })).sort((p, q) => p.d - q.d);
      for (const { e, d } of by.slice(1)) if (d > far) out.add(e.id);
    }
    return out;
  }

  /* The box of a group round its members, {x, y, w, h, dir} (centre), or null. geom: id -> {x, y, w, h, dir} or null. */
  function groupBox(v, gid, geom) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, dir = 1;
    for (const n of Object.values(v.nodes)) {
      if (n.group !== gid) continue;
      const g = geom(n.id); if (!g) continue;
      if (x0 === Infinity) dir = g.dir || 1;
      x0 = Math.min(x0, g.x - g.w / 2); x1 = Math.max(x1, g.x + g.w / 2); y0 = Math.min(y0, g.y - g.h / 2); y1 = Math.max(y1, g.y + g.h / 2);
    }
    if (x0 === Infinity) return null;
    x0 -= GPAD.l; x1 += GPAD.r; y0 -= GPAD.t; y1 += GPAD.b;
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, dir };
  }

  // tidy's waypoints for a drawn edge; a merged one follows its members' (they are one block edge in tidy)
  const routeOf = (lay, e) => lay.routes.get(e.id) || (e.members || []).map((m) => lay.routes.get(m)).find((r) => r && !r.poly) || null;

  /* The drawn edges of a laid-out view routed as board.js does once nothing moves. lay: layout()'s result.
   * Returns {res: Map id -> {d, mid, pts, label}, list (routeAll's input), boxes, node, geom (node or group end -> box)}. */
  function route(lay) {
    const v = lay.view;
    const node = (id) => { const p = lay.pos.get(id), s = lay.size(id); return p && { id, x: p.x, y: p.y, w: s.w, h: s.h, dir: p.dir || 1, type: v.nodes[id].type }; };
    const geom = (ref) => {
      const g = groupOf(ref);
      if (!g) return node(ref);
      const b = groupBox(v, g, node);
      return b && { ...b, id: ref, type: "group" };
    };
    const boxes = Object.keys(v.nodes).map(node).filter(Boolean);
    boxes.settled = true;
    boxes.sig = `${v.id}:` + boxes.map((o) => `${o.id}:${Math.round(o.x)},${Math.round(o.y)},${Math.round(o.w)},${Math.round(o.h)}`).join("|");
    const list = [];
    for (const e of Object.values(v.drawn)) {
      const a = geom(e.from), b = geom(e.to);
      if (a && b) list.push({ id: e.id, a, b, pa: a, pb: b, rt: routeOf(lay, e), lw: e.label ? BoardSvg.textW(e.label, "13px Kalam") + 10 : 0 });
    }
    return { res: BoardRouting.routeAll(list, boxes), list, boxes, node, geom };
  }

  // crossings between routed edges (as scripts/eval_metrics.py counts them: not close to an end two
  // edges share, crossing points closer than 14 px count once)
  function crossings(list, res) {
    const P = list.map((e) => res.get(e.id).pts);
    const box = (p, s, e) => { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (let k = s; k <= e; k++) { b[0] = Math.min(b[0], p[k].x); b[1] = Math.min(b[1], p[k].y); b[2] = Math.max(b[2], p[k].x); b[3] = Math.max(b[3], p[k].y); } return b; };
    const apart = (u, v) => u[0] > v[2] || v[0] > u[2] || u[1] > v[3] || v[1] > u[3];
    const bb = P.map((p) => box(p, 0, p.length - 1));
    // runs of 8 segments with their boxes, so far apart pieces of two long paths are skipped at once
    const runs = P.map((p) => { const c = []; for (let k = 1; k < p.length; k += 8) { const e = Math.min(p.length - 1, k + 7); c.push({ k, e, b: box(p, k - 1, e) }); } return c; });
    const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    let n = 0;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const shared = [a.a, a.b].filter((n) => n.id === b.a.id || n.id === b.b.id);
      const near = (p) => shared.some((n) => Math.abs(p.x - n.x) < n.w / 2 + 14 && Math.abs(p.y - n.y) < n.h / 2 + 14);
      if (apart(bb[i], bb[j])) continue;
      const found = [];
      for (const ri of runs[i]) for (let k = ri.k; k <= ri.e; k++) for (const rj of runs[j]) {
        if (apart(ri.b, rj.b)) continue;
        for (let m = rj.k; m <= rj.e; m++) {
        const p = P[i][k - 1], q = P[i][k], r = P[j][m - 1], s = P[j][m];
        if (Math.max(p.x, q.x) < Math.min(r.x, s.x) || Math.max(r.x, s.x) < Math.min(p.x, q.x) || Math.max(p.y, q.y) < Math.min(r.y, s.y) || Math.max(r.y, s.y) < Math.min(p.y, q.y)) continue;
        if (side(p, q, r) * side(p, q, s) < 0 && side(r, s, p) * side(r, s, q) < 0 && !near(p) && found.every((f) => Math.hypot(f.x - p.x, f.y - p.y) >= 14)) found.push(p);
        }
      }
      n += found.length;
    }
    return n;
  }

  /* Tidy with the stubs: tidy.js' own layout (BoardTidy.layoutBoard) and ELK's (BoardElk.layoutBoard, left to right,
   * left to right wrapped to the panel, top to bottom; not for a mind map), whichever reads better. Which edges are far
   * depends on the layout, and the layout on the stubs: from the layout without stubs choose the stubs (far: FAR, or
   * twice that), lay the board out with them (tidy: in the next column or right below their source; ELK: wherever it
   * puts them, next to their source), and from the better one choose once more; per family (tidy, ELK). Every
   * candidate is routed; the cheapest wins, in px: the length of the edges, a crossing CROSS_COST, a label over a node
   * half that, a stub STUB_COST, an edge against the reading direction (right to left, or up) BACK_COST, and text
   * smaller than READ after fitting the panel ZOOM_COST per unit of zoom lost. It may be the one without stubs.
   * only: just the layouts whose engine name starts with this (render_board.mjs --engine), else all.
   * Returns the layout's result plus {engine, stubs, view, size}; route() routes it. */
  const STUB_COST = 120, CROSS_COST = 400, BACK_COST = 1000, ZOOM_COST = 10000, READ = 0.75, LONG = 250, LONG_RATE = 0.2;
  function layout(board, sizes, panel, only = null) {
    const base = view(board), L = board.layout && typeof board.layout === "object" ? board.layout : {};
    const PW = Math.max(320, panel.width - 168), PH = Math.max(240, panel.height - 112 - 30);
    const elk = board.kind !== "mindmap" && typeof BoardElk !== "undefined" && BoardElk.available();
    const families = [["tidy", ...(board.kind === "mindmap" ? [] : ["below"])]];
    if (elk) families.push(L.direction === "TB" ? [{ dir: "DOWN" }] : [{ dir: "RIGHT" }, { dir: "RIGHT", wrap: PW / PH }, { dir: "DOWN" }]);
    const name = (mode) => (typeof mode === "object" ? (mode.wrap ? "elk WRAP" : `elk ${mode.dir}`) : mode);
    if (only) families.forEach((f, i) => { families[i] = f.filter((m) => name(m).startsWith(only)); });
    // mode: "tidy", "below" (tidy, each stub right below its source: a layout plan placement) or ELK's options
    const lay = (stubs, mode) => {
      const v = view(board, stubs), sz = new Map(sizes);
      const st = Object.values(v.nodes).filter((n) => n.type === "stub");
      for (const n of st) sz.set(n.id, BoardShapes.stubSize(n.label, n.edgeLabel));
      let res;
      if (typeof mode === "object") res = BoardElk.layoutBoard(v, sz, mode);
      else {
        const plan = mode === "below" ? { layout: { ...L, placements: [...(Array.isArray(L.placements) ? L.placements : []), ...st.map((n) => ({ node: n.id, anchor: board.edges[n.edge].from, side: "below" }))] } } : {};
        res = BoardTidy.layoutBoard({ ...v, ...plan }, sz, panel);
      }
      // engine: which layout this is ("tidy", "below", "elk RIGHT", "elk WRAP", "elk DOWN")
      return res && { ...res, mode, engine: name(mode), stubs, view: v, size: (id) => sz.get(id) || { w: 160, h: 60 } };
    };
    const cost = (c) => {
      const { res, list, boxes } = route(c);
      let len = 0, backs = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const o of boxes) { x0 = Math.min(x0, o.x - o.w / 2); x1 = Math.max(x1, o.x + o.w / 2); y0 = Math.min(y0, o.y - o.h / 2); y1 = Math.max(y1, o.y + o.h / 2); }
      for (const e of list) {
        const p = res.get(e.id).pts, l = res.get(e.id).label;
        let el = 0;
        for (let i = 1; i < p.length; i++) el += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
        // a long edge that keeps clear of everything is only a little worse than a shorter one
        len += Math.min(el, LONG) + LONG_RATE * Math.max(0, el - LONG);
        // a label over a node
        if (e.lw) for (const o of boxes) if (Math.abs(l.x - o.x) < (e.lw + o.w) / 2 - 2 && Math.abs(l.y - o.y) < (20 + o.h) / 2 - 2) len += CROSS_COST / 2;
        // against the reading direction: to the left within a row, or up (on to the next row, down and back to the
        // left, reads fine)
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
        if ((dx < -(e.a.w + e.b.w) / 2 && Math.abs(dy) < (e.a.h + e.b.h) / 2) || (dy < -(e.a.h + e.b.h) / 2 && -dy > Math.abs(dx))) backs++;
      }
      const k = Math.min(PW / Math.max(1, x1 - x0), PH / Math.max(1, y1 - y0 + 26)), cross = crossings(list, res);
      return len + CROSS_COST * cross + BACK_COST * backs + STUB_COST * c.stubs.size + ZOOM_COST * Math.max(0, READ - k);
    };
    const cheapest = (cs) => cs.reduce((a, b) => (b.cost < a.cost ? b : a));
    let best = null;
    for (const modes of families) {
      const none = modes.map((m) => lay(new Set(), m)).filter(Boolean);
      if (!none.length) continue;
      none.forEach((c) => { c.cost = cost(c); });
      const top = cheapest(none);
      if (!best || top.cost < best.cost) best = top;
      // tidy: from its best layout, both ways of placing the stubs; ELK: each shape on its own (a stub only changes
      // things next to its source), unless it is far behind without stubs
      const seeds = typeof top.mode === "object" ? none.filter((c) => c.cost <= 1.5 * top.cost) : [top];
      for (const seed of seeds) {
        if (!chooseStubs(base, seed.pos, seed.size, FAR).size) continue;
        const seen = new Set([""]);
        for (const far of [FAR, 2 * FAR]) {
          let cur = seed;
          for (let round = 0; round < 2; round++) {
            const stubs = chooseStubs(base, cur.pos, cur.size, far), k = [...stubs].sort().join("|");
            if (seen.has(k)) break;
            seen.add(k);
            const cands = (typeof seed.mode === "object" ? [seed.mode] : modes).map((m) => lay(stubs, m)).filter(Boolean);
            if (!cands.length) break;
            for (const c of cands) c.cost = cost(c);
            cur = cheapest(cands);
            if (cur.cost < best.cost) best = cur;
          }
        }
      }
    }
    BoardRouting.clearCache();
    return best || (only ? layout(board, sizes, panel) : null);
  }

  return { view, layout, route, routeOf, groupBox, groupRef, groupOf };
})();
