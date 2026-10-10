const BoardTidy = (() => {
  const { textW } = BoardSvg;

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

  /* sizes: Map node id -> {w, h} of the drawn nodes; panel: the board container's rect. */
  function layoutBoard(board, sizes, panel) {
    const ids = Object.keys(board.nodes);
    const order = new Map(ids.map((id, i) => [id, (board.nodes[id].created_v || 0) * 1e4 + i]));
    const item = (id) => {
      const ne = sizes.get(id);
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
    const PW = Math.max(320, panel.width - 168), PH = Math.max(240, panel.height - 112 - 30);
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

  return { layoutBoard };
})();
