// What the model reads: the two tools' descriptions and input schemas.

export const UPDATE_TOOL = 'update_diagram'
export const GET_TOOL = 'get_diagram'

export const UPDATE_DESCRIPTION = `Draw and live-edit a diagram in a pane beside the conversation (a shared whiteboard). Use it whenever a picture helps the user follow you: architecture, a code path or request lifecycle, a data flow or state machine, designing or comparing a system, onboarding to a codebase, brainstorming.

Build it step by step while you explain, like drawing on a whiteboard as you talk:
- One call per idea: 1-3 nodes plus their edges, then a sentence or two of explanation, then the next call.
- Start with the entry point or actor and follow the flow.
- Never send the whole board in one call. Each correction is its own small call.

Rules for a readable board:
- 8-20 nodes per board; split a bigger subject into boards (new_board = a tab).
- Labels 1-4 words; details go in note (max ~10 words).
- Node types: actor (person/role/external party), system (service, app, module), step (an action, verb phrase), decision (yes/no branch, label ends with "?"), data (DB, queue, file, cache).
- Edges point in the direction of flow or call (caller -> callee). Edge labels only when they add meaning, 1-3 words. Edge ids are "from->to".
- ids: short snake_case, stable. Reuse them exactly; call get_diagram if unsure what exists.
- Send only the ops that change something. Never redraw or clear a board to fix it; correct in place (update_node, reroute, disconnect, remove_node).
- Status: ghost for proposals, disputed for an open question (note says why), mark confirmed to accept.
- undo_last reverts your previous call.

Ops apply in order; later ops may use ids added earlier in the same call. Invalid ops are rejected with a reason and the rest still apply; fix and resend only what failed. The pane opens on the first update; the user can also run /diagram.`

const OP_REFERENCE = `The operation. Fields per op:
- new_board: id, title, kind? (process|architecture|sequence|mindmap|other). Creates a tab and makes it active.
- switch_board: board. Makes an existing board active.
- rename_board: title. Renames the active board.
- add_node: id, label, type, status?, note?. status defaults to confirmed.
- update_node: id, label?, type?, note?, status?. Renames/retypes in place; it keeps its position.
- remove_node: id. Also drops its edges.
- connect: from, to, label?, status?, note?. The edge id is "from->to"; no self-loops.
- disconnect: edge.
- reroute: edge plus one of: via (a->b becomes a->via->b; via must be an existing node), new_from and/or new_to (move an end; both = reverse), label alone (relabel).
- mark confirmed on a disputed element shows it as resolved.
- mark: target (node or edge id), status, note?. disputed needs a note (the reason).
- clear: empties the active board (undoable).
- undo_last: reverts the previous update_diagram call.
Any op may carry board to target a board other than the active one.`

export const UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      description:
        'Edit ops, applied in order. Each op is an object with "op" plus the fields that op uses. Keep it small: one idea per call (about 1-3 add_node plus their connect ops), with your explanation between calls; the user watches the board grow.',
      items: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: [
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
            ],
            description: OP_REFERENCE,
          },
          id: {
            type: 'string',
            description: 'Node id (add_node, update_node, remove_node) or board id (new_board). Short snake_case.',
          },
          label: {
            type: 'string',
            description: 'Node label (1-4 words) or edge label (1-3 words, e.g. "HTTPS", "on miss", "events"; connect, reroute).',
          },
          type: {
            type: 'string',
            enum: ['actor', 'system', 'step', 'decision', 'data'],
            description: 'Node type.',
          },
          status: {
            type: 'string',
            enum: ['confirmed', 'ghost', 'disputed', 'resolved'],
            description:
              'ghost = proposed/optional, disputed = open question or trade-off (needs a note), confirmed = accepted (a once-disputed element shows as resolved).',
          },
          note: {
            type: 'string',
            description: 'A short detail shown under the label (max ~10 words); for disputed, the reason.',
          },
          from: { type: 'string', description: 'connect: the source node id (caller, or earlier in the flow).' },
          to: { type: 'string', description: 'connect: the target node id.' },
          edge: { type: 'string', description: 'disconnect, reroute: the edge id "from->to".' },
          via: { type: 'string', description: 'reroute: an existing node to insert into the edge.' },
          new_from: { type: 'string', description: 'reroute: the new source node id.' },
          new_to: { type: 'string', description: 'reroute: the new target node id.' },
          target: { type: 'string', description: 'mark: the node id or edge id "from->to".' },
          title: { type: 'string', description: 'new_board, rename_board: the board title.' },
          kind: {
            type: 'string',
            enum: ['process', 'architecture', 'sequence', 'mindmap', 'other'],
            description: 'new_board: what kind of diagram.',
          },
          board: {
            type: 'string',
            description: 'switch_board: the board id. Any other op: apply it to this board instead of the active one.',
          },
        },
        required: ['op'],
      },
    },
  },
  required: ['ops'],
}

export const GET_DESCRIPTION =
  'Returns the current diagram as compact JSON: every board (tab), and for the active board each node (id, label, type, status, note) and edge (id "from->to", label, status). Call it before editing a diagram you did not just draw, so you reuse the exact ids.'

export const GET_SCHEMA = { type: 'object', properties: {} }
