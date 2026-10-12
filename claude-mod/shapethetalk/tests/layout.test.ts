import { describe, expect, test } from 'claude-code/testing'

import { applyOps, emptyDoc } from '../hooks/board.ts'
import { encodeRaster, renderGrid, snapshotText } from '../hooks/grid.ts'
import type { Grid } from '../hooks/grid.ts'
import { backEdges, fullLayout, placeNew } from '../hooks/layout.ts'
import { SAMPLES, boardFrom, bigOps } from '../scripts/samples.ts'
import type { DBoard } from '../types'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function unbase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map(k => (i + k < clean.length ? B64.indexOf(clean[i + k]!) : 0))
    const v = (n[0]! << 18) | (n[1]! << 12) | (n[2]! << 6) | n[3]!
    if (o < out.length) out[o++] = (v >> 16) & 255
    if (o < out.length) out[o++] = (v >> 8) & 255
    if (o < out.length) out[o++] = v & 255
  }
  return out
}

function checkGrid(g: Grid, board: DBoard) {
  // inside the grid
  for (const b of g.boxes) {
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.y).toBeGreaterThanOrEqual(0)
    expect(b.x + b.w).toBeLessThanOrEqual(g.width)
    expect(b.y + b.h).toBeLessThanOrEqual(g.height)
  }
  // no overlapping boxes
  for (const p of g.boxes)
    for (const q of g.boxes) {
      if (p === q) continue
      const apart = p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y
      expect(apart, `${p.id} overlaps ${q.id}`).toBe(true)
    }
  // every edge routed, with an arrowhead, and none through a box
  expect(g.undrawn).toEqual([])
  for (const e of Object.values(board.edges)) {
    const arrow = g.arrows.get(e.id)
    expect(arrow, `${e.id} has an arrow`).toBeDefined()
    expect('▶◀▲▼').toContain(String.fromCodePoint(g.glyph[arrow!]!))
    for (const c of g.paths.get(e.id)!) {
      const x = c % g.width, y = Math.floor(c / g.width)
      for (const b of g.boxes) {
        const inBox = x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h
        expect(inBox, `${e.id} runs through ${b.id}`).toBe(false)
      }
    }
  }
}

describe('terminal grid', () => {
  for (const [columns, rows] of [
    [120, 40],
    [70, 40],
    [48, 30],
  ] as const) {
    test(`sample boards at ${columns}x${rows}`, () => {
      for (const s of SAMPLES) {
        const board = boardFrom(s.ops)
        const g = renderGrid(board, fullLayout(board), { columns })
        checkGrid(g, board)
        void rows
      }
    })
  }

  test('the text render is deterministic', () => {
    const board = boardFrom(SAMPLES[1]!.ops)
    const a = snapshotText(renderGrid(board, fullLayout(board), { columns: 100 }))
    const b = snapshotText(renderGrid(boardFrom(SAMPLES[1]!.ops), fullLayout(board), { columns: 100 }))
    expect(a).toBe(b)
    expect(a).toContain('Load balancer')
    expect(a).toContain('╔')
  })

  test('raster encoding', () => {
    const board = boardFrom(SAMPLES[2]!.ops)
    const g = renderGrid(board, fullLayout(board), { columns: 200 })
    const r = encodeRaster(g, 0, 40)
    expect(r.columns).toBe(Math.min(40, g.width))
    expect(r.rows).toBe(g.height)
    const bytes = unbase64(r.cells)
    expect(bytes.length).toBe(r.columns * r.rows * 12)
    const view = new DataView(bytes.buffer)
    for (let i = 0; i < r.columns * r.rows; i++) {
      const cp = view.getUint32(i * 12, true)
      const fg = view.getUint32(i * 12 + 4, true)
      expect(cp >= 0x20 && cp <= 0xffff).toBe(true)
      expect(fg === 0x01000000 || fg <= 0xffffff).toBe(true)
      const x = i % r.columns, y = Math.floor(i / r.columns)
      expect(cp).toBe(g.glyph[y * g.width + x]!)
    }
    // a pan window starts where asked
    const panned = encodeRaster(g, 10, 20)
    const pv = new DataView(unbase64(panned.cells).buffer)
    expect(pv.getUint32(0, true)).toBe(g.glyph[10]!)
  })

  test('labels with wide characters are drawn as one-cell glyphs', () => {
    const doc = applyOps(emptyDoc(), [{ op: 'add_node', id: 'x', label: '日本 🚀 ok', type: 'step' }]).doc
    const board = doc.boards.main!
    const g = renderGrid(board, fullLayout(board), { columns: 80 })
    expect(snapshotText(g)).toContain('?? ? ok')
  })
})

describe('layout', () => {
  test('positions are stable across calls', () => {
    let doc = applyOps(emptyDoc(), SAMPLES[0]!.ops).doc
    const first = placeNew(doc.boards.pipeline!, undefined)
    doc = applyOps(doc, [
      { op: 'add_node', id: 'store', label: 'Recording', type: 'data' },
      { op: 'connect', from: 'stt', to: 'store' },
    ]).doc
    const second = placeNew(doc.boards.pipeline!, first)
    for (const [id, p] of Object.entries(first)) expect(second[id]).toEqual(p)
    expect(second.store!.r).toBe(first.stt!.r + 1)
    expect(placeNew(doc.boards.pipeline!, second)).toEqual(second)
  })

  test('a via insert opens a rank', () => {
    let doc = applyOps(emptyDoc(), [
      { op: 'add_node', id: 'a', label: 'A', type: 'step' },
      { op: 'add_node', id: 'b', label: 'B', type: 'step' },
      { op: 'add_node', id: 'c', label: 'C', type: 'step' },
      { op: 'connect', from: 'a', to: 'b' },
      { op: 'connect', from: 'b', to: 'c' },
    ]).doc
    const p0 = placeNew(doc.boards.main!, undefined)
    expect([p0.a!.r, p0.b!.r, p0.c!.r]).toEqual([0, 1, 2])
    doc = applyOps(doc, [
      { op: 'add_node', id: 'v', label: 'V', type: 'step' },
      { op: 'reroute', edge: 'a->b', via: 'v' },
    ]).doc
    const p1 = placeNew(doc.boards.main!, p0)
    expect(p1.v!.r).toBe(1)
    expect(p1.b!.r).toBe(2)
    expect(p1.c!.r).toBe(3)
    expect(p1.a).toEqual(p0.a)
  })

  test('cycles are broken and laid out', () => {
    const doc = applyOps(emptyDoc(), [
      { op: 'add_node', id: 'a', label: 'A', type: 'step' },
      { op: 'add_node', id: 'b', label: 'B', type: 'step' },
      { op: 'add_node', id: 'c', label: 'C', type: 'step' },
      { op: 'connect', from: 'a', to: 'b' },
      { op: 'connect', from: 'b', to: 'c' },
      { op: 'connect', from: 'c', to: 'a' },
    ]).doc
    const board = doc.boards.main!
    expect([...backEdges(board)]).toEqual(['c->a'])
    const p = fullLayout(board)
    expect([p.a!.r, p.b!.r, p.c!.r]).toEqual([0, 1, 2])
    checkGrid(renderGrid(board, p, { columns: 120 }), board)
  })

  test('a full re-layout only for a big first call', () => {
    const doc = applyOps(emptyDoc(), bigOps(12)).doc
    const board = doc.boards.big12!
    expect(placeNew(board, undefined)).toEqual(fullLayout(board))
  })
})
