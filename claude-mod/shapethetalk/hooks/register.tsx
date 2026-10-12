// ShapeTheTalk: Claude draws and live-edits a whiteboard diagram in a pane.
// Wiring: the two tools, /diagram, the pane (open, close, scroll guard), the
// terminal and desktop renderers, and the state atoms; registerBrowser adds the
// vendored terminal-browser pane (hooks/browser/) the live look opens.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { DBoard, DDoc, DImage, DLook, DPlacement, DRecent, DReveal, DSpeed } from '../types'
import { applyOps, compact, emptyDoc, findBoard, summary, switchTo, wipe } from './board.ts'
import { fullLayout, placeNew } from './layout.ts'
import { COLORS, encodeRaster, renderGrid } from './grid.ts'
import type { Dir } from './grid.ts'
import { emptySvg, renderRich } from './rich.ts'
import type { Rich } from './rich.ts'
import { CHROMES, DEFAULT_CELL, MAX_CELLS, MAX_PNG_BYTES, RASTER_TIMEOUT_MS, base64Bytes, cellOf, chromeArgv, cropSvg, cssCell, fitScale, imageView, parseCell, rsvgArgv, supportsImages, wrapHtml } from './raster.ts'
import type { Cell, Rasterizer } from './raster.ts'
import { LIVE_DATA, LIVE_PAGE, liveData, liveHtml } from './live.ts'
import type { LiveBoard } from './live.ts'
import { DEFAULT_SPEED, SPEEDS, SPEED_NAMES, advance, hiddenIds, isSpeed, nextDelay, recentOf, startReveal, visibleBoard } from './reveal.ts'
import { GET_DESCRIPTION, GET_SCHEMA, GET_TOOL, UPDATE_DESCRIPTION, UPDATE_SCHEMA, UPDATE_TOOL } from './tools.ts'
import {
  BROWSER_CLOSE_DESCRIPTION,
  BROWSER_CLOSE_TOOL,
  BROWSER_COMMAND,
  BROWSER_COMMAND_DESCRIPTION,
  BROWSER_INSTALL_HINT,
  BROWSER_OPEN_DESCRIPTION,
  BROWSER_OPEN_SCHEMA,
  BROWSER_OPEN_TOOL,
  hasRequiredCapabilities,
  registerBrowser,
} from './browser/browser.tsx'

const PLUGIN = 'shapethetalk'
const PANE = 'diagram'
const PANE_TITLE = 'Diagram'
const RECENT_MS = 5000
/** A call adding more nodes than this gets a nudge to build the board in smaller steps. */
const BIG_CALL_NODES = 4
/** Terminal picture during a reveal: at most one rasterise per this many ms (the steps in between are skipped). */
const IMAGE_REVEAL_MS = 1000
/** The once-per-session `terminal-browser capabilities` check behind the auto look: killed after this. */
const BROWSER_CHECK_MS = 5000
/** How long the first update in auto waits for that check before showing the picture instead. */
const BROWSER_WAIT_MS = 2000
/** How long the pane shows a quiet "Drawing the picture…" (no grid) while the first PNG is drawn. */
const IMAGE_WAIT_MS = 2000

// desktop pane metrics (estimated): px per cell
const CELL_W = 7.8
const CELL_H = 20
export const ZOOM_STEPS = [0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3]

const docAtom = atom({ plugin: 'shapethetalk', key: 'doc' } as const, emptyDoc())
const layoutAtom = atom({ plugin: 'shapethetalk', key: 'layout' } as const, {})
const recentAtom = atom({ plugin: 'shapethetalk', key: 'recent' } as const, null)
const panAtom = atom({ plugin: 'shapethetalk', key: 'pan' } as const, 0)
const zoomAtom = atom({ plugin: 'shapethetalk', key: 'zoom' } as const, 1)
const imagePanAtom = atom({ plugin: 'shapethetalk', key: 'imagePan' } as const, 0)
const lookAtom = atom({ plugin: 'shapethetalk', key: 'look' } as const, 'auto' as DLook)
const imagesAtom = atom({ plugin: 'shapethetalk', key: 'images' } as const, {} as { [boardId: string]: DImage })
const cellAtom = atom({ plugin: 'shapethetalk', key: 'cell' } as const, DEFAULT_CELL as Cell)
const revealAtom = atom({ plugin: 'shapethetalk', key: 'reveal' } as const, null as DReveal | null)
const speedAtom = atom({ plugin: 'shapethetalk', key: 'speed' } as const, DEFAULT_SPEED as DSpeed)

export const zoomIn = (k: number) => ZOOM_STEPS.find(s => s > k + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!
export const zoomOut = (k: number) => [...ZOOM_STEPS].reverse().find(s => s < k - 0.001) ?? ZOOM_STEPS[0]!

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** FNV-1a, as 8 hex digits: names a PNG after what it was drawn from. */
const fnv = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16).padStart(8, '0')
}

// module flags: reset on a reload (session.start re-reads the open panes)
const pane = { isOpen: false, isClosedByPerson: false }

async function openPane($: EngineInterface, isAsked: boolean) {
  if (!isAsked && (pane.isOpen || pane.isClosedByPerson)) return
  pane.isOpen = true
  if (isAsked) pane.isClosedByPerson = false
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

// the staggered reveal (module state: a reload cancels the timers and starts over, and a
// reveal it finds in $.state is dropped, so nothing stays hidden)
const run = {
  /** bumped by every start and stop: a timer from an older run does nothing */
  token: 0,
  timer: null as Timer | null,
  /** whether this module load is driving a reveal; renderers hide nothing otherwise */
  isRunning: false,
}

async function nowOf($: EngineInterface): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return 0
  }
}

/** The board as the renderers draw it: without what the reveal still hides. */
async function shownBoard($: EngineInterface, board: DBoard): Promise<DBoard> {
  if (!run.isRunning) return board
  const r = await read($, revealAtom)
  if (!r || r.board !== board.id) return board
  return visibleBoard(board, hiddenIds(r, board.id, await nowOf($), run.isRunning))
}

/** Ends any reveal: everything shows at once. */
async function stopReveal($: EngineInterface) {
  run.token++
  run.timer?.cancel()
  run.timer = null
  run.isRunning = false
  if ((await read($, revealAtom)) !== null) await update($, revealAtom, () => null)
}

/** Clears the highlight RECENT_MS from now, unless a newer one replaced it. */
function clearRecentLater($: EngineInterface, seq: number) {
  $.clock.after(RECENT_MS, () => {
    void update($, recentAtom, r => (r && r.seq === seq ? null : r)).then(() => refreshLive($))
  })
}

/** Waits for the next item of the run `token`, then reveals it; at the end the highlight fades as usual. */
function scheduleStep($: EngineInterface, token: number, r: DReveal) {
  const wait = nextDelay(r)
  if (wait === null) {
    run.isRunning = false
    run.timer = null
    void update($, revealAtom, cur => (cur && cur.seq === r.seq && !cur.queue.length ? null : cur))
    clearRecentLater($, recentOf(r).seq)
    return
  }
  run.timer = $.clock.after(wait, () => {
    void revealStep($, token)
  })
}

async function revealStep($: EngineInterface, token: number) {
  if (token !== run.token) return
  try {
    const r = await update($, revealAtom, cur => (cur ? advance(cur) : cur))
    if (!r || token !== run.token) {
      if (token === run.token) run.isRunning = false
      return
    }
    await update($, recentAtom, () => ({ board: r.board, ...recentOf(r) }))
    await refreshLive($)
    scheduleStep($, token, r)
  } catch {
    // never leave elements hidden: show the whole board
    if (token === run.token) await stopReveal($).catch(() => undefined)
  }
}

// terminal image: what the rasteriser is doing (module state: a reload starts over;
// the PNGs already drawn stay in $.state)
type Job = { board: string; key: string; svg: string; width: number; height: number; pxW: number; pxH: number; columns: number; rows: number }
/** How many PNGs the session keeps on disk for going back to a zoom or pan; older ones are deleted. */
const KEEP_PNGS = 12
const img = {
  /** undefined until looked for; null when there is no rsvg-convert or Chrome */
  rasterizer: undefined as Rasterizer | null | undefined,
  /** whether the terminal shows pictures (TERM_PROGRAM and friends) */
  canShow: undefined as boolean | undefined,
  dir: '',
  isBusy: false,
  /** when the last rasterise started ($.clock.now()), for pacing them during a reveal */
  lastStart: -Infinity,
  inflight: null as string | null,
  queued: null as Job | null,
  failed: new Map<string, string>(),
  /** PNGs on disk by key, oldest first (an LRU): a zoom or pan seen before shows at once */
  drawn: new Map<string, DImage>(),
  /** each PNG's bytes as base64 for a `{ png }` source, by file; null when over 2 MiB (shown by path) */
  bytes: new Map<string, string | null>(),
  failures: 0,
  /** set after repeated failures (or no rasteriser): the grid for the rest of the session */
  broken: null as string | null,
  /** when the pane first waited for a picture with none to show ($.clock.now()); past IMAGE_WAIT_MS it shows the grid meanwhile */
  waitSince: null as number | null,
}

// the live look: the board as a page in the terminal-browser pane (hooks/browser/; module state: a reload starts over)
const live = {
  /** whether this module opened the browser pane (and it has not closed since) */
  isOpen: false,
  /** what the last open found: undefined before one, false when it failed (`why` says how) */
  hasBrowser: undefined as boolean | undefined,
  /** the pane's note when the last open failed: the install hint, or the error */
  why: '',
  isClosedByPerson: false,
  /** what board.js holds now; '' before the first write (a reload writes it again) */
  data: '',
  /** the live.html written this module load */
  page: '',
  /**
   * whether a `terminal-browser` with the needed capabilities is on PATH: undefined until the
   * session.start check (run in the background) answers; auto shows the picture until then
   */
  hasBinary: undefined as boolean | undefined,
  /** the check in flight, so the first update can wait for it */
  checking: null as Promise<void> | null,
}

/** Asks `terminal-browser capabilities` once per module load, in the background; never throws. */
function checkBinary($: EngineInterface): Promise<void> {
  if (live.hasBinary !== undefined) return Promise.resolve()
  if (!live.checking) {
    live.checking = (async () => {
      let isThere = false
      try {
        isThere = hasRequiredCapabilities(await $.process.run(['terminal-browser', 'capabilities'], { timeoutMs: BROWSER_CHECK_MS }))
      } catch {
        // not on PATH (or it hung): the picture
      }
      // an open that already answered knows better
      if (live.hasBinary === undefined) live.hasBinary = isThere
      live.checking = null
      $.ui.invalidate('ui.render')
    })().catch(() => {
      live.checking = null
    })
  }
  return live.checking
}

/**
 * Auto on a terminal that shows images: the terminal-browser check answers before
 * the board is shown anywhere (started here if session.start did not), waited for
 * at most BROWSER_WAIT_MS; the picture if it is still out by then.
 */
async function settleAuto($: EngineInterface): Promise<void> {
  if (live.hasBinary !== undefined || (await read($, lookAtom)) !== 'auto' || !(await detectImages($))) return
  const checking = checkBinary($)
  await Promise.race([
    checking,
    new Promise<void>(resolve => {
      try {
        $.clock.after(BROWSER_WAIT_MS, resolve)
      } catch {
        resolve()
      }
    }),
  ])
}

/** What the terminal look comes to: `auto` is live (images and terminal-browser), else the picture (images), else the grid. */
type Shown = 'image' | 'grid' | 'live'
async function shownLook($: EngineInterface, look?: DLook): Promise<Shown> {
  const want = look ?? (await read($, lookAtom))
  if (want !== 'auto') return want
  if (!(await detectImages($))) return 'grid'
  return live.hasBinary === true && live.hasBrowser !== false ? 'live' : 'image'
}

/** Why auto came to what it did, for /diagram look. */
async function autoSays($: EngineInterface): Promise<string> {
  const shown = await shownLook($, 'auto')
  if (shown === 'grid') return 'the grid: this terminal shows no images'
  if (shown === 'live') return 'live: this terminal shows images and terminal-browser is installed'
  if (live.hasBinary === undefined) return 'the picture: still checking for terminal-browser'
  if (live.hasBinary && live.hasBrowser === false) return 'the picture: terminal-browser could not open the page'
  return `the picture: this terminal shows images; for the live page, ${BROWSER_INSTALL_HINT}`
}

/** The board as the live page shows it: rich.ts's interactive SVG with tooltips. */
async function liveBoard($: EngineInterface): Promise<LiveBoard> {
  const doc: DDoc = await read($, docAtom)
  const full = doc.active ? doc.boards[doc.active] : undefined
  if (!full) {
    const svg = emptySvg()
    return { v: fnv(svg), title: 'No diagram yet', svg, width: 520, height: 110 }
  }
  const board = await shownBoard($, full)
  const layout = await read($, layoutAtom)
  const recent = await read($, recentAtom)
  const here = recent && recent.board === board.id ? recent : null
  // the page patches its DOM in place, so every element shown in a reveal keeps its own animation:
  // all of them carry the classes, the chip follows the newest node
  const rich = renderRich(board, placeNew(board, layout[board.id]), {
    maxWidth: LIVE_ROOM.w,
    maxHeight: LIVE_ROOM.h,
    recent: here ? { ids: here.ids, added: here.added } : null,
    chip: here?.newest,
    tooltips: true,
    limit: 2_000_000,
  })
  return { v: `${doc.version}-${fnv(rich.source)}`, title: board.title, svg: rich.source, width: rich.width, height: rich.height }
}
/** The room the live page's drawing picks its direction for (a browser pane beside the chat). */
const LIVE_ROOM = { w: 1100, h: 900 }

/**
 * Writes the live page's board.js when the look is live and the board drew
 * differently (and live.html once per module load); resolves the page's path.
 */
async function syncLive($: EngineInterface, isForced = false): Promise<string | null> {
  if (!isForced && (await shownLook($)) !== 'live') return null
  if (!img.dir) img.dir = await tempDir($)
  const page = `${img.dir}/${LIVE_PAGE}`
  const b = await liveBoard($)
  const data = liveData(b)
  if (data !== live.data) {
    await $.fs.write(`${img.dir}/${LIVE_DATA}`, data)
    live.data = data
  }
  if (live.page !== page) {
    await $.fs.write(page, liveHtml(b))
    live.page = page
  }
  return page
}

/** Keeps the live page current; never throws (the board is saved either way). */
async function refreshLive($: EngineInterface) {
  try {
    await syncLive($)
  } catch {
    // the next change writes it again
  }
}

/** Writes the page and opens it in the terminal-browser pane; an error when the binary is missing or refuses. */
async function openLive($: EngineInterface): Promise<{ url: string } | { error: string }> {
  const page = await syncLive($, true)
  const url = `file://${encodeURI(page!)}`
  let error: string
  try {
    // the noun hooks/browser/browser.tsx adds to $ and answers (see registerBrowser)
    const r = await $.browser.open({ url })
    if (r.ok) error = ''
    else if (r.code === 'missing') {
      live.hasBinary = false
      error = r.error
      live.why = `Live look needs terminal-browser (${BROWSER_INSTALL_HINT}); showing the picture.`
    } else {
      error = `terminal-browser could not open it (${r.error})`
      live.why = `Live look unavailable (${cut(r.error, 80)}); showing the picture.`
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    error = `terminal-browser could not open it (${cut(why, 80)})`
    live.why = `Live look unavailable (${cut(why, 80)}); showing the picture.`
  }
  if (error) {
    live.hasBrowser = false
    return { error }
  }
  live.hasBrowser = true
  live.hasBinary = true
  live.why = ''
  live.isOpen = true
  live.isClosedByPerson = false
  return { url }
}

/** Closes terminal-browser's pane if this mod opened it. */
async function closeLive($: EngineInterface) {
  if (!live.isOpen) return
  live.isOpen = false
  try {
    await $.browser.close()
  } catch {
    // it may be gone already
  }
}

/** `/diagram close`: whichever of the diagram pane and the live page is open; the person's ask, so updates leave the page closed. */
async function closeAll($: EngineInterface): Promise<string> {
  const wasLive = live.isOpen
  if (wasLive) {
    await closeLive($)
    live.isClosedByPerson = true
  }
  await $.ui.close({ id: PANE })
  pane.isOpen = false
  return wasLive ? 'Live diagram closed.' : 'Diagram pane closed.'
}

async function detectImages($: EngineInterface): Promise<boolean> {
  if (img.canShow === undefined) {
    try {
      img.canShow = supportsImages({
        TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
        TERM: await $.env.get('TERM'),
        KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
        GHOSTTY_RESOURCES_DIR: await $.env.get('GHOSTTY_RESOURCES_DIR'),
        TMUX: await $.env.get('TMUX'),
      })
    } catch {
      img.canShow = false
    }
  }
  return img.canShow
}

async function wantsImage($: EngineInterface): Promise<boolean> {
  // live: the pane (if open) shows the picture beside the page, or instead of it without terminal-browser
  return (await shownLook($)) !== 'grid'
}

async function tempDir($: EngineInterface): Promise<string> {
  let base = '/tmp'
  let id = 'session'
  try {
    base = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
  } catch {
    // /tmp
  }
  try {
    id = (await $.session.id()).replace(/[^A-Za-z0-9_-]/g, '') || id
  } catch {
    // one dir for every session then
  }
  return `${base}/shapethetalk-${id}`
}

/** Ask for a PNG; the newest ask wins, one rasterise runs at a time, the pane redraws when it lands. */
function requestPng($: EngineInterface, job: Job) {
  if (img.inflight === job.key) return
  img.queued = job
  if (!img.isBusy) void pump($)
}

async function pump($: EngineInterface) {
  img.isBusy = true
  try {
    while (img.queued) {
      const job = img.queued
      img.queued = null
      img.inflight = job.key
      try {
        if (img.rasterizer === undefined) img.rasterizer = await findRasterizer($)
        if (!img.rasterizer) {
          img.broken = 'no rsvg-convert or Chrome found'
          $.ui.invalidate('ui.render')
          break
        }
        if (!img.dir) img.dir = await tempDir($)
        // during a reveal the steps come every 150-1000 ms: rasterise at most one per IMAGE_REVEAL_MS
        // and skip to the newest ask, so Chrome is not run back to back
        if (run.isRunning) {
          const wait = img.lastStart + IMAGE_REVEAL_MS - (await nowOf($))
          if (wait > 0) {
            await new Promise<void>(resolve => {
              $.clock.after(wait, resolve)
            })
            // a newer ask came in meanwhile: draw that one instead
            if (img.queued) continue
          }
        }
        img.lastStart = await nowOf($)
        const name = `${job.board.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}-${fnv(job.key)}`
        const file = await rasterize($, img.rasterizer, img.dir, name, job.svg, job.pxW, job.pxH)
        await loadBytes($, file)
        img.failures = 0
        const shot: DImage = { key: job.key, file, width: job.width, height: job.height, columns: job.columns, rows: job.rows, pxWidth: job.pxW, pxHeight: job.pxH }
        const images = await update($, imagesAtom, m => ({ ...m, [job.board]: shot }))
        remember($, shot, images)
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        img.failed.set(job.key, why)
        img.failures++
        if (img.failures >= 3) img.broken = why
        $.ui.invalidate('ui.render')
      } finally {
        img.inflight = null
      }
    }
  } catch {
    // nothing here may throw into the void
  } finally {
    img.isBusy = false
  }
}


/** Keeps a drawn PNG for reuse; deletes the oldest past KEEP_PNGS (never one a board still shows). */
function remember($: EngineInterface, shot: DImage, images: { [boardId: string]: DImage }) {
  img.drawn.delete(shot.key)
  img.drawn.set(shot.key, shot)
  const shown = new Set(Object.values(images).map(i => i.file))
  const gone: string[] = []
  for (const [key, old] of img.drawn) {
    if (img.drawn.size <= KEEP_PNGS) break
    if (shown.has(old.file)) continue
    img.drawn.delete(key)
    gone.push(old.file)
  }
  if (gone.length) void forget($, gone)
}

/**
 * The PNG's base64 for a `{ png }` source, read once per file and kept (the
 * engine scales `{ png }` bytes to the box; a `{ file }` PNG is drawn at its
 * own pixel size). Null when it is over 2 MiB or cannot be read: shown by path.
 */
async function loadBytes($: EngineInterface, file: string): Promise<string | null> {
  const known = img.bytes.get(file)
  if (known !== undefined) return known
  let b64: string | null = null
  try {
    const { base64 } = await $.fs.read(file, { as: 'bytes' })
    // a whole PNG (its signature, base64 `iVBORw0KGgo`) within the limit; else by path
    b64 = base64.startsWith('iVBORw0KGgo') && base64Bytes(base64) <= MAX_PNG_BYTES ? base64 : null
  } catch {
    // the path still works: the PNG is drawn at the box's pixel size
  }
  img.bytes.set(file, b64)
  return b64
}

/** Deletes PNGs (and only files in the session's temp dir). */
async function forget($: EngineInterface, files: string[]) {
  for (const f of files) img.bytes.delete(f)
  const mine = files.filter(f => f.includes('/shapethetalk-') && f.endsWith('.png'))
  if (!mine.length) return
  try {
    await $.process.run(['rm', '-f', ...mine], { timeoutMs: 3000 })
  } catch {
    // the temp dir goes at session end anyway
  }
}

async function which($: EngineInterface, name: string): Promise<string | null> {
  try {
    const r = await $.process.run(['which', name], { timeoutMs: 3000 })
    const path = r.stdout.trim().split('\n')[0] ?? ''
    return r.exitCode === 0 && path.startsWith('/') ? path : null
  } catch {
    return null
  }
}

/** rsvg-convert on PATH, else a Chrome-family browser; null when there is neither. */
async function findRasterizer($: EngineInterface): Promise<Rasterizer | null> {
  const rsvg = await which($, 'rsvg-convert')
  if (rsvg) return { kind: 'rsvg', bin: rsvg }
  for (const bin of CHROMES) {
    try {
      if (await $.fs.exists(bin)) return { kind: 'chrome', bin }
    } catch {
      // keep looking
    }
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const bin = await which($, name)
    if (bin) return { kind: 'chrome', bin }
  }
  return null
}

/**
 * Writes the SVG (and for Chrome its page) under dir, runs the rasteriser and
 * resolves the PNG's path; rejects when it fails or produces nothing.
 */
async function rasterize(
  $: EngineInterface,
  r: Rasterizer,
  dir: string,
  name: string,
  svg: string,
  pxW: number,
  pxH: number,
): Promise<string> {
  const png = `${dir}/${name}.png`
  const W = Math.round(pxW), H = Math.round(pxH)
  let argv: string[]
  if (r.kind === 'rsvg') {
    const file = `${dir}/${name}.svg`
    await $.fs.write(file, svg)
    argv = rsvgArgv(r.bin, file, png, W, H)
  } else {
    const file = `${dir}/${name}.html`
    await $.fs.write(file, wrapHtml(svg, W, H))
    argv = chromeArgv(r.bin, file, png, W, H, `${dir}/chrome-profile`)
  }
  const run = await $.process.run(argv, { timeoutMs: RASTER_TIMEOUT_MS })
  try {
    await $.process.run(['rm', '-f', argv[argv.length - 1]!.replace('file://', '')], { timeoutMs: 3000 })
  } catch {
    // the page is small; the temp dir goes at session end
  }
  if (run.exitCode !== 0) throw new Error(`${r.kind} exited ${run.exitCode}: ${run.stderr.trim().split('\n').slice(-1)[0] ?? ''}`)
  if (!(await $.fs.exists(png))) throw new Error(`${r.kind} wrote no PNG`)
  return png
}

export const register: Register = (on, options) => {
  // the terminal-browser pane the live look opens, and /browser; its closing:
  // an update no longer reopens it once the person closed it
  registerBrowser(on, isByPerson => {
    if (live.isOpen && isByPerson) live.isClosedByPerson = true
    live.isOpen = false
  })

  const lastDir = new Map<string, Dir>()
  const lastRichDir = new Map<string, Dir>()
  const richCache = new Map<string, { key: string; rich: Rich }>()
  const stillCache = new Map<string, { key: string; rich: Rich }>()
  const lastStillDir = new Map<string, Dir>()

  const layoutFor = (board: DBoard, layout: { [b: string]: DPlacement }) => placeNew(board, layout[board.id])

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: UPDATE_TOOL, description: UPDATE_DESCRIPTION, inputSchema: UPDATE_SCHEMA, isDeferred: false })
    await $.tool.register({ name: GET_TOOL, description: GET_DESCRIPTION, inputSchema: GET_SCHEMA, isDeferred: false })
    await $.command.register({
      name: 'diagram',
      description: 'Show the ShapeTheTalk diagram pane (open, close, clear, tidy, list, look, speed, cell, or a board to switch to)',
      argumentHint: '[open|close|clear|tidy|list|look image|grid|auto|live|speed slow|normal|fast|off|cell <w>x<h>|<board>]',
    })
    try {
      pane.isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    } catch {
      // the engine's record is a nicety; the flags still work without it
    }
    await detectImages($)
    // a reveal left in $.state by an earlier module load (hot reload, restart) can no longer
    // finish: show the whole board, and drop its highlight (its clearing timer is gone too)
    try {
      if ((await read($, revealAtom)) !== null) {
        await update($, revealAtom, () => null)
        await update($, recentAtom, () => null)
      }
    } catch {
      // the renderers ignore a reveal this module load is not driving anyway
    }
    const r = await next(e)
    // /browser and the optional browser tools (hooks/browser/), terminal sessions only, as terminal-browser's own plugin did after next
    let surfaces: readonly string[] = []
    try {
      surfaces = await $.session.surfaces()
    } catch {
      // none known: no /browser
    }
    if (surfaces.includes('terminal')) {
      // auto shows the live page where the terminal shows images and terminal-browser is installed:
      // look for it once, in the background (the picture until it answers)
      if (img.canShow) void checkBinary($)
      await $.command
        .register({ name: BROWSER_COMMAND, description: BROWSER_COMMAND_DESCRIPTION, argumentHint: '[url|close]', immediate: true })
        .catch(err => $.ui.log(`shapethetalk: /browser not registered: ${err}`))
      if (options.agentTool === true) {
        await $.tool
          .register({ name: BROWSER_OPEN_TOOL, description: BROWSER_OPEN_DESCRIPTION, inputSchema: BROWSER_OPEN_SCHEMA })
          .catch(err => $.ui.log(`shapethetalk: browser open tool not registered: ${err}`))
        await $.tool
          .register({ name: BROWSER_CLOSE_TOOL, description: BROWSER_CLOSE_DESCRIPTION })
          .catch(err => $.ui.log(`shapethetalk: browser close tool not registered: ${err}`))
      }
    }
    return r
  })

  // the PNGs live in a temp dir of the session's: gone with it
  on('session.end', async ($, e, next) => {
    const dir = img.dir || (await tempDir($))
    await update($, imagesAtom, () => ({}))
    if (dir.includes('/shapethetalk-')) await $.process.run(['rm', '-rf', dir], { timeoutMs: 3000 })
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------- tools

  on('tool.call', { tool: 'mcp__shapethetalk__update_diagram' }, async ($, e) => {
    // a reveal still going is fast-forwarded: what it hid shows with this call's first step
    const prev = run.isRunning ? await read($, revealAtom) : null
    const flushed = prev ? prev.queue.map(it => it.id) : []
    run.token++
    run.timer?.cancel()
    run.timer = null
    run.isRunning = false
    let out: ReturnType<typeof applyOps> | undefined
    const doc = await update($, docAtom, d => {
      out = applyOps(d, e.ops)
      return out.doc
    })
    const res = out!
    if (res.isChanged) {
      await update($, layoutAtom, layout => {
        const next = { ...layout }
        for (const id of Object.keys(next)) if (!doc.boards[id]) delete next[id]
        for (const b of res.boards) {
          const board = doc.boards[b]
          if (board) next[b] = placeNew(board, next[b])
        }
        return next
      })
      const active = doc.active ? doc.boards[doc.active] : undefined
      const speed = await read($, speedAtom)
      const reveal = active
        ? startReveal(active, res.added, res.changed, { seq: doc.version, now: await nowOf($), speed: isSpeed(speed) ? speed : DEFAULT_SPEED }, flushed)
        : null
      await update($, revealAtom, () => reveal)
      if (reveal) {
        run.isRunning = true
        await update($, recentAtom, () => ({ board: reveal.board, ...recentOf(reveal) }))
        scheduleStep($, run.token, reveal)
      } else {
        const early = active ? flushed.filter(id => active.nodes[id] || active.edges[id]) : []
        const recent: DRecent | null =
          active && (res.changed.length || early.length)
            ? { board: active.id, ids: [...new Set([...res.changed, ...early])], added: [...new Set([...res.added, ...early])], seq: doc.version * 1000 }
            : null
        await update($, recentAtom, () => recent)
        if (recent) clearRecentLater($, recent.seq)
      }
      // auto: the terminal-browser check answers first (once), so no pane opens before the page would
      await settleAuto($)
      const isLive = (await shownLook($)) === 'live'
      if (isLive) await refreshLive($)
      // the page polls board.js: open it once, never again after the person closed it; without
      // terminal-browser the pane shows the picture
      let isShown = isLive && (live.isOpen || live.isClosedByPerson)
      if (isLive && !isShown && live.hasBrowser !== false) {
        isShown = 'url' in (await openLive($))
        // the page is the diagram now: a pane opened before (say, while the check ran) would draw it twice
        if (isShown && pane.isOpen) {
          await $.ui.close({ id: PANE }).catch(() => undefined)
          pane.isOpen = false
        }
      }
      if (!isShown) {
        try {
          await openPane($, false)
        } catch {
          // the diagram is saved either way; /diagram opens the pane
        }
      }
    } else if (flushed.length) {
      // nothing changed, but the call still ends the reveal before it: show it all
      await update($, revealAtom, () => null)
      await refreshLive($)
    }
    const board =doc.active ? doc.boards[doc.active] : undefined
    const bigBy = board ? res.added.filter(id => board.nodes[id]).length : 0
    const hint =
      bigBy > BIG_CALL_NODES
        ? `\nNote: this call added ${bigBy} nodes at once. Next time add this in smaller steps while you explain: 1-3 nodes with their edges per call, a sentence or two between calls.`
        : bigBy > 0
          ? '\nNow explain this step to the user in a sentence or two before the next update_diagram call.'
          : ''
    return { result: res.text + hint }
  }).catch(($, e, next) => ({
    deny: `${PLUGIN}: update_diagram failed (${next.error.message ?? next.error.kind}); call get_diagram and try again.`,
  }))

  on('tool.call', { tool: 'mcp__shapethetalk__get_diagram' }, async $ => {
    const doc = await read($, docAtom)
    return { result: JSON.stringify(compact(doc)) }
  }).catch(($, e, next) => ({ deny: `${PLUGIN}: get_diagram failed (${next.error.message ?? next.error.kind}).` }))

  // ---------------------------------------------------------------- /diagram

  on('command.run', { command: 'diagram' }, async ($, e) => {
    const arg = e.args.trim()
    const word = arg.toLowerCase()
    if (word === '' || word === 'open') {
      if (word === '' && (pane.isOpen || live.isOpen)) return { text: await closeAll($) }
      // auto on a terminal that can: the live page in the browser pane (opened, or brought to the front)
      if ((await read($, lookAtom)) === 'auto') {
        await settleAuto($)
        if ((await shownLook($)) === 'live') {
          const opened = await openLive($)
          if ('url' in opened) {
            if (pane.isOpen) {
              await $.ui.close({ id: PANE })
              pane.isOpen = false
            }
            return { text: 'Live diagram opened in the browser pane.' }
          }
        }
      }
      await openPane($, true)
      return { text: 'Diagram pane opened.' }
    }
    if (word === 'close') return { text: await closeAll($) }
    if (word === 'clear') {
      await stopReveal($)
      await update($, docAtom, d => wipe(d))
      await update($, layoutAtom, () => ({}))
      await update($, recentAtom, () => null)
      await update($, panAtom, () => 0)
      await update($, imagePanAtom, () => 0)
      await update($, imagesAtom, () => ({}))
      void forget($, [...img.drawn.values()].map(i => i.file))
      img.drawn.clear()
      img.bytes.clear()
      richCache.clear()
      stillCache.clear()
      await refreshLive($)
      return {
        text: 'Cleared every diagram board.',
        context: ['The user ran /diagram clear: every ShapeTheTalk board is gone. If you draw again, start a new board; old ids no longer exist.'],
      }
    }
    if (word === 'tidy') {
      const doc = await read($, docAtom)
      const board = doc.active ? doc.boards[doc.active] : undefined
      if (!board) return { text: 'No diagram to tidy.' }
      await stopReveal($)
      await update($, layoutAtom, layout => ({ ...layout, [board.id]: fullLayout(board) }))
      await update($, panAtom, () => 0)
      await update($, imagePanAtom, () => 0)
      await refreshLive($)
      return { text: `Tidied "${board.title}".` }
    }
    if (word === 'look' || word.startsWith('look ')) {
      const want = word.slice(4).trim()
      if (want === 'live') {
        await update($, lookAtom, () => 'live' as DLook)
        img.broken = null
        img.failures = 0
        img.failed.clear()
        const opened = await openLive($)
        if ('url' in opened) {
          // the page is the diagram now: the pane would draw it twice
          if (pane.isOpen) {
            await $.ui.close({ id: PANE })
            pane.isOpen = false
          }
          return { text: `Terminal diagram look: live. Opened ${opened.url} in terminal-browser's pane; it follows the board as it changes. /diagram look auto goes back.` }
        }
        await openPane($, true)
        return {
          text:
            `Live look unavailable: ${opened.error}. Showing the hand-drawn picture in the pane instead (the look stays live and the page is kept up to date). ` +
            `Install it (${BROWSER_INSTALL_HINT}; it needs kitty or Ghostty, not tmux), then run /diagram look live again.`,
        }
      }
      if (want === 'image' || want === 'grid' || want === 'auto') {
        await update($, lookAtom, () => want)
        // auto that comes to live keeps the page open
        if ((await shownLook($)) !== 'live') await closeLive($)
        if (want !== 'grid') {
          // a manual switch is a fresh start for the rasteriser
          img.broken = null
          img.failures = 0
          img.failed.clear()
        }
        const how =
          want === 'image'
            ? 'the hand-drawn picture (needs kitty or Ghostty, and Chrome or rsvg-convert)'
            : want === 'grid'
              ? 'the box-drawing grid'
              : `auto (${await autoSays($)})`
        return { text: `Terminal diagram look: ${how}.` }
      }
      const look = await read($, lookAtom)
      const now = look === 'auto' ? ` (${await autoSays($)})` : ''
      return { text: `Terminal diagram look is ${look}${now}. Use /diagram look image|grid|auto|live.` }
    }
    if (word === 'speed' || word.startsWith('speed ')) {
      const want = word.slice(5).trim()
      const cur = await read($, speedAtom)
      const says = (sp: DSpeed) =>
        sp === 'off' ? 'off (each update appears at once)' : `${sp} (a node every ${SPEEDS[sp].node} ms, an edge every ${SPEEDS[sp].edge} ms)`
      if (!want) return { text: `Diagram build speed: ${says(cur)}. Use /diagram speed ${SPEED_NAMES.join('|')}.` }
      if (!isSpeed(want)) return { text: `Not a speed: "${want}". Use /diagram speed ${SPEED_NAMES.join('|')}.` }
      await update($, speedAtom, () => want)
      if (want === 'off') {
        await stopReveal($)
        await refreshLive($)
      }
      return { text: `Diagram build speed: ${says(want)}.` }
    }
    if (word === 'cell' || word.startsWith('cell ')) {
      const want = word.slice(4).trim()
      const cur = cellOf(await read($, cellAtom))
      if (!want) return { text: `Terminal cell size: ${cur.w}x${cur.h} device px (default ${DEFAULT_CELL.w}x${DEFAULT_CELL.h}). Use /diagram cell <w>x<h>, or /diagram cell default.` }
      const cell = want === 'default' || want === 'reset' ? DEFAULT_CELL : parseCell(want)
      if (!cell) return { text: `Not a cell size: "${want}". Use device pixels, e.g. /diagram cell 16x34 (width 4-64, height 4-128).` }
      await update($, cellAtom, () => cell)
      return { text: `Terminal cell size set to ${cell.w}x${cell.h} device px: pictures are drawn at exactly that many pixels per cell.` }
    }
    if (word === 'list') {
      const doc = await read($, docAtom)
      if (!doc.order.length) return { text: 'No diagram boards yet.' }
      const lines = doc.order.map(id => {
        const b = doc.boards[id]!
        return `${id === doc.active ? '*' : ' '} ${id}: ${b.title} (${Object.keys(b.nodes).length} nodes, ${Object.keys(b.edges).length} edges)`
      })
      return { text: lines.join('\n') }
    }
    const doc = await read($, docAtom)
    const id = findBoard(doc, arg)
    if (!id) return { text: `No board "${arg}". Boards: ${doc.order.join(', ') || 'none'}.` }
    await stopReveal($)
    await update($, docAtom, d => switchTo(d, id))
    await update($, panAtom, () => 0)
    await update($, imagePanAtom, () => 0)
    await refreshLive($)
    if (!live.isOpen) await openPane($, true)
    const title = doc.boards[id]!.title
    return {
      text: `Switched to "${title}".`,
      context: [`The user switched the diagram to board "${id}" (${title}); update_diagram ops now apply to it.`],
    }
  })

  // ---------------------------------------------------------------- pane

  on('ui.close', { id: PANE }, ($, e, next) => {
    pane.isOpen = false
    if (e.origin.kind === 'person') pane.isClosedByPerson = true
    return next(e)
  }).catch(($, e, next) => next(e))

  // a wheel tick at the edge of a pane with nothing to scroll: no move, no redraw
  on('ui.scroll', { component: 'Pane', requestId: PANE }, ($, e, next) => (e.contentRows <= e.bodyRows ? {} : next(e))).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const doc: DDoc = await read($, docAtom)
    const layout = await read($, layoutAtom)
    const recent = await read($, recentAtom)
    const full = doc.active ? doc.boards[doc.active] : undefined
    // what a staggered reveal shows so far (the whole board when none runs)
    const board = full ? await shownBoard($, full) : undefined
    const bodyColumns = Math.max(20, e.props.bodyColumns)
    const bodyRows = e.props.scroll.bodyRows

    const selectBoard = (id: string) => async () => {
      await stopReveal($)
      await update($, docAtom, d => switchTo(d, id))
      await update($, panAtom, () => 0)
      await update($, imagePanAtom, () => 0)
      await refreshLive($)
    }
    const highlight = board && recent && recent.board === board.id ? recent.ids : []
    const header = board
      ? `${board.title} · ${Object.keys(board.nodes).length} nodes · ${Object.keys(board.edges).length} edges · v${doc.version}`
      : ''
    const hasTabs = doc.order.length > 1

    if (e.surface === 'terminal') {
      const { Box, Text, Button, Raster, Image } = $.ui.resolve(e)
      const look = await read($, lookAtom)
      const isLive = look === 'live' || (await shownLook($, look)) === 'live'
      // auto: a missing terminal-browser says nothing (the picture is the look); a failed open a dim line
      const autoNote = look === 'auto' && live.hasBinary === true && live.hasBrowser === false
        ? <Text dimColor>Live page unavailable; showing the picture. /diagram look live says why.</Text>
        : null
      const liveNote = !isLive
        ? autoNote
        : live.hasBrowser === false
          ? <Text color="#e8590c">{live.why}</Text>
          : <Text dimColor>{live.isOpen ? 'Live page open in the browser pane.' : look === 'auto' ? 'Live look: /diagram opens the page.' : 'Live look: /diagram look live opens the page.'}</Text>
      if (!board) {
        return (
          <Box flexDirection="column">
            <Text dimColor>No diagram yet. Ask Claude to explain something and draw it, or run /diagram list.</Text>
          </Box>
        )
      }
      const placement = layoutFor(board, layout)
      const tabs = hasTabs && (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {doc.order.map(id => (
            <Button
              key={`tab-${id}`}
              label={cut(doc.boards[id]?.title ?? id, 24)}
              variant={id === doc.active ? 'primary' : 'secondary'}
              onPress={selectBoard(id)}
            />
          ))}
        </Box>
      )

      // the hand-drawn picture, where the terminal shows images
      let note = ''
      if (await wantsImage($)) {
        const cell = cellOf(await read($, cellAtom))
        const css = cssCell(cell)
        const roomRows = Math.max(8, bodyRows - (hasTabs ? 2 : 1) - 1)
        const maxWidth = bodyColumns * css.w
        const maxHeight = roomRows * css.h
        const recentHere = recent && recent.board === board.id ? recent : null
        const stillKey = JSON.stringify([board.id, doc.version, placement, recentHere?.seq ?? null, maxWidth, maxHeight])
        let still = stillCache.get(board.id)
        if (!still || still.key !== stillKey) {
          const rich = renderRich(board, placement, {
            maxWidth,
            maxHeight,
            prefer: lastStillDir.get(board.id),
            recent: recentHere ? { ids: recentHere.ids, added: recentHere.added } : null,
            chip: recentHere?.newest,
            isStatic: true,
            limit: 4_000_000,
          })
          still = { key: stillKey, rich }
          stillCache.set(board.id, still)
          lastStillDir.set(board.id, rich.dir)
        }
        const { rich } = still
        // zoom and pan pick the window drawn: a new PNG (a new file) per size and crop, rasterised at
        // exactly the box's device pixels (cell size × cells), never wider than the pane (wider pictures pan instead)
        const viewColumns = Math.min(bodyColumns, MAX_CELLS)
        const viewRows = Math.max(4, bodyRows - (hasTabs ? 1 : 0) - 2)
        const zoom = await read($, zoomAtom)
        const fitK = fitScale(rich.width, rich.height, viewColumns, viewRows, cell)
        const view = imageView(rich.width, rich.height, zoom > 0 ? zoom : fitK, viewColumns, await read($, imagePanAtom), cell)
        const pngKey = `${stillKey}|${view.k.toFixed(4)}|${view.startColumn}|${view.columns}|${view.rows}|${view.pxW}x${view.pxH}`
        const failure = img.broken ?? img.failed.get(pngKey)
        if (failure) {
          note = `Picture unavailable (${cut(failure, 80)}); showing the grid. /diagram look grid hides this.`
        } else {
          const kept = img.drawn.get(pngKey)
          const shown = kept ?? (await read($, imagesAtom))[board.id]
          const isFresh = !!shown && shown.key === pngKey
          if (kept) {
            // a zoom or pan seen before: its PNG is still on disk (and now the newest kept)
            img.drawn.delete(pngKey)
            img.drawn.set(pngKey, kept)
          }
          if (!isFresh) {
            requestPng($, {
              board: board.id,
              key: pngKey,
              svg: cropSvg(rich.source, view.cropX, view.cropY, view.cropW, view.cropH, rich.width, rich.height, view.pxW, view.pxH),
              width: view.cropW,
              height: view.cropH,
              pxW: view.pxW,
              pxH: view.pxH,
              columns: view.columns,
              rows: view.rows,
            })
          }
          if (shown) img.waitSince = null
          if (shown) {
            // until the new PNG lands the old one stays, in the box it was drawn for
            const box = shown.columns && shown.rows ? { columns: shown.columns, rows: shown.rows } : { columns: view.columns, rows: view.rows }
            const curK = view.k
            const keepCenter = (k: number) => {
              const k2 = Math.min(k, view.maxK)
              const total = Math.max(1, (rich.width * k2) / css.w)
              const center = (view.startColumn + view.columns / 2) / view.totalColumns
              return Math.max(0, center - Math.min(total, viewColumns) / 2 / total)
            }
            const zoomTo = async (k: number) => {
              const k2 = Math.max(0.05, Math.min(k, view.maxK))
              await update($, imagePanAtom, () => keepCenter(k2))
              await update($, zoomAtom, () => k2)
            }
            const canZoomIn = Math.min(zoomIn(curK), view.maxK) > curK + 0.001
            const isWider = view.columns < view.totalColumns
            const step = Math.max(4, Math.floor(view.columns * 0.6))
            const maxStart = view.totalColumns - view.columns
            const panTo = (col: number) => () => update($, imagePanAtom, () => Math.max(0, Math.min(maxStart, col)) / view.totalColumns)
            // bytes, so the terminal scales the PNG to the box; by path (drawn at its own pixel size, which is
            // the box's) only when it is over 2 MiB or unreadable
            const b64 = await loadBytes($, shown.file)
            const source = b64 ? { png: b64 } : { file: shown.file, format: 'png' as const }
            return (
              <Box flexDirection="column">
                <Text bold>
                  {header}
                  {isFresh ? '' : <Text dimColor> · drawing…</Text>}
                  {1 + (hasTabs ? 1 : 0) + 1 + box.rows > bodyRows ? <Text dimColor> · scroll for more</Text> : ''}
                </Text>
                {liveNote}
                {tabs}
                <Box flexDirection="row" gap={1} flexWrap="wrap">
                  <Button key="zoom-out" label="−" onPress={() => zoomTo(zoomOut(curK))} />
                  <Button key="zoom-fit" label="Fit" onPress={async () => {
                    await update($, imagePanAtom, () => 0)
                    await update($, zoomAtom, () => 0)
                  }} />
                  <Button key="zoom-100" label="100%" onPress={() => zoomTo(1)} />
                  <Button
                    key="zoom-in"
                    label="+"
                    dimColor={!canZoomIn}
                    onPress={() => (canZoomIn ? zoomTo(Math.min(zoomIn(curK), view.maxK)) : undefined)}
                  />
                  {isWider && <Button key="pan-left" label="◀" dimColor={view.startColumn <= 0} onPress={panTo(view.startColumn - step)} />}
                  {isWider && <Button key="pan-right" label="▶" dimColor={view.startColumn >= maxStart} onPress={panTo(view.startColumn + step)} />}
                  <Text dimColor>
                    {Math.round(curK * 100)}%{canZoomIn ? '' : ' (largest)'}
                    {isWider ? ` · columns ${view.startColumn + 1}-${view.startColumn + view.columns} of ${view.totalColumns}` : ''}
                  </Text>
                </Box>
                <Image key="board-image" source={source} columns={box.columns} rows={box.rows} alt={summary(doc)} />
              </Box>
            )
          }
          note = 'Drawing the picture…'
          // the first picture is usually under a second away: a quiet line, not the grid, until then
          const now = await nowOf($)
          if (img.waitSince === null) {
            img.waitSince = now
            $.clock.after(IMAGE_WAIT_MS + 50, () => $.ui.invalidate('ui.render'))
          }
          if (now - img.waitSince < IMAGE_WAIT_MS) {
            return (
              <Box flexDirection="column">
                <Text bold>{header}</Text>
                {liveNote}
                {tabs}
                <Text dimColor>{note}</Text>
              </Box>
            )
          }
        }
      }

      const grid = renderGrid(board, placement, { columns: bodyColumns, prefer: lastDir.get(board.id), highlight })
      lastDir.set(board.id, grid.dir)
      const pan = Math.max(0, Math.min(await read($, panAtom), grid.width - bodyColumns))
      const raster = encodeRaster(grid, pan, bodyColumns)
      const isWide = grid.width > bodyColumns
      const used = 1 + (hasTabs ? 1 : 0) + (isWide ? 1 : 0) + raster.rows + 1 + (grid.undrawn.length ? 1 : 0) + (note ? 1 : 0)
      const step = Math.max(10, Math.floor(bodyColumns * 0.6))
      const maxPan = Math.max(0, grid.width - bodyColumns)
      return (
        <Box flexDirection="column">
          <Text bold>
            {header}
            {used > bodyRows ? <Text dimColor> · scroll for more</Text> : ''}
          </Text>
          {note && <Text dimColor>{note}</Text>}
          {liveNote}
          {tabs}
          {isWide && (
            <Box flexDirection="row" gap={1}>
              <Button key="pan-left" label="◀" onPress={() => update($, panAtom, p => Math.max(0, Math.min(p, maxPan) - step))} />
              <Button key="pan-right" label="▶" onPress={() => update($, panAtom, p => Math.min(maxPan, Math.min(p, maxPan) + step))} />
              <Text dimColor>
                columns {pan + 1}-{pan + raster.columns} of {grid.width}
              </Text>
            </Box>
          )}
          <Raster key="board" columns={raster.columns} rows={raster.rows} cells={raster.cells} />
          {grid.undrawn.length > 0 && (
            <Text color="#fa5252">
              {grid.undrawn.length} edge(s) not drawn: {grid.undrawn.join(', ')}
            </Text>
          )}
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            <Text color={hex(COLORS.actor)}>╭╮ actor</Text>
            <Text color={hex(COLORS.system)}>╔╗ system</Text>
            <Text>┌┐ step</Text>
            <Text color={hex(COLORS.decision)}>╱╲ decision</Text>
            <Text color={hex(COLORS.data)}>╭═╮ data</Text>
            <Text color={hex(COLORS.ghost)}>┄ proposed</Text>
            <Text color={hex(COLORS.disputed)}>! disputed</Text>
            <Text color={hex(COLORS.resolved)}>✓ resolved</Text>
          </Box>
        </Box>
      )
    }

    // desktop, vscode, mobile: the hand-drawn SVG, as an image
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    if (!board) {
      return (
        <Box flexDirection="column">
          <Svg source={emptySvg()} alt="No diagram yet" width={Math.round(Math.min(520, bodyColumns * CELL_W - 4))} />
        </Box>
      )
    }
    const room = Math.max(12, bodyRows - (hasTabs ? 4 : 2) - 2)
    const maxWidth = bodyColumns * CELL_W - 4
    const maxHeight = room * CELL_H
    const placement = layoutFor(board, layout)
    const prefer = lastRichDir.get(board.id)
    const key = JSON.stringify([board.id, doc.version, placement, recent?.seq ?? null, prefer ?? null, maxWidth, maxHeight])
    let cached = richCache.get(board.id)
    if (!cached || cached.key !== key) {
      // a new source restarts every animation in it: during a reveal only the latest step pops in
      const here = recent && recent.board === board.id ? recent : null
      const stepIds = here?.step ?? null
      const rich = renderRich(board, placement, {
        maxWidth,
        maxHeight,
        prefer,
        recent: here ? (stepIds ? { ids: stepIds, added: (here.added ?? []).filter(id => stepIds.includes(id)) } : { ids: here.ids, added: here.added }) : null,
        chip: here?.newest,
      })
      cached = { key, rich }
      richCache.set(board.id, cached)
      lastRichDir.set(board.id, rich.dir)
    }
    const { rich } = cached
    const zoom = await read($, zoomAtom)
    const fitK = Math.min(maxWidth / rich.width, ((room - 1) * CELL_H) / rich.height)
    const k = zoom > 0 ? zoom : fitK
    const width = Math.max(1, Math.round(rich.width * k))
    const height = Math.max(1, Math.round(rich.height * k))
    const isWider = width > maxWidth + 1
    return (
      <Box flexDirection="column">
        <Text bold>{header}</Text>
        {hasTabs && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {doc.order.map(id => (
              <Button
                key={`tab-${id}`}
                label={cut(doc.boards[id]?.title ?? id, 24)}
                variant={id === doc.active ? 'primary' : 'secondary'}
                onPress={selectBoard(id)}
              />
            ))}
          </Box>
        )}
        <Box flexDirection="row" gap={1} alignItems="center">
          <Button key="zoom-out" label="−" onPress={() => update($, zoomAtom, z => zoomOut(z > 0 ? z : fitK))} />
          <Button key="zoom-fit" label="Fit" onPress={() => update($, zoomAtom, () => 0)} />
          <Button key="zoom-100" label="100%" onPress={() => update($, zoomAtom, () => 1)} />
          <Button key="zoom-in" label="+" onPress={() => update($, zoomAtom, z => zoomIn(z > 0 ? z : fitK))} />
          <Text dimColor>
            {Math.round(k * 100)}%{isWider ? ' · wider than the pane' : ''}
          </Text>
        </Box>
        <Svg source={rich.source} width={width} height={height} alt={summary(doc)} />
      </Box>
    )
  })
}

function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0')
}
