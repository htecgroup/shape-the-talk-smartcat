// The staggered reveal: an update_diagram call applies to the doc at once (the
// tool returns, undo and get_diagram see everything), while the renderers draw
// a "revealed" view that gains the call's new elements one at a time, in flow
// order, like the web whiteboard growing as people talk. Pure: register.tsx
// keeps the state in $.state (`reveal`) and drives the steps with $.clock.after.
//
// The state lists what is still hidden, never what is shown, so anything it
// does not name (in-place updates, older elements, a board it is not about) is
// drawn as it is, and dropping the state shows the whole board: that is how a
// run that can no longer finish (a hot reload cancelled its timers, a session
// restarted, a timer was refused) heals.

import type { DBoard, DReveal, DRevealItem, DSpeed } from '../types'

export type { DReveal, DRevealItem, DSpeed }

/** Milliseconds before a node and before an edge appears, per speed (`off`: all at once). */
export const SPEEDS: { readonly [s in DSpeed]: { node: number; edge: number } } = {
  slow: { node: 1000, edge: 500 },
  normal: { node: 600, edge: 300 },
  fast: { node: 300, edge: 150 },
  off: { node: 0, edge: 0 },
}
export const SPEED_NAMES = Object.keys(SPEEDS) as DSpeed[]
export const DEFAULT_SPEED: DSpeed = 'slow'

/** How long past its planned end a run may still hide anything (a stalled timer heals after this). */
export const GRACE_MS = 3000

export const isSpeed = (s: string): s is DSpeed => (SPEED_NAMES as string[]).includes(s)

/**
 * The order the new elements of one call appear in: each new node, then the
 * new edges that now have both ends drawn (its incoming ones first). The next
 * node is the one reached from the most recently drawn node (so a chain is
 * followed to its end before a branch), else a root of what is left (no
 * incoming edge from another hidden node), else the first in op order (a
 * cycle). New edges between nodes already drawn come first.
 *
 * `added` is the call's added ids in op order (nodes and edges of `board`);
 * every other node of the board counts as already drawn.
 */
export function revealOrder(board: DBoard, added: readonly string[]): DRevealItem[] {
  const newNodes = added.filter(id => board.nodes[id])
  const newEdges = added.filter(id => board.edges[id])
  const hiddenNode = new Set(newNodes)
  const edgeLeft = new Set(newEdges)
  const out: DRevealItem[] = []
  const shown = (id: string) => !hiddenNode.has(id) && !!board.nodes[id]
  // when each drawn node appeared: older nodes 0, then the order they were revealed in
  const at = new Map<string, number>()
  let tick = 0

  const flushEdges = (node: string | null) => {
    const ready = newEdges.filter(id => {
      if (!edgeLeft.has(id)) return false
      const e = board.edges[id]!
      return shown(e.from) && shown(e.to) && (node === null || e.from === node || e.to === node)
    })
    // incoming first, then outgoing; op order within each
    const incoming = ready.filter(id => node === null || board.edges[id]!.to === node)
    const rest = ready.filter(id => !incoming.includes(id))
    for (const id of [...incoming, ...rest]) {
      edgeLeft.delete(id)
      out.push({ id, kind: 'edge' })
    }
  }

  flushEdges(null)
  const allEdges = Object.values(board.edges)
  while (hiddenNode.size) {
    // the edge from the most recently drawn node to a hidden one; ties go to the earliest edge (op order)
    let next: string | undefined
    let bestAt = -1
    for (const e of allEdges) {
      if (!hiddenNode.has(e.to) || !shown(e.from)) continue
      const t = at.get(e.from) ?? 0
      if (t > bestAt) {
        bestAt = t
        next = e.to
      }
    }
    if (!next) next = newNodes.find(id => hiddenNode.has(id) && !allEdges.some(e => e.to === id && hiddenNode.has(e.from) && e.from !== id))
    if (!next) next = newNodes.find(id => hiddenNode.has(id))!
    hiddenNode.delete(next)
    at.set(next, ++tick)
    out.push({ id: next, kind: 'node' })
    flushEdges(next)
  }
  // anything left (an edge to a node that is not on the board): last
  for (const id of newEdges) if (edgeLeft.has(id)) out.push({ id, kind: 'edge' })
  return out
}

/** The wait before each item: the first appears at once, then a node's or an edge's delay. */
export function schedule(items: readonly DRevealItem[], speed: DSpeed): number[] {
  const ms = SPEEDS[speed]
  return items.map((it, i) => (i === 0 ? 0 : it.kind === 'node' ? ms.node : ms.edge))
}

/** The time from the first item to the last, in ms. */
export const duration = (items: readonly DRevealItem[], speed: DSpeed) => schedule(items, speed).reduce((a, b) => a + b, 0)

/**
 * Starts the reveal of one call. It replaces any run still going, whose hidden
 * elements the caller passes as `flushed`: they show at once (fast-forward),
 * so nothing is lost. Returns null when there is
 * nothing to stagger (speed off, or at most one new element), the board then
 * drawn whole. The first item is revealed already.
 */
export function startReveal(
  board: DBoard,
  added: readonly string[],
  changed: readonly string[],
  opts: { seq: number; now: number; speed: DSpeed },
  /** what an unfinished earlier run still hid: shown at once with the first item */
  flushed: readonly string[] = [],
): DReveal | null {
  if (opts.speed === 'off') return null
  const items = revealOrder(board, added)
  if (items.length <= 1) return null
  const first = items[0]!
  const addedSet = new Set(added)
  const early = flushed.filter(id => !addedSet.has(id) && (board.nodes[id] || board.edges[id]))
  return {
    board: board.id,
    seq: opts.seq,
    speed: opts.speed,
    queue: items.slice(1),
    shown: [...early, first.id],
    changed: changed.filter(id => !addedSet.has(id) && !early.includes(id)),
    step: [...early, first.id],
    newest: first.kind === 'node' ? first.id : null,
    steps: 1,
    until: opts.now + duration(items, opts.speed),
  }
}

/** Reveals the next item; the same state when the queue is empty. */
export function advance(r: DReveal): DReveal {
  const next = r.queue[0]
  if (!next) return r
  return {
    ...r,
    queue: r.queue.slice(1),
    shown: [...r.shown, next.id],
    step: [next.id],
    newest: next.kind === 'node' ? next.id : r.newest,
    steps: r.steps + 1,
  }
}

/** The wait before the next item, or null when the run is done. */
export function nextDelay(r: DReveal): number | null {
  const next = r.queue[0]
  if (!next) return null
  const ms = SPEEDS[r.speed] ?? SPEEDS[DEFAULT_SPEED]
  return next.kind === 'node' ? ms.node : ms.edge
}

/**
 * What is still hidden on `boardId`. Nothing when the run is about another
 * board, is not running in this module load (`isRunning` false: a reload or
 * restart dropped its timers), or overran its planned end by GRACE_MS.
 */
export function hiddenIds(r: DReveal | null | undefined, boardId: string, now: number, isRunning: boolean): Set<string> {
  if (!r || !isRunning || r.board !== boardId || !r.queue.length) return new Set()
  if (now > r.until + GRACE_MS) return new Set()
  return new Set(r.queue.map(it => it.id))
}

/** The board as drawn: without the hidden nodes, the hidden edges, and any edge to a hidden node. */
export function visibleBoard(board: DBoard, hidden: ReadonlySet<string>): DBoard {
  if (!hidden.size) return board
  const nodes: DBoard['nodes'] = {}
  for (const [id, n] of Object.entries(board.nodes)) if (!hidden.has(id)) nodes[id] = n
  const edges: DBoard['edges'] = {}
  for (const [id, e] of Object.entries(board.edges)) if (!hidden.has(id) && nodes[e.from] && nodes[e.to]) edges[id] = e
  return { ...board, nodes, edges }
}

/** The recent highlight for one step: everything shown so far in the run (and the in-place changes), the step, the chip's node. */
export function recentOf(r: DReveal): { ids: string[]; added: string[]; step: string[]; newest: string | null; seq: number } {
  return {
    ids: [...r.changed, ...r.shown],
    added: [...r.shown],
    step: r.steps === 1 ? [...r.changed, ...r.step] : [...r.step],
    newest: r.newest,
    seq: r.seq * 1000 + r.steps,
  }
}
