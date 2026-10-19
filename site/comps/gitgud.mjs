// GitGud in the right dock: a background review of #2086 works through the PR, stops to ask for a web fetch (the ask
// blinks), is allowed once from the card, and finishes.

import { cellXY, colOf, cropBody, cropCss, findRow, frame, rowsHtml, timelineHelpers } from '../tools/html.mjs'

const ID = 'gitgud'
const COLS = 56
const X0 = 20
const Y0 = 44
const DURATION = 12

export function build() {
  const top = frame('dock-all').rows.slice(0, 3)
  const names = ['gg-0', 'gg-6', 'gg-12', 'gg-18', 'gg-ask-on', 'gg-ask-off', 'gg-after', 'gg-done']
  const rows = 3 + Math.max(...names.map(n => frame(n).rows.length))
  const layers = names.map(name => ({ id: name.replace('gg-', ''), html: rowsHtml(frame(name).rows) }))
  const ask = frame('gg-ask-on').rows
  const allowRow = 3 + findRow(ask, 'Allow once')
  const allowCol = colOf(ask[allowRow - 3], 'Allow once')
  const at = (col, row) => cellXY(X0 + 3, Y0 + 7, col, row)
  const W = Math.ceil(COLS * 9.6 + 2 * X0)
  const H = Y0 + rows * 20 + 16

  const blinks = []
  // The ask flips colour once a second, as the panel's review tick does.
  for (let t = 4.6, lit = true; t < 8.3; t += 1, lit = !lit) blinks.push([t, lit])

  const script = `
${timelineHelpers(`${ID}-cur`)}
gsap.set(cur, { x: ${W - 140}, y: ${H - 40} });
const L = n => '#${ID}-' + n;
swap(L('0'), L('6'), 1.2);
swap(L('6'), L('12'), 2.4);
swap(L('12'), L('18'), 3.6);
off(L('18'), 4.6);
const blinks = ${JSON.stringify(blinks)};
for (const [t, lit] of blinks) { tl.set(L('ask-on'), { opacity: lit ? 1 : 0 }, t); tl.set(L('ask-off'), { opacity: lit ? 0 : 1 }, t); }
tl.to(cur, { opacity: 1, duration: 0.3 }, 6.4);
move(${at(allowCol + 4, allowRow).join(', ')}, 6.6, 0.9);
click(8.2);
off(L('ask-on'), 8.35);
off(L('ask-off'), 8.35);
on(L('after'), 8.35);
swap(L('after'), L('done'), 10.0);
tl.to(cur, { opacity: 0, duration: 0.3 }, 9.6);
tl.to(L('done'), { opacity: 0, duration: 0.25 }, 11.3);
tl.fromTo(L('0'), { opacity: 0 }, { opacity: 1, duration: 0.25, immediateRender: false }, 11.6);
`
  return {
    title: 'GitGud background review',
    width: W,
    height: H,
    duration: DURATION,
    css: `${cropCss({ cols: COLS, rows, x0: X0, y0: Y0 })}
.top { position: absolute; left: 0; top: 0; right: 0; }
.term .layer { top: 60px; }
`,
    body: cropBody({ id: ID, title: 'claude · ~/code/webapp · right dock', layers, extra: `<div class="top">${rowsHtml(top)}</div>` }),
    script
  }
}
