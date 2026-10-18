import type { On, ProcessRunResult, RenderPropsOf } from 'claude-code'
import { expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'

import type { DockNotice, GhItem, GhReviewJob, GithubState } from '../types'
import { githubTabTone, summarizeGithub } from '../hooks/panels/github/draw'
import { askKey, encodeItemId } from '../hooks/panels/github/model'
import { SECRET_DENY_RULES } from '../hooks/panels/github/review'

const NOW = Date.UTC(2026, 9, 16, 6, 30, 0)
const REPO = 'acme/webapp'
const ID = `${REPO}#2086`
const EARLIER = `${REPO}#2071`
const DOC_DIR = '/home/t/.claude/claudedockula/github'
const SHA = 'abcdef1234567890abcdef1234567890abcdef12'
const REVIEW_ROOT = '/tmp/t/claudedockula-reviews'
/** The dock tests mount several panes; a busy machine takes them past the default 5 s. */
const SLOW = { timeoutMs: 20_000 }

const ITEM: GhItem = {
  id: ID,
  kind: 'pr',
  repo: REPO,
  number: 2086,
  title: 'Add CSV export option for reports',
  url: `https://github.com/${REPO}/pull/2086`,
  author: 'grace',
  updatedAt: '2026-10-14T09:37:43Z',
  comments: 1,
  ci: 'pass',
  review: 'required'
}
const NODE = {
  number: 2086,
  title: ITEM.title,
  url: ITEM.url,
  updatedAt: ITEM.updatedAt,
  isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED',
  headRefName: 'ABC-1231/csv-export-option',
  baseRefName: 'develop',
  headRefOid: 'abc',
  bodyText: 'Swaps the toggle.',
  author: { login: 'grace' },
  repository: { nameWithOwner: REPO },
  comments: { totalCount: 1 },
  labels: { nodes: [] },
  reviewRequests: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }
}
/** The panel's poll: one review request, nothing else. */
const LISTS = JSON.stringify({
  data: {
    viewer: { login: 'octocat' },
    rateLimit: { cost: 1, remaining: 4998, resetAt: '2026-10-16T07:06:12Z' },
    review: { issueCount: 1, nodes: [NODE] },
    mine: { issueCount: 0, nodes: [] },
    issues: { issueCount: 0, nodes: [] }
  }
})
const REPO_VIEW = JSON.stringify({ nameWithOwner: REPO, url: `https://github.com/${REPO}`, defaultBranchRef: { name: 'develop' } })
const THREAD = JSON.stringify({
  data: { repository: { pullRequest: { title: ITEM.title, body: 'Swaps the toggle.', url: ITEM.url, state: 'OPEN', headRefOid: SHA, author: { login: 'grace' }, comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } } } }
})
/** The main session's settings, as `$.settings.read()` answers: the reviewer may borrow only its domain fetch allows and denies. */
const SESSION_SETTINGS = {
  permissions: { allow: ['Bash(ls)', 'WebFetch(domain:docs.python.org)', 'WebFetch', 'WebSearch'], deny: ['Read(./secrets/**)'] },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] }] },
  env: { CLAUDE_CODE_PLUGIN_DIRS: '/x' }
}

function paneProps(bodyColumns: number): RenderPropsOf['Pane'] {
  return { title: 'Dock', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 120 }, view: {} }
}

function ran(exitCode: number, stdout: string): ProcessRunResult {
  return { exitCode, stdout, stderr: exitCode === 0 ? '' : 'fatal', isStdoutTruncated: false, isStderrTruncated: false }
}

/** A repo checked out on a feature branch, with one review request whose ⋯ menu is open (the plain list). */
function seeded(): GithubState {
  return {
    health: 'ok',
    login: 'octocat',
    currentRepo: { nameWithOwner: REPO, url: `https://github.com/${REPO}`, defaultBranch: 'develop' },
    branch: 'ABC-964/csv-export',
    review: [ITEM],
    mine: [],
    issues: [],
    updatedAt: NOW,
    ui: { menuId: ID }
  }
}

/**
 * `gh`, `git`, `tar` and `rm` answered by argv: signed in, the poll's lists, the PR's thread and diff, a branch one
 * commit past origin/develop, and the PR's head commit on this machine unless `hasCommit` is false.
 */
function mockCommands(on: On, hasCommit = true, gitVersion = '2.49.0'): string[][] {
  const runs: string[][] = []
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const joined = argv.join(' ')
    if (argv[1] === '--version') return { value: ran(0, `git version ${gitVersion}\n`) }
    if (argv[2] === 'config') return { value: ran(0, 'filter.lfs.process\ngit-lfs filter-process\0filter.lfs.required\ntrue\0') }
    if (argv[2] === 'cat-file') return { value: ran(hasCommit ? 0 : 1, '') }
    if (argv.includes('archive') || argv[0] === 'tar' || argv[0] === 'rm') return { value: ran(0, '') }
    if (joined.includes('auth status')) return { value: ran(0, 'Logged in to github.com account octocat\n') }
    if (joined.includes('repo view')) return { value: ran(0, REPO_VIEW) }
    if (joined.includes('api graphql') && joined.includes('pullRequest(number')) return { value: ran(0, THREAD) }
    if (joined.includes('api graphql') && joined.includes('review-requested')) return { value: ran(0, LISTS) }
    if (joined.includes('pr list')) return { value: ran(0, '[]') }
    if (joined.includes('pr diff 2086')) return { value: ran(0, 'diff --git a/src/a.ts b/src/a.ts\n+const csv = true\n') }
    if (joined.includes('rev-parse --abbrev-ref')) return { value: ran(0, 'ABC-964/csv-export\n') }
    if (joined.includes('rev-parse --show-toplevel')) return { value: ran(0, '/repo\n') }
    if (joined.includes('merge-base HEAD origin/develop')) return { value: ran(0, 'abc123\n') }
    if (joined.includes('log --no-merges')) return { value: ran(0, 'def456\tAdd CSV export option\n') }
    const isGitDiff = argv[0] === 'git' && argv[2] === 'diff'
    if (isGitDiff && argv.includes('--stat')) return { value: ran(0, ' src/a.ts | 2 +-\n') }
    if (isGitDiff && argv.includes('--name-status')) return { value: ran(0, 'M\0src/a.ts\0') }
    if (isGitDiff && argv.includes('abc123')) return { value: ran(0, 'diff --git a/src/a.ts b/src/a.ts\n') }

    return { value: ran(1, '') }
  })

  return runs
}

interface Tracked {
  /** The panel's state as the hooks last wrote it. */
  latest: () => GithubState
  /** Every state the hooks wrote, oldest first. */
  writes: GithubState[]
}

/** Read before any write, the panel's state is `seed`, as a poll would leave it; every write is kept. */
function trackGithub(on: On, seed: GithubState): Tracked {
  const writes: GithubState[] = []
  on('state.get', { key: 'github' }, async ($, e, next) => {
    const held = await next(e)

    return 'value' in held && held.value?.version === 0 ? { value: { value: seed, version: 0 } } : held
  })
  on('state.set', { key: 'github' }, ($, e, next) => {
    if (e.key === 'github') writes.push(e.value)

    return next(e)
  })

  return { latest: () => writes.at(-1) ?? seed, writes }
}

/** Ticks GitHub into the main dock: it is opt-in. */
async function setUp(
  $: Engine,
  on: On,
  seed: GithubState = seeded(),
  settings: object = { isHaikuOn: false },
  clock = mock.clock(on, { now: NOW }),
  env: Record<string, string> = { HOME: '/home/t', TMPDIR: '/tmp/t/' }
): Promise<Tracked & { clock: MockClock }> {
  mock.store(on, { 'github:settings': settings })
  mock.env(on, env)
  on('ui.panes', () => ({ value: [] }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  const github = trackGithub(on, seed)
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(60) })
  for (const key of ['dock-main-manage', 'dock-main-enable-1-github', 'dock-main-manage']) await pane.press({ key })
  await pane.unmount()

  return { ...github, clock }
}

/** Files in memory: what the panel writes, reads and lists. */
function mockFiles(on: On): Map<string, string> {
  const files = new Map<string, string>()
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: text }
  })
  on('fs.list', ($, e) => {
    const names = [...files.keys()].filter(path => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/')).map(path => path.slice(e.path.length + 1))

    return { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  // The person's own skills folder and this checkout's `.claude/skills`; no `.agents/skills`. The copy holds a link out of it.
  const lands: Record<string, string> = {
    '/home/t/.claude/skills': '/home/t/.claude/skills',
    '/repo/.claude/skills': '/repo/.claude/skills',
    [`${WORK_DIR}/tree`]: `/private${WORK_DIR}/tree`,
    [`${WORK_DIR}/tree/docs/key.md`]: '/home/t/.ssh/id_rsa'
  }
  on('fs.stat', ($, e) => {
    const realPath = lands[e.path]
    if (realPath === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: { kind: e.path.endsWith('.md') ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false, realPath } }
  })

  return files
}

interface Spawned {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  input?: string
}

const INIT_LINE = '{"type":"system","subtype":"init","tools":["Read","Grep","Glob","WebFetch","WebSearch"],"skills":[],"plugins":[],"mcp_servers":[],"apiKeySource":"none","cwd":"/t"}'
/** The review's folder: its name carries the PR and the clock's time as it starts. */
const WORK_DIR = `${REVIEW_ROOT}/acme__webapp-2086-${NOW}`
const READ_LINE = `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"${WORK_DIR}/tree/src/a.ts"}}]}}`

/**
 * The reviewer, never a model: `claude` answers fixture stream-json lines, waits 5 s on the mocked clock (a review at
 * work), then answers the rest and exits with `code`.
 */
function mockReviewer(on: On, clock: MockClock, first: readonly string[], later: readonly string[], code = 0, waitMs = 5_000): Spawned[] {
  const spawned: Spawned[] = []
  on('process.spawn', async function* ($, e) {
    spawned.push({ argv: [...e.argv], ...(e.cwd === undefined ? {} : { cwd: e.cwd }), ...(e.env === undefined ? {} : { env: { ...e.env } }), ...(e.input === undefined ? {} : { input: e.input }) })
    for (const line of first) yield { stream: 'stdout' as const, text: `${line}\n` }
    await clock.sleep(waitMs)
    if (code !== 0) yield { stream: 'stderr' as const, text: 'boom\n' }
    for (const line of later) yield { stream: 'stdout' as const, text: `${line}\n` }

    return { value: { code, signal: null } }
  })

  return spawned
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)

  return at < 0 ? undefined : argv[at + 1]
}

const WEB_ASK = JSON.stringify({
  hook_event_name: 'PermissionRequest',
  tool_name: 'WebFetch',
  tool_input: { url: 'https://docs.python.org/3/', prompt: 'What does json.loads do?' },
  permission_suggestions: [{ type: 'addRules', destination: 'localSettings', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:docs.python.org' }], behavior: 'allow' }]
})
const RESULT_LINE = '{"type":"result","subtype":"success","is_error":false,"result":"## Summary\\nLooks right.","num_turns":3,"total_cost_usd":0.042,"permission_denials":[]}'

test('🤖 Review in background: a locked-down claude on a clean copy; progress, an ask answered from the card, the review, its logs and a bell', SLOW, async ($, on) => {
  const runs = mockCommands(on)
  const files = mockFiles(on)
  on('settings.read', () => ({ value: SESSION_SETTINGS }))
  const notified: string[] = []
  on('ui.notify', ($, e) => {
    notified.push(e.text)

    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  const notices: DockNotice[][] = []
  on('state.set', { key: 'notices' }, ($, e, next) => {
    if (e.key === 'notices') notices.push(e.value)

    return next(e)
  })
  const fetchLine = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu2","name":"WebFetch","input":{"url":"https://docs.python.org/3/","prompt":"x"}}]}}'
  const clock = mock.clock(on, { now: NOW })
  const spawned = mockReviewer(on, clock, [INIT_LINE, READ_LINE], [fetchLine, RESULT_LINE])
  const github = await setUp($, on, seeded(), { isHaikuOn: false, reviewDone: 'bell' }, clock)

  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'mobile', component: 'Pane', requestId: 'claudedockula', props: paneProps(60) })
  await ui.press({ key: `github-work-review-bg-${encodeItemId(ID)}` })

  // The copy: read from this repo into the review's own folder, Claude Code's project config left out.
  const workDir = github.latest().reviews?.[ID]?.workDir ?? ''
  expect(workDir).toBe(WORK_DIR)
  expect(runs).toEqual(expect.arrayContaining([
    ['git', '--no-optional-locks', 'cat-file', '-e', `${SHA}^{commit}`],
    ['git', '--no-optional-locks', '--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false', 'archive', '--format=tar', '--prefix=tree/', '-o', `${workDir}/pr.tar`, SHA],
    expect.arrayContaining(['tar', '-xf', `${workDir}/pr.tar`, '-C', workDir, '--exclude', '.claude', '--exclude', '.mcp.json'])
  ]))
  expect(runs.some(argv => ['fetch', 'checkout', 'worktree', 'clone', 'stash', 'reset'].includes(argv[2] ?? ''))).toBe(false)

  // The reviewer: none of the person's settings, plugins or MCP servers; their web allows and denies only.
  expect(spawned).toHaveLength(1)
  const [reviewer] = spawned
  const argv = reviewer?.argv ?? []
  expect(argv[0]).toBe('claude')
  expect(valueAfter(argv, '--setting-sources')).toBe('')
  expect(argv).toEqual(expect.arrayContaining(['--strict-mcp-config', '--no-session-persistence']))
  expect(valueAfter(argv, '--tools')).toBe('Read,Grep,Glob,WebFetch,WebSearch')
  expect(valueAfter(argv, '--model')).toBe('sonnet')
  expect(argv.filter((_, at) => argv[at - 1] === '--add-dir')).toEqual(['/home/t/.claude/skills', '/repo/.claude/skills'])
  const settings = JSON.parse(valueAfter(argv, '--settings') ?? '{}')
  expect(Object.keys(settings).sort()).toEqual(['hooks', 'permissions'])
  expect(settings.permissions.allow).toEqual(['WebFetch(domain:docs.python.org)'])
  expect(settings.permissions.deny).toEqual(expect.arrayContaining([...SECRET_DENY_RULES, 'Read(./secrets/**)']))
  expect(Object.keys(settings.hooks)).toEqual(['PermissionRequest'])
  expect(settings.hooks.PermissionRequest[0].hooks[0].command).toMatch(new RegExp(`/hooks/panels/github/ask-relay\\.sh' '${workDir}/asks'$`))
  expect(valueAfter(argv, '--append-system-prompt')).toContain('- /home/t/.claude/skills')
  expect(reviewer?.cwd).toBe(`${workDir}/tree`)
  expect(reviewer?.env).toEqual({ CLAUDE_CODE_PLUGIN_DIRS: '' })
  expect(reviewer?.input).toContain('+const csv = true')
  expect(reviewer?.input).toContain(`head commit ${SHA.slice(0, 7)}`)
  expect(github.latest().reviews?.[ID]).toMatchObject({ phase: 'running', activity: 'reading src/a.ts', steps: 1, copySha: SHA, model: 'sonnet' })
  expect(await ui.find({ type: 'Text', text: 'reading src/a.ts · 1 step' })).toBeDefined()

  // An ask from the relay, written 2 minutes ago: a warning on the review's row that blinks with the band tab, answered
  // from the card, its 10 minutes counted from when the relay wrote it.
  const askId = `${NOW / 1000 - 120}-42`
  files.set(`${workDir}/asks/ask-${askId}.json`, WEB_ASK)
  await github.clock.advance(1_000)
  expect(github.latest().reviews?.[ID]?.asks?.[0]).toMatchObject({ id: askId, tool: 'WebFetch', what: 'fetch https://docs.python.org/3/', ruleLabel: 'docs.python.org' })
  expect(summarizeGithub(github.latest())).toContain('🤖❓')
  const lit = githubTabTone(github.latest())
  await github.clock.advance(1_000)
  expect([lit, githubTabTone(github.latest())].sort()).toEqual(['warning', undefined].sort())
  expect(await ui.find({ type: 'Text', text: '⚠ Wants to fetch https://docs.python.org/3/' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'waiting for your answer · 1 step' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'denied in 8 min if unanswered' })).toBeDefined()
  expect(await ui.find({ key: askKey('once', askId, ID) })).toBeDefined()
  expect(await ui.find({ key: askKey('deny', askId, ID) })).toBeDefined()
  await ui.press({ key: askKey('review', askId, ID) })
  expect(files.get(`${workDir}/asks/answer-${askId}.json`)).toBe(
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"addRules","rules":[{"toolName":"WebFetch","ruleContent":"domain:docs.python.org"}],"behavior":"allow","destination":"session"}]}}}'
  )
  expect(github.latest().reviews?.[ID]?.asks?.[0]?.answer).toBe('review')
  expect(await ui.find({ key: askKey('once', askId, ID) })).toBeUndefined()
  // A read of a file in the copy that is a link out of it says where it lands.
  files.set(`${workDir}/asks/ask-1792331804-43.json`, JSON.stringify({ tool_name: 'Read', tool_input: { file_path: `${workDir}/tree/docs/key.md` }, permission_suggestions: [] }))
  await github.clock.advance(1_000)
  expect(github.latest().reviews?.[ID]?.asks?.[1]?.what).toBe('read docs/key.md, a link out of the copy to /home/t/.ssh/id_rsa')
  await ui.press({ key: askKey('deny', '1792331804-43', ID) })
  expect(files.get(`${workDir}/asks/answer-1792331804-43.json`)).toContain('"behavior":"deny"')

  // The end: the review beside its logs, the notice with Open, the bell, the copy gone.
  await github.clock.advance(3_000)
  const done = github.latest().reviews?.[ID]
  expect(done).toMatchObject({ phase: 'done', steps: 2 })
  const path = done?.path ?? ''
  expect(path).toMatch(new RegExp(`^${DOC_DIR}/acme__webapp/review-2086-\\d{8}-\\d{6}\\.md$`))
  expect(files.get(path)).toContain('Looks right.')
  expect(files.get(path)).toContain(`reading a clean copy of the pull request at ${SHA.slice(0, 7)}. Nothing was posted.`)
  expect(files.get(path.replace(/\.md$/, '.jsonl'))).toBe(`${[INIT_LINE, READ_LINE, fetchLine, RESULT_LINE].join('\n')}\n`)
  const log = files.get(done?.logPath ?? '') ?? ''
  expect(log).toContain(`- ${workDir}/tree`)
  expect(log).toContain('Read: reading src/a.ts')
  expect(log).toContain('WebFetch: fetch https://docs.python.org/3/ — allowed for this review at')
  expect(log).toContain('Read: read docs/key.md, a link out of the copy to /home/t/.ssh/id_rsa — denied at')
  expect(log).toContain('3 turns · $0.0420 · exit 0')
  expect(log).toContain(`Raw stream (every line the reviewer wrote): ${done?.streamPath}`)
  expect(log).toContain("CLAUDE_CODE_PLUGIN_DIRS='' claude -p")
  expect(github.latest().docs?.[0]).toMatchObject({ kind: 'review', path, itemId: ID })
  expect(notices.at(-1)?.find(notice => notice.topic === `github-review-${ID}`)).toMatchObject({ tone: 'success', title: 'Review of #2086 ready', action: { key: `github-review-act-open-${encodeItemId(ID)}`, label: 'Open' } })
  expect(notified).toEqual(['Review of #2086 ready'])
  expect(runs.at(-1)).toEqual(['rm', '-rf', workDir])
  // The raw stream opens in the person's own app, from the row's menu.
  await ui.press({ key: `github-review-row-${encodeItemId(ID)}` })
  await ui.press({ key: `github-review-act-raw-${encodeItemId(ID)}` })
  expect(runs).toContainEqual(['open', done?.streamPath])
  await ui.unmount()
})

test('no copy when the head commit is not here: diff only, Opus, no web, notice only; a reviewer that stops fails with Log and Retry', SLOW, async ($, on) => {
  const runs = mockCommands(on, false)
  const files = mockFiles(on)
  on('settings.read', () => ({ value: SESSION_SETTINGS }))
  let notifies = 0
  on('ui.notify', () => {
    notifies += 1

    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  const clock = mock.clock(on, { now: NOW })
  const spawned = mockReviewer(on, clock, [INIT_LINE], [], 1)
  const github = await setUp($, on, seeded(), { isHaikuOn: false, reviewModel: 'opus', isReviewWebOn: false }, clock)

  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'mobile', component: 'Pane', requestId: 'claudedockula', props: paneProps(60) })
  await ui.press({ key: `github-work-review-bg-${encodeItemId(ID)}` })
  expect(runs.some(argv => argv[2] === 'archive' || argv[0] === 'tar')).toBe(false)
  const job = github.latest().reviews?.[ID]
  expect(job?.noCopy).toBe('its head commit abcdef1 is not on this machine')
  expect(files.get(`${job?.workDir}/tree/NO-COPY.md`)).toContain('No copy')
  expect(await ui.find({ type: 'Text', text: /reviewing, diff only/ })).toBeDefined()
  const argv = spawned[0]?.argv ?? []
  expect(valueAfter(argv, '--model')).toBe('opus')
  expect(valueAfter(argv, '--tools')).toBe('Read,Grep,Glob')
  expect(JSON.parse(valueAfter(argv, '--settings') ?? '{}').permissions.allow).toEqual([])
  expect(valueAfter(argv, '--append-system-prompt')).toContain('There is no copy of the code (its head commit abcdef1 is not on this machine)')
  expect(spawned[0]?.input).toContain('There is no copy of the code here')

  await github.clock.advance(5_000)
  const failed = github.latest().reviews?.[ID]
  expect(failed).toMatchObject({ phase: 'failed', error: 'the reviewer stopped without an answer (exit 1)' })
  expect(notifies).toBe(0)
  expect(files.get(failed?.logPath ?? '')).toContain('boom')
  expect(runs.at(-1)).toEqual(['rm', '-rf', failed?.workDir])
  expect(await ui.find({ key: `github-review-inline-retry-${encodeItemId(ID)}` })).toBeDefined()
  await ui.press({ key: `github-review-inline-log-${encodeItemId(ID)}` })
  expect(opened).toContain('claudedockula-doc')
  const doc = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula-doc', props: paneProps(80) })
  expect(await doc.find({ type: 'Markdown', text: /no copy: its head commit abcdef1/ })).toBeDefined()
  await doc.unmount()
  await ui.unmount()
})

test('⚙ in the card header opens the settings: what this client can notify with, the model and web lookups, each saved', SLOW, async ($, on) => {
  mockCommands(on)
  on('config.list', () => ({
    value: [{ key: 'preferredNotifChannel', label: 'Notifications', kind: 'choice', value: 'terminal_bell', options: ['auto', 'terminal_bell'], provider: { plugin: 'engine', tier: 'core' }, isLocked: false }]
  }))
  const saved: unknown[] = []
  on('store.set', { key: 'github:settings' }, ($, e, next) => {
    saved.push(e.value)

    return next(e)
  })
  const github = await setUp($, on)
  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'mobile', component: 'Pane', requestId: 'claudedockula', props: paneProps(60) })
  await ui.press({ key: 'dock-main-settings-github' })
  expect(github.latest().ui?.isSettingsOpen).toBe(true)
  expect(await ui.find({ key: 'github-review-done-bell', text: /Notice \+ terminal bell/ })).toBeDefined()
  expect(await ui.find({ key: 'github-review-done-notify' })).toBeUndefined()
  for (const key of ['github-review-done-bell', 'github-review-model-opus', 'github-review-web-off']) await ui.press({ key })
  expect(github.latest().settings).toMatchObject({ reviewDone: 'bell', reviewModel: 'opus', isReviewWebOn: false })
  expect(saved.at(-1)).toMatchObject({ reviewDone: 'bell', reviewModel: 'opus', isReviewWebOn: false })
  await ui.press({ key: 'github-settings' })
  expect(github.latest().ui?.isSettingsOpen).toBe(false)
  await ui.unmount()
})

test('a waiting ask counts down and one past 10 minutes shows as denied; a reload ends the review and removes its copy', SLOW, async ($, on) => {
  const runs = mockCommands(on)
  mockFiles(on)
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const workDir = `${REVIEW_ROOT}/acme__webapp-2086-1`
  const running: GhReviewJob = {
    itemId: ID,
    title: ITEM.title,
    phase: 'running',
    startedAt: NOW - 700_000,
    workDir,
    steps: 4,
    asks: [
      { id: '1-1', tool: 'WebFetch', what: 'fetch https://docs.python.org/3/', askedAt: NOW - 60_000 },
      { id: '1-2', tool: 'Read', what: 'read ~/notes.md', askedAt: NOW - 650_000, answer: 'timeout', answeredAt: NOW - 50_000 }
    ]
  }
  const github = await setUp($, on, { ...seeded(), reviews: { [ID]: running } })
  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'mobile', component: 'Pane', requestId: 'claudedockula', props: paneProps(60) })
  expect(await ui.find({ type: 'Text', text: 'denied in 9 min if unanswered' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 ask went unanswered for 10 min and was denied' })).toBeDefined()
  expect(await ui.find({ key: askKey('once', '1-2', ID) })).toBeUndefined()
  await ui.unmount()

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(github.latest().reviews?.[ID]).toMatchObject({ phase: 'failed', error: 'interrupted by a reload — Retry' })
  expect(runs).toContainEqual(['rm', '-rf', workDir])
})

test('a session that never ticked GitHub in sets nothing up; ticking it in reads the files list', SLOW, async ($, on) => {
  mock.clock(on, { now: NOW })
  const link = { kind: 'review', title: 'Review #2071 · Add CSV export option', path: `${DOC_DIR}/acme__webapp/review-2071-20261016-0629.md`, createdAt: NOW - 60_000 }
  mock.store(on, { 'github:settings': { isHaikuOn: false }, 'github:docs': [link] })
  mock.env(on, { HOME: '/home/t' })
  mockCommands(on)
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: true }))
  const github = trackGithub(on, {})

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(60) })
  await pane.press({ key: 'dock-main-manage' })
  expect(github.writes.some(state => state.docs !== undefined)).toBe(false)

  await pane.press({ key: 'dock-main-enable-1-github' })
  await pane.press({ key: 'dock-main-manage' })
  expect(github.latest().docs).toEqual([link])
  await pane.unmount()
})

test('📝 PR description: the branch facts go to Haiku, the answer is written under the doc folder and opens in the doc pane', SLOW, async ($, on) => {
  mockCommands(on)
  const asks: string[] = []
  const written = new Map<string, string>()
  const opened: string[] = []
  on('model.complete', ($, e) => {
    asks.push(e.prompt)

    return { value: { isAnswered: true, text: '## Summary\nAdds a CSV encoding choice.', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('fs.write', ($, e) => {
    written.set(e.path, e.text)

    return { value: undefined }
  })
  on('fs.read', ($, e) => ({ value: written.get(e.path) ?? '' }))
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  const github = await setUp($, on)

  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'mobile', component: 'Pane', requestId: 'claudedockula', props: paneProps(60) })
  await ui.press({ key: 'github-gen-pr' })
  expect(asks.some(prompt => prompt.includes('Add CSV export option'))).toBe(true)
  const [path, text] = [...written.entries()][0] ?? []
  expect(path).toMatch(new RegExp(`^${DOC_DIR}/acme__webapp/pr-description-ABC-964-csv-export-\\d{8}-\\d{4}\\.md$`))
  expect(text).toBe('## Summary\nAdds a CSV encoding choice.\n')
  expect(github.latest().gen?.['pr-description']?.phase).toBe('done')

  await ui.press({ key: `github-doc-open-${github.latest().docs?.[0]?.createdAt}` })
  expect(opened).toContain('claudedockula-doc')
  const doc = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula-doc', props: paneProps(80) })
  expect(await doc.find({ type: 'Markdown', text: /Adds a CSV encoding choice/ })).toBeDefined()
  expect(await doc.find({ key: 'github-docpane-os' })).toBeDefined()
  await doc.unmount()
  await ui.unmount()
})

test('⏹ Stop denies every waiting ask, then leaves the reviewer at once: it fails saying so, and its copy goes', SLOW, async ($, on) => {
  const runs = mockCommands(on)
  const files = mockFiles(on)
  on('settings.read', () => ({ value: {} }))
  const clock = mock.clock(on, { now: NOW })
  mockReviewer(on, clock, [INIT_LINE, READ_LINE], [RESULT_LINE], 0, 3_600_000)
  const github = await setUp($, on, seeded(), { isHaikuOn: false }, clock)
  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'mobile', component: 'Pane', requestId: 'claudedockula', props: paneProps(60) })
  await ui.press({ key: `github-work-review-bg-${encodeItemId(ID)}` })
  // One ask the card shows, one the relay wrote just now: Stop denies both, then leaves the stream at once.
  files.set(`${WORK_DIR}/asks/ask-1792132100-1.json`, JSON.stringify({ tool_name: 'WebSearch', tool_input: { query: 'x' } }))
  await clock.advance(1_000)
  expect(github.latest().reviews?.[ID]?.asks?.[0]?.id).toBe('1792132100-1')
  files.set(`${WORK_DIR}/asks/ask-1792132201-2.json`, JSON.stringify({ tool_name: 'WebFetch', tool_input: { url: 'https://x.org' } }))
  await ui.press({ key: `github-review-row-${encodeItemId(ID)}` })
  await ui.press({ key: `github-review-act-stop-${encodeItemId(ID)}` })
  const deny = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"The person denied this in the ClaudeDockula panel. Carry on without it."}}}'
  expect(files.get(`${WORK_DIR}/asks/answer-1792132100-1.json`)).toBe(deny)
  expect(files.get(`${WORK_DIR}/asks/answer-1792132201-2.json`)).toBe(deny)
  await clock.settle()
  expect(github.latest().reviews?.[ID]).toMatchObject({ phase: 'failed', error: 'stopped' })
  expect(github.latest().reviews?.[ID]?.asks?.[0]?.answer).toBe('deny')
  expect(runs.at(-1)).toEqual(['rm', '-rf', WORK_DIR])
  await ui.unmount()
})

test('no safe temp folder or an old git: the card says why; nothing is made under the working directory, no copy is made', SLOW, async ($, on) => {
  const runs = mockCommands(on, true, '2.39.5')
  const files = mockFiles(on)
  on('settings.read', () => ({ value: {} }))
  const clock = mock.clock(on, { now: NOW })
  const spawned = mockReviewer(on, clock, [INIT_LINE], [RESULT_LINE])
  const github = await setUp($, on, seeded(), { isHaikuOn: false }, clock, { HOME: '/home/t', TMPDIR: 'tmp' })
  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'mobile', component: 'Pane', requestId: 'claudedockula', props: paneProps(60) })
  await ui.press({ key: `github-work-review-bg-${encodeItemId(ID)}` })
  expect(github.latest().reviews?.[ID]).toMatchObject({ phase: 'failed', error: 'TMPDIR ("tmp") is not an absolute folder, so there is nowhere safe for the review\'s copy' })
  expect([...files.keys()].filter(path => !path.startsWith('/'))).toEqual([])
  expect(spawned).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /TMPDIR \("tmp"\) is not an absolute folder/ })).toBeDefined()
  await ui.unmount()
  expect(runs.some(argv => argv.includes('archive'))).toBe(false)
})

test('a git older than 2.41: no copy, the card and the review file say why', SLOW, async ($, on) => {
  const runs = mockCommands(on, true, '2.39.5')
  const files = mockFiles(on)
  on('settings.read', () => ({ value: {} }))
  const clock = mock.clock(on, { now: NOW })
  mockReviewer(on, clock, [INIT_LINE], [RESULT_LINE])
  const github = await setUp($, on, seeded(), { isHaikuOn: false }, clock)
  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'mobile', component: 'Pane', requestId: 'claudedockula', props: paneProps(60) })
  await ui.press({ key: `github-work-review-bg-${encodeItemId(ID)}` })
  expect(github.latest().reviews?.[ID]?.noCopy).toBe('git 2.39 is older than 2.41, which the clean copy needs')
  expect(await ui.find({ type: 'Text', text: /reviewing, diff only/ })).toBeDefined()
  expect(runs.some(argv => argv.includes('archive') || argv[2] === 'cat-file')).toBe(false)
  await clock.advance(5_000)
  expect(files.get(github.latest().reviews?.[ID]?.path ?? '')).toContain('with no copy of the code (git 2.39 is older than 2.41, which the clean copy needs)')
  await ui.unmount()
})
