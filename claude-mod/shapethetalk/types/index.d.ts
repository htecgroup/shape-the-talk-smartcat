// ShapeTheTalk mod: the data model and the $.state contract.

export type DNodeType = 'actor' | 'system' | 'step' | 'decision' | 'data'
export type DStatus = 'confirmed' | 'ghost' | 'disputed' | 'resolved'
export type DKind = 'process' | 'architecture' | 'sequence' | 'mindmap' | 'other'

export type DNode = {
  id: string
  label: string
  type: DNodeType
  status: DStatus
  note: string | null
  wasDisputed?: boolean
  /** The doc version that last changed this node. */
  v: number
}

export type DEdge = {
  /** "from->to" */
  id: string
  from: string
  to: string
  label: string | null
  status: DStatus
  note: string | null
  wasDisputed?: boolean
  v: number
}

export type DBoard = {
  id: string
  title: string
  kind: DKind
  nodes: { [id: string]: DNode }
  edges: { [id: string]: DEdge }
}

/** One op as the model sent it, after normalising (unknown fields dropped). */
export type DOp = {
  op: string
  id?: string
  label?: string
  type?: string
  status?: string
  note?: string
  from?: string
  to?: string
  edge?: string
  via?: string
  new_from?: string
  new_to?: string
  target?: string
  title?: string
  kind?: string
  board?: string
}

/** An inverse primitive: put back what was there before one change. */
export type DInverse =
  | { k: 'node'; b: string; id: string; old: DNode | null }
  | { k: 'edge'; b: string; id: string; old: DEdge | null }
  | { k: 'board'; b: string; old: DBoard | null; order: string[] }
  | { k: 'active'; old: string | null }

/** One update_diagram call. */
export type DTxn = {
  version: number
  ops: DOp[]
  inverse: DInverse[]
  undone: boolean
}

export type DDoc = {
  version: number
  active: string | null
  order: string[]
  boards: { [id: string]: DBoard }
  /** At most 50 entries, oldest first. */
  history: DTxn[]
}

/** rank along the flow, slot across it (may be a half step). */
export type DPlace = { r: number; s: number; loose?: boolean }
export type DPlacement = { [nodeId: string]: DPlace }

/**
 * What the last update changed, for highlighting. During a staggered reveal:
 * `ids`/`added` are everything shown so far in the run, `step` what appeared in
 * the latest step, `newest` the node the "Claude" chip sits on.
 */
export type DRecent = { board: string; ids: string[]; seq: number; added?: string[]; step?: string[]; newest?: string | null }

/** How fast a call's new elements appear one by one (`/diagram speed`); `off` draws them at once. */
export type DSpeed = 'slow' | 'normal' | 'fast' | 'off'

export type DRevealItem = { id: string; kind: 'node' | 'edge' }

/**
 * A staggered reveal in progress: the doc already holds everything; the
 * renderers leave out what `queue` still names on `board`.
 */
export type DReveal = {
  board: string
  /** The doc version of the call. */
  seq: number
  speed: DSpeed
  /** Still hidden, in reveal order. */
  queue: DRevealItem[]
  /** Revealed so far in this run, oldest first. */
  shown: string[]
  /** In-place changes of the call (highlighted from the first step). */
  changed: string[]
  /** What the latest step revealed. */
  step: string[]
  /** The latest revealed node (the chip follows it). */
  newest: string | null
  /** Steps taken (1 after the first). */
  steps: number
  /** When the run should end, in $.clock.now() ms; past it (plus a grace) nothing stays hidden. */
  until: number
}

/**
 * How the terminal shows the board: `auto` (the default) is live where the terminal
 * shows pictures and terminal-browser is installed, else the image there, else the
 * grid; `live` shows the board as a page in terminal-browser's pane (the picture in
 * the diagram pane without it).
 */
export type DLook = 'auto' | 'image' | 'grid' | 'live'

/** A board rasterised to a PNG for the terminal's Image element. */
export type DImage = {
  /** What it was drawn from: board, version, placement, recent, pane size, zoom, pan, device scale. */
  key: string
  /** The PNG's absolute path (in the session's temp dir). */
  file: string
  /** Size of the drawn window of the drawing in CSS px (its full height; its width, or the crop of it). */
  width: number
  height: number
  /** The Image box it was drawn for, in cells (absent in PNGs from before zoom drew its own). */
  columns?: number
  rows?: number
  /** The PNG's size in device pixels: the box times the cell size. */
  pxWidth?: number
  pxHeight?: number
}

/** One terminal cell in device pixels (Ghostty on a Retina Mac: 16×34). */
export type DCell = { w: number; h: number }

/**
 * The terminal-browser pane's noun, `$.browser` (hooks/browser/, vendored from
 * zenbu-labs/terminal-browser, MIT): added in engine.create and answered by the
 * same module's `browser.open` / `browser.close` hooks.
 */
export type BrowserOpenInput = { url?: string }

/** Why an open failed: no `terminal-browser` on PATH, one too old, or it would not start. */
export type BrowserFailure = 'missing' | 'old' | 'start'

export type BrowserOpenResult =
  | { ok: true; url: string }
  | { ok: false; error: string; code: BrowserFailure }

export type Browser = {
  /** Opens (or navigates) the browser pane; starts terminal-browser's bridge on first use. */
  open: (input: BrowserOpenInput) => Promise<BrowserOpenResult>
  /** Closes the browser pane; false when none was open. */
  close: (input?: Record<string, never>) => Promise<boolean>
}

declare module 'claude-code' {
  interface EngineInterface {
    browser: Browser
  }

  interface PluginState {
    shapethetalk: {
      doc: DDoc
      layout: { [boardId: string]: DPlacement }
      recent: DRecent | null
      pan: number
      zoom: number
      /** Terminal picture: the left edge of the shown window, as a fraction of the drawing's width. */
      imagePan: number
      look: DLook
      /** The last PNG drawn for each board. */
      images: { [boardId: string]: DImage }
      /** Terminal picture: one cell's size in device pixels (`/diagram cell <w>x<h>`). */
      cell: DCell
      /** The staggered reveal in progress, or null (the whole board drawn). */
      reveal: DReveal | null
      /** `/diagram speed`: how fast new elements appear. */
      speed: DSpeed
    }
  }
}
