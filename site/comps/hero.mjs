// The hero: a Claude Code session; the band's tabs update as Claude works, a click on 🌿 opens the right dock, and its
// sections close and open. Dock rows and the open band are the plugin's own drawing (site/frames.json); the band's
// in-between states are rebuilt from the same summaries by bandRuns, checked against the drawn band below.

import { CURSOR_SVG, TABS, bandRuns, cellXY, colOf, frame, plainOf, rowHtml, rowsHtml, timelineHelpers, trimStart } from '../tools/html.mjs'

const W = 1280
const H = 760
const X0 = 20
const Y0 = 44
const CELL = 9.6
const COLS = 129
const LEFT_OPEN = 72
const ROWS = 35
const DURATION = 16
const RULE = '─'.repeat(56)

/** Which dock sections are open when the dock first opens: Branch, Checks, Activity, GitGud, Jira. */
const OPEN_AT_START = [true, true, false, false, false]

/** dock-all split into its top rows and its cards: `{ rule, open, closed, body }` per card. */
function dockParts() {
  const all = frame('dock-all').rows
  const none = frame('dock-none').rows
  const starts = all.map((runs, i) => (plainOf(runs) === RULE ? i : -1)).filter(i => i >= 0)
  const cards = starts.map((start, n) => {
    const end = starts[n + 1] ?? all.length
    return { rule: all[start], open: all[start + 1], closed: none[3 + n * 2 + 1], body: all.slice(start + 2, end) }
  })
  return { top: all.slice(0, starts[0]), cards }
}

/** Claude Code's transcript, written by hand in its own glyphs and colours, with the time each line appears. */
const ELBOW = '<i class="w1">⎿</i>'
const TRANSCRIPT = [
  ['<span class="d">&gt; Stream the CSV export instead of building it in memory</span>', 0.2],
  ['', 0],
  ['● I\'ll switch the export to a streamed writer and keep the', 0.7],
  ['  toast\'s progress in sync with it.', 0.7],
  ['', 0],
  ['<span class="c-success">●</span> <span class="b">Read</span>(src/export/csv.ts)', 1.2],
  [`<span class="d">  ${ELBOW}  Read 84 lines</span>`, 1.2],
  ['', 0],
  ['<span class="c-success">●</span> <span class="b">Update</span>(src/export/csv.ts)', 1.8],
  [`<span class="d">  ${ELBOW}  Updated src/export/csv.ts with 18 additions and 9 removals</span>`, 1.8],
  ['', 0],
  ['<span class="c-success">●</span> <span class="b">Update</span>(src/export/ExportButton.tsx)', 2.4],
  [`<span class="d">  ${ELBOW}  Updated src/export/ExportButton.tsx with 4 additions</span>`, 2.4],
  ['', 0],
  ['<span class="c-success">●</span> <span class="b">Write</span>(src/export/csv.test.ts)', 3.0],
  [`<span class="d">  ${ELBOW}  Wrote 41 lines to src/export/csv.test.ts</span>`, 3.0],
  ['', 0],
  ['<span class="c-success">●</span> <span class="b">Bash</span>(pnpm test export)', 3.6],
  [`<span class="d">  ${ELBOW}  Tests  12 passed (12)</span>`, 3.6],
  ['', 0],
  ['● Done. Exports now stream in 1,000-row chunks, so a large', 4.3],
  ['  report no longer stalls the tab.', 4.3]
]

/** The band as the session goes: 🕘 counts each tool call above; GitGud finishes its first load. */
const BAND_STEPS = [
  { at: 0.4, tabs: [TABS.branch, TABS.checks, TABS.activity(0), TABS.gitgudLoading, TABS.jira] },
  { at: 1.2, tabs: [TABS.branch, TABS.checks, TABS.activity(1), TABS.gitgudLoading, TABS.jira] },
  { at: 1.8, tabs: [TABS.branch, TABS.checks, TABS.activity(2), TABS.gitgud, TABS.jira] },
  { at: 2.4, tabs: [TABS.branch, TABS.checks, TABS.activity(3), TABS.gitgud, TABS.jira] },
  { at: 3.0, tabs: [TABS.branch, TABS.checks, TABS.activity(4), TABS.gitgud, TABS.jira] },
  { at: 3.6, tabs: [TABS.branch, TABS.checks, TABS.activity(5), TABS.gitgud, TABS.jira] }
]

/** The row of a section's header in the dock, given which sections are open. */
function headerRow(top, cards, open, card) {
  let row = top.length
  for (let n = 0; n < card; n += 1) row += 2 + (open[n] ? cards[n].body.length : 0)
  return row + 1
}

export function build() {
  const { top, cards } = dockParts()
  const wideRows = BAND_STEPS.map(step => bandRuns(step.tabs, COLS))
  const wideLive = wideRows[wideRows.length - 1]
  if (plainOf(wideLive) !== plainOf(frame('hero-band-closed').rows[0])) throw new Error('bandRuns no longer matches the band the plugin draws')
  const focused = frame('hero-band-focused').rows[0]
  const last = BAND_STEPS.length - 1

  const transcript = TRANSCRIPT.map(([html], i) => `<div class="r tr" id="hero-tr-${i}">${html || ' '}</div>`).join('')
  const bands = [...wideRows.map((runs, i) => ({ id: `hero-band-${i}`, runs })), { id: 'hero-band-open', runs: focused }]
  const bandHtml = bands.map(band => `<div class="band-row" id="${band.id}">${rowHtml(trimStart(band.runs))}</div>`).join('')
  const cardHtml = cards
    .map(
      (card, n) => `<div class="card">
${rowHtml(card.rule)}
<div class="hdr"><div class="main${OPEN_AT_START[n] ? '' : ' off'}" id="hero-h${n}-open">${rowHtml(card.open)}</div><div class="alt${OPEN_AT_START[n] ? '' : ' on'}" id="hero-h${n}-closed">${rowHtml(card.closed)}</div></div>
<div class="body${OPEN_AT_START[n] ? '' : ' shut'}" id="hero-b${n}">${rowsHtml(card.body)}</div>
</div>`
    )
    .join('')
  const sep = Array.from({ length: ROWS }, () => '<div class="r">│</div>').join('')
  const rule = `<div class="rule" data-layout-allow-overflow>${'─'.repeat(COLS)}</div>`

  const body = `
<div class="bar"><div class="dots"><i></i><i></i><i></i></div>claude · ~/code/webapp</div>
<div class="term">
  <div class="left" id="hero-left">
    <div class="transcript">${transcript}</div>
    <div class="bottom">
      <div class="band">${bandHtml}</div>
      ${rule}
      <div class="r"><span class="d">&gt; </span><span class="i"> </span></div>
      ${rule}
      <div class="r d">  ? for shortcuts</div>
    </div>
  </div>
  <div class="sep" id="hero-sep">${sep}</div>
  <div class="dock" id="hero-dock">
    ${rowsHtml(top)}
    ${cardHtml}
  </div>
</div>
<div class="cursor" id="hero-cur">${CURSOR_SVG}</div>`

  const px = cells => `${(cells * CELL).toFixed(1)}px`
  const css = `
.term { position: absolute; left: ${X0}px; top: ${Y0}px; width: ${px(COLS)}; height: ${ROWS * 20}px; }
.left { position: absolute; left: 0; top: 0; height: ${ROWS * 20}px; width: ${px(COLS)}; overflow: hidden; }
.transcript { position: absolute; left: 0; top: 0; right: 0; }
.bottom { position: absolute; left: 0; right: 0; bottom: 0; }
.band { position: relative; height: 20px; }
.band-row { position: absolute; right: 0; top: 0; opacity: 0; }
.sep { position: absolute; left: ${px(LEFT_OPEN)}; top: 0; width: ${px(1)}; opacity: 0; }
.sep .r { opacity: 0.35; }
.dock { position: absolute; left: ${px(LEFT_OPEN + 1)}; top: 0; width: ${px(56)}; height: ${ROWS * 20}px; overflow: hidden; opacity: 0; }
.hdr { position: relative; height: 20px; }
.hdr .alt { position: absolute; left: 0; top: 0; right: 0; opacity: 0; }
.hdr .alt.on { opacity: 1; }
.hdr .main.off { opacity: 0; }
.body { overflow: hidden; }
.body.shut { height: 0; }
.tr { opacity: 0; }
`

  // Pointer targets, cell → pixel, aimed a few pixels into the cell.
  const at = (col, row) => cellXY(X0 + 4, Y0 + 6, col, row)
  const bandRow = ROWS - 5
  const dockCol = LEFT_OPEN + 1
  const afterChecks = [true, false, false, false, false]
  const afterGitgud = [true, false, false, true, false]
  const script = `
${timelineHelpers('hero-cur')}
const left = document.getElementById('hero-left');
const dock = document.getElementById('hero-dock');
const sep = document.getElementById('hero-sep');
const WIDE = ${(COLS * CELL).toFixed(1)}, NARROW = ${(LEFT_OPEN * CELL).toFixed(1)};
const bodies = ${JSON.stringify(cards.map(card => card.body.length * 20))};
// Every first state is in the CSS: the dock closed, the transcript and the band empty.
gsap.set(cur, { x: 520, y: 420 });

// Claude works; each tool call it makes counts on the band.
const reveal = ${JSON.stringify(TRANSCRIPT.map(([, t], i) => [i, t]).filter(([, t]) => t > 0))};
for (const [i, t] of reveal) tl.to('#hero-tr-' + i, { opacity: 1, duration: 0.25, ease: 'power1.out' }, t);
const steps = ${JSON.stringify(BAND_STEPS.map(step => step.at))};
on('#hero-band-0', steps[0]);
for (let i = 1; i < steps.length; i += 1) swap('#hero-band-' + (i - 1), '#hero-band-' + i, steps[i]);

// A click on the 🌿 tab opens the dock; the tab of the panel in view is drawn bold and underlined.
tl.to(cur, { opacity: 1, duration: 0.3 }, 4.8);
move(${at(colOf(wideLive, '🌿') + 1, bandRow).join(', ')}, 4.9, 0.7);
click(5.7);
tl.to(left, { width: NARROW, duration: 0.5, ease: 'power3.out' }, 5.85);
tl.fromTo(dock, { opacity: 0, x: 120 }, { opacity: 1, x: 0, duration: 0.5, ease: 'power3.out' }, 5.85);
tl.to(sep, { opacity: 1, duration: 0.3 }, 5.95);
swap('#hero-band-${last}', '#hero-band-open', 6.35);

// Sections close and open from their headers.
function toggle(n, open, t) {
  click(t);
  tl.to('#hero-b' + n, { height: open ? bodies[n] : 0, duration: 0.35, ease: 'power2.inOut' }, t + 0.1);
  tl.set('#hero-h' + n + '-closed', { opacity: open ? 0 : 1 }, t + 0.1);
  tl.set('#hero-h' + n + '-open', { opacity: open ? 1 : 0 }, t + 0.1);
}
move(${at(dockCol + 1, headerRow(top, cards, OPEN_AT_START, 1)).join(', ')}, 7.0, 0.7);
toggle(1, false, 7.8);
move(${at(dockCol + 1, headerRow(top, cards, afterChecks, 3)).join(', ')}, 8.6, 0.6);
toggle(3, true, 9.3);
move(${at(dockCol + 1, headerRow(top, cards, afterGitgud, 0)).join(', ')}, 10.5, 0.7);
toggle(0, false, 11.3);

// ✕ Close puts the dock away; the band keeps its tabs.
move(${at(dockCol + colOf(top[0], '✕ Close') + 1, 0).join(', ')}, 12.3, 0.8);
click(13.2);
tl.to(dock, { opacity: 0, x: 120, duration: 0.4, ease: 'power2.in' }, 13.35);
tl.to(sep, { opacity: 0, duration: 0.2 }, 13.35);
tl.to(left, { width: WIDE, duration: 0.45, ease: 'power3.inOut' }, 13.35);
swap('#hero-band-open', '#hero-band-${last}', 13.4);
tl.to(cur, { opacity: 0, duration: 0.3 }, 14.2);

// Fade the session out so the loop starts clean.
tl.to('.tr', { opacity: 0, duration: 0.5 }, 15.3);
tl.to('#hero-band-${last}', { opacity: 0, duration: 0.5 }, 15.3);
`

  return { title: 'Band and dock', width: W, height: H, duration: DURATION, css, body, script }
}
