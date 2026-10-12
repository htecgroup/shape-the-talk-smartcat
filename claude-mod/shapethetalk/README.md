# shapethetalk: a Claude Code mod

Claude draws and live-edits a whiteboard diagram in a pane beside the conversation while it explains or designs something. It is the ShapeTheTalk idea inside Claude Code: Claude emits typed edit ops through the `update_diagram` tool, and a deterministic renderer draws them.

- **Terminal, kitty or Ghostty, with [terminal-browser](https://github.com/zenbu-labs/terminal-browser) installed (the default look):** the live page, in a real Chromium in a pane beside the chat (below).
- **Terminal, kitty or Ghostty, without terminal-browser:** the same hand-drawn picture as the desktop, rasterised to a PNG and shown with the `Image` element, with tabs and zoom buttons.
- **Other terminals:** a coloured box-drawing grid (`Raster`), with tabs, pan buttons and a legend.
- **Desktop Code tab:** the web whiteboard's hand-drawn SVG (vendored rough.js, same seeds as `static/board/`), shown as an image with zoom buttons.

Tools: `mcp__shapethetalk__update_diagram` (ops) and `mcp__shapethetalk__get_diagram` (compact JSON). Commands: `/diagram [open|close|clear|tidy|list|look image|grid|auto|live|speed slow|normal|fast|off|cell <w>x<h>|<board>]`, and `/browser [url|close]` (the bundled terminal-browser pane, below).

### Building the board step by step

Like the web app, where the board grows piece by piece as people talk:

- **Claude is asked to draw in small steps.** The `update_diagram` description (1,748 of its 2,048 characters) says: one call per idea, 1-3 nodes plus their edges, a sentence or two between calls, start at the entry point or actor and follow the flow, never the whole board in one call, corrections as their own small calls. A call that adds more than 4 nodes gets a note in its result ("next time add this in smaller steps while you explain"); a smaller one is reminded to explain the step before the next call.
- **Even a big call builds up gradually.** The ops apply at once (the tool returns at once; undo, history and `get_diagram` see everything), but the renderers draw a *revealed* view that gains the call's new elements one at a time in flow order: a node, then its incoming edges (an edge only once both ends show), then the node reached from the newest one (a chain before a branch). The first appears at once, then 1000 ms before each node and 500 ms before each edge (`/diagram speed slow`, the default; `normal` 600/300, `fast` 300/150, `off` draws each call whole; kept in `$.state` `speed`). In-place updates and removals apply at once.
- **Animation per element.** Each revealed element gets the pop-in and halo as it appears, and the "Claude" chip follows the newest node. The live page patches its SVG in place (keyed by `data-id`), so earlier elements keep their running animation, as on the web board; the desktop Svg pops in only the latest step (a new source restarts every animation in it); the terminal picture keeps a steady halo on everything revealed in the run.
- **Robust.** Steps are chained `$.clock.after` timers. A new `update_diagram` call while a reveal runs fast-forwards it: what it still hid shows at once with the new call's first step, so nothing is lost. `/diagram clear|tidy|<board>`, a tab press and `/diagram speed off` end it too. The `$.state` `reveal` names only what is still hidden, so dropping it shows the whole board: `session.start` (a hot reload or a restart, whose timers are gone) drops it, renderers hide nothing unless this module load is driving the run, and anything still hidden 3 s past the run's planned end shows anyway.
- **Pacing per look.** The live page's `board.js` is rewritten on every step and the page polls it every 250 ms (was 500), so 500-1000 ms steps (the default `slow`) are visible. The terminal picture rasterises at most once a second during a reveal (the newest step wins, the ones between are skipped), since Chrome takes 0.6-0.8 s per PNG; the picture then grows in about 1 s jumps and lands on the full board.

`hooks/reveal.ts` holds the logic (pure, unit-tested in `tests/reveal.test.ts`, along with plugin tests on a mocked clock).


### The terminal picture

- **When:** `/diagram look auto` (the default) uses the picture when the session's environment says kitty or Ghostty (`TERM_PROGRAM`, `TERM`, `KITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR`) and not tmux (`TMUX`), read once per module load, and `terminal-browser` is not installed (with it, auto is the live look, below). `/diagram look image` or `/diagram look grid` forces one.
- **The first picture:** while it is drawn the pane shows a quiet "Drawing the picture…" line rather than the grid; only if it takes over 2 s does the grid show meanwhile.
- **How:** `rich.ts` draws a *still* SVG (`isStatic`: no CSS animation; recently changed ids keep a steady orange halo and the "Claude" chip, and edges a faint glow). `register.tsx` writes it to `$TMPDIR/shapethetalk-<session id>/` and runs `rsvg-convert` if it is on PATH, else headless Chrome (`--headless --force-device-scale-factor=1 --window-size=W,H --screenshot=…` on an HTML page holding the SVG at exactly the PNG size W×H, with its own `--user-data-dir`; rsvg-convert gets `-w W -h H`), about 0.6-0.8 s per picture on an M-series Mac (about 1.7 s the first time, while Chrome sets up the profile). The `Image` gets the PNG's bytes (`{ png: base64 }`, read once per file with `$.fs.read(…, { as: 'bytes' })` and kept in a module cache), which the terminal scales to fill the box. A `{ file }` source is drawn at the PNG's own pixel size and clipped to the box (that was the old cropping bug), so it is only the fallback for a PNG over 2 MiB or one that cannot be read.
- **Never blocking:** the render never waits for Chrome. A missing picture is asked for and the pane draws the previous PNG (or the grid, "Drawing the picture…") until the new one lands in `$.state` (`images`), which redraws the pane. One rasterise at a time, the newest ask wins, each one killed after 8 s. PNGs are keyed by board, doc version, placement, `recent.seq`, pane size, zoom, pan window and device scale, so scrolling and focus reuse them; the highlight clearing after 5 s draws one more.
- **Failure:** a failed rasterise shows the grid with a dim "Picture unavailable (…)" line and is not retried for that drawing; three failures in a row (or no rsvg-convert and no Chrome) keep the grid for the session until `/diagram look image`.
- **Size, zoom and pan:** each PNG is rasterised at exactly its box's device pixels: `columns × cell.w` by `rows × cell.h`, the cell 16×34 device px by default (Ghostty, default font, Retina; measured, since the engine reports no cell pixel size). `/diagram cell <w>x<h>` sets it for another font or screen (stored in `$.state` `cell`; `/diagram cell` shows it, `/diagram cell default` resets). At 100% a column stands for 8 drawing px (`COL_PX`), so a row for 8×h/w. The rasterised window of the drawing is exactly the box at that zoom (centred; at most half a cell past the drawing, where the paper continues), so the picture is never stretched and the rows match its aspect. `imageView` in `hooks/raster.ts` does the sizing. Fit fits both the pane's width and its free rows (at most 1.6× natural size, so a two-node board isn't huge). Every zoom or pan draws its own PNG under its own file name (the engine sends nothing for a source equal to the last one). The engine refuses `{ png }` sides over 4096 px, so a taller box (255 rows are 8670 px) gets a PNG shrunk evenly to 4096, which the terminal scales up (a little softer). + stops at the largest size whose box fits 255 rows ("(largest)"), so the % shown is what is drawn. A picture wider than the pane is rasterised only for the window shown (the SVG's viewBox cut to it), so the box is never wider than the pane; ◀ ▶ move the window ("columns a-b of N"), and zoom keeps its centre. A taller picture scrolls with the pane. While a new PNG is drawn the old one stays in its own box ("· drawing…"). The last 12 PNGs stay on disk so going back to a zoom is instant; older ones are deleted. The colour legend is left out (the picture says it). The temp dir is removed at session end.

### The live look (terminal-browser)

The default on kitty or Ghostty when `terminal-browser` is installed (or forced with `/diagram look live`): the board as a page in a real Chromium, in a [terminal-browser](https://github.com/zenbu-labs/terminal-browser) pane: CSS pop-in animations for what just changed, hover styles, and `<title>` tooltips on nodes and edges. A Fit / 100% button sits top right. The pane comes with this mod (`hooks/browser/`, below), so there is one plugin to load; only the `terminal-browser` app itself is installed separately.

- **Files:** `$TMPDIR/shapethetalk-<session>/live.html` (self-contained: inline style and script, the board inline) and `board.js` next to it, rewritten on every change and every reveal step as `__shapethetalk({ v, title, svg, width, height })` (`hooks/live.ts`). The page loads `board.js?t=<now>` with a `<script>` tag every 250 ms (Chromium refuses `fetch()` on `file://` but loads scripts) and, when `v` changes, patches the SVG in place (elements matched by `data-id`, so running animations carry on), so the browser is never reopened and nothing flashes. Fit draws a board at most 1.6× its natural size (the viewBox widens instead), so a board that is just starting is not blown up.
- **How auto picks it:** auto is live when the terminal shows images (as for the picture: kitty or Ghostty, not tmux) and `terminal-browser capabilities` reports the `embedding` and `image-frames` capabilities; else the picture; else the grid. That check runs once per module load, in the background, from `session.start` (terminal sessions on an image terminal only; killed after 5 s). The first `update_diagram` waits for it, at most 2 s, before showing the board anywhere, so the diagram pane never flashes up before the page: with terminal-browser only the browser pane opens; without it (or still unanswered after 2 s) the diagram pane opens with the picture. A missing binary in auto says nothing: no install hint in the tool result or the pane. A failed open in auto shows the picture with one dim line and is not retried; `/diagram look live` says why. `/diagram look` (no argument) shows the setting and what auto came to. The stored `look` stays `auto`, so sessions from before this change get it too.
- **`/diagram`, `/diagram open`, `/diagram close` in auto→live:** `/diagram` and `/diagram open` open (or bring to the front) the browser pane on the page; `/diagram` closes it when it, or the diagram pane, is open; `/diagram close` closes whichever is open, and updates then leave the page closed until `/diagram` again. Under an explicit `/diagram look live` they act on the diagram pane as before.
- **Opening:** `$.browser.open({ url: 'file://…/live.html' })`. `hooks/browser/browser.tsx` adds the `browser` noun to `$` in `engine.create` and answers its `browser.open` / `browser.close` events, starting `terminal-browser claude-bridge launch` on first use and drawing its frames in the `browser` pane. It is a noun and not a plain function call because the engine follows `$` into functions of the same file only, never across an import. An update opens the page again only if it isn't open and the person didn't close the pane. While the page is open the diagram pane is closed (`/diagram open` brings it back, showing the picture).
- **Without terminal-browser, under an explicit `/diagram look live`:** if the `terminal-browser` binary is not on PATH, the reply says `brew install terminal-browser` and the diagram pane shows the picture look with an orange note saying the same. A version that is too old (no `embedding`/`image-frames` capability) says `terminal-browser upgrade`, and a bridge that would not start gives its error. The look stays `live`, the page files are kept up to date, and updates do not retry the browser (run `/diagram look live` again after installing).
- `/diagram look image|grid` closes the browser pane if this mod opened it; so does `/diagram look auto` when auto comes to something other than live.
- **`/browser [url|close]`:** terminal-browser's own command, for any page (terminal sessions only). The optional agent tools `mcp__shapethetalk__browser_open` / `mcp__shapethetalk__browser_close` (upstream `mcp__terminal-browser__open` / `close`) are off by default; turn them on with the `agentTool` option under `pluginConfigs["shapethetalk"].options` in `~/.claude/settings.json`.

Prerequisites: kitty or Ghostty (kitty graphics with unicode placeholders), not tmux, and the app:

```bash
brew install terminal-browser        # then: terminal-browser config set telemetry.usage off (and telemetry.crashReports off)
claude --plugin-dir /path/to/claude-mod/shapethetalk   # live by default; nothing to type
```

Don't also load terminal-browser's own plugin: both would add `$.browser`, `/browser` and a `browser` pane.

**Attribution.** `hooks/browser/` is vendored from [zenbu-labs/terminal-browser](https://github.com/zenbu-labs/terminal-browser)'s `claude-code-plugin/hooks/` at commit `2165ae76c9639e3996829ab0e6d54ddbd4f06ad8`, under the MIT licence (Copyright 2026 Zenbu Labs, Inc.; `hooks/browser/LICENSE`). `surface.tsx`, `bridge-protocol.ts` and `urls.ts` are unchanged apart from a header. `browser.tsx` is its `register.tsx` adapted to run inside this mod's one hooks module, and its header lists the changes. The noun's types moved from its `browser.d.ts` into `types/index.d.ts`.

## Load it

```bash
# CLI: live by default in kitty/Ghostty when terminal-browser is installed, else the picture (or the grid)
claude --plugin-dir /path/to/claude-mod/shapethetalk
```

A terminal of 144+ columns opens the pane by itself; otherwise run `/diagram`. `/diagram look image|grid|live|auto` overrides the default.

On Claude Code 2.1.296 the hooks module loads without `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`; terminal-browser's README asks for it, so an older build may still need it (prefix the command with it, or set it under `env` in `~/.claude/settings.json`). The live look (the default where it can run) needs `brew install terminal-browser` (above).

Desktop app: add the absolute path to `CLAUDE_CODE_PLUGIN_DIRS` under `env` in `~/.claude/settings.json` and start a new session, or copy the folder into the session's `~/.claude/dev-mods/<session-id>/` after loading the `plugin-authoring` skill and enable hot reloading.

### Install for all sessions

`claude-mod/` is a self-contained marketplace: its `.claude-plugin/marketplace.json` names it `shape-the-talk` and lists this mod (`./shapethetalk`).

```bash
# local clone (user scope by default; -s project|local for one repo)
claude plugin marketplace add /path/to/shape-the-talk/claude-mod
claude plugin install shapethetalk@shape-the-talk
# or in one step
claude plugin install shapethetalk --marketplace /path/to/shape-the-talk/claude-mod

claude plugin list                                   # shapethetalk@shape-the-talk ✔ enabled
claude plugin disable shapethetalk@shape-the-talk    # enable to turn it back on
claude plugin uninstall shapethetalk@shape-the-talk
claude plugin marketplace remove shape-the-talk
```

Updating: a local-path install is read from the folder itself, so edits show at the next session or `/reload-plugins` (`claude plugin update` reports nothing to update). Teammates add the `claude-mod/` folder of their own clone the same way. (`claude plugin marketplace add <owner>/<repo>` from GitHub reads `.claude-plugin/marketplace.json` at the repo root, so it would need a root manifest pointing here.)

While it is installed, don't also pass `--plugin-dir` for this mod (it would load twice); disable the installed one for development, or keep using `--plugin-dir` and skip the install. `CLAUDE_CODE_PLUGIN_DIRS` (Desktop app, above) is the other way to load the live folder in every session.

Try: "Walk me through how an utterance flows through this app, from the mic to the whiteboard, and draw it as you explain."

## Check and test it

```bash
claude plugin validate claude-mod/shapethetalk --strict
claude plugin test claude-mod/shapethetalk
npx -y -p typescript@5 tsc -p claude-mod/shapethetalk   # needs .claude-plugin/types (below)
```

The engine writes `.claude-plugin/types/` (gitignored) when it loads the mod from a folder it watches: an interactive `claude --plugin-dir`, or headless with `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`:

```bash
CLAUDE_CODE_PLUGIN_DIR_WATCH=1 claude -p --plugin-dir claude-mod/shapethetalk \
  --allowedTools "mcp__shapethetalk__update_diagram,mcp__shapethetalk__get_diagram" \
  --output-format stream-json --verbose "Draw how a web request reaches the database"
```

## Look at it

```bash
node scripts/snapshot.ts   # terminal renders of the sample boards -> SNAPSHOT.md
node scripts/preview.ts    # desktop SVGs next to the web whiteboard -> preview/ (gitignored)
node scripts/still.ts 80 50 [k left cell]  # the terminal PNGs for an 80x50 pane (Fit, or zoom k panned to left 0..1, cell 16x34), with timings and PNG vs box size -> preview/*.still*.png
python3 -m http.server     # from the repo root, then open /claude-mod/shapethetalk/preview/index.html
```

The scripts need Node 23.6 or newer (it runs TypeScript directly).

## Layout

| path | what |
|---|---|
| `hooks/register.tsx` | wiring: tools, `/diagram`, pane open/close, scroll guard, terminal and desktop render, state atoms |
| `hooks/tools.ts` | tool descriptions and input schemas |
| `hooks/board.ts` | op normalisation, validation, apply, undo history, dispute rule, `compact()`/`summary()` |
| `hooks/layout.ts` | stable (rank, slot) placement: `placeNew()`, `fullLayout()` |
| `hooks/grid.ts` | terminal: cells, Dijkstra edge routing, Raster encoding, text snapshot |
| `hooks/rich.ts` | desktop and terminal picture: hand-drawn SVG, CSS animations (or a still), size budget |
| `hooks/raster.ts` | terminal picture: image detection, cell sizing, rsvg-convert / Chrome argv (register.tsx runs them) |
| `hooks/live.ts` | live look: the self-contained page and its polled `board.js` |
| `hooks/reveal.ts` | staggered reveal: flow order, timing, fast-forward, self-heal |
| `hooks/browser/` | the terminal-browser pane and `$.browser` noun, vendored from zenbu-labs/terminal-browser (MIT, see its LICENSE and the attribution above) |
| `hooks/vendor/` | roughjs 4.6.6, points-on-curve 0.2.0, points-on-path 0.2.1, path-data-parser 0.1.0 (MIT, see each LICENSE) |
| `types/index.d.ts` | data model, the `$.state` contract and the `$.browser` noun |
| `tests/` | board, layout, rich, plugin, terminal-image, live-page (and the browser pane) and reveal tests |
| `scripts/` | sample boards, snapshot and preview generators |
| `../.claude-plugin/marketplace.json` | the `claude-mod/` marketplace `shape-the-talk` (for `claude plugin marketplace add`) |
