// Rasterises the sample boards the way the terminal pane does (the still SVG,
// the same rsvg-convert / Chrome argv and sizing as register.tsx) into
// preview/<name>.still.png, and prints how long each took.
// Run: node scripts/still.ts [paneColumns=80] [paneRows=50] [zoom=fit|k] [left=0..1] [cell=16x34]
// A zoom wider than the pane rasterises only the window starting at `left`.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fullLayout } from '../hooks/layout.ts'
import { CHROMES, DEFAULT_CELL, chromeArgv, cropSvg, cssCell, fitScale, imageView, parseCell, rsvgArgv, wrapHtml } from '../hooks/raster.ts'
import { renderRich } from '../hooks/rich.ts'
import { SAMPLES, boardFrom } from './samples.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', 'preview')
mkdirSync(dir, { recursive: true })

const columns = Number(process.argv[2] ?? 80)
const rows = Number(process.argv[3] ?? 50)
const zoomArg = process.argv[4] ?? 'fit'
const left = Number(process.argv[5] ?? 0)
const cell = parseCell(process.argv[6] ?? '') ?? DEFAULT_CELL
const css = cssCell(cell)
const which = (name: string) => {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}
const rsvg = which('rsvg-convert')
const chrome = CHROMES.find(p => existsSync(p)) ?? which('google-chrome') ?? which('chromium')
if (!rsvg && !chrome) throw new Error('no rsvg-convert or Chrome')
console.log(`rasteriser: ${rsvg ? 'rsvg-convert' : chrome}; pane ${columns}x${rows}; cell ${cell.w}x${cell.h} device px`)

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
for (const s of SAMPLES) {
  const board = boardFrom(s.ops)
  const placement = fullLayout(board)
  const ids = Object.keys(board.nodes)
  const recent = { ids: [ids[1] ?? '', ...Object.keys(board.edges).slice(0, 1)], added: [ids[1] ?? ''] }
  const rich = renderRich(board, placement, {
    maxWidth: columns * css.w,
    maxHeight: (rows - 3) * css.h,
    recent,
    isStatic: true,
    limit: 4_000_000,
  })
  const fitK = fitScale(rich.width, rich.height, Math.min(columns, 255), Math.max(4, rows - 2), cell)
  const view = imageView(rich.width, rich.height, zoomArg === 'fit' ? fitK : Number(zoomArg), Math.min(columns, 255), left, cell)
  const svg = cropSvg(rich.source, view.cropX, view.cropY, view.cropW, view.cropH, rich.width, rich.height, view.pxW, view.pxH)
  const name = `${slug(s.name)}.still${zoomArg === 'fit' ? '' : `-${zoomArg}x-${left}`}`
  const png = join(dir, `${name}.png`)
  let argv: string[]
  if (rsvg) {
    writeFileSync(join(dir, `${name}.svg`), svg)
    argv = rsvgArgv(rsvg, join(dir, `${name}.svg`), png, view.pxW, view.pxH)
  } else {
    writeFileSync(join(dir, `${name}.html`), wrapHtml(svg, view.pxW, view.pxH))
    argv = chromeArgv(chrome!, join(dir, `${name}.html`), png, view.pxW, view.pxH, join(dir, '.chrome-profile'))
  }
  const t0 = performance.now()
  execFileSync(argv[0]!, argv.slice(1), { stdio: 'ignore', timeout: 8000 })
  const ms = Math.round(performance.now() - t0)
  const at = view.columns < view.totalColumns ? `, columns ${view.startColumn + 1}-${view.startColumn + view.columns} of ${view.totalColumns}` : ''
  // the PNG's real size, from its IHDR
  const ihdr = readFileSync(png).subarray(16, 24)
  const realW = ihdr.readUInt32BE(0), realH = ihdr.readUInt32BE(4)
  const boxW = view.columns * cell.w, boxH = view.rows * cell.h
  const ok = realW === view.pxW && realH === view.pxH ? (realW === boxW && realH === boxH ? '= box' : 'box shrunk to 4096') : 'MISMATCH'
  console.log(`${s.name}: ${rich.width}x${rich.height} px, k ${view.k.toFixed(2)} (max ${view.maxK.toFixed(2)}), ${rich.dir}, ${view.columns}x${view.rows} cells${at} = ${boxW}x${boxH} device px; PNG ${realW}x${realH} (${ok}), ${ms} ms -> ${png}`)
}
