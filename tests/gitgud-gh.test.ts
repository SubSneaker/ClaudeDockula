import { expect, test } from 'claude-code/testing'

import * as argv from '../hooks/panels/gitgud/argv'
import { isAllowedArgv } from '../hooks/panels/gitgud/guard'
import { adapterOf } from '../hooks/panels/gitgud/providers'
import * as github from '../hooks/panels/gitgud/providers/github'
import { cleanLogLines } from '../hooks/panels/gitgud/logs'
import { classifyGhFailure, drawable, foldCi, foldReview, parseChecks, parseListsResponse, parseOpenPrFiles, parseThreadResponse } from '../hooks/panels/gitgud/parse'

const gh = 'gh'
const scope = { scope: 'repos', repos: ['o/a', 'o/b'] } as const
const docDir = '/home/me/.claude/claudedockula/gitgud'

test('the guard allows every builder output', () => {
  const calls = [
    github.ghAuthStatus(gh), github.ghRepoView(gh), github.ghRepoValidate(gh, 'o/r'), github.ghRecentRepos(gh), github.ghSearchRepos(gh, 'dock'),
    github.ghListsCall(gh, scope), github.ghSearchCall(gh, 'fix', scope), github.ghChecks(gh, 'o/r', 3), github.ghJobLog(gh, 'o/r', 1, 2),
    github.ghThreadCall(gh, 'o/r', 3, 'pr'), github.ghThreadCall(gh, 'o/r', 3, 'issue'), github.ghDiff(gh, 'o/r', 3), github.ghOpenPrFiles(gh, 'o/r'),
    github.ghPrForBranch(gh), argv.GIT_BRANCH, argv.GIT_TOPLEVEL, argv.GIT_STATUS_PORCELAIN, argv.gitMergeBase('develop'),
    argv.gitChangedSince('abc'), argv.gitLogSince('abc'), argv.gitDiffStat('abc'), argv.gitDiff('abc'), github.ghViewerCall(gh),
    ['git', '--no-optional-locks', 'symbolic-ref', '--short', 'HEAD'], github.ghPrHead(gh, 'o/r', 3), github.ghPrFilesCall(gh, 'o/r', 3),
    argv.gitMergeBaseOf('origin/develop', 'a'.repeat(40)), argv.gitDiffPath('abc', 'src/-o x.ts'), argv.gitStatusPath('--output=x')
  ]

  expect(calls.filter(call => !isAllowedArgv(call))).toEqual([])
  expect(isAllowedArgv(['/opt/homebrew/bin/gh', 'pr', 'view', '--json', 'number'])).toBe(true)
})

test('the guard refuses writes', () => {
  const refused = [
    [gh, 'pr', 'checkout', '3'], [gh, 'pr', 'merge', '3'], [gh, 'pr', 'review', '3', '--approve'], [gh, 'pr', 'comment', '3'],
    [gh, 'pr', 'view', '3', '--web'], [gh, 'pr', 'checks', '3', '--watch'], [gh, 'run', 'rerun', '1'], [gh, 'auth', 'login'],
    [gh, 'api', '-X', 'POST', 'repos/o/r/issues'], [gh, 'api', 'repos/o/r/issues', '-f', 'title=x'],
    [gh, 'api', 'graphql', '-X', 'POST', '-f', 'query=query { viewer { login } }'],
    [gh, 'api', 'graphql', '-f', 'query=mutation { addStar(input: {}) { clientMutationId } }'],
    [gh, 'api', 'graphql', '-f', 'query=query { x } mutation M { y }'],
    [gh, 'api', 'graphql', '-F', 'query=@q.graphql'], [gh, 'api', 'graphql', '-f', 'other=1'],
    ['git', 'checkout', 'main'], ['git', 'diff', 'a', 'b'], ['git', '--no-optional-locks', 'checkout', 'main'],
    ['git', '--no-optional-locks', 'diff', '--output=x', 'a'], ['git', '--no-optional-locks', 'diff', '--ext-diff'],
    ['git', '--no-optional-locks', 'push'], ['rm', '-rf', '/'], [],
    ['git', '--no-optional-locks', 'symbolic-ref', 'HEAD', 'refs/heads/x'], ['git', '--no-optional-locks', 'symbolic-ref', '-d', 'HEAD'],
    ['git', '--no-optional-locks', 'symbolic-ref', '-m', 'why', 'HEAD', 'refs/heads/x'], ['git', '--no-optional-locks', 'diff', '--textconv'],
    ['git', '--no-optional-locks', 'ls-files'],
    [gh, 'api', 'repos/o/r/pulls/3/files', '-X', 'POST'], [gh, 'api', 'repos/o/r/pulls/3/files', '-f', 'a=b'],
    [gh, 'api', 'repos/o/r/pulls/3/files', '--input', 'x.json'], [gh, 'api', 'repos/o/r/pulls/3/merge'],
    [gh, 'api', 'repos/o/r/pulls/3/files', '--paginate', '--paginate'], [gh, 'api', 'repos/../../user/pulls/3/files'],
    [gh, 'api', 'repos/o/r/pulls/3/files?per_page=100&x=1'], [gh, 'api', '--method', 'DELETE', 'repos/o/r/pulls/3/files']
  ]

  expect(refused.filter(call => isAllowedArgv(call))).toEqual([])
})

test('openers: https links, and files only under the doc dir', () => {
  const url = 'https://github.com/o/r/pull/3'
  const allowed = [['open', url], ['xdg-open', url], ['cmd', '/c', 'start', '', url], ['open', `${docDir}/o__r/review.md`]]
  const refused = [['open', '/etc/passwd'], ['open', `${docDir}/../x`], ['open', 'http://x.io'], ['open', '-a', 'Terminal'], ['cmd', '/c', 'start', '', 'https://x.io/?a&calc']]

  expect(allowed.filter(call => !isAllowedArgv(call, { docDirs: [docDir] }))).toEqual([])
  expect(refused.filter(call => isAllowedArgv(call, { docDirs: [docDir] }))).toEqual([])
  expect(isAllowedArgv(['open', `${docDir}/a.md`])).toBe(false)
})

test('list queries carry the qualifiers; the search keeps its text in a variable', () => {
  expect(github.listQueries(scope).review).toBe('is:pr is:open review-requested:@me archived:false repo:o/a repo:o/b')
  expect(github.listQueries({ scope: 'all', repos: ['o/a'] }).mine).toBe('is:pr is:open author:@me')
  expect(github.searchQuery('bug', scope)).toBe('bug is:open repo:o/a repo:o/b')
  expect(github.ghSearchCall(gh, 'a mutation', scope)).toContain('q=a mutation is:open repo:o/a repo:o/b')
  expect(isAllowedArgv(github.ghSearchCall(gh, 'a mutation', scope))).toBe(true)
})

const lists = {
  data: {
    viewer: { login: 'octocat' },
    rateLimit: { cost: 1, remaining: 4998, resetAt: '2026-10-16T07:06:12Z' },
    review: { nodes: [
      { number: 2086, title: 'ABC-1231 / Add CSV export option', url: 'https://github.com/acme/webapp/pull/2086', updatedAt: '2026-10-14T09:37:43Z', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', headRefName: 'ABC-1231/label', baseRefName: 'develop', headRefOid: 'abc', bodyText: 'Body\n\n  text', author: { login: 'grace' }, repository: { nameWithOwner: 'acme/webapp' }, comments: { totalCount: 1 }, labels: { nodes: [{ name: 'fe' }] }, reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'fe' } }] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } },
      { number: 7, title: 'Direct', url: 'https://github.com/o/r/pull/7', headRefName: 'x', author: { login: 'a' }, repository: { nameWithOwner: 'o/r' }, reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'octocat' } }, { requestedReviewer: { __typename: 'Team', slug: 'fe' } }] }, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }
    ] },
    mine: { nodes: [{ number: 1, title: 'Update', url: 'https://github.com/o/r/pull/1', reviewDecision: 'CHANGES_REQUESTED', headRefName: 'p', author: { login: 'octocat' }, repository: { nameWithOwner: 'o/r' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }] },
    issues: { nodes: [{ number: 5, title: 'Bug', url: 'https://github.com/o/r/issues/5', author: { login: 'b' }, repository: { nameWithOwner: 'o/r' } }, { broken: true }] }
  }
}

test('lists response: folding, team request, ticket, excerpt, rate limit', () => {
  const parsed = parseListsResponse(JSON.stringify(lists))

  expect(parsed.isOk).toBe(true)
  if (!parsed.isOk) return
  const [team, direct] = parsed.value.review

  expect(team).toMatchObject({ id: 'acme/webapp#2086', kind: 'pr', ci: 'pass', review: 'required', isTeamRequest: true, ticket: 'ABC-1231', excerpt: 'Body text', labels: ['fe'], headSha: 'abc', baseRef: 'develop', comments: 1 })
  expect(direct).toMatchObject({ ci: 'none', review: 'none' })
  expect(direct?.isTeamRequest).toBeUndefined()
  expect(parsed.value.mine[0]).toMatchObject({ ci: 'fail', review: 'changes' })
  expect(parsed.value.mine[0]?.isTeamRequest).toBeUndefined()
  expect(parsed.value.issues).toHaveLength(1)
  expect(parsed.value.issues[0]).toMatchObject({ kind: 'issue', id: 'o/r#5' })
  expect(parsed.value).toMatchObject({ login: 'octocat', rateRemaining: 4998, rateResetAt: '2026-10-16T07:06:12Z' })
  expect(foldCi('EXPECTED')).toBe('pending')
  expect(foldReview(null)).toBe('none')
  expect(parseListsResponse('not json').isOk).toBe(false)
  expect(parseListsResponse(JSON.stringify({ errors: [{ message: 'boom' }] }))).toEqual({ isOk: false, error: 'boom' })
})

test('checks: pending exit-8 JSON sorts failed, pending, rest, with run and job ids', () => {
  const link = 'https://github.com/o/r/actions/runs/38543300706/job/115783088880'
  const stdout = JSON.stringify([
    { name: 'ok', bucket: 'pass', state: 'SUCCESS', link, workflow: 'Test' },
    { name: 'wait', bucket: 'pending', state: 'IN_PROGRESS', link: 'https://ci.example/x' },
    { name: 'bad', bucket: 'fail', state: 'FAILURE', link: 'https://github.com/o/r/actions/runs/9/job/8', description: 'x' },
    { name: 'skip', bucket: 'skipping', state: 'SKIPPED' }
  ])
  const parsed = parseChecks(stdout)

  expect(parsed.isOk && parsed.value.map(check => `${check.name}:${check.state}`)).toEqual(['bad:fail', 'wait:pending', 'ok:pass', 'skip:skipped'])
  expect(parsed.isOk && parsed.value[0]).toMatchObject({ runId: 9, jobId: 8 })
  expect(parsed.isOk && parsed.value[2]).toMatchObject({ runId: 38543300706, jobId: 115783088880, workflow: 'Test' })
  expect(parsed.isOk && parsed.value[1]?.runId).toBeUndefined()
  expect(parseChecks('no checks reported').isOk).toBe(false)
})

test('thread and open-PR-files parsers', () => {
  const thread = parseThreadResponse(JSON.stringify({ data: { repository: { pullRequest: {
    title: 'T', body: 'B', url: 'https://github.com/o/r/pull/12', state: 'OPEN', headRefName: 'h', baseRefName: 'b', author: { login: 'a' },
    comments: { nodes: [{ author: { login: 'c' }, body: 'hi', createdAt: 'z' }] }, reviews: { nodes: [{ author: { login: 'r' }, state: 'APPROVED', body: '' }] },
    reviewThreads: { nodes: [{ isResolved: false, isOutdated: true, path: 'f.ts', line: null, originalLine: 4, comments: { nodes: [{ author: null, body: 'x', diffHunk: '@@' }] } }] }
  } } } }), 'o/r', 'pr')

  expect(thread.isOk && thread.value).toMatchObject({ number: 12, title: 'T', headRef: 'h', comments: [{ author: 'c', body: 'hi' }], reviews: [{ state: 'APPROVED' }], threads: [{ path: 'f.ts', line: 4, isOutdated: true, comments: [{ author: 'ghost', diffHunk: '@@' }] }] })
  expect(parseThreadResponse('{}', 'o/r', 'issue').isOk).toBe(false)

  const files = parseOpenPrFiles(JSON.stringify([{ number: 1, title: 't', url: 'u', author: { login: 'a' }, headRefName: 'h', changedFiles: 150, files: [{ path: 'a.ts' }] }]))

  expect(files.isOk && files.value[0]).toMatchObject({ files: ['a.ts'], isPartial: true })
})

test('escapes and control characters in GitHub text never reach a drawn row', () => {
  const nasty = '\u001b[31mRed\u0007 \u001b(Btitle\u001b]8;;https://x\u0007link\u001b]8;;\u0007\tend\u009b1m'
  const node = { ...lists.data.mine.nodes[0], title: nasty, labels: { nodes: [{ name: 'a\u001b=b' }] }, author: { login: 'x\u0000y' } }
  const parsed = parseListsResponse(JSON.stringify({ data: { ...lists.data, mine: { nodes: [node] } } }))
  const checks = parseChecks(JSON.stringify([{ name: 'lint\u001b7', bucket: 'fail', description: 'boom\u0008' }]))
  const log = cleanLogLines('build\tRun tsc\t2026-10-15T07:18:06.3Z src/a.ts: error\u001b(B\u001b[m\r\u001b=')

  expect(drawable(nasty)).toBe('Red titlelink end')
  expect(parsed.isOk && parsed.value.mine[0]).toMatchObject({ title: 'Red titlelink end', labels: ['ab'], author: 'xy' })
  expect(checks.isOk && checks.value[0]).toMatchObject({ name: 'lint', description: 'boom' })
  expect(log).toEqual(['src/a.ts: error'])
})

test('gh failures are classified from stderr', () => {
  expect(classifyGhFailure('spawn gh ENOENT')).toBe('missing')
  expect(classifyGhFailure('You are not logged into any GitHub hosts. To log in, run: gh auth login')).toBe('logged-out')
  expect(classifyGhFailure('HTTP 403: API rate limit exceeded')).toBe('rate-limited')
  expect(classifyGhFailure('Could not resolve to a Repository with the name o/x')).toBe('not-found')
  expect(classifyGhFailure('error connecting: dial tcp: lookup api.github.com: no such host')).toBe('network')
  expect(classifyGhFailure('error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com')).toBe('network')
  expect(classifyGhFailure('weird', 1)).toBe('other')
})

test('a failed gh graphql call with a JSON error body fails with its stderr, so a sign-out or a rate limit classifies', () => {
  const adapter = adapterOf('github')
  if (adapter === undefined) throw new Error('adapter missing')
  const ctx = { host: 'github.com', apiHost: 'github.com', scope: 'repos' as const, repos: [] }
  const cases: Array<[string, string, string]> = [
    ['gh: Bad credentials (HTTP 401)', '{"message":"Bad credentials","status":"401"}', 'logged-out'],
    ['gh: You have exceeded a secondary rate limit (HTTP 403)', '{"message":"You have exceeded a secondary rate limit"}', 'rate-limited']
  ]
  for (const [stderr, stdout, kind] of cases) {
    for (const op of [adapter.lists(ctx), adapter.search(ctx, 'x')]) {
      op.next()
      const done = op.next({ exitCode: 1, stdout, stderr })
      expect(done.done).toBe(true)
      const value = done.value
      expect(value !== undefined && !Array.isArray(value) && 'isOk' in value && !value.isOk ? classifyGhFailure(value.error) : 'ok').toBe(kind)
    }
  }
})
