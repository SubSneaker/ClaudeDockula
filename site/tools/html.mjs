// Turns laid-out terminal rows into HTML for the compositions, and builds the band's tab row the way
// hooks/dock/DockPane.tsx (drawTabRow) and hooks/dock/layout.ts (fitBand) do, for band states the probe doesn't draw.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cellsOf, layout, measureChars, toRuns } from './rows.mjs'

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DATA = JSON.parse(readFileSync(join(SITE, 'frames.json'), 'utf8'))

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
export const esc = text => String(text).replace(/[&<>"]/g, ch => ESC[ch])

/** Box drawing and plain ASCII draw at the font's own advance; any other glyph is pinned to its cells. */
function isNative(ch) {
  const p = ch.codePointAt(0) ?? 0
  return p < 0x7f || (p >= 0x2500 && p <= 0x257f)
}

function classOf(style) {
  return style
    .split(' ')
    .filter(Boolean)
    .map(part => (part.startsWith('c:') ? `c-${part.slice(2)}` : part))
    .join(' ')
}

/** One run's text, wide and non-font glyphs boxed to exact cells so columns line up whatever font draws them. */
function textHtml(text) {
  let out = ''
  let plain = ''
  for (const [ch, cells] of measureChars(text)) {
    if (cells === 1 && isNative(ch)) {
      plain += ch
      continue
    }
    out += esc(plain)
    plain = ''
    if (cells === 0) continue
    out += `<i class="w${cells}">${esc(cells === 1 ? `${ch}\uFE0E` : ch)}</i>`
  }
  return out + esc(plain)
}

export function rowHtml(runs) {
  const inner = runs.map(([text, style]) => (style ? `<span class="${classOf(style)}">${textHtml(text)}</span>` : textHtml(text))).join('')
  return `<div class="r">${inner || ' '}</div>`
}

export function rowsHtml(rows) {
  return rows.map(runs => rowHtml(runs)).join('')
}

export function frame(name) {
  const found = DATA.frames[name]
  if (!found) throw new Error(`no frame ${name}`)
  return found
}

export const plainOf = runs => runs.map(([text]) => text).join('')

/** The index of the first row of `rows` whose text matches. */
export function findRow(rows, test) {
  const index = rows.findIndex(runs => (typeof test === 'string' ? plainOf(runs).includes(test) : test.test(plainOf(runs))))
  if (index < 0) throw new Error(`no row matching ${test}`)
  return index
}

/** The cell where `text` starts in a row. */
export function colOf(runs, text) {
  const plain = plainOf(runs)
  const at = plain.indexOf(text)
  if (at < 0) throw new Error(`no ${text} in ${plain}`)
  return cellsOf(plain.slice(0, at))
}

const BAND_FITS = [
  { hasSummaries: true, gap: 3 },
  { hasSummaries: true, gap: 2 },
  { hasSummaries: false, gap: 2 },
  { hasSummaries: false, gap: 1 }
]
const ADD_ICON = '➕'

const bandLabel = (tab, hasSummaries) => (hasSummaries && tab.summary !== '' ? `${tab.icon} ${tab.summary}` : tab.icon)

/** The band's tab row in `columns` cells: `[{ icon, summary, tone? }]` drawn as the dock draws it. */
export function bandRuns(tabs, columns) {
  const widthOf = fit => [...tabs.map(tab => bandLabel(tab, fit.hasSummaries)), ADD_ICON].reduce((sum, label) => sum + cellsOf(label), 0) + fit.gap * tabs.length
  const fit = BAND_FITS.find(one => widthOf(one) <= columns) ?? { hasSummaries: false, gap: 1 }
  const tree = {
    type: 'Box',
    props: { flexDirection: 'row', justifyContent: 'flex-end', columnGap: fit.gap, width: columns },
    children: [
      ...tabs.map(tab => {
        const label = bandLabel(tab, fit.hasSummaries)
        const children = tab.tone ? [{ type: 'Text', props: { bold: true, color: tab.tone }, children: [label] }] : []
        return { type: 'Button', props: { plain: true, label }, children }
      }),
      { type: 'Button', props: { plain: true, label: ADD_ICON } }
    ]
  }
  return toRuns(layout(tree, columns))[0]
}

/** Runs without their leading blanks: a right-aligned row that a flex box places itself. */
export function trimStart(runs) {
  const out = runs.map(run => [...run])
  while (out.length > 0 && out[0][1] === '' && out[0][0].trim() === '') out.shift()
  if (out[0]?.[1] === '') out[0][0] = out[0][0].replace(/^\s+/, '')
  return out
}

/**
 * Tab summaries as the probe's band frames show them (hero.mjs checks the full set against a drawn band); 🕘 is the
 * session's tool-call count and 🐙 shows `…` until its first load.
 */
export const TABS = {
  branch: { icon: '🌿', summary: 'ABC-123 ·3' },
  checks: { icon: '✅', summary: '4/4' },
  activity: n => ({ icon: '🕘', summary: String(n) }),
  jira: { icon: '🎫', summary: 'In Dev' },
  gitgud: { icon: '🐙', summary: '3 to review · 1 mine' },
  gitgudLoading: { icon: '🐙', summary: '…' }
}

/** The mouse pointer, its tip at the element's top-left corner. */
export const CURSOR_SVG =
  '<svg viewBox="0 0 22 26" aria-hidden="true"><path d="M2 2 L2 21 L7 16.5 L10.6 24 L14 22.4 L10.5 15 L17.5 15 Z" fill="#f4f4f4" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>'

/** Timeline helpers every composition script starts with: the pointer's moves and clicks, and instant swaps. */
export function timelineHelpers(cursorId) {
  return `
const cur = document.getElementById('${cursorId}');
function move(x, y, at, d) { tl.to(cur, { x: x, y: y, duration: d === undefined ? 0.6 : d, ease: 'power2.inOut' }, at); }
function click(at) { tl.to(cur, { scale: 0.8, duration: 0.08, ease: 'power1.out' }, at); tl.to(cur, { scale: 1, duration: 0.14, ease: 'power1.out' }, at + 0.08); }
function on(sel, at) { tl.set(sel, { opacity: 1 }, at); }
function off(sel, at) { tl.set(sel, { opacity: 0 }, at); }
function swap(from, to, at) { off(from, at); on(to, at); }
`
}

/** Cell → pixel, for a terminal whose first cell's top-left is at (x0, y0). */
export function cellXY(x0, y0, col, row) {
  return [Math.round(x0 + col * 9.6), Math.round(y0 + row * 20)]
}

/**
 * A crop of the terminal around one dock: the window bar, then stacked layers of rows (one per frame), only the
 * first shown at the start. Layers sit at the top unless `bottom` anchors them to the bottom edge.
 */
export function cropBody({ id, title, layers, extra = '' }) {
  const layerHtml = layers
    .map((layer, i) => `<div class="layer${i === 0 ? ' on' : ''}" id="${id}-${layer.id}">${layer.html}</div>`)
    .join('\n')
  return `
<div class="bar"><div class="dots"><i></i><i></i><i></i></div>${esc(title)}</div>
<div class="term" id="${id}-term">
${layerHtml}
${extra}
</div>
<div class="cursor" id="${id}-cur">${CURSOR_SVG}</div>`
}

export function cropCss({ cols, rows, x0 = 20, y0 = 44, bottom = false }) {
  return `
.term { position: absolute; left: ${x0}px; top: ${y0}px; width: ${(cols * 9.6).toFixed(1)}px; height: ${rows * 20}px; overflow: hidden; }
.term .layer { opacity: 0; width: 100%; ${bottom ? 'top: auto; bottom: 0;' : ''} background: var(--bg); }
.term .layer.on { opacity: 1; }
`
}
