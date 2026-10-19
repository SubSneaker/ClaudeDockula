import type { ClientElements, ClientKeyEvent, ClientPointerEvent, ClientSurface, RenderElement } from 'claude-code'

import { fitEnd, padCells } from '../../dock/ui'
import type { GhAction, GhListMessage } from './model'
import { DETAIL_INDENT, DETAIL_LABEL_CELLS, ROW_CHROME_CELLS, type DetailLine, type ListProps, type MenuEntry } from './rows'

// The list's surface module: it draws the rows, keeps the cursor and the row menu locally and posts
// `GhListMessage`s (model.ts) to the hooks: a row to open or close, an action picked, more rows.

type Row = ListProps['rows'][number]

const MENU_ZONE_CELLS = 3
const MORE_STOP = 'more'
const COPY_GROUP = 'copy'
const BACK = 'back'
const INDENT = ' '.repeat(DETAIL_INDENT)
/** The copy actions, folded under `📋 Copy ▸` and named there by what they copy. */
const COPY_LABELS: Partial<Record<GhAction, string>> = {
  'copy-link': '📋 Link',
  'copy-body': '📋 Title + body',
  'copy-thread': '📋 Full thread',
  'copy-diff': '📋 Diff'
}

interface Menu {
  id: string
  isCopyOpen: boolean
  /** The highlighted choice by its id, so a redraw that changes the entries cannot move it onto another. */
  active: string
}

interface Press {
  x: number
  y: number
  /** What the pressed line was (`lineIdOf`): a release acts only while that line is still under it. */
  lineId: string
}

interface ListLocal {
  /** A row's item id, or `more`: the line the arrow keys move. */
  cursor?: string
  menu?: Menu
  press?: Press
}

/** One menu line: an action, the `📋 Copy ▸` group, or the way back out of it. */
interface MenuChoice {
  id: string
  label: string
  action?: GhAction
}

/** One terminal line of the list: the pointer's `y` is its index. */
type Line =
  | { kind: 'item'; row: Row }
  | { kind: 'menu'; row: Row; choice: MenuChoice; isActive: boolean }
  | { kind: 'detail'; row: Row; line: DetailLine }
  | { kind: 'more'; hidden: number }

function post(surface: ClientSurface<ListLocal>, message: GhListMessage): void {
  surface.post(message)
}

function readLocal(surface: ClientSurface<ListLocal>): ListLocal {
  return surface.state ?? {}
}

function widthOf(surface: ClientSurface<ListLocal>, props: ListProps): number {
  return Math.max(1, surface.columns > 0 ? surface.columns : props.columns)
}

function isCopy(entry: MenuEntry): boolean {
  return COPY_LABELS[entry.action] !== undefined
}

/**
 * The open menu's lines: the actions with the copy ones folded into one group, or with the group open its copies after a way back.
 * @example
 * // before: [review-here, copy-link, copy-body, open], closed
 * // after:  ['🧐 Review here', '📋 Copy ▸', '🌐 Open in browser']
 */
function menuChoices(menu: Menu, entries: readonly MenuEntry[]): MenuChoice[] {
  const copies = entries.filter(isCopy)
  if (menu.isCopyOpen) {
    return [
      { id: BACK, label: '‹ Back' },
      ...copies.map(entry => ({ id: entry.action, label: COPY_LABELS[entry.action] ?? entry.label, action: entry.action }))
    ]
  }

  return entries.flatMap((entry): MenuChoice[] => {
    if (!isCopy(entry)) return [{ id: entry.action, label: entry.label, action: entry.action }]

    return entry === copies[0] ? [{ id: COPY_GROUP, label: '📋 Copy ▸' }] : []
  })
}

function layoutLines(props: ListProps, local: ListLocal): Line[] {
  const lines: Line[] = []
  for (const row of props.rows) {
    lines.push({ kind: 'item', row })
    const { menu } = local
    if (menu?.id === row.id) {
      menuChoices(menu, row.menu).forEach(choice => lines.push({ kind: 'menu', row, choice, isActive: choice.id === menu.active }))
    }
    row.details.forEach(line => lines.push({ kind: 'detail', row, line }))
  }
  if (props.hidden > 0) lines.push({ kind: 'more', hidden: props.hidden })

  return lines
}

/** A line's identity across redraws: `item:o/r#1`, `menu:o/r#1:copy`, `detail:o/r#1`, `more`. */
function lineIdOf(line: Line | undefined): string {
  if (!line) return 'none'
  switch (line.kind) {
    case 'item':
    case 'detail':
      return `${line.kind}:${line.row.id}`
    case 'menu':
      return `menu:${line.row.id}:${line.choice.id}`
    default:
      return MORE_STOP
  }
}

function toggleMenu(local: ListLocal, row: Row): ListLocal {
  if (local.menu?.id === row.id) return { ...local, cursor: row.id, menu: undefined }
  const first = menuChoices({ id: row.id, isCopyOpen: false, active: '' }, row.menu)[0]

  return { ...local, cursor: row.id, menu: { id: row.id, isCopyOpen: false, active: first?.id ?? '' } }
}

function toggleOpen(surface: ClientSurface<ListLocal>, local: ListLocal, props: ListProps, row: Row): void {
  surface.setState({ ...local, cursor: row.id, menu: undefined })
  post(surface, { type: 'open', id: props.openId === row.id ? null : row.id })
}

function showMore(surface: ClientSurface<ListLocal>, local: ListLocal): void {
  surface.setState({ ...local, cursor: MORE_STOP, menu: undefined })
  post(surface, { type: 'more' })
}

/** The copy group opens, Back closes it, an action closes the menu and goes to the hooks. */
function choose(surface: ClientSurface<ListLocal>, local: ListLocal, row: Row, choice: MenuChoice): void {
  if (choice.id === COPY_GROUP || choice.id === BACK) {
    const isCopyOpen = choice.id === COPY_GROUP
    const first = row.menu.find(isCopy)?.action ?? BACK
    surface.setState({ ...local, menu: { id: row.id, isCopyOpen, active: isCopyOpen ? first : COPY_GROUP } })

    return
  }
  surface.setState({ ...local, cursor: row.id, menu: undefined })
  if (choice.action) post(surface, { type: 'act', action: choice.action, id: row.id })
}

/** A press and release on one line: open a row (its right end opens the menu), pick a menu line, show more; elsewhere closes the menu. */
function click(surface: ClientSurface<ListLocal>, local: ListLocal, props: ListProps, line: Line | undefined, x: number, columns: number): void {
  if (line?.kind === 'item') {
    if (x >= columns - MENU_ZONE_CELLS) surface.setState(toggleMenu(local, line.row))
    else toggleOpen(surface, local, props, line.row)
  } else if (line?.kind === 'menu') {
    choose(surface, local, line.row, line.choice)
  } else if (line?.kind === 'more') {
    showMore(surface, local)
  } else {
    surface.setState({ ...local, menu: undefined })
  }
}

function handlePointer(event: ClientPointerEvent, props: ListProps, surface: ClientSurface<ListLocal>): void {
  const local = readLocal(surface)
  const lines = layoutLines(props, local)
  const line = lines[event.y]
  if (event.button === 'right') {
    if (event.type === 'down' && line?.kind === 'item') surface.setState(toggleMenu(local, line.row))

    return
  }
  if (event.button !== 'left') return
  if (event.type === 'down') {
    surface.setState({ ...local, press: { x: event.x, y: event.y, lineId: lineIdOf(line) } })
  } else if (event.type === 'up') {
    const { press } = local
    const settled = { ...local, press: undefined }
    if (press && event.y === press.y && lineIdOf(line) === press.lineId) click(surface, settled, props, line, press.x, widthOf(surface, props))
    else surface.setState(settled)
  }
}

/** ↑ ↓ through the rows (and `+N more`), → ← open and close a row, Enter or m for its menu. */
function keyOnList(surface: ClientSurface<ListLocal>, local: ListLocal, props: ListProps, event: ClientKeyEvent): void {
  const stops = [...props.rows.map(row => row.id), ...(props.hidden > 0 ? [MORE_STOP] : [])]
  const at = local.cursor === undefined ? -1 : stops.indexOf(local.cursor)
  if (event.key === 'down' || event.key === 'up') {
    const step = event.key === 'down' ? 1 : -1
    const next = at === -1 ? (step === 1 ? 0 : stops.length - 1) : Math.min(stops.length - 1, Math.max(0, at + step))
    const cursor = stops[next]
    if (cursor !== undefined) surface.setState({ ...local, cursor })

    return
  }
  if (local.cursor === MORE_STOP) {
    if (event.key === 'return') showMore(surface, local)

    return
  }
  const row = props.rows.find(one => one.id === local.cursor)
  if (!row) return
  const isOpen = props.openId === row.id
  if ((event.key === 'right' && !isOpen) || (event.key === 'left' && isOpen)) toggleOpen(surface, local, props, row)
  else if (event.key === 'return' || event.key === 'm') surface.setState(toggleMenu(local, row))
}

/** ↑ ↓ move the highlight (by choice, not by place), Enter picks, → opens only the copy group, ← or backspace goes back or closes. */
function keyOnMenu(surface: ClientSurface<ListLocal>, local: ListLocal, menu: Menu, row: Row, event: ClientKeyEvent): void {
  const choices = menuChoices(menu, row.menu)
  const at = choices.findIndex(choice => choice.id === menu.active)
  const choice = choices[at]
  if (event.key === 'down' || event.key === 'up') {
    const step = event.key === 'down' ? 1 : -1
    const next = choices[at === -1 ? 0 : (at + step + choices.length) % choices.length]
    if (next) surface.setState({ ...local, menu: { ...menu, active: next.id } })
  } else if (choice && (event.key === 'return' || (event.key === 'right' && choice.id === COPY_GROUP))) {
    choose(surface, local, row, choice)
  } else if ((event.key === 'left' || event.key === 'backspace') && menu.isCopyOpen) {
    surface.setState({ ...local, menu: { ...menu, isCopyOpen: false, active: COPY_GROUP } })
  } else if (event.key === 'left' || event.key === 'backspace' || event.key === 'm') {
    surface.setState({ ...local, menu: undefined })
  }
}

/** Keys answer the menu only while its row is drawn; one whose row went is dropped. */
function handleKey(event: ClientKeyEvent, props: ListProps, surface: ClientSurface<ListLocal>): void {
  const local = readLocal(surface)
  const { menu } = local
  const menuRow = menu ? props.rows.find(row => row.id === menu.id) : undefined
  if (menu && menuRow) {
    keyOnMenu(surface, local, menu, menuRow, event)

    return
  }
  const list = { ...local, menu: undefined }
  if (menu) surface.setState(list)
  keyOnList(surface, list, props, event)
}

/** `›✅ #2086 Add CSV export option…  👀  2d ⋯`: the number bold, the opened row bold throughout, a draft dim. */
function drawItem(ui: ClientElements, row: Row, props: ListProps, local: ListLocal, columns: number): JSX.Element {
  const { Text } = ui
  const label = padCells(row.label, Math.max(1, columns - ROW_CHROME_CELLS))
  const number = `${row.sigil}${row.id.slice(row.id.lastIndexOf('#') + 1)}`
  const at = label.indexOf(`${number} `)
  const lead = at < 0 ? '' : label.slice(0, at)
  const rest = at < 0 ? label : label.slice(at + number.length)

  return (
    <Text wrap="truncate-end" bold={props.openId === row.id}>
      {local.cursor === row.id ? '›' : ' '}
      <Text color={row.tone}>{lead}</Text>
      {at >= 0 && (
        <Text bold color="suggestion">
          {number}
        </Text>
      )}
      <Text color={row.tone}>{rest}</Text>
      <Text dimColor={local.menu?.id !== row.id}>{' ⋯'}</Text>
    </Text>
  )
}

function drawDetail(ui: ClientElements, line: DetailLine, columns: number): JSX.Element {
  const { Text } = ui
  if (line.label === undefined) {
    return (
      <Text wrap="truncate-end" color={line.tone} dimColor={line.isDim === true}>
        {line.text === '' ? ' ' : `${INDENT}${fitEnd(line.text, columns - DETAIL_INDENT)}`}
      </Text>
    )
  }

  return (
    <Text wrap="truncate-end">
      <Text dimColor>{`${INDENT}${padCells(line.label, DETAIL_LABEL_CELLS)}`}</Text>
      <Text color={line.tone} dimColor={line.isDim === true} bold={line.isDim !== true}>
        {fitEnd(line.text, Math.max(1, columns - DETAIL_INDENT - DETAIL_LABEL_CELLS))}
      </Text>
    </Text>
  )
}

function drawLine(ui: ClientElements, line: Line, props: ListProps, local: ListLocal, columns: number): JSX.Element {
  const { Text } = ui
  switch (line.kind) {
    case 'item':
      return drawItem(ui, line.row, props, local, columns)
    case 'menu':
      return (
        <Text wrap="truncate-end">
          {INDENT}
          <Text inverse={line.isActive}>{fitEnd(line.choice.label, Math.max(1, columns - DETAIL_INDENT))}</Text>
        </Text>
      )
    case 'detail':
      return drawDetail(ui, line.line, columns)
    default:
      return (
        <Text dimColor wrap="truncate-end">
          {`${local.cursor === MORE_STOP ? '›' : ' '}+${line.hidden} more`}
        </Text>
      )
  }
}

/** The rows of one list: a click opens a row, a right-click, `⋯`, Enter or m opens its menu, the keys steer. */
export default function GitgudList(props: ListProps, surface: ClientSurface<ListLocal>): RenderElement {
  surface.onPointer(event => handlePointer(event, props, surface))
  surface.onKey(event => handleKey(event, props, surface))
  const { Box } = surface.elements
  const local = readLocal(surface)
  const columns = widthOf(surface, props)

  return (
    <Box flexDirection="column" width={columns}>
      {layoutLines(props, local).map(line => drawLine(surface.elements, line, props, local, columns))}
    </Box>
  )
}
