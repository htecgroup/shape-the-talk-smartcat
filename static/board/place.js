/* Stable incremental placement: a node gets a position once (next to the nodes it is connected to)
 * and keeps it. pos: Map "board:node" -> {x, y, dir}, shared with the renderer. */
const BoardPlace = (() => {
  const { key } = BoardSvg;
  const COLW = 250, ROWH = 128;

  function occupied(pos, boardId, ids, x, y, self) {
    for (const id of ids) {
      if (id === self) continue;
      const p = pos.get(key(boardId, id));
      if (p && Math.abs(p.x - x) < COLW * 0.82 && Math.abs(p.y - y) < ROWH * 0.8) return true;
    }
    return false;
  }

  function findFree(pos, boardId, ids, x, y, self) {
    const offs = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, 6, 7, 8];
    for (const o of offs) {
      const yy = y + o * ROWH;
      if (!occupied(pos, boardId, ids, x, yy, self)) return { x, y: yy };
    }
    return { x: x + COLW, y };
  }

  /* Place nodes that have no position yet. Existing nodes never move.
   * Flows run left-to-right; when a row is full the flow drops one row and
   * continues right-to-left (snake layout), so edges stay short.
   * maxCols() is how many columns fit the panel. */
  function placeNew(board, pos, maxCols) {
    const ids = Object.keys(board.nodes);
    const pending = ids.filter((id) => !pos.has(key(board.id, id)));
    if (!pending.length) return;
    pending.sort((a, b) => (board.nodes[a].created_v || 0) - (board.nodes[b].created_v || 0));
    const edges = Object.values(board.edges);
    const placed = (id) => pos.has(key(board.id, id));
    const P = (id) => pos.get(key(board.id, id));
    const cols = maxCols();
    const col = (x) => Math.round(x / COLW);
    const inRange = (x) => col(x) >= 0 && col(x) < cols;

    const placeAfter = (pred, id) => {
      const dir = pred.dir || 1;
      const x = pred.x + dir * COLW;
      if (inRange(x)) {
        const p = findFree(pos, board.id, ids, x, pred.y, id);
        if (p.x === x) return { ...p, dir };
      }
      // row is full: drop below and turn around
      const p = findFree(pos, board.id, ids, pred.x, pred.y + ROWH, id);
      return { ...p, dir: -dir };
    };

    let guard = 0;
    while (pending.length && guard++ < 500) {
      let progressed = false;
      for (const id of [...pending]) {
        let preds = edges.filter((e) => e.to === id && e.from !== id && placed(e.from)).map((e) => e.from);
        let succs = edges.filter((e) => e.from === id && e.to !== id && placed(e.to)).map((e) => e.to);
        // a node that joins an existing group goes next to its group mates
        const grp = board.nodes[id].group;
        const mates = grp ? ids.filter((m) => m !== id && placed(m) && board.nodes[m].group === grp) : [];
        if (mates.length) {
          const mp = preds.filter((m) => mates.includes(m)), ms = succs.filter((m) => mates.includes(m));
          if (mp.length || ms.length) { preds = mp; succs = ms; } else { preds = [mates[mates.length - 1]]; succs = []; }
        }
        preds = preds.map(P); succs = succs.map(P);
        let p = null;
        if (preds.length) {
          // follow the right-most / lowest predecessor in flow order
          const pred = preds.reduce((a, b) => (b.y > a.y || (b.y === a.y && b.x * (b.dir || 1) > a.x * (a.dir || 1)) ? b : a));
          p = placeAfter(pred, id);
        } else if (succs.length) {
          const s = succs[0];
          const dir = s.dir || 1;
          const x = s.x - dir * COLW;
          p = inRange(x) ? { ...findFree(pos, board.id, ids, x, s.y, id), dir } : { ...findFree(pos, board.id, ids, s.x, s.y - ROWH, id), dir };
        }
        if (p) {
          pos.set(key(board.id, id), p);
          pending.splice(pending.indexOf(id), 1);
          progressed = true;
        }
      }
      if (!progressed) {
        // an unconnected node: start a new row under everything else
        const id = pending.shift();
        const all = ids.filter(placed).map(P);
        const p = all.length
          ? { ...findFree(pos, board.id, ids, 0, Math.max(...all.map((q) => q.y)) + ROWH, id), dir: 1 }
          : { x: 0, y: 0, dir: 1 };
        pos.set(key(board.id, id), p);
      }
    }
  }

  return { placeNew };
})();
