import type { GhCiState, GhItem, GhReviewState, GitgudState, JiraState } from '../../../types'
import { findTicketKey } from '../../settings'
import { CI_GLYPH, REVIEW_GLYPH } from './rows'

/** Title first, then the branch. */
export function ticketOfItem(title: string, headRef: string | undefined, pattern?: string): string | undefined {
  return findTicketKey(title, pattern) ?? (headRef === undefined ? undefined : findTicketKey(headRef, pattern))
}

/** Status by key from the Jira panel's state (assigned tickets + the branch issue). */
export function jiraStatusesFromState(jira: JiraState): Record<string, string> {
  const statuses: Record<string, string> = {}
  for (const ticket of jira.tickets ?? []) {
    if (ticket.status) statuses[ticket.key] = ticket.status
  }
  if (jira.issue?.status) statuses[jira.issue.key] = jira.issue.status

  return statuses
}

/** The ticket keys of `items` that have no status yet, each once, at most `limit`. */
export function missingTicketKeys(items: readonly GhItem[], known: Readonly<Record<string, string>>, limit: number): string[] {
  const keys = new Set<string>()
  for (const item of items) {
    if (item.ticket !== undefined && known[item.ticket] === undefined) keys.add(item.ticket)
  }

  return [...keys].slice(0, limit)
}

export interface PrBadge {
  number: number
  url: string
  ci: GhCiState
  review: GhReviewState
  isDraft?: boolean
  isMine: boolean
  /** How many PRs carry the key. */
  count: number
}

/**
 * One badge per ticket key: my PR beats a review request, else the first listed; `count` is how many PRs carry the key.
 * @example
 * // before: mine [#12 ABC-1], review [#9 ABC-1, #7 ABC-2]
 * // after:  { 'ABC-1': { number: 12, isMine: true, count: 2, … }, 'ABC-2': { number: 7, isMine: false, count: 1, … } }
 */
export function prBadgesByKey(state: GitgudState): Record<string, PrBadge> {
  const badges: Record<string, PrBadge> = {}
  const seen = new Set<string>()
  const lists = [
    { items: state.mine ?? [], isMine: true },
    { items: state.review ?? [], isMine: false }
  ]
  for (const { items, isMine } of lists) {
    for (const item of items) {
      if (item.kind !== 'pr' || item.ticket === undefined || seen.has(item.id)) continue
      seen.add(item.id)
      const existing = badges[item.ticket]
      const badge: PrBadge = {
        number: item.number,
        url: item.url,
        ci: item.ci ?? 'none',
        review: item.review ?? 'none',
        ...(item.isDraft ? { isDraft: true } : {}),
        isMine,
        count: 1
      }
      if (existing === undefined) badges[item.ticket] = badge
      else badges[item.ticket] = { ...(isMine && !existing.isMine ? badge : existing), count: existing.count + 1 }
    }
  }

  return badges
}

/** `#2086 ✅ 👍` / `#2086 ❌ ✋ +1`; a draft adds 📝. */
export function prBadgeLabel(badge: PrBadge): string {
  const parts = [`#${badge.number}`, badge.isDraft ? '📝' : '', CI_GLYPH[badge.ci], REVIEW_GLYPH[badge.review], badge.count > 1 ? `+${badge.count - 1}` : '']

  return parts.filter(part => part !== '').join(' ')
}
