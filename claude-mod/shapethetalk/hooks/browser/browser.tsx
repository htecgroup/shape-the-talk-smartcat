/* @jsx h */
// Vendored from zenbu-labs/terminal-browser (https://github.com/zenbu-labs/terminal-browser),
// claude-code-plugin/hooks/register.tsx at commit 2165ae76c9639e3996829ab0e6d54ddbd4f06ad8.
// MIT licence, Copyright 2026 Zenbu Labs, Inc.: see ./LICENSE beside this file.
//
// Changes for shapethetalk (one plugin, one hooks module):
// - `register` is now `registerBrowser(on, onClose)`, called from ../register.tsx.
//   The `$.browser` noun stays (engine.create here, `browser.open` / `browser.close`
//   answered here): the engine follows `$` into a function of this same file only,
//   never across an import, so ../register.tsx reaches the pane through the noun.
//   Its types moved from browser.d.ts into ../../types/index.d.ts (the plugin's one contract).
// - The optional agent tools are `browser_open` / `browser_close`
//   (mcp__shapethetalk__browser_open / _close; upstream mcp__terminal-browser__open / _close).
// - The dev-checkout lookup (`<plugin root>/../cli/dist/main.js`) is gone: always the
//   `terminal-browser` on PATH.
// - A failed open carries a `code` ('missing' | 'old' | 'start'), and a missing binary
//   says `brew install terminal-browser`.
// - Log lines are prefixed `shapethetalk browser:`.
// - The capability parsing is the exported pure `hasRequiredCapabilities`, which
//   ../register.tsx also uses for its once-per-session check behind the auto look.
// - The bridge watch's rejection on unload is caught (`void watchBridge($).catch(...)`).
// - A module may hook an event once without a matcher, so the `session.start` work
//   (`/browser` and the optional tools) is in ../register.tsx's own session.start,
//   from the constants here, and ../register.tsx hears the pane close through `onClose`.
import type { EngineInterface, On } from 'claude-code'
import type { Browser, BrowserFailure, BrowserOpenResult } from '../../types'
import { MAX_IMAGE_CELLS } from './surface.tsx'
import { normalizeUrl } from './urls.ts'
import {
  isBridgeState,
  isInputMessage,
  isLaunchReport,
  isSizeMessage,
  takenItems,
  type BridgeState,
  type Frame,
} from './bridge-protocol.ts'

export const BROWSER_PANE = 'browser'
export const BROWSER_COMMAND = 'browser'
export const BROWSER_COMMAND_DESCRIPTION = 'Open a browser to the right (terminal-browser)'
export const BROWSER_OPEN_TOOL = 'browser_open'
export const BROWSER_OPEN_DESCRIPTION = 'Open terminal-browser directly inside claude code. Control the open page with the terminal-browser action CLI.'
export const BROWSER_OPEN_SCHEMA = { type: 'object', properties: { url: { type: 'string', description: 'The page to open, as a full url or a host name' } } } as const
export const BROWSER_CLOSE_TOOL = 'browser_close'
export const BROWSER_CLOSE_DESCRIPTION = 'Close the terminal-browser pane.'
export const BROWSER_INSTALL_HINT = 'brew install terminal-browser'
const IMAGE_KEY = 'view'
const IMAGE_ALT = ''
const OPEN_TOOL = `mcp__shapethetalk__${BROWSER_OPEN_TOOL}`
const CLOSE_TOOL = `mcp__shapethetalk__${BROWSER_CLOSE_TOOL}`
const START_URL = 'terminal-browser://start'
const INSTALL_URL = 'https://terminal-browser.sh'
const REQUIRED_CAPABILITIES = ['embedding', 'image-frames']
const WATCH_RETRY_MS = 250
const DENIED_REDRAW_MS = 500
const DENIALS_BEFORE_LOGGING = 3


const state = {
  port: null as number | null,
  token: null as string | null,
  open: false,
  pendingUrl: null as string | null,
  region: null as { cols: number; rows: number } | null,
  last: null as BridgeState | null,
  frame: null as Frame | null,
  mounted: null as { cols: number; rows: number } | null,
  watcher: 0,
  // a hack to programatically trigger agent input focus
  viewGeneration: 0,
}

const bridgeUrl = (path: string) => `http://127.0.0.1:${state.port}${path}`
const authHeaders = () => ({ authorization: `Bearer ${state.token}` })
const viewKey = () => `view${state.viewGeneration}`

const COMMAND = ['terminal-browser']

async function checkCapabilities($: EngineInterface, command: string[]): Promise<{ ok: true } | { ok: false; installed: boolean }> {
  let result: { stdout: string; exitCode: number }
  try {
    result = await $.process.run([...command, 'capabilities'], { timeoutMs: 10_000 })
  } catch {
    // $.process.run rejects when the command cannot start: not on PATH
    return { ok: false, installed: false }
  }
  return hasRequiredCapabilities(result) ? { ok: true } : { ok: false, installed: true }
}

/**
 * Whether `terminal-browser capabilities` printed every capability the pane needs
 * (pure: ../register.tsx runs the command itself for its once-per-session check,
 * since the engine follows `$` into functions of the same file only).
 */
export function hasRequiredCapabilities(result: { stdout: string; exitCode: number }): boolean {
  let capabilities: string[] = []
  if (result.exitCode === 0) {
    const line = result.stdout.split('\n').find((text: string) => text.startsWith('{'))
    try {
      const parsed = line ? JSON.parse(line) : null
      if (parsed && Array.isArray(parsed.capabilities)) capabilities = parsed.capabilities
    } catch {}
  }
  return REQUIRED_CAPABILITIES.every(need => capabilities.includes(need))
}

async function startBridge($: EngineInterface): Promise<{ ok: true } | { ok: false; error: string; code: BrowserFailure }> {
  const command = COMMAND
  const check = await checkCapabilities($, command)
  if (!check.ok) {
    return check.installed
      ? { ok: false, code: 'old', error: 'Newer terminal-browser version required, run terminal-browser upgrade' }
      : { ok: false, code: 'missing', error: `terminal-browser is not installed: ${BROWSER_INSTALL_HINT} (or see ${INSTALL_URL})` }
  }
  let report: unknown = null
  try {
    const { stdout, stderr, exitCode } = await $.process.run([...command, 'claude-bridge', 'launch'], { timeoutMs: 20_000 })
    const line = stdout.split('\n').find((text: string) => text.startsWith('{'))
    report = line ? JSON.parse(line) : { error: stderr.trim() || `exit ${exitCode}`, code: 'start' }
  } catch (err) {
    report = { error: String(err), code: 'start' }
  }
  if (!isLaunchReport(report) || !('port' in report)) {
    const detail = isLaunchReport(report) && 'error' in report ? report.error : 'terminal-browser could not start'
    return { ok: false, code: 'start', error: `${detail}` }
  }
  state.port = report.port
  state.token = report.token
  // its waits reject when the module unloads (a reload, the session's end): nothing to do then
  void watchBridge($).catch(() => {})
  return { ok: true }
}

async function post($: EngineInterface, path: string, body: unknown): Promise<unknown> {
  if (state.port === null) return null
  try {
    const response = await $.http.fetch(bridgeUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    })
    return response.ok ? JSON.parse(response.text || '{}') : null
  } catch {
    return null
  }
}

async function fetchState($: EngineInterface, version: number): Promise<BridgeState | null> {
  if (state.port === null) return null
  try {
    const response = await $.http.fetch(bridgeUrl(`/state?version=${version}`), { headers: authHeaders() })
    const parsed: unknown = response.ok ? JSON.parse(response.text) : null
    return isBridgeState(parsed) ? parsed : null
  } catch {
    return null
  }
}


function imageSource(frame: Frame) {
  return { shm: frame.shm, format: frame.format, width: frame.width, height: frame.height, generation: frame.generation }
}

function imageGrid(frame: Frame, cols: number, rows: number) {
  return {
    cols: Math.max(1, Math.min(frame.cols, cols, MAX_IMAGE_CELLS)),
    rows: Math.max(1, Math.min(frame.rows, rows, MAX_IMAGE_CELLS)),
  }
}

function fitsMounted(frame: Frame): boolean {
  const mounted = state.mounted
  if (!mounted || !state.region) return false
  const grid = imageGrid(frame, state.region.cols, state.region.rows)
  return grid.cols === mounted.cols && grid.rows === mounted.rows
}

async function watchBridge($: EngineInterface): Promise<void> {
  const watcher = ++state.watcher
  const live = () => state.watcher === watcher && state.port !== null
  let version = -1
  let denials = 0
  let lastDeniedRedraw = 0
  while (live()) {
    const fresh = await fetchState($, version)
    if (!live()) return
    if (!fresh) {
      await $.clock.sleep(WATCH_RETRY_MS)
      continue
    }
    version = fresh.version
    const previous = state.last
    state.last = fresh
    if (fresh.inbox > 0) await deliverAgentText($)
    if (!state.open) continue
    const pictureGone = fresh.frame === null && state.frame !== null
    if (pictureGone) state.frame = null
    const paneChanged =
      !previous
      || pictureGone
      || previous.title !== fresh.title
      || previous.alive !== fresh.alive
      || previous.error !== fresh.error
    if (paneChanged) {
      $.ui.invalidate('ui.render')
      if (fresh.title) await $.ui.open({ id: BROWSER_PANE, title: fresh.title.slice(0, 40) })
    }
    const frame = fresh.frame
    if (!frame || frame.generation === state.frame?.generation) continue
    state.frame = frame
    if (!fitsMounted(frame)) {
      $.ui.invalidate('ui.render')
      continue
    }
    const result = await $.ui.blit({ requestId: BROWSER_PANE, key: IMAGE_KEY, source: imageSource(frame) })
    if (!result.deny) {
      denials = 0
      continue
    }
    denials += 1
    if (denials === DENIALS_BEFORE_LOGGING) $.ui.log(`shapethetalk browser: frame blit refused: ${result.deny}`)
    const now = Date.now()
    if (now - lastDeniedRedraw >= DENIED_REDRAW_MS) {
      lastDeniedRedraw = now
      $.ui.invalidate('ui.render')
    }
  }
}

/** Opens (or navigates) the terminal-browser pane, starting the bridge on first use. */
async function openBrowser($: EngineInterface, raw: string | null): Promise<BrowserOpenResult> {
  if (state.port === null) {
    const started = await startBridge($)
    if (!started.ok) return started
  }
  const alive = state.last?.alive === true
  const url = raw ? normalizeUrl(raw) : (alive && state.last?.url ? state.last.url : START_URL)
  state.pendingUrl = url
  state.open = true
  await $.ui.open({ id: BROWSER_PANE, title: 'browser', focus: true, rows: 24 })
  $.ui.invalidate('ui.render')
  if (state.region) {
    state.pendingUrl = null
    await post($, '/open', { url, ...state.region })
  }
  return { ok: true, url }
}

/** Closes the terminal-browser pane; false when none was open. */
async function closeBrowser($: EngineInterface): Promise<boolean> {
  if (!state.open) return false
  await $.ui.close({ id: BROWSER_PANE })
  return true
}

async function browserClosed($: EngineInterface): Promise<void> {
  state.open = false
  state.pendingUrl = null
  state.region = null
  state.frame = null
  state.mounted = null
  await post($, '/browser/close', {})
}

async function deliverAgentText($: EngineInterface): Promise<void> {
  const oneLine = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
  const lines = takenItems(await post($, '/inbox/take', {}))
    .filter(item => item.text.trim() !== '')
    .flatMap(item => [oneLine(item.text), ...(item.screenshot ? [oneLine(item.screenshot)] : [])])
  if (lines.length === 0) return
  const { isFilled } = await $.prompt.fill({ text: `${lines.join('\n')}\n` })
  if (!isFilled) {
    // would need to see a case this happens before shipping
    // $.ui.toast('copied to clipboard')
    return
  }
  state.viewGeneration += 1
  $.ui.invalidate('ui.render')
}


/**
 * The terminal-browser pane: `/browser [url|close]`, the optional agent tools'
 * calls, and the pane's drawing, input, scroll and close. Called once from
 * ../register.tsx; `onClose` hears every close of the pane (`isByPerson` for the
 * person's mark or key).
 */
export function registerBrowser(on: On, onClose?: (isByPerson: boolean) => void): void {
  // this is a hack because the plugin api does not allow $ or the result of next to be passed to functions
  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    const servedByHooks = () => { throw new Error('the browser noun is served by its hooks') }
    const browser: Browser = { open: servedByHooks, close: servedByHooks }
    return { ...built, browser }
  })

  on('browser.open', async ($, e) => {
    const opened = await openBrowser($, e.url ?? null)
    return { value: opened }
  })

  on('browser.close', async ($) => {
    return { value: await closeBrowser($) }
  })


  on('command.run', { command: BROWSER_COMMAND }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close' || (!arg && state.open)) {
      await closeBrowser($)
      return { text: 'Closed terminal-browser' }
    }
    const opened = await openBrowser($, arg || null)
    return { text: opened.ok ? 'Opened terminal-browser' : opened.error }
  })

  on('tool.call', { tool: new RegExp(`^${OPEN_TOOL}$`) }, async ($, e) => {
    const url = (e as { url?: unknown }).url
    const opened = await openBrowser($, typeof url === 'string' ? url : null)
    if (!opened.ok) return { deny: `could not open the browser: ${opened.error}` }
    return { result: [{ type: 'text', text: `opened ${opened.url} ` }] }
  })

  on('tool.call', { tool: new RegExp(`^${CLOSE_TOOL}$`) }, async ($) => {
    const closed = await closeBrowser($)
    return { result: [{ type: 'text', text: closed ? 'browser pane closed' : 'no browser pane was open (maybe the user closed it?)' }] }
  })

  on('ui.render', { component: 'Pane', requestId: BROWSER_PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Box } = await $.ui.resolve(e)
      return <Box />
    }
    const { Box, Client, Image } = await $.ui.resolve(e)
    const rows = e.props.scroll.bodyRows > 0 ? e.props.scroll.bodyRows : Math.max(8, (e.viewport?.rows ?? 30) - 8)
    const cols = Math.max(1, e.props.bodyColumns > 0 ? e.props.bodyColumns : (e.viewport?.columns ?? 80))
    const frame = state.frame
    const grid = frame ? imageGrid(frame, cols, rows) : null
    state.mounted = grid
    return (
      <Box flexDirection="column" width={cols} height={rows}>
        {frame && grid ? (
          <Image key={IMAGE_KEY} source={imageSource(frame)} columns={grid.cols} rows={grid.rows} alt={IMAGE_ALT} />
        ) : null}
        <Box position="absolute" top={0} left={0} width={cols} height={rows}>
          <Client key={viewKey()} module="./surface.tsx" width={cols} height={rows} />
        </Box>
      </Box>
    )
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== BROWSER_PANE || state.port === null) return next(e)
    if (isSizeMessage(e.data)) {
      state.region = { cols: e.data.cols, rows: e.data.rows }
      if (state.pendingUrl) {
        const url = state.pendingUrl
        state.pendingUrl = null
        await post($, '/open', { url, ...state.region })
      } else {
        await post($, '/size', state.region)
      }
    } else if (isInputMessage(e.data)) {
      await post($, '/input', { events: e.data.events })
    }
    return next(e)
  })

  on('ui.scroll', { requestId: BROWSER_PANE }, async ($, e) => {
    if (state.port === null || !state.open || e.by === 0) return {}
    const kind = e.by < 0 ? 'scrollup' : 'scrolldown'
    const ticks = Math.min(Math.round(Math.abs(e.by)) || 1, 10)
    const x = e.pointer?.column ?? Math.floor((state.region?.cols ?? 0) / 2)
    const y = e.pointer?.row ?? Math.floor((state.region?.rows ?? 0) / 2)
    const events = Array.from({ length: ticks }, () => ({ type: 'mouse', kind, x, y }))
    await post($, '/input', { events })
    return {}
  })

  on('ui.close', { id: BROWSER_PANE }, async ($, e, next) => {
    onClose?.(e.origin.kind === 'person')
    const r = await next(e)
    await browserClosed($)
    return r
  })
}
