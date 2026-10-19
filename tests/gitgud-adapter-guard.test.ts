import { expect, test } from 'claude-code/testing'

import type { GhCheck, GhItem } from '../types'
import { isAllowedArgv, isAllowedRequest } from '../hooks/panels/gitgud/guard'
import { repoKeyOf } from '../hooks/panels/gitgud/ids'
import { ADAPTERS } from '../hooks/panels/gitgud/providers'
import type { ListsCtx, Op, Outcome, ProviderAdapter, ProviderId, RepoRef, Req, Step } from '../hooks/panels/gitgud/providers/types'

const SHA = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)
const MR = { iid: 7, title: 'T', web_url: 'https://h/g/-/merge_requests/7', updated_at: '2026-10-19T10:00:00Z', author: { username: 'ann' }, source_branch: 'f', target_branch: 'main', sha: SHA, references: { full: 'g/sub/proj!7' }, head_pipeline: { id: 5, web_url: 'https://h/p/5' }, diff_refs: { head_sha: SHA, base_sha: BASE_SHA } }
const RAW_DIFF = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-x', '+y', ''].join('\n')

function ok(stdout: string, extra: Partial<Outcome> = {}): Outcome {
  return { exitCode: 0, stdout, stderr: '', ...extra }
}

function ghReply(argv: readonly string[]): Outcome {
  const text = argv.join(' ')
  if (text.includes('auth status')) return ok('', { stderr: 'Logged in to h account me' })
  if (text.includes('repo view')) return ok(JSON.stringify({ nameWithOwner: 'acme/web', url: 'https://h/acme/web', defaultBranchRef: { name: 'main' } }))
  if (text.includes('pr view')) return ok(JSON.stringify({ headRefOid: SHA, baseRefName: 'main', number: 3, url: 'https://h/3', headRefName: 'f', title: 'T' }))
  if (text.includes('/files')) return ok('[]')
  if (text.includes('repositories(')) return ok('{"data":{"viewer":{"repositories":{"nodes":[{"nameWithOwner":"acme/web"}]}}}}')
  if (argv[1] === 'api') return ok('{"data":{}}')
  if (argv[1] === 'search') return ok('[{"fullName":"acme/web"}]')

  return ok(argv[1] === 'pr' || argv[1] === 'search' ? '[]' : '')
}

function glabReply(argv: readonly string[]): Outcome {
  const base = (argv[2] ?? '').split('?')[0] ?? ''
  if (argv[1] === 'auth') return ok('')
  if (base === 'user') return ok('{"username":"me","id":1}')
  if (base === 'projects') return ok('[{"path_with_namespace":"g/sub/proj"}]')
  if (/(^|\/)(merge_requests|issues)$/.test(base)) return ok(JSON.stringify([MR]))
  if (base.endsWith('/jobs')) return ok('[{"id":2,"name":"unit","status":"failed"}]')
  if (base.endsWith('/trace')) return ok('ERROR: failed')
  if (base.endsWith('/raw_diffs')) return ok(RAW_DIFF)
  if (base.endsWith('/discussions') || base.endsWith('/notes')) return ok('[]')
  if (base.endsWith('/approvals')) return ok('{}')
  if (/\/merge_requests\/\d+$/.test(base)) return ok(JSON.stringify(MR))

  return ok(JSON.stringify({ path_with_namespace: 'g/sub/proj', web_url: 'https://h/g/sub/proj', default_branch: 'main', iid: 7, title: 'i', author: { username: 'ann' } }))
}

function pull(fork: boolean) {
  return {
    id: 3, title: 'T', links: { html: { href: 'https://bb/3' } }, updated_on: '2026-10-19T10:00:00Z', author: { nickname: 'ann', uuid: '{a}' },
    source: { commit: { hash: SHA.slice(0, 12) }, branch: { name: 'f' }, repository: { full_name: fork ? 'fork/web' : 'acme/web' } },
    destination: { commit: { hash: BASE_SHA.slice(0, 12) }, branch: { name: 'main' }, repository: { full_name: 'acme/web' } },
    participants: [{ role: 'REVIEWER', approved: false, user: { uuid: '{1a2b}' } }]
  }
}

function bbReply(url: string, fork: boolean): Outcome {
  const path = url.replace(/^https:\/\/[^/]+\/2\.0/, '').split('?')[0] ?? ''
  const status = 200
  if (path === '/user') return ok('{"nickname":"me","uuid":"{1a2b}"}', { status })
  if (path === '/user/workspaces') return ok('{"values":[{"workspace":{"slug":"acme"}}]}', { status })
  if (/\/diff(stat)?\//.test(path) || /\/pullrequests\/\d+\/diff(stat)?$/.test(path)) return ok(path.includes('diffstat') ? '{"values":[{"new":{"path":"a.ts"}}]}' : RAW_DIFF, { status })
  if (/\/pullrequests\/\d+$/.test(path)) return ok(JSON.stringify(pull(fork)), { status })
  if (path.endsWith('/pullrequests') || path.includes('/pullrequests/%7B')) return ok(JSON.stringify({ values: [pull(fork)] }), { status })
  if (/^\/repositories\/[^/]+$/.test(path)) return ok('{"values":[{"full_name":"acme/web"}]}', { status })
  if (path.includes('/commit/')) return ok(JSON.stringify({ hash: SHA }), { status })

  return ok('{"values":[],"full_name":"acme/web","links":{"html":{"href":"https://bb/acme/web"}}}', { status })
}

interface Place {
  provider: ProviderId
  host: string
  apiHost: string
  path: string
  fork?: boolean
}

const PLACES: Place[] = [
  { provider: 'github', host: 'github.com', apiHost: 'api.github.com', path: 'acme/web' },
  { provider: 'github', host: 'ghe.acme.dev', apiHost: 'ghe.acme.dev', path: 'acme/web' },
  { provider: 'gitlab', host: 'gitlab.com', apiHost: 'gitlab.com', path: 'g/proj' },
  { provider: 'gitlab', host: 'git.acme.dev', apiHost: 'git.acme.dev', path: 'g/sub/proj' },
  { provider: 'bitbucket', host: 'bitbucket.org', apiHost: 'api.bitbucket.org', path: 'acme/web' },
  { provider: 'bitbucket', host: 'bitbucket.org', apiHost: 'api.bitbucket.org', path: 'acme/web', fork: true }
]

function refOf(place: Place): RepoRef {
  return { provider: place.provider, host: place.host, apiHost: place.apiHost, path: place.path }
}

function itemOf(place: Place, kind: 'pr' | 'issue'): GhItem {
  const repo = repoKeyOf(place.host, place.path)

  return { id: `${repo}#3`, kind, provider: place.provider, repo, number: 3, title: 't', url: 'u', author: 'ann', updatedAt: '', comments: 0, headRef: 'f', baseRef: 'main', headSha: SHA }
}

const CHECK: GhCheck = { name: 'unit', state: 'fail', runId: 1, jobId: 2, jobKey: '2' }

function isReqAllowed(req: Req, place: Place): boolean {
  if (req.kind === 'http') {
    const headers = { Authorization: 'Basic x', Accept: 'application/json' }

    return isAllowedRequest({ method: req.method, url: req.url, headers, needsToken: req.needsToken }, { apiHosts: [place.apiHost] })
  }

  return isAllowedArgv(req.argv)
}

function replyTo(req: Req, place: Place): Outcome {
  if (req.kind === 'git') return ok(SHA)
  if (req.kind === 'http') return bbReply(req.url, place.fork === true)

  return place.provider === 'github' ? ghReply(req.argv) : glabReply(req.argv)
}

/** Runs an op on canned outcomes; every request it yields is checked against the guard on the way. */
function drive<T>(op: Op<T>, place: Place, label: string): Req[] {
  const seen: Req[] = []
  let step = op.next()
  for (let turns = 0; !step.done && turns < 12; turns += 1) {
    const value: Step = step.value
    const reqs = 'kind' in value ? [value] : value
    for (const req of reqs) {
      seen.push(req)
      const text = req.kind === 'http' ? req.url : req.argv.join(' ')
      expect(`${label}: ${isReqAllowed(req, place)} ${text}`).toBe(`${label}: true ${text}`)
    }
    const outcomes = reqs.map(req => replyTo(req, place))
    step = op.next('kind' in value ? (outcomes[0] ?? ok('')) : outcomes)
  }

  return seen
}

function opsOf(adapter: ProviderAdapter, place: Place): [string, Op<unknown>][] {
  const ref = refOf(place)
  const ctxOf = (scope: ListsCtx['scope']): ListsCtx => ({ host: place.host, apiHost: place.apiHost, scope, repos: [ref] })
  const pr = itemOf(place, 'pr')
  const issue = itemOf(place, 'issue')

  return [
    ['health', adapter.health(place.host)],
    ['repoOf', adapter.repoOf(ref)],
    ['lists all', adapter.lists(ctxOf('all'))],
    ['lists repos', adapter.lists(ctxOf('repos'))],
    ['search', adapter.search(ctxOf('repos'), 'login')],
    ['details', adapter.details(ctxOf('repos'), [pr])],
    ['checks', adapter.checks(pr)],
    ['failedLog', adapter.failedLog(pr, CHECK)],
    ['thread pr', adapter.thread(pr)],
    ['thread issue', adapter.thread(issue)],
    ['diff', adapter.diff(pr)],
    ['head', adapter.head(pr)],
    ['prFiles', adapter.prFiles(pr)],
    ['openPrFiles', adapter.openPrFiles(ref, {})],
    ['prForBranch', adapter.prForBranch(ref, 'f')],
    ['recentRepos', adapter.recentRepos(place.host)],
    ['searchRepos', adapter.searchRepos(place.host, 'we')]
  ]
}

for (const place of PLACES) {
  test(`every ${place.provider} request on ${place.host}${place.fork === true ? ' (fork PR)' : ''} passes the read-only guard`, () => {
    const adapter = ADAPTERS[place.provider]
    if (adapter === undefined) throw new Error('adapter missing')
    for (const [label, op] of opsOf(adapter, place)) {
      const seen = drive(op, place, label)
      const isRequestFree = (label === 'details' && place.provider === 'github') || (label === 'failedLog' && place.provider === 'bitbucket')
      if (!isRequestFree) expect(seen.length).toBeGreaterThan(0)
    }
  })
}

test('GitHub Enterprise reads PR files with the host flag where the guard expects it', () => {
  const place = PLACES[1]
  const adapter = ADAPTERS.github
  if (place === undefined || adapter === undefined) throw new Error('missing')
  const [req] = drive(adapter.prFiles(itemOf(place, 'pr')), place, 'prFiles')

  expect(req?.kind === 'cli' ? req.argv.slice(1) : []).toEqual(['api', 'repos/acme/web/pulls/3/files?per_page=100', '--hostname', 'ghe.acme.dev', '--paginate'])
})

test('the guard refuses a PR-files read with the host flag after --paginate', () => {
  expect(isAllowedArgv(['gh', 'api', 'repos/o/r/pulls/3/files?per_page=100', '--paginate', '--hostname', 'ghe.acme.dev'])).toBe(false)
})

test('a GraphQL response with errors still parses when gh printed its data', () => {
  const place = PLACES[0]
  const adapter = ADAPTERS.github
  if (place === undefined || adapter === undefined) throw new Error('missing')
  const ctx: ListsCtx = { host: place.host, apiHost: place.apiHost, scope: 'all', repos: [] }
  const partial = { exitCode: 1, stdout: '{"data":{"viewer":{"login":"me"},"review":{"nodes":[]},"mine":{"nodes":[]},"issues":{"nodes":[]}},"errors":[{"message":"x"}]}', stderr: 'gh: x' }
  const lists = adapter.lists(ctx)
  lists.next()
  expect(lists.next(partial).value).toMatchObject({ isOk: true })
  const found = adapter.search(ctx, 'x')
  found.next()
  expect(found.next({ exitCode: 1, stdout: '{"data":{"search":{"nodes":[]}},"errors":[]}', stderr: '' }).value).toMatchObject({ isOk: true, value: [] })
  const failed = adapter.lists(ctx)
  failed.next()
  expect(failed.next({ exitCode: 1, stdout: '', stderr: 'boom' }).value).toMatchObject({ isOk: false })
})

test('a truncated read marks PR files partial on every provider', () => {
  for (const place of [PLACES[0], PLACES[2], PLACES[4]]) {
    const adapter = place === undefined ? undefined : ADAPTERS[place.provider]
    if (place === undefined || adapter === undefined) throw new Error('missing')
    const answer = (req: Req): Outcome => ({ ...replyTo(req, place), isTruncated: true })
    const run = <T>(op: Op<T>): T | undefined => {
      let step = op.next()
      while (!step.done) {
        const value: Step = step.value
        step = op.next('kind' in value ? answer(value) : value.map(answer))
      }

      return step.value.isOk ? step.value.value : undefined
    }
    const files = run(adapter.prFiles(itemOf(place, 'pr')))
    const open = run(adapter.openPrFiles(refOf(place), {}))

    expect(files?.isPartial).toBe(true)
    expect(open?.every(entry => entry.isPartial) ?? false).toBe(true)
  }
})

test('recent and searched repos come back host-keyed on every provider', () => {
  for (const place of PLACES) {
    const adapter = ADAPTERS[place.provider]
    if (adapter === undefined) throw new Error('missing')
    const run = (op: Op<string[]>): string[] => {
      let step = op.next()
      while (!step.done) {
        const value: Step = step.value
        const reqs = 'kind' in value ? [value] : value
        const outcomes = reqs.map(req => replyTo(req, place))
        step = op.next('kind' in value ? (outcomes[0] ?? ok('')) : outcomes)
      }

      return step.value.isOk ? step.value.value : []
    }
    const keys = [...run(adapter.recentRepos(place.host)), ...run(adapter.searchRepos(place.host, 'we'))]

    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(key.startsWith(`${place.host}/`)).toBe(true)
  }
})

test('GitLab overlap lists the newest-updated open MRs first', () => {
  const place = PLACES[3]
  const adapter = ADAPTERS.gitlab
  if (place === undefined || adapter === undefined) throw new Error('missing')
  const [req] = drive(adapter.openPrFiles(refOf(place), {}), place, 'openPrFiles')

  expect(req?.kind === 'cli' ? req.argv[2] : '').toContain('order_by=updated_at&sort=desc')
})

test('a Bitbucket fork PR reads its diff and diffstat through the PR, not the destination commits', () => {
  const place = PLACES[5]
  const adapter = ADAPTERS.bitbucket
  if (place === undefined || adapter === undefined) throw new Error('missing')
  const urlsOf = (reqs: Req[]) => reqs.flatMap(req => (req.kind === 'http' ? [req.url] : []))
  const diff = urlsOf(drive(adapter.diff(itemOf(place, 'pr')), place, 'diff'))
  const stat = urlsOf(drive(adapter.openPrFiles(refOf(place), {}), place, 'openPrFiles'))

  expect(diff.some(url => url.endsWith('/repositories/acme/web/pullrequests/3/diff'))).toBe(true)
  expect(stat.some(url => url.includes('/pullrequests/3/diffstat'))).toBe(true)
  expect([...diff, ...stat].some(url => /\/(diff|diffstat)\/[0-9a-f]+\.\./.test(url))).toBe(false)
})
