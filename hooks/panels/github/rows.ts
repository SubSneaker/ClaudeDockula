// The list's view-model, pure: row labels, the lines under a row, the row menu and the list Client's props.
import type { ThemeKey } from 'claude-code'

import type { GhCheck, GhCheckState, GhCiState, GhDetail, GhItem, GhReviewState, GhScope, GhView, GithubState } from '../../../types'
import { TONE, cellWidth, fitEnd, padCells } from '../../dock/ui'
import { DEFAULT_SHOWN, isSessionRepo, type GhAction } from './model'
import { drawable } from './parse'

/** Cells the list Client adds around a row's label: the cursor before it and ` ⋯` after it. */
export const ROW_CHROME_CELLS = 3
/** Where the lines under a row start: under its `#`. */
export const DETAIL_INDENT = 4
/** The label column of an opened row's lines: `CI`, `Review`, `Jira`. */
export const DETAIL_LABEL_CELLS = 8

const AGE_CELLS = 3
const MAX_FAILED_SHOWN = 3
const MAX_WHY_LINES = 2
const DRAFT_TONE: ThemeKey = 'inactive'

export const CI_GLYPH: Record<GhCiState, string> = { pass: '✅', fail: '❌', pending: '🟡', none: '⚪' }
export const REVIEW_GLYPH: Record<GhReviewState, string> = { approved: '👍', changes: '✋', required: '👀', none: '' }
const CHECK_GLYPH: Record<GhCheckState, string> = { pass: '✅', fail: '❌', pending: '🟡', skipped: '⚪', cancelled: '⛔' }
export const ISSUE_GLYPH = '📌'
const REVIEW_TEXT: Record<GhReviewState, string> = {
  approved: '👍 Approved',
  changes: '✋ Changes requested',
  required: '👀 Review required',
  none: 'No review yet'
}
const REVIEW_TONE: Partial<Record<GhReviewState, ThemeKey>> = { approved: TONE.pass, changes: TONE.fail }

export interface ListRow {
  id: string
  item: GhItem
  /** Fitted to columns. */
  label: string
  tone?: ThemeKey
  isOpen: boolean
}

/** One line under a row. With `label` it is a field of the opened row (`CI      ❌ Lint`); `''` continues the one above. */
export interface DetailLine {
  text: string
  tone?: ThemeKey
  isDim?: boolean
  label?: string
}

export interface MenuEntry {
  action: GhAction
  label: string
}

/** The tab shown: To review until another is picked. */
export function viewOf(state: GithubState): GhView {
  return state.ui?.view ?? 'review'
}

/** The latest time the state knows (the clock's tick or the last poll): what ages are measured against while drawing. */
export function nowOf(state: GithubState): number {
  return Math.max(state.now ?? 0, state.updatedAt ?? 0)
}

/** All when the person chose it, or when this folder is no GitHub repo and none was added. */
export function scopeOf(state: GithubState): GhScope {
  if (state.settings?.scope === 'all') return 'all'

  return state.currentRepo === null && (state.settings?.extraRepos?.length ?? 0) === 0 ? 'all' : 'repos'
}

/** An item of any list (the search's too) by its id. */
export function findItem(state: GithubState, id: string): GhItem | undefined {
  const lists = [state.review, state.mine, state.issues, state.search?.items]

  return lists.flatMap(list => list ?? []).find(item => item.id === id)
}

/** A background review still going: another cannot start for that PR. */
export function isReviewRunning(state: GithubState, id: string): boolean {
  const phase = state.reviews?.[id]?.phase

  return phase === 'queued' || phase === 'running'
}

/** How long ago `at` (ms) was: `5m`, `3h`, `2d`, `6w`, `2y`; `''` with no clock yet. */
export function ageSince(at: number, now: number): string {
  if (!Number.isFinite(at) || now <= 0) return ''
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)

  return weeks < 52 ? `${weeks}w` : `${Math.floor(days / 365)}y`
}

/** 5m, 3h, 2d, 6w. */
export function ageOf(iso: string, now: number): string {
  return ageSince(Date.parse(iso), now)
}

function leadGlyph(item: GhItem): string {
  return item.kind === 'issue' ? ISSUE_GLYPH : CI_GLYPH[item.ci ?? 'none']
}

/**
 * A row's head line: CI dot, number, title cut to fit, then the review glyph and the age in fixed columns.
 * `extras.jira` and `extras.oneLiner` go on the lines under it, not here.
 * @example
 * // before: { ci: 'pass', number: 2086, title: 'Add CSV export option for reports', review: 'required' }, 40 columns
 * // after:  '✅ #2086 Add CSV export option on label es…  👀  2d'
 */
export function rowLabel(item: GhItem, extras: { jira?: string; oneLiner?: string; now: number }, columns: number): string {
  const lead = `${leadGlyph(item)} #${item.number} `
  const glyph = item.kind === 'pr' ? REVIEW_GLYPH[item.review ?? 'none'] : ''
  const tail = `${glyph === '' ? '  ' : glyph} ${ageOf(item.updatedAt, extras.now).padStart(AGE_CELLS)}`
  const room = columns - cellWidth(lead) - cellWidth(tail) - 2
  const title = drawable(item.title)
  if (room < 6) return padCells(`${lead}${title}`, Math.max(1, columns))

  return `${lead}${padCells(title, room)}  ${tail}`
}

/** `grace · 💬 1 · 🎫 In Review · team · draft`, the author left out on the person's own rows. */
function metaLine(item: GhItem, jira: string | undefined, login: string | undefined): string {
  const parts = [
    item.author !== login ? item.author : '',
    item.comments > 0 ? `💬 ${item.comments}` : '',
    item.ticket ? `🎫 ${jira ?? item.ticket}` : '',
    item.isTeamRequest ? 'team' : '',
    item.isDraft ? 'draft' : ''
  ]

  return drawable(parts.filter(part => part !== '').join(' · '))
}

/** Every text a row draws goes through `drawable` here, whichever list or surface draws it. */
function field(label: string, text: string, room: number, look: { tone?: ThemeKey | undefined; isDim?: boolean } = {}): DetailLine {
  return {
    label,
    text: fitEnd(drawable(text), room),
    ...(look.tone === undefined ? {} : { tone: look.tone }),
    ...(look.isDim ? { isDim: true } : {})
  }
}

/** A failed job's lines: its name, then why (Haiku's line, the log being read, the excerpt, or GitHub's description). */
function failedCheckLines(check: GhCheck, room: number): DetailLine[] {
  const lines = [field('', `${CHECK_GLYPH.fail} ${check.name}`, room, { tone: TONE.fail })]
  if (check.whyLine) lines.push(field('', `💡 ${check.whyLine}`, room))
  if (check.isLogLoading) lines.push(field('', 'Reading the log…', room, { isDim: true }))
  const why = check.why ?? []
  why.slice(0, MAX_WHY_LINES).forEach(line => lines.push(field('', line, room, { isDim: true })))
  if (why.length === 0 && !check.isLogLoading && check.description) lines.push(field('', check.description, room, { isDim: true }))

  return lines
}

/**
 * The CI lines of an opened PR: failed jobs one by one with why, then the running ones, then counts.
 * @example
 * // before: [{ name: 'Lint', state: 'fail', why: ['src/a.ts(3,1): TS2322'] }, { name: 'Test', state: 'pass' }, { name: 'Unit', state: 'pass' }]
 * // after:  ['CI  ❌ Lint', '    src/a.ts(3,1): TS2322', '    ✅ 2 passed']
 */
function ciLines(detail: GhDetail | undefined, room: number): DetailLine[] {
  if (!detail?.checks) {
    const text = detail?.error ? `Couldn't load the checks: ${detail.error}` : 'Loading the checks…'

    return [field('CI', text, room, { isDim: true })]
  }
  const { checks } = detail
  if (checks.length === 0) return [field('CI', 'No checks', room, { isDim: true })]
  const failed = checks.filter(check => check.state === 'fail')
  const pending = checks.filter(check => check.state === 'pending')
  const passed = checks.filter(check => check.state === 'pass').length
  const others = checks.length - failed.length - pending.length - passed
  const lines = failed.slice(0, MAX_FAILED_SHOWN).flatMap(check => failedCheckLines(check, room))
  if (failed.length > MAX_FAILED_SHOWN) lines.push(field('', `+${failed.length - MAX_FAILED_SHOWN} more failed`, room, { isDim: true }))
  if (pending.length > 0) lines.push(field('', `${CHECK_GLYPH.pending} ${pending.map(check => check.name).join(', ')}`, room, { tone: TONE.run }))
  if (passed > 0) lines.push(field('', `${CHECK_GLYPH.pass} ${passed} passed`, room))
  if (others > 0) lines.push(field('', `${CHECK_GLYPH.skipped} ${others} skipped`, room, { isDim: true }))
  const [first, ...rest] = lines

  return first ? [{ ...first, label: 'CI' }, ...rest] : []
}

/** What an opened row shows: CI (PRs), review, branch, Jira, labels, and the body's start when no one-liner says it. */
export function detailLines(item: GhItem, state: GithubState, columns: number): DetailLine[] {
  const room = Math.max(1, columns - DETAIL_LABEL_CELLS)
  const lines: DetailLine[] = []
  if (item.kind === 'pr') {
    const review = item.review ?? 'none'
    lines.push(...ciLines(state.details?.[item.id], room))
    lines.push(field('Review', `${REVIEW_TEXT[review]}${item.isTeamRequest ? ' · asked of a team' : ''}`, room, { tone: REVIEW_TONE[review] }))
    if (item.headRef) lines.push(field('Branch', item.baseRef ? `${item.headRef} → ${item.baseRef}` : item.headRef, room))
  }
  if (item.ticket) {
    const status = state.jiraStatus?.[item.ticket]
    lines.push(field('Jira', status ? `${item.ticket} · ${status}` : item.ticket, room))
  }
  if (item.labels && item.labels.length > 0) lines.push(field('Labels', item.labels.join(', '), room))
  if (!state.oneLiners?.[item.id] && item.excerpt) lines.push(field('About', item.excerpt.replace(/\s+/g, ' ').trim(), room, { isDim: true }))

  return lines
}

/** The lines under a row: who and what (dim), Haiku's one-liner, and when opened its details then a blank line. */
function rowDetails(item: GhItem, state: GithubState, columns: number, isOpen: boolean): DetailLine[] {
  const room = Math.max(1, columns)
  const meta = metaLine(item, item.ticket ? state.jiraStatus?.[item.ticket] : undefined, state.login)
  const oneLiner = state.oneLiners?.[item.id]
  const lines: DetailLine[] = []
  if (meta !== '') lines.push({ text: fitEnd(meta, room), isDim: true })
  if (oneLiner) lines.push({ text: fitEnd(drawable(oneLiner), room), isDim: true })
  if (isOpen) lines.push(...detailLines(item, state, room), { text: '' })

  return lines
}

interface MenuContext {
  login?: string
  currentRepo?: string
  hasReviewJob: boolean
}

interface MenuCandidate extends MenuEntry {
  isOffered: (item: GhItem, ctx: MenuContext) => boolean
}

const always = (): boolean => true
const isPr = (item: GhItem): boolean => item.kind === 'pr'

/** Every row action in menu order, with when a row offers it. */
const MENU: readonly MenuCandidate[] = [
  { action: 'review-here', label: '🧐 Review here', isOffered: isPr },
  { action: 'review-bg', label: '🤖 Review in background', isOffered: (item, ctx) => isPr(item) && !ctx.hasReviewJob },
  { action: 'fix-ci', label: '🔧 Fix failing CI', isOffered: item => isPr(item) && item.ci === 'fail' },
  {
    action: 'address',
    label: '💬 Address review comments',
    isOffered: (item, ctx) => isPr(item) && ctx.login !== undefined && item.author === ctx.login
  },
  { action: 'add-link', label: '➕ Add link to prompt', isOffered: always },
  { action: 'add-full', label: '➕ Add full thread to prompt', isOffered: always },
  { action: 'copy-link', label: '📋 Copy link', isOffered: always },
  { action: 'copy-body', label: '📋 Copy title + body', isOffered: always },
  { action: 'copy-thread', label: '📋 Copy full thread', isOffered: always },
  { action: 'copy-diff', label: '📋 Copy diff', isOffered: isPr },
  { action: 'open', label: '🌐 Open in browser', isOffered: always },
  { action: 'open-ticket', label: '🎫 Open ticket', isOffered: item => item.ticket !== undefined },
  // `gh pr checkout N` runs in this folder: for another repo's PR it would check out this repo's PR N.
  { action: 'checkout', label: '🌿 Check out', isOffered: (item, ctx) => isPr(item) && isSessionRepo(item.repo, ctx.currentRepo) }
]

/**
 * A row's actions: PRs get the review and CI ones; fix-ci only on failing CI, address only on the person's own,
 * checkout only in the session's repo, the Jira ticket only when the title or branch names one (`🎫 Open ABC-123`).
 */
export function menuFor(item: GhItem, ctx: { login?: string; currentRepo?: string; hasReviewJob: boolean }): MenuEntry[] {
  return MENU.filter(entry => entry.isOffered(item, ctx)).map(({ action, label }) => ({
    action,
    label: action === 'open-ticket' && item.ticket ? `🎫 Open ${item.ticket}` : label
  }))
}

/** The items of `ui.view`. */
export function listItemsOf(state: GithubState): GhItem[] {
  switch (viewOf(state)) {
    case 'mine':
      return state.mine ?? []
    case 'issues':
      return state.issues ?? []
    case 'search':
      return state.search?.items ?? []
    default:
      return state.review ?? []
  }
}

export interface ListProps {
  rows: { id: string; label: string; tone?: ThemeKey; details: DetailLine[]; menu: MenuEntry[] }[]
  openId?: string
  columns: number
  hidden: number
}

/**
 * The list Client's props (plain data, no key left undefined): the first `ui.shown` items of the view as rows
 * fitted to `columns`, the opened one carrying its details.
 * @example
 * // before: { review: [#2086, #2071], ui: { openId: 'o/r#2086' } }, 56
 * // after:  { rows: [{ id: 'o/r#2086', label: '✅ #2086 …  👀  2d', details: [meta, CI…, Review…], menu }, …], openId: 'o/r#2086', columns: 56, hidden: 0 }
 */
export function buildListProps(state: GithubState, columns: number): ListProps {
  const items = listItemsOf(state)
  const shown = items.slice(0, Math.max(1, state.ui?.shown ?? DEFAULT_SHOWN))
  const openId = shown.some(item => item.id === state.ui?.openId) ? state.ui?.openId : undefined
  const now = nowOf(state)
  const login = state.login
  const currentRepo = state.currentRepo?.nameWithOwner
  const rows = shown.map(item => ({
    id: item.id,
    label: rowLabel(item, { now }, columns - ROW_CHROME_CELLS),
    ...(item.isDraft ? { tone: DRAFT_TONE } : {}),
    details: rowDetails(item, state, columns - DETAIL_INDENT, item.id === openId),
    menu: menuFor(item, {
      ...(login === undefined ? {} : { login }),
      ...(currentRepo === undefined ? {} : { currentRepo }),
      hasReviewJob: isReviewRunning(state, item.id)
    })
  }))

  return { rows, ...(openId === undefined ? {} : { openId }), columns, hidden: items.length - shown.length }
}
