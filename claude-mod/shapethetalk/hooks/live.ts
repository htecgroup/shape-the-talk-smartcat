// The "live" look: the board as a page in a real browser (terminal-browser's
// pane), with rich.ts's interactive SVG: pop-in animations for what just
// changed, hover styles and <title> tooltips. Pure: register.tsx writes the
// files and opens the page.
//
// live.html is written once per session dir and holds the board at that time;
// board.js next to it is rewritten on every change as
// `__shapethetalk({ v, title, svg, width, height })`. The page loads board.js
// again every POLL_MS with a fresh query (a <script> tag, which Chromium loads
// from file:// where fetch() is refused) and swaps the SVG in place when `v`
// changed, so the browser is never reopened and nothing flashes.
//
// The swap patches the drawing in place (keyed by data-id / data-key, the
// rest by position) instead of replacing it, so an element that is still there
// keeps its DOM node and its running CSS animation: during a staggered reveal
// each new node pops in and haloes once, from the moment it appears, while the
// ones before it carry on, as on the web whiteboard.

/** How often the page loads board.js again: well under a reveal step (150-1000 ms). */
export const POLL_MS = 250
/** Fit never draws the board larger than this many times its natural size. */
export const MAX_FIT = 1.6
export const LIVE_PAGE = 'live.html'
export const LIVE_DATA = 'board.js'
const BG = '#fbfaf6'

export type LiveBoard = {
  /** Changes whenever the drawing does (a hash of it). */
  v: string
  title: string
  /** rich.ts's non-static SVG (width and height 100%, viewBox, paper past it). */
  svg: string
  /** The drawing's natural size in px (for 100%). */
  width: number
  height: number
}

/** What board.js holds: one call, the board as JSON (JSON is valid JS). */
export function liveData(b: LiveBoard): string {
  return `window.__shapethetalk&&window.__shapethetalk(${JSON.stringify(b)});\n`
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The page: self-contained (inline style and script; the only other file it
 * reads is board.js beside it), the board inline from the start, a Fit / 100%
 * toggle, and the poll.
 */
export function liveHtml(b: LiveBoard): string {
  // the initial board as JSON inside a <script>: `<` escaped so no `</script>` can end it early
  const initial = JSON.stringify(b).replace(/</g, '\\u003c')
  const css = [
    `html,body{margin:0;height:100%;background:${BG};font:13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#495057}`,
    `#board{position:fixed;inset:0;overflow:auto}`,
    `#board>svg{display:block;width:100%;height:100%}`,
    `body.natural #board>svg{width:var(--w);height:var(--h)}`,
    `#bar{position:fixed;top:6px;right:8px;display:flex;gap:6px;align-items:center;z-index:2;opacity:.55;transition:opacity .2s}`,
    `#bar:hover{opacity:1}`,
    `#bar button{font:inherit;border:1px solid #ced4da;background:#fff;border-radius:6px;padding:2px 8px;cursor:pointer}`,
    `#bar .t{max-width:40vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
  ].join('')
  const js = `(function(){
var cur=${initial};
var host=document.getElementById('board'),title=document.getElementById('t'),zoom=document.getElementById('z');
function key(n){if(n.nodeType!==1)return null;var i=n.getAttribute('data-id');if(i!=null)return 'i:'+i;var k=n.getAttribute('data-key');return k!=null?'k:'+k:null;}
function sync(o,n){
  if(o.nodeType!==1||n.nodeType!==1){if(o.nodeType===n.nodeType&&o.nodeType!==1){if(o.nodeValue!==n.nodeValue)o.nodeValue=n.nodeValue;return o;}o.replaceWith(n);return n;}
  if(o.tagName!==n.tagName||key(o)!==key(n)){o.replaceWith(n);return n;}
  var i,a;
  for(i=o.attributes.length-1;i>=0;i--){a=o.attributes[i];if(!n.hasAttribute(a.name))o.removeAttribute(a.name);}
  for(i=0;i<n.attributes.length;i++){a=n.attributes[i];if(o.getAttribute(a.name)!==a.value)o.setAttribute(a.name,a.value);}
  if(o.tagName.toLowerCase()==='style'){if(o.textContent!==n.textContent)o.textContent=n.textContent;return o;}
  var oc=Array.prototype.slice.call(o.childNodes),nc=Array.prototype.slice.call(n.childNodes);
  var keyed={},plain=[],used=[],out=[],u=0;
  oc.forEach(function(c){var k=key(c);if(k)keyed[k]=c;else plain.push(c);});
  nc.forEach(function(c){
    var k=key(c),m=k?keyed[k]:plain[u++];
    if(m&&used.indexOf(m)<0){used.push(m);out.push(sync(m,c));}else out.push(c);
  });
  oc.forEach(function(c){if(used.indexOf(c)<0&&out.indexOf(c)<0&&c.parentNode===o)o.removeChild(c);});
  for(i=0;i<out.length;i++){if(o.childNodes[i]!==out[i])o.insertBefore(out[i],o.childNodes[i]||null);}
  while(o.childNodes.length>out.length)o.removeChild(o.lastChild);
  return o;
}
function show(b){
  var old=host.firstElementChild;
  try{
    if(!old||old.tagName.toLowerCase()!=='svg')throw 0;
    var t=document.createElement('div');t.innerHTML=b.svg;
    var neu=t.firstElementChild;
    if(!neu||neu.tagName.toLowerCase()!=='svg')throw 0;
    sync(old,neu);
  }catch(err){host.innerHTML=b.svg;}
  document.body.style.setProperty('--w',b.width+'px');
  document.body.style.setProperty('--h',b.height+'px');
  document.title=b.title+' · ShapeTheTalk';
  title.textContent=b.title;
  cap();
}
// Fit, but at most MAX_FIT x natural size: the viewBox widens around the drawing (the paper fills the page),
// so a board that is still growing (one node, then two...) is not blown up
function cap(){
  var svg=host.firstElementChild;
  if(!svg||svg.tagName.toLowerCase()!=='svg')return;
  var vb=svg.getAttribute('data-vb')||svg.getAttribute('viewBox');
  if(!vb)return;
  svg.setAttribute('data-vb',vb);
  var p=vb.split(/[\\s,]+/).map(Number),W=host.clientWidth,H=host.clientHeight;
  var k=Math.min(W/p[2],H/p[3]);
  if(document.body.classList.contains('natural')||!(k>${MAX_FIT})){svg.setAttribute('viewBox',vb);return;}
  var w=W/${MAX_FIT},h=H/${MAX_FIT};
  svg.setAttribute('viewBox',[p[0]-(w-p[2])/2,p[1]-(h-p[3])/2,w,h].join(' '));
}
window.addEventListener('resize',cap);
window.__shapethetalk=function(b){if(b&&b.v!==cur.v){cur=b;show(b);}};
zoom.onclick=function(){var n=document.body.classList.toggle('natural');zoom.textContent=n?'Fit':'100%';cap();};
cap();
function poll(){
  var s=document.createElement('script');
  s.src='${LIVE_DATA}?t='+Date.now();
  s.onload=s.onerror=function(){s.remove();};
  document.head.appendChild(s);
}
setInterval(poll,${POLL_MS});
})();`
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escText(b.title)} · ShapeTheTalk</title><style>${css}</style></head>` +
    `<body style="--w:${Math.round(b.width)}px;--h:${Math.round(b.height)}px"><div id="bar"><span class="t" id="t">${escText(b.title)}</span><button id="z" type="button">100%</button></div>` +
    `<div id="board">${b.svg}</div><script>${js}</script></body></html>`
  )
}
