// Stable abstract placement: every node gets a (rank, slot) once and keeps it.
// rank runs along the flow, slot across it (half steps allowed). Turning that
// into cells or pixels, left-to-right or top-down, is the renderer's job. Pure.

import type { DBoard, DPlace, DPlacement } from '../types'

type Graph = { ids: string[]; out: Map<string, string[]>; inn: Map<string, string[]> }

function graph(board: DBoard, skip?: Set<string>): Graph {
  const ids = Object.keys(board.nodes)
  const out = new Map<string, string[]>(ids.map(id => [id, []]))
  const inn = new Map<string, string[]>(ids.map(id => [id, []]))
  for (const e of Object.values(board.edges)) {
    if (!out.has(e.from) || !inn.has(e.to) || e.from === e.to) continue
    if (skip?.has(e.id)) continue
    out.get(e.from)!.push(e.to)
    inn.get(e.to)!.push(e.from)
  }
  return { ids, out, inn }
}

/** Edge ids that close a cycle (DFS in node order). */
export function backEdges(board: DBoard): Set<string> {
  const g = graph(board)
  const state = new Map<string, 0 | 1 | 2>()
  const back = new Set<string>()
  const visit = (start: string) => {
    // iterative DFS
    const stack: [string, number][] = [[start, 0]]
    state.set(start, 1)
    while (stack.length) {
      const top = stack[stack.length - 1]!
      const [id, i] = top
      const next = g.out.get(id)!
      if (i >= next.length) {
        state.set(id, 2)
        stack.pop()
        continue
      }
      top[1] = i + 1
      const to = next[i]!
      const s = state.get(to) ?? 0
      if (s === 1) back.add(`${id}->${to}`)
      else if (s === 0) {
        state.set(to, 1)
        stack.push([to, 0])
      }
    }
  }
  // start from sources first, so the cycle breaks where the flow comes back
  const order = [...g.ids.filter(id => g.inn.get(id)!.length === 0), ...g.ids]
  for (const id of order) if (!state.get(id)) visit(id)
  return back
}

function topo(g: Graph): string[] {
  const indeg = new Map(g.ids.map(id => [id, g.inn.get(id)!.length]))
  const queue = g.ids.filter(id => indeg.get(id) === 0)
  const out: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    out.push(id)
    for (const to of g.out.get(id)!) {
      indeg.set(to, indeg.get(to)! - 1)
      if (indeg.get(to) === 0) queue.push(to)
    }
  }
  return out
}

/** Slots for nodes in a row: as near their wish as a gap of 1 allows, on half steps. */
export function spaceOut(wish: number[]): number[] {
  if (wish.length === 0) return []
  const s: number[] = []
  for (let i = 0; i < wish.length; i++) s.push(i === 0 ? wish[0]! : Math.max(wish[i]!, s[i - 1]! + 1))
  // shift the run so it sits as close to the wishes as possible
  let shift = 0
  for (let i = 0; i < wish.length; i++) shift += wish[i]! - s[i]!
  shift /= wish.length
  return s.map(v => Math.round((v + shift) * 2) / 2)
}

/** A full layered layout of the board. */
export function fullLayout(board: DBoard): DPlacement {
  const back = backEdges(board)
  const g = graph(board, back)
  const order = topo(g)
  const rank = new Map<string, number>()
  for (const id of order) {
    const preds = g.inn.get(id)!
    rank.set(id, preds.length ? Math.max(...preds.map(p => rank.get(p)! + 1)) : 0)
  }
  // a source sits just before its first successor
  for (const id of order) {
    if (g.inn.get(id)!.length) continue
    const succ = g.out.get(id)!
    if (succ.length) rank.set(id, Math.min(...succ.map(t => rank.get(t)!)) - 1)
  }
  const isolated = (id: string) => g.inn.get(id)!.length === 0 && g.out.get(id)!.length === 0 && ![...back].some(b => b.startsWith(id + '->') || b.endsWith('->' + id))
  const min = Math.min(0, ...[...rank.entries()].filter(([id]) => !isolated(id)).map(([, r]) => r))
  for (const [id, r] of rank) rank.set(id, isolated(id) ? 0 : r - min)

  // rows of nodes per rank, in node order to start with
  const maxRank = Math.max(0, ...rank.values())
  const rows: string[][] = Array.from({ length: maxRank + 1 }, () => [])
  for (const id of g.ids) rows[rank.get(id)!]!.push(id)
  const all = graph(board) // neighbours for ordering include back edges
  const nbrs = (id: string, dir: 'up' | 'down') =>
    dir === 'down'
      ? [...all.inn.get(id)!, ...all.out.get(id)!].filter(n => rank.get(n)! < rank.get(id)!)
      : [...all.inn.get(id)!, ...all.out.get(id)!].filter(n => rank.get(n)! > rank.get(id)!)
  const posIn = () => {
    const p = new Map<string, number>()
    for (const row of rows) row.forEach((id, i) => p.set(id, i - (row.length - 1) / 2))
    return p
  }
  for (let iter = 0; iter < 4; iter++) {
    const dir = iter % 2 === 0 ? 'down' : 'up'
    const seq = dir === 'down' ? rows.map((_, i) => i) : rows.map((_, i) => rows.length - 1 - i)
    for (const r of seq) {
      const p = posIn()
      const row = rows[r]!
      const bary = new Map<string, number>()
      for (const id of row) {
        const ns = nbrs(id, dir)
        bary.set(id, ns.length ? ns.reduce((a, n) => a + p.get(n)!, 0) / ns.length : p.get(id)!)
      }
      row.sort((a, b) => bary.get(a)! - bary.get(b)!)
    }
  }

  // slots: near the mean of the already placed neighbours
  const out: DPlacement = {}
  for (let r = 0; r <= maxRank; r++) {
    const row = rows[r]!
    const wish = row.map((id, i) => {
      const ns = nbrs(id, 'down').filter(n => out[n])
      return ns.length ? ns.reduce((a, n) => a + out[n]!.s, 0) / ns.length : i - (row.length - 1) / 2
    })
    // spaceOut keeps the order the crossing pass chose
    const s = spaceOut(wish)
    row.forEach((id, i) => (out[id] = { r, s: s[i]! }))
  }
  return out
}

const isFree = (placed: DPlacement, r: number, s: number, self?: string) =>
  !Object.entries(placed).some(([id, p]) => id !== self && p.r === r && Math.abs(p.s - s) < 1)

/** The nearest free slot to `wish` in rank r, on half steps. */
export function freeSlot(placed: DPlacement, r: number, wish: number): number {
  const w = Math.round(wish * 2) / 2
  for (let d = 0; d < 200; d += 0.5) {
    if (isFree(placed, r, w + d)) return w + d
    if (d > 0 && isFree(placed, r, w - d)) return w - d
  }
  return w + 200
}

/**
 * Keep every placed node where it is and place the new ones next to their
 * neighbours. A full re-layout only when at most 2 nodes are kept, or more new
 * nodes arrive than already exist.
 */
export function placeNew(board: DBoard, prev: DPlacement | undefined): DPlacement {
  const ids = Object.keys(board.nodes)
  const kept: DPlacement = {}
  for (const id of ids) if (prev?.[id]) kept[id] = { ...prev[id]! }
  const fresh = ids.filter(id => !kept[id])
  const keptN = Object.keys(kept).length
  if (fresh.length === 0) return prev && Object.keys(prev).length === keptN ? prev : kept
  if (keptN <= 2 || fresh.length > keptN) return fullLayout(board)

  const out = kept
  const edges = Object.values(board.edges)
  const pending = new Set(fresh)
  while (pending.size) {
    // the next node to place: one with a placed neighbour, in node order
    let id = fresh.find(n => pending.has(n) && edges.some(e => (e.to === n && out[e.from]) || (e.from === n && out[e.to])))
    if (!id) {
      id = fresh.find(n => pending.has(n))!
      const r = 0
      out[id] = { r, s: freeSlot(out, r, 0), loose: true }
      pending.delete(id)
      continue
    }
    pending.delete(id)
    const preds = edges.filter(e => e.to === id && out[e.from]).map(e => out[e.from]!)
    const succs = edges.filter(e => e.from === id && out[e.to]).map(e => out[e.to]!)
    const mean = (ps: DPlace[]) => ps.reduce((a, p) => a + p.s, 0) / ps.length
    if (preds.length && succs.length) {
      const pr = Math.max(...preds.map(p => p.r))
      const sr = Math.min(...succs.map(p => p.r))
      if (sr <= pr + 1) {
        // inserted between neighbours on adjacent ranks (a via): open a rank
        for (const p of Object.values(out)) if (p.r > pr) p.r += 1
      }
      const r = pr + 1
      out[id] = { r, s: freeSlot(out, r, (mean(preds) + mean(succs)) / 2) }
    } else if (preds.length) {
      const r = Math.max(...preds.map(p => p.r)) + 1
      out[id] = { r, s: freeSlot(out, r, mean(preds)) }
    } else {
      const r = Math.min(...succs.map(p => p.r)) - 1
      out[id] = { r, s: freeSlot(out, r, mean(succs)) }
    }
  }
  return out
}

/** Ranks and slots shifted so both start at 0 (slots stay on half steps). */
export function normalise(p: DPlacement): DPlacement {
  const vals = Object.values(p)
  if (!vals.length) return {}
  const r0 = Math.min(...vals.map(v => v.r))
  const s0 = Math.min(...vals.map(v => v.s))
  const out: DPlacement = {}
  for (const [id, v] of Object.entries(p)) out[id] = { r: v.r - r0, s: v.s - s0 }
  return out
}
