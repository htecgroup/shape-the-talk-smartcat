// Writes SVG preview pages for the sample boards into preview/: the desktop
// renderer's SVG shown as an image (as the Desktop app shows it) at a pane's
// width, and beside it the same board drawn by the web whiteboard
// (static/board/*.js of this repo), to compare the hand-drawn look.
// Run: node scripts/preview.ts, then serve the repo root (python3 -m http.server)
// and open /claude-mod/shapethetalk/preview/index.html.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fullLayout } from '../hooks/layout.ts'
import { renderRich } from '../hooks/rich.ts'
import { SAMPLES, boardFrom } from './samples.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', 'preview')
mkdirSync(dir, { recursive: true })

const PANE_COLUMNS = 90 // a docked pane in the Desktop app
const PANE_ROWS = 46
const CELL_W = 7.8
const CELL_H = 20
const maxWidth = PANE_COLUMNS * CELL_W - 4
const maxHeight = (PANE_ROWS - 4) * CELL_H

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// the web app's board markup (static/index.html), for the comparison panel
const WEB_SVG = `<svg id="svg" xmlns="http://www.w3.org/2000/svg"><defs>
<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.3" fill="#d4d0c4"/></pattern>
<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="#495057" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
<marker id="arrow-ghost" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="#adb5bd" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
<marker id="arrow-disputed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="#e03131" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>
</defs><rect x="-50000" y="-50000" width="100000" height="100000" fill="url(#dots)"/>
<g id="camera"><g id="groupsLayer"></g><g id="edgesLayer"></g><g id="nodesLayer"></g><g id="fxLayer"></g></g></svg>`

const index: string[] = []
for (const s of SAMPLES) {
  const board = boardFrom(s.ops)
  const placement = fullLayout(board)
  const anyId = Object.keys(board.nodes)[1] ?? ''
  const rich = renderRich(board, placement, { maxWidth, maxHeight, recent: { ids: [anyId], added: [anyId] } })
  const k = Math.min(1, maxWidth / rich.width)
  const file = `${slug(s.name)}.html`
  writeFileSync(join(dir, `${slug(s.name)}.svg`), rich.source)
  const webBoard = { ...board, groups: {} }
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(s.name)} preview</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Kalam:wght@400;700&family=Inter:wght@400;600;700&display=swap">
<link rel="stylesheet" href="../../../static/style.css">
<style>
  body { display: block; height: auto; background: #f3f1ec; padding: 16px; font-family: Inter, system-ui, sans-serif; }
  .row { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
  .panel { background: #fff; border: 1px solid #e6e2d9; border-radius: 12px; padding: 10px; }
  .panel h2 { font-size: 13px; margin: 0 0 8px; color: #4a5059; }
  .pane { width: ${Math.round(maxWidth)}px; background: #1f1f1f0a; }
  .pane img { display: block; }
  #board { position: relative; flex: none; width: 760px; height: 640px !important; background: #fbfaf6; border-radius: 8px; overflow: hidden; }
  .meta { font-size: 12px; color: #8a909a; margin-top: 6px; }
</style></head><body>
<p><a href="index.html">all samples</a> · <b>${esc(s.name)}</b></p>
<div class="row">
  <div class="panel"><h2>Desktop pane (mod, Svg as an image, ${PANE_COLUMNS} columns)</h2>
    <div class="pane"><img src="${file.replace('.html', '.svg')}" width="${Math.round(rich.width * k)}" height="${Math.round(rich.height * k)}" alt="${esc(board.title)}"></div>
    <div class="meta">${rich.dir} · quality ${rich.quality} · ${rich.source.length.toLocaleString('en')} chars · natural ${Math.round(rich.width)}×${Math.round(rich.height)} px, shown at ${Math.round(k * 100)}%</div>
  </div>
  <div class="panel"><h2>Web whiteboard (static/board/*.js)</h2>
    <div class="board" id="board">${WEB_SVG}<div id="tooltip" class="tooltip" hidden></div></div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/roughjs@4.6.6/bundled/rough.js"></script>
<script src="../../../static/board/svg.js"></script>
<script src="../../../static/board/shapes.js"></script>
<script src="../../../static/board/place.js"></script>
<script src="../../../static/board/tidy.js"></script>
<script src="../../../static/board/routing.js"></script>
<script src="../../../static/board/board.js"></script>
<script>
  const board = ${JSON.stringify(webBoard)};
  document.fonts.ready.then(() => {
    Board.init({ colorOf: () => "#d9480f", onEmptyChange: () => {}, layoutSig: () => "" });
    Board.render(board, { silent: true });
  });
</script>
</body></html>`
  writeFileSync(join(dir, file), html)
  index.push(`<li><a href="${file}">${esc(s.name)}</a> (${Object.keys(board.nodes).length} nodes, ${rich.dir}, ${rich.source.length.toLocaleString('en')} chars)</li>`)
}
writeFileSync(
  join(dir, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>ShapeTheTalk previews</title></head><body style="font-family:system-ui;padding:16px"><h1>ShapeTheTalk desktop previews</h1><ul>${index.join('')}</ul></body></html>`,
)
console.log(`wrote ${SAMPLES.length} previews to ${dir}`)
