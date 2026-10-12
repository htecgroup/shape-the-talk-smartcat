// Terminal image: the still hand-drawn SVG (rich.ts, isStatic) turned into a
// PNG on the host, shown with the terminal's Image element (kitty, Ghostty).
// rsvg-convert when it is on PATH, else headless Chrome. This file is the pure
// part (sizing, argv, detection); register.tsx runs the commands ($ may only
// be handed to functions declared there).

/**
 * One terminal cell in device pixels, by default Ghostty's on a Retina Mac at
 * its default font (measured: 16×34). The engine reports no cell pixel size;
 * `/diagram cell <w>x<h>` sets it for another font or screen.
 */
export type Cell = { w: number; h: number }
export const DEFAULT_CELL: Cell = { w: 16, h: 34 }
/** At 100% one column stands for this many drawing px (CSS px): 2 device px per drawing px at a 16 px cell. */
export const COL_PX = 8
/** The Image element's limit on columns and rows. */
export const MAX_CELLS = 255
/** A small board is drawn at most this much larger than its natural size when fitted. */
export const MAX_FIT = 1.6
/** How long one rasterise may take before it is killed (well under a hook's 10 s). */
export const RASTER_TIMEOUT_MS = 8000
/** The most bytes a `{ png }` Image source may hold (decoded); a larger PNG is shown by path. */
export const MAX_PNG_BYTES = 2 * 1024 * 1024
/** The engine refuses a `{ png }` whose side is over this many pixels. */
export const MAX_PNG_SIDE = 4096

export type Rasterizer = { kind: 'rsvg' | 'chrome'; bin: string }

/** Parses `16x34` (device px, each 4-64); null when it is not one. */
export function parseCell(s: string): Cell | null {
  const m = /^\s*(\d{1,2})\s*[x×*]\s*(\d{1,3})\s*$/i.exec(s)
  if (!m) return null
  const w = Number(m[1]), h = Number(m[2])
  return w >= 4 && w <= 64 && h >= 4 && h <= 128 ? { w, h } : null
}

/** A cell size usable for sizing (falls back to the default for a bad one). */
export const cellOf = (c: Partial<Cell> | null | undefined): Cell =>
  c && Number(c.w) >= 4 && Number(c.h) >= 4 ? { w: Number(c.w), h: Number(c.h) } : DEFAULT_CELL

/** Drawing px (CSS px) per column and per row at 100%. */
export const cssCell = (cell: Cell) => ({ w: COL_PX, h: (COL_PX * cell.h) / cell.w })

/** Device px per drawing px at scale k. */
export const devicePerPx = (k: number, cell: Cell) => (k * cell.w) / COL_PX

/** Above this many rows' worth the Image cannot grow: the largest k for a drawing h px tall. */
export function maxScale(h: number, cell: Cell = DEFAULT_CELL): number {
  return (MAX_CELLS * cssCell(cell).h) / Math.max(1, h)
}

/**
 * The scale that fits a drawing of natural size w×h px into a box of
 * viewColumns × viewRows cells: both dimensions, at most MAX_FIT (a two-node
 * board is not drawn huge) and at most what 255 rows allow.
 */
export function fitScale(w: number, h: number, viewColumns: number, viewRows: number, cell: Cell = DEFAULT_CELL): number {
  const c = cssCell(cell)
  const byW = (Math.max(1, Math.floor(viewColumns)) * c.w) / Math.max(1, w)
  const byH = (Math.max(1, Math.floor(viewRows)) * c.h) / Math.max(1, h)
  return Math.max(0.05, Math.min(MAX_FIT, byW, byH, maxScale(h, cell)))
}

/** What the terminal shows of a drawing at one zoom and pan. */
export type ImageView = {
  /** The scale drawn (the asked one, at most maxK). */
  k: number
  /** The largest scale whose box fits the Image's 255 rows. */
  maxK: number
  /** The Image box: at most viewColumns wide, at most 255 rows. */
  columns: number
  rows: number
  /** How many columns the whole drawing takes at k, and the first one shown (0-based). */
  totalColumns: number
  startColumn: number
  /**
   * The window of the drawing rasterised, in drawing px: exactly the box at k
   * (so the PNG fills it unstretched); past the drawing's edge by at most half
   * a cell, which the paper fills.
   */
  cropX: number
  cropY: number
  cropW: number
  cropH: number
  /**
   * The PNG's size in pixels: the box's device pixels (columns × cell.w by
   * rows × cell.h), or that shrunk evenly to fit MAX_PNG_SIDE (then the
   * terminal scales it up to the box, a little softer).
   */
  pxW: number
  pxH: number
}

/**
 * The window of a drawing w×h px at scale k in a pane viewColumns wide, its
 * left edge at `left` (a fraction of the drawing's width, clamped so the
 * window stays on the drawing). When the drawing is wider than the pane only
 * the window is rasterised, so the Image box is never wider than the pane.
 * The PNG is drawn at exactly the box's device-pixel size.
 */
export function imageView(w: number, h: number, k: number, viewColumns: number, left: number, cell: Cell = DEFAULT_CELL): ImageView {
  const c = cssCell(cell)
  const maxK = maxScale(h, cell)
  const kk = Math.max(0.05, Math.min(k, maxK))
  const view = Math.max(1, Math.min(MAX_CELLS, Math.floor(viewColumns)))
  const totalColumns = Math.max(1, Math.round((w * kk) / c.w))
  const columns = Math.min(totalColumns, view)
  const maxStart = totalColumns - columns
  const startColumn = Math.max(0, Math.min(maxStart, Math.round((Number.isFinite(left) ? left : 0) * totalColumns)))
  const rows = Math.max(1, Math.min(MAX_CELLS, Math.round((h * kk) / c.h)))
  const cropW = (columns * c.w) / kk
  const cropH = (rows * c.h) / kk
  // the whole width: centred (the rounding split both sides); a window: from its column
  const cropX = columns < totalColumns ? (startColumn * c.w) / kk : (w - cropW) / 2
  const cropY = (h - cropH) / 2
  const fullW = columns * cell.w, fullH = rows * cell.h
  const f = Math.min(1, MAX_PNG_SIDE / fullW, MAX_PNG_SIDE / fullH)
  const pxW = f < 1 ? Math.max(1, Math.min(MAX_PNG_SIDE, Math.round(fullW * f))) : fullW
  const pxH = f < 1 ? Math.max(1, Math.min(MAX_PNG_SIDE, Math.round(fullH * f))) : fullH
  return { k: kk, maxK, columns, rows, totalColumns, startColumn, cropX, cropY, cropW, cropH, pxW, pxH }
}

/**
 * The still SVG cut to the window (x, y, cw, ch) of its natural size w×h
 * (drawing px) and sized pxW×pxH: the root's viewBox, width and height
 * replaced, so either rasteriser draws exactly that window at exactly that
 * many pixels. Unchanged when the root has no viewBox.
 */
export function cropSvg(svg: string, x: number, y: number, cw: number, ch: number, w: number, h: number, pxW: number, pxH: number): string {
  const m = /^<svg\b[^>]*>/.exec(svg)
  if (!m) return svg
  const root = m[0]
  const vb = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(root)
  if (!vb) return svg
  const [vx, vy, vw, vh] = vb.slice(1).map(Number) as [number, number, number, number]
  const perX = vw / Math.max(1, w)
  const perY = vh / Math.max(1, h)
  const r = (n: number) => Math.round(n * 1000) / 1000
  let next = root.replace(vb[0], `viewBox="${r(vx + x * perX)} ${r(vy + y * perY)} ${r(cw * perX)} ${r(ch * perY)}"`)
  for (const [attr, val] of [['width', pxW], ['height', pxH]] as const) {
    const re = new RegExp(`\\s${attr}="[^"]*"`)
    next = re.test(next) ? next.replace(re, ` ${attr}="${Math.round(val)}"`) : next.replace('<svg', `<svg ${attr}="${Math.round(val)}"`)
  }
  // the box's aspect is the window's: nothing to letterbox
  next = /preserveAspectRatio="[^"]*"/.test(next) ? next.replace(/preserveAspectRatio="[^"]*"/, 'preserveAspectRatio="none"') : next
  return next + svg.slice(root.length)
}

/** Decoded size of standard padded base64. */
export const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)

/** Whether the terminal draws Image pixels: kitty or Ghostty, not under tmux or screen. */
export function supportsImages(env: { TERM_PROGRAM?: string; TERM?: string; KITTY_WINDOW_ID?: string; GHOSTTY_RESOURCES_DIR?: string; TMUX?: string }): boolean {
  if (env.TMUX) return false
  const prog = (env.TERM_PROGRAM ?? '').toLowerCase()
  const term = (env.TERM ?? '').toLowerCase()
  if (prog === 'tmux' || prog === 'screen' || term.startsWith('screen') || term.startsWith('tmux')) return false
  return prog === 'ghostty' || prog === 'kitty' || term.includes('ghostty') || term.includes('kitty') || !!env.KITTY_WINDOW_ID || !!env.GHOSTTY_RESOURCES_DIR
}

/** A page holding the SVG at exactly w×h px, for Chrome's screenshot (at device scale 1, so px are the PNG's). */
export function wrapHtml(svg: string, w: number, h: number): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:#fbfaf6}` +
    `svg{display:block;width:${w}px;height:${h}px}</style></head><body>${svg}</body></html>`
  )
}

export function chromeArgv(bin: string, html: string, png: string, w: number, h: number, profile: string): string[] {
  return [
    bin,
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    `--user-data-dir=${profile}`,
    '--force-device-scale-factor=1',
    `--window-size=${w},${h}`,
    `--screenshot=${png}`,
    `file://${html}`,
  ]
}

/** rsvg-convert drawing the SVG at exactly w×h px. */
export function rsvgArgv(bin: string, svg: string, png: string, w: number, h: number): string[] {
  return [bin, '-w', String(Math.round(w)), '-h', String(Math.round(h)), '-b', '#fbfaf6', '-o', png, svg]
}

export const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]
