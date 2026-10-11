/* Board image export (PNG, drawn from a standalone SVG of the board).
 *
 * Works on the live #svg: clones it, drops what only makes sense on screen (camera
 * pan/zoom, the endless dot background, effect chips, nodes on their way out,
 * entry/flash animations), crops to the drawn content, and inlines the board CSS
 * and the Kalam font, so the image looks like the board without the page around it.
 */
const BoardExport = (() => {
  const PAD = 32;
  const PAPER = "#faf7f2";          // --board
  const MAX_SIDE = 8192;            // keep canvases inside browser limits
  const HAND = '"Kalam", "Comic Sans MS", cursive';
  const SANS = '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif';

  // The static board rules of style.css (no animations: an image shows one frame, and
  // nodes that just appeared would be caught mid "pop-in", scaled down and transparent).
  const CSS = `
.node.ghost .shape { opacity: .62; }
.node-label { font-family: ${HAND}; font-weight: 700; fill: #212529; font-size: 16px; text-anchor: middle; dominant-baseline: central; }
.node.ghost .node-label { fill: #868e96; font-weight: 400; }
.node-note { font-family: ${SANS}; font-size: 10.5px; fill: #6c757d; text-anchor: middle; }
.node .halo { display: none; }
.edge path.line { fill: none; stroke: #495057; stroke-width: 1.9; stroke-linecap: round; }
.edge.ghost path.line { stroke: #adb5bd; stroke-dasharray: 7 6; }
.edge.disputed path.line { stroke: #e03131; stroke-width: 2.3; stroke-dasharray: 3 5; }
.edge.resolved path.line { stroke: #2b8a3e; }
.edge path.glow { display: none; }
.edge-label rect { fill: ${PAPER}; stroke: none; }
.edge-label text { font-family: ${HAND}; font-size: 13px; fill: #495057; text-anchor: middle; dominant-baseline: central; }
.edge.disputed .edge-label text { fill: #c92a2a; }
.group rect { fill: rgba(73, 80, 87, .035); stroke: #ced4da; stroke-dasharray: 6 5; stroke-width: 1.5; }
.group text { font-family: ${HAND}; font-size: 14px; fill: #868e96; font-weight: 700; }`;

  // Kalam is embedded as data: URLs. An SVG drawn as an image can't use the page's fonts, and a font
  // from another origin would taint the canvas and block toBlob. The bytes come from the Google Fonts
  // stylesheet the page already loads (index.html), so they are browser-cache hits, nothing new.
  let fontCss = null;

  async function toDataUrl(url) {
    const blob = await (await fetch(url)).blob();
    return new Promise((ok, fail) => {
      const r = new FileReader();
      r.onload = () => ok(r.result); r.onerror = fail;
      r.readAsDataURL(blob);
    });
  }

  // The page's Kalam @font-face rules (latin subset), with each font URL replaced by a data: URL.
  async function embeddedFonts() {
    if (fontCss !== null) return fontCss;
    try {
      const link = document.querySelector('link[href*="fonts.googleapis.com"][href*="Kalam"]');
      if (!link) throw new Error("no Google Fonts stylesheet with Kalam on the page");
      const css = await (await fetch(link.href)).text();
      // Google's CSS is a list of "/* subset */ @font-face {...}" blocks; keep Kalam's latin ones.
      const blocks = css.split("/*").filter((b) => /^\s*latin\s*\*\//.test(b) && /font-family:\s*'Kalam'/.test(b));
      if (!blocks.length) throw new Error("no latin Kalam faces in the stylesheet");
      const faces = await Promise.all(blocks.map(async (b) => {
        const face = b.slice(b.indexOf("@font-face"));
        const url = face.match(/url\(([^)]+)\)/)[1];
        return face.replace(url, await toDataUrl(url));
      }));
      fontCss = faces.join("\n");
    } catch (e) {
      console.warn("board export: Kalam font not embedded, falling back to a cursive font", e);
      fontCss = "";
    }
    return fontCss;
  }

  // Union of the drawn layers' boxes, in board coordinates (getBBox ignores the camera transform).
  function contentBox(svg) {
    let box = null;
    for (const id of ["groupsLayer", "edgesLayer", "nodesLayer"]) {
      const layer = svg.querySelector("#" + id);
      if (!layer || !layer.childElementCount) continue;
      const b = layer.getBBox();
      if (!b.width && !b.height) continue;
      box = box ? {
        x: Math.min(box.x, b.x), y: Math.min(box.y, b.y),
        x2: Math.max(box.x2, b.x + b.width), y2: Math.max(box.y2, b.y + b.height),
      } : { x: b.x, y: b.y, x2: b.x + b.width, y2: b.y + b.height };
    }
    return box && { x: box.x, y: box.y, w: box.x2 - box.x, h: box.y2 - box.y };
  }

  /** A standalone SVG document of the board as drawn now, or null when the board is empty. */
  async function svgString(svg = document.getElementById("svg")) {
    const box = contentBox(svg);
    if (!box) return null;
    const w = Math.ceil(box.w + 2 * PAD), h = Math.ceil(box.h + 2 * PAD);

    const out = svg.cloneNode(true);
    out.removeAttribute("id");
    out.removeAttribute("class");
    for (const sel of ["#fxLayer", "#bgRect", ".exit"]) out.querySelectorAll(sel).forEach((n) => n.remove());
    out.querySelectorAll(".enter, .flash").forEach((n) => n.classList.remove("enter", "flash"));
    out.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    out.setAttribute("width", w); out.setAttribute("height", h);
    out.setAttribute("viewBox", `0 0 ${w} ${h}`);
    out.querySelector("#camera").setAttribute("transform", `translate(${PAD - box.x},${PAD - box.y})`);

    const NS = "http://www.w3.org/2000/svg";
    const style = document.createElementNS(NS, "style");
    style.textContent = (await embeddedFonts()) + CSS;
    const bg = document.createElementNS(NS, "rect");
    Object.entries({ x: 0, y: 0, width: w, height: h, fill: PAPER }).forEach(([k, v]) => bg.setAttribute(k, v));
    const defs = out.querySelector("defs");
    defs.prepend(style);
    defs.after(bg);

    return { svg: new XMLSerializer().serializeToString(out), width: w, height: h };
  }

  /** The board as a PNG Blob, `scale` x its on-board size (2 = crisp on retina and in slides). */
  async function png(svg = document.getElementById("svg"), scale = 2) {
    const doc = await svgString(svg);
    if (!doc) return null;
    const k = Math.min(scale, MAX_SIDE / doc.width, MAX_SIDE / doc.height);
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(doc.svg);
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(doc.width * k); canvas.height = Math.round(doc.height * k);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((ok) => canvas.toBlob(ok, "image/png"));
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { png, download };
})();
