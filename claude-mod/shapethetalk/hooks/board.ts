// Ops: normalise, validate and apply them to the doc, with undo history, the
// dispute rule and the compact()/summary() views the model reads. Pure.

import type {
  DBoard,
  DDoc,
  DEdge,
  DInverse,
  DKind,
  DNode,
  DNodeType,
  DOp,
  DStatus,
  DTxn,
} from '../types'

export const NODE_TYPES: readonly DNodeType[] = ['actor', 'system', 'step', 'decision', 'data']
export const STATUSES: readonly DStatus[] = ['confirmed', 'ghost', 'disputed', 'resolved']
export const KINDS: readonly DKind[] = ['process', 'architecture', 'sequence', 'mindmap', 'other']
export const OPS = [
  'new_board',
  'switch_board',
  'rename_board',
  'add_node',
  'update_node',
  'remove_node',
  'connect',
  'disconnect',
  'reroute',
  'mark',
  'clear',
  'undo_last',
] as const
export const HISTORY_MAX = 50
export const DEFAULT_BOARD = 'main'

const ID_FIELDS = ['id', 'from', 'to', 'via', 'new_from', 'new_to', 'board'] as const
const EDGE_FIELDS = ['edge', 'target'] as const
const TEXT_FIELDS = ['label', 'type', 'status', 'note', 'title', 'kind'] as const
const MAX_LABEL = 80
const MAX_NOTE = 160
const MAX_TITLE = 80

export function emptyDoc(): DDoc {
  return { version: 0, active: null, order: [], boards: {}, history: [] }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** `[a-z0-9_]`, at most 48 characters. */
export function slug(s: unknown): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
}

/** "A -> B", "a->b", "a → b" all name the edge "a->b". */
export function edgeId(ref: unknown): string {
  const text = String(ref ?? '').trim()
  const parts = text.split(/\s*(?:->|→|=>)\s*/)
  if (parts.length !== 2) return slug(text)
  return `${slug(parts[0])}->${slug(parts[1])}`
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export type NormalisedOps = { ops: (DOp | { error: string; raw: unknown })[]; error?: string }

/** ops may arrive as a JSON string; each op keeps only the known fields. */
export function normaliseOps(raw: unknown): NormalisedOps {
  let list = raw
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      return { ops: [], error: 'ops is not valid JSON: send an array of op objects' }
    }
  }
  if (list && typeof list === 'object' && !Array.isArray(list) && 'op' in (list as object)) list = [list]
  if (!Array.isArray(list)) return { ops: [], error: 'ops must be an array of op objects' }
  return { ops: list.map(normaliseOp) }
}

function normaliseOp(raw: unknown): DOp | { error: string; raw: unknown } {
  let o = raw
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o)
    } catch {
      return { error: 'not an op object', raw }
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'not an op object', raw }
  const src = o as Record<string, unknown>
  const name = typeof src.op === 'string' ? src.op.trim().toLowerCase() : ''
  if (!name) return { error: 'missing "op"', raw }
  if (!(OPS as readonly string[]).includes(name)) return { error: `unknown op "${name}" (use one of ${OPS.join(', ')})`, raw }
  const op: DOp = { op: name }
  const str = (v: unknown): string | undefined => {
    if (v === null || v === undefined) return undefined
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return undefined
    const t = String(v).replace(/\s+/g, ' ').trim()
    return t === '' ? undefined : t
  }
  for (const f of ID_FIELDS) {
    const t = str(src[f])
    if (t === undefined) continue
    // board may be named by its title in switch_board: keep the raw text there
    const v = f === 'board' ? t : slug(t)
    if (v) op[f] = v
  }
  for (const f of EDGE_FIELDS) {
    const t = str(src[f])
    if (t === undefined) continue
    op[f] = t.includes('->') || t.includes('→') || t.includes('=>') ? edgeId(t) : slug(t)
  }
  for (const f of TEXT_FIELDS) {
    const t = str(src[f])
    if (t === undefined) continue
    op[f] = f === 'type' || f === 'status' || f === 'kind' ? t.toLowerCase() : t
  }
  return op
}

export function describeOp(op: DOp | { error: string; raw: unknown }): string {
  if ('error' in op) {
    const s = JSON.stringify(op.raw) ?? String(op.raw)
    return cut(s, 60)
  }
  const bits: string[] = [op.op]
  if (op.op === 'connect') bits.push(`${op.from ?? '?'}->${op.to ?? '?'}`)
  else if (op.id) bits.push(op.id)
  else if (op.edge) bits.push(op.edge)
  else if (op.target) bits.push(op.target)
  else if (op.op === 'switch_board' && op.board) bits.push(op.board)
  return bits.join(' ')
}

// ------------------------------------------------------------------ apply

class Reject extends Error {}
const reject = (reason: string): never => {
  throw new Reject(reason)
}

type Ctx = {
  doc: DDoc
  inv: DInverse[]
  version: number
  changed: Set<string>
  added: Set<string>
  boards: Set<string>
}

function setNode(c: Ctx, b: string, id: string, node: DNode | null) {
  const board = c.doc.boards[b] ?? reject(`unknown board "${b}"`)
  c.inv.push({ k: 'node', b, id, old: board.nodes[id] ? clone(board.nodes[id]) : null })
  if (node) board.nodes[id] = node
  else delete board.nodes[id]
  c.boards.add(b)
  if (b === c.doc.active) c.changed.add(id)
}

function setEdge(c: Ctx, b: string, id: string, edge: DEdge | null) {
  const board = c.doc.boards[b] ?? reject(`unknown board "${b}"`)
  c.inv.push({ k: 'edge', b, id, old: board.edges[id] ? clone(board.edges[id]) : null })
  if (edge) board.edges[id] = edge
  else delete board.edges[id]
  c.boards.add(b)
  if (b === c.doc.active) c.changed.add(id)
}

function setBoard(c: Ctx, b: string, board: DBoard | null, order: string[]) {
  c.inv.push({ k: 'board', b, old: c.doc.boards[b] ? clone(c.doc.boards[b]) : null, order: [...c.doc.order] })
  if (board) c.doc.boards[b] = board
  else delete c.doc.boards[b]
  c.doc.order = order
  c.boards.add(b)
}

function setActive(c: Ctx, id: string | null) {
  if (c.doc.active === id) return
  c.inv.push({ k: 'active', old: c.doc.active })
  c.doc.active = id
}

function applyInverse(doc: DDoc, inv: DInverse) {
  if (inv.k === 'active') {
    doc.active = inv.old
    return
  }
  if (inv.k === 'board') {
    if (inv.old) doc.boards[inv.b] = clone(inv.old)
    else delete doc.boards[inv.b]
    doc.order = [...inv.order]
    return
  }
  const board = doc.boards[inv.b]
  if (!board) return
  if (inv.k === 'node') {
    if (inv.old) board.nodes[inv.id] = clone(inv.old)
    else delete board.nodes[inv.id]
  } else {
    if (inv.old) board.edges[inv.id] = clone(inv.old)
    else delete board.edges[inv.id]
  }
}

/** The dispute rule: what status an element ends up with. */
export function nextStatus(prev: { status: DStatus; wasDisputed?: boolean } | undefined, want: DStatus): DStatus {
  const once = !!prev && (prev.status === 'disputed' || !!prev.wasDisputed)
  if (want === 'ghost' && prev?.status === 'disputed') return 'disputed'
  if (want === 'confirmed' && once) return 'resolved'
  if (want === 'resolved' && !once) return 'confirmed'
  return want
}

function withStatus<T extends DNode | DEdge>(el: T, prev: T | undefined, want: DStatus | undefined): T {
  if (!want) return el
  const status = nextStatus(prev, want)
  const out = { ...el, status }
  if (status === 'disputed' || prev?.status === 'disputed' || prev?.wasDisputed) out.wasDisputed = true
  return out
}

function asStatus(s: string | undefined): DStatus | undefined {
  if (s === undefined) return undefined
  return (STATUSES as readonly string[]).includes(s) ? (s as DStatus) : reject(`unknown status "${s}" (confirmed|ghost|disputed|resolved)`)
}

function asType(s: string | undefined): DNodeType | undefined {
  if (s === undefined) return undefined
  return (NODE_TYPES as readonly string[]).includes(s) ? (s as DNodeType) : reject(`unknown type "${s}" (actor|system|step|decision|data)`)
}

/** Which board an op works on; the first content op makes a default board when none exists. */
function targetBoard(c: Ctx, op: DOp): string {
  if (op.board) {
    const id = findBoard(c.doc, op.board)
    return id ?? reject(`unknown board "${op.board}"`)
  }
  if (c.doc.active && c.doc.boards[c.doc.active]) return c.doc.active
  if (c.doc.order.length === 0) {
    setBoard(c, DEFAULT_BOARD, { id: DEFAULT_BOARD, title: 'Diagram', kind: 'other', nodes: {}, edges: {} }, [DEFAULT_BOARD])
    setActive(c, DEFAULT_BOARD)
    return DEFAULT_BOARD
  }
  return reject('no active board: switch_board first')
}

/** A board by id, or by title (case-insensitive). */
export function findBoard(doc: DDoc, ref: string): string | undefined {
  const s = slug(ref)
  if (doc.boards[s]) return s
  const low = ref.trim().toLowerCase()
  return doc.order.find(id => doc.boards[id]?.title.toLowerCase() === low)
}

function needNode(board: DBoard, id: string | undefined, field: string): DNode {
  if (!id) return reject(`${field} is required`)
  return board.nodes[id] ?? reject(`unknown node "${id}"`)
}

function needEdge(board: DBoard, ref: string | undefined, field: string): DEdge {
  if (!ref) return reject(`${field} is required`)
  return board.edges[edgeId(ref)] ?? reject(`unknown edge "${ref}"`)
}

function addEdge(c: Ctx, b: string, from: string, to: string, base: Partial<DEdge>) {
  const board = c.doc.boards[b]!
  if (from === to) reject('no self-loops')
  needNode(board, from, 'from')
  needNode(board, to, 'to')
  const id = `${from}->${to}`
  if (board.edges[id]) reject(`edge "${id}" already exists`)
  const edge: DEdge = {
    id,
    from,
    to,
    label: base.label ?? null,
    status: base.status ?? 'confirmed',
    note: base.note ?? null,
    v: c.version,
  }
  if (base.wasDisputed || edge.status === 'disputed') edge.wasDisputed = true
  setEdge(c, b, id, edge)
  if (b === c.doc.active) c.added.add(id)
}

function applyOne(c: Ctx, op: DOp) {
  switch (op.op) {
    case 'new_board': {
      const id = op.id ?? (op.title ? slug(op.title) : '')
      if (!id) reject('id is required')
      if (c.doc.boards[id]) reject(`board "${id}" already exists (use switch_board)`)
      const kind = op.kind ?? 'other'
      if (!(KINDS as readonly string[]).includes(kind)) reject(`unknown kind "${kind}" (process|architecture|sequence|mindmap|other)`)
      const title = cut(op.title ?? id, MAX_TITLE)
      setBoard(c, id, { id, title, kind: kind as DKind, nodes: {}, edges: {} }, [...c.doc.order, id])
      setActive(c, id)
      return
    }
    case 'switch_board': {
      const ref = op.board ?? op.id
      if (!ref) reject('board is required')
      const id = findBoard(c.doc, ref!) ?? reject(`unknown board "${ref}"`)
      setActive(c, id)
      return
    }
    case 'rename_board': {
      if (!op.title) reject('title is required')
      const b = op.board ? findBoard(c.doc, op.board) ?? reject(`unknown board "${op.board}"`) : c.doc.active
      if (!b || !c.doc.boards[b]) reject('no active board')
      const board = c.doc.boards[b!]!
      setBoard(c, b!, { ...clone(board), title: cut(op.title!, MAX_TITLE) }, [...c.doc.order])
      return
    }
    case 'clear': {
      const b = targetBoard(c, op)
      const board = c.doc.boards[b]!
      setBoard(c, b, { ...board, nodes: {}, edges: {} }, [...c.doc.order])
      if (b === c.doc.active) {
        for (const id of Object.keys(board.nodes)) c.changed.add(id)
      }
      return
    }
    case 'undo_last':
      return // handled by applyOps
  }

  const b = targetBoard(c, op)
  const board = c.doc.boards[b]!
  switch (op.op) {
    case 'add_node': {
      if (!op.id) reject('id is required')
      if (!op.label) reject('label is required')
      if (!op.type) reject('type is required (actor|system|step|decision|data)')
      if (board.nodes[op.id!]) reject(`node "${op.id}" already exists (use update_node)`)
      const status = asStatus(op.status) ?? 'confirmed'
      const node: DNode = {
        id: op.id!,
        label: cut(op.label!, MAX_LABEL),
        type: asType(op.type)!,
        status,
        note: op.note ? cut(op.note, MAX_NOTE) : null,
        v: c.version,
      }
      if (status === 'disputed') node.wasDisputed = true
      setNode(c, b, node.id, node)
      if (b === c.doc.active) c.added.add(node.id)
      return
    }
    case 'update_node': {
      const prev = needNode(board, op.id, 'id')
      if (!op.label && !op.type && !op.note && !op.status) reject('nothing to change (give label, type, note or status)')
      const type = asType(op.type)
      const status = asStatus(op.status)
      let node: DNode = { ...prev, v: c.version }
      if (op.label) node.label = cut(op.label, MAX_LABEL)
      if (type) node.type = type
      if (op.note) node.note = cut(op.note, MAX_NOTE)
      node = withStatus(node, prev, status)
      setNode(c, b, prev.id, node)
      return
    }
    case 'remove_node': {
      const node = needNode(board, op.id, 'id')
      for (const e of Object.values(board.edges)) {
        if (e.from === node.id || e.to === node.id) setEdge(c, b, e.id, null)
      }
      setNode(c, b, node.id, null)
      return
    }
    case 'connect': {
      if (!op.from) reject('from is required')
      if (!op.to) reject('to is required')
      const status = asStatus(op.status) ?? 'confirmed'
      addEdge(c, b, op.from!, op.to!, {
        label: op.label ? cut(op.label, MAX_LABEL) : null,
        status,
        note: op.note ? cut(op.note, MAX_NOTE) : null,
      })
      return
    }
    case 'disconnect': {
      const e = needEdge(board, op.edge ?? op.target ?? op.id, 'edge')
      setEdge(c, b, e.id, null)
      return
    }
    case 'reroute': {
      const e = needEdge(board, op.edge ?? op.target, 'edge')
      if (op.via) {
        const via = needNode(board, op.via, 'via')
        if (via.id === e.from || via.id === e.to) reject('via must be a third node')
        setEdge(c, b, e.id, null)
        const keep = { status: e.status, note: e.note, wasDisputed: e.wasDisputed }
        if (!board.edges[`${e.from}->${via.id}`]) addEdge(c, b, e.from, via.id, { ...keep, label: op.label ?? e.label })
        if (!board.edges[`${via.id}->${e.to}`]) addEdge(c, b, via.id, e.to, { ...keep, label: null })
        return
      }
      if (op.new_from || op.new_to) {
        const from = op.new_from ?? e.from
        const to = op.new_to ?? e.to
        if (from === e.from && to === e.to) reject('new_from/new_to name the same edge')
        setEdge(c, b, e.id, null)
        addEdge(c, b, from, to, {
          label: op.label ? cut(op.label, MAX_LABEL) : e.label,
          status: e.status,
          note: e.note,
          wasDisputed: e.wasDisputed,
        })
        return
      }
      if (op.label) {
        setEdge(c, b, e.id, { ...e, label: cut(op.label, MAX_LABEL), v: c.version })
        return
      }
      return reject('reroute needs via, new_from/new_to or label')
    }
    case 'mark': {
      const ref = op.target ?? op.id ?? op.edge
      if (!ref) reject('target is required')
      const status = asStatus(op.status) ?? reject('status is required')
      if (status === 'disputed' && !op.note) reject('disputed needs a note (the reason)')
      const node = board.nodes[slug(ref!)]
      if (node && !ref!.includes('->')) {
        let next: DNode = { ...node, v: c.version }
        if (op.note) next.note = cut(op.note, MAX_NOTE)
        next = withStatus(next, node, status)
        setNode(c, b, node.id, next)
        return
      }
      const e = board.edges[edgeId(ref)] ?? reject(`unknown node or edge "${ref}"`)
      let next: DEdge = { ...e, v: c.version }
      if (op.note) next.note = cut(op.note, MAX_NOTE)
      next = withStatus(next, e, status)
      setEdge(c, b, e.id, next)
      return
    }
  }
}

export type OpResult = { i: number; text: string; ok: boolean; reason?: string }

export type ApplyResult = {
  doc: DDoc
  applied: number
  rejected: number
  results: OpResult[]
  /** ids changed on the active board (nodes and edges) */
  changed: string[]
  /** node and edge ids added on the active board */
  added: string[]
  /** boards whose nodes or edges changed (for layout) */
  boards: string[]
  /** something changed (the version moved) */
  isChanged: boolean
  error?: string
  text: string
}

/** Apply one update_diagram call. The input doc is not changed. */
export function applyOps(input: DDoc, raw: unknown): ApplyResult {
  const doc = clone(input)
  const norm = normaliseOps(raw)
  const version = doc.version + 1
  const c: Ctx = { doc, inv: [], version, changed: new Set(), added: new Set(), boards: new Set() }
  const results: OpResult[] = []
  const applied: DOp[] = []
  let undid = false

  norm.ops.forEach((op, i) => {
    if ('error' in op) {
      results.push({ i, text: describeOp(op), ok: false, reason: op.error })
      return
    }
    if (op.op === 'undo_last') {
      const txn = [...doc.history].reverse().find(t => !t.undone)
      if (!txn) {
        results.push({ i, text: describeOp(op), ok: false, reason: 'nothing to undo' })
        return
      }
      for (const inv of [...txn.inverse].reverse()) {
        applyInverse(doc, inv)
        if (inv.k === 'node' || inv.k === 'edge') {
          c.boards.add(inv.b)
          if (inv.b === doc.active) c.changed.add(inv.id)
        } else if (inv.k === 'board') c.boards.add(inv.b)
      }
      txn.undone = true
      undid = true
      results.push({ i, text: describeOp(op), ok: true })
      return
    }
    const start = c.inv.length
    const marks = { changed: new Set(c.changed), added: new Set(c.added), boards: new Set(c.boards) }
    try {
      applyOne(c, op)
      applied.push(op)
      results.push({ i, text: describeOp(op), ok: true })
    } catch (err) {
      // roll back this op's partial changes
      for (const inv of c.inv.splice(start).reverse()) applyInverse(doc, inv)
      c.changed = marks.changed
      c.added = marks.added
      c.boards = marks.boards
      const reason = err instanceof Reject ? err.message : `internal error: ${String((err as Error)?.message ?? err)}`
      results.push({ i, text: describeOp(op), ok: false, reason })
    }
  })

  const isChanged = c.inv.length > 0 || undid
  if (c.inv.length > 0) {
    const txn: DTxn = { version, ops: applied, inverse: c.inv, undone: false }
    doc.history = [...doc.history, txn].slice(-HISTORY_MAX)
  }
  if (isChanged) doc.version = version
  // an element that was removed again is not "changed" for highlighting
  const active = doc.active ? doc.boards[doc.active] : undefined
  const changed = [...c.changed].filter(id => active && (active.nodes[id] || active.edges[id]))
  const added = [...c.added].filter(id => active && (active.nodes[id] || active.edges[id]))
  const okCount = results.filter(r => r.ok).length
  const bad = results.filter(r => !r.ok)
  const lines: string[] = []
  if (norm.error) lines.push(`applied 0 ops, rejected all: ${norm.error}`)
  else lines.push(`applied ${okCount} ops, rejected ${bad.length}${bad.length ? ':' : '.'}`)
  for (const r of bad) lines.push(`- ops[${r.i}] ${r.text}: ${r.reason}`)
  lines.push('', summary(doc))
  return {
    doc: isChanged ? doc : input,
    applied: okCount,
    rejected: bad.length,
    results,
    changed,
    added,
    boards: [...c.boards].filter(b => doc.boards[b]),
    isChanged,
    error: norm.error,
    text: lines.join('\n'),
  }
}

// ------------------------------------------------------------------ views

const q = (s: string) => JSON.stringify(s)

/** Every node id, type and label and every edge id and label of the active board; the other boards by name. */
export function summary(doc: DDoc): string {
  const board = doc.active ? doc.boards[doc.active] : undefined
  if (!board) return doc.order.length ? `no active board; boards: ${doc.order.join(', ')}` : 'the diagram is empty (no boards yet)'
  const nodes = Object.values(board.nodes)
  const edges = Object.values(board.edges)
  const out = [`board ${board.id} ${q(board.title)} (${board.kind}) v${doc.version}: ${nodes.length} nodes, ${edges.length} edges`]
  const st = (s: DStatus) => (s === 'confirmed' ? '' : ` [${s}]`)
  out.push(nodes.length ? 'nodes: ' + nodes.map(n => `${n.id} (${n.type}) ${q(n.label)}${st(n.status)}`).join('; ') : 'nodes: none')
  out.push(edges.length ? 'edges: ' + edges.map(e => `${e.id}${e.label ? ' ' + q(e.label) : ''}${st(e.status)}`).join('; ') : 'edges: none')
  const others = doc.order.filter(id => id !== board.id)
  if (others.length) out.push('other boards: ' + others.map(id => `${id} ${q(doc.boards[id]?.title ?? id)}`).join(', '))
  return out.join('\n')
}

export type CompactBoard =
  | {
      id: string
      title: string
      kind: DKind
      active: true
      nodes: { id: string; label: string; type: DNodeType; status: DStatus; note: string | null }[]
      edges: { id: string; label: string | null; status: DStatus }[]
    }
  | { id: string; title: string; kind: DKind; labels: string[] }

/** The active board in full; the other boards only by their node labels. */
export function compact(doc: DDoc): { version: number; active: string | null; boards: CompactBoard[] } {
  return {
    version: doc.version,
    active: doc.active,
    boards: doc.order
      .map(id => doc.boards[id])
      .filter((b): b is DBoard => !!b)
      .map(b =>
        b.id === doc.active
          ? {
              id: b.id,
              title: b.title,
              kind: b.kind,
              active: true as const,
              nodes: Object.values(b.nodes).map(n => ({ id: n.id, label: n.label, type: n.type, status: n.status, note: n.note })),
              edges: Object.values(b.edges).map(e => ({ id: e.id, label: e.label, status: e.status })),
            }
          : { id: b.id, title: b.title, kind: b.kind, labels: Object.values(b.nodes).map(n => n.label) },
      ),
  }
}

/** Make a board active (a tab press, /diagram <board>). */
export function switchTo(doc: DDoc, id: string): DDoc {
  if (!doc.boards[id] || doc.active === id) return doc
  return { ...doc, active: id, version: doc.version + 1 }
}

/** /diagram clear: every board gone. */
export function wipe(doc: DDoc): DDoc {
  return { ...emptyDoc(), version: doc.version + 1 }
}
