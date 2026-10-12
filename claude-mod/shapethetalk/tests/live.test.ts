import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { fullLayout } from '../hooks/layout.ts'
import { LIVE_DATA, LIVE_PAGE, liveData, liveHtml } from '../hooks/live.ts'
import type { LiveBoard } from '../hooks/live.ts'
import { renderRich } from '../hooks/rich.ts'
import { PIPELINE, SAMPLES, boardFrom } from '../scripts/samples.ts'
import { xmlProblem } from './xml.ts'

const UPDATE = 'mcp__shapethetalk__update_diagram'
const TMP = '/var/folders/xx/T'
const DIR = `${TMP}/shapethetalk-sess-1`

const diagram = (args: string) =>
  ({ command: 'diagram', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

const PANE = {
  component: 'Pane',
  requestId: 'diagram',
  props: { title: 'Diagram', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

function board(): LiveBoard {
  const b = boardFrom(SAMPLES[0]!.ops)
  const ids = Object.keys(b.nodes)
  const rich = renderRich(b, fullLayout(b), { maxWidth: 1100, maxHeight: 900, recent: { ids: [ids[0]!], added: [ids[0]!] }, tooltips: true })
  return { v: '7-abc', title: 'Pipe <&> line', svg: rich.source, width: rich.width, height: rich.height }
}

/** The SVG inside the page's #board div. */
const svgOf = (html: string) => {
  const from = html.indexOf('<div id="board">') + '<div id="board">'.length
  return html.slice(from, html.indexOf('</svg>', from) + '</svg>'.length)
}

describe('live page', () => {
  test('well-formed, holds the interactive SVG, reads nothing but board.js beside it', () => {
    const b = board()
    const html = liveHtml(b)
    expect(html.startsWith('<!doctype html><html><head><meta charset="utf-8">')).toBe(true)
    expect(html.endsWith('</script></body></html>')).toBe(true)
    // the board inline, as XML, with its animation, hover style and tooltips
    const svg = svgOf(html)
    expect(svg).toBe(b.svg)
    expect(xmlProblem(svg)).toBeNull()
    expect(svg).toContain('@keyframes')
    expect(svg).toContain(':hover')
    expect(svg).toMatch(/<g class="node [^"]*" data-id="[^"]+" transform="[^"]+"><title>[^<]+<\/title>/)
    expect(svg).toMatch(/<g class="edge [^"]*" data-id="[^"]+"><title>[^<]+→[^<]+<\/title>/)
    // the title escaped in markup; the initial JSON cannot end its <script>
    expect(html).toContain('<title>Pipe &lt;&amp;&gt; line · ShapeTheTalk</title>')
    const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'))
    expect(script).not.toContain('</')
    expect(html.match(/<script>/g)).toHaveLength(1)
    // no external resources: no src or href but in-document fragments, no http(s) url but the SVG namespace
    expect(html).not.toMatch(/\s(src|href)="(?!#)/)
    expect(html.replaceAll('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/@import|<link|<iframe|<img/)
    // the only file it loads: board.js, polled with a fresh query
    expect(html).toContain(`s.src='${LIVE_DATA}?t='+Date.now()`)
    expect(html).toContain('setInterval(poll,250)')
  })

  test('board.js is one call with the board as JSON', () => {
    const b = board()
    const js = liveData(b)
    const m = /^window\.__shapethetalk&&window\.__shapethetalk\((.*)\);\n$/s.exec(js)
    expect(m).not.toBeNull()
    expect(JSON.parse(m![1]!)).toEqual(b)
  })
})

const RUN_OK = { isStdoutTruncated: false, isStderrTruncated: false, stderr: '' }

/**
 * The engine beneath the plugin. `browser` picks what `terminal-browser` on PATH
 * does: 'missing' (the command cannot start: $.process.run rejects), 'old' (no
 * embedding capability) or 'ok' (capabilities, then a bridge on port 4321).
 */
function host(on: On, browser: 'missing' | 'old' | 'ok' = 'missing', env: Record<string, string> = { TERM_PROGRAM: 'ghostty' }, gate?: Promise<void>) {
  const clock = mock.clock(on)
  mock.env(on, { TMPDIR: `${TMP}/`, ...env })
  const files = new Map<string, string>()
  const opened: string[] = []
  const closed: string[] = []
  const runs: string[] = []
  const posts: { url: string; body: unknown }[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', () => ({ value: false }))
  on('process.run', async (_$, e) => {
    runs.push(e.argv.join(' '))
    if (e.argv[0] === 'terminal-browser') {
      if (gate && e.argv[1] === 'capabilities') await gate
      if (browser === 'missing') return { deny: 'spawn terminal-browser ENOENT' }
      if (e.argv[1] === 'capabilities') {
        const caps = browser === 'ok' ? ['embedding', 'image-frames'] : ['embedding']
        return { value: { ...RUN_OK, exitCode: 0, stdout: `${JSON.stringify({ capabilities: caps })}\n` } }
      }
      if (e.argv[1] === 'claude-bridge') return { value: { ...RUN_OK, exitCode: 0, stdout: '{"port":4321,"token":"tok"}\n' } }
    }
    return { value: { ...RUN_OK, exitCode: 1, stdout: '' } }
  })
  // the bridge: posts recorded; /state is not ready, so its watch waits on the (held) clock
  on('http.fetch', (_$, e) => {
    if (e.init?.method === 'POST') posts.push({ url: e.url, body: JSON.parse(String(e.init.body ?? '{}')) })
    return { value: { status: e.init?.method === 'POST' ? 200 : 503, ok: e.init?.method === 'POST', headers: {}, text: '{}' } }
  })
  return { clock, files, opened, closed, runs, posts }
}

describe('/diagram look live', () => {
  test('without terminal-browser on PATH: says brew install, keeps the page current, the pane shows the picture look', async ($, on) => {
    const { files, runs } = host(on, 'missing')
    expect((await $.tool.call({ tool: UPDATE, ops: PIPELINE })).deny).toBeUndefined()
    const reply = (await $.command.run(diagram('look live'))).text ?? ''
    expect(reply).toContain('Live look unavailable')
    expect(reply).toContain('terminal-browser is not installed')
    expect(reply).toContain('brew install terminal-browser')
    expect(reply).not.toContain('vendor-terminal-browser-plugin')
    expect(runs).toContain('terminal-browser capabilities')
    expect((await $.command.run(diagram('look'))).text).toContain('look is live')

    // the page and its data were written anyway
    const page = files.get(`${DIR}/${LIVE_PAGE}`)!
    expect(page).toContain('<svg')
    const data1 = files.get(`${DIR}/${LIVE_DATA}`)!
    expect(data1).toContain('__shapethetalk(')

    // the pane: the orange note with the install hint, and the picture look's path
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE })
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /Live look needs terminal-browser \(brew install terminal-browser\)/ })).toBeDefined()
    await ui.unmount()

    // a change rewrites board.js with a new version, without asking for the browser again
    const asked = runs.length
    expect((await $.tool.call({ tool: UPDATE, ops: [{ op: 'add_node', id: 'audit', label: 'Audit log', type: 'data' }] })).deny).toBeUndefined()
    const data2 = files.get(`${DIR}/${LIVE_DATA}`)!
    expect(data2).not.toBe(data1)
    expect(data2).toContain('Audit log')
    const v = (js: string) => JSON.parse(/\((.*)\);\n$/s.exec(js)![1]!).v
    expect(v(data2)).not.toBe(v(data1))
    expect(runs.slice(asked).filter(r => r.startsWith('terminal-browser'))).toEqual([])

    // back to another look: nothing to close, and board.js is left alone from then on
    expect((await $.command.run(diagram('look auto'))).text).toContain('auto')
    await $.tool.call({ tool: UPDATE, ops: [{ op: 'add_node', id: 'later', label: 'Later', type: 'step' }] })
    expect(files.get(`${DIR}/${LIVE_DATA}`)).toBe(data2)
  })

  test('an old terminal-browser: says to upgrade, and the pane notes it', async ($, on) => {
    host(on, 'old')
    await $.tool.call({ tool: UPDATE, ops: PIPELINE })
    const reply = (await $.command.run(diagram('look live'))).text ?? ''
    expect(reply).toContain('terminal-browser upgrade')
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE })
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /Live look unavailable \(Newer terminal-browser/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('/diagram look live with terminal-browser (vendored pane)', () => {
  test('opens the page in the browser pane once, keeps it current, closes it on another look', async ($, on) => {
    const { files, opened, closed, runs, posts } = host(on, 'ok')
    // the board drawn in another look first (auto would open the page by itself here)
    await $.command.run(diagram('look grid'))
    await $.tool.call({ tool: UPDATE, ops: PIPELINE })
    const reply = (await $.command.run(diagram('look live'))).text ?? ''
    const url = `file://${DIR}/${LIVE_PAGE}`
    expect(reply).toContain(`Opened ${url}`)
    // the bridge started once, the browser pane opened, and the diagram pane closed
    expect(runs.filter(r => r.startsWith('terminal-browser'))).toEqual(['terminal-browser capabilities', 'terminal-browser claude-bridge launch'])
    expect(opened.filter(id => id === 'browser')).toHaveLength(1)
    expect(closed).toContain('diagram')

    // the pane draws the vendored surface module; its first size message sends the page to the bridge
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE, requestId: 'browser', props: { ...PANE.props, title: 'browser' } })
    await ui.redraw()
    expect(await ui.find({ type: 'Client' })).toBeDefined()
    await ui.post({ type: 'size', cols: 90, rows: 40 })
    expect(posts).toContainEqual({ url: 'http://127.0.0.1:4321/open', body: { url, cols: 90, rows: 40 } })
    await ui.unmount()

    // a change rewrites board.js; the page is not opened again
    const before = files.get(`${DIR}/${LIVE_DATA}`)
    await $.tool.call({ tool: UPDATE, ops: [{ op: 'add_node', id: 'audit', label: 'Audit log', type: 'data' }] })
    expect(files.get(`${DIR}/${LIVE_DATA}`)).not.toBe(before)
    expect(opened.filter(id => id === 'browser')).toHaveLength(1)

    // another look closes the browser pane, and the bridge hears it
    expect((await $.command.run(diagram('look image'))).text).toContain('hand-drawn picture')
    expect(closed.filter(id => id === 'browser')).toHaveLength(1)
    expect(posts.some(p => p.url === 'http://127.0.0.1:4321/browser/close')).toBe(true)
  })
})

describe('the vendored terminal-browser module', () => {
  test('/browser without terminal-browser on PATH says brew install and opens nothing', async ($, on) => {
    const { opened } = host(on, 'missing')
    expect((await $.command.run({ ...diagram(''), command: 'browser', args: 'example.com' })).text).toContain('brew install terminal-browser')
    expect(opened).not.toContain('browser')
  })

  test('/browser <url> opens the pane at the normalised url; /browser close closes it', async ($, on) => {
    const { opened, closed, posts } = host(on, 'ok')
    expect((await $.command.run({ ...diagram(''), command: 'browser', args: 'example.com/docs' })).text).toBe('Opened terminal-browser')
    expect(opened).toContain('browser')
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE, requestId: 'browser', props: { ...PANE.props, title: 'browser' } })
    await ui.redraw()
    await ui.post({ type: 'size', cols: 80, rows: 30 })
    expect(posts).toContainEqual({ url: 'http://127.0.0.1:4321/open', body: { url: 'https://example.com/docs', cols: 80, rows: 30 } })
    await ui.unmount()
    expect((await $.command.run({ ...diagram(''), command: 'browser', args: 'close' })).text).toBe('Closed terminal-browser')
    expect(closed).toContain('browser')
  })

  test('a terminal session registers /browser; the agent tools only with the agentTool option', async ($, on) => {
    host(on, 'missing')
    const commands: string[] = []
    const tools: string[] = []
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.surfaces' as never, (() => ({ value: ['terminal'] })) as never)
    on('tool.register', (_$, e) => {
      tools.push(e.name)
      return { value: { tool: `mcp__shapethetalk__${e.name}` } }
    })
    on('command.register', (_$, e) => {
      commands.push(e.name)
      return { value: { command: e.name } }
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    expect(commands).toEqual(['diagram', 'browser'])
    expect(tools).toEqual(['update_diagram', 'get_diagram'])
  })
})

/** A terminal session start, as the engine runs one beneath the plugin (its background terminal-browser check included). */
async function start($: Engine, on: On) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.surfaces' as never, (() => ({ value: ['terminal'] })) as never)
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__shapethetalk__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

const ADD = [{ op: 'add_node', id: 'audit', label: 'Audit log', type: 'data' }]

describe('the auto look (the default)', () => {
  test('Ghostty with terminal-browser: the first update opens the live page, once; /diagram close and /diagram toggle it', async ($, on) => {
    const { files, opened, closed, runs } = host(on, 'ok')
    await start($, on)
    expect(runs).toContain('terminal-browser capabilities')
    const reply = await $.tool.call({ tool: UPDATE, ops: PIPELINE })
    expect(reply.deny).toBeUndefined()
    expect(JSON.stringify(reply)).not.toContain('terminal-browser')
    // the browser pane opened on the page, the diagram pane did not
    expect(opened.filter(id => id === 'browser')).toHaveLength(1)
    expect(opened).not.toContain('diagram')
    expect(runs).toContain('terminal-browser claude-bridge launch')
    expect(files.get(`${DIR}/${LIVE_DATA}`)).toContain('__shapethetalk(')
    expect((await $.command.run(diagram('look'))).text).toContain('look is auto (live: this terminal shows images and terminal-browser is installed)')

    // the next update rewrites board.js and opens nothing
    const before = files.get(`${DIR}/${LIVE_DATA}`)
    await $.tool.call({ tool: UPDATE, ops: ADD })
    expect(files.get(`${DIR}/${LIVE_DATA}`)).not.toBe(before)
    expect(opened.filter(id => id === 'browser')).toHaveLength(1)

    // /diagram close closes the page; updates leave it closed (and open no diagram pane either)
    expect((await $.command.run(diagram('close'))).text).toBe('Live diagram closed.')
    expect(closed).toContain('browser')
    await $.tool.call({ tool: UPDATE, ops: [{ op: 'add_node', id: 'later', label: 'Later', type: 'step' }] })
    expect(opened.filter(id => id === 'browser')).toHaveLength(1)
    expect(opened).not.toContain('diagram')

    // /diagram brings the live page back (not the diagram pane), and toggles it closed again
    expect((await $.command.run(diagram(''))).text).toBe('Live diagram opened in the browser pane.')
    expect(opened.filter(id => id === 'browser')).toHaveLength(2)
    expect(opened).not.toContain('diagram')
    expect((await $.command.run(diagram(''))).text).toBe('Live diagram closed.')
  })

  test('a slow check: the first update waits for it, and only the browser pane opens (never the diagram pane first)', async ($, on) => {
    let answer = () => {}
    const gate = new Promise<void>(resolve => (answer = resolve))
    const { clock, opened } = host(on, 'ok', { TERM_PROGRAM: 'ghostty' }, gate)
    await start($, on)
    const call = $.tool.call({ tool: UPDATE, ops: PIPELINE })
    await clock.advance(1000)
    expect(opened).toEqual([])
    answer()
    expect((await call).deny).toBeUndefined()
    expect(opened).toEqual(['browser'])
  })

  test('a check slower than 2 s: the first update shows the picture rather than wait on', async ($, on) => {
    const { clock, opened } = host(on, 'ok', { TERM_PROGRAM: 'ghostty' }, new Promise<void>(() => {}))
    await start($, on)
    const call = $.tool.call({ tool: UPDATE, ops: PIPELINE })
    await clock.advance(2000)
    expect((await call).deny).toBeUndefined()
    expect(opened).toEqual(['diagram'])
  })

  test('Ghostty without terminal-browser: the picture, silently (no error in the result or the pane), checked once', async ($, on) => {
    const { files, opened, runs } = host(on, 'missing')
    await start($, on)
    const reply = await $.tool.call({ tool: UPDATE, ops: PIPELINE })
    expect(reply.deny).toBeUndefined()
    const said = JSON.stringify(reply)
    expect(said).not.toContain('terminal-browser')
    expect(said).not.toContain('brew')
    expect(opened).toContain('diagram')
    expect(opened).not.toContain('browser')
    await $.tool.call({ tool: UPDATE, ops: ADD })
    expect(runs.filter(r => r.startsWith('terminal-browser'))).toEqual(['terminal-browser capabilities'])
    // no live page files: the look is the picture
    expect(files.has(`${DIR}/${LIVE_DATA}`)).toBe(false)
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE })
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /terminal-browser|Live look|Live page/ })).toBeUndefined()
    await ui.unmount()
    expect((await $.command.run(diagram('look'))).text).toContain('look is auto (the picture: this terminal shows images; for the live page, brew install terminal-browser)')
    expect((await $.command.run(diagram(''))).text).toBe('Diagram pane closed.')
    expect((await $.command.run(diagram('open'))).text).toBe('Diagram pane opened.')
  })

  test('tmux (no images): the grid, and terminal-browser is not even asked', async ($, on) => {
    const { opened, runs } = host(on, 'ok', { TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-501/default,1,0' })
    await start($, on)
    await $.tool.call({ tool: UPDATE, ops: PIPELINE })
    expect(runs.filter(r => r.startsWith('terminal-browser'))).toEqual([])
    expect(opened).toContain('diagram')
    expect(opened).not.toContain('browser')
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Raster' })).toBeDefined()
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    await ui.unmount()
    expect((await $.command.run(diagram('look'))).text).toContain('look is auto (the grid: this terminal shows no images)')
  })

  test('explicit looks win over auto', async ($, on) => {
    const { opened, runs } = host(on, 'ok')
    await start($, on)
    expect((await $.command.run(diagram('look image'))).text).toContain('hand-drawn picture')
    await $.tool.call({ tool: UPDATE, ops: PIPELINE })
    expect(opened).toContain('diagram')
    expect(opened).not.toContain('browser')
    expect((await $.command.run(diagram('look grid'))).text).toContain('box-drawing grid')
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Raster' })).toBeDefined()
    await ui.unmount()
    expect(runs).not.toContain('terminal-browser claude-bridge launch')
    // back to auto: live again (the next update opens the page)
    expect((await $.command.run(diagram('look auto'))).text).toContain('auto (live')
    await $.tool.call({ tool: UPDATE, ops: ADD })
    expect(opened).toContain('browser')
  })
})
