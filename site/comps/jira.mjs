// The Jira board in the right dock: a ticket dragged from To Do onto In Review, the move confirmed, the board redrawn.

import { cellXY, colOf, cropBody, cropCss, findRow, frame, rowsHtml, timelineHelpers } from '../tools/html.mjs'

const ID = 'jira'
const COLS = 56
const X0 = 20
const Y0 = 44
const DURATION = 10

export function build() {
  const names = ['jira-rest', 'jira-drag-dev', 'jira-drag-review', 'jira-confirm', 'jira-moved']
  const rows = Math.max(...names.map(n => frame(n).rows.length))
  const layers = names.map(name => ({ id: name.replace('jira-', ''), html: rowsHtml(frame(name).rows) }))
  const rest = frame('jira-rest').rows
  const confirm = frame('jira-confirm').rows
  const ticketRow = findRow(rest, 'ABC-140')
  const devRow = findRow(rest, /^ IN DEV/)
  const reviewRow = findRow(rest, /^ IN REVIEW/)
  const moveRow = findRow(confirm, '[Move]')
  const moveCol = colOf(confirm[moveRow], '[Move]')
  const at = (col, row) => cellXY(X0 + 3, Y0 + 7, col, row)
  const W = Math.ceil(COLS * 9.6 + 2 * X0)
  const H = Y0 + rows * 20 + 16

  const script = `
${timelineHelpers(`${ID}-cur`)}
gsap.set(cur, { x: ${W - 120}, y: ${H - 60} });
const L = n => '#${ID}-' + n;
tl.to(cur, { opacity: 1, duration: 0.3 }, 0.5);
move(${at(6, ticketRow).join(', ')}, 0.7, 0.8);
tl.to(cur, { scale: 0.85, duration: 0.1 }, 1.7);
move(${at(6, devRow).join(', ')}, 1.9, 0.6);
swap(L('rest'), L('drag-dev'), 2.15);
move(${at(6, reviewRow).join(', ')}, 2.8, 0.6);
swap(L('drag-dev'), L('drag-review'), 3.05);
tl.to(cur, { scale: 1, duration: 0.12 }, 3.8);
swap(L('drag-review'), L('confirm'), 3.85);
move(${at(moveCol + 2, moveRow).join(', ')}, 4.3, 0.7);
click(5.2);
swap(L('confirm'), L('moved'), 5.35);
tl.to(cur, { opacity: 0, duration: 0.3 }, 8.0);
// Back to the start for the loop: the last frame fades out, then the first fades in.
tl.to(L('moved'), { opacity: 0, duration: 0.25 }, 9.3);
tl.fromTo(L('rest'), { opacity: 0 }, { opacity: 1, duration: 0.25, immediateRender: false }, 9.6);
`
  return {
    title: 'Jira board drag',
    width: W,
    height: H,
    duration: DURATION,
    css: cropCss({ cols: COLS, rows, x0: X0, y0: Y0 }),
    body: cropBody({ id: ID, title: 'claude · ~/code/webapp · right dock', layers }),
    script
  }
}
