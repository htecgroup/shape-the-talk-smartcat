import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PIPELINE } from '../scripts/samples.ts'

const UPDATE = 'mcp__shapethetalk__update_diagram'
const GET = 'mcp__shapethetalk__get_diagram'

const PANE = (bodyColumns: number, bodyRows: number) =>
  ({
    component: 'Pane',
    requestId: 'diagram',
    props: {
      title: 'Diagram',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows },
      view: {},
    },
  }) as const

/** Stand in for the engine beneath the plugin: the clock, and panes that open. */
function engine(on: On) {
  const clock = mock.clock(on)
  const opened: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  return { opened, clock }
}

const diagram = (args: string) =>
  ({ command: 'diagram', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

async function callUpdate($: Engine, ops: unknown): Promise<string> {
  const ran = await $.tool.call({ tool: UPDATE, ops })
  expect(ran.deny).toBeUndefined()
  return String(ran.result)
}

describe('tools', () => {
  test('update_diagram applies ops and reports rejects', async ($, on) => {
    const { opened } = engine(on)
    const text = await callUpdate($, [
      { op: 'add_node', id: 'a', label: 'A', type: 'system' },
      { op: 'add_node', id: 'b', label: 'B', type: 'nope' },
      { op: 'connect', from: 'a', to: 'ghost' },
    ])
    expect(text).toContain('applied 1 ops, rejected 2:')
    expect(text).toContain('- ops[1] add_node b: unknown type "nope"')
    expect(text).toContain('- ops[2] connect a->ghost: unknown node "ghost"')
    expect(text).toContain('a (system) "A"')
    expect(opened).toEqual(['diagram'])
    await callUpdate($, [{ op: 'add_node', id: 'c', label: 'C', type: 'step' }])
    expect(opened).toEqual(['diagram'])
  })

  test('get_diagram returns compact JSON', async ($, on) => {
    engine(on)
    await callUpdate($, PIPELINE)
    const ran = await $.tool.call({ tool: GET })
    const json = JSON.parse(String(ran.result))
    expect(json.active).toBe('pipeline')
    expect(json.boards[0].active).toBe(true)
    expect(json.boards[0].nodes.map((n: { id: string }) => n.id)).toContain('extractor')
    expect(json.boards[0].edges.map((e: { id: string }) => e.id)).toContain('mic->stt')
  })

  test('undo_last reverts the previous call', async ($, on) => {
    engine(on)
    await callUpdate($, [{ op: 'add_node', id: 'a', label: 'A', type: 'step' }])
    await callUpdate($, [{ op: 'add_node', id: 'b', label: 'B', type: 'step' }])
    const text = await callUpdate($, [{ op: 'undo_last' }])
    expect(text).toContain('applied 1 ops, rejected 0.')
    const json = JSON.parse(String((await $.tool.call({ tool: GET })).result))
    expect(json.boards[0].nodes.map((n: { id: string }) => n.id)).toEqual(['a'])
  })

  test('malformed ops are answered, not thrown', async ($, on) => {
    engine(on)
    expect(await callUpdate($, 'not json')).toContain('not valid JSON')
    expect(await callUpdate($, { nope: true })).toContain('ops must be an array')
    expect(await callUpdate($, [null, 3, { op: 'add_node' }])).toContain('rejected 3')
    expect(await callUpdate($, JSON.stringify([{ op: 'add_node', id: 'x', label: 'X', type: 'data' }]))).toContain('applied 1 ops')
  })
})

describe('pane', () => {
  test('terminal: a Raster, and a tab press switches boards', async ($, on) => {
    engine(on)
    await callUpdate($, PIPELINE)
    await callUpdate($, [
      { op: 'new_board', id: 'second', title: 'Second' },
      { op: 'add_node', id: 'x', label: 'X', type: 'actor' },
    ])
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE(100, 40) })
    const raster = await ui.find({ type: 'Raster' })
    expect(raster).toBeDefined()
    expect(Number(raster!.props.columns)).toBeLessThanOrEqual(100)
    expect(typeof raster!.props.cells).toBe('string')
    expect((await ui.find({ type: 'Text', text: /Second · 1 nodes/ }))).toBeDefined()
    await ui.press({ key: 'tab-pipeline' })
    expect(await ui.find({ type: 'Text', text: /ShapeTheTalk pipeline · 10 nodes/ })).toBeDefined()
    const json = JSON.parse(String((await $.tool.call({ tool: GET })).result))
    expect(json.active).toBe('pipeline')
    await ui.unmount()
  })

  test('desktop: an image Svg under the limit, tabs, pop-in classes and zoom', async ($, on) => {
    engine(on)
    await callUpdate($, PIPELINE)
    await callUpdate($, [
      { op: 'new_board', id: 'second', title: 'Second' },
      { op: 'add_node', id: 'x', label: 'X', type: 'actor' },
    ])
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'desktop', ...PANE(80, 50) })
    let svg = (await ui.find({ type: 'Svg' }))!
    expect(svg).toBeDefined()
    expect(svg.props.isInteractive).toBeUndefined()
    expect(String(svg.props.source).length).toBeLessThanOrEqual(131072)
    expect(String(svg.props.alt)).toContain('x (actor) "X"')

    await ui.press({ key: 'tab-pipeline' })
    svg = (await ui.find({ type: 'Svg' }))!
    expect(String(svg.props.source)).toContain('data-id="extractor"')

    // a new node pops in
    await callUpdate($, [
      { op: 'add_node', id: 'store', label: 'Recording', type: 'data' },
      { op: 'connect', from: 'stt', to: 'store' },
    ])
    svg = (await ui.find({ type: 'Svg' }))!
    const source = String(svg.props.source)
    expect(source).toContain('class="node data confirmed new hl" data-id="store"')
    expect(source).not.toContain('class="node system confirmed new hl" data-id="web"')

    // zoom changes the size, never the source
    const w0 = Number(svg.props.width)
    await ui.press({ key: 'zoom-in' })
    const zin = (await ui.find({ type: 'Svg' }))!
    expect(Number(zin.props.width)).toBeGreaterThan(w0)
    expect(zin.props.source).toBe(source)
    await ui.press({ key: 'zoom-out' })
    await ui.press({ key: 'zoom-out' })
    const zout = (await ui.find({ type: 'Svg' }))!
    expect(Number(zout.props.width)).toBeLessThan(w0)
    expect(zout.props.source).toBe(source)
    await ui.press({ key: 'zoom-100' })
    expect(Number((await ui.find({ type: 'Svg' }))!.props.width)).toBe(w0)
    await ui.press({ key: 'zoom-fit' })
    expect(Number((await ui.find({ type: 'Svg' }))!.props.width)).toBeLessThanOrEqual(80 * 7.8)
    await ui.unmount()
  })

  test('the highlight clears 5 s after the last update', async ($, on) => {
    const { clock } = engine(on)
    await callUpdate($, PIPELINE)
    // let the staggered reveal of the big first call finish (and its highlight fade)
    await clock.advance(30000)
    await callUpdate($, [{ op: 'update_node', id: 'web', label: 'Whiteboard' }])
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'desktop', ...PANE(80, 50) })
    expect(String((await ui.find({ type: 'Svg' }))!.props.source)).toContain('class="node system confirmed hl" data-id="web"')
    await clock.advance(5000)
    await ui.redraw()
    const after = String((await ui.find({ type: 'Svg' }))!.props.source)
    expect(after).toContain('class="node system confirmed" data-id="web"')
    expect(after).not.toContain('class="bychip"')
    await ui.unmount()
  })
})

describe('/diagram', () => {
  test('list, switch, tidy and clear', async ($, on) => {
    engine(on)
    await callUpdate($, PIPELINE)
    await callUpdate($, [{ op: 'new_board', id: 'second', title: 'Second' }, { op: 'add_node', id: 'x', label: 'X', type: 'step' }])
    const list = await $.command.run(diagram('list'))
    expect(list.text).toContain('  pipeline: ShapeTheTalk pipeline (10 nodes, 9 edges)')
    expect(list.text).toContain('* second: Second (1 nodes, 0 edges)')
    const sw = await $.command.run(diagram('ShapeTheTalk pipeline'))
    expect(sw.text).toContain('Switched to "ShapeTheTalk pipeline"')
    expect(sw.context?.[0]).toContain('"pipeline"')
    expect(JSON.parse(String((await $.tool.call({ tool: GET })).result)).active).toBe('pipeline')
    expect((await $.command.run(diagram('tidy'))).text).toContain('Tidied')
    expect((await $.command.run(diagram('nope'))).text).toContain('No board "nope"')
    const clear = await $.command.run(diagram('clear'))
    expect(clear.context?.[0]).toContain('every ShapeTheTalk board is gone')
    expect(JSON.parse(String((await $.tool.call({ tool: GET })).result)).boards).toEqual([])
  })
})
