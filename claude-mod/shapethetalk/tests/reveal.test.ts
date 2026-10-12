import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { DBoard } from '../types'
import { applyOps, emptyDoc } from '../hooks/board.ts'
import { GRACE_MS, SPEEDS, advance, duration, hiddenIds, nextDelay, recentOf, revealOrder, schedule, startReveal, visibleBoard } from '../hooks/reveal.ts'
import { LIVE_DATA } from '../hooks/live.ts'
import { UPDATE_DESCRIPTION } from '../hooks/tools.ts'

const UPDATE = 'mcp__shapethetalk__update_diagram'
const GET = 'mcp__shapethetalk__get_diagram'

/** A board from ops, and the ids the last call added (in op order). */
function built(...calls: unknown[][]): { board: DBoard; added: string[]; changed: string[] } {
  let doc = emptyDoc()
  let added: string[] = []
  let changed: string[] = []
  for (const ops of calls) {
    const r = applyOps(doc, ops)
    doc = r.doc
    added = r.added
    changed = r.changed
  }
  return { board: doc.boards[doc.active!]!, added, changed }
}

const n = (id: string, type = 'system') => ({ op: 'add_node', id, label: id.toUpperCase(), type })
const c = (from: string, to: string) => ({ op: 'connect', from, to })

describe('reveal order', () => {
  test('follows the flow: a node, then its incoming edges, the newest chain first', () => {
    // the nodes sent in a jumbled order: the branch first, the entry point last
    const { board, added } = built([n('d'), n('c'), n('b'), n('a', 'actor'), c('a', 'b'), c('b', 'c'), c('a', 'd')])
    const order = revealOrder(board, added)
    const ids = order.map(it => it.id)
    expect(new Set(ids)).toEqual(new Set(added))
    // the entry point first (a root), then the chain a -> b -> c before the branch d
    expect(ids).toEqual(['a', 'b', 'a->b', 'c', 'b->c', 'd', 'a->d'])
    // never an edge before both of its ends
    const seen = new Set<string>()
    for (const it of order) {
      if (it.kind === 'edge') {
        const e = board.edges[it.id]!
        expect(seen.has(e.from) && seen.has(e.to)).toBe(true)
      }
      seen.add(it.id)
    }
  })

  test('nodes already on the board count as drawn; edges between them come first', () => {
    const { board, added } = built([n('x'), n('y')], [n('z'), c('y', 'z'), c('x', 'y'), c('z', 'x')])
    expect(revealOrder(board, added)).toEqual([
      { id: 'x->y', kind: 'edge' },
      { id: 'z', kind: 'node' },
      { id: 'y->z', kind: 'edge' },
      { id: 'z->x', kind: 'edge' },
    ])
  })

  test('a cycle of new nodes still reveals all of them, in op order', () => {
    const { board, added } = built([n('p'), n('q'), c('p', 'q'), c('q', 'p')])
    expect(revealOrder(board, added).map(it => it.id)).toEqual(['p', 'q', 'p->q', 'q->p'])
  })
})

describe('reveal timing', () => {
  const items = [
    { id: 'a', kind: 'node' as const },
    { id: 'b', kind: 'node' as const },
    { id: 'a->b', kind: 'edge' as const },
    { id: 'c', kind: 'node' as const },
  ]
  test('the first at once, then 600 ms a node and 300 ms an edge (normal)', () => {
    expect(schedule(items, 'normal')).toEqual([0, 600, 300, 600])
    expect(duration(items, 'normal')).toBe(1500)
    expect(schedule(items, 'slow')).toEqual([0, 1000, 500, 1000])
    expect(schedule(items, 'fast')).toEqual([0, 300, 150, 300])
    expect(SPEEDS.off).toEqual({ node: 0, edge: 0 })
  })

  test('a run steps through the queue; the chip follows the newest node; each step its own seq', () => {
    const { board, added, changed } = built([n('a', 'actor'), n('b'), c('a', 'b'), n('c', 'data'), c('b', 'c')])
    let r = startReveal(board, added, changed, { seq: 1, now: 1000, speed: 'normal' })!
    expect(r.shown).toEqual(['a'])
    expect(r.queue.map(it => it.id)).toEqual(['b', 'a->b', 'c', 'b->c'])
    expect(r.until).toBe(1000 + 600 + 300 + 600 + 300)
    const delays: (number | null)[] = []
    const seqs = new Set<number>()
    const chips: (string | null)[] = []
    while (r.queue.length) {
      delays.push(nextDelay(r))
      r = advance(r)
      seqs.add(recentOf(r).seq)
      chips.push(recentOf(r).newest)
    }
    expect(delays).toEqual([600, 300, 600, 300])
    expect(nextDelay(r)).toBeNull()
    expect(advance(r)).toBe(r)
    expect(seqs.size).toBe(4)
    expect(chips).toEqual(['b', 'b', 'c', 'c'])
    expect(recentOf(r).ids).toEqual(['a', 'b', 'a->b', 'c', 'b->c'])
    expect(recentOf(r).step).toEqual(['b->c'])
  })

  test('speed off, or a single new element: nothing to stagger', () => {
    const big = built([n('a'), n('b'), c('a', 'b')])
    expect(startReveal(big.board, big.added, big.changed, { seq: 1, now: 0, speed: 'off' })).toBeNull()
    const one = built([n('a')], [n('b')])
    expect(startReveal(one.board, one.added, one.changed, { seq: 2, now: 0, speed: 'normal' })).toBeNull()
  })

  test('fast-forward: what an unfinished run hid shows with the next run\'s first step', () => {
    const { board, added, changed } = built([n('a'), n('b'), c('a', 'b')], [n('c'), n('d'), c('c', 'd'), { op: 'update_node', id: 'a', label: 'A2' }])
    const r = startReveal(board, added, changed, { seq: 3, now: 0, speed: 'normal' }, ['b', 'a->b', 'gone'])!
    expect(r.shown).toEqual(['b', 'a->b', 'c'])
    expect(r.step).toEqual(['b', 'a->b', 'c'])
    expect(r.changed).toEqual(['a'])
    expect(recentOf(r).step).toEqual(['a', 'b', 'a->b', 'c'])
    expect(hiddenIds(r, board.id, 0, true)).toEqual(new Set(['d', 'c->d']))
  })

  test('self-heal: nothing stays hidden when the run is not driven, is about another board, or overran', () => {
    const { board, added, changed } = built([n('a'), n('b'), c('a', 'b')])
    const r = startReveal(board, added, changed, { seq: 1, now: 0, speed: 'normal' })!
    expect(hiddenIds(r, board.id, 0, true)).toEqual(new Set(['b', 'a->b']))
    expect(hiddenIds(r, board.id, 0, false).size).toBe(0)
    expect(hiddenIds(r, 'other', 0, true).size).toBe(0)
    expect(hiddenIds(r, board.id, r.until + GRACE_MS, true).size).toBe(2)
    expect(hiddenIds(r, board.id, r.until + GRACE_MS + 1, true).size).toBe(0)
    expect(hiddenIds(null, board.id, 0, true).size).toBe(0)
  })

  test('the drawn board drops hidden nodes and every edge touching one', () => {
    const { board } = built([n('a'), n('b'), n('c'), c('a', 'b'), c('b', 'c')])
    const v = visibleBoard(board, new Set(['c']))
    expect(Object.keys(v.nodes)).toEqual(['a', 'b'])
    expect(Object.keys(v.edges)).toEqual(['a->b'])
    expect(visibleBoard(board, new Set())).toBe(board)
  })
})

describe('tool description', () => {
  test('asks for small steps and stays under the 2,048-character limit', () => {
    expect(UPDATE_DESCRIPTION.length).toBeLessThanOrEqual(2048)
    expect(UPDATE_DESCRIPTION).toContain('1-3 nodes')
    expect(UPDATE_DESCRIPTION).toContain('Never send the whole board in one call')
  })
})

// ------------------------------------------------------------------ in the plugin

const TMP = '/var/folders/xx/T'
const DIR = `${TMP}/shapethetalk-sess-1`
const PANE = {
  component: 'Pane',
  requestId: 'diagram',
  props: { title: 'Diagram', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 50 }, view: {} },
} as const
const diagram = (args: string) =>
  ({ command: 'diagram', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

function host(on: On) {
  const clock = mock.clock(on)
  mock.env(on, { TMPDIR: `${TMP}/` })
  const files = new Map<string, string>()
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', () => ({ value: false }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  return { clock, files }
}

const FLOW = [
  { op: 'new_board', id: 'web', title: 'Web request' },
  n('user', 'actor'),
  n('browser'),
  n('server'),
  n('db', 'data'),
  c('user', 'browser'),
  c('browser', 'server'),
  c('server', 'db'),
]

/** The node and edge ids drawn in an SVG. */
const drawn = (svg: string) => [...svg.matchAll(/class="(node|edge) [^"]*" data-id="([^"]+)"/g)].map(m => m[2]!.replace('&gt;', '>'))
const svgNow = async (ui: { find: (q: { type: string }) => Promise<{ props: Record<string, unknown> } | undefined> }) =>
  String((await ui.find({ type: 'Svg' }))!.props.source)
const call = async ($: Engine, ops: unknown) => String((await $.tool.call({ tool: UPDATE, ops })).result)

describe('staggered reveal in the plugin', () => {
  test('the pane gains one element per step; get_diagram has everything at once', async ($, on) => {
    const { clock } = host(on)
    const text = await call($, FLOW)
    expect(text).toContain('applied 8 ops')
    expect(text).not.toContain('smaller steps')
    // the truth is there at once
    const json = JSON.parse(String((await $.tool.call({ tool: GET })).result))
    expect(json.boards[0].nodes).toHaveLength(4)

    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'desktop', ...PANE })
    let svg = await svgNow(ui)
    expect(drawn(svg)).toEqual(['user'])
    expect(svg).toContain('class="node actor confirmed new hl" data-id="user"')
    expect(svg).toContain('data-key="chip-user"')

    await clock.advance(1000) // browser (slow, the default)
    await ui.redraw()
    svg = await svgNow(ui)
    expect(drawn(svg).sort()).toEqual(['browser', 'user'])
    // only the latest step pops in (a new source restarts every animation in it); the chip moved
    expect(svg).toContain('class="node system confirmed new hl" data-id="browser"')
    expect(svg).toContain('class="node actor confirmed" data-id="user"')
    expect(svg).toContain('data-key="chip-browser"')
    expect(svg).not.toContain('data-key="chip-user"')

    await clock.advance(500) // user->browser
    await ui.redraw()
    svg = await svgNow(ui)
    expect(drawn(svg).sort()).toEqual(['browser', 'user', 'user->browser'])
    expect(svg).toContain('class="edge confirmed new hl" data-id="user-&gt;browser"')
    expect(svg).toContain('data-key="chip-browser"')

    await clock.advance(1000 + 500 + 1000 + 500)
    await ui.redraw()
    expect(drawn(await svgNow(ui)).sort()).toEqual(['browser', 'browser->server', 'db', 'server', 'server->db', 'user', 'user->browser'])
    await ui.unmount()
  })

  test('live look: board.js is rewritten on each step and gains elements over time', async ($, on) => {
    const { clock, files } = host(on)
    await $.command.run(diagram('look live')) // no terminal-browser here: the files are still kept current
    await call($, FLOW)
    const ids = () => {
      const js = files.get(`${DIR}/${LIVE_DATA}`)!
      return drawn(JSON.parse(/\((.*)\);\n$/s.exec(js)![1]!).svg)
    }
    const counts = [ids().length]
    const chips: string[] = []
    for (let i = 0; i < 6; i++) {
      await clock.advance(1000)
      counts.push(ids().length)
      chips.push(/data-key=\\"chip-([^\\"]+)/.exec(files.get(`${DIR}/${LIVE_DATA}`)!)?.[1] ?? '')
    }
    expect(counts[0]).toBe(1)
    expect(counts[counts.length - 1]).toBe(7)
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!)
    // the page keeps everything shown so far animated (it patches its DOM in place): all carry the classes
    const js = files.get(`${DIR}/${LIVE_DATA}`)!
    expect(js).toContain('class=\\"node actor confirmed new hl\\" data-id=\\"user\\"')
    // one chip, on the newest node
    expect(chips[chips.length - 1]).toBe('db')
    expect(js.match(/data-key=\\"chip-/g)).toHaveLength(1)
  })

  test('a new call fast-forwards the running reveal; nothing is lost', async ($, on) => {
    const { clock } = host(on)
    await call($, FLOW)
    await clock.advance(1000)
    // a correction mid-reveal: the rest of the first call shows at once with it
    await call($, [n('cache', 'data'), c('server', 'cache')])
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'desktop', ...PANE })
    let svg = await svgNow(ui)
    expect(drawn(svg).sort()).toEqual(['browser', 'browser->server', 'cache', 'db', 'server', 'server->db', 'user', 'user->browser'])
    await clock.advance(500)
    await ui.redraw()
    svg = await svgNow(ui)
    expect(drawn(svg)).toContain('server->cache')
    await ui.unmount()
  })

  test('/diagram speed off draws each call whole; a big call is nudged toward smaller steps', async ($, on) => {
    host(on)
    expect((await $.command.run(diagram('speed'))).text).toContain('slow (a node every 1000 ms, an edge every 500 ms)')
    expect((await $.command.run(diagram('speed warp'))).text).toContain('Not a speed')
    expect((await $.command.run(diagram('speed off'))).text).toContain('off')
    const text = await call($, [...FLOW, n('cache', 'data'), c('server', 'cache')])
    expect(text).toContain('this call added 5 nodes at once. Next time add this in smaller steps while you explain')
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'desktop', ...PANE })
    expect(drawn(await svgNow(ui))).toHaveLength(9)
    await ui.unmount()
  })

  test('self-heal: a session start (a reload or restart) shows the whole board', async ($, on) => {
    host(on)
    // what the engine does beneath a session start (the kit's own one ran before the test)
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('tool.register', (_$, e) => ({ value: { tool: `mcp__shapethetalk__${e.name}` } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('ui.panes', () => ({ value: [] }))
    await call($, FLOW)
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'desktop', ...PANE })
    expect(drawn(await svgNow(ui))).toHaveLength(1)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await ui.redraw()
    expect(drawn(await svgNow(ui))).toHaveLength(7)
    await ui.unmount()
  })

  test('terminal grid: the header counts what is drawn so far', async ($, on) => {
    const { clock } = host(on)
    await $.command.run(diagram('look grid'))
    await call($, FLOW)
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /Web request · 1 nodes · 0 edges/ })).toBeDefined()
    await clock.advance(5000)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /Web request · 4 nodes · 3 edges/ })).toBeDefined()
    await ui.unmount()
  })
})
