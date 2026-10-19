import type { ProcessRunResult, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { PANELS } from '../hooks/panels'
import { isAllowedArgv } from '../hooks/panels/gitgud/guard'

/** The Branch card's own read-only worktree listing runs in the same session; the guard is GitGud's. */
function isBranchWorktreeRead(argv: readonly string[]): boolean {
  return argv[0] === 'git' && argv.includes('worktree') && argv.includes('list')
}

// The whole GitGud panel, main path: ticked in, `gh` answers, the band says it, a row opens, an action fills the prompt, the overlap opens.

const NOW = Date.parse('2026-10-16T12:00:00Z')
const REPO = 'acme/webapp'
const LIST = { in: 'gitgud-list-main' }

function ran(exitCode: number, stdout: string): ProcessRunResult {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function prNode(number: number, fields: { author?: string; ci?: string } = {}): object {
  return {
    number,
    title: `ABC-${number} / Change ${number}`,
    url: `https://github.com/${REPO}/pull/${number}`,
    updatedAt: '2026-10-15T09:00:00Z',
    isDraft: false,
    reviewDecision: null,
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

const LISTS = JSON.stringify({
  data: {
    viewer: { login: 'octocat' },
    rateLimit: { cost: 1, remaining: 4990, resetAt: '2026-10-16T13:00:00Z' },
    review: { issueCount: 1, nodes: [prNode(2086)] },
    mine: { issueCount: 2, nodes: [prNode(2068, { author: 'octocat', ci: 'FAILURE' }), prNode(2071, { author: 'octocat' })] },
    issues: { issueCount: 0, nodes: [] }
  }
})
/** Another open PR that touches a file changed here. */
const OTHER_PRS = JSON.stringify([
  { number: 2090, title: 'PR 2090', author: { login: 'linus' }, headRefName: 'ABC-2090/work', url: `https://github.com/${REPO}/pull/2090`, changedFiles: 1, files: [{ path: 'src/a.ts' }] }
])

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('\n')
  if (typeof node === 'object' && node !== null && 'children' in node) return textOf(node.children)

  return ''
}

test('ticked in, the band counts the lists, a row opens and fills the prompt, the overlap unfolds', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = Object.fromEntries(PANELS.map(panel => [panel.id, panel.revision ?? 1]))
  mock.store(on, { 'panels:seen': seen, 'gitgud:settings': { isHaikuOn: false } })
  const argvs: string[][] = []
  const filled: string[] = []
  on('process.run', ($, e) => {
    argvs.push([...e.argv])
    const [command, group, action] = e.argv
    if (command === 'git' && e.argv.includes('status')) return { value: ran(0, ' M src/a.ts\0') }
    if (command === 'git' && e.argv.includes('merge-base')) return { value: ran(1, '') }
    if (command === 'git') return { value: ran(0, 'feat/x\n') }
    if (group === 'auth') return { value: ran(0, '') }
    if (group === 'repo') return { value: ran(0, JSON.stringify({ nameWithOwner: REPO, url: `https://github.com/${REPO}`, defaultBranchRef: { name: 'develop' } })) }
    if (group === 'api') return { value: ran(0, LISTS) }
    if (group === 'pr' && action === 'list') return { value: ran(0, OTHER_PRS) }
    if (group === 'pr' && action === 'checks') return { value: ran(0, '[]') }

    return { value: ran(1, '') }
  })
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.list', () => ({ value: [{ name: 'pr-review', description: 'Review a PR', source: 'user' as const }] }))
  on('ui.panes', () => ({ value: [] }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  const paneProps: RenderPropsOf['Pane'] = { title: 'Dock', isFocused: true, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }
  const bandProps: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 7 }, view: {} }

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps })
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
  await clock.advance(60_000)
  await pane.press({ key: 'gitgud-refresh' })
  const tab = await band.find({ key: 'dock-tab-gitgud' })
  expect(tab?.text).toMatch(/^🐙 1 to review · 2 mine ❌1 ⚠1/)

  // The real list: a click opens the first row, the open row's right-click menu offers Review here first.
  expect(textOf(await pane.drawn(LIST))).toContain('#2086')
  await pane.pointer({ type: 'down', x: 10, y: 0, button: 'left', ...LIST })
  await pane.pointer({ type: 'up', x: 10, y: 0, button: 'left', ...LIST })
  expect(textOf(await pane.drawn(LIST))).toContain('ABC-2086/work → develop')
  await pane.pointer({ type: 'down', x: 10, y: 0, button: 'right', ...LIST })
  expect(textOf(await pane.drawn(LIST))).toContain('Review here')
  await pane.key({ key: 'return', ...LIST })
  expect(filled).toEqual([`/pr-review https://github.com/${REPO}/pull/2086`])

  // The overlap section is closed until its ▸ is pressed.
  expect(textOf(await pane.drawn())).not.toContain('a.ts')
  await pane.press({ key: 'gitgud-overlap-toggle' })
  expect(textOf(await pane.drawn())).toContain('a.ts')
  expect(argvs.filter(argv => !isAllowedArgv(argv) && !isBranchWorktreeRead(argv))).toEqual([])
  await band.unmount()
  await pane.unmount()
})

test('Reset all settings forgets GitGud settings and its open ⚙, reads again, and refills the alert ledger without alerts', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = Object.fromEntries(PANELS.map(panel => [panel.id, panel.revision ?? 1]))
  const argvs: string[][] = []
  const states: { settings?: { pollSeconds?: number }; ui?: { isSettingsOpen?: boolean } }[] = []
  const notices: unknown[] = []
  const stored = new Map<string, unknown>()
  on('store.set', { key: 'gitgud:alerted' }, ($, e, next) => {
    stored.set(e.key, e.value)

    return next(e)
  })
  mock.store(on, { 'panels:seen': seen, 'gitgud:settings': { isHaikuOn: false, pollSeconds: 300 } })
  on('process.run', ($, e) => {
    argvs.push([...e.argv])
    const [command, group, action] = e.argv
    if (command === 'git' && e.argv.includes('status')) return { value: ran(0, '') }
    if (command === 'git' && e.argv.includes('merge-base')) return { value: ran(1, '') }
    if (command === 'git') return { value: ran(0, 'feat/x\n') }
    if (group === 'auth') return { value: ran(0, '') }
    if (group === 'repo') return { value: ran(0, JSON.stringify({ nameWithOwner: REPO, url: `https://github.com/${REPO}`, defaultBranchRef: { name: 'develop' } })) }
    if (group === 'api') return { value: ran(0, LISTS) }
    if (group === 'pr' && action === 'list') return { value: ran(0, '[]') }
    if (group === 'pr' && action === 'checks') return { value: ran(0, '[]') }

    return { value: ran(1, '') }
  })
  on('state.set', { key: 'gitgud' }, ($, e, next) => {
    if (e.key === 'gitgud') states.push(e.value)

    return next(e)
  })
  on('state.set', { key: 'notices' }, ($, e, next) => {
    notices.push(e.value)

    return next(e)
  })
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }))
  const paneProps: RenderPropsOf['Pane'] = { title: 'Dock', isFocused: true, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps })
  await clock.advance(60_000)
  await pane.press({ key: 'dock-main-settings-gitgud' })
  expect(states.at(-1)?.ui?.isSettingsOpen).toBe(true)
  expect(states.at(-1)?.settings?.pollSeconds).toBe(300)

  // ⚙ Manage empties the store, then the panels hear of it.
  stored.clear()
  const noticesBefore = notices.length
  for (const key of ['dock-main-manage', 'dock-main-reset-all', 'dock-main-reset-all-yes']) await pane.press({ key })
  await clock.advance(60_000)
  expect(states.at(-1)?.ui?.isSettingsOpen).not.toBe(true)
  expect(states.at(-1)?.settings?.pollSeconds).toBeUndefined()
  expect(stored.get('gitgud:alerted')).toBeDefined()
  const topics = notices.slice(noticesBefore).flatMap(list => (Array.isArray(list) ? list.map((notice: unknown) => (typeof notice === 'object' && notice !== null && 'topic' in notice ? notice.topic : undefined)) : []))
  expect(topics.filter(topic => topic !== 'reset')).toEqual([])
  expect(argvs.filter(argv => argv.some(part => part === 'security' || part === 'secret-tool'))).toEqual([])
  await pane.unmount()
})
