import type { ProcessRunResult, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { PANELS } from '../hooks/panels'
import { isAllowedArgv } from '../hooks/panels/github/argv'

// The whole GitHub panel, main path: ticked in, `gh` answers, the band says it, a row opens, an action fills the prompt, the overlap opens.

const NOW = Date.parse('2026-10-16T12:00:00Z')
const REPO = 'acme/webapp'
const LIST = { in: 'github-list-main' }

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
  mock.store(on, { 'panels:seen': seen, 'github:settings': { isHaikuOn: false } })
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
  for (const key of ['dock-main-manage', 'dock-main-enable-1-github', 'dock-main-manage']) await pane.press({ key })
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
  await clock.advance(60_000)
  await pane.press({ key: 'github-refresh' })
  const tab = await band.find({ key: 'dock-tab-github' })
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
  await pane.press({ key: 'github-overlap-toggle' })
  expect(textOf(await pane.drawn())).toContain('a.ts')
  expect(argvs.filter(argv => !isAllowedArgv(argv))).toEqual([])
  await band.unmount()
  await pane.unmount()
})
