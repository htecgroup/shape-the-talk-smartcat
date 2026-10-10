/* Small SVG and text helpers shared by the board modules. */
const BoardSvg = (() => {
  const NS = "http://www.w3.org/2000/svg";

  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  const key = (b, id) => `${b}:${id}`;
  const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return Math.abs(h) % 100000 + 1; };
  const measureCtx = document.createElement("canvas").getContext("2d");
  const textW = (t, font) => { measureCtx.font = font; return measureCtx.measureText(t).width; };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  return { el, key, hash, textW, esc };
})();
