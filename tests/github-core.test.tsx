import type { On, ProcessRunResult, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { PANELS } from '../hooks/panels'
import { isAllowedArgv } from '../hooks/panels/github/argv'

// The core wiring (github.tsx) against a mocked `gh`: poll → state → band, alerts once, row actions, the read-only guard.

const NOW = Date.parse('2026-10-16T12:00:00Z')
const REPO = 'acme/webapp'
const LIST = { in: 'github-list-main' }
/** The dock tests mount several panes; a busy machine takes them past the default 5 s. */
const SLOW = { timeoutMs: 20_000 }

function ran(exitCode: number, stdout: string, stderr = ''): ProcessRunResult {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

/** One search node as the GraphQL fragment returns it. */
function prNode(number: number, fields: { title?: string; author?: string; ci?: string; review?: string | null } = {}): object {
  return {
    number,
    title: fields.title ?? `ABC-${number} / Change ${number}`,
    url: `https://github.com/${REPO}/pull/${number}`,
    updatedAt: '2026-10-15T09:00:00Z',
    isDraft: false,
    reviewDecision: fields.review ?? null,
    headRefName: `ABC-${number}/work`,
    baseRefName: 'develop',
    headRefOid: `sha${number}`,
    bodyText: 'Body.',
    author: { login: fields.author ?? 'grace' },
    repository: { nameWithOwner: REPO },
    comments: { totalCount: 0 },
    labels: { nodes: [] },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'octocat' } }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: fields.ci ?? 'SUCCESS' } } }] }
  }
}

function listsJson(review: object[], mine: object[]): string {
  const data = {
    viewer: { login: 'octocat' },
    rateLimit: { cost: 1, remaining: 4990, resetAt: '2026-10-16T13:00:00Z' },
    review: { issueCount: review.length, nodes: review },
    mine: { issueCount: mine.length, nodes: mine },
    issues: { issueCount: 0, nodes: [] }
  }

  return JSON.stringify({ data })
}

const MINE = prNode(2068, { author: 'octocat', ci: 'FAILURE', review: 'CHANGES_REQUESTED' })
const CHECKS = JSON.stringify([
  { name: 'Lint & Build', bucket: 'fail', state: 'FAILURE', workflow: 'CI', link: `https://github.com/${REPO}/actions/runs/111/job/222` },
  { name: 'Test', bucket: 'pass', state: 'SUCCESS', workflow: 'CI', link: `https://github.com/${REPO}/actions/runs/111/job/223` }
])
// tput's reset (`ESC ( B ESC [ m`) after the error: a control character in a drawn row would get the list refused.
const JOB_LOG = [
  "build\tRun tsc\t2026-10-15T07:18:06.3245564Z src/a.ts(3,1): error TS2322: Type 'x' is wrong.\u001b(B\u001b[m",
  'build\tRun tsc\t2026-10-15T07:18:09.6633215Z ##[error]Process completed with exit code 2.'
].join('\n')

interface GhMock {
  /** What the next poll answers. */
  lists: string
  /** GitHub out of reach: `gh auth status` calls the token invalid, every other call can't connect. */
  isOffline: boolean
  argvs: string[][]
  filled: string[]
  copied: string[]
}

/** `gh` and `git` by argv, the prompt box, the clipboard and the command list. */
function mockGh(on: On): GhMock {
  const title = '\u001b[1mABC-2086\u001b(B / Change\u0007 2086'
  const gh: GhMock = { lists: listsJson([prNode(2086, { title })], [MINE]), isOffline: false, argvs: [], filled: [], copied: [] }
  on('process.run', ($, e) => {
    gh.argvs.push([...e.argv])
    const [command, group, action] = e.argv
    if (command === 'git') return { value: ran(0, 'ABC-1/work\n') }
    if (gh.isOffline && group === 'auth') return { value: ran(1, 'X Failed to log in to github.com account octocat (keyring)\n- The token in keyring is invalid.\n- To re-authenticate, run: gh auth login -h github.com') }
    if (gh.isOffline) return { value: ran(1, '', 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com') }
    if (group === 'auth') return { value: ran(0, '', 'Logged in to github.com account octocat') }
    if (group === 'repo') return { value: ran(0, JSON.stringify({ nameWithOwner: REPO, url: `https://github.com/${REPO}`, defaultBranchRef: { name: 'develop' } })) }
    if (group === 'api') return { value: ran(0, gh.lists) }
    if (group === 'pr' && action === 'checks') return { value: ran(1, CHECKS) }
    if (group === 'run') return { value: ran(0, JOB_LOG) }

    return { value: ran(1, '', 'unexpected') }
  })
  on('command.list', () => ({ value: [{ name: 'pr-review', description: 'Review a PR', source: 'user' as const }] }))
  on('ui.panes', () => ({ value: [] }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    gh.filled.push(e.text)

    return { isFilled: true }
  })
  on('ui.copy', ($, e) => {
    gh.copied.push(e.text)

    return { value: { isCopied: true } }
  })

  return gh
}

function paneProps(): RenderPropsOf['Pane'] {
  return { title: 'Dock', isFocused: true, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }
}

function bandProps(): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 7 }, view: {} }
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('\n')
  if (typeof node === 'object' && node !== null && 'children' in node) return textOf(node.children)

  return ''
}

/** Every panel already announced and Haiku off, so the only notices are the panel's alerts and the dock asks no model. */
function startStore(on: On): void {
  const seen = Object.fromEntries(PANELS.map(panel => [panel.id, panel.revision ?? 1]))
  mock.store(on, { 'panels:seen': seen, 'github:settings': { isHaikuOn: false } })
}

async function tickIn(pane: { press: (args: { key: string }) => Promise<unknown> }): Promise<void> {
  for (const key of ['dock-main-manage', 'dock-main-enable-1-github', 'dock-main-manage']) await pane.press({ key })
}

test('ticked in, one poll fills the lists and the band; a new review request alerts once, never again', SLOW, async ($, on) => {
  mock.clock(on, { now: NOW })
  startStore(on)
  const gh = mockGh(on)
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps() })
  await tickIn(pane)
  expect(textOf(await pane.drawn(LIST))).toContain('#2086')
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps() })
  expect((await band.find({ key: 'dock-tab-github' }))?.text).toBe('🐙 1 to review · 1 mine ❌1')
  // The first sight of a scope only records what is there.
  expect(await band.findAll({ type: 'Text', text: /Review requested|CI failed/ })).toHaveLength(0)

  gh.lists = listsJson([prNode(2086), prNode(2090, { title: 'Add the GitHub panel' })], [MINE])
  await pane.press({ key: 'github-refresh' })
  expect((await band.find({ key: 'dock-tab-github' }))?.text).toBe('🐙 2 to review · 1 mine ❌1')
  expect(await band.findAll({ type: 'Text', text: /👀 Review requested: #2090 Add the GitHub panel/ })).toHaveLength(1)
  expect(await band.find({ type: 'Text', text: /#2086/ })).toBeUndefined()

  const close = (await band.findAll({ type: 'Button' })).find(found => found.key?.startsWith('dock-notice-x-'))
  expect(close).toBeDefined()
  await band.press({ key: close?.key ?? '' })
  await pane.press({ key: 'github-refresh' })
  expect(await band.find({ type: 'Text', text: /Review requested/ })).toBeUndefined()
  await band.unmount()
  await pane.unmount()
})

test('row actions fill the prompt or the clipboard; a checkout is only filled, and every command run is read-only', SLOW, async ($, on) => {
  mock.clock(on, { now: NOW })
  startStore(on)
  const gh = mockGh(on)
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps() })
  await tickIn(pane)
  const id = `${REPO}#2086`

  await pane.post({ type: 'act', action: 'checkout', id }, LIST)
  await pane.post({ type: 'act', action: 'review-here', id }, LIST)
  await pane.post({ type: 'act', action: 'copy-link', id }, LIST)
  expect(gh.filled).toEqual(['! gh pr checkout 2086', `/pr-review https://github.com/${REPO}/pull/2086`])
  expect(gh.copied).toEqual([`https://github.com/${REPO}/pull/2086`])

  // Opening my failing PR reads its checks, then the failed job's log for why.
  await pane.press({ key: 'github-view-mine' })
  await pane.post({ type: 'open', id: `${REPO}#2068` }, LIST)
  expect(gh.argvs).toContainEqual(['gh', 'run', 'view', '111', '--job', '222', '--log-failed', '--repo', REPO])
  expect(textOf(await pane.drawn(LIST))).toContain("src/a.ts(3,1): error TS2322: Type 'x' is wrong.")

  expect(gh.argvs.length).toBeGreaterThan(3)
  expect(gh.argvs.filter(argv => !isAllowedArgv(argv))).toEqual([])
  expect(gh.argvs.some(argv => argv.includes('checkout'))).toBe(false)
  expect(isAllowedArgv(['gh', 'pr', 'checkout', '2086'])).toBe(false)
  await pane.unmount()
})

test('offline at the start is no sign-out: the card says GitHub is out of reach, then recovers by itself', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  startStore(on)
  const gh = mockGh(on)
  gh.isOffline = true
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps() })
  await tickIn(pane)
  await clock.settle()
  expect(await pane.find({ type: 'Text', text: /Couldn't reach GitHub/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Sign in to GitHub/ })).toBeUndefined()
  expect(await pane.find({ key: 'github-login' })).toBeUndefined()

  gh.isOffline = false
  await clock.advance(10 * 60_000)
  expect(textOf(await pane.drawn(LIST))).toContain('#2086')
  await pane.unmount()
})
