/* Edge paths: the direct curve, detours round nodes in the way (U-turns, arcs, an A* grid route),
 * and long edges through the waypoints of the last tidy. Pure geometry plus a route cache. */
const BoardRouting = (() => {
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
    if (rt.poly) return outsidePath(a, b, rt.poly);
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

  /* A back edge round the outside of the layout (see tidy.js): sideways out to
   * the line X and along it ("v"), or up over the row to the line Y ("h"). */
  function outsidePath(a, b, poly) {
    if (poly.kind === "h") {
      return roundedPolyline([{ x: a.x, y: a.y - a.h / 2 }, { x: a.x, y: poly.Y }, { x: b.x, y: poly.Y }, { x: b.x, y: b.y - b.h / 2 - 3 }]);
    }
    const sa = Math.sign(poly.X - a.x) || 1, sb = Math.sign(poly.X - b.x) || 1;
    const p = roundedPolyline([{ x: a.x + sa * a.w / 2, y: a.y }, { x: poly.X, y: a.y }, { x: poly.X, y: b.y }, { x: b.x + sb * (b.w / 2 + 3), y: b.y }]);
    // the label on the longer horizontal leg, not out on the margin line
    const la = Math.abs(poly.X - a.x) - a.w / 2, lb = Math.abs(poly.X - b.x) - b.w / 2;
    const [n, s] = la >= lb ? [a, sa] : [b, sb];
    if (Math.max(la, lb) > 90) p.mid = { x: (n.x + s * n.w / 2 + poly.X) / 2, y: n.y };
    return p;
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

  return { edgePath, routedPath, clearCache: () => gridCache.clear() };
})();
