import { describe, expect, test } from 'claude-code/testing'

import { applyOps, emptyDoc } from '../hooks/board.ts'
import { fullLayout, placeNew } from '../hooks/layout.ts'
import { SVG_LIMIT, chooseRichDir, hash, renderRich } from '../hooks/rich.ts'
import { SAMPLES, bigOps, boardFrom } from '../scripts/samples.ts'
import type { DBoard } from '../types'
import { xmlProblem } from './xml.ts'

const ROOM = { maxWidth: 700, maxHeight: 900 }
const draw = (board: DBoard, extra: Partial<Parameters<typeof renderRich>[2]> = {}) =>
  renderRich(board, fullLayout(board), { ...ROOM, ...extra })

/** The markup of one node's group. */
function nodeMarkup(src: string, id: string): string {
  const start = src.indexOf(`data-id="${id}"`)
  expect(start, `node ${id} drawn`).toBeGreaterThan(0)
  const from = src.lastIndexOf('<g class="node', start)
  const end = src.indexOf('<g class="node', start)
  return src.slice(from, end < 0 ? src.indexOf('</g><g class="fx">', start) : end)
}

describe('desktop svg', () => {
  test('every sample parses as XML and is safe', () => {
    for (const s of SAMPLES) {
      const { source } = draw(boardFrom(s.ops))
      expect(xmlProblem(source), s.name).toBeNull()
      expect(source.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox=')).toBe(true)
      expect(source).toContain('preserveAspectRatio="xMidYMid meet"')
      expect(source).not.toMatch(/<script/i)
      expect(source).not.toMatch(/\son[a-z]+\s*=\s*["']/i)
      expect(source).not.toMatch(/href\s*=/i)
      expect(source).not.toMatch(/url\((?!#)/)
    }
  })

  test('labels cannot inject markup', () => {
    const doc = applyOps(emptyDoc(), [
      { op: 'add_node', id: 'x', label: '<script>alert(1)</script>', type: 'step', note: '" onload="evil()' },
      { op: 'add_node', id: 'y', label: 'a & b </text><image href="http://x"/>', type: 'actor' },
      { op: 'connect', from: 'x', to: 'y', label: '<b onclick="x">' },
    ]).doc
    const { source } = draw(doc.boards.main!)
    expect(xmlProblem(source)).toBeNull()
    expect(source).not.toMatch(/<script/i)
    expect(source).not.toMatch(/<image/i)
    expect(source).not.toMatch(/\son[a-z]+\s*=\s*["']/i)
    expect(source).toContain('&lt;script&gt;')
  })

  test('10, 20 and 30 node boards stay under the limit at full quality', () => {
    for (const n of [10, 20, 30]) {
      const r = draw(boardFrom(bigOps(n)))
      expect(r.quality).toBe('full')
      expect(r.source.length).toBeLessThan(SVG_LIMIT)
      expect(xmlProblem(r.source)).toBeNull()
    }
    const big = draw(boardFrom(bigOps(45)))
    expect(big.quality).not.toBe('full')
    expect(big.source.length).toBeLessThanOrEqual(SVG_LIMIT)
  })

  test('the budget degrades step by step and never goes over', () => {
    const board = boardFrom(bigOps(20))
    const full = draw(board).source.length
    const single = draw(board, { quality: 'single' }).source.length
    const clean = draw(board, { quality: 'clean' }).source.length
    expect(single).toBeLessThan(full)
    expect(clean).toBeLessThan(single)
    expect(draw(board, { limit: full - 1 }).quality).toBe('single')
    expect(draw(board, { limit: single - 1 }).quality).toBe('clean')
    const fb = draw(board, { limit: clean - 1 })
    expect(fb.quality).toBe('fallback')
    expect(fb.source.length).toBeLessThan(clean)
    expect(xmlProblem(fb.source)).toBeNull()
  })

  test('deterministic, and a node keeps its outline when another node changes', () => {
    const ops = SAMPLES[1]!.ops
    const a = draw(boardFrom(ops)).source
    expect(draw(boardFrom(ops)).source).toBe(a)
    let doc = applyOps(emptyDoc(), ops).doc
    const p = placeNew(doc.boards.request!, undefined)
    const before = renderRich(doc.boards.request!, p, ROOM).source
    doc = applyOps(doc, [{ op: 'update_node', id: 'cdn', label: 'Edge CDN', note: 'cached assets' }]).doc
    const after = renderRich(doc.boards.request!, p, ROOM).source
    const shape = (src: string, id: string) => nodeMarkup(src, id).match(/<g class="shape"[\s\S]*?<\/g>/)![0]
    expect(shape(after, 'db')).toBe(shape(before, 'db'))
    expect(shape(after, 'cdn')).not.toBe(shape(before, 'cdn'))
    expect(hash('db')).toBe(hash('db'))
    expect(hash('db')).toBeGreaterThan(0)
    expect(hash('db')).toBeLessThanOrEqual(100000)
  })

  test('only recent ids get the animation classes', () => {
    const board = boardFrom(SAMPLES[0]!.ops)
    const quiet = draw(board).source
    expect(quiet).not.toMatch(/class="node [a-z]+ [a-z]+ (new|hl)/)
    expect(quiet).not.toContain('class="bychip"')
    const lively = draw(board, { recent: { ids: ['mic', 'stt', 'mic->stt'], added: ['stt', 'mic->stt'] } }).source
    expect(nodeMarkup(lively, 'stt')).toContain('class="node system confirmed new hl"')
    expect(nodeMarkup(lively, 'mic')).toContain('class="node system confirmed hl"')
    expect(nodeMarkup(lively, 'web')).toContain('class="node system confirmed"')
    expect(lively).toContain('class="edge confirmed new hl" data-id="mic-&gt;stt"')
    expect(lively.match(/class="bychip"/g)).toHaveLength(2)
  })

  test('the still version (terminal PNG): no animation, a steady highlight, a pixel size', () => {
    const board = boardFrom(SAMPLES[0]!.ops)
    const recent = { ids: ['mic', 'stt', 'mic->stt'], added: ['stt'] }
    const still = draw(board, { recent, isStatic: true })
    expect(xmlProblem(still.source)).toBeNull()
    expect(still.source).not.toContain('@keyframes')
    expect(still.source).not.toContain('animation')
    expect(still.source).not.toContain(':hover')
    expect(still.source).toContain('.node.hl .halo{opacity:.5')
    expect(still.source.match(/class="bychip"/g)).toHaveLength(2)
    expect(still.source).toMatch(new RegExp(`^<svg [^>]*width="${Math.ceil(still.width)}" height="${Math.ceil(still.height)}"`))
    // the same drawing as the animated one, only the styles differ
    const lively = draw(board, { recent })
    expect(still.width).toBe(lively.width)
    expect(nodeMarkup(still.source, 'stt')).toBe(nodeMarkup(lively.source, 'stt'))
  })

  test('the drawing fits the room and keeps its direction', () => {
    const chain = boardFrom([
      { op: 'new_board', id: 'chain', title: 'Chain' },
      ...['a', 'b', 'c', 'd', 'e'].map(id => ({ op: 'add_node', id, label: id.toUpperCase(), type: 'step' })),
      ...['a', 'b', 'c', 'd'].map((id, i) => ({ op: 'connect', from: id, to: 'bcde'[i]! })),
    ])
    expect(draw(chain, { maxWidth: 1600, maxHeight: 300 }).dir).toBe('LR')
    expect(draw(chain, { maxWidth: 400, maxHeight: 1600 }).dir).toBe('TB')
    // within 85% the last direction stays
    expect(chooseRichDir({ w: 1000, h: 200 }, { w: 200, h: 1100 }, 1000, 1000, 'TB')).toBe('TB')
    expect(chooseRichDir({ w: 1000, h: 200 }, { w: 200, h: 1100 }, 1000, 1000)).toBe('LR')
    expect(chooseRichDir({ w: 1000, h: 200 }, { w: 200, h: 2000 }, 1000, 1000, 'TB')).toBe('LR')
    const r = draw(chain, { maxWidth: 1600, maxHeight: 300 })
    const vb = r.source.match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/)!
    expect(Number(vb[3])).toBe(r.width)
    expect(Number(vb[4])).toBe(r.height)
  })
})
