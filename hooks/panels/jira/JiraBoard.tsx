import type { ClientElements, ClientKeyEvent, ClientPointerEvent, ClientSurface, RenderElement } from 'claude-code'

import { cellWidth, fitEnd, padCells } from '../../dock/ui'
import {
  confirmQuestion,
  isCardOpen,
  isLaneCollapsed,
  laneTitle,
  menuItemsFor,
  toggleIn,
  type BoardOption,
  type BoardProps,
  type CardView,
  type LaneView,
  type MenuAction
} from './lanes'

// The board's surface module: it draws the board picker and the lanes, keeps the drag, menu, picker and
// confirm locally and posts to the hooks module (hooks/panels/jira.tsx) only what needs `$`: a confirmed
// move, an action, a board picked, a drop or a menu pick to preview, the view to keep.

const DETAIL_INDENT = 5
const LABEL_CELLS = 8
const MENU_ZONE_CELLS = 3
const MOVE_LABEL = '[Move]'
const CANCEL_LABEL = '[Cancel]'
const GAP = '  '
const PICKER_LABEL = 'Board'
const PICKER_STOP = 'picker'

interface Press {
  x: number
  y: number
  /** What the pressed row was (`rowIdOf`): a release acts only while that row is still under it. */
  rowId: string
  /** The ticket under the press, which a drag carries, and its lane. */
  key?: string
  lane?: string
}

interface Drag {
  key: string
  from: string
  over?: string
}

interface Menu {
  key: string
  isMoveOpen: boolean
  /** The highlighted entry by its `entryId`, so a redraw that changes the lanes cannot move it onto another. */
  active: string
}

interface Confirm {
  key: string
  lane: string
  isMoveChosen: boolean
}

/** The board picker's open list and the board highlighted in it. */
interface Picker {
  active?: number
}

interface BoardLocal {
  toggled: string[]
  toggledLanes: string[]
  /** `picker`, `lane:<name>` or `card:<key>`: the row the arrow keys move. */
  cursor?: string
  menu?: Menu
  confirm?: Confirm
  picker?: Picker
  press?: Press
  drag?: Drag
}

interface MenuEntry {
  label: string
  action: MenuAction | 'back' | 'to'
  lane?: string
}

interface PickerRow {
  kind: 'picker' | 'gap'
  laneName?: undefined
}

interface OptionRow {
  kind: 'option'
  option: BoardOption
  isActive: boolean
  laneName?: undefined
}

interface LaneRow {
  kind: 'lane'
  lane: LaneView
  laneName: string
}

interface CardRow {
  kind: 'card'
  card: CardView
  laneName: string
}

interface FieldRow {
  kind: 'field'
  label: string
  value: string
  laneName: string
}

interface NoteRow {
  kind: 'excerpt' | 'pending' | 'blank'
  text: string
  laneName: string
}

interface MenuRow {
  kind: 'menu'
  card: CardView
  entry: MenuEntry
  isActive: boolean
  laneName: string
}

interface ConfirmRow {
  kind: 'confirm'
  confirm: Confirm
  laneName: string
}

/** One terminal row of the board: the pointer's `y` is its index. */
type BoardRow = PickerRow | OptionRow | LaneRow | CardRow | FieldRow | NoteRow | MenuRow | ConfirmRow

interface ConfirmLayout {
  question: string
  moveAt: number
  cancelAt: number
}

function readLocal(surface: ClientSurface<BoardLocal>, props: BoardProps): BoardLocal {
  return surface.state ?? { toggled: props.toggled, toggledLanes: props.toggledLanes }
}

function widthOf(surface: ClientSurface<BoardLocal>, props: BoardProps): number {
  return Math.max(1, surface.columns > 0 ? surface.columns : props.columns)
}

function laneOfCard(props: BoardProps, key: string): LaneView | undefined {
  return props.lanes.find(lane => lane.cards.some(card => card.key === key))
}

/** An entry's identity across redraws: `move`, `back`, `to:IN REVIEW`. */
function entryId(entry: MenuEntry): string {
  return entry.action === 'to' ? `to:${entry.lane ?? ''}` : entry.action
}

/** The open menu's entries: the actions, or with Move to open, the lanes a move can land in after a way back. */
function menuEntries(menu: Menu, props: BoardProps): MenuEntry[] {
  if (!menu.isMoveOpen) {
    const card = props.lanes.flatMap(lane => lane.cards).find(one => one.key === menu.key)

    return menuItemsFor(card).map(item => ({ label: item.label, action: item.action }))
  }
  const current = laneOfCard(props, menu.key)?.name
  const targets = props.lanes.filter(lane => lane.isMoveTarget && lane.name !== current)

  return [
    { label: '‹ Back', action: 'back' },
    ...targets.map((lane): MenuEntry => ({ label: `→ ${laneTitle(lane.name)}`, action: 'to', lane: lane.name }))
  ]
}

/** The rows under a ticket: the move in flight or to confirm, its menu, then its details when open. */
function rowsUnderCard(card: CardView, laneName: string, props: BoardProps, local: BoardLocal): BoardRow[] {
  const rows: BoardRow[] = []
  if (props.pending?.key === card.key) {
    rows.push({ kind: 'pending', text: `Moving to ${laneTitle(props.pending.lane)}…`, laneName })
  } else if (local.confirm?.key === card.key) {
    rows.push({ kind: 'confirm', confirm: local.confirm, laneName })
  }
  const { menu } = local
  if (menu?.key === card.key) {
    menuEntries(menu, props).forEach(entry => rows.push({ kind: 'menu', card, entry, isActive: entryId(entry) === menu.active, laneName }))
  }
  if (isCardOpen(card, local.toggled)) {
    card.fields.forEach(field => rows.push({ kind: 'field', label: field.label, value: field.value, laneName }))
    card.excerpt.forEach(text => rows.push({ kind: 'excerpt', text, laneName }))
  }

  return rows
}

/** The picker row, the boards under it while it is open, and a blank row before the lanes; nothing with no boards. */
function pickerRows(props: BoardProps, local: BoardLocal): BoardRow[] {
  if (props.boards.length === 0) return []
  const { picker } = local
  const options = picker ? props.boards.map((option): BoardRow => ({ kind: 'option', option, isActive: option.id === picker.active })) : []

  return [{ kind: 'picker' }, ...options, { kind: 'gap' }]
}

/**
 * The board as rows, one per terminal row, each lane row tagged with the lane it belongs to so a drop lands there.
 * @example
 * // before: boards [Team Board], lanes [To Do: ABC-1 (open)], [Done: ABC-2] (collapsed)
 * // after:  [picker, gap, lane To Do, card ABC-1, field Status, field Prio, blank, lane Done]
 */
function layoutRows(props: BoardProps, local: BoardLocal): BoardRow[] {
  const rows = pickerRows(props, local)
  props.lanes.forEach((lane, index) => {
    rows.push({ kind: 'lane', lane, laneName: lane.name })
    if (isLaneCollapsed(lane, local.toggledLanes)) return
    for (const card of lane.cards) {
      rows.push({ kind: 'card', card, laneName: lane.name }, ...rowsUnderCard(card, lane.name, props, local))
    }
    if (lane.cards.length > 0 && index < props.lanes.length - 1) rows.push({ kind: 'blank', text: ' ', laneName: lane.name })
  })

  return rows
}

/**
 * The confirm row: the question, then [Move] [Cancel] at the row's right end, where they stay when the
 * question grows (the status it lands in arrives after the drop), so a click never lands on the other one.
 */
function confirmLayout(confirm: Confirm, props: BoardProps, columns: number): ConfirmLayout {
  const preview = props.preview?.key === confirm.key ? props.preview : undefined
  const buttonCells = MOVE_LABEL.length + GAP.length + CANCEL_LABEL.length
  const moveAt = Math.max(DETAIL_INDENT + 1 + GAP.length, columns - buttonCells)
  const room = moveAt - DETAIL_INDENT - GAP.length
  const question = padCells(fitEnd(confirmQuestion(confirm.lane, preview), room), room)

  return { question, moveAt, cancelAt: moveAt + MOVE_LABEL.length + GAP.length }
}

function confirmChoiceAt(layout: ConfirmLayout, x: number): 'move' | 'cancel' | undefined {
  if (x >= layout.moveAt && x < layout.moveAt + MOVE_LABEL.length) return 'move'
  if (x >= layout.cancelAt && x < layout.cancelAt + CANCEL_LABEL.length) return 'cancel'

  return undefined
}

/** A row's identity across redraws: `card:ABC-1`, `menu:ABC-1:to:IN REVIEW`, `confirm:ABC-1:IN REVIEW`, `option:357`. */
function rowIdOf(row: BoardRow | undefined): string {
  if (!row) return 'none'
  switch (row.kind) {
    case 'picker':
    case 'gap':
      return row.kind
    case 'option':
      return `option:${row.option.id}`
    case 'lane':
      return `lane:${row.lane.name}`
    case 'card':
      return `card:${row.card.key}`
    case 'menu':
      return `menu:${row.card.key}:${entryId(row.entry)}`
    case 'confirm':
      return `confirm:${row.confirm.key}:${row.confirm.lane}`
    default:
      return `${row.kind}:${row.laneName}`
  }
}

/** The lane a held ticket would drop into at row `y`: one a move can land in, or none. */
function dropLaneAt(rows: readonly BoardRow[], y: number, props: BoardProps): string | undefined {
  const name = rows[y]?.laneName

  return props.lanes.some(lane => lane.name === name && lane.isMoveTarget) ? name : undefined
}

/** Sets the local state and posts the view, so a redraw or a reload keeps what is open. */
function changeView(surface: ClientSurface<BoardLocal>, next: BoardLocal): void {
  surface.setState(next)
  surface.post({ type: 'view', toggled: next.toggled, toggledLanes: next.toggledLanes })
}

function toggleMenu(local: BoardLocal, key: string): BoardLocal {
  const isOpen = local.menu?.key === key

  return {
    ...local,
    cursor: `card:${key}`,
    confirm: undefined,
    picker: undefined,
    menu: isOpen ? undefined : { key, isMoveOpen: false, active: 'move' }
  }
}

/** Opens or closes the board list; a project with one board has nothing to pick. */
function togglePicker(local: BoardLocal, props: BoardProps): BoardLocal {
  if (local.picker || props.boards.length < 2) return { ...local, cursor: PICKER_STOP, picker: undefined }

  const picker = props.boardId === undefined ? {} : { active: props.boardId }

  return { ...local, cursor: PICKER_STOP, menu: undefined, confirm: undefined, picker }
}

function pickBoard(surface: ClientSurface<BoardLocal>, local: BoardLocal, props: BoardProps, id: number): void {
  surface.setState({ ...local, picker: undefined, cursor: PICKER_STOP })
  if (id !== props.boardId) surface.post({ type: 'board', id })
}

function confirmMove(surface: ClientSurface<BoardLocal>, local: BoardLocal): void {
  const { confirm } = local
  surface.setState({ ...local, confirm: undefined })
  if (confirm) surface.post({ type: 'move', key: confirm.key, lane: confirm.lane })
}

function activate(surface: ClientSurface<BoardLocal>, local: BoardLocal, key: string, entry: MenuEntry): void {
  const closed = { ...local, menu: undefined }
  switch (entry.action) {
    case 'move':
    case 'back': {
      const isMoveOpen = entry.action === 'move'
      surface.setState({ ...local, menu: { key, isMoveOpen, active: isMoveOpen ? 'back' : 'move' } })

      return
    }
    case 'to':
      if (!entry.lane) {
        surface.setState(closed)

        return
      }
      surface.setState({ ...closed, confirm: { key, lane: entry.lane, isMoveChosen: true }, cursor: `card:${key}` })
      surface.post({ type: 'preview', key, lane: entry.lane })

      return
    default:
      surface.setState(closed)
      surface.post({ type: 'act', action: entry.action, key })
  }
}

/**
 * A press and release on one row: open a ticket or a lane, its menu, a menu entry, the board picker or one of
 * its boards, or answer the confirm (pressed and released on the same button). A click anywhere else drops
 * the confirm, the menu and the picker.
 */
function click(
  surface: ClientSurface<BoardLocal>,
  local: BoardLocal,
  props: BoardProps,
  row: BoardRow | undefined,
  x: number,
  upX: number,
  columns: number
): void {
  if (row?.kind === 'card') {
    const { key } = row.card
    if (x >= columns - MENU_ZONE_CELLS) {
      surface.setState(toggleMenu(local, key))

      return
    }
    changeView(surface, { ...local, cursor: `card:${key}`, menu: undefined, confirm: undefined, toggled: toggleIn(local.toggled, key) })
  } else if (row?.kind === 'lane') {
    const { name } = row.lane
    const toggledLanes = toggleIn(local.toggledLanes, name)
    changeView(surface, { ...local, cursor: `lane:${name}`, menu: undefined, confirm: undefined, toggledLanes })
  } else if (row?.kind === 'menu') {
    activate(surface, local, row.card.key, row.entry)
  } else if (row?.kind === 'picker') {
    surface.setState(togglePicker(local, props))
  } else if (row?.kind === 'option') {
    pickBoard(surface, local, props, row.option.id)
  } else if (row?.kind === 'confirm') {
    const layout = confirmLayout(row.confirm, props, columns)
    const choice = confirmChoiceAt(layout, x)
    const isSameButton = choice === confirmChoiceAt(layout, upX)
    if (isSameButton && choice === 'move') confirmMove(surface, local)
    else if (isSameButton && choice === 'cancel') surface.setState({ ...local, confirm: undefined })
    else surface.setState(local)
  } else {
    surface.setState({ ...local, menu: undefined, confirm: undefined, picker: undefined })
  }
}

/** While a ticket is held: which lane the pointer is over, if any; the same local when nothing changed. */
function dragOver(local: BoardLocal, rows: readonly BoardRow[], props: BoardProps, y: number): BoardLocal {
  const { press, drag } = local
  if (!press?.key || (!drag && y === press.y)) return local
  const over = dropLaneAt(rows, y, props)
  if (drag && drag.over === over) return local
  const from = drag?.from ?? press.lane ?? ''

  return { ...local, drag: { key: press.key, from, ...(over === undefined ? {} : { over }) } }
}

/**
 * The release: a drop onto another lane asks to confirm under the ticket and has the hooks module read the
 * status it would land in. A release on the row pressed, still the same row, is a click; one that slid off
 * it, or met a redraw that moved the rows, does nothing.
 */
function release(
  surface: ClientSurface<BoardLocal>,
  local: BoardLocal,
  props: BoardProps,
  rows: readonly BoardRow[],
  up: ClientPointerEvent,
  columns: number
): void {
  const { press, drag } = local
  const settled = { ...local, press: undefined, drag: undefined }
  if (drag) {
    const lane = drag.over !== undefined && drag.over !== drag.from ? drag.over : undefined
    if (lane === undefined) {
      surface.setState(settled)

      return
    }
    const confirm = { key: drag.key, lane, isMoveChosen: true }
    surface.setState({ ...settled, menu: undefined, picker: undefined, confirm, cursor: `card:${drag.key}` })
    surface.post({ type: 'preview', key: drag.key, lane })

    return
  }
  const row = rows[up.y]
  if (press && up.y === press.y && rowIdOf(row) === press.rowId) click(surface, settled, props, row, press.x, up.x, columns)
  else surface.setState(settled)
}

function handlePointer(event: ClientPointerEvent, props: BoardProps, surface: ClientSurface<BoardLocal>): void {
  const local = readLocal(surface, props)
  const rows = layoutRows(props, local)
  const row = rows[event.y]
  if (event.button === 'right') {
    if (event.type === 'down' && row?.kind === 'card') surface.setState(toggleMenu(local, row.card.key))

    return
  }
  if (event.button !== 'left') return
  if (event.type === 'down') {
    const held = row?.kind === 'card' ? { key: row.card.key, lane: row.laneName } : {}
    surface.setState({ ...local, press: { x: event.x, y: event.y, rowId: rowIdOf(row), ...held }, drag: undefined })
  } else if (event.type === 'move') {
    const next = dragOver(local, rows, props, event.y)
    if (next !== local) surface.setState(next)
  } else if (event.type === 'up') {
    release(surface, local, props, rows, event, widthOf(surface, props))
  }
}

function stopOf(row: BoardRow): string | undefined {
  if (row.kind === 'picker') return PICKER_STOP
  if (row.kind === 'lane') return `lane:${row.lane.name}`
  if (row.kind === 'card') return `card:${row.card.key}`

  return undefined
}

/** ↑ ↓ through the picker, lanes and tickets, → ← open and close, Enter or m for a ticket's menu. */
function keyOnBoard(
  surface: ClientSurface<BoardLocal>,
  local: BoardLocal,
  props: BoardProps,
  rows: readonly BoardRow[],
  event: ClientKeyEvent
): void {
  const stops = rows.flatMap(row => stopOf(row) ?? [])
  const at = local.cursor === undefined ? -1 : stops.indexOf(local.cursor)
  if (event.key === 'down' || event.key === 'up') {
    const step = event.key === 'down' ? 1 : -1
    const next = at === -1 ? (step === 1 ? 0 : stops.length - 1) : Math.min(stops.length - 1, Math.max(0, at + step))
    const cursor = stops[next]
    if (cursor !== undefined) surface.setState({ ...local, cursor })

    return
  }
  const row = rows.find(one => stopOf(one) === local.cursor)
  if (row?.kind === 'picker') {
    if (event.key === 'return' || event.key === 'right') surface.setState(togglePicker(local, props))
  } else if (row?.kind === 'card') {
    const isOpen = isCardOpen(row.card, local.toggled)
    const wantsToggle = (event.key === 'right' && !isOpen) || (event.key === 'left' && isOpen)
    if (wantsToggle) changeView(surface, { ...local, toggled: toggleIn(local.toggled, row.card.key) })
    else if (event.key === 'return' || event.key === 'm') surface.setState(toggleMenu(local, row.card.key))
  } else if (row?.kind === 'lane') {
    const isCollapsed = isLaneCollapsed(row.lane, local.toggledLanes)
    const wantsToggle = (event.key === 'right' && isCollapsed) || (event.key === 'left' && !isCollapsed) || event.key === 'return'
    if (wantsToggle) changeView(surface, { ...local, toggledLanes: toggleIn(local.toggledLanes, row.lane.name) })
  }
}

/**
 * ↑ ↓ move the highlight (by entry, not by place), Enter acts on it, → only opens Move to ▸, ← or backspace goes
 * back or closes: an arrow never moves a ticket or runs an action.
 */
function keyOnMenu(surface: ClientSurface<BoardLocal>, local: BoardLocal, menu: Menu, props: BoardProps, event: ClientKeyEvent): void {
  const entries = menuEntries(menu, props)
  const at = entries.findIndex(entry => entryId(entry) === menu.active)
  const entry = entries[at]
  if (event.key === 'down' || event.key === 'up') {
    const step = event.key === 'down' ? 1 : -1
    const next = entries[at === -1 ? 0 : (at + step + entries.length) % entries.length]
    if (next) surface.setState({ ...local, menu: { ...menu, active: entryId(next) } })
  } else if (entry && (event.key === 'return' || (event.key === 'right' && entry.action === 'move'))) {
    activate(surface, local, menu.key, entry)
  } else if ((event.key === 'left' || event.key === 'backspace') && menu.isMoveOpen) {
    surface.setState({ ...local, menu: { ...menu, isMoveOpen: false, active: 'move' } })
  } else if (event.key === 'left' || event.key === 'backspace' || event.key === 'm') {
    surface.setState({ ...local, menu: undefined })
  }
}

function keyOnPicker(surface: ClientSurface<BoardLocal>, local: BoardLocal, picker: Picker, props: BoardProps, event: ClientKeyEvent): void {
  const at = props.boards.findIndex(option => option.id === picker.active)
  const active = props.boards[at]
  if (event.key === 'down' || event.key === 'up') {
    const step = event.key === 'down' ? 1 : -1
    const next = props.boards[at === -1 ? 0 : (at + step + props.boards.length) % props.boards.length]
    if (next) surface.setState({ ...local, picker: { active: next.id } })
  } else if ((event.key === 'return' || event.key === 'right') && active) {
    pickBoard(surface, local, props, active.id)
  } else if (event.key === 'left' || event.key === 'backspace') {
    surface.setState({ ...local, picker: undefined })
  }
}

/** ← → (or Tab) choose between Move and Cancel, Enter answers, backspace cancels; no letter answers it. */
function keyOnConfirm(surface: ClientSurface<BoardLocal>, local: BoardLocal, confirm: Confirm, event: ClientKeyEvent): void {
  if (event.key === 'left' || event.key === 'right' || event.key === 'tab') {
    surface.setState({ ...local, confirm: { ...confirm, isMoveChosen: !confirm.isMoveChosen } })
  } else if (event.key === 'return' && confirm.isMoveChosen) {
    confirmMove(surface, local)
  } else if (event.key === 'backspace' || event.key === 'return') {
    surface.setState({ ...local, confirm: undefined })
  }
}

/** Keys answer a confirm, a menu or the picker only while it is drawn; one hidden (its lane collapsed, a move in flight) is dropped. */
function handleKey(event: ClientKeyEvent, props: BoardProps, surface: ClientSurface<BoardLocal>): void {
  const local = readLocal(surface, props)
  const rows = layoutRows(props, local)
  const { menu, confirm, picker } = local
  if (confirm && rows.some(row => row.kind === 'confirm')) {
    keyOnConfirm(surface, local, confirm, event)
  } else if (menu && rows.some(row => row.kind === 'menu')) {
    keyOnMenu(surface, local, menu, props, event)
  } else if (picker && rows.some(row => row.kind === 'option')) {
    keyOnPicker(surface, local, picker, props, event)
  } else {
    const board = { ...local, menu: undefined, confirm: undefined, picker: undefined }
    if (menu || confirm || picker) surface.setState(board)
    keyOnBoard(surface, board, props, layoutRows(props, board), event)
  }
}

/** `›Board  Team Board · kanban  ▾`: the board the lanes follow; a click lists the project's others. */
function drawPicker(ui: ClientElements, props: BoardProps, local: BoardLocal, columns: number): JSX.Element {
  const { Text } = ui
  const current = props.boards.find(option => option.id === props.boardId)
  const lead = `${local.cursor === PICKER_STOP ? '›' : ' '}${PICKER_LABEL}${GAP}`
  let tail = ''
  if (props.isBoardLoading) tail = `${GAP}…`
  else if (props.boards.length > 1) tail = `${GAP}${local.picker ? '▴' : '▾'}`
  const room = Math.max(1, columns - cellWidth(lead) - cellWidth(tail))

  return (
    <Text wrap="truncate-end">
      <Text dimColor>{lead}</Text>
      <Text bold>{fitEnd(current?.label ?? 'Choose a board', room)}</Text>
      <Text dimColor>{tail}</Text>
    </Text>
  )
}

function drawOption(ui: ClientElements, row: OptionRow, props: BoardProps, columns: number): JSX.Element {
  const { Text } = ui
  const mark = row.option.id === props.boardId ? '●' : '○'

  return (
    <Text wrap="truncate-end">
      {' '.repeat(DETAIL_INDENT)}
      <Text inverse={row.isActive}>{fitEnd(`${mark} ${row.option.label}`, columns - DETAIL_INDENT)}</Text>
    </Text>
  )
}

function drawLane(ui: ClientElements, row: LaneRow, local: BoardLocal): JSX.Element {
  const { Text } = ui
  const { lane } = row
  const isTarget = local.drag?.over === lane.name && local.drag.from !== lane.name
  const isCollapsed = isLaneCollapsed(lane, local.toggledLanes)

  return (
    <Text wrap="truncate-end">
      {local.cursor === `lane:${lane.name}` ? '›' : ' '}
      <Text bold inverse={isTarget}>
        {laneTitle(lane.name)}
      </Text>
      <Text dimColor>{`${GAP}(${lane.cards.length})${isCollapsed ? `${GAP}▸` : ''}`}</Text>
      {isTarget && <Text color="suggestion">{`${GAP}← drop here`}</Text>}
    </Text>
  )
}

function drawCard(ui: ClientElements, row: CardRow, local: BoardLocal, columns: number): JSX.Element {
  const { Text } = ui
  const { card } = row
  const lead = `${local.cursor === `card:${card.key}` ? '›' : ' '}${isCardOpen(card, local.toggled) ? '▾' : '▸'} `
  const star = card.isBranch ? ' ★' : ''
  const pr = card.pr ? `${GAP}${card.pr}` : ''
  const room = columns - cellWidth(lead) - cellWidth(card.key) - cellWidth(star) - GAP.length - 2 - cellWidth(pr)

  return (
    <Text wrap="truncate-end" inverse={local.drag?.key === card.key}>
      {lead}
      <Text bold color="suggestion">
        {card.key}
      </Text>
      {card.isBranch && <Text color="warning">{star}</Text>}
      {`${GAP}${room > 0 ? padCells(card.summary, room) : ''}`}
      {pr !== '' && <Text dimColor>{pr}</Text>}
      <Text dimColor>{' ⋯'}</Text>
    </Text>
  )
}

function drawConfirm(ui: ClientElements, confirm: Confirm, props: BoardProps, columns: number): JSX.Element {
  const { Text } = ui
  const { question } = confirmLayout(confirm, props, columns)

  return (
    <Text wrap="truncate-end">
      {`${' '.repeat(DETAIL_INDENT)}${question}${GAP}`}
      <Text bold inverse={confirm.isMoveChosen} color="suggestion">
        {MOVE_LABEL}
      </Text>
      {GAP}
      <Text inverse={!confirm.isMoveChosen}>{CANCEL_LABEL}</Text>
    </Text>
  )
}

function drawRow(ui: ClientElements, row: BoardRow, props: BoardProps, local: BoardLocal, columns: number): JSX.Element {
  const { Text } = ui
  const indent = ' '.repeat(DETAIL_INDENT)
  switch (row.kind) {
    case 'picker':
      return drawPicker(ui, props, local, columns)
    case 'option':
      return drawOption(ui, row, props, columns)
    case 'lane':
      return drawLane(ui, row, local)
    case 'card':
      return drawCard(ui, row, local, columns)
    case 'confirm':
      return drawConfirm(ui, row.confirm, props, columns)
    case 'menu':
      return (
        <Text wrap="truncate-end">
          {indent}
          <Text inverse={row.isActive}>{fitEnd(row.entry.label, columns - DETAIL_INDENT)}</Text>
        </Text>
      )
    case 'field':
      return (
        <Text wrap="truncate-end">
          <Text dimColor>{`${indent}${padCells(row.label, LABEL_CELLS)}`}</Text>
          <Text bold>{fitEnd(row.value, columns - DETAIL_INDENT - LABEL_CELLS)}</Text>
        </Text>
      )
    case 'excerpt':
    case 'pending':
      return (
        <Text dimColor wrap="truncate-end">
          {`${indent}${fitEnd(row.text, columns - DETAIL_INDENT)}`}
        </Text>
      )
    default:
      return <Text> </Text>
  }
}

/** The board picker and the lanes as a board the person drags tickets across, right-clicks and steers with the keys. */
export default function JiraBoard(props: BoardProps, surface: ClientSurface<BoardLocal>): RenderElement {
  surface.onPointer(event => handlePointer(event, props, surface))
  surface.onKey(event => handleKey(event, props, surface))
  const { Box } = surface.elements
  const local = readLocal(surface, props)
  const columns = widthOf(surface, props)

  return (
    <Box flexDirection="column" width={columns}>
      {layoutRows(props, local).map(row => drawRow(surface.elements, row, props, local, columns))}
    </Box>
  )
}
