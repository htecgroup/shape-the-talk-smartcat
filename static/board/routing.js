/* Edge paths: the direct curve, detours round nodes in the way (U-turns, arcs, an A* grid route),
 * and long edges through the waypoints of the last tidy (or along ELK's route, elk.js). routeAll
 * lays out all edges of a board together: spread ports where several edges meet one side of a
 * node, grid routes that keep out of each other's corridors, and labels where they don't cover
 * other labels, nodes or lines. Pure geometry plus a route cache.
 *
 * A path is {d, mid, pts}: the SVG path, its middle (where the label wants to be) and points
 * along it (for collision checks). A node may carry off: its port is moved that far along the
 * side the edge uses (y on the left / right, x on the top / bottom). */
const BoardRouting = (() => {
  const O = (n) => n.off || 0;
  const cubic = (sx, sy, c1x, c1y, c2x, c2y, tx, ty) => {
    const m = (t) => {
      const u = 1 - t;
      return { x: u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * tx,
               y: u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ty };
    };
    const pts = [];
    for (let i = 0; i <= 24; i++) pts.push(m(i / 24));
    return { d: `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`, mid: m(0.5), pts };
  };
  // points every ~14 px along a polyline
  function densify(pts) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i], n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 14));
      for (let k = 1; k <= n; k++) out.push({ x: p.x + (q.x - p.x) * k / n, y: p.y + (q.y - p.y) * k / n });
    }
    return out;
  }
  const length = (pts) => { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return l; };
  // how many other nodes a route runs through
  function blocked(route, a, b, boxes) {
    let n = 0;
    for (const o of boxes) {
      if (o.id === a.id || o.id === b.id) continue;
      for (let i = 1; i < route.pts.length - 1; i++) {
        const p = route.pts[i];
        if (Math.abs(p.x - o.x) < o.w / 2 + 6 && Math.abs(p.y - o.y) < o.h / 2 + 6) { n++; break; }
      }
    }
    return n;
  }

  /* Edge from a to b. The direct curve, unless it runs through other nodes:
   * then try to go around (a U-turn past the side of a column, or an arc over
   * or under a row) and keep the route that crosses the fewest nodes. */
  function edgePath(a, b, boxes = [], G = null) {
    const direct = directPath(a, b);
    if (!boxes.length || !blocked(direct, a, b, boxes)) return { ...direct, n: 0 };
    const dx = b.x - a.x, dy = b.y - a.y, routes = [direct];
    const sameCol = Math.abs(dx) < (a.w + b.w) / 2, sameRow = Math.abs(dy) < Math.max(a.h, b.h);
    const ay = a.y + O(a), by = b.y + O(b);
    for (const s of sameCol ? [a.dir || 1, -(a.dir || 1)] : []) {   // U-turn beside the column
      const sx = a.x + s * a.w / 2, tx = b.x + s * (b.w / 2 + 3);
      const edge = s > 0 ? Math.max(sx, tx) : Math.min(sx, tx);
      const X = edge + s * (26 + Math.abs(dy) * 0.04) / 0.75;
      routes.push(cubic(sx, ay, X, ay, X, by, tx, by));
    }
    for (const s of sameRow ? [-1, 1] : []) {               // arc over / under the row
      const sy = a.y + s * a.h / 2, ty = b.y + s * (b.h / 2 + 3);
      const edge = s > 0 ? Math.max(sy, ty) : Math.min(sy, ty);
      const Y = edge + s * (30 + Math.abs(dx) * 0.06) / 0.75;
      routes.push(cubic(a.x + O(a), sy, a.x + dx * 0.15, Y, b.x - dx * 0.15, Y, b.x + O(b), ty));
    }
    let best = direct, bestN = Infinity;
    for (const r of routes) { const n = blocked(r, a, b, boxes); if (n < bestN) { best = r; bestN = n; } }
    if (!bestN || !G) return { ...best, n: bestN };
    // nothing simple is free: find a way round the nodes on a grid
    const res = gridRoute(a, b, G);
    return res ? { ...res, n: 0 } : { ...best, n: bestN };
  }

  /* The grid the A* routes run on: walls round the nodes, a small cost close
   * to them, and the cells the edges routed so far run through (used: 1 =
   * along x, 2 = along y), so the next route keeps out of their corridors. */
  function makeGrid(boxes) {
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
    return { C, x0, y0, W, H, cx, cy, wall, near, used: new Uint8Array(W * H) };
  }
  // mark the cells a path runs through
  function occupy(G, pts) {
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      G.used[G.cy(q.y) * G.W + G.cx(q.x)] |= Math.abs(q.x - p.x) >= Math.abs(q.y - p.y) ? 1 : 2;
    }
  }

  /* A* on a coarse grid around the nodes (ports on all four sides, turns
   * cost extra, running along another edge costs extra), then the corners
   * are rounded so it still looks hand drawn. */
  function gridRoute(a, b, G) {
    const { C, x0, y0, W, H, cx, cy, near, used } = G;
    const wall = G.wall.slice();
    const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
    const ports = (n, out) => [0, 1, 2, 3].map((d) => {
      const px = n.x + DX[d] * (n.w / 2 + 14) + (DY[d] ? O(n) : 0), py = n.y + DY[d] * (n.h / 2 + 14) + (DX[d] ? O(n) : 0);
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
        const u = used[nj * W + ni], along = u & (DX[nd] ? 1 : 2);
        const t = (nj * W + ni) * 4 + nd, cost = g[s] + 1 + (nd !== d ? 5 : 0) + (near[nj * W + ni] ? 0.6 : 0) + (along ? 4 : u ? 0.4 : 0);
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
    snap(0, 1, DX[sp.side] ? "y" : "x", DX[sp.side] ? a.y + O(a) : a.x + O(a));
    snap(Q.length - 1, -1, DX[ep.side] ? "y" : "x", DX[ep.side] ? b.y + O(b) : b.x + O(b));
    const pts = [{ x: a.x + DX[sp.side] * a.w / 2 + (DY[sp.side] ? O(a) : 0), y: a.y + DY[sp.side] * a.h / 2 + (DX[sp.side] ? O(a) : 0) }, ...Q,
      { x: b.x + DX[ep.side] * (b.w / 2 + 3) + (DY[ep.side] ? O(b) : 0), y: b.y + DY[ep.side] * (b.h / 2 + 3) + (DX[ep.side] ? O(b) : 0) }];
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
    return { d, mid, pts: densify(pts) };
  }

  /* A long edge through its tidy waypoints. Every waypoint has a direction of
   * travel; consecutive waypoints in opposite directions make a U-turn round
   * the end of a band. While the nodes glide, the waypoints glide with them. */
  function routedPath(a, b, rt, pa, pb) {
    if (rt.poly) return outsidePath(a, b, rt.poly);
    if (rt.elk) return elkPath(a, b, rt, pa, pb);
    const n = rt.pts.length;
    const pts = rt.pts.map((q, i) => {
      const f = (i + 1) / (n + 1);
      return { ...q, x: q.x + (a.x - pa.x) * (1 - f) + (b.x - pb.x) * f, y: q.y + (a.y - pa.y) * (1 - f) + (b.y - pb.y) * f };
    });
    const sgn = rt.rev ? -1 : 1, d0 = (pa.dir || 1) * sgn, d1 = (pb.dir || 1) * sgn;
    const P = [{ x: a.x + d0 * a.w / 2, y: a.y + O(a), dir: d0, half: 0 }, ...pts, { x: b.x - d1 * (b.w / 2 + 3), y: b.y + O(b), dir: d1, half: 0 }];
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
    return { d, mid, pts: segs.flatMap((s) => s.pts) };
  }

  /* An edge along ELK's orthogonal route (elk.js: rt.elk, its points from end to end; rt.mid, its label), the
   * corners rounded like the grid routes. While the nodes glide, the points glide with them. Each end is moved onto
   * the outline its node is drawn with (a diamond's sides, the group box), the arrow end 3 px short of it. */
  function elkPath(a, b, rt, pa, pb) {
    const n = rt.elk.length, at = (q, f) => ({ x: q.x + (a.x - pa.x) * (1 - f) + (b.x - pb.x) * f, y: q.y + (a.y - pa.y) * (1 - f) + (b.y - pb.y) * f });
    const P = rt.elk.map((q, i) => at(q, i / (n - 1)));
    const onto = (i, j, o, gap) => {
      const p = P[i], q = P[j], diamond = o.type === "decision";
      if (Math.abs(q.x - p.x) >= Math.abs(q.y - p.y)) {
        const s = Math.sign(q.x - p.x) || 1, t = Math.min(1, Math.abs(p.y - o.y) / (o.h / 2));
        p.x = o.x + s * ((diamond ? (o.w / 2) * Math.max(0.12, 1 - t) : o.w / 2) + gap);
      } else {
        const s = Math.sign(q.y - p.y) || 1, t = Math.min(1, Math.abs(p.x - o.x) / (o.w / 2));
        p.y = o.y + s * ((diamond ? (o.h / 2) * Math.max(0.12, 1 - t) : o.h / 2) + gap);
      }
    };
    // a jog of a few px right at an end (ELK's ports don't line up exactly): move the end along its side instead
    const JOG = 12, near = (p, q) => Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5;
    if (n >= 4) {
      for (const [e, j, k, o] of [[0, 1, 2, a], [n - 1, n - 2, n - 3, b]]) {
        const ax = Math.abs(P[e].x - P[j].x) < 0.5 ? "x" : Math.abs(P[e].y - P[j].y) < 0.5 ? "y" : null;
        const half = ax && (ax === "x" ? o.w : o.h) / 2 * (o.type === "decision" ? 0.5 : 1) - 6;
        if (ax && Math.abs(P[k][ax] - P[j][ax]) < JOG && Math.abs(P[k][ax] - o[ax]) < half) { P[e][ax] = P[k][ax]; P[j][ax] = P[k][ax]; }
      }
    }
    for (let i = P.length - 2; i > 0; i--) if (near(P[i], P[i + 1]) || near(P[i], P[i - 1])) P.splice(i, 1);
    if (P.length >= 2) { onto(0, 1, a, 0); onto(P.length - 1, P.length - 2, b, 3); }
    const r = roundedPolyline(P);
    if (rt.mid) r.mid = at(rt.mid, 0.5);
    return r;
  }

  /* A back edge round the outside of the layout (see tidy.js): sideways out to
   * the line X and along it ("v"), or up over the row to the line Y ("h"). */
  function outsidePath(a, b, poly) {
    if (poly.kind === "h") {
      return roundedPolyline([{ x: a.x + O(a), y: a.y - a.h / 2 }, { x: a.x + O(a), y: poly.Y }, { x: b.x + O(b), y: poly.Y }, { x: b.x + O(b), y: b.y - b.h / 2 - 3 }]);
    }
    const sa = Math.sign(poly.X - a.x) || 1, sb = Math.sign(poly.X - b.x) || 1;
    const ay = a.y + O(a), by = b.y + O(b);
    const p = roundedPolyline([{ x: a.x + sa * a.w / 2, y: ay }, { x: poly.X, y: ay }, { x: poly.X, y: by }, { x: b.x + sb * (b.w / 2 + 3), y: by }]);
    // the label on the longer horizontal leg, not out on the margin line
    const la = Math.abs(poly.X - a.x) - a.w / 2, lb = Math.abs(poly.X - b.x) - b.w / 2;
    const [n, s] = la >= lb ? [a, sa] : [b, sb];
    if (Math.max(la, lb) > 90) p.mid = { x: (n.x + s * n.w / 2 + poly.X) / 2, y: n.y + O(n) };
    return p;
  }

  function directPath(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    let sx, sy, tx, ty, c1x, c1y, c2x, c2y;
    if (Math.abs(dx) >= Math.abs(dy) * 1.1 || Math.abs(dx) > (a.w + b.w) / 2 + 30) {
      const s = Math.sign(dx) || 1;
      sx = a.x + s * a.w / 2; sy = a.y + O(a); tx = b.x - s * (b.w / 2 + 3); ty = b.y + O(b);
      const c = Math.max(36, Math.abs(tx - sx) * 0.45);
      c1x = sx + s * c; c1y = sy; c2x = tx - s * c; c2y = ty;
    } else {
      const s = Math.sign(dy) || 1;
      sx = a.x + O(a); sy = a.y + s * a.h / 2; tx = b.x + O(b); ty = b.y - s * (b.h / 2 + 3);
      const c = Math.max(30, Math.abs(ty - sy) * 0.45);
      c1x = sx; c1y = sy + s * c; c2x = tx; c2y = ty - s * c;
    }
    return cubic(sx, sy, c1x, c1y, c2x, c2y, tx, ty);
  }

  /* One edge on its own. Waypoints from the last tidy, unless that runs
   * through a node; round the outside (rt.poly), unless a way through the board
   * is much shorter; otherwise edgePath. G: the A* grid, or null (still moving). */
  function pathOf(e, boxes, G) {
    const { a, b, rt } = e;
    if (!rt) return edgePath(a, b, boxes, G);
    const r = routedPath(a, b, rt, e.pa, e.pb), n = blocked(r, a, b, boxes);
    if (rt.poly) {
      const g = G && gridRoute(a, b, G);
      return g && (n || length(g.pts) < 0.8 * length(r.pts)) ? { ...g, n: 0 } : { ...r, n };
    }
    if (!n) return { ...r, n };
    const alt = edgePath(a, b, boxes, G);
    return alt.n < n ? alt : { ...r, n };
  }

  /* All edges: the simple ones first, then the ones that need the grid, each
   * marking the cells it runs through so the next one keeps out of them. */
  function pathsOf(list, boxes, G) {
    const res = new Map(), later = [];
    for (const e of list) {
      const r = pathOf(e, boxes, null);
      res.set(e.id, r);
      if (G && (r.n || (e.rt && e.rt.poly))) later.push(e); else if (G) occupy(G, r.pts);
    }
    for (const e of later) { const r = pathOf(e, boxes, G); res.set(e.id, r); occupy(G, r.pts); }
    return res;
  }

  /* Several edges on one side of a node: spread their ends along the side,
   * in the order of where they come from, so they don't run on top of each
   * other. Returns Map "edge:a|b" -> offset. */
  function spreadPorts(list, res) {
    // side of n a path end p is on: 0 right, 1 bottom, 2 left, 3 top
    const sideOf = (n, p, m) => (Math.abs(Math.abs(p.x - n.x) - (n.w / 2 + m)) < 1.5 && Math.abs(p.y - n.y) <= n.h / 2 + 1 ? (p.x > n.x ? 0 : 2) : (p.y > n.y ? 1 : 3));
    const ends = new Map();
    for (const e of list) {
      const p = res.get(e.id).pts;
      for (const [end, n, q, m, o] of [["a", e.a, p[0], 0, e.b], ["b", e.b, p[p.length - 1], 3, e.a]]) {
        if (n.type === "decision") continue;   // a diamond only has its corners
        const s = sideOf(n, q, m), k = `${n.id}:${s}`;
        if (!ends.has(k)) ends.set(k, []);
        ends.get(k).push({ id: `${e.id}:${end}`, n, s, at: s % 2 ? o.x : o.y });
      }
    }
    const offs = new Map();
    for (const l of ends.values()) {
      if (l.length < 2) continue;
      const { n, s } = l[0];
      const gap = Math.min(16, ((s % 2 ? n.w : n.h) - 18) / (l.length - 1));
      l.sort((p, q) => p.at - q.at || (p.id < q.id ? -1 : 1));
      l.forEach((p, i) => offs.set(p.id, (i - (l.length - 1) / 2) * gap));
    }
    return offs;
  }

  /* Labels: from the middle of their edge outwards to the first spot that
   * covers no node, no label placed before and no other edge; failing that
   * the spot that covers the least. Short edges choose first (fewer spots). */
  function placeLabels(list, res, boxes) {
    const out = new Map(), placed = [];
    const segs = [];   // [edge id, bbox of a short piece of its path]
    for (const e of list) {
      const p = res.get(e.id).pts;
      for (let i = 1; i < p.length; i++) segs.push([e.id, Math.min(p[i - 1].x, p[i].x), Math.min(p[i - 1].y, p[i].y), Math.max(p[i - 1].x, p[i].x), Math.max(p[i - 1].y, p[i].y)]);
    }
    const withLabel = list.filter((e) => e.lw).map((e) => {
      const p = res.get(e.id).pts, acc = [0];
      for (let i = 1; i < p.length; i++) acc.push(acc[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y));
      return { e, p, acc };
    }).sort((u, v) => u.acc[u.acc.length - 1] - v.acc[v.acc.length - 1]);
    for (const { e, p, acc } of withLabel) {
      const L = acc[acc.length - 1], hw = e.lw / 2 + 3, hh = 12, mid = res.get(e.id).mid;
      const pointAt = (s) => {
        let i = 1;
        while (i < acc.length - 1 && acc[i] < s) i++;
        const t = (s - acc[i - 1]) / ((acc[i] - acc[i - 1]) || 1);
        return { x: p[i - 1].x + (p[i].x - p[i - 1].x) * t, y: p[i - 1].y + (p[i].y - p[i - 1].y) * t };
      };
      let s0 = 0, dm = Infinity;
      p.forEach((q, i) => { const dd = Math.hypot(q.x - mid.x, q.y - mid.y); if (dd < dm) { dm = dd; s0 = acc[i]; } });
      const lo = Math.min(s0, 12), hi = Math.max(s0, L - 12), z = p[p.length - 1];
      const cost = (c) => {
        // not over its own arrowhead
        let k = Math.abs(c.x - z.x) < hw + 12 && Math.abs(c.y - z.y) < hh + 12 ? 10 : 0;
        for (const o of boxes) if (Math.abs(c.x - o.x) < hw + o.w / 2 + 2 && Math.abs(c.y - o.y) < hh + o.h / 2 + 2) k += 10;
        for (const q of placed) if (Math.abs(c.x - q.x) < hw + q.hw && Math.abs(c.y - q.y) < hh + q.hh) k += 10;
        const hit = new Set();
        for (const [id, x0, y0, x1, y1] of segs) if (id !== e.id && !hit.has(id) && x1 > c.x - hw && x0 < c.x + hw && y1 > c.y - hh + 3 && y0 < c.y + hh - 3) hit.add(id);
        return k + 2 * hit.size;
      };
      let best = null;
      for (let j = 0; j < 80; j++) {
        const s = s0 + (j % 2 ? 1 : -1) * Math.ceil(j / 2) * 14;
        if (s < lo || s > hi) { if (s0 - Math.ceil(j / 2) * 14 < lo && s0 + Math.ceil(j / 2) * 14 > hi) break; continue; }
        const c = pointAt(s), k = cost(c) + Math.abs(s - s0) * 0.004;
        if (!best || k < best.k) best = { ...c, k };
        if (k < 1) break;
      }
      const at = best || mid;
      placed.push({ x: at.x, y: at.y, hw, hh });
      out.set(e.id, { x: at.x, y: at.y });
    }
    return out;
  }

  /* Paths and label spots for all edges of the board.
   * list: [{id, a, b, rt, pa, pb, lw}]: a / b the end nodes ({id, x, y, w, h, dir, type}),
   * rt the waypoints from the last tidy (only while both ends sit where tidy put them),
   * lw the label width (0: none). Returns Map id -> {d, mid, pts, label}. While nodes
   * move only the simple paths (it runs every frame); once nothing moves
   * (boxes.settled) the ports, grid routes and labels are worked out, and kept
   * until something changes. */
  const cache = { sig: null, res: null };
  function routeAll(list, boxes) {
    const sig = boxes.settled ? `${boxes.sig}#${list.map((e) => `${e.id}:${e.a.id}>${e.b.id}:${Math.round(e.lw)}:${e.rt ? (e.rt.poly ? "o" : e.rt.elk ? `e${e.rt.elk.length}` : e.rt.pts.length) : ""}`).join("|")}` : null;
    if (sig && cache.sig === sig) return cache.res;
    const G = boxes.settled && list.length ? makeGrid(boxes) : null;
    let res = pathsOf(list, boxes, G && { ...G, used: new Uint8Array(G.used.length) });
    const offs = boxes.settled ? spreadPorts(list, res) : new Map();
    if (offs.size) {
      const moved = list.map((e) => ({ ...e, a: { ...e.a, off: offs.get(`${e.id}:a`) || 0 }, b: { ...e.b, off: offs.get(`${e.id}:b`) || 0 } }));
      res = pathsOf(moved, boxes, G);
    }
    const labels = boxes.settled ? placeLabels(list, res, boxes) : new Map();
    const out = new Map();
    for (const e of list) { const r = res.get(e.id); out.set(e.id, { d: r.d, mid: r.mid, pts: r.pts, label: labels.get(e.id) || r.mid }); }
    if (sig) { cache.sig = sig; cache.res = out; }
    return out;
  }

  return { routeAll, clearCache: () => { cache.sig = null; cache.res = null; } };
})();
