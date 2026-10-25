/* Lay out and route boards with the real frontend code (static/board/svg.js, shapes.js, routing.js, tidy.js, elk.js
 * with static/vendor/elk.bundled.js, simplify.js) in Node, with a stubbed DOM, and print the geometry as JSON: node
 * boxes, edge polylines, label boxes, group boxes. Optionally writes one SVG per board. No dependencies; text widths are estimated (no canvas).
 *
 *   node scripts/render_board.mjs runs/<file>.json [--out DIR] [--width 1500] [--height 1000] [--engine elk]
 *
 * The input is a run file (final_board.boards), a board export ({boards: [...]}) or one board ({nodes, edges}).
 * stdout: [{id, title, kind, w, h, nodes: [{id, label, type, x, y, w, h}], edges: [{id, from, to, label, pts,
 * label_box}], groups: [{id, label, x0, y0, x1, y1}], svg}].
 * Stubs are nodes of type "stub" (ref: the node they stand for); an end "group:<id>" is a group box. A detail board has
 * parent (its overview); a summary node has detail (its detail board), a reference node ref_board (the overview).
 * scripts/eval_metrics.py scores it. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const BOARD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "static", "board");

// ------------------------------------------------------------------ a DOM just big enough for the board modules
class El {
  constructor(tag) {
    this.tag = tag; this.attrs = {}; this.children = []; this.style = {}; this.textContent = "";
    const cls = () => new Set((this.attrs.class || "").split(" ").filter(Boolean));
    const set = (s) => { this.attrs.class = [...s].join(" "); };
    this.classList = {
      add: (...c) => { const s = cls(); c.forEach((x) => s.add(x)); set(s); },
      remove: (...c) => { const s = cls(); c.forEach((x) => s.delete(x)); set(s); },
      contains: (c) => cls().has(c),
      toggle: (c, on) => { const s = cls(); (on ?? !s.has(c)) ? s.add(c) : s.delete(c); set(s); },
    };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(c) { this.children.push(c); return c; }
  insertBefore(c, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
  querySelector() { return null; }
}
// Kalam / Inter are not available here: widths from the font size, a bit wider for bold
const ctx = {
  font: "16px x",
  measureText(t) {
    const m = /(\d+(?:\.\d+)?)px/.exec(this.font), s = m ? +m[1] : 13;
    return { width: String(t).length * s * (/700/.test(this.font) ? 0.56 : 0.5) };
  },
};
const document = { createElementNS: (_, t) => new El(t), createElement: () => ({ getContext: () => ctx }) };
const sandbox = { document, console, Math, Map, Set, Uint8Array, Int32Array, Float64Array, Infinity, Array, Object, JSON, Number, String };
vm.createContext(sandbox);
// ELK (static/vendor, elkjs' bundle with its fake worker) needs a global object and timers
vm.runInContext("var global = globalThis;", sandbox);
Object.assign(sandbox, { setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync(path.join(BOARD_DIR, "..", "vendor", "elk.bundled.js"), "utf8"), sandbox);
let src = "";
for (const f of ["svg.js", "shapes.js", "routing.js", "tidy.js", "elk.js", "simplify.js"]) src += fs.readFileSync(path.join(BOARD_DIR, f), "utf8") + "\n";
src += "this.BoardSvg = BoardSvg; this.BoardShapes = BoardShapes; this.BoardRouting = BoardRouting; this.BoardSimplify = BoardSimplify;";
vm.runInContext(src, sandbox);
const { BoardSvg, BoardShapes, BoardRouting, BoardSimplify } = sandbox;
const { esc, textW } = BoardSvg;

// ------------------------------------------------------------------ geometry
/* An SVG path (absolute M / L / Q / C, as routing.js writes them) as a polyline; curves sampled. */
function pathPoints(d) {
  const tok = d.match(/[MLQC]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const pts = [];
  let i = 0, cmd = null;
  const num = () => +tok[i++];
  while (i < tok.length) {
    if (/[MLQC]/i.test(tok[i])) cmd = tok[i++].toUpperCase();
    const p = pts[pts.length - 1];
    if (cmd === "M" || cmd === "L") pts.push([num(), num()]);
    else if (cmd === "Q") {
      const [cx, cy, x, y] = [num(), num(), num(), num()];
      for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; pts.push([u * u * p[0] + 2 * u * t * cx + t * t * x, u * u * p[1] + 2 * u * t * cy + t * t * y]); }
    } else if (cmd === "C") {
      const [ax, ay, bx, by, x, y] = [num(), num(), num(), num(), num(), num()];
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        pts.push([u * u * u * p[0] + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * x, u * u * u * p[1] + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * y]);
      }
    } else i++;
  }
  return pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
}

/* One board, laid out by tidy.js (with simplify.js' stubs) and routed by routing.js the way board.js does once
 * nothing moves. A stub is a node of type "stub"; an edge that ends at a group box has the end "group:<id>". */
function layout(board, panel, boards) {
  const built = new Map(), sizes = new Map();
  // as board.js draws them: references with their direction (the view), summary nodes with their detail board's size
  const own = (b) => Object.values(b.nodes).filter((n) => !n.ref_board).length;
  for (const [id, n0] of Object.entries(BoardSimplify.view(board).nodes)) {
    const n = n0.detail && boards[n0.detail] ? { ...n0, detailN: own(boards[n0.detail]) } : n0;
    const b = BoardShapes.buildNode(n, null); built.set(id, b); sizes.set(id, { w: b.w, h: b.h });
  }
  const lay = BoardSimplify.layout(board, sizes, panel, engine), v = lay.view;
  for (const n of Object.values(v.nodes)) if (!built.has(n.id)) built.set(n.id, BoardShapes.buildNode(n, null));
  const { res, list, boxes, node } = BoardSimplify.route(lay);
  const edges = list.map((e) => v.drawn[e.id]);

  const end = (ref) => (BoardSimplify.groupOf(ref) ? `group:${BoardSimplify.groupOf(ref)}` : v.nodes[ref].type === "stub" ? `stub:${v.nodes[ref].edge}` : ref);
  const nodes = boxes.map((o) => ({ id: o.id, key: end(o.id), label: v.nodes[o.id].label, type: o.type, x: o.x, y: o.y, w: o.w, h: o.h, ...(o.type === "stub" ? { ref: v.nodes[o.id].ref } : {}),
                                    ...(v.nodes[o.id].detail ? { detail: v.nodes[o.id].detail } : {}), ...(v.nodes[o.id].ref_board ? { ref_board: v.nodes[o.id].ref_board } : {}) }));
  const outEdges = edges.map((e) => {
    const r = res.get(e.id), lw = e.label ? textW(e.label, "13px Kalam") + 10 : 0;
    return { id: e.id, from: end(e.from), to: end(e.to), label: e.label || null, d: r.d, pts: pathPoints(r.d),
             label_box: e.label ? { x: r.label.x, y: r.label.y, w: lw, h: 20 } : null,
             ...(e.members ? { members: e.members } : {}), ...(e.ref ? { ref: e.ref } : {}) };
  });
  const groups = [];
  for (const g of Object.values(board.groups || {})) {
    const b = BoardSimplify.groupBox(v, g.id, node);
    if (b) groups.push({ id: g.id, label: g.label, kind: g.kind || null, x0: b.x - b.w / 2, y0: b.y - b.h / 2, x1: b.x + b.w / 2, y1: b.y + b.h / 2 });
  }
  return { nodes, edges: outEdges, groups, built, engine: lay.engine };
}

// ------------------------------------------------------------------ SVG
function serialize(e) {
  const attrs = Object.entries(e.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
  const body = e.children.length ? e.children.map(serialize).join("") : esc(e.textContent);
  return `<${e.tag}${attrs}>${body}</${e.tag}>`;
}

const STYLE = `
.node-label { font-family: "Kalam", "Comic Sans MS", cursive; font-weight: 700; fill: #212529; font-size: 16px; text-anchor: middle; dominant-baseline: central; }
.node-note { font-family: "Inter", Helvetica, sans-serif; font-size: 10.5px; fill: #6c757d; text-anchor: middle; }
.halo { display: none; }
.line { fill: none; stroke: #495057; stroke-width: 1.8; }
.edge-label rect { fill: #faf7f2; fill-opacity: 0.9; }
.edge-label text { font-family: "Kalam", "Comic Sans MS", cursive; font-size: 13px; fill: #495057; text-anchor: middle; dominant-baseline: central; }
.group rect { fill: rgba(73, 80, 87, .035); stroke: #ced4da; stroke-dasharray: 6 5; stroke-width: 1.5; }
.group text { font-family: "Kalam", "Comic Sans MS", cursive; font-size: 14px; fill: #868e96; font-weight: 700; }
.stub-label { font-family: "Kalam", "Comic Sans MS", cursive; font-weight: 700; font-size: 13px; text-anchor: middle; dominant-baseline: central; }
.title { font-family: Helvetica, sans-serif; font-size: 18px; font-weight: 700; fill: #343a40; }`;

function toSvg(board, g, title) {
  const xs = [], ys = [];
  for (const n of g.nodes) { xs.push(n.x - n.w / 2, n.x + n.w / 2); ys.push(n.y - n.h / 2, n.y + n.h / 2); }
  for (const e of g.edges) for (const [x, y] of e.pts) { xs.push(x); ys.push(y); }
  for (const q of g.groups) { xs.push(q.x0, q.x1); ys.push(q.y0, q.y1); }
  if (!xs.length) { xs.push(0, 200); ys.push(0, 100); }
  const x0 = Math.min(...xs) - 40, y0 = Math.min(...ys) - 70;
  // square, so a Quick Look thumbnail (the PNG) shows all of it
  const w = Math.max(Math.max(...xs) + 40 - x0, Math.max(...ys) + 40 - y0), h = w;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">`;
  s += `<style>${STYLE}</style><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#495057"/></marker></defs>`;
  s += `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#faf7f2"/>`;
  s += `<text class="title" x="${x0 + 20}" y="${y0 + 32}">${esc(title)}</text>`;
  for (const q of g.groups) s += `<g class="group"><rect x="${q.x0}" y="${q.y0}" width="${q.x1 - q.x0}" height="${q.y1 - q.y0}" rx="18"/><text x="${q.x0 + 12}" y="${q.y0 + 18}">${esc(q.label)}</text></g>`;
  for (const e of g.edges) s += `<path class="line" d="${e.d}" marker-end="url(#arrow)"/>`;
  for (const n of g.nodes) s += `<g transform="translate(${n.x},${n.y})">${serialize(g.built.get(n.id).inner)}</g>`;
  for (const e of g.edges) {
    if (!e.label_box) continue;
    const b = e.label_box;
    s += `<g class="edge-label" transform="translate(${b.x},${b.y})"><rect x="${-b.w / 2}" y="-10" width="${b.w}" height="20" rx="6"/><text>${esc(e.label)}</text></g>`;
  }
  return s + "</svg>";
}

// ------------------------------------------------------------------ main
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const engine = opt("--engine", null);   // only layouts whose name starts with this ("tidy", "elk", "elk RIGHT", ...)
const outDir = opt("--out", null), panel = { width: +opt("--width", 1500), height: +opt("--height", 1000) };
const file = args[0];
if (!file) { console.error("usage: node scripts/render_board.mjs <run.json | boards.json> [--out DIR] [--width W] [--height H]"); process.exit(2); }
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const boards = data.final_board ? data.final_board.boards : data.boards || [data];
if (outDir) fs.mkdirSync(outDir, { recursive: true });
const byId = Object.fromEntries(boards.map((b, i) => [b.id || `board${i}`, b]));
const out = boards.map((board, i) => {
  board = { groups: {}, ...board, id: board.id || `board${i}` };
  const g = layout(board, panel, byId);
  // a detail board: "Overview › Detail"
  const title = board.parent && byId[board.parent] ? `${byId[board.parent].title} › ${board.title}` : board.title || board.id;
  let svg = null;
  if (outDir) { svg = path.join(outDir, `${i + 1}_${board.id.replace(/[^\w-]+/g, "_")}.svg`); fs.writeFileSync(svg, toSvg(board, g, title)); }
  return { id: board.id, title: board.title || board.id, kind: board.kind || null, ...(board.parent ? { parent: board.parent } : {}),
           engine: g.engine, nodes: g.nodes.map(({ key, ...n }) => ({ ...n, id: key })), edges: g.edges.map(({ d, ...e }) => e), groups: g.groups, svg };
});
process.stdout.write(JSON.stringify(out));
