import type { GhItem, GhOverlap, GhScope, NoticeTone } from '../../../types'

const TOPIC = 'gitgud'
const MAX_AGE_MS = 30 * 24 * 3600 * 1000
const MAX_IDS = 2000
const TITLE_CUT = 40
/** A seen id's time is moved on once it is this old, so an alert still showing up is never pruned and raised again. */
const REFRESH_MS = 24 * 3600 * 1000
const ALL = 'all'
const REPO_ENTRY = 'repo:'
const SCOPE_ENTRY = 'repos:'

/** `seeded`: what has been followed already, `all` or `repo:<owner/name>` (older ledgers: whole scope signatures); `ids`: alert id → ms. */
export interface AlertLedger {
  seeded: string[]
  ids: Record<string, number>
}

export interface AlertCandidate {
  id: string
  tone: NoticeTone
  title: string
  detail?: string
  topic: string
  /** `owner/name`: the alert stays silent on the first poll that follows its repo. */
  repo?: string
}

function shortTitle(title: string): string {
  return title.length > TITLE_CUT ? `${title.slice(0, TITLE_CUT - 1).trimEnd()}…` : title
}

/**
 * Stable ids: `rr:<itemId>`, `ci:<itemId>:<headSha>`, and for reviews `ap:<itemId>:<approvalId>` /
 * `cr:<itemId>:<changeRequestId>`, each keyed on the latest review of its own kind: a push, or another reviewer's
 * approval while changes are still requested, leaves them as they were; a new review of that kind raises them again.
 */
export function deriveListAlerts(lists: { review: GhItem[]; mine: GhItem[] }): AlertCandidate[] {
  const alerts: AlertCandidate[] = []
  for (const item of lists.review) {
    if (item.kind !== 'pr') continue
    alerts.push({
      id: `rr:${item.id}`,
      tone: 'info',
      title: `👀 Review requested: #${item.number} ${shortTitle(item.title)}`,
      detail: `${item.author} in ${item.repo}`,
      topic: TOPIC,
      repo: item.repo
    })
  }
  for (const item of lists.mine) {
    if (item.kind !== 'pr') continue
    const sha = item.headSha ?? ''
    const base = { detail: item.repo, topic: TOPIC, repo: item.repo }
    if (item.ci === 'fail') {
      alerts.push({ id: `ci:${item.id}:${sha}`, tone: 'error', title: `❌ CI failed on #${item.number}`, ...base })
    }
    if (item.review === 'approved') {
      alerts.push({ id: `ap:${item.id}:${item.approvalId ?? ''}`, tone: 'success', title: `👍 #${item.number} approved`, ...base })
    }
    if (item.review === 'changes') {
      alerts.push({ id: `cr:${item.id}:${item.changeRequestId ?? ''}`, tone: 'error', title: `✋ Changes requested on #${item.number}`, ...base })
    }
  }

  return alerts
}

function djb2(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index++) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0

  return (hash >>> 0).toString(36)
}

/** `ov:<prId>:<files joined by \0, hashed (djb2)>`: the same PR over the same files alerts once. */
export function deriveOverlapAlerts(overlaps: readonly GhOverlap[]): AlertCandidate[] {
  return overlaps.map(overlap => ({
    id: `ov:${overlap.prId}:${djb2(overlap.files.join('\0'))}`,
    tone: 'info',
    title: `⚠ #${overlap.number} (${overlap.author}) touches ${overlap.files.length} file${overlap.files.length === 1 ? '' : 's'} you changed`,
    detail: overlap.title,
    topic: TOPIC,
    repo: overlap.repo
  }))
}

/**
 * @example
 * // before: 'all' / ('repos', ['b/y', 'a/x'])
 * // after:  'all' / 'repos:a/x,b/y'
 */
export function scopeSignature(scope: GhScope, repos: readonly string[]): string {
  return scope === 'all' ? 'all' : `repos:${[...repos].sort().join(',')}`
}

/** `repos:a/x,b/y` → ['a/x', 'b/y'] (lower case); `all` → []. */
function reposOfScope(scopeSig: string): string[] {
  if (!scopeSig.startsWith(SCOPE_ENTRY)) return []

  return scopeSig
    .slice(SCOPE_ENTRY.length)
    .split(',')
    .filter(repo => repo !== '')
    .map(repo => repo.toLowerCase())
}

/** What the ledger has followed already: every repo, or these. */
function coverageOf(seeded: readonly string[]): { isAll: boolean; repos: Set<string> } {
  const repos = new Set<string>()
  for (const entry of seeded) {
    if (entry.startsWith(REPO_ENTRY)) repos.add(entry.slice(REPO_ENTRY.length).toLowerCase())
    else reposOfScope(entry).forEach(repo => repos.add(repo))
  }

  return { isAll: seeded.includes(ALL), repos }
}

/**
 * Seeds per repo: a candidate is recorded silently only while its repo is followed for the first time (all of them the
 * first time `all` is), so adding a repo or switching This/All never swallows news from repos already followed.
 * A seen id's time moves on once a day while it keeps showing up.
 */
export function takeNewAlerts(
  ledger: AlertLedger,
  candidates: readonly AlertCandidate[],
  scopeSig: string,
  now: number
): { ledger: AlertLedger; fresh: AlertCandidate[]; isChanged: boolean } {
  const before = coverageOf(ledger.seeded)
  const scopeRepos = reposOfScope(scopeSig)
  const isScopeKnown =
    before.isAll || ledger.seeded.includes(scopeSig) || (scopeRepos.length > 0 && scopeRepos.every(repo => before.repos.has(repo)))
  const isKnown = (candidate: AlertCandidate): boolean => {
    const repo = candidate.repo?.toLowerCase()
    if (repo === undefined || (scopeSig !== ALL && !scopeRepos.includes(repo))) return isScopeKnown

    return before.isAll || before.repos.has(repo)
  }
  const ids = { ...ledger.ids }
  const fresh: AlertCandidate[] = []
  let isChanged = false
  for (const candidate of candidates) {
    const seenAt = ids[candidate.id]
    if (seenAt !== undefined) {
      if (now - seenAt > REFRESH_MS) {
        ids[candidate.id] = now
        isChanged = true
      }
      continue
    }
    ids[candidate.id] = now
    isChanged = true
    if (isKnown(candidate)) fresh.push(candidate)
  }
  const added = scopeSig === ALL ? [ALL] : scopeRepos.map(repo => `${REPO_ENTRY}${repo}`)
  const seeded = [...ledger.seeded, ...added.filter(entry => !ledger.seeded.includes(entry))]

  return { ledger: { seeded, ids }, fresh, isChanged: isChanged || seeded.length !== ledger.seeded.length }
}

/** Reads what the store gave back; anything unusable is an empty ledger. */
export function parseLedger(raw: unknown): AlertLedger {
  if (typeof raw !== 'object' || raw === null) return { seeded: [], ids: {} }
  const seeded = 'seeded' in raw && Array.isArray(raw.seeded) ? raw.seeded.filter((sig): sig is string => typeof sig === 'string') : []
  const ids: Record<string, number> = {}
  if ('ids' in raw && typeof raw.ids === 'object' && raw.ids !== null) {
    for (const [id, at] of Object.entries(raw.ids)) {
      if (typeof at === 'number' && Number.isFinite(at)) ids[id] = at
    }
  }

  return { seeded, ids }
}

/** Drops ids older than 30 days and keeps at most 2000 (the newest). */
export function pruneLedger(ledger: AlertLedger, now: number): AlertLedger {
  const kept = Object.entries(ledger.ids)
    .filter(([, at]) => now - at <= MAX_AGE_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_IDS)

  return { seeded: ledger.seeded, ids: Object.fromEntries(kept) }
}
