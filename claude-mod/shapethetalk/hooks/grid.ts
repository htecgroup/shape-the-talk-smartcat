// Terminal renderer: placement -> a grid of cells (box-drawing glyphs and
// colours), orthogonal edge routing (Dijkstra on the cells), Raster encoding
// and a plain-text snapshot. Pure.

import type { DBoard, DEdge, DNode, DPlacement } from '../types'
import { normalise } from './layout.ts'

export type Dir = 'LR' | 'TB'

export const COLORS = {
  actor: 0xf08c00,
  system: 0x339af0,
  decision: 0xe64980,
  data: 0x37b24d,
  ghost: 0x868e96,
  disputed: 0xfa5252,
  resolved: 0x40c057,
  highlight: 0xfcc419,
  note: 0x868e96,
  label: 0xadb5bd,
  default: 0x01000000,
} as const

export type Box = {
  id: string
  x: number
  y: number
  w: number
  h: number
  node: DNode
  lines: string[]
  note: string | null
}

export type Grid = {
  width: number
  height: number
  dir: Dir
  /** row-major code points */
  glyph: Uint32Array
  fg: Uint32Array
  bg: Uint32Array
  boxes: Box[]
  /** edge ids that could not be routed */
  undrawn: string[]
  /** edge id -> the arrowhead cell index */
  arrows: Map<string, number>
  /** edge id -> the cells its line runs through (start to arrow) */
  paths: Map<string, number[]>
}

export type GridOpts = {
  /** cells across the pane, to choose the direction */
  columns: number
  /** the direction drawn last time for this board */
  prefer?: Dir
  /** ids drawn highlighted */
  highlight?: readonly string[]
}

const LABEL_WRAP = 18
const MARGIN = 2

// ------------------------------------------------------------------ text

/** One printable width-1 BMP character, else '?'. */
export function safeText(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    const ok =
      (c >= 0x20 && c <= 0x7e) ||
      (c >= 0xa0 && c <= 0x2ff) ||
      (c >= 0x370 && c <= 0x482) ||
      (c >= 0x48a && c <= 0x52f) ||
      (c >= 0x1e00 && c <= 0x1fff) ||
      (c >= 0x2010 && c <= 0x2027) ||
      (c >= 0x2030 && c <= 0x205e) ||
      (c >= 0x20a0 && c <= 0x20bf) ||
      (c >= 0x2190 && c <= 0x21ff) ||
      (c >= 0x2200 && c <= 0x22ff) ||
      (c >= 0x2500 && c <= 0x25ff) ||
      c === 0x2713
    out += ok ? ch : c === 0x09 || c === 0x0a ? ' ' : '?'
  }
  return out
}

const cutTo = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s)

/** Wrap to at most 2 lines of `max` characters, the rest cut with an ellipsis. */
export function wrap2(text: string, max = LABEL_WRAP): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = ['']
  for (const w of words) {
    const last = lines[lines.length - 1]!
    const cand = last ? `${last} ${w}` : w
    if (cand.length > max && last) lines.push(w)
    else lines[lines.length - 1] = cand
  }
  if (lines.length > 2) {
    lines[1] = lines.slice(1).join(' ')
    lines.length = 2
  }
  return lines.map(l => cutTo(l, max))
}

export function nodeBox(node: DNode): Omit<Box, 'x' | 'y'> {
  const prefix = node.status === 'disputed' ? '! ' : node.status === 'resolved' ? '✓ ' : ''
  const lines = wrap2(safeText(prefix + node.label))
  const labelW = Math.max(...lines.map(l => l.length))
  const rawNote = node.note ? safeText(node.note) : null
  const inner = Math.max(6, labelW, rawNote ? Math.min(rawNote.length, LABEL_WRAP) : 0)
  const note = rawNote ? cutTo(rawNote, inner) : null
  return { id: node.id, w: inner + 4, h: lines.length + (note ? 1 : 0) + 2, node, lines, note }
}

// ------------------------------------------------------------------ placement -> cells

type Laid = { boxes: Box[]; width: number; height: number }

function lay(board: DBoard, placement: DPlacement, dir: Dir): Laid {
  const p = normalise(placement)
  const sized = Object.values(board.nodes)
    .filter(n => p[n.id])
    .map(n => ({ ...nodeBox(n), place: p[n.id]! }))
  if (!sized.length) return { boxes: [], width: 1, height: 1 }
  const maxW = Math.max(...sized.map(b => b.w))
  const maxH = Math.max(...sized.map(b => b.h))
  const ranks = Math.max(...sized.map(b => b.place.r)) + 1
  const longest = Math.max(0, ...Object.values(board.edges).map(e => (e.label ? Math.min(16, safeText(e.label).length) : 0)))
  const boxes: Box[] = []
  if (dir === 'LR') {
    const colW = Array.from({ length: ranks }, (_, r) => Math.max(0, ...sized.filter(b => b.place.r === r).map(b => b.w)))
    const gap = Math.max(7, Math.min(22, longest + 8))
    const xs: number[] = []
    let x = MARGIN
    for (let r = 0; r < ranks; r++) {
      xs.push(x)
      x += colW[r]! + (colW[r] ? gap : 2)
    }
    const unit = maxH + 2
    for (const b of sized) {
      boxes.push({
        id: b.id,
        node: b.node,
        lines: b.lines,
        note: b.note,
        w: b.w,
        h: b.h,
        x: xs[b.place.r]! + Math.floor((colW[b.place.r]! - b.w) / 2),
        y: MARGIN + Math.round(b.place.s * unit) + Math.floor((maxH - b.h) / 2),
      })
    }
  } else {
    const rowH = Array.from({ length: ranks }, (_, r) => Math.max(0, ...sized.filter(b => b.place.r === r).map(b => b.h)))
    const gap = 4
    const ys: number[] = []
    let y = MARGIN
    for (let r = 0; r < ranks; r++) {
      ys.push(y)
      y += rowH[r]! + (rowH[r] ? gap : 1)
    }
    const unit = maxW + 3
    for (const b of sized) {
      boxes.push({
        id: b.id,
        node: b.node,
        lines: b.lines,
        note: b.note,
        w: b.w,
        h: b.h,
        x: MARGIN + Math.round(b.place.s * unit) + Math.floor((maxW - b.w) / 2),
        y: ys[b.place.r]! + Math.floor((rowH[b.place.r]! - b.h) / 2),
      })
    }
  }
  const width = Math.max(...boxes.map(b => b.x + b.w)) + MARGIN
  const height = Math.max(...boxes.map(b => b.y + b.h)) + MARGIN - 1
  return { boxes, width, height }
}

/** The direction to draw in: keep the last one unless only the other fits. */
export function chooseDir(board: DBoard, placement: DPlacement, columns: number, prefer?: Dir): Dir {
  const lr = lay(board, placement, 'LR').width
  const tb = lay(board, placement, 'TB').width
  const fits = (d: Dir) => (d === 'LR' ? lr : tb) <= columns
  if (prefer && fits(prefer)) return prefer
  if (fits('LR')) return 'LR'
  if (fits('TB')) return 'TB'
  if (prefer) return prefer
  return tb < lr ? 'TB' : 'LR'
}

// ------------------------------------------------------------------ glyphs

type Style = { tl: string; tr: string; bl: string; br: string; h: string; v: string; top?: string; bottom?: string }

const STYLES: Record<DNode['type'], Style> = {
  actor: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  system: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
  step: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  decision: { tl: '╱', tr: '╲', bl: '╲', br: '╱', h: '─', v: '│' },
  data: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', top: '═', bottom: '═' },
}

const E = 1, S = 2, W = 4, N = 8
const DX = [1, 0, -1, 0]
const DY = [0, 1, 0, -1]
const BIT = [E, S, W, N]
const OPP = [2, 3, 0, 1]
const ARROW = ['▶', '▼', '◀', '▲']

const LINE: Record<number, string> = {
  [E]: '─', [W]: '─', [E | W]: '─',
  [N]: '│', [S]: '│', [N | S]: '│',
  [E | S]: '┌', [W | S]: '┐', [N | E]: '└', [N | W]: '┘',
  [E | W | S]: '┬', [E | W | N]: '┴', [N | S | E]: '├', [N | S | W]: '┤',
  [N | S | E | W]: '┼',
}

function nodeColor(n: DNode, hl: Set<string>): number {
  if (hl.has(n.id)) return COLORS.highlight
  if (n.status === 'ghost') return COLORS.ghost
  if (n.status === 'disputed') return COLORS.disputed
  if (n.status === 'resolved') return COLORS.resolved
  return n.type === 'step' ? COLORS.default : COLORS[n.type]
}

function edgeColor(e: DEdge, hl: Set<string>): number {
  if (hl.has(e.id)) return COLORS.highlight
  if (e.status === 'ghost') return COLORS.ghost
  if (e.status === 'disputed') return COLORS.disputed
  if (e.status === 'resolved') return COLORS.resolved
  return COLORS.default
}

// ------------------------------------------------------------------ heap

class Heap {
  private k: number[] = []
  private v: number[] = []
  get size() {
    return this.k.length
  }
  push(key: number, val: number) {
    const k = this.k, v = this.v
    k.push(key)
    v.push(val)
    let i = k.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (k[p]! <= k[i]!) break
      ;[k[p], k[i]] = [k[i]!, k[p]!]
      ;[v[p], v[i]] = [v[i]!, v[p]!]
      i = p
    }
  }
  pop(): number {
    const k = this.k, v = this.v
    const top = v[0]!
    const lk = k.pop()!, lv = v.pop()!
    if (k.length) {
      k[0] = lk
      v[0] = lv
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < k.length && k[l]! < k[m]!) m = l
        if (r < k.length && k[r]! < k[m]!) m = r
        if (m === i) break
        ;[k[m], k[i]] = [k[i]!, k[m]!]
        ;[v[m], v[i]] = [v[i]!, v[m]!]
        i = m
      }
    }
    return top
  }
}

// ------------------------------------------------------------------ render

/** Draw a board into cells. */
export function renderGrid(board: DBoard, placement: DPlacement, opts: GridOpts): Grid {
  const dir = chooseDir(board, placement, opts.columns, opts.prefer)
  const { boxes, width: W0, height: H0 } = lay(board, placement, dir)
  const width = Math.max(1, W0)
  const height = Math.max(1, H0)
  const size = width * height
  const hl = new Set(opts.highlight ?? [])
  const glyph = new Uint32Array(size).fill(0x20)
  const fg = new Uint32Array(size).fill(COLORS.default)
  const bg = new Uint32Array(size).fill(COLORS.default)
  const block = new Uint8Array(size) // 1 box, 2 reserved (arrow, label)
  const near = new Uint8Array(size)
  const mask = new Uint8Array(size)
  const owners = new Uint8Array(size)
  const dashed = new Uint8Array(size)
  const lineColor = new Uint32Array(size).fill(COLORS.default)
  const portGlyph = new Map<number, string>()
  const usedPorts = new Set<number>()
  const byId = new Map(boxes.map(b => [b.id, b]))
  const at = (x: number, y: number) => y * width + x
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height

  for (const b of boxes) {
    for (let y = b.y - 1; y <= b.y + b.h; y++)
      for (let x = b.x - 1; x <= b.x + b.w; x++) if (inside(x, y)) near[at(x, y)] = 1
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (inside(x, y)) block[at(x, y)] = 1
  }

  // ---- route the edges: short ones first, so neighbours get straight lines
  const edges = Object.values(board.edges).filter(e => byId.has(e.from) && byId.has(e.to))
  const rankDist = (e: DEdge) => {
    const a = byId.get(e.from)!, b = byId.get(e.to)!
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
  }
  edges.sort((p, q) => rankDist(p) - rankDist(q))
  const undrawn: string[] = []
  const arrows = new Map<string, number>()
  const paths = new Map<string, number[]>()

  // the cells beside a box's side (not its corners), with the direction pointing away from the box
  const sides = (b: Box) => {
    const out: { border: number; cell: number; d: number; off: number; side: number }[] = []
    const add = (bx: number, by: number, d: number, off: number) => {
      const cx = bx + DX[d]!, cy = by + DY[d]!
      if (inside(cx, cy)) out.push({ border: at(bx, by), cell: at(cx, cy), d, off, side: d })
    }
    const mx = b.x + (b.w - 1) / 2, my = b.y + (b.h - 1) / 2
    for (let y = b.y + 1; y < b.y + b.h - 1; y++) {
      add(b.x + b.w - 1, y, 0, Math.abs(y - my))
      add(b.x, y, 2, Math.abs(y - my))
    }
    for (let x = b.x + 1; x < b.x + b.w - 1; x++) {
      add(x, b.y + b.h - 1, 1, Math.abs(x - mx))
      add(x, b.y, 3, Math.abs(x - mx))
    }
    return out
  }
  const facing = (a: Box, b: Box): number => {
    const dx = b.x + b.w / 2 - (a.x + a.w / 2)
    const dy = b.y + b.h / 2 - (a.y + a.h / 2)
    const sepX = b.x >= a.x + a.w || a.x >= b.x + b.w
    const sepY = b.y >= a.y + a.h || a.y >= b.y + b.h
    if (sepX && (!sepY || Math.abs(dx) * 0.5 >= Math.abs(dy))) return dx > 0 ? 0 : 2
    return dy > 0 ? 1 : 3
  }

  const dist = new Float64Array(size * 4)
  const prev = new Int32Array(size * 4)
  for (const e of edges) {
    const A = byId.get(e.from)!, B = byId.get(e.to)!
    const fa = facing(A, B), fb = facing(B, A)
    dist.fill(Infinity)
    prev.fill(-1)
    const heap = new Heap()
    const bcx = B.x + B.w / 2, bcy = B.y + B.h / 2
    const h = (c: number) => {
      const x = c % width, y = (c - x) / width
      return Math.max(0, Math.abs(x - bcx) - B.w / 2 - 1) + Math.max(0, Math.abs(y - bcy) - B.h / 2 - 1)
    }
    const starts = new Map<number, { border: number; d: number }>()
    for (const s of sides(A)) {
      if (usedPorts.has(s.border) || block[s.cell] || mask[s.cell]) continue
      const sideCost = s.side === fa ? 0 : s.side === OPP[fa] ? 10 : 4
      const cost = sideCost + s.off * 0.6
      const st = s.cell * 4 + s.d
      if (cost < dist[st]!) {
        dist[st] = cost
        starts.set(st, { border: s.border, d: s.d })
        heap.push(cost + h(s.cell), st)
      }
    }
    // goals: the cell beside B's side, arrived at moving into B
    const goals = new Map<number, number>()
    for (const s of sides(B)) {
      if (block[s.cell] || mask[s.cell]) continue
      const into = OPP[s.d]!
      const sideCost = s.side === fb ? 0 : s.side === OPP[fb] ? 10 : 4
      goals.set(s.cell * 4 + into, sideCost + s.off * 0.6)
    }
    let best = -1
    let bestCost = Infinity
    while (heap.size) {
      const st = heap.pop()
      const d0 = dist[st]!
      if (d0 >= bestCost) break
      const g = goals.get(st)
      if (g !== undefined && d0 + g < bestCost) {
        bestCost = d0 + g
        best = st
      }
      const cell = st >> 2, d = st & 3
      const x = cell % width, y = (cell - x) / width
      const occupied = mask[cell] !== 0
      for (const nd of occupied ? [d] : [d, (d + 1) % 4, (d + 3) % 4]) {
        const nx = x + DX[nd]!, ny = y + DY[nd]!
        if (!inside(nx, ny)) continue
        const nc = at(nx, ny)
        if (block[nc]) continue
        let cost = d0 + 1 + (nd !== d ? 4 : 0) + (near[nc] ? 0.3 : 0)
        const m = mask[nc]!
        if (m) {
          const horiz = nd === 0 || nd === 2
          const straightAcross = horiz ? m === (N | S) : m === (E | W)
          if (!straightAcross) continue
          cost += 3
        }
        const ns = nc * 4 + nd
        if (cost < dist[ns]!) {
          dist[ns] = cost
          prev[ns] = st
          heap.push(cost + h(nc), ns)
        }
      }
    }
    if (best < 0) {
      undrawn.push(e.id)
      continue
    }
    // walk back
    const chain: number[] = []
    for (let st = best; st >= 0; st = prev[st]!) chain.push(st)
    chain.reverse()
    const first = starts.get(chain[0]!)!
    const color = edgeColor(e, hl)
    const cells: number[] = []
    const startCell = chain[0]! >> 2
    mask[startCell]! |= BIT[OPP[first.d]!]!
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i]! >> 2
      cells.push(c)
      if (i + 1 < chain.length) {
        const nd = chain[i + 1]! & 3
        const nc = chain[i + 1]! >> 2
        mask[c]! |= BIT[nd]!
        if (i + 1 < chain.length - 1) mask[nc]! |= BIT[OPP[nd]!]!
      }
    }
    const goalCell = best >> 2
    for (const c of cells) {
      if (c === goalCell) continue
      owners[c]! += 1
      lineColor[c] = color
      if (e.status === 'ghost') dashed[c] = 1
    }
    block[goalCell] = 2
    glyph[goalCell] = ARROW[best & 3]!.codePointAt(0)!
    fg[goalCell] = color
    arrows.set(e.id, goalCell)
    paths.set(e.id, cells)
    usedPorts.add(first.border)
    const t = A.node.type
    const dbl = t === 'system'
    const dblH = t === 'system' || t === 'data'
    portGlyph.set(first.border, first.d === 0 ? (dbl ? '╟' : '├') : first.d === 2 ? (dbl ? '╢' : '┤') : first.d === 1 ? (dblH ? '╤' : '┬') : dblH ? '╧' : '┴')
  }

  // ---- paint lines
  for (let c = 0; c < size; c++) {
    if (!mask[c] || block[c]) continue
    const m = mask[c]!
    let ch = LINE[m] ?? '┼'
    if (dashed[c] && owners[c] === 1) {
      if (m === (E | W) || m === E || m === W) ch = '┄'
      else if (m === (N | S) || m === N || m === S) ch = '┆'
    }
    glyph[c] = ch.codePointAt(0)!
    fg[c] = lineColor[c]!
  }

  // ---- edge labels: inline on a straight run, else beside the line
  const labelled = new Uint8Array(size)
  for (const e of edges) {
    const cells = paths.get(e.id)
    if (!e.label || !cells) continue
    const text = cutTo(safeText(e.label), 16)
    const color = hl.has(e.id) ? COLORS.highlight : COLORS.label
    const plain = (c: number, m: number) => mask[c] === m && owners[c] === 1 && !labelled[c] && !block[c]
    // horizontal runs
    const runs: number[][] = []
    let run: number[] = []
    for (const c of cells) {
      if (plain(c, E | W) && (!run.length || Math.abs(c - run[run.length - 1]!) === 1)) run.push(c)
      else {
        if (run.length) runs.push(run)
        run = plain(c, E | W) ? [c] : []
      }
    }
    if (run.length) runs.push(run)
    runs.sort((a, b) => b.length - a.length)
    const need = text.length + 4
    const long = runs.find(r => r.length >= need)
    const write = (start: number, s: string) => {
      for (let i = 0; i < s.length; i++) {
        glyph[start + i] = s.codePointAt(i)!
        fg[start + i] = color
        labelled[start + i] = 1
        block[start + i] = 2
      }
    }
    if (long) {
      const lo = Math.min(...long)
      const off = lo + Math.floor((long.length - text.length - 2) / 2)
      write(off, ` ${text} `)
      continue
    }
    // beside a vertical run, or above a short horizontal one
    const free = (x: number, y: number, n: number) => {
      if (y < 0 || y >= height || x < 0 || x + n > width) return false
      for (let i = 0; i < n; i++) {
        const c = at(x + i, y)
        if (mask[c] || block[c] || labelled[c] || near[c]) return false
      }
      return true
    }
    const verts = cells.filter(c => plain(c, N | S))
    const mid = verts.length ? verts.slice(Math.floor(verts.length / 3)).concat(verts.slice(0, Math.floor(verts.length / 3))) : []
    let done = false
    for (const c of mid) {
      const x = c % width, y = (c - x) / width
      if (free(x + 2, y, text.length)) {
        write(at(x + 2, y), text)
        done = true
        break
      }
      if (free(x - 1 - text.length, y, text.length)) {
        write(at(x - 1 - text.length, y), text)
        done = true
        break
      }
    }
    if (done) continue
    for (const r of runs) {
      const c = r[Math.floor(r.length / 2)]!
      const x = c % width, y = (c - x) / width
      const sx = Math.max(0, Math.min(width - text.length, x - Math.floor(text.length / 2)))
      if (free(sx, y - 1, text.length)) {
        write(at(sx, y - 1), text)
        break
      }
      if (free(sx, y + 1, text.length)) {
        write(at(sx, y + 1), text)
        break
      }
    }
  }

  // ---- paint boxes
  for (const b of boxes) {
    const st = STYLES[b.node.type]
    const ghost = b.node.status === 'ghost'
    const color = nodeColor(b.node, hl)
    const put = (x: number, y: number, ch: string, col: number) => {
      if (!inside(x, y)) return
      const c = at(x, y)
      glyph[c] = (portGlyph.get(c) ?? ch).codePointAt(0)!
      fg[c] = col
    }
    const hch = (top: boolean) => (ghost ? '┄' : top ? st.top ?? st.h : st.bottom ?? st.h)
    const vch = ghost ? '┆' : st.v
    for (let x = b.x + 1; x < b.x + b.w - 1; x++) {
      put(x, b.y, hch(true), color)
      put(x, b.y + b.h - 1, hch(false), color)
    }
    for (let y = b.y + 1; y < b.y + b.h - 1; y++) {
      put(b.x, y, vch, color)
      put(b.x + b.w - 1, y, vch, color)
      for (let x = b.x + 1; x < b.x + b.w - 1; x++) put(x, y, ' ', COLORS.default)
    }
    put(b.x, b.y, st.tl, color)
    put(b.x + b.w - 1, b.y, st.tr, color)
    put(b.x, b.y + b.h - 1, st.bl, color)
    put(b.x + b.w - 1, b.y + b.h - 1, st.br, color)
    const inner = b.w - 4
    const text = (y: number, s: string, col: number) => {
      const x0 = b.x + 2 + Math.floor((inner - s.length) / 2)
      for (let i = 0; i < s.length; i++) put(x0 + i, y, s[i]!, col)
    }
    const labelColor = ghost ? COLORS.ghost : b.node.status === 'disputed' ? COLORS.disputed : COLORS.default
    b.lines.forEach((l, i) => text(b.y + 1 + i, l, labelColor))
    if (b.note) text(b.y + 1 + b.lines.length, b.note, COLORS.note)
  }

  return { width, height, dir, glyph, fg, bg, boxes, undrawn, arrows, paths }
}

// ------------------------------------------------------------------ output

/** The glyphs as plain text, trailing spaces trimmed. */
export function snapshotText(g: Grid): string {
  const rows: string[] = []
  for (let y = 0; y < g.height; y++) {
    let row = ''
    for (let x = 0; x < g.width; x++) row += String.fromCodePoint(g.glyph[y * g.width + x]!)
    rows.push(row.replace(/\s+$/, ''))
  }
  while (rows.length && rows[rows.length - 1] === '') rows.pop()
  while (rows.length && rows[0] === '') rows.shift()
  return rows.join('\n')
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '=='
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '='
  }
  return out
}

export const RASTER_MAX_COLUMNS = 512
export const RASTER_MAX_ROWS = 256

/** A window of the grid as Raster props: columns from `x0`, at most `columns` wide. */
export function encodeRaster(g: Grid, x0: number, columns: number): { columns: number; rows: number; cells: string } {
  const cols = Math.max(1, Math.min(columns, g.width - x0, RASTER_MAX_COLUMNS))
  const rows = Math.max(1, Math.min(g.height, RASTER_MAX_ROWS))
  const buf = new ArrayBuffer(cols * rows * 12)
  const view = new DataView(buf)
  let o = 0
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const gx = x0 + x
      const c = y * g.width + gx
      const ok = gx >= 0 && gx < g.width
      view.setUint32(o, ok ? g.glyph[c]! : 0x20, true)
      view.setUint32(o + 4, ok ? g.fg[c]! : COLORS.default, true)
      view.setUint32(o + 8, ok ? g.bg[c]! : COLORS.default, true)
      o += 12
    }
  }
  return { columns: cols, rows, cells: base64(new Uint8Array(buf)) }
}
