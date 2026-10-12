import { describe, expect, test } from 'claude-code/testing'

import { applyOps, compact, edgeId, emptyDoc, normaliseOps, slug, summary } from '../hooks/board.ts'
import type { DDoc } from '../types'

const run = (doc: DDoc, ops: unknown) => applyOps(doc, ops)
const board = (doc: DDoc) => doc.boards[doc.active!]!

const BASE = [
  { op: 'new_board', id: 'b1', title: 'First' },
  { op: 'add_node', id: 'a', label: 'A', type: 'system' },
  { op: 'add_node', id: 'b', label: 'B', type: 'step' },
  { op: 'add_node', id: 'c', label: 'C', type: 'data' },
  { op: 'connect', from: 'a', to: 'b', label: 'calls' },
]

describe('normalising and validation', () => {
  test('ids are slugged, empty strings are null, unknown fields dropped', () => {
    expect(slug('  Auth Service! ')).toBe('auth_service')
    expect(slug('x'.repeat(80))).toHaveLength(48)
    expect(edgeId('A -> B')).toBe('a->b')
    const { ops } = normaliseOps([{ op: 'add_node', id: 'My Node', label: '', type: 'step', colour: 'red' }])
    expect(ops[0]).toEqual({ op: 'add_node', id: 'my_node', type: 'step' })
  })

  test('invalid ops are rejected with a reason and the rest still apply', () => {
    const r = run(emptyDoc(), [
      { op: 'add_node', id: 'a', label: 'A', type: 'system' },
      { op: 'add_node', id: 'b', label: 'B', type: 'blob' },
      { op: 'connect', from: 'a', to: 'zz' },
      { op: 'explode' },
      { op: 'add_node', id: 'c', label: 'C', type: 'step' },
    ])
    expect(r.applied).toBe(2)
    expect(r.rejected).toBe(3)
    expect(r.text).toContain('applied 2 ops, rejected 3:')
    expect(r.text).toContain('- ops[1] add_node b: unknown type "blob"')
    expect(r.text).toContain('- ops[2] connect a->zz: unknown node "zz"')
    expect(r.text).toContain('unknown op "explode"')
    expect(Object.keys(board(r.doc).nodes)).toEqual(['a', 'c'])
  })

  test('a failed op rolls back its partial changes', () => {
    let doc = run(emptyDoc(), BASE).doc
    doc = run(doc, [{ op: 'connect', from: 'c', to: 'b' }]).doc
    // reroute removes a->b first, then fails to add c->b (exists): a->b must come back
    const r = run(doc, [{ op: 'reroute', edge: 'a->b', new_from: 'c' }])
    expect(r.rejected).toBe(1)
    expect(r.text).toContain('already exists')
    expect(board(r.doc).edges['a->b']?.label).toBe('calls')
    expect(r.doc.version).toBe(doc.version)
  })

  test('ops that are not an array, or arrive as a JSON string', () => {
    const bad = run(emptyDoc(), 42)
    expect(bad.applied).toBe(0)
    expect(bad.text).toContain('ops must be an array')
    const str = run(emptyDoc(), JSON.stringify([{ op: 'add_node', id: 'x', label: 'X', type: 'actor' }]))
    expect(str.applied).toBe(1)
    const broken = run(emptyDoc(), '[{"op": "add_node"')
    expect(broken.text).toContain('not valid JSON')
  })
})

describe('applying', () => {
  test('add and connect', () => {
    const r = run(emptyDoc(), BASE)
    const b = board(r.doc)
    expect(r.rejected).toBe(0)
    expect(Object.keys(b.nodes)).toEqual(['a', 'b', 'c'])
    expect(b.edges['a->b']).toMatchObject({ from: 'a', to: 'b', label: 'calls', status: 'confirmed' })
    expect(r.added).toContain('a')
    expect(run(r.doc, [{ op: 'connect', from: 'a', to: 'a' }]).text).toContain('no self-loops')
  })

  test('reroute via, new_from, relabel and reverse', () => {
    let doc = run(emptyDoc(), BASE).doc
    doc = run(doc, [{ op: 'reroute', edge: 'A -> B', via: 'c' }]).doc
    expect(Object.keys(board(doc).edges).sort()).toEqual(['a->c', 'c->b'])
    expect(board(doc).edges['a->c']?.label).toBe('calls')
    doc = run(doc, [{ op: 'reroute', edge: 'c->b', label: 'reads' }]).doc
    expect(board(doc).edges['c->b']?.label).toBe('reads')
    doc = run(doc, [{ op: 'reroute', edge: 'c->b', new_from: 'b', new_to: 'c' }]).doc
    expect(board(doc).edges['b->c']?.label).toBe('reads')
    expect(board(doc).edges['c->b']).toBeUndefined()
    doc = run(doc, [{ op: 'reroute', edge: 'b->c', new_from: 'a' }]).doc
    expect(board(doc).edges['a->c']).toBeDefined()
    expect(run(doc, [{ op: 'reroute', edge: 'a->c' }]).text).toContain('reroute needs')
  })

  test('the mark lifecycle and the dispute rule', () => {
    let doc = run(emptyDoc(), BASE).doc
    expect(run(doc, [{ op: 'mark', target: 'a', status: 'disputed' }]).text).toContain('disputed needs a note')
    doc = run(doc, [{ op: 'mark', target: 'a', status: 'disputed', note: 'too slow?' }]).doc
    expect(board(doc).nodes.a).toMatchObject({ status: 'disputed', note: 'too slow?', wasDisputed: true })
    doc = run(doc, [{ op: 'mark', target: 'a', status: 'ghost' }]).doc
    expect(board(doc).nodes.a?.status).toBe('disputed')
    doc = run(doc, [{ op: 'mark', target: 'a', status: 'confirmed' }]).doc
    expect(board(doc).nodes.a?.status).toBe('resolved')
    doc = run(doc, [{ op: 'mark', target: 'b', status: 'resolved' }]).doc
    expect(board(doc).nodes.b?.status).toBe('confirmed')
    doc = run(doc, [{ op: 'mark', target: 'a->b', status: 'disputed', note: 'sync?' }]).doc
    expect(board(doc).edges['a->b']?.status).toBe('disputed')
    doc = run(doc, [{ op: 'mark', target: 'A -> B', status: 'confirmed' }]).doc
    expect(board(doc).edges['a->b']?.status).toBe('resolved')
  })

  test('undo_last, also twice in a row', () => {
    let doc = run(emptyDoc(), BASE).doc
    doc = run(doc, [{ op: 'add_node', id: 'd', label: 'D', type: 'step' }]).doc
    doc = run(doc, [{ op: 'update_node', id: 'a', label: 'Alpha' }]).doc
    doc = run(doc, [{ op: 'undo_last' }]).doc
    expect(board(doc).nodes.a?.label).toBe('A')
    expect(board(doc).nodes.d).toBeDefined()
    doc = run(doc, [{ op: 'undo_last' }]).doc
    expect(board(doc).nodes.d).toBeUndefined()
    doc = run(doc, [{ op: 'undo_last' }]).doc
    expect(doc.order).toEqual([])
    expect(run(doc, [{ op: 'undo_last' }]).text).toContain('nothing to undo')
  })

  test('clear, then undo', () => {
    let doc = run(emptyDoc(), BASE).doc
    doc = run(doc, [{ op: 'clear' }]).doc
    expect(Object.keys(board(doc).nodes)).toHaveLength(0)
    doc = run(doc, [{ op: 'undo_last' }]).doc
    expect(Object.keys(board(doc).nodes)).toEqual(['a', 'b', 'c'])
    expect(board(doc).edges['a->b']).toBeDefined()
  })

  test('several boards and the per-op board field', () => {
    let doc = run(emptyDoc(), BASE).doc
    doc = run(doc, [
      { op: 'new_board', id: 'b2', title: 'Second', kind: 'architecture' },
      { op: 'add_node', id: 'x', label: 'X', type: 'actor' },
      { op: 'add_node', id: 'y', label: 'Y', type: 'step', board: 'b1' },
      { op: 'rename_board', title: 'Second board' },
    ]).doc
    expect(doc.active).toBe('b2')
    expect(doc.order).toEqual(['b1', 'b2'])
    expect(doc.boards.b1?.nodes.y).toBeDefined()
    expect(doc.boards.b2?.nodes.x).toBeDefined()
    expect(doc.boards.b2?.title).toBe('Second board')
    doc = run(doc, [{ op: 'switch_board', board: 'First' }]).doc
    expect(doc.active).toBe('b1')
    expect(run(doc, [{ op: 'add_node', id: 'q', label: 'Q', type: 'step', board: 'nope' }]).text).toContain('unknown board')
  })

  test('the first content op makes a default board', () => {
    const r = run(emptyDoc(), [{ op: 'add_node', id: 'a', label: 'A', type: 'step' }])
    expect(r.doc.active).toBe('main')
    expect(r.doc.order).toEqual(['main'])
    expect(r.doc.version).toBe(1)
  })

  test('compact and summary name the ids', () => {
    let doc = run(emptyDoc(), BASE).doc
    doc = run(doc, [{ op: 'new_board', id: 'other', title: 'Other' }, { op: 'add_node', id: 'z', label: 'Zed', type: 'step' }, { op: 'switch_board', board: 'b1' }]).doc
    const s = summary(doc)
    expect(s).toContain('a (system) "A"')
    expect(s).toContain('a->b "calls"')
    expect(s).toContain('other "Other"')
    const c = compact(doc)
    expect(c.active).toBe('b1')
    expect(c.boards[0]).toMatchObject({ id: 'b1', active: true })
    expect(JSON.stringify(c.boards[0])).toContain('"a->b"')
    expect(c.boards[1]).toEqual({ id: 'other', title: 'Other', kind: 'other', labels: ['Zed'] })
    const r = run(doc, [{ op: 'connect', from: 'b', to: 'c' }])
    expect(r.text).toContain('b->c')
  })
})
