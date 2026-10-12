// Sample boards for the tests, SNAPSHOT.md and the SVG previews. Built through
// applyOps, so they are boards the tool could have drawn.

import type { DBoard, DDoc, DOp } from '../types'
import { applyOps, emptyDoc } from '../hooks/board.ts'

export const PIPELINE: DOp[] = [
  { op: 'new_board', id: 'pipeline', title: 'ShapeTheTalk pipeline', kind: 'process' },
  { op: 'add_node', id: 'speaker', label: 'Speaker', type: 'actor' },
  { op: 'add_node', id: 'mic', label: 'Browser mic', type: 'system', note: 'PCM over /ws/mic' },
  { op: 'add_node', id: 'stt', label: 'Realtime transcription', type: 'system', note: 'gpt-live-transcribe' },
  { op: 'add_node', id: 'extractor', label: 'Extractor', type: 'system', note: 'classifies each utterance' },
  { op: 'add_node', id: 'chit_chat', label: 'Chit chat?', type: 'decision' },
  { op: 'add_node', id: 'modeller', label: 'Modeller', type: 'system', note: 'emits typed ops' },
  { op: 'add_node', id: 'validate', label: 'Validate ops', type: 'step' },
  { op: 'add_node', id: 'board', label: 'Board state', type: 'data', note: 'versioned' },
  { op: 'add_node', id: 'web', label: 'Web whiteboard', type: 'system', note: 'rough.js SVG' },
  { op: 'add_node', id: 'analyst', label: 'Analyst', type: 'system', status: 'ghost' },
  { op: 'connect', from: 'speaker', to: 'mic', label: 'speaks' },
  { op: 'connect', from: 'mic', to: 'stt', label: 'audio' },
  { op: 'connect', from: 'stt', to: 'extractor', label: 'utterances' },
  { op: 'connect', from: 'extractor', to: 'chit_chat' },
  { op: 'connect', from: 'chit_chat', to: 'modeller', label: 'no' },
  { op: 'connect', from: 'modeller', to: 'validate', label: 'ops' },
  { op: 'connect', from: 'validate', to: 'board' },
  { op: 'connect', from: 'board', to: 'web', label: 'events' },
  { op: 'connect', from: 'board', to: 'analyst', status: 'ghost' },
]

export const WEB_REQUEST: DOp[] = [
  { op: 'new_board', id: 'request', title: 'A web request', kind: 'architecture' },
  { op: 'add_node', id: 'user', label: 'User', type: 'actor' },
  { op: 'add_node', id: 'cdn', label: 'CDN', type: 'system' },
  { op: 'add_node', id: 'lb', label: 'Load balancer', type: 'system' },
  { op: 'add_node', id: 'api', label: 'API server', type: 'system', note: 'stateless, 3 replicas' },
  { op: 'add_node', id: 'auth', label: 'Auth service', type: 'system' },
  { op: 'add_node', id: 'cache_hit', label: 'In cache?', type: 'decision' },
  { op: 'add_node', id: 'cache', label: 'Redis cache', type: 'data' },
  { op: 'add_node', id: 'db', label: 'Postgres', type: 'data' },
  { op: 'add_node', id: 'queue', label: 'Job queue', type: 'data', status: 'disputed', note: 'Kafka or SQS?' },
  { op: 'add_node', id: 'worker', label: 'Worker', type: 'system' },
  { op: 'add_node', id: 'respond', label: 'Render response', type: 'step' },
  { op: 'connect', from: 'user', to: 'cdn', label: 'HTTPS' },
  { op: 'connect', from: 'cdn', to: 'lb', label: 'on miss' },
  { op: 'connect', from: 'lb', to: 'api' },
  { op: 'connect', from: 'api', to: 'auth', label: 'verify token' },
  { op: 'connect', from: 'api', to: 'cache_hit' },
  { op: 'connect', from: 'cache_hit', to: 'cache', label: 'yes' },
  { op: 'connect', from: 'cache_hit', to: 'db', label: 'no' },
  { op: 'connect', from: 'db', to: 'cache', label: 'fill' },
  { op: 'connect', from: 'api', to: 'queue', label: 'events', status: 'disputed', note: 'ordering?' },
  { op: 'connect', from: 'queue', to: 'worker' },
  { op: 'connect', from: 'worker', to: 'api', label: 'retry' },
  { op: 'connect', from: 'cache', to: 'respond' },
  { op: 'connect', from: 'respond', to: 'user' },
]

export const STATUSES: DOp[] = [
  { op: 'new_board', id: 'statuses', title: 'Statuses', kind: 'other' },
  { op: 'add_node', id: 'a', label: 'Confirmed step', type: 'step' },
  { op: 'add_node', id: 'b', label: 'Proposed cache', type: 'data', status: 'ghost', note: 'optional' },
  { op: 'add_node', id: 'c', label: 'Sharding', type: 'system', status: 'disputed', note: 'too early?' },
  { op: 'add_node', id: 'd', label: 'Retry policy', type: 'step', status: 'disputed', note: 'how many?' },
  { op: 'add_node', id: 'e', label: 'Ops team', type: 'actor' },
  { op: 'connect', from: 'a', to: 'b', status: 'ghost' },
  { op: 'connect', from: 'a', to: 'c', label: 'scales', status: 'disputed', note: 'maybe' },
  { op: 'connect', from: 'c', to: 'd' },
  { op: 'connect', from: 'e', to: 'a', label: 'runs' },
  { op: 'mark', target: 'd', status: 'confirmed' },
]

const TYPES = ['system', 'step', 'data', 'actor', 'decision'] as const

/** A layered board of n nodes (a tree with a few cross links). */
export function bigOps(n: number, id = `big${n}`): DOp[] {
  const ops: DOp[] = [{ op: 'new_board', id, title: `${n} nodes`, kind: 'architecture' }]
  for (let i = 0; i < n; i++) {
    ops.push({ op: 'add_node', id: `n${i}`, label: `Service ${i} ${i % 3 === 0 ? 'gateway' : 'worker'}`, type: TYPES[i % 5]!, note: i % 4 === 0 ? 'handles the hot path' : undefined })
  }
  for (let i = 1; i < n; i++) ops.push({ op: 'connect', from: `n${Math.floor((i - 1) / 2)}`, to: `n${i}`, label: i % 3 === 0 ? 'calls' : undefined })
  for (let i = 3; i + 4 < n; i += 5) ops.push({ op: 'connect', from: `n${i}`, to: `n${i + 4}` })
  return ops
}

export function docFrom(...calls: DOp[][]): DDoc {
  let doc = emptyDoc()
  for (const ops of calls) doc = applyOps(doc, ops).doc
  return doc
}

export function boardFrom(ops: DOp[]): DBoard {
  const doc = docFrom(ops)
  return doc.boards[doc.active!]!
}

export const SAMPLES: { name: string; ops: DOp[] }[] = [
  { name: 'pipeline', ops: PIPELINE },
  { name: 'web request', ops: WEB_REQUEST },
  { name: 'statuses', ops: STATUSES },
  { name: '20 nodes', ops: bigOps(20) },
]
