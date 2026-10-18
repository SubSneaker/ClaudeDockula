import type { ThemeKey } from 'claude-code'

import type {
  SlackerDraft,
  SlackerFilter,
  SlackerItem,
  SlackerKind,
  SlackerMessage,
  SlackerSearch,
  SlackerState,
  SlackerThread
} from '../../../types'
import { cellWidth, fitEnd, fitStart } from '../../dock/ui'
import { FEED_DAYS, filterCounts, formatAge, isUnseen, LIST_STEP, replyTarget, visibleItems } from './feed'
import { wrapText } from './text'

// The feed as rows of segments, from the panel's state alone: the `Client` (./SlackerFeed.tsx) draws them one
// terminal row each and hit-tests them, the plain card (vscode, mobile) turns their keys into Buttons. No `$` here.

/** From this width an item takes one row (author, place, text, age); below it, two. */
const WIDE_COLUMNS = 90
/** The first cell of a row the arrow keys stop on, where the `Client` draws its cursor. */
export const GUTTER = ' '
export const CURSOR = '›'
const INDENT = '   '
/** Cells before an item's author: the gutter, the open or unseen mark, the badge and a space. */
const ITEM_LEAD_CELLS = 6
const DOTS = '⋯'
const BODY_LINES = 8
const DRAFT_LINES = 6
/** Errors are drawn whole, never cut. */
const ALL_LINES = Number.POSITIVE_INFINITY
const SHOWN_REPLIES = 4
/** The engine refuses a `Client`'s props past 100,000 characters, so the rows stop short of it. */
const MAX_PROPS_CHARS = 90_000
/** Every Button and `Client` of the panel is keyed under this prefix. */
export const KEY_PREFIX = 'slacker-'

export interface FeedLook {
  color?: ThemeKey
  isDim?: boolean
  isBold?: boolean
  isInverse?: boolean
}

/** A run of text on a row; a `key` makes it a target of its own. */
export interface FeedSegment extends FeedLook {
  text: string
  key?: string
}

/** One terminal row of the feed. */
export interface FeedRow {
  /** Where a click anywhere on the row lands, unless a segment there names its own. */
  key?: string
  /** The arrow keys stop on it (an item, a menu entry); its first cell is GUTTER. */
  isStop?: boolean
  segments: FeedSegment[]
}

/** The `Client`'s props: the rows to draw, and what the search box starts from when it takes the keys. */
export interface FeedProps {
  rows: FeedRow[]
  columns: number
  query: string
  isBusy: boolean
}

/** What the `Client` posts: a click or right-click by key, the filter as typed, or Enter's Slack-wide search. */
export type FeedMessage =
  | { type: 'click'; key?: string }
  | { type: 'context'; key?: string }
  | { type: 'query'; query: string }
  | { type: 'search'; query: string }

export type SlackerAction = 'add' | 'addthread' | 'reply' | 'thread' | 'copy' | 'close'
export type SlackerDraftAction = 'send' | 'polish' | 'edit' | 'undo' | 'cancel' | 'dismiss'
export type SlackerControl = 'search' | 'clear-query' | 'clear-search' | 'refresh' | 'allow' | 'watch' | 'seen' | 'more' | 'less'

/** What a key names: a control, a chip, an item, its `⋯`, an action on an item, or an answer to its reply. */
export type SlackerKey =
  | { kind: 'control'; name: SlackerControl }
  | { kind: 'filter'; filter: SlackerFilter }
  | { kind: 'item' | 'dots'; id: string }
  | { kind: 'action'; scope: 'act' | 'menu'; action: SlackerAction; id: string }
  | { kind: 'draft'; action: SlackerDraftAction; id: string }

const CONTROLS = ['search', 'clear-query', 'clear-search', 'refresh', 'allow', 'watch', 'seen', 'more', 'less'] as const
const FILTERS = ['all', 'mention', 'dm', 'thread', 'keyword'] as const
const ACTIONS = ['add', 'addthread', 'reply', 'thread', 'copy', 'close'] as const
const DRAFT_ACTIONS = ['send', 'polish', 'edit', 'undo', 'cancel', 'dismiss'] as const

const BADGE: Record<SlackerKind, { glyph: string; color: ThemeKey }> = {
  mention: { glyph: '@ ', color: 'warning' },
  dm: { glyph: 'DM', color: 'suggestion' },
  thread: { glyph: '🧵', color: 'merged' },
  keyword: { glyph: '★ ', color: 'claude' },
  search: { glyph: '⌕ ', color: 'subtle' }
}

const CHIP_LABEL: Record<SlackerFilter, string> = { all: 'All', mention: '@', dm: 'DM', thread: '🧵', keyword: '★' }

const BLANK: FeedRow = { segments: [] }

function oneOf<T extends string>(list: readonly T[], value: string | undefined): T | undefined {
  return list.find(entry => entry === value)
}

/**
 * The key a click, a right-click or a Button names, read back (a Button's without KEY_PREFIX).
 * @example
 * // 'act:reply:C1:1792.1' → { kind: 'action', scope: 'act', action: 'reply', id: 'C1:1792.1' }
 * // 'item:C1:1792.1' → { kind: 'item', id: 'C1:1792.1' }
 */
export function parseSlackerKey(key: string | undefined): SlackerKey | undefined {
  if (key === undefined) return undefined
  const control = oneOf(CONTROLS, key)
  if (control) return { kind: 'control', name: control }
  const [scope = '', action = '', ...rest] = key.split(':')
  if (scope === 'filter') {
    const filter = oneOf(FILTERS, action)

    return filter ? { kind: 'filter', filter } : undefined
  }
  if (scope === 'item' || scope === 'dots') {
    const id = key.slice(scope.length + 1)

    return id === '' ? undefined : { kind: scope, id }
  }
  const id = rest.join(':')
  if (id === '') return undefined
  if (scope === 'act' || scope === 'menu') {
    const known = oneOf(ACTIONS, action)

    return known ? { kind: 'action', scope, action: known, id } : undefined
  }
  if (scope === 'draft') {
    const known = oneOf(DRAFT_ACTIONS, action)

    return known ? { kind: 'draft', action: known, id } : undefined
  }

  return undefined
}

/** A `Client`'s post read back; anything else is undefined. */
export function parseFeedMessage(data: unknown): FeedMessage | undefined {
  if (typeof data !== 'object' || data === null || !('type' in data)) return undefined
  const { type } = data
  if (type === 'click' || type === 'context') {
    const key = 'key' in data && typeof data.key === 'string' ? data.key : undefined

    return { type, ...(key === undefined ? {} : { key }) }
  }
  if ((type === 'query' || type === 'search') && 'query' in data && typeof data.query === 'string') return { type, query: data.query }

  return undefined
}

function seg(text: string, look: FeedLook = {}, key?: string): FeedSegment {
  return { text, ...look, ...(key === undefined ? {} : { key }) }
}

function note(text: string): FeedRow {
  return { segments: [seg(text, { isDim: true })] }
}

function cellsOf(segments: readonly FeedSegment[]): number {
  return segments.reduce((sum, one) => sum + cellWidth(one.text), 0)
}

/** `left`, then `right` pushed to the right edge of `columns`, one space between them at least. */
function spread(left: readonly FeedSegment[], right: readonly FeedSegment[], columns: number): FeedSegment[] {
  return [...left, seg(' '.repeat(Math.max(1, columns - cellsOf(left) - cellsOf(right)))), ...right]
}

/**
 * The row cut to `columns` cells, the first segment that does not fit ending in `…`.
 * @example
 * // ([a 'abc', b 'defgh'], 6) → [a 'abc', b 'de…']
 */
function fitRow(row: FeedRow, columns: number): FeedRow {
  const segments: FeedSegment[] = []
  let used = 0
  for (const one of row.segments) {
    const width = cellWidth(one.text)
    if (used + width <= columns) {
      segments.push(one)
      used += width
      continue
    }
    if (columns - used >= 1) segments.push({ ...one, text: fitEnd(one.text, columns - used) })
    break
  }

  return { ...row, segments }
}

/**
 * Segments packed into as few rows of `columns` as fit, `gap` between them, each row led by `lead`.
 * @example
 * // ([A, B, C] where A and B fit and C does not) → [[lead, A, gap, B], [lead, C]]
 */
function packSegments(segments: readonly FeedSegment[], columns: number, lead = '', gap = '  '): FeedRow[] {
  const rows: FeedRow[] = []
  let row: FeedSegment[] = []
  let used = 0
  for (const one of segments) {
    const width = cellWidth(one.text)
    if (row.length > 0 && used + cellWidth(gap) + width > columns) {
      rows.push({ segments: row })
      row = []
    }
    if (row.length === 0) {
      row = [...(lead === '' ? [] : [seg(lead)]), one]
      used = cellWidth(lead) + width
    } else {
      row.push(seg(gap), one)
      used += cellWidth(gap) + width
    }
  }
  if (row.length > 0) rows.push({ segments: row })

  return rows
}

function wrappedRows(value: string, columns: number, look: FeedLook, maxLines = BODY_LINES): FeedRow[] {
  return wrapText(value, columns - INDENT.length, maxLines).map(line => ({ segments: [seg(INDENT), seg(line, look)] }))
}

/**
 * The key under column `x` of a row: the segment's own key, else the row's.
 * @example
 * // ({ key: 'item:C1:1', segments: ['  Grace ', ⋯ 'dots:C1:1'] }, 7) → 'dots:C1:1'
 */
export function keyAt(row: FeedRow | undefined, x: number): string | undefined {
  if (!row) return undefined
  let start = 0
  for (const one of row.segments) {
    const end = start + cellWidth(one.text)
    if (x >= start && x < end) return one.key ?? row.key
    start = end
  }

  return row.key
}

/**
 * The search box: what is typed (with a caret while it takes the keys), ✕ to clear it, ⟳ while Slack is read.
 * @example
 * // ('abc', true, false, 40) → '🔍 abc▏          ⏎ all Slack  ✕'
 */
export function searchRow(query: string, isTyping: boolean, isBusy: boolean, columns: number): FeedRow {
  const status = isBusy ? [seg(' ⟳', { color: 'claude' })] : []
  const clear = seg('✕', { isDim: true }, 'clear-query')
  let right = status
  if (isTyping) right = [seg(query === '' ? 'type to filter  ' : '⏎ all Slack  ', { isDim: true }), clear, ...status]
  else if (query !== '') right = [clear, ...status]
  const room = Math.max(1, columns - cellsOf(right) - 5)
  let left = [seg('🔍 Search Slack…', { isDim: true })]
  if (isTyping) left = [seg('🔍 '), seg(fitStart(query, room), { isBold: true }), seg('▏', { color: 'suggestion' })]
  else if (query !== '') left = [seg('🔍 '), seg(fitEnd(query, room), { isBold: true })]

  return fitRow({ key: 'search', segments: spread(left, right, columns) }, columns)
}

interface DrawContext {
  columns: number
  /** The `Client` draws the rows: Enter in its search box searches all of Slack. */
  isCanvas: boolean
  now: number
  state: SlackerState
}

/** The chosen chip inverse, an empty one dim. */
function chipLook(isActive: boolean, count: number): FeedLook {
  if (isActive) return { isInverse: true, isBold: true }

  return count === 0 ? { isDim: true } : {}
}

function chipsRow(context: DrawContext): FeedRow {
  const items = context.state.items ?? []
  const counts = filterCounts(items)
  const active = context.state.filter ?? 'all'
  const showKeywords = (context.state.keywords?.length ?? 0) > 0 || counts.keyword > 0
  const chips = FILTERS.filter(filter => filter !== 'keyword' || showKeywords).flatMap((filter, index) => {
    const label = ` ${CHIP_LABEL[filter]} ${counts[filter]} `

    return [...(index > 0 ? [seg(' ')] : []), seg(label, chipLook(filter === active, counts[filter]), `filter:${filter}`)]
  })
  const fresh = items.filter(item => isUnseen(item, context.state.dotsSince)).length
  const segments = fresh > 0 ? spread(chips, [seg(`● ${fresh} new`, { color: 'claude' })], context.columns) : chips

  return { segments }
}

function searchHeader(search: SlackerSearch, columns: number): FeedRow {
  const count = search.items ? [seg(` ${search.items.length}`, { isDim: true })] : []
  const left = [seg('⌕ ', { color: 'suggestion' }), seg(fitEnd(`“${search.query}”`, columns - 16), { isBold: true }), ...count]

  return { segments: spread(left, [seg('✕ Feed', { isDim: true }, 'clear-search')], columns) }
}

/** The open marker, or the unseen dot, after the gutter. */
function leadSegment(item: SlackerItem, context: DrawContext): FeedSegment {
  if (context.state.openId === item.id) return seg('▾ ', { color: 'suggestion' })

  return isUnseen(item, context.state.dotsSince) ? seg('● ', { color: 'claude' }) : seg('  ')
}

/** The gutter, the mark, the badge, the author, then where it was posted and the fold count in `budget` cells. */
function metaSegments(item: SlackerItem, context: DrawContext, budget: number): FeedSegment[] {
  const badge = BADGE[item.kind]
  const count = item.count && item.count > 1 ? ` ×${item.count}` : ''
  const author = fitEnd(item.author, Math.max(6, Math.floor(budget / 2)))
  const whereBudget = budget - cellWidth(author) - cellWidth(count)

  return [
    seg(GUTTER),
    leadSegment(item, context),
    seg(badge.glyph, { color: badge.color, isBold: true }),
    seg(' '),
    seg(author, { isBold: true }),
    ...(whereBudget > 4 ? [seg(`  ${fitEnd(item.where, whereBudget - 2)}`, { isDim: true })] : []),
    ...(count ? [seg(count, { isDim: true })] : [])
  ]
}

function previewOf(item: SlackerItem): string {
  const flat = item.text.replace(/\s+/g, ' ').trim()

  return flat === '' ? '(no text)' : flat
}

/** An item's rows: one at wide widths, else its author row and its text row; its age and `⋯` at the right end. */
function itemRows(item: SlackerItem, context: DrawContext): FeedRow[] {
  const { columns, state } = context
  const age = formatAge(item.ts, context.now)
  const tail = [seg(age, { isDim: true }), seg(' '), seg(DOTS, { isDim: true }, `dots:${item.id}`)]
  const tailCells = cellsOf(tail) + 1
  const textLook: FeedLook = isUnseen(item, state.dotsSince) ? {} : { isDim: true }
  const key = `item:${item.id}`
  if (columns >= WIDE_COLUMNS && state.openId !== item.id) {
    const meta = metaSegments(item, context, Math.floor(columns / 3))
    const room = columns - cellsOf(meta) - tailCells - 2
    const segments = spread([...meta, seg('  '), seg(fitEnd(previewOf(item), room), textLook)], tail, columns)

    return [{ key, isStop: true, segments }]
  }
  const head: FeedRow = { key, isStop: true, segments: spread(metaSegments(item, context, columns - ITEM_LEAD_CELLS - tailCells), tail, columns) }
  if (state.openId === item.id) return [head]

  return [head, { key, segments: [seg(INDENT), seg(fitEnd(previewOf(item), columns - INDENT.length), textLook)] }]
}

function messageRow(message: SlackerMessage, context: DrawContext): FeedRow {
  const age = seg(formatAge(message.ts, context.now), { isDim: true })
  const isMine = message.authorId === context.state.me?.id
  const author = fitEnd(message.author, 14)
  const room = context.columns - INDENT.length - cellWidth(author) - cellWidth(age.text) - 3
  const body = message.text.replace(/\s+/g, ' ').trim() || '(no text)'
  const left = [seg(INDENT), seg(author, isMine ? { isBold: true, color: 'suggestion' } : { isBold: true }), seg(' '), seg(fitEnd(body, room))]

  return { segments: spread(left, [age], context.columns) }
}

function threadRows(item: SlackerItem, thread: SlackerThread, context: DrawContext): FeedRow[] {
  if (thread.isLoading) return [{ segments: [seg(INDENT), seg('Reading the thread…', { isDim: true })] }]
  if (thread.error) return wrappedRows(thread.error, context.columns, { color: 'error' }, ALL_LINES)
  const replies = thread.replies ?? []
  const isConversation = thread.parent === undefined
  const title = isConversation ? '┄ Recent messages ┄' : `┄ Thread · ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'} ┄`
  const parentRow = thread.parent && thread.parent.ts !== item.ts ? [messageRow(thread.parent, context)] : []
  const hidden = Math.max(0, replies.length - SHOWN_REPLIES)
  const earlier: FeedRow[] = hidden > 0 ? [{ segments: [seg(INDENT), seg(`+${hidden} earlier`, { isDim: true })] }] : []
  const shown = replies.slice(-SHOWN_REPLIES).map(reply => messageRow(reply, context))
  const empty: FeedRow[] = replies.length === 0 && parentRow.length === 0 ? [{ segments: [seg(INDENT), seg('No replies yet.', { isDim: true })] }] : []

  return [{ segments: [seg(INDENT), seg(title, { isDim: true })] }, ...parentRow, ...earlier, ...shown, ...empty]
}

/** The reply's inline confirm: Send (once), ✦ Polish, ✎ Edit, ↶ Undo, ✕ Cancel, by its phase. */
function draftActions(draft: SlackerDraft, id: string): FeedSegment[] {
  const cancel = seg('✕ Cancel', { isDim: true }, `draft:cancel:${id}`)
  const edit = seg('✎ Edit', { isDim: true }, `draft:edit:${id}`)
  if (draft.phase === 'polishing') return [seg('✦ Polishing…', { color: 'claude' }), cancel]
  if (draft.phase === 'sending') return [seg('Sending…', { isDim: true })]
  if (draft.phase === 'sent') return [seg('✓ Sent', { color: 'success', isBold: true }), seg('✕', { isDim: true }, `draft:dismiss:${id}`)]
  const sendLabel = draft.phase === 'failed' ? ' ↻ Try again ' : ' Send '
  const send = draft.text.trim() === '' ? [] : [seg(sendLabel, { isInverse: true, color: 'success', isBold: true }, `draft:send:${id}`)]
  const undo = draft.previous !== undefined ? [seg('↶ Undo', { isDim: true }, `draft:undo:${id}`)] : []

  return [...send, seg('✦ Polish', { color: 'claude' }, `draft:polish:${id}`), edit, ...undo, cancel]
}

function draftRows(item: SlackerItem, draft: SlackerDraft, context: DrawContext): FeedRow[] {
  const title: FeedRow = { segments: [seg(INDENT), seg(`┄ ${fitEnd(replyTarget(item).label, context.columns - 10)} ┄`, { isDim: true })] }
  const isBusy = draft.phase === 'polishing' || draft.phase === 'sending'
  const body =
    draft.text.trim() === ''
      ? [{ segments: [seg(INDENT), seg('(empty)', { isDim: true })] }]
      : wrappedRows(draft.text, context.columns, isBusy ? { isDim: true } : {}, DRAFT_LINES)
  const error = draft.error ? wrappedRows(draft.error, context.columns, { color: 'error' }, ALL_LINES) : []

  return [title, ...body, ...error, ...packSegments(draftActions(draft, item.id), context.columns, INDENT)]
}

function actionRows(item: SlackerItem, context: DrawContext): FeedRow[] {
  const isThreadShown = context.state.thread?.itemId === item.id
  const threadLabel = item.isDm && !item.threadTs ? '💬 Chat' : '🧵 Thread'
  const segments = [
    seg(isThreadShown ? '+ Thread to prompt' : '+ Prompt', { color: 'suggestion', isBold: true }, `act:add:${item.id}`),
    seg('↩ Reply', {}, `act:reply:${item.id}`),
    seg(isThreadShown ? `${threadLabel} ▴` : threadLabel, { isDim: true }, `act:thread:${item.id}`),
    seg('🔗 Link', { isDim: true }, `act:copy:${item.id}`),
    seg('✕', { isDim: true }, `act:close:${item.id}`)
  ]

  return packSegments(segments, context.columns, INDENT)
}

function menuRows(item: SlackerItem, context: DrawContext): FeedRow[] {
  const isThreadShown = context.state.thread?.itemId === item.id
  const entries: [SlackerAction, string][] = [
    ['add', '+ Add message to prompt'],
    ['addthread', '+ Add thread to prompt'],
    ['reply', '↩ Reply…'],
    ['thread', isThreadShown ? '🧵 Hide thread' : '🧵 Show thread'],
    ['copy', '🔗 Copy link'],
    ['close', '✕ Close menu']
  ]

  return entries.map(([action, label]) => ({
    key: `menu:${action}:${item.id}`,
    isStop: true,
    segments: [seg(GUTTER), seg('  │ ', { isDim: true }), seg(label)]
  }))
}

/** An item with what is open under it: its menu, then its whole text, thread, and reply or actions. */
function itemBlock(item: SlackerItem, context: DrawContext): FeedRow[] {
  const { state } = context
  const menu = state.menuId === item.id ? menuRows(item, context) : []
  if (state.openId !== item.id) return [...itemRows(item, context), ...menu]
  const body = item.text.trim() === '' ? [{ segments: [seg(INDENT), seg('(no text)', { isDim: true })] }] : wrappedRows(item.text, context.columns, {})
  const thread = state.thread?.itemId === item.id ? threadRows(item, state.thread, context) : []
  const tail = state.draft?.itemId === item.id ? draftRows(item, state.draft, context) : actionRows(item, context)

  return [...itemRows(item, context), ...menu, ...body, ...thread, ...tail]
}

function emptyRows(context: DrawContext): FeedRow[] {
  const { state } = context
  if (state.search) {
    if (state.search.isLoading) return [note('Searching Slack…')]
    if (state.search.error) return wrappedRows(state.search.error, context.columns, { color: 'error' }, ALL_LINES)

    return [note('Slack found nothing for that.')]
  }
  const query = (state.query ?? '').trim()
  if (query !== '') return [note(`No matches for “${fitEnd(query, 20)}”.`), ...(context.isCanvas ? [note('⏎ searches all of Slack.')] : [])]
  if ((state.items?.length ?? 0) > 0) return [note('Nothing under this chip.')]

  return [note(`Nothing for you in the last ${FEED_DAYS} days.`)]
}

function listRows(context: DrawContext): FeedRow[] {
  const items = visibleItems(context.state)
  if (items.length === 0) return emptyRows(context)
  const shown = Math.max(LIST_STEP, context.state.shown ?? LIST_STEP)
  const rows = items.slice(0, shown).flatMap(item => itemBlock(item, context))
  if (items.length > shown) return [...rows, { key: 'more', segments: [seg(`+${items.length - shown} more`, { isDim: true })] }]
  if (shown > LIST_STEP && items.length > LIST_STEP) return [...rows, { key: 'less', segments: [seg('Show less', { isDim: true })] }]

  return rows
}

export function isBusy(state: SlackerState): boolean {
  return state.isLoading === true || state.search?.isLoading === true
}

/**
 * The feed's rows: the search box, the chips (or the search's title), then the list with what is open under its
 * items. Before the first read only the box and a note; the errors and Buttons are drawn under the rows.
 * @example
 * // ({ items: [dm from Grace] }, 48, true) → ['🔍 Search Slack…', ' All 1   @ 0   DM 1   🧵 0 ', '', ' ● DM Grace  … ⋯', '   hi']
 */
export function layoutSlacker(state: SlackerState, columns: number, isCanvas: boolean): FeedRow[] {
  const context: DrawContext = { columns, isCanvas, now: state.updatedAt ?? 0, state }
  const search = searchRow(state.query ?? '', false, isBusy(state), columns)
  if (state.items === undefined && !state.search) {
    if ((state.errors ?? []).length > 0) return [search]

    return [search, BLANK, fitRow(note(state.isLoading ? 'Reading your Slack…' : 'Not read yet.'), columns)]
  }
  const header = state.search ? searchHeader(state.search, columns) : chipsRow(context)

  return [search, header, BLANK, ...listRows(context)].map(row => fitRow(row, columns))
}

/** The `Client`'s props: the rows, cut short (with a way back) before they pass what the engine takes. */
export function buildFeedProps(state: SlackerState, columns: number): FeedProps {
  const rows: FeedRow[] = []
  let size = 0
  for (const row of layoutSlacker(state, columns, true)) {
    size += JSON.stringify(row).length
    if (size > MAX_PROPS_CHARS) {
      rows.push({ key: 'less', segments: [seg('Too much to draw here: show less', { isDim: true })] })
      break
    }
    rows.push(row)
  }

  return { rows, columns, query: state.query ?? '', isBusy: isBusy(state) }
}
