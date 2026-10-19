import { expect, test } from 'claude-code/testing'

import type { GhItem, GitgudState } from '../types'
import { type AlertLedger, deriveListAlerts, deriveOverlapAlerts, parseLedger, pruneLedger, scopeSignature, takeNewAlerts } from '../hooks/panels/gitgud/alerts'
import { prBadgeLabel, prBadgesByKey, ticketOfItem } from '../hooks/panels/gitgud/jiraLink'
import { cleanLogLines, excerptFailedLog } from '../hooks/panels/gitgud/logs'
import { computeOverlaps, parseNameStatusZ, parsePorcelainZ } from '../hooks/panels/gitgud/overlap'
import { MAX_BACKOFF_MS } from '../hooks/panels/gitgud/model'
import { isPollDue, nextPollDelay } from '../hooks/panels/gitgud/poll'

const row = (text: string) => `validate\tUNKNOWN STEP\t2026-10-15T07:18:06.3Z ${text}`

test('a failed log drops the preamble and keeps the ##[error] context', () => {
  const raw = [
    row('﻿Current runner version: 2.337.0'),
    row('##[group]Run check'),
    row('\u001b[36;1m# a script line\u001b[0m'),
    row('##[endgroup]'),
    row('Missing "## Testing" section'),
    row('##[error]Process completed with exit code 1.')
  ].join('\n')

  expect(cleanLogLines(raw)).toEqual(['Missing "## Testing" section', '##[error]Process completed with exit code 1.'])
  expect(excerptFailedLog(raw)).toEqual({
    problem: 'Process completed with exit code 1.',
    lines: ['Missing "## Testing" section', 'Process completed with exit code 1.']
  })
})

test('a tsc log is read by the checks parser', () => {
  const raw = [row("src/a.ts(3,1): error TS2322: Type 'x' is not assignable."), row('##[error]Process completed with exit code 2.')].join('\n')
  const excerpt = excerptFailedLog(raw)

  expect(excerpt.problem).toBe('1 error')
  expect(excerpt.lines[0]).toContain('src/a.ts(3,1): error TS2322')
})

test('porcelain and name-status -z give both sides of a rename and untracked files', () => {
  expect(parsePorcelainZ('R  new.ts\0old.ts\0?? fresh.ts\0 M a.ts\0')).toEqual(['new.ts', 'old.ts', 'fresh.ts', 'a.ts'])
  expect(parseNameStatusZ('M\0a.ts\0R087\0old.ts\0new.ts\0D\0gone.ts\0')).toEqual([
    { status: 'M', path: 'a.ts' },
    { status: 'R', path: 'new.ts', from: 'old.ts' },
    { status: 'D', path: 'gone.ts' }
  ])
})

const pr = (number: number, headRef: string, files: string[]) => ({ number, title: `PR ${number}`, author: 'grace', url: `u${number}`, headRef, files, isPartial: false })

test('overlaps exclude the branch own PR and sort by shared files', () => {
  const prs = [pr(1, 'mine', ['a', 'b']), pr(2, 'x', ['a']), pr(3, 'y', ['a', 'b', 'z']), pr(4, 'w', ['q'])]
  const byBranch = computeOverlaps({ local: ['a', 'b'], prs, repo: 'o/r', branch: 'mine' })
  const byNumber = computeOverlaps({ local: ['a', 'b'], prs, repo: 'o/r', branchPr: 1 })

  expect(byBranch.map(overlap => overlap.number)).toEqual([3, 2])
  expect(byBranch[0]).toMatchObject({ prId: 'o/r#3', files: ['a', 'b'] })
  expect(byNumber).toEqual(byBranch)
})

const item = (over: Partial<GhItem>): GhItem => ({ id: 'o/r#1', kind: 'pr', repo: 'o/r', number: 1, title: 't', url: 'u', author: 'a', updatedAt: '', comments: 0, ...over })

test('alerts seed silently on a new scope, then fire once, across polls and sessions', () => {
  const candidates = deriveListAlerts({ review: [item({ id: 'o/r#9', number: 9 })], mine: [item({ ci: 'fail', headSha: 'abc' })] })
  const sig = scopeSignature('repos', ['o/r'])
  const empty: AlertLedger = { seeded: [], ids: {} }

  expect(scopeSignature('repos', ['b/y', 'a/x'])).toBe('repos:a/x,b/y')
  expect(candidates.map(candidate => candidate.id)).toEqual(['rr:o/r#9', 'ci:o/r#1:abc'])

  const first = takeNewAlerts(empty, candidates, sig, 1000)
  const reloaded = parseLedger(JSON.parse(JSON.stringify(first.ledger)))
  const next = candidates.concat(deriveListAlerts({ review: [], mine: [item({ review: 'approved', headSha: 'abc' })] }))
  const second = takeNewAlerts(reloaded, next, sig, 2000)

  expect(first.fresh).toEqual([])
  expect(second.fresh.map(candidate => candidate.title)).toEqual(['👍 #1 approved'])
  expect(takeNewAlerts(second.ledger, next, sig, 3000).fresh).toEqual([])
  expect(takeNewAlerts(second.ledger, next, 'all', 3000).fresh).toEqual([])
})

test("a review alert keys on the latest review of its kind: a push, or another reviewer's approval, does not raise it again", () => {
  const changes = (headSha: string, changeRequestId: string, approvalId?: string) =>
    deriveListAlerts({ review: [], mine: [item({ review: 'changes', headSha, changeRequestId, ...(approvalId ? { approvalId } : {}) })] })
  const sig = scopeSignature('repos', ['o/r'])
  const seeded = takeNewAlerts({ seeded: [], ids: {} }, [], sig, 0).ledger
  const asked = takeNewAlerts(seeded, changes('sha1', 'R1'), sig, 1000)

  expect(asked.fresh.map(alert => alert.title)).toEqual(['✋ Changes requested on #1'])
  expect(takeNewAlerts(asked.ledger, changes('sha2', 'R1'), sig, 2000).fresh).toEqual([])
  // Reviewer A requested changes, then reviewer B approved: the decision stays "changes", and A's request is not new.
  expect(takeNewAlerts(asked.ledger, changes('sha2', 'R1', 'R2'), sig, 2000).fresh).toEqual([])
  expect(takeNewAlerts(asked.ledger, changes('sha2', 'R3', 'R2'), sig, 2000).fresh).toHaveLength(1)
})

test('a newly followed repo seeds alone: the repos already followed keep alerting', () => {
  const rr = (repo: string, number: number) => item({ id: `${repo}#${number}`, repo, number })
  const known = takeNewAlerts({ seeded: [], ids: {} }, [], scopeSignature('repos', ['o/r']), 0).ledger
  const widened = takeNewAlerts(known, deriveListAlerts({ review: [rr('o/r', 2), rr('o/new', 3)], mine: [] }), scopeSignature('repos', ['o/r', 'o/new']), 1000)
  const legacy = takeNewAlerts({ seeded: ['repos:o/r'], ids: {} }, deriveListAlerts({ review: [rr('o/r', 4)], mine: [] }), 'all', 1000)

  expect(widened.fresh.map(alert => alert.id)).toEqual(['rr:o/r#2'])
  expect(widened.ledger.seeded).toEqual(['repo:o/r', 'repo:o/new'])
  expect(legacy.fresh.map(alert => alert.id)).toEqual(['rr:o/r#4'])
})

test('overlap alerts repeat only when the shared files change', () => {
  const [overlap] = computeOverlaps({ local: ['a', 'b'], prs: [pr(2, 'x', ['a', 'b'])], repo: 'o/r' })
  const [again] = deriveOverlapAlerts([overlap!])
  const [other] = deriveOverlapAlerts([{ ...overlap!, files: ['a'] }])

  expect(again?.title).toBe('⚠ #2 (grace) touches 2 files you changed')
  expect(again?.id).not.toBe(other?.id)
  expect(parseLedger('nope')).toEqual({ seeded: [], ids: {} })
})

test('pruneLedger drops old ids and caps the count', () => {
  const day = 24 * 3600 * 1000
  const ids: Record<string, number> = { old: 0, fresh: 40 * day }
  for (let index = 0; index < 2100; index++) ids[`n${index}`] = 40 * day + index

  const pruned = pruneLedger({ seeded: ['all'], ids }, 41 * day)

  expect(Object.keys(pruned.ids)).toHaveLength(2000)
  expect(pruned.ids.old).toBeUndefined()
  expect(pruned.ids.n2099).toBeDefined()
  expect(pruned.seeded).toEqual(['all'])
})

test('poll delay: shown, hidden, backoff cap, rate pause', () => {
  const now = 1_000_000

  expect(nextPollDelay({ isShown: true, failures: 0, now })).toBe(90_000)
  expect(nextPollDelay({ isShown: true, failures: 0, pollSeconds: 5, now })).toBe(30_000)
  expect(nextPollDelay({ isShown: false, failures: 0, now })).toBe(300_000)
  expect(nextPollDelay({ isShown: true, failures: 2, now })).toBe(360_000)
  expect(nextPollDelay({ isShown: true, failures: 20, now })).toBe(MAX_BACKOFF_MS)
  expect(nextPollDelay({ isShown: true, failures: 0, rateRemaining: 10, rateResetAt: new Date(now + 600_000).toISOString(), now })).toBe(605_000)
  expect(isPollDue(undefined, 90_000, now)).toBe(true)
  expect(isPollDue(now - 89_999, 90_000, now)).toBe(false)
})

test('PR badges: my PR beats a review request, count adds up, label reads', () => {
  const state: GitgudState = {
    mine: [item({ id: 'o/r#12', number: 12, ticket: 'ABC-1', ci: 'fail', review: 'changes' })],
    review: [item({ id: 'o/r#9', number: 9, ticket: 'ABC-1' }), item({ id: 'o/r#7', number: 7, ticket: 'ABC-2', ci: 'pass', review: 'approved' })]
  }
  const badges = prBadgesByKey(state)

  expect(badges['ABC-1']).toMatchObject({ number: 12, isMine: true, count: 2 })
  expect(prBadgeLabel(badges['ABC-1']!)).toBe('#12 ❌ ✋ +1')
  expect(prBadgeLabel(badges['ABC-2']!)).toBe('#7 ✅ 👍')
  expect(ticketOfItem('no key here', 'ABC-55/foo')).toBe('ABC-55')
})
