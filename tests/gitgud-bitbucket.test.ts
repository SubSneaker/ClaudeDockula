import { expect, test } from 'claude-code/testing'

import { basicAuthHeader, keychainLookupArgv, redactSecrets, tokenFromEnv } from '../hooks/panels/gitgud/credentials'
import { BITBUCKET_READS, bitbucketAdapter } from '../hooks/panels/gitgud/providers/bitbucket'
import { ciOfChecks, classifyBitbucketFailure, failureMessage, foldParticipants, parseDiffstat, parsePullRequests, parseStatuses, splitUnifiedDiff } from '../hooks/panels/gitgud/providers/bitbucketParse'
import type { Op, Outcome, Req } from '../hooks/panels/gitgud/providers/types'
import type { GhItem } from '../types'

const ME = '{me-uuid}'
const SHORT = 'a1b2c3d4e5f6'
const FULL = `${SHORT}${'0'.repeat(28)}`
const BASE_SHORT = '0f9e8d7c6b5a'
const TOKEN = 's3cr3t-token-value'

const participants = [
  { role: 'REVIEWER', approved: false, state: null, user: { uuid: ME, nickname: 'me' } },
  { role: 'REVIEWER', approved: true, state: 'approved', participated_on: '2026-10-01T10:00:00Z', user: { uuid: '{ann}', nickname: 'ann' } }
]
const prNode = {
  id: 7,
  title: 'ABC-12 add export',
  summary: { raw: 'Adds the export button.' },
  draft: false,
  comment_count: 2,
  updated_on: '2026-10-02T10:00:00Z',
  author: { uuid: '{bob}', display_name: 'Bob B', nickname: 'bob' },
  links: { html: { href: 'https://bitbucket.org/ws/web/pull-requests/7' } },
  source: { branch: { name: 'feat/export' }, commit: { hash: SHORT }, repository: { full_name: 'ws/web' } },
  destination: { branch: { name: 'main' }, commit: { hash: BASE_SHORT }, repository: { full_name: 'ws/web' } },
  participants
}
const repoRef = { provider: 'bitbucket', host: 'bitbucket.org', apiHost: 'api.bitbucket.org', path: 'ws/web' } as const
const item: GhItem = { id: 'bitbucket.org/ws/web#7', kind: 'pr', repo: 'bitbucket.org/ws/web', number: 7, title: 't', url: 'https://bitbucket.org/ws/web/pull-requests/7', author: 'bob', updatedAt: '', comments: 0 }

function ok(body: unknown, headers?: Record<string, string>): Outcome {
  return { exitCode: 0, stdout: typeof body === 'string' ? body : JSON.stringify(body), stderr: '', status: 200, ...(headers === undefined ? {} : { headers }) }
}

function httpFail(status: number, body = ''): Outcome {
  return { exitCode: 0, stdout: body, stderr: '', status }
}

/** Steps a generator with an answer per request; returns the requests it made and its result. */
function drive<T>(op: Op<T>, answer: (req: Req) => Outcome) {
  const seen: Req[] = []
  let step = op.next()

  while (!step.done) {
    const value = step.value
    const reqs = Array.isArray(value) ? value : [value]

    seen.push(...reqs)
    step = op.next(Array.isArray(value) ? reqs.map(answer) : answer(reqs[0] as Req))
  }

  return { seen, result: step.value }
}

function urlOf(req: Req): string {
  return req.kind === 'http' ? req.url : ''
}

const lists = { host: 'bitbucket.org', apiHost: 'api.bitbucket.org', scope: 'repos', repos: [repoRef] } as const

test('lists: To review keeps PRs awaiting me; Mine reads my workspaces; every request is a token GET', () => {
  const { seen, result } = drive(bitbucketAdapter.lists(lists), req => {
    const url = urlOf(req)

    if (url.endsWith('/user')) return ok({ uuid: ME, nickname: 'me' })
    if (url.includes('/user/workspaces')) return ok({ values: [{ workspace: { slug: 'ws' } }] })
    if (url.includes('/workspaces/ws/pullrequests/')) return ok({ values: [{ ...prNode, id: 9, author: { uuid: ME, nickname: 'me' } }] })

    return ok({ values: [prNode] })
  })

  expect(result.isOk && result.value.login).toBe('me')
  expect(result.isOk && result.value.review.map(row => row.id)).toEqual(['bitbucket.org/ws/web#7'])
  expect(result.isOk && result.value.mine.map(row => row.id)).toEqual(['bitbucket.org/ws/web#9'])
  expect(seen.every(req => req.kind === 'http' && req.method === 'GET' && req.needsToken && req.url.startsWith('https://api.bitbucket.org/2.0/'))).toBe(true)
  expect(seen.some(req => urlOf(req).includes('/workspaces/ws/pullrequests/%7Bme-uuid%7D'))).toBe(true)
})

test('lists: To review leaves out PRs I already approved or wrote', () => {
  const mine = { ...prNode, id: 8, author: { uuid: ME } }
  const approved = { ...prNode, id: 6, participants: [{ role: 'REVIEWER', approved: true, state: 'approved', user: { uuid: ME } }] }
  const { result } = drive(bitbucketAdapter.lists(lists), req => {
    const url = urlOf(req)

    if (url.endsWith('/user')) return ok({ uuid: ME, nickname: 'me' })
    if (url.includes('/user/workspaces')) return ok({ values: [] })

    return ok({ values: [mine, approved] })
  })

  expect(result.isOk && result.value.review).toEqual([])
})

test('parse: a PR row folds to a GhItem with a short head flagged', () => {
  const parsed = parsePullRequests(JSON.stringify({ values: [prNode] }), 'bitbucket.org', undefined, undefined)
  const row = parsed.isOk ? parsed.value[0]?.item : undefined

  expect(row).toMatchObject({ id: 'bitbucket.org/ws/web#7', repo: 'bitbucket.org/ws/web', number: 7, author: 'bob', headRef: 'feat/export', baseRef: 'main', headSha: SHORT, isHeadShaShort: true, comments: 2 })
})

test('participants fold to a review state and alert keys', () => {
  expect(foldParticipants([])).toEqual({ review: 'none' })
  expect(foldParticipants([{ name: 'me', role: 'REVIEWER', isApproved: false }]).review).toBe('required')

  const approved = foldParticipants([{ name: 'ann', uuid: '{ann}', role: 'REVIEWER', isApproved: true, state: 'approved', participatedOn: 'T1' }])
  const changes = foldParticipants([
    { name: 'ann', uuid: '{ann}', role: 'REVIEWER', isApproved: true, state: 'approved', participatedOn: 'T1' },
    { name: 'cy', uuid: '{cy}', role: 'REVIEWER', isApproved: false, state: 'changes_requested', participatedOn: 'T2' }
  ])

  expect(approved).toEqual({ review: 'approved', approvalId: '{ann}@T1' })
  expect(changes.review).toBe('changes')
  expect(changes.changeRequestId).toBe('{cy}@T2')
})

test('statuses fold to checks and a combined ci', () => {
  const body = JSON.stringify({ values: [
    { name: 'build', state: 'SUCCESSFUL', url: 'https://ci/1' },
    { name: 'lint', state: 'FAILED', description: 'bad' },
    { name: 'e2e', state: 'INPROGRESS' }
  ] })
  const parsed = parseStatuses(body)
  const checks = parsed.isOk ? parsed.value : []

  expect(checks.map(check => [check.name, check.state])).toEqual([['lint', 'fail'], ['e2e', 'pending'], ['build', 'pass']])
  expect(ciOfChecks(checks)).toBe('fail')
  expect(ciOfChecks([])).toBe('none')
  expect(ciOfChecks(checks.filter(check => check.state === 'pass'))).toBe('pass')
  expect(ciOfChecks(checks.filter(check => check.state === 'pending'))).toBe('pending')
})

test('details: statuses give ci, and one self fetch fills a missing review', () => {
  const bare: GhItem = { ...item }
  const { seen, result } = drive(bitbucketAdapter.details(lists, [bare]), req => (urlOf(req).includes('/statuses') ? ok({ values: [{ name: 'b', state: 'SUCCESSFUL' }] }) : ok(prNode)))

  expect(seen).toHaveLength(2)
  expect(result.isOk && result.value[bare.id]).toMatchObject({ ci: 'pass', review: 'approved' })
})

test('head: the local rev-parse resolves the short hash; the commit endpoint is the fallback', () => {
  const local = drive(bitbucketAdapter.head(item), req => (req.kind === 'git' ? { exitCode: 0, stdout: `${FULL}\n`, stderr: '' } : ok(prNode)))
  const gitReq = local.seen.find(req => req.kind === 'git')

  expect(gitReq?.kind === 'git' && gitReq.argv).toEqual(['git', '--no-optional-locks', 'rev-parse', '--verify', '--quiet', `${SHORT}^{commit}`])
  expect(local.result.isOk && local.result.value).toMatchObject({ headSha: FULL, baseRef: 'main' })

  const fallback = drive(bitbucketAdapter.head(item), req => {
    if (req.kind === 'git') return { exitCode: 1, stdout: '', stderr: '' }

    return urlOf(req).includes('/commit/') ? ok({ hash: FULL }) : ok(prNode)
  })

  expect(fallback.seen.some(req => urlOf(req).includes(`/commit/${SHORT}`))).toBe(true)
  expect(fallback.result.isOk && fallback.result.value.headSha).toBe(FULL)

  const none = drive(bitbucketAdapter.head(item), req => (req.kind === 'git' ? { exitCode: 1, stdout: '', stderr: '' } : urlOf(req).includes('/commit/') ? httpFail(404) : ok(prNode)))

  expect(none.result.isOk).toBe(false)
})

test('diff reads the commit range, never the redirecting PR diff', () => {
  const { seen, result } = drive(bitbucketAdapter.diff(item), req => {
    if (req.kind === 'git') return { exitCode: 0, stdout: `${FULL}\n`, stderr: '' }

    return urlOf(req).includes('/diff/') ? ok('diff --git a/x.ts b/x.ts\n') : ok(prNode)
  })
  const diffUrl = seen.map(urlOf).find(url => url.includes('/diff/'))

  expect(diffUrl).toMatch(/\/repositories\/ws\/web\/diff\/[0-9a-f]{12,}\.\.[0-9a-f]{12,}\?topic=true$/)
  expect(seen.map(urlOf).some(url => url.includes('/pullrequests/7/diff'))).toBe(false)
  expect(result.isOk).toBe(true)
})

test('diffstat gives files, and a changed PR is the only one re-read', () => {
  const stat = parseDiffstat(JSON.stringify({ values: [{ new: { path: 'src/a.ts' } }, { old: { path: 'gone.ts' }, new: null }], next: 'https://x' }))

  expect(stat.isOk && stat.value).toEqual({ files: ['src/a.ts', 'gone.ts'], isPartial: true })

  const rows = { values: [
    { id: 1, links: { html: { href: 'u1' } }, source: { commit: { hash: 'aaaaaaaaaaaa' } }, destination: { commit: { hash: 'bbbbbbbbbbbb' } } },
    { id: 2, links: { html: { href: 'u2' } }, source: { commit: { hash: 'cccccccccccc' } }, destination: { commit: { hash: 'bbbbbbbbbbbb' } } }
  ] }
  const known = { 'bitbucket.org/ws/web#1': { headSha: 'aaaaaaaaaaaa', files: ['kept.ts'] } }
  const { seen, result } = drive(bitbucketAdapter.openPrFiles(repoRef, known), req => (urlOf(req).includes('/diffstat/') ? ok({ values: [{ new: { path: 'n.ts' } }] }) : ok(rows)))
  const statUrls = seen.map(urlOf).filter(url => url.includes('/diffstat/'))

  expect(statUrls).toEqual(['https://api.bitbucket.org/2.0/repositories/ws/web/diffstat/cccccccccccc..bbbbbbbbbbbb?topic=true&pagelen=100'])
  expect(result.isOk && result.value.map(pr => [pr.number, pr.files])).toEqual([[1, ['kept.ts']], [2, ['n.ts']]])
})

test('a raw diff splits into one entry per file', () => {
  const text = 'diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+z\n'
  const entries = splitUnifiedDiff(text)

  expect(entries.map(entry => [entry.filename, entry.status])).toEqual([['a.ts', 'modified'], ['new.ts', 'added']])
  expect(entries[0]?.patch).toBe('@@ -1 +1 @@\n-x\n+y')
})

test('401, 403 and 429 become a health state, not a throw', () => {
  const run = (out: Outcome) => drive(bitbucketAdapter.health('bitbucket.org'), () => out).result

  expect(run(ok({ uuid: ME, nickname: 'me' }))).toEqual({ isOk: true, value: { health: 'ok', login: 'me', userId: ME } })
  expect(run(httpFail(401))).toMatchObject({ isOk: true, value: { health: 'logged-out' } })
  expect(run(httpFail(403))).toMatchObject({ isOk: true, value: { health: 'logged-out' } })
  expect(run(httpFail(429))).toMatchObject({ isOk: true, value: { health: 'ok' } })
  expect(classifyBitbucketFailure(httpFail(403))).toBe('forbidden')
  expect(failureMessage(httpFail(403))).toContain('scope')
})

test('a near-limit header pauses the poll', () => {
  const { result } = drive(bitbucketAdapter.lists(lists), req => {
    const url = urlOf(req)

    if (url.endsWith('/user')) return ok({ uuid: ME, nickname: 'me' })
    if (url.includes('/user/workspaces')) return ok({ values: [] })

    return ok({ values: [] }, { 'X-RateLimit-NearLimit': 'true' })
  })

  expect(result.isOk && result.value.rateRemaining).toBe(0)
})

test('the Basic header is base64 of email:token', () => {
  expect(basicAuthHeader('me@x.io', 'tok')).toBe(`Basic ${btoa('me@x.io:tok')}`)
  expect(basicAuthHeader('é@x.io', 'tok')).toBe('Basic w6lAeC5pbzp0b2s=')
})

test('keychain and env lookups are read-only and strict', () => {
  expect(keychainLookupArgv('darwin', 'me@x.io')).toEqual(['security', 'find-generic-password', '-s', 'gitgud-bitbucket', '-a', 'me@x.io', '-w'])
  expect(keychainLookupArgv('linux', 'me@x.io')).toEqual(['secret-tool', 'lookup', 'service', 'gitgud-bitbucket', 'account', 'me@x.io'])
  expect(keychainLookupArgv('win32', 'me@x.io')).toBeUndefined()
  expect(keychainLookupArgv('darwin', 'a b')).toBeUndefined()
  expect(tokenFromEnv('BITBUCKET_TOKEN', name => (name === 'BITBUCKET_TOKEN' ? ' tok\n' : undefined))).toBe('tok')
  expect(tokenFromEnv('bad name', () => 'tok')).toBeUndefined()
})

test('the token never survives redaction, in any form it travels', () => {
  const header = basicAuthHeader('me@x.io', TOKEN)
  const text = `401 for ${header}; token ${TOKEN}; again ${btoa(TOKEN)}; Bearer abc.def`
  const clean = redactSecrets(text, [TOKEN])

  expect(clean).not.toContain(TOKEN)
  expect(clean).not.toContain(btoa(TOKEN))
  expect(clean).not.toContain(header.slice(6))
  expect(clean).not.toContain('abc.def')
  expect(failureMessage({ exitCode: 1, stdout: '', stderr: `curl Authorization: ${header}`, status: 500 })).not.toContain(header.slice(6))
})

test('the reads table is GET paths on one host, and stays inside /2.0', () => {
  const allowed = (path: string) => BITBUCKET_READS.some(rule => rule.path.test(path))

  expect(allowed('repositories/ws/web/pullrequests/7/statuses')).toBe(true)
  expect(allowed('repositories/ws/web/diff/aaaaaaaaaaaa..bbbbbbbbbbbb')).toBe(true)
  expect(allowed('repositories/ws/web/pullrequests/7/approve')).toBe(false)
  expect(allowed('repositories/ws/web/diffXaaaaaaaaaaaa.Xbbbbbbbbbbbb')).toBe(false)
  expect(allowed('repositories/ws/web/pullrequests/7/merge')).toBe(false)
})
