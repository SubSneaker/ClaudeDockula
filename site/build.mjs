// Builds the landing page's HyperFrames compositions into docs/assets/comps/.
//
//   node site/build.mjs                 # every composition
//   node site/build.mjs hero jira       # some of them
//
// Each site/comps/<name>.mjs returns its markup, styles and GSAP timeline; the terminal rows come from
// site/frames.json (see site/tools/snapshot.mjs). The output files are standalone compositions: one paused GSAP
// timeline registered on window.__timelines, played in the page by <hyperframes-player>.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = dirname(fileURLToPath(import.meta.url))
const OUT = join(SITE, '..', 'docs', 'assets', 'comps')
const ALL = ['hero', 'jira', 'gitgud', 'bottom']

const GSAP = 'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js'

/** The terminal: a dark theme close to Claude Code's own, cells 0.6em wide and 20px tall. */
const TERM_CSS = `
@font-face { font-family: 'JetBrains Mono'; font-weight: 400; src: url('fonts/jetbrains-mono-400.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-weight: 700; src: url('fonts/jetbrains-mono-700.woff2') format('woff2'); }
@font-face { font-family: 'Term Symbols'; src: local('Apple Symbols'), local('Segoe UI Symbol'), local('DejaVu Sans'); }
@font-face { font-family: 'Term Emoji'; src: local('Apple Color Emoji'), local('Segoe UI Emoji'), local('Noto Color Emoji'); }
:root {
  --bg: #141519; --fg: #e8e6e3; --bar: #1c1d22; --edge: #2a2b31;
  --c-success: #4eba65; --c-error: #ff6b80; --c-warning: #ffc107; --c-suggestion: #b1b9f9;
  --c-claude: #d77757; --c-merged: #af87ff; --c-permission: #b1b9f9; --c-subtle: #6b6b70; --c-inactive: #999999;
}
html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: var(--bg); }
#root {
  position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--bg); color: var(--fg);
  font-family: 'JetBrains Mono', 'Term Symbols', 'Term Emoji', monospace;
  font-size: 16px; line-height: 20px; font-variant-ligatures: none; -webkit-font-smoothing: antialiased;
}
.scene { position: absolute; inset: 0; }
.bar {
  position: absolute; left: 0; right: 0; top: 0; height: 30px; background: var(--bar); border-bottom: 1px solid var(--edge);
  display: flex; align-items: center; justify-content: center; font-size: 12px; color: #8b8b92;
}
.dots { position: absolute; left: 14px; top: 10px; display: flex; gap: 8px; }
.dots i { width: 10px; height: 10px; border-radius: 50%; background: #3a3b42; }
.r { height: 20px; white-space: nowrap; overflow: hidden; }
.w1, .w2 { display: inline-block; font-style: normal; text-align: center; vertical-align: top; }
.w1 { width: 9.6px; font-variant-emoji: text; } .w2 { width: 19.2px; font-size: 14px; }
.b { font-weight: 700; } .d { opacity: 0.55; } .u { text-decoration: underline; text-underline-offset: 3px; }
.c-success { color: var(--c-success); } .c-error { color: var(--c-error); } .c-warning { color: var(--c-warning); }
.c-suggestion { color: var(--c-suggestion); } .c-claude { color: var(--c-claude); } .c-merged { color: var(--c-merged); }
.c-permission { color: var(--c-permission); } .c-subtle { color: var(--c-subtle); } .c-inactive { color: var(--c-inactive); }
.i { background: var(--fg); color: var(--bg); }
.i.c-suggestion { background: var(--c-suggestion); color: var(--bg); }
.rule { height: 20px; overflow: hidden; white-space: nowrap; opacity: 0.55; }
.cursor { position: absolute; left: 0; top: 0; width: 22px; height: 26px; opacity: 0; }
.cursor svg { display: block; width: 22px; height: 26px; }
.layer { position: absolute; left: 0; top: 0; }
`

function doc({ id, title, width, height, duration, css, body, script }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${width}, height=${height}">
<title>${title}</title>
<script src="${GSAP}"></script>
<style>${TERM_CSS}${css}</style>
</head>
<body>
<div id="root" data-composition-id="${id}" data-start="0" data-width="${width}" data-height="${height}" data-duration="${duration}">
<div id="${id}-scene" class="scene">
${body}
</div>
</div>
<script>
window.__timelines = window.__timelines || {};
(function () {
const tl = gsap.timeline({ paused: true });
${script}
window.__timelines["${id}"] = tl;
})();
</script>
</body>
</html>
`
}

/** The Slacker card, a still: its rows written into docs/index.html between the slacker markers. */
async function writeSlackerStill() {
  const { findRow, frame, protectRows, rowsHtml } = await import(join(SITE, 'tools', 'html.mjs'))
  const rows = frame('slacker').rows
  const card = rows.slice(findRow(rows, '💬 Slacker') - 1)
  const page = join(SITE, '..', 'docs', 'index.html')
  const html = readFileSync(page, 'utf8')
  const markers = /(<!-- slacker:start -->)[\s\S]*?(<!-- slacker:end -->)/
  if (!markers.test(html)) throw new Error('docs/index.html has no slacker:start / slacker:end markers')
  const next = html.replace(markers, `$1\n${protectRows(rowsHtml(card))}\n$2`)
  writeFileSync(page, next)
  console.log(`docs/index.html  Slacker still, ${card.length} rows`)
}

const wanted = process.argv.slice(2)
mkdirSync(OUT, { recursive: true })
for (const name of wanted.length > 0 ? wanted : ALL) {
  const { build } = await import(join(SITE, 'comps', `${name}.mjs`))
  const comp = build()
  const { protectRows } = await import(join(SITE, 'tools', 'html.mjs'))
  const html = doc({ id: name, ...comp, body: protectRows(comp.body) })
  writeFileSync(join(OUT, `${name}.html`), html)
  console.log(`docs/assets/comps/${name}.html  ${(html.length / 1024).toFixed(1)} KB`)
}

if (wanted.length === 0) await writeSlackerStill()
