import { MAX_BACKOFF_MS, POLL_HIDDEN_MS, POLL_SHOWN_MS } from './model'

const MIN_POLL_MS = 30_000
const MAX_POLL_MS = 900_000
const RATE_FLOOR = 100
const RATE_SLACK_MS = 5_000
const MAX_DOUBLINGS = 10

export interface PollFacts {
  isShown: boolean
  failures: number
  pollSeconds?: number
  rateRemaining?: number
  rateResetAt?: string
  now: number
}

/**
 * Shown: pollSeconds·1000 (default POLL_SHOWN_MS, held 30 s…15 min); hidden: max(POLL_HIDDEN_MS, 3×shown).
 * Failures double it up to MAX_BACKOFF_MS. rateRemaining < 100 → until resetAt (+5 s).
 */
export function nextPollDelay(facts: PollFacts): number {
  const asked = facts.pollSeconds !== undefined && facts.pollSeconds > 0 ? facts.pollSeconds * 1000 : POLL_SHOWN_MS
  const shown = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, asked))
  const base = facts.isShown ? shown : Math.max(POLL_HIDDEN_MS, 3 * shown)
  const doublings = Math.min(Math.max(0, facts.failures), MAX_DOUBLINGS)
  const delay = doublings === 0 ? base : Math.min(base * 2 ** doublings, Math.max(base, MAX_BACKOFF_MS))

  const resetAt = facts.rateResetAt === undefined ? Number.NaN : Date.parse(facts.rateResetAt)
  if (facts.rateRemaining !== undefined && facts.rateRemaining < RATE_FLOOR && !Number.isNaN(resetAt)) {
    return Math.max(delay, resetAt + RATE_SLACK_MS - facts.now)
  }

  return delay
}

export function isPollDue(lastAt: number | undefined, delay: number, now: number): boolean {
  return lastAt === undefined || now - lastAt >= delay
}
