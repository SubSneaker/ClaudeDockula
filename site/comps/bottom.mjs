// The bottom dock in a Row layout: Branch and Checks side by side, Activity under them. The grip is dragged up six rows
// (the label counts them), the dock grows on release, then it is dragged back.

import { cellXY, cropBody, cropCss, frame, rowsHtml, timelineHelpers } from '../tools/html.mjs'

const ID = 'bottom'
const COLS = 110
const X0 = 20
const Y0 = 44
const DURATION = 10

const PROMPT = [
  '<div class="rule" data-layout-allow-overflow>' + '─'.repeat(COLS) + '</div>',
  '<div class="r"><span class="d">&gt; </span><span class="i"> </span></div>',
  '<div class="rule" data-layout-allow-overflow>' + '─'.repeat(COLS) + '</div>',
  '<div class="r d">  ? for shortcuts</div>'
].join('')

const TRANSCRIPT = [
  '<span class="c-success">●</span> <span class="b">Bash</span>(pnpm test export)',
  '<span class="d">  <i class="w1">⎿</i>  Tests  12 passed (12)</span>',
  '',
  '● Done. Exports now stream in 1,000-row chunks, so a large report no longer stalls the tab.',
  ''
]

export function build() {
  const short = frame('bottom-12').rows
  const tall = frame('bottom-18').rows
  const labels = [1, 2, 3, 4, 5, 6].map(n => frame(`bottom-drag${n}`).rows[0])
  // Dragging back down from 18 rows: the tall dock with the label counting down (17 … 13).
  const back = [5, 4, 3, 2, 1].map(n => [labels[n - 1], ...tall.slice(1)])
  const layers = [
    { id: 'short', html: rowsHtml(short) },
    ...labels.map((label, i) => ({ id: `up${i + 1}`, html: rowsHtml([label, ...short.slice(1)]) })),
    { id: 'tall', html: rowsHtml(tall) },
    ...back.map((rows, i) => ({ id: `down${i + 1}`, html: rowsHtml(rows) }))
  ]
  const dockRows = tall.length
  const rows = TRANSCRIPT.length + dockRows
  const W = Math.ceil(COLS * 9.6 + 2 * X0)
  const H = Y0 + (rows + 4) * 20 + 16
  const gripShort = rows - short.length
  const gripTall = rows - tall.length
  const at = (col, row) => cellXY(X0 + 3, Y0 + 7, col, row)

  const script = `
${timelineHelpers(`${ID}-cur`)}
gsap.set(cur, { x: ${W - 260}, y: 70 });
const L = n => '#${ID}-' + n;
tl.to(cur, { opacity: 1, duration: 0.3 }, 0.4);
move(${at(56, gripShort).join(', ')}, 0.6, 0.9);
tl.to(cur, { scale: 0.85, duration: 0.1 }, 1.7);
tl.to(cur, { y: ${at(56, gripTall)[1]}, duration: 1.6, ease: 'none' }, 1.9);
const ups = ['short', 'up1', 'up2', 'up3', 'up4', 'up5', 'up6'];
for (let i = 1; i < ups.length; i += 1) swap(L(ups[i - 1]), L(ups[i]), 1.9 + i * 0.25);
tl.to(cur, { scale: 1, duration: 0.12 }, 3.8);
swap(L('up6'), L('tall'), 3.85);
tl.to(cur, { scale: 0.85, duration: 0.1 }, 5.6);
tl.to(cur, { y: ${at(56, gripShort)[1]}, duration: 1.4, ease: 'none' }, 5.8);
const downs = ['tall', 'down1', 'down2', 'down3', 'down4', 'down5'];
for (let i = 1; i < downs.length; i += 1) swap(L(downs[i - 1]), L(downs[i]), 5.8 + i * 0.25);
tl.to(cur, { scale: 1, duration: 0.12 }, 7.3);
swap(L('down5'), L('short'), 7.35);
tl.to(cur, { opacity: 0, duration: 0.3 }, 8.4);
`
  const transcript = `<div class="tail">${TRANSCRIPT.map(line => `<div class="r">${line || ' '}</div>`).join('')}</div>`
  return {
    title: 'Bottom dock in a row',
    width: W,
    height: H,
    duration: DURATION,
    css: `${cropCss({ cols: COLS, rows, x0: X0, y0: Y0, bottom: true })}
.tail { position: absolute; left: 0; top: 0; right: 0; }
.prompt { position: absolute; left: ${X0}px; top: ${Y0 + rows * 20}px; width: ${(COLS * 9.6).toFixed(1)}px; }
`,
    body: `${cropBody({ id: ID, title: 'claude · ~/code/webapp', layers, extra: transcript })}<div class="prompt">${PROMPT}</div>`,
    script
  }
}
