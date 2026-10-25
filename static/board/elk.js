/* Layered layout with ELK (static/vendor/elk.bundled.js, elkjs 0.9.3, the `layered` algorithm) for Tidy: a candidate
 * next to tidy.js' own layout; simplify.js keeps whichever reads better (see its layout()).
 *
 * The board as ELK sees it: every node with its drawn size (decisions are their diamond's box, stubs and references
 * small pills), every group a compound node (hierarchyHandling INCLUDE_CHILDREN, padded like the drawn group box; a
 * task list is one block, its members in a column), every drawn edge with its label's size (inline, so ELK keeps room
 * for it). The edges are the drawn ones: a merged edge to a group box is an edge to the compound node, a stubbed one
 * ends at its stub. Edges are routed orthogonally; routing.js draws them (rounded) and routes the few ELK leaves
 * without a usable route itself.
 *
 * The story order decides which edges are back edges: a topological order that follows the layout plan's spine (the
 * story's main line) where there is one, else starts from the entry points (sources, actors) in the order they were
 * mentioned. Edges against it are handed to ELK reversed (and turned round again afterwards), so the flow runs one
 * way, and the children are listed in that order (ELK's model order breaks ties in crossing minimisation). Spine
 * edges weigh more for straightness. The plan's placements are only used for order (before / after); above / below
 * and group orientation are left to ELK, which keeps the flow layered instead.
 *
 * ELK's API is a Promise (a worker); the bundle's fake worker runs on this thread anyway, so its dispatcher is
 * called directly and the layout is synchronous, like tidy.js: Tidy, the stub search and Node (render_board.mjs)
 * stay as they are. Returns null when ELK is missing or fails (Tidy then uses its own layout).
 *
 * layoutBoard(view, sizes, opts) -> {pos: Map id -> {x, y, dir}, routes: Map drawn edge id -> {elk: points, mid},
 * w, h, bands, cuts}. opts: {dir: "RIGHT" | "DOWN", wrap: the aspect ratio to wrap the layers to (rows), or none}. */
const BoardElk = (() => {
  const GPAD = { l: 22, r: 22, t: 36, b: 22 };   // the group box round its members (as board.js draws it)
  const LABEL_H = 20, LIST_GAP = 30;

  // ELK's layout dispatcher, called synchronously (undefined: not tried yet, null: not available)
  let engine;
  function dispatcher() {
    if (engine !== undefined) return engine;
    if (typeof ELK === "undefined") return null;   // not loaded (yet)
    engine = null;
    try {
      const d = new ELK({ algorithms: ["layered"] }).worker.worker.dispatcher;
      d.dispatch({ data: { cmd: "register", algorithms: ["layered"], id: -1 } });
      engine = d;
    } catch (e) {
      console.warn("ELK not available, Tidy uses its own layout", e);
    }
    return engine;
  }
  const available = () => !!dispatcher();

  const BASE = {
    "elk.algorithm": "layered",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    "elk.layered.cycleBreaking.strategy": "GREEDY",   // the edges come acyclic already (story order)
    "elk.layered.thoroughness": "30",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
    "elk.layered.nodePlacement.favorStraightEdges": "true",
    "elk.spacing.nodeNode": "34",
    "elk.layered.spacing.nodeNodeBetweenLayers": "36",
    "elk.layered.spacing.edgeNodeBetweenLayers": "12",
    "elk.spacing.edgeNode": "22",
    "elk.spacing.edgeEdge": "14",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
    "elk.spacing.edgeLabel": "4",
    "elk.spacing.labelNode": "8",
    "elk.spacing.componentComponent": "70",
    "elk.edgeLabels.inline": "true",
    "elk.layered.mergeEdges": "false",
  };

  const groupRef = (gid) => `\u0002${gid}`;
  const groupOf = (ref) => (typeof ref === "string" && ref[0] === "\u0002" ? ref.slice(1) : null);

  /* The story order of the nodes: Map id -> index. A topological order in which the spine comes in spine order
   * (a cycle is cut at the next spine entry); otherwise sources and actors first, then in the order mentioned. */
  function storyOrder(ids, edges, spine, v, actor) {
    const sp = new Map(spine.map((id, i) => [id, i]));
    const out = new Map(ids.map((id) => [id, []])), left = new Map(ids.map((id) => [id, 0]));
    for (const e of edges) { out.get(e.from).push(e.to); left.set(e.to, left.get(e.to) + 1); }
    const entry = (id) => (!left.get(id) || actor(id) ? 0 : 1);
    const ent = new Map(ids.map((id) => [id, entry(id)]));
    const better = (c, u) => u == null || (sp.has(c) && !sp.has(u)) || (sp.has(c) === sp.has(u) && (ent.get(c) - ent.get(u) || v(c) - v(u)) < 0);
    const order = new Map(), rest = new Set(ids);
    let next = 0;
    while (rest.size) {
      let u = null;
      for (const c of rest) {
        if (left.get(c) > 0 || (sp.has(c) && sp.get(c) !== next)) continue;
        if (better(c, u)) u = c;
      }
      if (u == null) {
        // stuck in a cycle: cut it at the next spine entry, else at the earliest entry point
        u = next < spine.length && rest.has(spine[next]) ? spine[next] : null;
        if (u == null) for (const c of rest) if (!sp.has(c) && better(c, u)) u = c;
        if (u == null) u = [...rest].sort((a, b) => sp.get(a) - sp.get(b))[0];
      }
      rest.delete(u); order.set(u, order.size);
      if (sp.has(u)) next = Math.max(next, sp.get(u) + 1);
      for (const t of out.get(u)) left.set(t, left.get(t) - 1);
    }
    return order;
  }

  /* The layout plan as far as ELK uses it: the spine (node ids; a group stands for its members) and the
   * placements before / after an anchor (as order). */
  function readPlan(view, members) {
    const L = view.layout;
    if (!L || typeof L !== "object") return { spine: [], place: [] };
    const expand = (id) => (members.has(id) ? members.get(id) : view.nodes[id] ? [id] : []);
    const spine = [...new Set((Array.isArray(L.spine) ? L.spine : []).flatMap(expand))];
    const place = (Array.isArray(L.placements) ? L.placements : [])
      .filter((p) => p && (p.side === "before" || p.side === "after") && expand(p.node).length && expand(p.anchor).length);
    return { spine: spine.length >= 2 ? spine : [], place, expand };
  }

  function layoutBoard(view, sizes, opts = {}) {
    const D = dispatcher();
    if (!D) return null;
    const dir = opts.dir || "RIGHT";
    const ids = Object.keys(view.nodes);
    const size = (id) => sizes.get(id) || { w: 160, h: 60 };
    const order0 = new Map(ids.map((id, i) => [id, (view.nodes[id].created_v || 0) * 1e4 + i]));
    const members = new Map();
    for (const id of ids) {
      const g = view.nodes[id].group;
      if (g && view.groups && view.groups[g]) { if (!members.has(g)) members.set(g, []); members.get(g).push(id); }
    }
    const inGroup = (id) => (members.has(view.nodes[id].group) ? view.nodes[id].group : null);
    // the drawn edges; an end may be a group box
    const end = (ref) => { const g = groupOf(ref); return g ? (members.has(g) ? groupRef(g) : null) : view.nodes[ref] ? ref : null; };
    const drawn = Object.values(view.drawn || view.edges);
    // a task list, or a group whose members have no edges of their own, is a list: its members in a column, one
    // block for ELK (in a layered layout they would stand side by side in one layer); its members' edges end at the
    // block and routing.js routes them
    const lists = new Set([...members.keys()].filter((g) => view.groups[g].kind === "task_list"
      || !drawn.some((e) => [e.from, e.to].some((r) => !groupOf(r) && view.nodes[r] && inGroup(r) === g))));
    const block = (ref) => (ref && !groupOf(ref) && lists.has(inGroup(ref)) ? groupRef(inGroup(ref)) : ref);
    const edges = drawn.map((e) => ({ e, from: block(end(e.from)), to: block(end(e.to)), own: block(end(e.from)) === end(e.from) && block(end(e.to)) === end(e.to) }))
      .filter((x) => x.from && x.to && x.from !== x.to && !(groupOf(x.from) && groupOf(x.from) === inGroup(x.to)) && !(groupOf(x.to) && groupOf(x.to) === inGroup(x.from)));

    // story order over the nodes (an edge to a group counts as one to each member)
    const plan = readPlan(view, members);
    const flat = (ref) => (groupOf(ref) ? members.get(groupOf(ref)) : [ref]);
    const fe = [];
    for (const x of edges) for (const a of flat(x.from)) for (const b of flat(x.to)) fe.push({ from: a, to: b });
    for (const p of plan.place) {
      const [u, a] = [plan.expand(p.node)[0], plan.expand(p.anchor)[0]];
      if (u !== a) fe.push(p.side === "before" ? { from: u, to: a } : { from: a, to: u });
    }
    const order = storyOrder([...ids].sort((a, b) => order0.get(a) - order0.get(b)), fe, plan.spine, (id) => order0.get(id),
      (id) => view.nodes[id].type === "actor");
    const rank = (ref) => (groupOf(ref) ? Math.min(...members.get(groupOf(ref)).map((m) => order.get(m))) : order.get(ref));
    const sp = new Map(plan.spine.map((id, i) => [id, i]));
    const onSpine = (a, b) => !groupOf(a) && !groupOf(b) && sp.has(a) && sp.has(b) && Math.abs(sp.get(a) - sp.get(b)) === 1;

    // the ELK graph: groups as compound nodes, children in story order
    const byOrder = (a, b) => rank(a) - rank(b);
    const leaf = (id) => ({ id, width: size(id).w, height: size(id).h });
    const top = [];
    const seenG = new Set();
    for (const id of [...ids].sort(byOrder)) {
      const g = inGroup(id);
      if (!g) { top.push(leaf(id)); continue; }
      if (seenG.has(g)) continue;
      seenG.add(g);
      const ms = [...members.get(g)].sort(byOrder);
      if (lists.has(g)) {
        const h = ms.reduce((t, m) => t + size(m).h, 0) + LIST_GAP * (ms.length - 1);
        top.push({ id: groupRef(g), width: Math.max(...ms.map((m) => size(m).w)) + GPAD.l + GPAD.r, height: h + GPAD.t + GPAD.b });
        continue;
      }
      top.push({ id: groupRef(g), layoutOptions: { "elk.padding": `[top=${GPAD.t},left=${GPAD.l},bottom=${GPAD.b},right=${GPAD.r}]` },
                 children: ms.map(leaf) });
    }
    top.sort((a, b) => byOrder(a.id, b.id));
    const elkEdges = [], info = new Map();
    edges.sort((p, q) => rank(p.from) - rank(q.from) || rank(p.to) - rank(q.to));
    for (const x of edges) {
      const rev = rank(x.from) > rank(x.to);
      const lw = x.e.label ? BoardSvg.textW(x.e.label, "13px Kalam") + 10 : 0;
      const ee = { id: `e${elkEdges.length}`, sources: [rev ? x.to : x.from], targets: [rev ? x.from : x.to] };
      if (lw) ee.labels = [{ text: x.e.label, width: lw, height: LABEL_H, layoutOptions: { "elk.edgeLabels.placement": "CENTER" } }];
      if (onSpine(x.from, x.to)) ee.layoutOptions = { "elk.layered.priority.straightness": "10", "elk.layered.priority.direction": "10" };
      info.set(ee.id, { id: x.e.id, rev, from: x.from, to: x.to, own: x.own });
      elkEdges.push(ee);
    }
    const layoutOptions = { ...BASE, "elk.direction": dir };
    // wrapped: the layers cut into rows (ELK's graph wrapping), each row left to right under the one before
    if (opts.wrap) Object.assign(layoutOptions, { "elk.layered.wrapping.strategy": "MULTI_EDGE", "elk.aspectRatio": String(opts.wrap), "elk.layered.wrapping.cutting.strategy": "MSD" });
    // ELK gets a plain copy (it marks the objects it has seen; a graph built here as is comes back unlaid)
    const graph = JSON.parse(JSON.stringify({ id: "root", layoutOptions, children: top, edges: elkEdges }));
    try {
      D.dispatch({ data: { cmd: "layout", graph, layoutOptions: {}, options: {}, id: -1 } });
      if (!(graph.width > 0)) throw new Error("no layout");
    } catch (e) {
      console.warn("ELK layout failed, Tidy uses its own layout", e);
      return null;
    }

    // back to the board: centres (ELK's are relative to the parent), and each edge's polyline in edge direction
    // (relative to its container: the root or a group)
    const pos = new Map(), origin = new Map([["root", { x: 0, y: 0 }]]), edgeList = [];
    const walk = (n, ox, oy) => {
      edgeList.push(...(n.edges || []));
      for (const c of n.children || []) {
        const x = ox + c.x, y = oy + c.y;
        if (c.children && c.children.length) { origin.set(c.id, { x, y }); walk(c, x, y); }
        else if (view.nodes[c.id]) pos.set(c.id, { x: x + c.width / 2, y: y + c.height / 2, dir: 1 });
        else if (lists.has(groupOf(c.id))) {
          // a list's members, top to bottom in story order
          let yy = y + GPAD.t;
          for (const m of [...members.get(groupOf(c.id))].sort(byOrder)) {
            pos.set(m, { x: x + c.width / 2, y: yy + size(m).h / 2, dir: 1 });
            yy += size(m).h + LIST_GAP;
          }
        }
      }
    };
    walk(graph, 0, 0);
    // an edge end's box: a node, or a group round its members
    const box = (ref) => {
      const ms = groupOf(ref) ? members.get(groupOf(ref)) : [ref];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const m of ms) {
        const p = pos.get(m), z = size(m);
        if (p) { x0 = Math.min(x0, p.x - z.w / 2); x1 = Math.max(x1, p.x + z.w / 2); y0 = Math.min(y0, p.y - z.h / 2); y1 = Math.max(y1, p.y + z.h / 2); }
      }
      return groupOf(ref) ? { x0: x0 - GPAD.l, y0: y0 - GPAD.t, x1: x1 + GPAD.r, y1: y1 + GPAD.b } : { x0, y0, x1, y1 };
    };
    const far = (q, ref) => { const b = box(ref); return Math.max(b.x0 - q.x, q.x - b.x1, 0) + Math.max(b.y0 - q.y, q.y - b.y1, 0) > 16; };
    const routes = new Map();
    for (const ee of edgeList) {
      const it = info.get(ee.id), o = origin.get(ee.container) || origin.get("root");
      if (!it || !it.own || !ee.sections || !ee.sections.length) continue;
      const abs = (q) => ({ x: q.x + o.x, y: q.y + o.y });
      // a wrapped edge comes in several sections: follow them from the one nothing leads into
      const byId = new Map(ee.sections.map((s) => [s.id, s]));
      let s = ee.sections.find((q) => !(q.incomingSections || []).length) || ee.sections[0], pts = [];
      for (const seen = new Set(); s && !seen.has(s.id); s = byId.get((s.outgoingSections || [])[0])) {
        seen.add(s.id);
        for (const q of [s.startPoint, ...(s.bendPoints || []), s.endPoint]) {
          const p = pts[pts.length - 1];
          if (!p || Math.abs(p.x - q.x - o.x) > 0.5 || Math.abs(p.y - q.y - o.y) > 0.5) pts.push(abs(q));
        }
      }
      if (it.rev) pts = pts.reverse();
      // a route that doesn't start and end at its nodes (ELK's wrapping can leave edges into groups behind) is
      // dropped: routing.js routes that edge itself
      if (pts.length < 2 || far(pts[0], it.from) || far(pts[pts.length - 1], it.to)) continue;
      const l = ee.labels && ee.labels[0];
      routes.set(it.id, { elk: pts, pts: [], ...(l && l.x != null ? { mid: abs({ x: l.x + l.width / 2, y: l.y + l.height / 2 }) } : {}) });
    }
    return { pos, routes, w: graph.width || 0, h: graph.height || 0, bands: 1, cuts: 0 };
  }

  return { layoutBoard, available };
})();
