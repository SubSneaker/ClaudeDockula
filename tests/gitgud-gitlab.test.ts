import { expect, test } from 'claude-code/testing'

import { cleanGitlabTrace, excerptFailedLog } from '../hooks/panels/gitgud/logs'
import { GITLAB_READS, GLAB_ENV, gitlabAdapter, projectOf } from '../hooks/panels/gitgud/providers/gitlab'
import { foldMrDetail, parseItemList, parseRawDiffFiles, parseThread } from '../hooks/panels/gitgud/providers/gitlabParse'
import type { Op, Outcome, Step } from '../hooks/panels/gitgud/providers/types'

const MR_LIST = JSON.stringify([
  {
    iid: 12, title: 'ABC-7 Fix login', web_url: 'https://gitlab.com/g/sub/proj/-/merge_requests/12', updated_at: '2026-10-19T10:00:00Z',
    author: { username: 'ann' }, user_notes_count: 3, labels: ['bug'], draft: false, source_branch: 'fix-login', target_branch: 'main',
    sha: 'a'.repeat(40), references: { full: 'g/sub/proj!12' }, description: 'Fixes   the\nlogin', detailed_merge_status: 'not_approved'
  },
  { iid: 5, title: 'Old', web_url: 'https://gitlab.com/g/sub/proj/-/issues/5', updated_at: '2026-10-01T10:00:00Z', author: { username: 'bob' }, references: { full: 'g/sub/proj#5' } }
])
const DETAIL = JSON.stringify({
  iid: 12, detailed_merge_status: 'not_approved', head_pipeline: { id: 99, status: 'failed', web_url: 'https://gitlab.com/p/99' },
  diff_refs: { base_sha: 'b'.repeat(40), start_sha: 's', head_sha: 'a'.repeat(40) }, target_branch: 'main'
})
const APPROVALS = JSON.stringify({ approved: true, approved_by: [{ user: { username: 'zed' } }, { user: { username: 'amy' } }] })
const JOBS = JSON.stringify([
  { id: 1, name: 'lint', stage: 'test', status: 'success', web_url: 'https://gitlab.com/j/1' },
  { id: 2, name: 'unit', stage: 'test', status: 'failed', web_url: 'https://gitlab.com/j/2', failure_reason: 'script_failure' },
  { id: 3, name: 'flaky', stage: 'test', status: 'failed', allow_failure: true }
])
const DISCUSSIONS = JSON.stringify([
  { id: 'd1', individual_note: true, notes: [{ body: 'hello', author: { username: 'amy' }, created_at: '2026-10-19T11:00:00Z', system: false }] },
  { id: 'd2', individual_note: true, notes: [{ body: 'merged', author: { username: 'bot' }, system: true }] },
  {
    id: 'd3', individual_note: false,
    notes: [
      { body: 'rename', author: { username: 'amy' }, resolvable: true, resolved: true, position: { new_path: 'src/a.ts', new_line: 4, head_sha: 'old' } },
      { body: 'done', author: { username: 'ann' }, resolvable: true, resolved: true, position: { new_path: 'src/a.ts', new_line: 4, head_sha: 'old' } }
    ]
  }
])
const RAW_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-x', '+y',
  'diff --git a/old.ts b/new.ts', 'similarity index 100%', 'rename from old.ts', 'rename to new.ts',
  'diff --git a/img.png b/img.png', 'new file mode 100644', 'Binary files /dev/null and b/img.png differ', ''
].join('\n')
const ITEM = { id: 'gitlab.com/g/sub/proj#12', provider: 'gitlab', kind: 'pr', repo: 'gitlab.com/g/sub/proj', number: 12, title: 't', url: 'u', author: 'ann', updatedAt: '', comments: 0 } as const

/** True when a `glab api` target matches a `GITLAB_READS` entry with only that entry's query keys. */
function isListedRead(target: string): boolean {
  const [path = '', query = ''] = target.split('?')
  const pairs = query === '' ? [] : query.split('&').map(part => part.split('=') as [string, string])

  return GITLAB_READS.some(
    read => read.path.test(path) && pairs.every(([key, value]) => read.query?.[key]?.test(value) === true) && (read.required ?? []).every(key => pairs.some(([seen]) => seen === key))
  )
}

function ok(stdout: string): Outcome {
  return { exitCode: 0, stdout, stderr: '' }
}

/** Runs an op, answering each request by the `glab api` path it asks for; returns the result and every argv seen. */
function drive<T>(op: Op<T>, answers: Record<string, string>) {
  const seen: string[][] = []
  const answer = (step: Step): Outcome => {
    const reqs = 'kind' in step ? [step] : step
    const outcomes = reqs.map(req => {
      const argv = req.kind === 'http' ? [] : req.argv
      seen.push(argv)
      const path = argv[2] ?? ''
      const hit = Object.keys(answers).find(key => path.split('?')[0]?.endsWith(key))

      return hit === undefined ? { exitCode: 1, stdout: '', stderr: `404 ${path}` } : ok(answers[hit] ?? '')
    })

    return 'kind' in step ? (outcomes[0] as Outcome) : (outcomes as unknown as Outcome)
  }
  let step = op.next()
  while (!step.done) step = op.next(answer(step.value))

  return { result: step.value, seen }
}

test('list parse: project path, labels, review from requested_changes, newest first', () => {
  const parsed = parseItemList(MR_LIST, 'gitlab.com', 'ABC-\\d+')
  expect(parsed.isOk && parsed.value.map(item => item.id)).toEqual(['gitlab.com/g/sub/proj#12', 'gitlab.com/g/sub/proj#5'])
  const [mr, issue] = parsed.isOk ? parsed.value : []
  expect(mr).toMatchObject({ kind: 'pr', provider: 'gitlab', ticket: 'ABC-7', headRef: 'fix-login', baseRef: 'main', labels: ['bug'], excerpt: 'Fixes the login' })
  expect(issue?.kind).toBe('issue')
  expect(projectOf(mr ?? ITEM)).toEqual({ host: 'gitlab.com', path: 'g/sub/proj' })
})

test('detail fold: pipeline → ci, approvals and requested_changes → review', () => {
  expect(foldMrDetail(DETAIL, APPROVALS)).toMatchObject({ ci: 'fail', review: 'approved', approvalId: 'amy,zed', headSha: 'a'.repeat(40) })
  expect(foldMrDetail(DETAIL, '{"approved":false,"approved_by":[]}')).toMatchObject({ review: 'required' })
  const changes = DETAIL.replace('not_approved', 'requested_changes')
  expect(foldMrDetail(changes, APPROVALS)).toMatchObject({ review: 'changes', changeRequestId: 'a'.repeat(40) })
  expect(foldMrDetail('{"message":"404"}', APPROVALS)).toBeUndefined()
})

test('discussions → comments and diff threads; system notes dropped; outdated by head sha', () => {
  const parsed = parseThread('pr', 'gitlab.com/g/sub/proj', DETAIL.replace('{', '{"title":"T","web_url":"u","iid":12,"author":{"username":"ann"},'), DISCUSSIONS, APPROVALS)
  expect(parsed.isOk).toBe(true)
  const thread = parsed.isOk ? parsed.value : undefined
  expect(thread?.comments.map(comment => comment.body)).toEqual(['hello'])
  expect(thread?.threads).toMatchObject([{ path: 'src/a.ts', line: 4, isResolved: true, isOutdated: true }])
  expect(thread?.reviews.map(review => review.author)).toEqual(['amy', 'zed'])
})

test('raw diff → file entries with rename, binary and patch', () => {
  expect(parseRawDiffFiles(RAW_DIFF)).toEqual([
    { filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' },
    { filename: 'new.ts', previousFilename: 'old.ts', status: 'renamed' },
    { filename: 'img.png', status: 'added' }
  ])
})

test('trace cleaning drops ANSI, section markers and the preamble; errors become ##[error]', () => {
  const raw = [
    'Running with gitlab-runner 17.0',
    'section_start:1700000000:step_script\r\u001b[0K\u001b[36;1mExecuting step\u001b[0;m',
    '\u001b[32;1m$ npm test\u001b[0;m',
    'src/a.ts(3,1): error TS2322: bad',
    'section_end:1700000001:step_script\r\u001b[0K',
    '\u001b[31;1mERROR: Job failed: exit code 1\u001b[0;m'
  ].join('\n')
  const cleaned = cleanGitlabTrace(raw)

  expect(cleaned).toBe('Executing step\n$ npm test\nsrc/a.ts(3,1): error TS2322: bad\n##[error]Job failed: exit code 1')
  expect(excerptFailedLog(cleaned).problem).toBeDefined()
})

test('lists: user first, then three GETs; every argv is a bare glab api read', () => {
  const ctx = { host: 'gitlab.com', apiHost: 'gitlab.com', scope: 'all', repos: [] } as const
  const { result, seen } = drive(gitlabAdapter.lists(ctx), { 'user': '{"username":"me","id":1}', 'merge_requests': MR_LIST, 'issues': '[]' })

  expect(result.isOk && result.value.login).toBe('me')
  expect(result.isOk && result.value.review.length).toBe(2)
  expect(seen.map(argv => argv[2])).toEqual([
    'user',
    'merge_requests?scope=all&state=opened&reviewer_username=me&per_page=30',
    'merge_requests?scope=created_by_me&state=opened&per_page=30',
    'issues?scope=assigned_to_me&state=opened&per_page=30'
  ])
  for (const argv of seen) {
    expect(argv.slice(0, 2)).toEqual(['glab', 'api'])
    expect(argv.slice(3)).toEqual(['--hostname', 'gitlab.com'])
    expect([argv[2], isListedRead(argv[2] ?? '')]).toEqual([argv[2], true])
    expect(argv.some(arg => ['-f', '-F', '-X', '--method', '--field', '--raw-field'].includes(arg))).toBe(false)
  }
})

test('repos scope asks each followed project with an encoded nested path', () => {
  const repos = [{ provider: 'gitlab', host: 'git.corp', apiHost: 'git.corp', path: 'g/sub/proj' }] as const
  const ctx = { host: 'git.corp', apiHost: 'git.corp', scope: 'repos', repos, login: 'me' } as const
  const { seen } = drive(gitlabAdapter.lists(ctx), { 'merge_requests': '[]', 'issues': '[]' })

  expect(seen.map(argv => argv[2])).toContain('projects/g%2Fsub%2Fproj/merge_requests?state=opened&reviewer_username=me&per_page=30')
  expect(seen.every(argv => argv.at(-1) === 'git.corp')).toBe(true)
})

test('checks follow the head pipeline; failedLog reads the job trace; details fold per row', () => {
  const checks = drive(gitlabAdapter.checks(ITEM), { 'pipelines/99/jobs': JOBS, 'merge_requests/12': DETAIL })
  const list = checks.result.isOk ? checks.result.value : []
  expect(list.map(check => [check.name, check.state, check.jobKey])).toEqual([['unit', 'fail', '2'], ['lint', 'pass', '1'], ['flaky', 'skipped', '3']])
  expect(checks.seen.map(argv => argv[2])).toEqual(['projects/g%2Fsub%2Fproj/merge_requests/12', 'projects/g%2Fsub%2Fproj/pipelines/99/jobs?per_page=100'])

  const [failed] = list
  const log = drive(gitlabAdapter.failedLog(ITEM, failed ?? { name: 'x', state: 'fail' }), { 'jobs/2/trace': 'ERROR: Job failed: exit code 1' })
  expect(log.result).toEqual({ isOk: true, value: '##[error]Job failed: exit code 1' })

  const filled = drive(gitlabAdapter.details({ host: 'gitlab.com', apiHost: 'gitlab.com', scope: 'all', repos: [] }, [ITEM]), { 'merge_requests/12/approvals': APPROVALS, 'merge_requests/12': DETAIL })
  expect(filled.result.isOk && filled.result.value[ITEM.id]).toMatchObject({ ci: 'fail', review: 'approved' })
})

test('head and prFiles use the MR head sha and raw_diffs', () => {
  const head = drive(gitlabAdapter.head(ITEM), { 'merge_requests/12': DETAIL })
  expect(head.result.isOk && head.result.value).toEqual({ headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), baseRef: 'main' })

  const files = drive(gitlabAdapter.prFiles(ITEM), { raw_diffs: RAW_DIFF })
  expect(files.result.isOk && files.result.value.map(file => file.filename)).toEqual(['src/a.ts', 'new.ts', 'img.png'])
})

test('health: signed out and a missing glab are verdicts, not errors', () => {
  const run = (exitCode: number, stderr: string) => {
    const op = gitlabAdapter.health('gitlab.com')
    op.next()

    return op.next({ exitCode, stdout: '', stderr })
  }

  expect(run(1, 'x No token found for gitlab.com. Run glab auth login').value).toEqual({ isOk: true, value: { health: 'logged-out' } })
  expect(run(127, 'glab: command not found').value).toEqual({ isOk: true, value: { health: 'missing' } })
  expect(run(1, 'dial tcp: lookup gitlab.corp: no such host').value).toMatchObject({ isOk: false })
})

test('GITLAB_READS lists only GET read paths and GLAB_ENV silences glab', () => {
  const matches = (path: string) => GITLAB_READS.some(read => read.path.test(path))

  expect(matches('projects/g%2Fsub%2Fproj/merge_requests/12/raw_diffs')).toBe(true)
  expect(matches('projects/g/sub/proj')).toBe(false)
  expect(matches('projects/g%2Fp/merge_requests/12/merge')).toBe(false)
  expect(GLAB_ENV).toMatchObject({ GLAB_NO_PROMPT: 'true', NO_COLOR: '1', GLAB_PAGER: 'cat', GLAB_CHECK_UPDATE: 'false', GLAB_SEND_TELEMETRY: 'false' })
})
