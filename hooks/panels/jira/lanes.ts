import type { McpToolResult } from 'claude-code'

import type {
  JiraBoard,
  JiraBoardColumn,
  JiraBoardStatus,
  JiraBoardSummary,
  JiraMove,
  JiraMovePreview,
  JiraState,
  JiraTicket
} from '../../../types'
import type { PrBadge } from '../github/jiraLink'
import { prBadgeLabel } from '../github/jiraLink'
import { drawable } from '../github/parse'
import { isRecord, mcpErrorText, readMcpJson, textAt, valueAt } from './parse'
import { ticketFromIssue } from './ticket'

const CATEGORY_RANK: Record<string, number> = { new: 0, indeterminate: 1, done: 2 }
const PROJECT_KEY = /^([A-Z][A-Z0-9]+)-\d+$/
/** The lane after a board's columns that holds the tickets whose status no column has. */
export const OTHER_LANE = 'Other'

/** A lane as drawn: a board column (or, with no board, one status) and the tickets in it. */
export interface BoardLane {
  name: string
  statuses: JiraBoardStatus[]
  tickets: JiraTicket[]
  /** The `Other` lane: no column of the board, so nothing moves into it. */
  isOther?: boolean
}

export interface JiraTransition {
  id: string
  name: string
  toId?: string
  toName: string
}

export type TransitionsParse = { isOk: true; transitions: JiraTransition[] } | { isOk: false; error: string }

export interface CardField {
  label: string
  value: string
}

/** One ticket row of the board, with the details its open card shows. */
export interface CardView {
  key: string
  summary: string
  /** The branch's ticket: marked ★ and open until the person closes it. */
  isBranch: boolean
  fields: CardField[]
  excerpt: string[]
  /** The ticket's pull request as `#2086 ✅ 👍`; absent when no pull request carries the key. */
  pr?: string
  /** That pull request's number, for the menu's `Open PR #2086`. */
  prNumber?: number
}

export interface LaneView {
  name: string
  cards: CardView[]
  isCollapsedByDefault: boolean
  /** False for the `Other` lane: a drop or a `Move to` cannot land there. */
  isMoveTarget: boolean
}

/** One entry of the board picker: `Team Board · kanban`. */
export interface BoardOption {
  id: number
  label: string
}

/** What the board's `Client` is handed: plain data only, no key left undefined. */
export interface BoardProps {
  lanes: LaneView[]
  columns: number
  toggled: string[]
  toggledLanes: string[]
  /** The project's boards for the picker row; empty, the board draws no picker. */
  boards: BoardOption[]
  boardId?: number
  isBoardLoading?: boolean
  pending?: JiraMove
  preview?: JiraMovePreview
}

export type MenuAction = 'move' | 'branch' | 'open' | 'pr' | 'link' | 'full'

/** The actions a ticket's menu offers that act at once, posted to the hooks module. */
export type TicketAction = Exclude<MenuAction, 'move'>

export interface MenuItem {
  action: MenuAction
  label: string
}

export const MENU_ITEMS: readonly MenuItem[] = [
  { action: 'move', label: 'Move to ▸' },
  { action: 'branch', label: 'New branch' },
  { action: 'open', label: 'Open in browser' },
  { action: 'pr', label: 'Open pull request' },
  { action: 'link', label: 'Add link to prompt' },
  { action: 'full', label: 'Add full ticket to prompt' }
]

const TICKET_ACTIONS: readonly string[] = ['branch', 'open', 'pr', 'link', 'full']

/** A ticket's menu: `Open PR #2086` only when a pull request carries its key. */
export function menuItemsFor(card: Pick<CardView, 'prNumber'> | undefined): MenuItem[] {
  return MENU_ITEMS.flatMap(item => {
    if (item.action !== 'pr') return [item]

    return card?.prNumber === undefined ? [] : [{ action: item.action, label: `Open PR #${card.prNumber}` }]
  })
}

export interface ViewMessage {
  type: 'view'
  toggled: string[]
  toggledLanes: string[]
}

export interface MoveMessage {
  type: 'move'
  key: string
  lane: string
}

export interface ActMessage {
  type: 'act'
  action: TicketAction
  key: string
}

/** A drop waiting for its confirm: the hooks module reads the status the move would land in. */
export interface PreviewMessage {
  type: 'preview'
  key: string
  lane: string
}

export interface PickBoardMessage {
  type: 'board'
  id: number
}

/** What the board's `Client` posts to the hooks module. */
export type BoardMessage = ViewMessage | MoveMessage | ActMessage | PreviewMessage | PickBoardMessage

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isTicketAction(value: unknown): value is TicketAction {
  return typeof value === 'string' && TICKET_ACTIONS.includes(value)
}

/** A post from the board's `Client`, checked: it came from code, so anything else is dropped. */
export function parseBoardMessage(data: unknown): BoardMessage | undefined {
  if (!isRecord(data)) return undefined
  const { type, key, lane, action, toggled, toggledLanes, id } = data
  if (type === 'view' && isStringList(toggled) && isStringList(toggledLanes)) return { type, toggled, toggledLanes }
  if ((type === 'move' || type === 'preview') && typeof key === 'string' && typeof lane === 'string') return { type, key, lane }
  if (type === 'act' && typeof key === 'string' && isTicketAction(action)) return { type, key, action }
  if (type === 'board' && typeof id === 'number' && Number.isInteger(id)) return { type, id }

  return undefined
}

/** `list` with `item` added, or taken out when it is there: a toggle against a default. */
export function toggleIn(list: readonly string[], item: string): string[] {
  return list.includes(item) ? list.filter(one => one !== item) : [...list, item]
}

export function isCardOpen(card: Pick<CardView, 'key' | 'isBranch'>, toggled: readonly string[]): boolean {
  return card.isBranch !== toggled.includes(card.key)
}

export function isLaneCollapsed(lane: Pick<LaneView, 'name' | 'isCollapsedByDefault'>, toggledLanes: readonly string[]): boolean {
  return lane.isCollapsedByDefault !== toggledLanes.includes(lane.name)
}

/** `In Progress` → `IN PROGRESS`, the way the lane headers read. */
export function laneTitle(name: string): string {
  return name.toUpperCase()
}

export function projectOf(key: string | undefined): string | undefined {
  return key === undefined ? undefined : PROJECT_KEY.exec(key)?.[1]
}

/** The project whose board draws the lanes: the branch ticket's, else the one most of the tickets are in. */
export function boardProjectFor(state: JiraState): string | undefined {
  const fromBranch = projectOf(state.ticketKey)
  if (fromBranch) return fromBranch
  const counts = new Map<string, number>()
  for (const ticket of state.tickets ?? []) {
    const project = projectOf(ticket.key)
    if (project) counts.set(project, (counts.get(project) ?? 0) + 1)
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

export type BoardListParse = { isOk: true; boards: JiraBoardSummary[] } | { isOk: false; error: string }

function parseBoardSummary(board: unknown): JiraBoardSummary | undefined {
  const id = isRecord(board) ? board.id : undefined
  const name = textAt(board, 'name')
  if (typeof id !== 'number' || !name) return undefined
  const type = textAt(board, 'type')

  return { id, name, ...(type ? { type } : {}) }
}

/**
 * The boards a `listJiraBoards` result lists, in its order.
 * @example
 * // before: { data: { values: [{ id: 357, name: 'Team Board', type: 'kanban', location: {…} }] } }
 * // after:  { isOk: true, boards: [{ id: 357, name: 'Team Board', type: 'kanban' }] }
 */
export function parseBoardList(result: McpToolResult): BoardListParse {
  if (result.isError) return { isOk: false, error: mcpErrorText(result) }
  const values = valueAt(readMcpJson(result), ['values'])
  if (!Array.isArray(values)) return { isOk: false, error: 'Jira answered without a list of boards' }

  return { isOk: true, boards: values.flatMap(board => parseBoardSummary(board) ?? []) }
}

/** `Team Board · kanban`, the way the picker lists a board. */
export function boardLabel(board: JiraBoardSummary): string {
  return board.type ? `${board.name} · ${board.type}` : board.name
}

/** The board the person picked for the project, while the project still has it. */
export function chosenBoard(boards: readonly JiraBoardSummary[], choice: number | undefined): JiraBoardSummary | undefined {
  return choice === undefined ? undefined : boards.find(board => board.id === choice)
}

/**
 * The picks kept in the store, by project key; anything malformed is dropped.
 * @example
 * // before: { ABC: 357, XYZ: '12', X: null }
 * // after:  { ABC: 357 }
 */
export function parseBoardChoices(stored: unknown): Record<string, number> {
  if (!isRecord(stored)) return {}
  const choices: Record<string, number> = {}
  for (const [project, id] of Object.entries(stored)) {
    if (typeof id === 'number' && Number.isInteger(id)) choices[project] = id
  }

  return choices
}

function parseBoardStatus(status: unknown): JiraBoardStatus | undefined {
  const name = textAt(status, 'name')
  if (!name) return undefined
  const id = textAt(status, 'id')
  const category = textAt(status, 'category')

  return { name, ...(id ? { id } : {}), ...(category ? { category } : {}) }
}

/**
 * A `getJiraBoardConfig` result as the board's columns and the statuses each holds.
 * @example
 * // before: { data: { id: 357, name: 'Team Board', columnConfig: { columns: [{ name: 'IN REVIEW',
 * //           statuses: [{ id: '10003', name: 'IN REVIEW', category: 'done' }] }] } } }
 * // after:  { id: 357, name: 'Team Board', projectKey: 'ABC',
 * //           columns: [{ name: 'IN REVIEW', statuses: [{ id: '10003', name: 'IN REVIEW', category: 'done' }] }] }
 */
export function parseBoardConfig(result: McpToolResult, projectKey: string): JiraBoard | undefined {
  if (result.isError) return undefined
  const json = readMcpJson(result)
  const id = valueAt(json, ['id'])
  const name = textAt(json, 'name')
  const listed = valueAt(json, ['columnConfig', 'columns'])
  if (typeof id !== 'number' || !name || !Array.isArray(listed)) return undefined
  const columns = listed.flatMap((column): JiraBoardColumn[] => {
    const columnName = textAt(column, 'name')
    const statuses = valueAt(column, ['statuses'])
    if (!columnName || !Array.isArray(statuses)) return []

    return [{ name: columnName, statuses: statuses.flatMap(status => parseBoardStatus(status) ?? []) }]
  })

  return columns.length > 0 ? { id, name, projectKey, columns } : undefined
}

/** What looking for a project's board found: its boards when they were listed, the board read, what failed. */
export interface BoardLookup {
  boards?: JiraBoardSummary[]
  board?: JiraBoard
  error?: string
}

/**
 * The state after a board lookup. Only a lookup that read a board (or found the project has none) marks the
 * project done; a failed one leaves `boardProject` unset, so the next refresh looks again.
 * @example
 * // before: {}, 'ABC', { error: 'claude.ai Atlassian MCP: denied' }
 * // after:  { boardNote: 'No ABC board reachable: the lanes are the statuses', boardError: 'claude.ai Atlassian MCP: denied' }
 */
export function withBoardLookup(state: JiraState, project: string, lookup: BoardLookup): JiraState {
  const kept = state.board?.projectKey === project ? state.board : undefined
  const board = lookup.board ?? kept
  const boards = lookup.boards ?? (kept ? state.boards : undefined)
  const isDone = lookup.error === undefined && lookup.boards !== undefined
  const reason = boards?.length === 0 ? `${project} has no board` : `No ${project} board reachable`
  const note = `${reason}: the lanes are the statuses`
  const { boardProject: _boardProject, boards: _boards, boardsProject: _listedFor, board: _board, boardNote: _note, boardError: _error, ...rest } =
    state
  const boardsProject = lookup.boards ? project : (state.boardsProject ?? project)

  return {
    ...rest,
    ...(isDone ? { boardProject: project } : {}),
    ...(boards ? { boards, boardsProject } : {}),
    ...(board ? { board } : { boardNote: note }),
    ...(lookup.error ? { boardError: lookup.error } : {})
  }
}

/** Of a project's boards, the one that tells the most statuses apart: the most columns, the first on a tie. */
export function pickBoard(boards: readonly JiraBoard[]): JiraBoard | undefined {
  return boards.reduce<JiraBoard | undefined>(
    (best, board) => (best === undefined || board.columns.length > best.columns.length ? board : best),
    undefined
  )
}

function sameName(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** The column that holds the ticket's status: by id, then by status name, then by the column's own name. */
function columnIndexOf(ticket: JiraTicket, columns: readonly JiraBoardColumn[]): number {
  const holdsId = (column: JiraBoardColumn) => column.statuses.some(status => status.id !== undefined && status.id === ticket.statusId)
  const byId = columns.findIndex(holdsId)
  if (byId !== -1) return byId
  const byStatus = columns.findIndex(column => column.statuses.some(status => sameName(status.name, ticket.status)))
  if (byStatus !== -1) return byStatus

  return columns.findIndex(column => sameName(column.name, ticket.status))
}

/**
 * Puts each ticket in the board column that holds its status (by id, then name); the tickets whose status
 * no column holds go to an `Other` lane after the board's.
 * @example
 * // before: tickets [ABC-1 To Do#10001, XYZ-3 TO DO#10000, ABC-2 IN REVIEW#10003, X-4 Parked]
 * //         columns [Backlog: To Do#10001] [IN REVIEW: IN REVIEW#10003]
 * // after:  [{ name: 'Backlog', tickets: [ABC-1, XYZ-3] }, { name: 'IN REVIEW', tickets: [ABC-2] }, { name: 'Other', tickets: [X-4] }]
 */
export function groupTicketsIntoLanes(tickets: readonly JiraTicket[], columns: readonly JiraBoardColumn[]): BoardLane[] {
  const lanes: BoardLane[] = columns.map(column => ({ name: column.name, statuses: column.statuses, tickets: [] }))
  const other: BoardLane = { name: OTHER_LANE, statuses: [], tickets: [], isOther: true }
  for (const ticket of tickets) {
    const lane = lanes[columnIndexOf(ticket, columns)] ?? other
    lane.tickets.push(ticket)
  }

  return other.tickets.length > 0 ? [...lanes, other] : lanes
}

/**
 * With no board, one lane per status present, ordered to do, in progress, done (then as first seen).
 * @example
 * // before: [A IN REVIEW (done), B To Do (new), C In Progress (indeterminate), D To Do (new)]
 * // after:  [{ name: 'To Do', tickets: [B, D] }, { name: 'In Progress', tickets: [C] }, { name: 'IN REVIEW', tickets: [A] }]
 */
export function groupTicketsByStatus(tickets: readonly JiraTicket[]): BoardLane[] {
  const lanes: BoardLane[] = []
  for (const ticket of tickets) {
    const name = ticket.status ?? 'No status'
    const lane = lanes.find(one => sameName(one.name, name))
    const category = ticket.statusCategory ? { category: ticket.statusCategory } : {}
    if (lane) lane.tickets.push(ticket)
    else lanes.push({ name, statuses: [{ name, ...category }], tickets: [ticket] })
  }
  const rank = (lane: BoardLane) => CATEGORY_RANK[lane.statuses[0]?.category ?? 'indeterminate'] ?? 1

  return lanes
    .map((lane, order) => ({ lane, order }))
    .sort((a, b) => rank(a.lane) - rank(b.lane) || a.order - b.order)
    .map(({ lane }) => lane)
}

/** The person's tickets, with the branch's own ticket first when it is not among them. */
function ticketsWithBranch(state: JiraState): JiraTicket[] {
  const tickets = state.tickets ?? []
  const { issue, ticketKey } = state
  const isMissing = issue !== undefined && issue.key === ticketKey && !tickets.some(ticket => ticket.key === issue.key)

  return isMissing ? [ticketFromIssue(issue), ...tickets] : tickets
}

/** The board's lanes from the stored state: the board's columns when one was found, else the statuses. */
export function buildLanes(state: JiraState): BoardLane[] {
  const tickets = ticketsWithBranch(state)
  if (state.board) return groupTicketsIntoLanes(tickets, state.board.columns)

  return groupTicketsByStatus(tickets)
}

/** `3h ago` from Jira's ISO time (`+0900` offsets read as `+09:00`) and the moment the list loaded. */
export function formatAge(iso: string | undefined, now: number | undefined): string | undefined {
  const at = iso === undefined ? Number.NaN : Date.parse(iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  if (Number.isNaN(at) || now === undefined) return undefined
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)

  return days < 60 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`
}

/**
 * The rows under an open card: status, priority and type on one row, when it was updated.
 * @example
 * // before: { status: 'In Progress', priority: 'Medium', type: 'Story', updated: '2026-10-13T09:00:00Z' }, now 12:00Z
 * // after:  [{ Status, In Progress }, { Prio, Medium · Story }, { Updated, 3h ago }]
 */
export function cardFields(ticket: JiraTicket, now: number | undefined): CardField[] {
  const prio = [ticket.priority, ticket.type].filter(Boolean).join(' · ')
  const age = formatAge(ticket.updated, now)

  return [
    { label: 'Status', value: ticket.status ?? 'No status' },
    ...(prio !== '' ? [{ label: 'Prio', value: prio }] : []),
    ...(age ? [{ label: 'Updated', value: age }] : [])
  ]
}

export function cardOf(ticket: JiraTicket, state: JiraState, badge?: PrBadge): CardView {
  const pr = badge ? drawable(prBadgeLabel(badge)) : undefined

  return {
    key: ticket.key,
    summary: drawable(ticket.summary),
    isBranch: ticket.key === state.ticketKey,
    fields: [...cardFields(ticket, state.listedAt).map(field => ({ ...field, value: drawable(field.value) })), ...(pr ? [{ label: 'PR', value: pr }] : [])],
    excerpt: (ticket.excerpt ?? []).map(drawable),
    ...(pr ? { pr } : {}),
    ...(badge ? { prNumber: badge.number } : {})
  }
}

/** A plain board's `→ Lane` Button key, naming the lane so a redraw that reorders the lanes cannot change the target. */
export function moveTargetKey(key: string, lane: string): string {
  return `jira-to-${key}~${encodeURIComponent(lane)}`
}

/**
 * Reads a `moveTargetKey` back; anything else is undefined.
 * @example
 * // before: 'jira-to-ABC-1~IN%20REVIEW'
 * // after:  { key: 'ABC-1', lane: 'IN REVIEW' }
 */
export function parseMoveTarget(element: string): JiraMove | undefined {
  const [, key, lane] = /^jira-to-([^~]+)~(.+)$/.exec(element) ?? []
  if (!key || !lane) return undefined
  try {
    return { key, lane: decodeURIComponent(lane) }
  } catch {
    return undefined
  }
}

/** A plain board's Move Button key, naming the lane its confirm asks about so a stale press cannot move to another. */
export function confirmMoveKey(move: JiraMove): string {
  return `jira-confirm-move-${move.key}~${encodeURIComponent(move.lane)}`
}

/** A press of a plain board's confirm: Move names its lane too, Cancel only the ticket. */
export interface ConfirmPress {
  answer: 'move' | 'cancel'
  key: string
  lane?: string
}

/**
 * Reads a confirm Button's key back; anything else is undefined.
 * @example
 * // before: 'jira-confirm-move-ABC-1~IN%20REVIEW'   after: { answer: 'move', key: 'ABC-1', lane: 'IN REVIEW' }
 * // before: 'jira-confirm-cancel-ABC-1'          after: { answer: 'cancel', key: 'ABC-1' }
 */
export function parseConfirmPress(element: string): ConfirmPress | undefined {
  const [, answer, key, lane] = /^jira-confirm-(move|cancel)-([^~]+)(?:~(.+))?$/.exec(element) ?? []
  if (!key) return undefined
  if (answer === 'cancel') return { answer, key }
  if (answer !== 'move' || !lane) return undefined
  try {
    return { answer, key, lane: decodeURIComponent(lane) }
  } catch {
    return undefined
  }
}

/** The lanes as the board draws them; the board's last column starts collapsed, as a Done column. */
export function laneViews(state: JiraState, prBadges: Readonly<Record<string, PrBadge>> = {}): LaneView[] {
  const lanes = buildLanes(state)
  const columnCount = lanes.filter(lane => !lane.isOther).length

  return lanes.map((lane, index) => ({
    name: lane.name,
    cards: lane.tickets.map(ticket => cardOf(ticket, state, prBadges[ticket.key])),
    isCollapsedByDefault: columnCount > 1 && index === columnCount - 1,
    isMoveTarget: lane.isOther !== true
  }))
}

/** The project's boards as the picker lists them; none until they were listed for the board's project. */
export function boardOptions(state: JiraState): BoardOption[] {
  return (state.boards ?? []).map(board => ({ id: board.id, label: boardLabel(board) }))
}

/** The preview as plain props: no key left undefined. */
function previewProps(preview: JiraMovePreview): JiraMovePreview {
  return { key: preview.key, lane: preview.lane, ...(preview.status ? { status: preview.status } : {}) }
}

/** The board `Client`'s props from the stored state, sized to the card's width. */
export function buildBoardProps(state: JiraState, columns: number, prBadges: Readonly<Record<string, PrBadge>> = {}): BoardProps {
  const { pendingMove, movePreview, board, isBoardLoading } = state

  return {
    lanes: laneViews(state, prBadges),
    columns,
    toggled: state.view?.toggled ?? [],
    toggledLanes: state.view?.toggledLanes ?? [],
    boards: boardOptions(state),
    ...(board ? { boardId: board.id } : {}),
    ...(isBoardLoading ? { isBoardLoading: true } : {}),
    ...(pendingMove ? { pending: { key: pendingMove.key, lane: pendingMove.lane } } : {}),
    ...(movePreview ? { preview: previewProps(movePreview) } : {})
  }
}

/**
 * The confirm under a dropped ticket, naming the status it lands in when that is not the lane's name.
 * @example
 * // before: 'Done', { key: 'ABC-1', lane: 'Done', status: 'COMPLETE' }
 * // after:  'Move to DONE (COMPLETE)?'
 */
export function confirmQuestion(lane: string, preview: JiraMovePreview | undefined): string {
  const status = preview?.lane === lane ? preview.status : undefined
  const named = status && !sameName(status, lane) ? ` (${status})` : ''

  return `Move to ${laneTitle(lane)}${named}?`
}

/** A plain board's lane Button key, naming the lane so a redraw that reorders the lanes cannot change it. */
export function laneToggleKey(lane: string): string {
  return `jira-lane-${encodeURIComponent(lane)}`
}

/** Reads a `laneToggleKey` back; anything else is undefined. */
export function parseLaneToggle(element: string): string | undefined {
  const [, lane] = /^jira-lane-(.+)$/.exec(element) ?? []
  if (!lane) return undefined
  try {
    return decodeURIComponent(lane)
  } catch {
    return undefined
  }
}

function parseTransition(transition: unknown): JiraTransition | undefined {
  const id = textAt(transition, 'id')
  const toName = textAt(transition, 'to', 'name')
  if (!id || !toName) return undefined
  const toId = textAt(transition, 'to', 'id')

  return { id, name: textAt(transition, 'name') ?? toName, toName, ...(toId ? { toId } : {}) }
}

/**
 * The transitions a ticket can take now, from either server's answer.
 * @example
 * // before: { transitions: [{ id: '91', name: 'IN REVIEW', to: { id: '10003', name: 'IN REVIEW' } }] }
 * // after:  { isOk: true, transitions: [{ id: '91', name: 'IN REVIEW', toId: '10003', toName: 'IN REVIEW' }] }
 */
export function parseTransitions(result: McpToolResult): TransitionsParse {
  if (result.isError) return { isOk: false, error: mcpErrorText(result) }
  const listed = valueAt(readMcpJson(result), ['transitions'])
  if (!Array.isArray(listed)) return { isOk: false, error: 'Jira answered without transitions' }

  return { isOk: true, transitions: listed.flatMap(transition => parseTransition(transition) ?? []) }
}

/**
 * The transition that lands the ticket in the lane: one to the lane's first status it can reach (by id, then
 * by name), else one to a status named as the lane.
 * @example
 * // before: transitions [61 → COMPLETE#10004, 131 → DUPLICATE#11162], lane Done: [COMPLETE#10004, DUPLICATE#11162]
 * // after:  { id: '61', toName: 'COMPLETE' }
 */
export function pickTransition(transitions: readonly JiraTransition[], lane: Pick<BoardLane, 'name' | 'statuses'>): JiraTransition | undefined {
  for (const status of lane.statuses) {
    const found =
      transitions.find(transition => status.id !== undefined && transition.toId === status.id) ??
      transitions.find(transition => sameName(transition.toName, status.name))
    if (found) return found
  }

  return transitions.find(transition => sameName(transition.toName, lane.name))
}
