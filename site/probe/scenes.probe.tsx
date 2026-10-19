// Draws the plugin's real panels with made-up data and prints the drawn trees, for the landing page's terminal frames.
// Not a test of the plugin: site/tools/snapshot.mjs copies it into a throwaway copy of the repo as tests/probe.test.tsx,
// runs `claude plugin test` there, and lays the printed trees out into rows (site/frames.json).
import type { McpToolResult, On, ProcessRunResult, RenderPropsOf, UiPane } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { PANELS } from '../hooks/panels'
import { drawCard } from '../hooks/dock/ui'
import { drawGitgud } from '../hooks/panels/gitgud/draw'
import GitgudList from '../hooks/panels/gitgud/GitgudList'
import { buildListProps } from '../hooks/panels/gitgud/rows'
import type { GhItem, GitgudState } from '../types'

const NOW = Date.parse('2026-10-16T12:00:00Z')
const REPO = 'acme/webapp'
const SLOW = { timeoutMs: 60_000 }

function ran(exitCode: number, stdout: string, stderr = ''): ProcessRunResult {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}
function json(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }
}
function paneProps(bodyColumns: number): RenderPropsOf['Pane'] {
  return { title: 'Dock', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }
}
function bandProps(bodyColumns: number, maxRows = 20): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows, bodyColumns, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} }
}

type Mounted = { drawn: (q?: { in: string }) => Promise<unknown> }
function nodes(tree: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (typeof tree === 'object' && tree !== null) {
    out.push(tree as Record<string, unknown>)
    const c = (tree as { children?: unknown }).children
    if (Array.isArray(c)) for (const x of c) nodes(x, out)
  }
  return out
}
/** The drawn tree with every Client's own drawing spliced in under it. */
async function full(ui: Mounted, q?: { in: string }): Promise<unknown> {
  const tree = await ui.drawn(q)
  for (const node of nodes(tree)) {
    if (node.type === 'Client') {
      const key = (node.props as { key?: string }).key
      if (key) {
        try { node.children = [await full(ui, { in: key })] } catch { node.children = [] }
      }
    }
  }
  return tree
}
async function dump(name: string, ui: Mounted): Promise<void> {
  console.log(`@@FRAME ${name} ${JSON.stringify(await full(ui))}`)
}

const GIT_STATUS = [
  '# branch.oid a1b2c3d4e5f0000000000000000000000000000',
  '# branch.head ABC-123/csv-export',
  '# branch.upstream origin/ABC-123/csv-export',
  '# branch.ab +2 -0',
  '1 .M N... 100644 100644 100644 a1b2c3d e4f5a6b src/export/csv.ts',
  '1 M. N... 100644 100644 100644 a1b2c3d e4f5a6b src/export/ExportButton.tsx',
  '? src/export/csv.test.ts',
  ''
].join('\n')

function prNode(number: number, f: { title: string; head?: string; author?: string; ci?: string; review?: string | null; comments?: number; draft?: boolean }): object {
  return {
    number, title: f.title, url: `https://github.com/${REPO}/pull/${number}`, updatedAt: '2026-10-16T09:00:00Z', isDraft: f.draft ?? false,
    reviewDecision: f.review ?? null, headRefName: f.head ?? `ABC-${number}/work`, baseRefName: 'main', headRefOid: `sha${number}`, bodyText: 'Body.',
    author: { login: f.author ?? 'grace' }, repository: { nameWithOwner: REPO }, comments: { totalCount: f.comments ?? 0 }, labels: { nodes: [] },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'octocat' } }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: f.ci ?? 'SUCCESS' } } }] }
  }
}
const REVIEW_PRS = [
  prNode(2086, { title: 'ABC-131 / Date range picker', head: 'ABC-131/date-range', author: 'grace', comments: 2 }),
  prNode(2090, { title: 'Fix sidebar overflow on narrow screens', head: 'fix/sidebar-overflow', author: 'linus', ci: 'PENDING' }),
  prNode(2093, { title: 'Bump the chart library to v5', head: 'chore/charts-v5', author: 'ada' })
]
const MINE_PRS = [prNode(2079, { title: 'ABC-123 / Stream large CSV exports', head: 'ABC-123/csv-export', author: 'octocat', review: 'APPROVED' })]
function listsJson(): string {
  return JSON.stringify({ data: {
    viewer: { login: 'octocat' }, rateLimit: { cost: 1, remaining: 4990, resetAt: '2026-10-16T13:00:00Z' },
    review: { issueCount: REVIEW_PRS.length, nodes: REVIEW_PRS }, mine: { issueCount: MINE_PRS.length, nodes: MINE_PRS }, issues: { issueCount: 0, nodes: [] }
  } })
}

const SITES = [{ id: 'abc', url: 'https://acme.atlassian.net' }]
const BRANCH_ISSUE = { key: 'ABC-123', fields: { summary: 'Stream large CSV exports', status: { name: 'In Dev' }, description: '### Acceptance criteria\n\n* Exports over 50k rows stream\n* Progress shows in the toast' } }
const SEARCH: { issues: Array<{ key: string; fields: { summary: string; status: { name: string; id: string; statusCategory: { key: string } } } }> } = { issues: [
  { key: 'ABC-140', fields: { summary: 'Remember the last export format', status: { name: 'To Do', id: '10001', statusCategory: { key: 'new' } } } },
  { key: 'ABC-137', fields: { summary: 'Empty state for saved views', status: { name: 'To Do', id: '10001', statusCategory: { key: 'new' } } } },
  { key: 'ABC-123', fields: { summary: 'Stream large CSV exports', status: { name: 'In Dev', id: '10002', statusCategory: { key: 'indeterminate' } } } },
  { key: 'ABC-131', fields: { summary: 'Date range picker for reports', status: { name: 'In Review', id: '10003', statusCategory: { key: 'indeterminate' } } } },
  { key: 'ABC-118', fields: { summary: 'Retry failed webhooks', status: { name: 'Done', id: '10004', statusCategory: { key: 'done' } } } }
] }
const BOARDS = { data: { values: [{ id: 357, name: 'Web Board', type: 'kanban' }] } }
const COLUMNS = [
  { name: 'To Do', statuses: [{ id: '10001', name: 'To Do', category: 'new' }] },
  { name: 'In Dev', statuses: [{ id: '10002', name: 'In Dev', category: 'indeterminate' }] },
  { name: 'In Review', statuses: [{ id: '10003', name: 'In Review', category: 'indeterminate' }] },
  { name: 'Done', statuses: [{ id: '10004', name: 'Done', category: 'done' }] }
]
const TRANSITIONS = { transitions: [
  { id: '81', name: 'In Dev', to: { id: '10002', name: 'In Dev' } },
  { id: '91', name: 'In Review', to: { id: '10003', name: 'In Review' } },
  { id: '61', name: 'Done', to: { id: '10004', name: 'Done' } }
] }
const JIRA_SETTINGS = { server: 'atlassian', flavour: 'standard', boardServer: 'claude.ai Atlassian MCP', site: { cloudId: 'abc', url: 'https://acme.atlassian.net' } }

const ME = 'U08ME'
function tsAgo(minutes: number): string {
  return (NOW / 1000 - minutes * 60).toFixed(6)
}
interface Block { channel: string; channelId: string; from: string; fromId: string; ts: string; text: string; threadTs?: string; participants?: string }
function resultBlock(block: Block, index: number, total: number): string {
  const thread = block.threadTs ? `?thread_ts=${block.threadTs}&cid=${block.channelId}` : ''
  const link = `https://acme.slack.com/archives/${block.channelId}/p${block.ts.replace('.', '')}${thread}`
  return [`### Result ${index + 1} of ${total}`, `Channel: ${block.channel} (ID: ${block.channelId})`, ...(block.participants ? [`Participants: ${block.participants}`] : []),
    `From: ${block.from} <someone@acme.io> (ID: ${block.fromId}) `, 'Time: 2026-10-16 11:04:50 UTC', `Message_ts: ${block.ts}`, `Permalink: [link](${link})`, 'Text: ', block.text, '', '---', ''].join('\n')
}
function searchText(blocks: readonly Block[]): string {
  return `# Search Results for: \n\n## Messages (${blocks.length} results)\n${blocks.map((b, i) => resultBlock(b, i, blocks.length)).join('\n')}`
}
const MENTION: Block = { channel: '#dev-app', channelId: 'C1', from: 'grace', fromId: 'U07', ts: tsAgo(12), text: '<@U08ME|ada> can you look at <https://acme.atlassian.net/browse/ABC-131|ABC-131> before standup? :eyes:' }
const DM: Block = { channel: 'DM', channelId: 'D1', participants: `linus (ID: U09), ada (ID: ${ME})`, from: 'linus', fromId: 'U09', ts: tsAgo(4), text: 'the export toggle is back on staging, want to pair on the flaky test?' }
const DM_OLD: Block = { ...DM, ts: tsAgo(90), text: 'lunch at 1?' }
const REPLY: Block = { channel: '#dev-app', channelId: 'C1', from: 'octocat', fromId: 'U11', ts: tsAgo(30), threadTs: tsAgo(200), text: 'Merged the retry fix, deploy goes out at 3' }
function answerOf(field: string, text: string): { value: McpToolResult } {
  return { value: { content: [{ type: 'text', text: JSON.stringify({ [field]: text }) }], isError: false } }
}
function slackAnswer(tool: string, args: Record<string, unknown>): { value: McpToolResult } {
  if (tool === 'slack_read_user_profile') return answerOf('result', `User ID: ${ME}\nDisplay Name: ada\n`)
  if (tool !== 'slack_search_public_and_private') return answerOf('messages', '')
  const { keywords, channel_types: channelTypes, filters } = args
  if (Array.isArray(keywords) && keywords.includes(`<@${ME}>`)) return answerOf('results', searchText([MENTION]))
  if (channelTypes === 'im,mpim') return answerOf('results', searchText([DM, DM_OLD]))
  if (typeof filters === 'string' && filters.includes('is:thread')) return answerOf('results', searchText([REPLY]))
  return answerOf('results', searchText([]))
}

function mockAll(on: On, opts: { gitgud?: boolean } = {}): void {
  const seen = Object.fromEntries(PANELS.map(panel => [panel.id, panel.revision ?? 1]))
  mock.store(on, {
    'panels:seen': seen,
    'gitgud:settings': { isHaikuOn: false },
    settings: { jira: JIRA_SETTINGS },
    'settings:/repo': { checks: [
      { id: 'types', name: 'Types', argv: ['pnpm', 'exec', 'tsc', '--noEmit'] },
      { id: 'lint', name: 'Lint', argv: ['pnpm', 'lint'] },
      { id: 'test', name: 'Unit tests', argv: ['pnpm', 'test'] },
      { id: 'build', name: 'Build', argv: ['pnpm', 'build'] }
    ] }
  })
  on('session.root', () => ({ value: '/repo' }))
  on('session.start', () => ({ cwd: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  const panes = new Set<string>()
  on('ui.open', ($, e) => { panes.add(e.id); return { value: { isPlaced: true } } })
  on('ui.close', ($, e) => { panes.delete(e.id); return { value: undefined } })
  on('ui.panes', () => ({ value: [...panes].map((id): UiPane => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.scroll', () => ({}))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('tool.call', () => ({ result: { ok: true } }))
  on('process.run', ($, e) => {
    const [command, group, action] = e.argv
    if (command === 'git' && e.argv.includes('status')) return { value: ran(0, GIT_STATUS) }
    if (command === 'git' && e.argv.includes('--show-toplevel')) return { value: ran(0, '/repo\n') }
    if (command === 'git' && e.argv.includes('get-regexp')) return { value: ran(0, `remote.origin.url git@github.com:${REPO}.git\n`) }
    if (command === 'git') return { value: ran(0, 'ABC-123/csv-export\n') }
    if (command === 'gh') {
      if (group === 'auth') return { value: ran(0, '', 'Logged in to github.com account octocat') }
      if (group === 'repo') return { value: ran(0, JSON.stringify({ nameWithOwner: REPO, url: `https://github.com/${REPO}`, defaultBranchRef: { name: 'main' } })) }
      if (group === 'api') return { value: ran(0, listsJson()) }
      if (group === 'pr' && action === 'checks') return { value: ran(0, '[]') }
      return { value: ran(1, '', 'unexpected') }
    }
    return { value: ran(0, 'ok\n') }
  })
  on('mcp.call', ($, e) => {
    if (e.tool.startsWith('slack_')) return slackAnswer(e.tool, e.args)
    const operation = e.tool === 'executeRead' ? e.args.name : e.tool
    switch (operation) {
      case 'getAccessibleAtlassianResources': return { value: json(SITES) }
      case 'getJiraIssue': return { value: json(BRANCH_ISSUE) }
      case 'searchJiraIssuesUsingJql': return { value: json(SEARCH) }
      case 'listJiraBoards': return { value: json(BOARDS) }
      case 'getJiraBoardConfig': return { value: json({ data: { id: 357, name: 'Web Board', columnConfig: { columns: COLUMNS } } }) }
      case 'transitionJiraIssue': {
        const issue = SEARCH.issues.find(one => one.key === 'ABC-140')
        if (issue) issue.fields.status = { name: 'In Review', id: '10003', statusCategory: { key: 'indeterminate' } }
        return { value: json({}) }
      }
      case 'getTransitionsForJiraIssue':
      case 'listJiraIssueTransitions': return { value: json(TRANSITIONS) }
      default: return { value: json({}) }
    }
  })
}


type Clock = { advance: (s: number) => Promise<unknown>; settle: () => Promise<unknown> }
type Ui = Awaited<ReturnType<Parameters<Parameters<typeof test>[1]>[0]['ui']['mount']>>

async function dismissNotices(band: Ui): Promise<void> {
  for (const found of await band.findAll({ type: 'Button' })) if (found.key?.startsWith('dock-notice-x-')) await band.press({ key: found.key })
}

/** A session with data in every panel; `optIns` are ticked into the main dock (Jira and Slacker are off by default). */
async function prime($: Parameters<Parameters<typeof test>[1]>[0], clock: Clock, optIns: string[]): Promise<Ui> {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  // The same five calls the hero's transcript shows.
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/export/csv.ts' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/export/csv.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/export/ExportButton.tsx', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/export/csv.test.ts', content: 'test' })
  await $.tool.call({ tool: 'Bash', command: 'pnpm test export' })
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  if (optIns.length > 0) {
    await pane.press({ key: 'dock-main-manage' })
    for (const id of optIns) await pane.press({ key: `dock-main-enable-1-${id}` })
    await pane.press({ key: 'dock-main-manage' })
  }
  await pane.press({ key: 'branch-refresh' })
  if (optIns.includes('jira')) await pane.press({ key: 'jira-refresh' })
  await pane.press({ key: 'checks-run-all' })
  await clock.advance(10)
  await clock.settle()
  return pane
}

test('hero', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mockAll(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const pane = await prime($, clock, ['jira'])
  await dump('dock-all', pane)
  for (const id of ['branch', 'checks', 'activity', 'jira', 'gitgud']) await pane.press({ key: `dock-main-toggle-${id}` })
  await dump('dock-none', pane)
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(72, 6) })
  await dismissNotices(band)
  await band.press({ key: 'dock-tab-branch' })
  await dump('hero-band-focused', band)
  await pane.press({ key: 'dock-main-close' })
  await pane.unmount()
  await band.redraw(bandProps(129, 6))
  await dump('hero-band-closed', band)
  await band.unmount()
  expect(true).toBe(true)
})

test('jira drag', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mockAll(on)
  const pane = await prime($, clock, ['jira'])
  for (const k of ['branch', 'checks', 'activity', 'gitgud']) await pane.press({ key: `dock-main-toggle-${k}` })
  const board = { in: 'jira-board-main' }
  const textOf = (n: unknown): string => typeof n === 'string' ? n : Array.isArray(n) ? n.map(textOf).join('') : typeof n === 'object' && n !== null && 'children' in n ? textOf((n as { children: unknown }).children) : ''
  const rowsOf = async () => (((await pane.drawn(board)) as { children?: unknown[] }).children ?? []).map(textOf)
  let rows = await rowsOf()
  await dump('jira-rest', pane)
  const from = rows.findIndex(r => r.includes('ABC-140'))
  const to = rows.findIndex(r => r.startsWith(' IN REVIEW'))
  const dev = rows.findIndex(r => r.startsWith(' IN DEV'))
  await pane.pointer({ ...board, type: 'down', x: 6, y: from, button: 'left' })
  await pane.pointer({ ...board, type: 'move', x: 6, y: dev, button: 'left' })
  await dump('jira-drag-dev', pane)
  await pane.pointer({ ...board, type: 'move', x: 6, y: to, button: 'left' })
  await dump('jira-drag-review', pane)
  await pane.pointer({ ...board, type: 'up', x: 6, y: to, button: 'left' })
  await dump('jira-confirm', pane)
  rows = await rowsOf()
  const moveX = (rows[from + 1] ?? '').indexOf('[Move]')
  await pane.pointer({ ...board, type: 'down', x: moveX + 1, y: from + 1, button: 'left' })
  await pane.pointer({ ...board, type: 'up', x: moveX + 1, y: from + 1, button: 'left' })
  await clock.advance(5)
  await clock.settle()
  await pane.press({ key: 'jira-refresh' })
  await clock.settle()
  await dump('jira-moved', pane)
  await pane.unmount()
  expect(true).toBe(true)
})

test('slacker', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mockAll(on)
  const pane = await prime($, clock, ['jira', 'slacker'])
  for (const k of ['branch', 'checks', 'activity', 'jira', 'gitgud']) await pane.press({ key: `dock-main-toggle-${k}` })
  await clock.advance(10)
  await clock.settle()
  await dump('slacker', pane)
  await pane.unmount()
  expect(true).toBe(true)
})

test('bottom', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mockAll(on)
  const pane = await prime($, clock, [])
  await pane.press({ key: 'dock-main-close' })
  await pane.press({ key: 'dock-main-menu' })
  await pane.press({ key: 'dock-main-new-bottom' })
  await pane.unmount()
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(110, 26) })
  for (const id of ['branch', 'checks', 'activity']) await band.press({ key: `dock-2-enable-1-${id}` })
  await band.input({ key: 'dock-2-name', text: 'Bottom' })
  await band.press({ key: 'dock-2-manage' })
  await dismissNotices(band)
  await clock.settle()
  await band.resize({ in: 'dock-2-measure', columns: 1, rows: 26 })
  await dump('bottom-12', band)
  const grip = { in: 'dock-2-grip' }
  await band.pointer({ ...grip, type: 'down', x: 40, y: 0, button: 'left' })
  for (const dy of [1, 2, 3, 4, 5, 6]) {
    await band.pointer({ ...grip, type: 'move', x: 40, y: -dy, button: 'left' })
    await dump(`bottom-drag${dy}`, band)
  }
  await band.pointer({ ...grip, type: 'up', x: 40, y: -6, button: 'left' })
  await dump('bottom-18', band)
  await band.unmount()
  expect(true).toBe(true)
})

function item(number: number, fields: Partial<GhItem>): GhItem {
  return { id: `${REPO}#${number}`, kind: 'pr', repo: REPO, number, title: '', url: `https://github.com/${REPO}/pull/${number}`, author: 'grace',
    updatedAt: '2026-10-16T09:00:00Z', comments: 0, ci: 'pass', review: 'none', ...fields }
}
const G_REVIEW = [
  item(2086, { title: 'ABC-131 / Date range picker', author: 'grace', review: 'required', comments: 2, ticket: 'ABC-131', isTeamRequest: false }),
  item(2090, { title: 'Fix sidebar overflow on narrow screens', author: 'linus', ci: 'pending', review: 'required' }),
  item(2093, { title: 'Bump the chart library to v5', author: 'ada', review: 'required', updatedAt: '2026-10-15T16:00:00Z' })
]
const G_MINE = [item(2079, { title: 'ABC-123 / Stream large CSV exports', author: 'octocat', review: 'approved', ticket: 'ABC-123', headRef: 'ABC-123/csv-export', baseRef: 'main' })]

function ggState(step: number, blink: boolean): GitgudState {
  const now = NOW + step * 1000
  const job = G_REVIEW[0]!
  const activities = ['reading src/reports/DateRange.tsx', 'reading src/reports/DateRange.tsx', 'running pnpm test reports', 'reading src/reports/useRange.ts', 'reading src/reports/useRange.ts', 'reading src/reports/useRange.ts']
  const asking = step >= 20
  return {
    health: 'ok', login: 'octocat', provider: 'github',
    currentRepo: { nameWithOwner: REPO, url: `https://github.com/${REPO}`, defaultBranch: 'main' },
    branch: 'ABC-123/csv-export', review: G_REVIEW, mine: G_MINE, issues: [], updatedAt: NOW, now,
    jiraStatus: { 'ABC-131': 'In Review', 'ABC-123': 'In Dev' },
    oneLiners: { [job.id]: 'Adds a from/to picker above the reports table.' },
    blink,
    ui: { view: 'review' },
    reviews: { [job.id]: {
      itemId: job.id, title: job.title, phase: 'running', startedAt: NOW - 61_000, model: 'sonnet',
      activity: activities[Math.min(activities.length - 1, Math.floor(step / 4))], steps: 4 + Math.floor(step / 2),
      asks: asking ? [{ id: '1-2', tool: 'WebFetch', what: 'fetch https://docs.example.com/date-format', askedAt: NOW + 20_000, rules: [{ toolName: 'WebFetch', ruleContent: 'domain:docs.example.com' }], ruleLabel: 'docs.example.com' }] : []
    } }
  } as GitgudState
}

test('gitgud review', SLOW, async ($, on) => {
  let state = ggState(0, false)
  on('ui.render', { component: 'Pane', requestId: 'gg-probe' }, ($, e) => {
    const ui = $.ui.resolve({ ...e, surface: 'terminal' as const })
    const { Box, Button, Text } = ui
    const Stub = (props: { key?: string; width?: number }) => <Box key={props.key} width={props.width} flexDirection="column" />
    const body = drawGitgud({ ...ui, Client: Stub } as typeof ui, state, 56, 'terminal', 'main')
    return drawCard(ui, {
      key: 'dock-main-card-gitgud', cells: 56,
      title: <Button key="dock-main-toggle-gitgud" plain label="▾ 🐙 GitGud" onPress={() => undefined}><Text bold>▾ 🐙 GitGud</Text></Button>,
      controls: [<Button key="gitgud-settings" plain dimColor label="⚙" onPress={() => undefined} />, <Text> </Text>, <Text> </Text>],
      body
    })
  })
  on('ui.render', { component: 'Pane', requestId: 'gg-list' }, ($, e) => {
    const ui = $.ui.resolve({ ...e, surface: 'terminal' as const })
    let ls: unknown
    const surface = { elements: ui, get state() { return ls }, setState: (n: unknown) => { ls = n }, columns: 56, rows: 0,
      every: () => () => undefined, onPointer: () => () => undefined, onKey: () => () => undefined, post: () => undefined }
    return GitgudList(buildListProps(state, 56), surface as Parameters<typeof GitgudList>[1])
  })
  const card = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'gg-probe', props: paneProps(56) })
  const list = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'gg-list', props: paneProps(56) })
  for (const [name, step, blink] of [['gg-0', 0, false], ['gg-6', 6, false], ['gg-12', 12, false], ['gg-18', 18, false], ['gg-ask-on', 22, true], ['gg-ask-off', 22, false], ['gg-after', 30, false], ['gg-done', 60, false]] as const) {
    state = ggState(step, blink)
    const job = Object.values(state.reviews ?? {})[0]
    if (job && step >= 30) {
      job.asks = (job.asks ?? []).map(a => ({ ...a, answer: 'once' as const, answeredAt: NOW + 25_000 }))
      job.activity = 'fetching docs.example.com'
    }
    if (job && step >= 60) { job.phase = 'done'; job.endedAt = NOW + 60_000; job.path = '/tmp/review.md'; job.activity = undefined }
    await card.redraw(paneProps(56))
    await list.redraw(paneProps(56))
    console.log(`@@FRAME ${name} ${JSON.stringify(await card.drawn())}`)
    console.log(`@@LIST ${name} ${JSON.stringify(await list.drawn())}`)
  }
  await card.unmount()
  await list.unmount()
  expect(true).toBe(true)
})
