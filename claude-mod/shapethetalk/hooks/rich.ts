// Desktop renderer: placement -> the web whiteboard's hand-drawn SVG
// (static/board/*.js + static/style.css), as one self-contained string under
// the Svg element's 131,072-character limit. Pure.

import type { DBoard, DEdge, DNode, DPlacement } from '../types'
import { normalise } from './layout.ts'
import { RoughGenerator } from './vendor/roughjs/generator.js'
import type { Drawable, Options as RoughOptions } from './vendor/roughjs/generator.js'

export type Dir = 'LR' | 'TB'
export type Quality = 'full' | 'single' | 'clean' | 'fallback'

export const SVG_LIMIT = 131072

export type RichOpts = {
  /** px the drawing may take across */
  maxWidth: number
  /** px the drawing may take down */
  maxHeight: number
  /** the direction drawn last time for this board */
  prefer?: Dir
  /** what the last update changed: only these get the animation classes */
  recent?: { ids: readonly string[]; added?: readonly string[] } | null
  /**
   * The node the "Claude" chip sits on (a staggered reveal: the newest node);
   * null for none. Absent: every recent node gets one.
   */
  chip?: string | null
  /** start at this quality (tests); default by node count */
  quality?: Quality
  /** the size budget; default SVG_LIMIT */
  limit?: number
  /**
   * A still picture (the terminal's PNG): no CSS animation or hover; recent ids
   * keep a steady orange halo and the "Claude" chip, and the root gets a pixel
   * width and height so a rasteriser sizes it without a page around it.
   */
  isStatic?: boolean
  /** hover tooltips: a `<title>` in each node and edge (the live page; an image shows none) */
  tooltips?: boolean
}

export type Rich = { source: string; width: number; height: number; dir: Dir; quality: Quality }

// ------------------------------------------------------------------ the web app's constants

const TYPE: Record<DNode['type'], { fill: string; stroke: string }> = {
  actor: { fill: '#fff3bf', stroke: '#f08c00' },
  system: { fill: '#e7f5ff', stroke: '#1864ab' },
  step: { fill: '#ffffff', stroke: '#343a40' },
  decision: { fill: '#fff0f6', stroke: '#c2255c' },
  data: { fill: '#ebfbee', stroke: '#2b8a3e' },
}
const FLASH = '#d9480f' // the "Claude" colour
const BOARD_BG = '#fbfaf6'
const HAND = 'Kalam,"Chalkboard SE","Marker Felt","Comic Sans MS",cursive'
const SANS = 'Inter,system-ui,-apple-system,"Segoe UI",sans-serif'
// the web board's grid (place.js COLW 250, ROWH 128): at least 250 px across
// and 128 px down between neighbours, whichever way the flow runs
const ACROSS_MIN = 250
const DOWN_MIN = 128

/** board.js's seed: FNV-1a over the id, % 100000 + 1. */
export function hash(s: string): number {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return (Math.abs(h) % 100000) + 1
}

// ------------------------------------------------------------------ text

/** Approximate advance widths (no canvas here), in em. */
function charEm(ch: string): number {
  if (ch === ' ') return 0.3
  if ('il.,:;|!\'`'.includes(ch)) return 0.28
  if ('fjrt()[]{}-'.includes(ch)) return 0.4
  if ('mw'.includes(ch)) return 0.82
  if ('MW'.includes(ch)) return 0.95
  if (ch >= 'A' && ch <= 'Z') return 0.66
  if (ch >= '0' && ch <= '9') return 0.56
  return 0.54
}
export function textW(s: string, px: number): number {
  let em = 0
  for (const ch of s) em += charEm(ch)
  return em * px
}

/** board.js's wrap: 17 characters, at most 2 lines. */
export function wrap(label: string, max = 17): string[] {
  const words = String(label).split(/\s+/)
  const lines = ['']
  for (const w of words) {
    const last = lines[lines.length - 1]!
    const cand = last ? last + ' ' + w : w
    if (cand.length > max && last) lines.push(w)
    else lines[lines.length - 1] = cand
  }
  if (lines.length > 2) {
    lines[1] = lines.slice(1).join(' ')
    lines.length = 2
    if (lines[1]!.length > max + 3) lines[1] = lines[1]!.slice(0, max + 1) + '…'
  }
  return lines
}

/** Text that cannot break out of the markup. */
export function esc(s: string): string {
  return String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const r1 = (n: number) => Math.round(n * 10) / 10

/** Every number in a path rounded to 1 decimal. */
const roundPath = (d: string) => d.replace(/-?\d+\.\d+(e-?\d+)?/g, m => String(r1(Number(m))))

// ------------------------------------------------------------------ node sizes (board.js buildNode)

type Size = { w: number; h: number; lines: string[]; note: string | null }

export function nodeSize(n: DNode): Size {
  const lines = wrap(n.label)
  const tw = Math.max(...lines.map(l => textW(l, 16)))
  const showNote = n.note && !['disputed', 'resolved'].includes(n.status)
  const note = showNote ? (n.note!.length > 34 ? n.note!.slice(0, 33) + '…' : n.note!) : null
  const nw = note ? textW(note, 10.5) : 0
  let w = Math.max(128, Math.min(236, Math.max(tw, nw) + 40))
  let h = lines.length === 1 ? 54 : 72
  if (note) h += 14
  if (n.type === 'actor') w += 30
  if (n.type === 'decision') {
    w += 52
    h += 34
  }
  if (n.type === 'data') h += 16
  return { w, h, lines, note }
}

// ------------------------------------------------------------------ geometry

type Geo = { id: string; x: number; y: number; w: number; h: number; dir: number; node: DNode; size: Size }
type Pt = { x: number; y: number }
type Route = { d: string; mid: Pt; pts: Pt[] }
type Layout = { geos: Map<string, Geo>; routes: Map<string, Route>; x0: number; y0: number; w: number; h: number }

function place(board: DBoard, placement: DPlacement, dir: Dir): Map<string, Geo> {
  const p = normalise(placement)
  const nodes = Object.values(board.nodes).filter(n => p[n.id])
  const sizes = new Map(nodes.map(n => [n.id, nodeSize(n)]))
  const geos = new Map<string, Geo>()
  if (!nodes.length) return geos
  const ranks = Math.max(...nodes.map(n => p[n.id]!.r)) + 1
  const maxW = Math.max(...nodes.map(n => sizes.get(n.id)!.w))
  const maxH = Math.max(...nodes.map(n => sizes.get(n.id)!.h))
  const inRank = (r: number) => nodes.filter(n => p[n.id]!.r === r)
  // the widest edge label between two neighbouring ranks
  const labelBetween = (r: number) =>
    Math.max(
      0,
      ...Object.values(board.edges)
        .filter(e => e.label && p[e.from] && p[e.to] && Math.min(p[e.from]!.r, p[e.to]!.r) === r)
        .map(e => textW(e.label!, 13) + 10),
    )
  const along: number[] = [0]
  for (let r = 1; r < ranks; r++) {
    const a = Math.max(0, ...inRank(r - 1).map(n => (dir === 'LR' ? sizes.get(n.id)!.w : sizes.get(n.id)!.h)))
    const b = Math.max(0, ...inRank(r).map(n => (dir === 'LR' ? sizes.get(n.id)!.w : sizes.get(n.id)!.h)))
    const label = labelBetween(r - 1)
    along.push(
      along[r - 1]! +
        (dir === 'LR'
          ? Math.max(ACROSS_MIN, a / 2 + b / 2 + 60 + label)
          : Math.max(DOWN_MIN, a / 2 + b / 2 + 56 + (label ? 26 : 0))),
    )
  }
  const slot = dir === 'LR' ? Math.max(DOWN_MIN, maxH + 44) : Math.max(ACROSS_MIN, maxW + 48)
  for (const n of nodes) {
    const { r, s } = p[n.id]!
    const size = sizes.get(n.id)!
    const a = along[r]!
    const c = s * slot
    geos.set(n.id, { id: n.id, x: dir === 'LR' ? a : c, y: dir === 'LR' ? c : a, w: size.w, h: size.h, dir: 1, node: n, size })
  }
  return geos
}

// board.js / routing.js edgePath, with the elbow and bowed fallbacks

const cubic = (sx: number, sy: number, c1x: number, c1y: number, c2x: number, c2y: number, tx: number, ty: number): Route => {
  const at = (t: number): Pt => {
    const u = 1 - t
    return {
      x: u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * tx,
      y: u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ty,
    }
  }
  const pts = Array.from({ length: 17 }, (_, i) => at(i / 16))
  return { d: `M${r1(sx)},${r1(sy)} C${r1(c1x)},${r1(c1y)} ${r1(c2x)},${r1(c2y)} ${r1(tx)},${r1(ty)}`, mid: at(0.5), pts }
}

function directPath(a: Geo, b: Geo): Route {
  const dx = b.x - a.x, dy = b.y - a.y
  let sx, sy, tx, ty, c1x, c1y, c2x, c2y
  if (Math.abs(dx) >= Math.abs(dy) * 1.1 || Math.abs(dx) > (a.w + b.w) / 2 + 30) {
    const s = Math.sign(dx) || 1
    sx = a.x + (s * a.w) / 2
    sy = a.y
    tx = b.x - s * (b.w / 2 + 3)
    ty = b.y
    const c = Math.max(36, Math.abs(tx - sx) * 0.45)
    c1x = sx + s * c
    c1y = sy
    c2x = tx - s * c
    c2y = ty
  } else {
    const s = Math.sign(dy) || 1
    sx = a.x
    sy = a.y + (s * a.h) / 2
    tx = b.x
    ty = b.y - s * (b.h / 2 + 3)
    const c = Math.max(30, Math.abs(ty - sy) * 0.45)
    c1x = sx
    c1y = sy + s * c
    c2x = tx
    c2y = ty - s * c
  }
  return cubic(sx, sy, c1x, c1y, c2x, c2y, tx, ty)
}

function blocked(route: Route, a: Geo, b: Geo, boxes: Geo[]): number {
  let n = 0
  for (const o of boxes) {
    if (o.id === a.id || o.id === b.id) continue
    for (let i = 1; i < route.pts.length - 1; i++) {
      const p = route.pts[i]!
      if (Math.abs(p.x - o.x) < o.w / 2 + 6 && Math.abs(p.y - o.y) < o.h / 2 + 6) {
        n++
        break
      }
    }
  }
  return n
}

/** An orthogonal route with rounded corners through the given corners. */
function elbow(points: Pt[]): Route {
  const R = 18
  let d = `M${r1(points[0]!.x)},${r1(points[0]!.y)}`
  const pts: Pt[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i]!, q = points[i + 1]!
    for (let k = 0; k <= 8; k++) pts.push({ x: p.x + ((q.x - p.x) * k) / 8, y: p.y + ((q.y - p.y) * k) / 8 })
  }
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1]!, c = points[i]!, n = points[i + 1]!
    const l1 = Math.hypot(c.x - p.x, c.y - p.y), l2 = Math.hypot(n.x - c.x, n.y - c.y)
    const r = Math.min(R, l1 / 2, l2 / 2)
    const a = { x: c.x - ((c.x - p.x) / (l1 || 1)) * r, y: c.y - ((c.y - p.y) / (l1 || 1)) * r }
    const b = { x: c.x + ((n.x - c.x) / (l2 || 1)) * r, y: c.y + ((n.y - c.y) / (l2 || 1)) * r }
    d += ` L${r1(a.x)},${r1(a.y)} Q${r1(c.x)},${r1(c.y)} ${r1(b.x)},${r1(b.y)}`
  }
  const last = points[points.length - 1]!
  d += ` L${r1(last.x)},${r1(last.y)}`
  // the label sits halfway along the polyline
  const segs = points.slice(1).map((q, i) => Math.hypot(q.x - points[i]!.x, q.y - points[i]!.y))
  let half = segs.reduce((x, y) => x + y, 0) / 2
  let mid = points[0]!
  for (let i = 0; i < segs.length; i++) {
    if (half <= segs[i]!) {
      const p = points[i]!, q = points[i + 1]!, t = half / (segs[i]! || 1)
      mid = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }
      break
    }
    half -= segs[i]!
  }
  return { d, mid, pts }
}

export function edgePath(a: Geo, b: Geo, boxes: Geo[]): Route {
  const direct = directPath(a, b)
  if (!boxes.length || !blocked(direct, a, b, boxes)) return direct
  const dx = b.x - a.x, dy = b.y - a.y
  const routes = [direct]
  const sameCol = Math.abs(dx) < (a.w + b.w) / 2
  const sameRow = Math.abs(dy) < Math.max(a.h, b.h)
  for (const s of sameCol ? [a.dir || 1, -(a.dir || 1)] : []) {
    // U-turn beside the column (a side arc)
    const sx = a.x + (s * a.w) / 2, tx = b.x + s * (b.w / 2 + 3)
    const edge = s > 0 ? Math.max(sx, tx) : Math.min(sx, tx)
    const X = edge + (s * (26 + Math.abs(dy) * 0.04)) / 0.75
    routes.push(cubic(sx, a.y, X, a.y, X, b.y, tx, b.y))
  }
  for (const s of sameRow ? [-1, 1] : []) {
    // arc over / under the row
    const sy = a.y + (s * a.h) / 2, ty = b.y + s * (b.h / 2 + 3)
    const edge = s > 0 ? Math.max(sy, ty) : Math.min(sy, ty)
    const Y = edge + (s * (30 + Math.abs(dx) * 0.06)) / 0.75
    routes.push(cubic(a.x, sy, a.x + dx * 0.15, Y, b.x - dx * 0.15, Y, b.x, ty))
  }
  // elbows: out of a side, along the gap between the ranks, into the other node
  const sxs = Math.sign(dx) || 1, sys = Math.sign(dy) || 1
  {
    const sx = a.x + (sxs * a.w) / 2, tx = b.x - sxs * (b.w / 2 + 3)
    for (const f of [0.5, 0.25, 0.75]) {
      const mx = sx + (tx - sx) * f
      routes.push(elbow([{ x: sx, y: a.y }, { x: mx, y: a.y }, { x: mx, y: b.y }, { x: tx, y: b.y }]))
    }
    const sy = a.y + (sys * a.h) / 2, ty = b.y - sys * (b.h / 2 + 3)
    for (const f of [0.5, 0.25, 0.75]) {
      const my = sy + (ty - sy) * f
      routes.push(elbow([{ x: a.x, y: sy }, { x: a.x, y: my }, { x: b.x, y: my }, { x: b.x, y: ty }]))
    }
  }
  // bowed curves to either side
  {
    const sx = direct.pts[0]!.x, sy = direct.pts[0]!.y
    const end = direct.pts[direct.pts.length - 1]!
    const len = Math.hypot(end.x - sx, end.y - sy) || 1
    const nx = -(end.y - sy) / len, ny = (end.x - sx) / len
    for (const k of [0.35, -0.35, 0.7, -0.7]) {
      const off = k * len
      routes.push(
        cubic(sx, sy, sx + (end.x - sx) * 0.25 + nx * off, sy + (end.y - sy) * 0.25 + ny * off, sx + (end.x - sx) * 0.75 + nx * off, sy + (end.y - sy) * 0.75 + ny * off, end.x, end.y),
      )
    }
  }
  let best = direct, bestN = Infinity
  for (const r of routes) {
    const n = blocked(r, a, b, boxes)
    if (n < bestN) {
      best = r
      bestN = n
    }
  }
  return best
}

function layoutFor(board: DBoard, placement: DPlacement, dir: Dir): Layout {
  const geos = place(board, placement, dir)
  const boxes = [...geos.values()]
  const routes = new Map<string, Route>()
  for (const e of Object.values(board.edges)) {
    const a = geos.get(e.from), b = geos.get(e.to)
    if (a && b) routes.set(e.id, edgePath(a, b, boxes))
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const g of boxes) {
    x0 = Math.min(x0, g.x - g.w / 2)
    x1 = Math.max(x1, g.x + g.w / 2)
    y0 = Math.min(y0, g.y - g.h / 2 - 26) // room for the "proposed" caption and the chip
    y1 = Math.max(y1, g.y + g.h / 2)
  }
  for (const r of routes.values())
    for (const p of r.pts) {
      x0 = Math.min(x0, p.x)
      x1 = Math.max(x1, p.x)
      y0 = Math.min(y0, p.y)
      y1 = Math.max(y1, p.y)
    }
  if (!boxes.length) {
    x0 = 0
    y0 = 0
    x1 = 320
    y1 = 120
  }
  const pad = 28
  return { geos, routes, x0: x0 - pad, y0: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 }
}

/** The direction to draw in: keep the last one unless the other fits clearly better (85%). */
export function chooseRichDir(lr: { w: number; h: number }, tb: { w: number; h: number }, maxWidth: number, maxHeight: number, prefer?: Dir): Dir {
  const fit = (s: { w: number; h: number }) => Math.min(maxWidth / s.w, maxHeight / s.h)
  const kl = fit(lr), kt = fit(tb)
  if (prefer === 'LR' && kl >= kt * 0.85) return 'LR'
  if (prefer === 'TB' && kt >= kl * 0.85) return 'TB'
  return kt > kl ? 'TB' : 'LR'
}

// ------------------------------------------------------------------ shapes

function roundedRect(w: number, h: number, r: number): string {
  const x = -w / 2, y = -h / 2
  return `M${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x + r},${y + h} Q${x},${y + h} ${x},${y + h - r} L${x},${y + r} Q${x},${y} ${x + r},${y} Z`
}

const gen = new RoughGenerator()

/** A rough.js drawable as SVG paths; the stroke colour and width come from the enclosing group. */
function roughSvg(dr: Drawable, evenodd = false): string {
  let out = ''
  for (const set of dr.sets) {
    const d = roundPath(gen.opsToPath(set, 1))
    if (set.type === 'path') out += `<path d="${d}" fill="none"/>`
    else if (set.type === 'fillPath') out += `<path d="${d}" fill="${dr.options.fill ?? 'none'}" stroke="none"${evenodd ? ' fill-rule="evenodd"' : ''}/>`
    else if (set.type === 'fillSketch') out += `<path d="${d}" stroke="${dr.options.fill ?? 'none'}" fill="none"/>`
  }
  return out
}

function nodeSvg(g: Geo, quality: Quality, cls: string, tip = ''): string {
  const n = g.node
  const t = TYPE[n.type] ?? TYPE.step
  const { w, h, lines, note } = g.size
  const ghost = n.status === 'ghost'
  const disputed = n.status === 'disputed'
  const stroke = disputed ? '#e03131' : ghost ? '#adb5bd' : t.stroke
  const strokeWidth = disputed ? 2.6 : 1.9
  const fill = ghost ? '#ffffff' : t.fill
  const opts: RoughOptions = { seed: hash(n.id), roughness: 1.15, bowing: 0.9, stroke, strokeWidth, fill, fillStyle: 'solid' }
  if (ghost) opts.strokeLineDash = [7, 6]
  if (quality === 'single') {
    opts.disableMultiStroke = true
    opts.disableMultiStrokeFill = true
  }
  const rough = quality === 'full' || quality === 'single'
  const hw = w / 2, hh = h / 2
  let halo: string
  let shape: string
  const plain = (d: string, f: string | null) => `<path d="${roundPath(d)}" fill="${f ?? 'none'}"/>`
  if (n.type === 'decision') {
    const pts: [number, number][] = [[0, -hh], [hw, 0], [0, hh], [-hw, 0]]
    shape = rough ? roughSvg(gen.polygon(pts, opts), true) : `<polygon points="${pts.map(p => p.map(r1).join(',')).join(' ')}" fill="${fill}"/>`
    halo = `M0,${r1(-hh - 6)} L${r1(hw + 8)},0 L0,${r1(hh + 6)} L${r1(-hw - 8)},0 Z`
  } else if (n.type === 'data') {
    const ry = 9, top = -hh + ry, bot = hh - ry
    const d = `M${-hw},${top} A${hw},${ry} 0 0,1 ${hw},${top} L${hw},${bot} A${hw},${ry} 0 0,1 ${-hw},${bot} Z`
    const lid = `M${-hw},${top} A${hw},${ry} 0 0,0 ${hw},${top}`
    shape = rough ? roughSvg(gen.path(d, opts)) + roughSvg(gen.path(lid, { ...opts, fill: undefined })) : plain(d, fill) + plain(lid, null)
    halo = roundedRect(w + 12, h + 12, 16)
  } else if (n.type === 'actor') {
    const r = Math.min(hh, 26)
    const d = roundedRect(w, h, r)
    shape = rough ? roughSvg(gen.path(d, opts)) : plain(d, fill)
    halo = roundedRect(w + 12, h + 12, r + 6)
  } else if (n.type === 'system') {
    const d = roundedRect(w, h, 4)
    shape = rough ? roughSvg(gen.path(d, opts)) : plain(d, fill)
    const bar = rough
      ? `<g stroke-width="1.3">${roughSvg(gen.line(-hw, -hh + 11, hw, -hh + 11, { ...opts, strokeWidth: 1.3 }))}</g>`
      : `<path d="M${r1(-hw)},${r1(-hh + 11)} L${r1(hw)},${r1(-hh + 11)}" stroke-width="1.3"/>`
    shape += bar
    for (let i = 0; i < 3; i++) shape += `<circle cx="${r1(-hw + 9 + i * 7)}" cy="${r1(-hh + 5.5)}" r="2" fill="${stroke}" stroke="none" opacity="0.7"/>`
    halo = roundedRect(w + 12, h + 12, 8)
  } else {
    const d = roundedRect(w, h, 12)
    shape = rough ? roughSvg(gen.path(d, opts)) : plain(d, fill)
    halo = roundedRect(w + 12, h + 12, 16)
  }
  const dash = ghost ? ' stroke-dasharray="7 6"' : ''
  let s = `<g class="node ${n.type} ${n.status}${cls}" data-id="${esc(n.id)}" transform="translate(${r1(g.x)},${r1(g.y)})">${tip ? `<title>${esc(tip)}</title>` : ''}<g class="inner">`
  s += `<path class="halo" d="${roundPath(halo)}"/>`
  s += `<g class="shape" stroke="${stroke}" stroke-width="${strokeWidth}"${dash}>${shape}</g>`
  const shift = n.type === 'actor' ? 13 : 0
  const top = n.type === 'system' ? 5 : 0
  const lineH = 19
  const startY = -((lines.length - 1) * lineH) / 2 - (note ? 7 : 0) + top
  lines.forEach((l, i) => {
    s += `<text class="node-label" x="${shift}" y="${r1(startY + i * lineH)}">${esc(l)}</text>`
  })
  if (note) s += `<text class="node-note" x="${shift}" y="${r1(startY + (lines.length - 1) * lineH + 20)}">${esc(note)}</text>`
  if (n.type === 'actor') {
    const ix = r1(-hw + 20), c = ghost ? '#adb5bd' : t.stroke
    s += `<g fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"><circle cx="${ix}" cy="-6" r="5"/><path d="M${r1(ix - 8)},11 Q${ix},-3 ${r1(ix + 8)},11"/></g>`
  }
  if (ghost) s += `<text class="node-note" x="${r1(-hw + 4)}" y="${r1(-hh - 7)}" text-anchor="start" font-style="italic">proposed</text>`
  if (disputed || n.status === 'resolved') {
    const bx = n.type === 'decision' ? hw * 0.55 : hw - 4
    const by = n.type === 'decision' ? -hh * 0.55 : -hh + 2
    s += `<g transform="translate(${r1(bx)},${r1(by)})"><g class="${disputed ? 'badge-disputed' : 'badge-resolved'}"><circle r="12" fill="${disputed ? '#e03131' : '#2b8a3e'}" stroke="#fff" stroke-width="2.5"/><text class="badge" text-anchor="middle" dominant-baseline="central">${disputed ? '!' : '✓'}</text></g></g>`
  }
  return s + '</g></g>'
}

function edgeSvg(e: DEdge, r: Route, cls: string, tip = ''): string {
  const marker = e.status === 'ghost' ? 'arrow-ghost' : e.status === 'disputed' ? 'arrow-disputed' : 'arrow'
  let s = `<g class="edge ${e.status}${cls}" data-id="${esc(e.id)}">${tip ? `<title>${esc(tip)}</title>` : ''}<path class="glow" d="${r.d}"/><path class="line" d="${r.d}" marker-end="url(#${marker})"/>`
  if (e.label) {
    const w = r1(textW(e.label, 13) + 10)
    s += `<g class="edge-label" transform="translate(${r1(r.mid.x)},${r1(r.mid.y)})"><rect x="${r1(-w / 2)}" y="-10" width="${w}" height="20" rx="6"/><text>${esc(e.label)}</text></g>`
  }
  return s + '</g>'
}

function chipSvg(g: Geo): string {
  const name = 'Claude'
  const w = r1(textW(name, 11) + 14)
  return `<g class="bychip" data-key="chip-${esc(g.id)}"><g transform="translate(${r1(g.x + g.w / 2 - w + 6)},${r1(g.y - g.h / 2 - 22)})"><rect width="${w}" height="18" rx="9" fill="${FLASH}"/><text class="byline" x="${r1(w / 2)}" y="12.5" text-anchor="middle">${name}</text></g></g>`
}

const CSS = [
  `text{font-family:${HAND}}`,
  `.node-label{font-weight:700;fill:#212529;font-size:16px;text-anchor:middle;dominant-baseline:central}`,
  `.node.ghost .node-label{fill:#868e96;font-weight:400}`,
  `.node-note{font-family:${SANS};font-size:10.5px;fill:#6c757d;text-anchor:middle}`,
  `.node.ghost .shape{opacity:.62}`,
  `.node .inner{transform-box:fill-box;transform-origin:center}`,
  `.node.new .inner{animation:nodeIn .55s cubic-bezier(.2,1.4,.4,1)}`,
  `@keyframes nodeIn{from{transform:scale(.4);opacity:0}}`,
  `.node .halo{fill:none;stroke:${FLASH};stroke-width:7;opacity:0}`,
  `.node.hl .halo{animation:halo 3.2s ease-out}`,
  `@keyframes halo{0%{opacity:.85;stroke-width:12}60%{opacity:.55}100%{opacity:0;stroke-width:5}}`,
  `.node.disputed .badge-disputed{animation:wobble 1.6s ease-in-out infinite;transform-box:fill-box;transform-origin:center}`,
  `@keyframes wobble{0%,100%{transform:rotate(0)}20%{transform:rotate(-12deg)}40%{transform:rotate(10deg)}60%{transform:rotate(0)}}`,
  `.badge{font-family:${SANS};font-weight:800;font-size:14px;fill:#fff}`,
  `.byline{font-family:${SANS};font-size:11px;font-weight:700;fill:#fff}`,
  `.bychip{opacity:0;animation:chip 3.2s ease forwards}`,
  `@keyframes chip{0%{opacity:0;transform:translateY(6px)}10%{opacity:1;transform:none}75%{opacity:1}100%{opacity:0}}`,
  `.edge .line{fill:none;stroke:#495057;stroke-width:1.9;stroke-linecap:round}`,
  `.edge.ghost .line{stroke:#adb5bd;stroke-dasharray:7 6}`,
  `.edge.disputed .line{stroke:#e03131;stroke-width:2.3;stroke-dasharray:3 5}`,
  `.edge.resolved .line{stroke:#2b8a3e}`,
  `.edge .glow{fill:none;stroke:${FLASH};stroke-width:9;opacity:0;stroke-linecap:round}`,
  `.edge.hl .glow{animation:glow 3.2s ease-out}`,
  `@keyframes glow{0%{opacity:.7}100%{opacity:0}}`,
  `.edge.new{animation:fadein .6s ease}`,
  `@keyframes fadein{from{opacity:0}}`,
  `.edge-label rect{fill:${BOARD_BG};stroke:none}`,
  `.edge-label text{font-size:13px;fill:#495057;text-anchor:middle;dominant-baseline:central}`,
  `.edge.disputed .edge-label text{fill:#c92a2a}`,
  `.node:hover .halo{opacity:.3;stroke:#adb5bd}`,
  `.edge:hover .line{stroke-width:2.8}`,
  `@media (prefers-reduced-motion:reduce){*{animation:none!important}.bychip{opacity:0}}`,
].join('')

/** The still version: the end state of the highlight, no keyframes, no hover. */
const CSS_STATIC = [
  `text{font-family:${HAND}}`,
  `.node-label{font-weight:700;fill:#212529;font-size:16px;text-anchor:middle;dominant-baseline:central}`,
  `.node.ghost .node-label{fill:#868e96;font-weight:400}`,
  `.node-note{font-family:${SANS};font-size:10.5px;fill:#6c757d;text-anchor:middle}`,
  `.node.ghost .shape{opacity:.62}`,
  `.node .halo{fill:none;stroke:${FLASH};stroke-width:7;opacity:0}`,
  `.node.hl .halo{opacity:.5;stroke-width:9}`,
  `.badge{font-family:${SANS};font-weight:800;font-size:14px;fill:#fff}`,
  `.byline{font-family:${SANS};font-size:11px;font-weight:700;fill:#fff}`,
  `.edge .line{fill:none;stroke:#495057;stroke-width:1.9;stroke-linecap:round}`,
  `.edge.ghost .line{stroke:#adb5bd;stroke-dasharray:7 6}`,
  `.edge.disputed .line{stroke:#e03131;stroke-width:2.3;stroke-dasharray:3 5}`,
  `.edge.resolved .line{stroke:#2b8a3e}`,
  `.edge .glow{fill:none;stroke:${FLASH};stroke-width:9;opacity:0;stroke-linecap:round}`,
  `.edge.hl .glow{opacity:.35}`,
  `.edge-label rect{fill:${BOARD_BG};stroke:none}`,
  `.edge-label text{font-size:13px;fill:#495057;text-anchor:middle;dominant-baseline:central}`,
  `.edge.disputed .edge-label text{fill:#c92a2a}`,
].join('')

const DEFS =
  `<defs><pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.3" fill="#d4d0c4"/></pattern>` +
  [
    ['arrow', '#495057', 1.6],
    ['arrow-ghost', '#adb5bd', 1.6],
    ['arrow-disputed', '#e03131', 1.8],
  ]
    .map(
      ([id, c, w]) =>
        `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/></marker>`,
    )
    .join('') +
  `</defs>`

function frame(x0: number, y0: number, w: number, h: number, body: string, isStatic = false): string {
  const vb = `${r1(x0)} ${r1(y0)} ${r1(w)} ${r1(h)}`
  const size = isStatic ? `width="${Math.ceil(w)}" height="${Math.ceil(h)}"` : `width="100%" height="100%"`
  // the paper reaches well past the viewBox, so a letterboxed image is dotted too
  const big = `x="${r1(x0 - 4000)}" y="${r1(y0 - 4000)}" width="${r1(w + 8000)}" height="${r1(h + 8000)}"`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="${vb}" preserveAspectRatio="xMidYMid meet">` +
    `<style>${isStatic ? CSS_STATIC : CSS}</style>${DEFS}<rect ${big} fill="${BOARD_BG}"/><rect ${big} fill="url(#dots)"/>${body}</svg>`
  )
}

function fallback(board: DBoard, why: string, isStatic = false): string {
  const n = Object.keys(board.nodes).length
  const body = `<text x="20" y="44" font-size="18" fill="#495057">${esc(board.title)}: ${n} nodes</text><text x="20" y="74" font-size="14" fill="#868e96">${esc(why)}</text>`
  return frame(0, 0, 520, 110, body, isStatic)
}

// ------------------------------------------------------------------ entry

const QUALITIES: Quality[] = ['full', 'single', 'clean']

/** The hand-drawn SVG of a board, under the size budget. */
const STATUS_WORD: { [s: string]: string } = { ghost: 'proposed', disputed: 'disputed', resolved: 'resolved', confirmed: '' }

/** A node's hover text: label, type, status, note. */
export function nodeTip(n: DNode): string {
  const st = STATUS_WORD[n.status] ?? n.status
  return `${n.label} (${n.type}${st ? `, ${st}` : ''})${n.note ? `\n${n.note}` : ''}`
}

/** An edge's hover text: from → to, label, status, note. */
export function edgeTip(board: DBoard, e: DEdge): string {
  const name = (id: string) => board.nodes[id]?.label ?? id
  const st = STATUS_WORD[e.status] ?? e.status
  return `${name(e.from)} → ${name(e.to)}${e.label ? `: ${e.label}` : ''}${st ? ` (${st})` : ''}${e.note ? `\n${e.note}` : ''}`
}

export function renderRich(board: DBoard, placement: DPlacement, opts: RichOpts): Rich {
  const limit = opts.limit ?? SVG_LIMIT
  const lr = layoutFor(board, placement, 'LR')
  const tb = layoutFor(board, placement, 'TB')
  const dir = chooseRichDir(lr, tb, Math.max(1, opts.maxWidth), Math.max(1, opts.maxHeight), opts.prefer)
  const L = dir === 'LR' ? lr : tb
  const ids = new Set(opts.recent?.ids ?? [])
  const added = new Set(opts.recent?.added ?? [])
  const count = Object.keys(board.nodes).length
  const startAt = opts.quality ?? (count > 40 ? 'single' : 'full')
  const draw = (quality: Quality) => {
    let edges = ''
    for (const e of Object.values(board.edges)) {
      const r = L.routes.get(e.id)
      if (!r) continue
      const cls = added.has(e.id) ? ' new hl' : ids.has(e.id) ? ' hl' : ''
      edges += edgeSvg(e, r, cls, opts.tooltips ? edgeTip(board, e) : '')
    }
    let nodes = ''
    let fx = ''
    for (const g of L.geos.values()) {
      const cls = added.has(g.id) ? ' new hl' : ids.has(g.id) ? ' hl' : ''
      nodes += nodeSvg(g, quality, cls, opts.tooltips ? nodeTip(g.node) : '')
      if (opts.chip === undefined ? !!cls : opts.chip === g.id) fx += chipSvg(g)
    }
    return frame(L.x0, L.y0, L.w, L.h, `<g class="edges">${edges}</g><g class="nodes">${nodes}</g><g class="fx">${fx}</g>`, opts.isStatic)
  }
  const steps = startAt === 'fallback' ? [] : QUALITIES.slice(QUALITIES.indexOf(startAt))
  for (const quality of steps) {
    const source = draw(quality)
    if (source.length <= limit) return { source, width: r1(L.w), height: r1(L.h), dir, quality }
  }
  let source = fallback(board, 'Too large to draw here: split it into several boards (new_board).', opts.isStatic)
  if (source.length > limit) source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 110"/>'
  return { source, width: 520, height: 110, dir, quality: 'fallback' }
}

/** The pane's empty state. */
export function emptySvg(): string {
  return frame(0, 0, 520, 120, `<text x="260" y="56" text-anchor="middle" font-size="20" fill="#b9b4a6">No diagram yet</text><text x="260" y="84" text-anchor="middle" font-size="14" fill="#868e96">Ask Claude to draw something; it calls update_diagram.</text>`)
}
