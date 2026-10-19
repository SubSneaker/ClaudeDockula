import type { ThemeKey } from 'claude-code'

import type { DockNotice, DockNoticeAction, NoticeTone } from '../../types'
import { drawable } from '../panels/gitgud/parse'
import { cellWidth, fitEnd, padCells, TONE } from './ui'

// Notices replace toasts: each file that tells the person something writes the literal ref
// `{ plugin: 'claudedockula', key: 'notices' }` with `pushNotice`; the dock draws them and clears them.

/** How long an info or success notice stays; an error stays until dismissed. */
export const NOTICE_TTL_MS = 8000
/** How often the dock's one notice timer clears the notices whose time has passed. */
export const NOTICE_SWEEP_MS = 2000
/** Rows the band shows at most; the rest are counted in a `+N more` row. */
export const VISIBLE_NOTICES = 3
const MAX_NOTICES = 20
/** Cells a notice row keeps at its right end: `  ▸` before the ✕ and the gap to it. */
const ROW_TAIL_CELLS = 6

export const NO_NOTICES: DockNotice[] = []

/** A notice as its writer gives it: `at` is the clock's now, which an info or success notice expires from. */
export interface NewNotice {
  tone: NoticeTone
  title: string
  detail?: string
  /** What the notice is about (`check-types`): a newer notice on it replaces the older. */
  topic?: string
  /** Stays until dismissed instead of expiring. */
  stays?: true
  /** A Button on the row; the writer's `ui.press` hook answers its key. */
  action?: DockNoticeAction
  at: number
}

const TONE_ICON: Record<NoticeTone, string> = { error: '⚠', info: 'ℹ', success: '✓' }
const TONE_COLOR: Partial<Record<NoticeTone, ThemeKey>> = { error: TONE.fail, success: TONE.pass }

/**
 * The list with `notice` on top, newest first: one on the same topic, or identical, is replaced instead of doubled.
 * Its id counts on from the clock, so a dismissed notice's id never comes back for a newer one that its ✕ could hit.
 * @example
 * // before: [{ id: 1, tone: 'error', title: 'A' }], { tone: 'info', title: 'B', at: 100 }
 * // after:  [{ id: 101, tone: 'info', title: 'B', expiresAt: 8100 }, { id: 1, tone: 'error', title: 'A' }]
 */
export function pushNotice(list: readonly DockNotice[], notice: NewNotice): DockNotice[] {
  const isSame = (one: DockNotice) =>
    (notice.topic !== undefined && one.topic === notice.topic) ||
    (one.tone === notice.tone && one.title === notice.title && one.detail === notice.detail)
  const id = Math.max(0, notice.at, ...list.map(one => one.id)) + 1
  const added: DockNotice = {
    id,
    tone: notice.tone,
    title: notice.title,
    ...(notice.detail ? { detail: notice.detail } : {}),
    ...(notice.topic ? { topic: notice.topic } : {}),
    ...(notice.action ? { action: notice.action } : {}),
    ...(notice.tone === 'error' || notice.stays ? {} : { expiresAt: notice.at + NOTICE_TTL_MS })
  }

  return [added, ...list.filter(one => !isSame(one))].slice(0, MAX_NOTICES)
}

/** The list without the notices on these topics: a summary that says what they said replaces them. */
export function dropTopics(list: readonly DockNotice[], topics: readonly string[]): DockNotice[] {
  return list.filter(one => one.topic === undefined || !topics.includes(one.topic))
}

/** The list without the notices whose time has passed; the same list when none has. */
export function expireNotices(list: DockNotice[], now: number): DockNotice[] {
  const kept = list.filter(one => one.expiresAt === undefined || one.expiresAt > now)

  return kept.length === list.length ? list : kept
}

export function dismissNotice(list: readonly DockNotice[], id: number): DockNotice[] {
  return list.filter(one => one.id !== id)
}

/** Opens or closes a notice; one opened stays until dismissed, so it never vanishes while read. */
export function toggleNotice(list: readonly DockNotice[], id: number): DockNotice[] {
  return list.map(one => {
    if (one.id !== id) return one
    const { expiresAt: _expiresAt, ...kept } = one

    return { ...kept, isExpanded: !one.isExpanded }
  })
}

/** A notice as one band row: its icon and colour, the title cut to the row, and what a click opens. */
export interface NoticeRow {
  id: number
  label: string
  color?: ThemeKey
  isExpanded: boolean
  /** Whether a click has anything to open: the row cut its title, or the notice has a detail. */
  hasMore: boolean
  /** The text the open row shows under it, one entry per line: the whole title when the row cut it, then the detail. */
  lines: string[]
  /** A Button drawn before ✕. */
  action?: DockNoticeAction
}

/**
 * The rows the band draws: the newest few, each cut to `columns` with `▸` (`▾` open) at its end
 * when it has more to show, and how many more are left out.
 * @example
 * // before: [{ id: 2, tone: 'error', title: "Couldn't move ABC-101 → IN REVIEW", detail: 'atlassian: denied' }], 40
 * // after:  { rows: [{ id: 2, label: "⚠ Couldn't move ABC-101 → IN REVIEW   ▸", lines: ['atlassian: denied'], … }], hidden: 0 }
 */
export function noticeRows(list: readonly DockNotice[], columns: number): { rows: NoticeRow[]; hidden: number } {
  const rows = list.slice(0, VISIBLE_NOTICES).map((notice): NoticeRow => {
    const action = notice.action === undefined ? undefined : { key: notice.action.key, label: drawable(notice.action.label) }
    const room = Math.max(1, columns - ROW_TAIL_CELLS - (action === undefined ? 0 : cellWidth(action.label) + 2))
    const head = drawable(`${TONE_ICON[notice.tone]} ${notice.title}`)
    const detail = (notice.detail ?? '').split('\n').filter(line => line.trim() !== '')
    const lines = [...(cellWidth(head) > room ? [notice.title] : []), ...detail].map(drawable)
    const isExpanded = notice.isExpanded === true
    const color = TONE_COLOR[notice.tone]

    const hasMore = lines.length > 0

    return {
      id: notice.id,
      label: `${padCells(fitEnd(head, room), room)}  ${arrowOf(hasMore, isExpanded)}`,
      ...(color ? { color } : {}),
      isExpanded,
      hasMore,
      lines: isExpanded ? lines : [],
      ...(action ? { action } : {})
    }
  })

  return { rows, hidden: Math.max(0, list.length - VISIBLE_NOTICES) }
}

/** Cells an opened notice's lines are indented by. */
export const NOTICE_LINE_INDENT = 2

/**
 * How many band rows the notices take as drawn at `columns`: a row each, the wrapped lines of the opened ones,
 * and the `+N more` row.
 */
export function noticeRowCount(list: readonly DockNotice[], columns: number): number {
  const { rows, hidden } = noticeRows(list, columns)
  const room = Math.max(1, columns - NOTICE_LINE_INDENT)
  const lines = rows.flatMap(row => row.lines).reduce((sum, line) => sum + Math.max(1, Math.ceil(cellWidth(line) / room)), 0)

  return rows.length + lines + (hidden > 0 ? 1 : 0)
}

function arrowOf(hasMore: boolean, isExpanded: boolean): string {
  if (!hasMore) return ' '

  return isExpanded ? '▾' : '▸'
}
