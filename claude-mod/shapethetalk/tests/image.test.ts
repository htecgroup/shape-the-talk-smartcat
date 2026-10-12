import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PIPELINE } from '../scripts/samples.ts'
import { COL_PX, DEFAULT_CELL, MAX_CELLS, MAX_PNG_BYTES, MAX_PNG_SIDE, base64Bytes, cropSvg, cssCell, fitScale, imageView, parseCell, supportsImages } from '../hooks/raster.ts'

const UPDATE = 'mcp__shapethetalk__update_diagram'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const TMP = '/var/folders/xx/T'

const PANE = (bodyColumns: number, bodyRows: number) =>
  ({
    component: 'Pane',
    requestId: 'diagram',
    props: { title: 'Diagram', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
  }) as const

const diagram = (args: string) =>
  ({ command: 'diagram', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

const crc32 = (s: string) => {
  let c = ~0
  for (let i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i)
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
const be32 = (n: number) => String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
const chunk = (type: string, data: string) => be32(data.length) + type + data + be32(crc32(type + data))
/**
 * A "PNG" as latin-1: the signature and a real IHDR of w×h (the engine checks
 * both), IEND, then `#META#<path>` so a test can tell which file it is.
 */
const fakePng = (w: number, h: number, path: string) =>
  '\x89PNG\r\n\x1a\n' + chunk('IHDR', be32(w) + be32(h) + '\x08\x06\x00\x00\x00') + chunk('IEND', '') + `#META#${path}`

const RUN_OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

/**
 * The host beneath the plugin: a terminal (env), a machine with Chrome and no
 * rsvg-convert, files in memory, and a Chrome that writes the PNG it is asked
 * for (or fails, with `isChromeBroken`).
 */
function host(on: On, env: Record<string, string>, opts: { isChromeBroken?: boolean; pngBytes?: number; chromeGate?: Promise<void> } = {}) {
  const clock = mock.clock(on)
  mock.env(on, { TMPDIR: `${TMP}/`, ...env })
  const files = new Map<string, string>()
  const runs: string[][] = []
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: e.path === CHROME || files.has(e.path) }))
  // a "PNG" is its path and window size; `pngBytes` pads it (to test the 2 MiB limit)
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    const body = opts.pngBytes ? text.padEnd(opts.pngBytes, '.') : text
    return { value: e.as === 'bytes' ? { base64: btoa(body) } : body }
  })
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    if (argv[0] === 'which') return { value: { ...RUN_OK, exitCode: 1 } }
    if (argv[0] === CHROME) {
      if (opts.chromeGate) await opts.chromeGate
      if (opts.isChromeBroken) return { value: { ...RUN_OK, exitCode: 21, stderr: 'boom' } }
      const shot = argv.find(a => a.startsWith('--screenshot='))!.slice('--screenshot='.length)
      const [w, h] = argv.find(a => a.startsWith('--window-size='))!.slice('--window-size='.length).split(',').map(Number) as [number, number]
      files.set(shot, fakePng(w, h, shot))
      return { value: RUN_OK }
    }
    return { value: RUN_OK }
  })
  const chromeRuns = () => runs.filter(r => r[0] === CHROME)
  return { clock, files, runs, chromeRuns }
}

async function callUpdate($: Engine, ops: unknown) {
  const ran = await $.tool.call({ tool: UPDATE, ops })
  expect(ran.deny).toBeUndefined()
}

type Src = { png: string } | { file: string; format: string }
/** The PNG an Image shows: its path (decoded from the `{ png }` bytes the mock Chrome wrote, or the `{ file }`). */
const fileOf = (image: { props: Record<string, unknown> }) => {
  const src = image.props.source as Src
  if (!('png' in src)) return src.file
  const bytes = atob(src.png)
  return bytes.slice(bytes.indexOf('#META#') + 6)
}
/** The PNG's pixel size, from the IHDR of the bytes the Image holds. */
const pxOf = (image: { props: Record<string, unknown> }) => {
  const src = image.props.source as Src
  const b = 'png' in src ? atob(src.png) : ''
  const u32 = (at: number) => ((b.charCodeAt(at) << 24) | (b.charCodeAt(at + 1) << 16) | (b.charCodeAt(at + 2) << 8) | b.charCodeAt(at + 3)) >>> 0
  return [u32(16), u32(20)] as [number, number]
}
/** The box times the cell size is the PNG's pixel size, exactly. */
const expectBoxIsPng = (image: { props: Record<string, unknown> }) => {
  const [w, h] = pxOf(image)
  const W = Number(image.props.columns) * DEFAULT_CELL.w, H = Number(image.props.rows) * DEFAULT_CELL.h
  if (W <= MAX_PNG_SIDE && H <= MAX_PNG_SIDE) {
    expect(w).toBe(W)
    expect(h).toBe(H)
  } else {
    // past the engine's 4096 px a side: shrunk evenly, the same aspect (within a pixel)
    expect(Math.max(w, h)).toBeLessThanOrEqual(MAX_PNG_SIDE)
    expect(Math.abs(w / h - W / H)).toBeLessThan(2 / Math.min(w, h))
  }
}
const windowOf = (argv: string[]) => argv.find(a => a.startsWith('--window-size='))!.slice('--window-size='.length).split(',').map(Number) as [number, number]

/** Redraws until the Image's source is no longer `file` (the new PNG has landed). */
async function nextImage(ui: Mounted<'terminal', 'Pane'>, file: string) {
  for (let i = 0; i < 8; i++) {
    const found = await ui.find({ type: 'Image' })
    if (found && fileOf(found) !== file) return found
    await ui.redraw()
  }
  throw new Error(`the Image still shows ${file}`)
}

/** The zoom label: the percentage drawn and the column window, if any. */
async function labelOf(ui: Mounted<'terminal', 'Pane'>) {
  const t = await ui.find({ type: 'Text', text: /\d+%/ })
  const text = String(t?.text ?? '')
  const pct = Number(/(\d+)%/.exec(text)?.[1])
  const win = /columns (\d+)-(\d+) of (\d+)/.exec(text)
  return { text, pct, win: win ? ([Number(win[1]), Number(win[2]), Number(win[3])] as [number, number, number]) : null }
}

/** The Image once the rasteriser has landed (it runs after the render that asked for it). */
async function imageOf(ui: Mounted<'terminal', 'Pane'>) {
  for (let i = 0; i < 5; i++) {
    const found = await ui.find({ type: 'Image' })
    if (found) return found
    await ui.redraw()
  }
  return undefined
}

describe('terminal image', () => {
  test('Ghostty: the hand-drawn PNG via headless Chrome, still highlight, re-rasterised when it clears', async ($, on) => {
    const { clock, files, chromeRuns } = host(on, { TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty' })
    // the whole board at once: these tests are about the picture, not the staggered reveal
    await $.command.run(diagram('speed off'))
    await callUpdate($, PIPELINE)
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE(90, 40) })
    const image = await imageOf(ui)
    expect(image).toBeDefined()
    // bytes, so the terminal scales them to the box: exactly the PNG Chrome wrote
    const src = image!.props.source as { png: string }
    expect(typeof src.png).toBe('string')
    const file = fileOf(image!)
    expect(file.startsWith(`${TMP}/shapethetalk-sess-1/pipeline-`)).toBe(true)
    expect(atob(src.png)).toBe(files.get(file)!)
    expectBoxIsPng(image!)
    const source = { file }
    expect(Number(image!.props.columns)).toBeLessThanOrEqual(90)
    expect(Number(image!.props.rows)).toBeGreaterThan(0)
    expect(Number(image!.props.rows)).toBeLessThanOrEqual(MAX_CELLS)
    expect(String(image!.props.alt)).toContain('extractor')
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'zoom-in' })).toBeDefined()

    // one Chrome run, sized to the drawing, at a Retina scale, from a still page
    expect(chromeRuns()).toHaveLength(1)
    const argv = chromeRuns()[0]!
    expect(argv).toContain('--headless')
    expect(argv).toContain('--force-device-scale-factor=1')
    expect(windowOf(argv)).toEqual([Number(image!.props.columns) * DEFAULT_CELL.w, Number(image!.props.rows) * DEFAULT_CELL.h])
    const html = files.get(argv[argv.length - 1]!.replace('file://', ''))!
    expect(html).toContain('<svg')
    expect(html).not.toContain('@keyframes')
    expect(html).toContain('class="bychip"') // the board was just drawn: the chip shows

    // redraws (scroll, focus) reuse the PNG
    await ui.redraw()
    await ui.redraw()
    expect(chromeRuns()).toHaveLength(1)

    // zoom draws a new PNG under a new name (a new source), not just a new box
    const cols0 = Number(image!.props.columns)
    await ui.press({ key: 'zoom-out' })
    const smaller = await nextImage(ui, source.file)
    expect(Number(smaller.props.columns)).toBeLessThan(cols0)
    expect(Number(smaller.props.rows)).toBeLessThan(Number(image!.props.rows))
    expectBoxIsPng(smaller)
    expect(chromeRuns()).toHaveLength(2)
    // and back: the PNG drawn before is still on disk, shown at once
    await ui.press({ key: 'zoom-100' })
    const refit = await nextImage(ui, fileOf(smaller))
    expect(fileOf(refit)).toBe(source.file)
    expect(chromeRuns()).toHaveLength(2)

    // the highlight clears after 5 s: a new still without the chip
    await clock.advance(5000)
    await ui.redraw()
    await ui.redraw()
    expect(chromeRuns()).toHaveLength(3)
    const after = (await imageOf(ui))!
    const file2 = fileOf(after)
    expect(file2).not.toBe(source.file)
    const html2 = files.get(chromeRuns()[2]!.at(-1)!.replace('file://', ''))!
    expect(html2).not.toContain('class="bychip"')
    await ui.unmount()
  })

  test('during a staggered reveal the picture grows, rasterised at most once a second', async ($, on) => {
    const { clock, files, chromeRuns } = host(on, { TERM_PROGRAM: 'ghostty' })
    await callUpdate($, PIPELINE) // 10 nodes and 9 edges: steps every 500-1000 ms (slow, the default) for about 14 s
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE(90, 40) })
    expect(await imageOf(ui)).toBeDefined()
    expect(chromeRuns()).toHaveLength(1)
    const shownIn = (run: string[]) => (files.get(run.at(-1)!.replace('file://', ''))!.match(/class="(node|edge) /g) ?? []).length
    // the pane redraws on every step (and more): Chrome runs about once a second, never back to back
    for (let t = 0; t < 4000; t += 150) {
      await clock.advance(150)
      await ui.redraw()
    }
    const runs = chromeRuns()
    expect(runs.length).toBeGreaterThanOrEqual(3)
    expect(runs.length).toBeLessThanOrEqual(5)
    // each picture holds more of the board than the one before
    const counts = runs.map(shownIn)
    expect(counts[0]).toBe(1)
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThan(counts[i - 1]!)
    await ui.unmount()
  })

  test('while the first picture is drawn: a quiet line, not the grid; the grid only if it takes over 2 s', async ($, on) => {
    let finish = () => {}
    const chromeGate = new Promise<void>(resolve => (finish = resolve))
    const { clock } = host(on, { TERM_PROGRAM: 'ghostty' }, { chromeGate })
    await $.command.run(diagram('speed off'))
    await callUpdate($, PIPELINE)
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE(90, 40) })
    expect(await ui.find({ type: 'Text', text: /Drawing the picture/ })).toBeDefined()
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    await clock.advance(2100)
    await ui.redraw()
    expect(await ui.find({ type: 'Raster' })).toBeDefined()
    finish()
    expect(await imageOf(ui)).toBeDefined()
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    await ui.unmount()
  })

  test('a terminal without images keeps the Raster grid and runs nothing', async ($, on) => {
    const { runs } = host(on, { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' })
    await callUpdate($, PIPELINE)
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE(90, 40) })
    await ui.redraw()
    expect(await ui.find({ type: 'Raster' })).toBeDefined()
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(runs).toHaveLength(0)
    await ui.unmount()
  })

  test('a failing rasteriser falls back to the grid, with a note', async ($, on) => {
    const { chromeRuns } = host(on, { TERM_PROGRAM: 'ghostty' }, { isChromeBroken: true })
    await callUpdate($, PIPELINE)
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE(90, 40) })
    await ui.redraw()
    await ui.redraw()
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(await ui.find({ type: 'Raster' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Picture unavailable \(chrome exited 21/ })).toBeDefined()
    // the same drawing is not retried on every redraw
    await ui.redraw()
    expect(chromeRuns()).toHaveLength(1)
    await ui.unmount()
  })

  test('/diagram look switches between the grid and the image by hand', async ($, on) => {
    const { chromeRuns } = host(on, { TERM_PROGRAM: 'Apple_Terminal' })
    await callUpdate($, PIPELINE)
    expect((await $.command.run(diagram('look'))).text).toContain('look is auto')
    expect((await $.command.run(diagram('look image'))).text).toContain('hand-drawn picture')
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE(90, 40) })
    expect(await imageOf(ui)).toBeDefined()
    expect(chromeRuns()).toHaveLength(1)
    expect((await $.command.run(diagram('look grid'))).text).toContain('box-drawing grid')
    await ui.redraw()
    expect(await ui.find({ type: 'Raster' })).toBeDefined()
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect((await $.command.run(diagram('look auto'))).text).toContain('this terminal shows no images')
    await ui.unmount()
  })

  test('zoom in: a new source each step, a larger PNG at the box size, the label never more than drawn, no box past 255 rows', async ($, on) => {
    const { chromeRuns, files } = host(on, { TERM_PROGRAM: 'ghostty' })
    // the whole board at once: these tests are about the picture, not the staggered reveal
    await $.command.run(diagram('speed off'))
    await callUpdate($, PIPELINE)
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE(90, 40) })
    let image = (await imageOf(ui))!
    const seen = new Set([fileOf(image)])
    let lastH = windowOf(chromeRuns().at(-1)!)[1]
    const firstH = lastH
    for (let i = 0; i < 12; i++) {
      const before = await labelOf(ui)
      await ui.press({ key: 'zoom-in' })
      const after = await labelOf(ui)
      if (after.pct === before.pct) {
        // at the largest size: + does nothing and says so
        expect(after.text).toContain('(largest)')
        break
      }
      image = await nextImage(ui, fileOf(image))
      expect(seen.has(fileOf(image))).toBe(false)
      seen.add(fileOf(image))
      const run = chromeRuns().at(-1)!
      const [, H] = windowOf(run)
      expect(H).toBeGreaterThanOrEqual(Math.min(lastH, MAX_PNG_SIDE))
      lastH = H
      expectBoxIsPng(image)
      // what is drawn matches the label: the PNG's height over the drawing's (from its viewBox) is the % shown
      const html = files.get(run.at(-1)!.replace('file://', ''))!
      const vbH = Number(/viewBox="[-\d.]+ [-\d.]+ [-\d.]+ ([-\d.]+)"/.exec(html)![1])
      const k = (Number(image.props.rows) * DEFAULT_CELL.h) / (vbH * (DEFAULT_CELL.w / COL_PX))
      expect(Math.abs(k - after.pct / 100)).toBeLessThan(0.01)
      const rows = Number(image.props.rows)
      expect(rows).toBeLessThanOrEqual(MAX_CELLS)
      expect(Number(image.props.columns)).toBeLessThanOrEqual(90)
    }
    expect((await labelOf(ui)).text).toContain('(largest)')
    expect(lastH).toBeGreaterThan(firstH)
    expect(seen.size).toBeGreaterThan(3)
    await ui.unmount()
  })

  test('wider than the pane: pan buttons move the rasterised window, the box stays the pane width', async ($, on) => {
    const { chromeRuns, files } = host(on, { TERM_PROGRAM: 'ghostty' })
    // the whole board at once: these tests are about the picture, not the staggered reveal
    await $.command.run(diagram('speed off'))
    await callUpdate($, PIPELINE)
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE(60, 40) })
    let image = (await imageOf(ui))!
    expect(await ui.find({ type: 'Button', key: 'pan-right' })).toBeUndefined()
    await ui.press({ key: 'zoom-in' })
    image = await nextImage(ui, fileOf(image))
    await ui.press({ key: 'zoom-in' })
    image = await nextImage(ui, fileOf(image))
    const at = await labelOf(ui)
    expect(at.win).not.toBeNull()
    const [a0, b0, total] = at.win!
    expect(total).toBeGreaterThan(60)
    expect(b0 - a0 + 1).toBe(60)
    expect(Number(image.props.columns)).toBe(60)
    expect(await ui.find({ type: 'Button', key: 'pan-left' })).toBeDefined()
    const viewBoxOf = () => /viewBox="([-\d.]+) /.exec(files.get(chromeRuns().at(-1)!.at(-1)!.replace('file://', ''))!)![1]
    const x0 = Number(viewBoxOf())

    await ui.press({ key: 'pan-right' })
    image = await nextImage(ui, fileOf(image))
    const moved = (await labelOf(ui)).win!
    expect(moved[0]).toBeGreaterThan(a0)
    expect(moved[1] - moved[0] + 1).toBe(60)
    expect(Number(viewBoxOf())).toBeGreaterThan(x0)
    expect(Number(image.props.columns)).toBe(60)
    expectBoxIsPng(image)

    // all the way right stops at the drawing's edge
    for (let i = 0; i < 10; i++) {
      await ui.press({ key: 'pan-right' })
      await ui.redraw()
    }
    for (let i = 0; i < 4; i++) await ui.redraw()
    expect((await labelOf(ui)).win![1]).toBe(total)
    image = (await ui.find({ type: 'Image' }))!
    expect(Number(image.props.columns)).toBe(60)

    await ui.press({ key: 'pan-left' })
    image = await nextImage(ui, fileOf(image))
    expect((await labelOf(ui)).win![1]).toBeLessThan(total)
    await ui.unmount()
  })

  test('Fit fits the pane both ways', async ($, on) => {
    host(on, { TERM_PROGRAM: 'ghostty' })
    await callUpdate($, PIPELINE)
    for (const [cols, rows] of [[90, 40], [160, 24], [50, 60]] as const) {
      const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE(cols, rows) })
      const image = (await imageOf(ui))!
      await ui.press({ key: 'zoom-fit' })
      for (let i = 0; i < 3; i++) await ui.redraw()
      const now = (await ui.find({ type: 'Image' }))!
      expect(Number(now.props.columns)).toBeLessThanOrEqual(cols)
      expect(Number(now.props.rows)).toBeLessThanOrEqual(rows - 2)
      // one way or the other it fills the room (within a cell), unless capped at 160%
      const fillsW = Number(now.props.columns) >= cols - 1
      const fillsH = Number(now.props.rows) >= rows - 3
      expect(fillsW || fillsH || (await labelOf(ui)).pct === 160).toBe(true)
      expectBoxIsPng(now)
      expect(image).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'pan-right' })).toBeUndefined()
      await ui.unmount()
    }
  })
})

describe('raster helpers', () => {
  test('detects kitty and Ghostty, not tmux', () => {
    expect(supportsImages({ TERM_PROGRAM: 'ghostty' })).toBe(true)
    expect(supportsImages({ TERM: 'xterm-ghostty' })).toBe(true)
    expect(supportsImages({ TERM: 'xterm-kitty' })).toBe(true)
    expect(supportsImages({ KITTY_WINDOW_ID: '1' })).toBe(true)
    expect(supportsImages({ TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-501/default,1,0' })).toBe(false)
    expect(supportsImages({ TERM_PROGRAM: 'iTerm.app' })).toBe(false)
    expect(supportsImages({})).toBe(false)
  })

  test('fitScale fits width and height, capped for a tiny board', () => {
    expect(Math.abs(fitScale(800, 300, 50, 100) - 0.5)).toBeLessThan(0.01) // width-bound: 50 columns × 8 px
    const k = fitScale(400, 2000, 100, 20) // height-bound
    expect(imageView(400, 2000, k, 100, 0).rows).toBeLessThanOrEqual(20)
    expect(fitScale(100, 50, 200, 100)).toBe(1.6)
  })

  test('imageView: the PNG is the box in device px, never wider than the pane or taller than 255 rows; the window clamps', () => {
    const c = cssCell(DEFAULT_CELL)
    const v = imageView(1000, 800, 3, 80, 0.5)
    expect(v.columns).toBe(80)
    expect(v.totalColumns).toBe(Math.round((1000 * 3) / c.w))
    expect(v.startColumn).toBe(Math.round(0.5 * v.totalColumns))
    // the window is the box at k: no stretch (k 3 is taller than 4096 px: shrunk evenly)
    expect(Math.abs(v.cropW / v.cropH - v.pxW / v.pxH)).toBeLessThan(0.01)
    const one = imageView(1000, 800, 1, 80, 0.5)
    expect(one.pxW).toBe(80 * DEFAULT_CELL.w)
    expect(one.pxH).toBe(one.rows * DEFAULT_CELL.h)
    expect(Math.abs(one.cropW * (DEFAULT_CELL.w / COL_PX) - one.pxW)).toBeLessThan(0.01)
    expect(Math.abs(one.cropH * (DEFAULT_CELL.w / COL_PX) - one.pxH)).toBeLessThan(0.01)
    expect(Math.abs(v.cropX - (v.startColumn * c.w) / 3)).toBeLessThan(0.01)
    expect(imageView(1000, 800, 3, 80, 5).startColumn).toBe(v.totalColumns - 80)
    const tall = imageView(400, 4000, 3, 80, 0)
    expect(Math.abs(tall.k - tall.maxK)).toBeLessThan(0.01)
    expect(tall.rows).toBeLessThanOrEqual(MAX_CELLS)
    const whole = imageView(400, 300, 1, 80, 0.3)
    expect(whole.columns).toBe(whole.totalColumns)
    expect(whole.columns).toBe(50)
    expect(whole.rows).toBe(Math.round(300 / c.h))
    // the whole width: centred, within half a cell of the drawing
    expect(Math.abs(whole.cropX + whole.cropW / 2 - 200)).toBeLessThan(0.01)
    expect(Math.abs(whole.cropH - 300)).toBeLessThanOrEqual(c.h / 2)
    // the box is up to 8670 px tall at 255 rows: the PNG shrinks evenly to 4096
    expect(tall.pxH).toBeLessThanOrEqual(MAX_PNG_SIDE)
    expect(Math.abs(tall.pxW / tall.pxH - (tall.columns * 16) / (tall.rows * 34))).toBeLessThan(0.01)
    // another cell size: the same box rule
    const big = imageView(400, 300, 1, 80, 0, { w: 20, h: 40 })
    expect(big.pxW).toBe(big.columns * 20)
    expect(big.pxH).toBe(big.rows * 40)
  })

  test('cell sizes parse; base64 sizes decode', () => {
    expect(parseCell('16x34')).toEqual({ w: 16, h: 34 })
    expect(parseCell(' 18 x 40 ')).toEqual({ w: 18, h: 40 })
    expect(parseCell('16')).toBeNull()
    expect(parseCell('2x2')).toBeNull()
    expect(base64Bytes(btoa('abcde'))).toBe(5)
    expect(base64Bytes(btoa('abcdef'))).toBe(6)
  })

  test('cropSvg sets the root viewBox to the window and the size to the PNG pixels', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="-20 -10 400 300" preserveAspectRatio="xMidYMid meet"><rect/></svg>'
    const c = cropSvg(svg, 100, 5, 150, 290, 400, 300, 300, 580)
    expect(c).toContain('viewBox="80 -5 150 290"')
    expect(c).toContain('width="300"')
    expect(c).toContain('height="580"')
    expect(c).toContain('preserveAspectRatio="none"')
    expect(c.endsWith('<rect/></svg>')).toBe(true)
  })
})

describe('terminal image sources', () => {
  test('a PNG over 2 MiB is shown by path; /diagram cell resizes the PNGs', async ($, on) => {
    const { chromeRuns } = host(on, { TERM_PROGRAM: 'ghostty' }, { pngBytes: MAX_PNG_BYTES + 10 })
    // the whole board at once: these tests are about the picture, not the staggered reveal
    await $.command.run(diagram('speed off'))
    await callUpdate($, PIPELINE)
    const ui = await $.ui.mount({ plugin: 'shapethetalk', surface: 'terminal', ...PANE(90, 40) })
    const image = (await imageOf(ui))!
    const src = image.props.source as { file: string; format: string }
    expect(src.format).toBe('png')
    expect(src.file.startsWith(`${TMP}/shapethetalk-sess-1/`)).toBe(true)
    expect(windowOf(chromeRuns()[0]!)).toEqual([Number(image.props.columns) * 16, Number(image.props.rows) * 34])

    expect((await $.command.run(diagram('cell'))).text).toContain('16x34')
    expect((await $.command.run(diagram('cell nope'))).text).toContain('Not a cell size')
    expect((await $.command.run(diagram('cell 20x40'))).text).toContain('20x40')
    for (let i = 0; i < 4; i++) await ui.redraw()
    const now = (await ui.find({ type: 'Image' }))!
    const [W, H] = windowOf(chromeRuns().at(-1)!)
    expect(W).toBe(Number(now.props.columns) * 20)
    expect(H).toBe(Number(now.props.rows) * 40)
    expect((await $.command.run(diagram('cell default'))).text).toContain('16x34')
    await ui.unmount()
  })
})
