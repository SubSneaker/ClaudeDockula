import type { McpToolResult, On, ProcessRunResult, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { PANELS } from '../hooks/panels'

const SITES = [{ id: 'abc', url: 'https://acme.atlassian.net' }]
const BRANCH_ISSUE = { key: 'ABC-101', fields: { summary: 'Add export button', status: { name: 'IN REVIEW' } } }
const SEARCH = {
  issues: [
    { key: 'ABC-102', fields: { summary: 'Pick a table', status: { name: 'To Do', id: '10001', statusCategory: { key: 'new' } } } },
    { key: 'ABC-101', fields: { summary: 'Add export button', status: { name: 'IN REVIEW', id: '10003', statusCategory: { key: 'done' } } } },
    { key: 'ABC-103', fields: { summary: 'Group query', status: { name: 'COMPLETE', id: '10004', statusCategory: { key: 'done' } } } }
  ]
}
const BOARDS = {
  data: {
    values: [
      { id: 357, name: 'Team Board', type: 'kanban' },
      { id: 356, name: 'Sprint Board', type: 'scrum' }
    ]
  }
}
const RELEASE_COLUMNS = [
  { name: 'Backlog', statuses: [{ id: '10001', name: 'To Do', category: 'new' }] },
  { name: 'In Progress', statuses: [{ id: '10002', name: 'In Progress', category: 'indeterminate' }] },
  { name: 'IN REVIEW', statuses: [{ id: '10003', name: 'IN REVIEW', category: 'done' }] },
  { name: 'Done', statuses: [{ id: '10004', name: 'COMPLETE', category: 'done' }] }
]
/** The scrum board: its lanes in another order, and no column for COMPLETE. */
const SPRINT_COLUMNS = [
  { name: 'To Do', statuses: [{ id: '10001', name: 'To Do', category: 'new' }] },
  { name: 'IN REVIEW', statuses: [{ id: '10003', name: 'IN REVIEW', category: 'done' }] },
  { name: 'In Progress', statuses: [{ id: '10002', name: 'In Progress', category: 'indeterminate' }] }
]
const TRANSITIONS = {
  transitions: [
    { id: '81', name: 'In Progress', to: { id: '10002', name: 'In Progress' } },
    { id: '91', name: 'IN REVIEW', to: { id: '10003', name: 'IN REVIEW' } },
    { id: '61', name: 'Done', to: { id: '10004', name: 'COMPLETE' } }
  ]
}
const SETTINGS = {
  jira: {
    server: 'atlassian',
    flavour: 'standard',
    boardServer: 'claude.ai Atlassian MCP',
    site: { cloudId: 'abc', url: 'https://acme.atlassian.net' }
  }
}
const DENIED = 'Permission to use this MCP tool has been denied.'

interface JiraMock {
  moves: unknown[]
  /** The server each transition went through. */
  writes: string[]
  filled: string[]
  configs: number[]
  /** Operations the session's permissions refuse. */
  denied: string[]
  /** Boards whose config Jira refuses. */
  brokenBoards: number[]
  isWriteFailing: boolean
  /** How the session refuses the transition call itself: a permission deny, or a call that throws. */
  writeRefusal?: 'deny' | 'throw'
  draft: string
}

function json(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }
}

function ran(stdout: string): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

/** Ticks Jira into the main dock's view in ⚙ Manage: it is opt-in, so no view shows it before. */
async function enableJira(pane: { press: (args: { key: string }) => Promise<unknown> }): Promise<void> {
  await pane.press({ key: 'dock-main-manage' })
  await pane.press({ key: 'dock-main-enable-1-jira' })
  await pane.press({ key: 'dock-main-manage' })
}

function paneProps(bodyColumns: number): RenderPropsOf['Pane'] {
  return { title: 'Dock', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }
}

function bandProps(bodyColumns: number): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns, scroll: { offset: 0, bodyRows: 11 }, view: {} }
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'children' in node) return textOf(node.children)

  return ''
}

/** The board's rows as shown: the pointer's `y` is the index. */
function rowsOf(tree: unknown): string[] {
  const children = typeof tree === 'object' && tree !== null && 'children' in tree ? tree.children : []

  return Array.isArray(children) ? children.map(textOf) : []
}

/** The Jira site, as both servers answer it, with the board config by board id and the writes recorded. */
function mockJira(on: On): JiraMock {
  const jira: JiraMock = { moves: [], writes: [], filled: [], configs: [], denied: [], brokenBoards: [], isWriteFailing: false, draft: '' }
  // Only git answers; GitGud, on by default, finds no gh and shows its setup card instead of a notice.
  on('process.run', (_$, e) => ({
    value: e.argv[0] === 'git' ? ran('ABC-101/add-export-button\n') : { ...ran(''), exitCode: 127, stderr: 'command not found' }
  }))
  on('prompt.read', () => ({ value: { text: jira.draft, cursor: jira.draft.length } }))
  on('prompt.fill', ($, e) => {
    jira.filled.push(e.text)

    return { isFilled: true }
  })
  on('mcp.call', ($, e) => {
    const operation = e.tool === 'executeRead' ? e.args.name : e.tool
    if (typeof operation === 'string' && jira.denied.includes(operation)) return { deny: DENIED }
    if (operation === 'transitionJiraIssue') {
      jira.moves.push(e.args)
      jira.writes.push(e.server)
      if (jira.writeRefusal === 'deny') return { deny: DENIED }
      if (jira.writeRefusal === 'throw') throw new Error('socket hang up')
      if (jira.isWriteFailing) return { value: { content: [{ type: 'text', text: 'Transition is not valid' }], isError: true } }
    }
    switch (operation) {
      case 'getAccessibleAtlassianResources':
        return { value: json(SITES) }
      case 'getJiraIssue':
        return { value: json(BRANCH_ISSUE) }
      case 'searchJiraIssuesUsingJql':
        return { value: json(SEARCH) }
      case 'listJiraBoards':
        return { value: json(BOARDS) }
      case 'getJiraBoardConfig': {
        const inputs = e.args.inputs
        const id = typeof inputs === 'object' && inputs !== null && 'boardId' in inputs ? inputs.boardId : undefined
        const isSprint = id === 356
        if (typeof id === 'number') jira.configs.push(id)
        if (typeof id === 'number' && jira.brokenBoards.includes(id)) {
          return { value: { content: [{ type: 'text', text: '{"errorMessages":["Board does not exist"]}' }], isError: true } }
        }

        return {
          value: json({
            data: { id, name: isSprint ? 'Sprint Board' : 'Team Board', columnConfig: { columns: isSprint ? SPRINT_COLUMNS : RELEASE_COLUMNS } }
          })
        }
      }
      case 'getTransitionsForJiraIssue':
      case 'listJiraIssueTransitions':
        return { value: json(TRANSITIONS) }
      default:
        return { value: json({}) }
    }
  })

  return jira
}

test('the board: drag a ticket to a lane and confirm, right-click for the menu; Buttons where there is no Client', async ($, on) => {
  mock.clock(on)
  mock.store(on, { settings: SETTINGS })
  const jira = mockJira(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
    if (surface === 'terminal') await enableJira(ui)
    await ui.press({ key: 'jira-refresh' })
    await expect(ui.drawn()).resolves.toBeDefined()
    expect(rowsOf(await ui.drawn({ in: 'jira-board-main' })).slice(0, 3)).toEqual([' Board  Team Board · kanban  ▾', ' ', ' BACKLOG  (1)'])
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  const board = { in: 'jira-board-main' }
  const rows = rowsOf(await ui.drawn(board))
  const from = rows.findIndex(row => row.includes('ABC-102'))
  const to = rows.findIndex(row => row.startsWith(' IN REVIEW'))
  const done = rows.findIndex(row => row.startsWith(' DONE'))
  expect(rows.find(row => row.includes('ABC-101'))).toContain('▾ ABC-101 ★')
  expect(rows.at(-1)).toContain('DONE  (1)  ▸')

  // A drop onto Done names the status it lands in; y and n do not answer.
  await ui.pointer({ ...board, type: 'down', x: 6, y: from, button: 'left' })
  await ui.pointer({ ...board, type: 'move', x: 6, y: done, button: 'left' })
  await ui.pointer({ ...board, type: 'up', x: 6, y: done, button: 'left' })
  const doneConfirm = rowsOf(await ui.drawn(board))[from + 1] ?? ''
  expect(doneConfirm).toMatch(/^ {5}Move to DONE \(COMPLETE\)\? +\[Move\] {2}\[Cancel\]$/)
  await ui.key({ ...board, key: 'y' })
  expect(jira.moves).toHaveLength(0)
  await ui.key({ ...board, key: 'backspace' })

  await ui.pointer({ ...board, type: 'down', x: 6, y: from, button: 'left' })
  await ui.pointer({ ...board, type: 'move', x: 6, y: to, button: 'left' })
  expect(rowsOf(await ui.drawn(board))[to]).toContain('← drop here')
  await ui.pointer({ ...board, type: 'up', x: 6, y: to, button: 'left' })
  const confirmRow = rowsOf(await ui.drawn(board))[from + 1] ?? ''
  expect(confirmRow).toMatch(/^ {5}Move to IN REVIEW\? +\[Move\] {2}\[Cancel\]$/)
  expect(jira.moves).toHaveLength(0)

  // The buttons stay put whatever the question says, so a click never lands on the other one.
  const moveX = confirmRow.indexOf('[Move]')
  expect(doneConfirm.indexOf('[Move]')).toBe(moveX)
  await ui.pointer({ ...board, type: 'down', x: moveX + 1, y: from + 1, button: 'left' })
  await ui.pointer({ ...board, type: 'up', x: moveX + 1, y: from + 2, button: 'left' })
  expect(jira.moves).toHaveLength(0)
  await ui.pointer({ ...board, type: 'down', x: moveX + 1, y: from + 1, button: 'left' })
  await ui.pointer({ ...board, type: 'up', x: moveX + 1, y: from + 1, button: 'left' })
  expect(jira.moves).toEqual([{ cloudId: 'abc', issueIdOrKey: 'ABC-102', transition: { id: '91' } }])

  // A confirm left open and then hidden by collapsing its lane takes no Enter.
  const backlog = rows.findIndex(row => row.startsWith(' BACKLOG'))
  await ui.pointer({ ...board, type: 'down', x: 6, y: from, button: 'left' })
  await ui.pointer({ ...board, type: 'move', x: 6, y: to, button: 'left' })
  await ui.pointer({ ...board, type: 'up', x: 6, y: to, button: 'left' })
  await ui.pointer({ ...board, type: 'down', x: 2, y: backlog, button: 'left' })
  await ui.pointer({ ...board, type: 'up', x: 2, y: backlog, button: 'left' })
  await ui.key({ ...board, key: 'return' })
  expect(jira.moves).toHaveLength(1)

  // Two posts in one frame make one write.
  const move = { type: 'move', key: 'ABC-102', lane: 'IN REVIEW' }
  await Promise.all([ui.post(move, board), ui.post(move, board)])
  expect(jira.moves).toHaveLength(2)

  const branchRow = rowsOf(await ui.drawn(board)).findIndex(row => row.includes('ABC-101'))
  await ui.pointer({ ...board, type: 'down', x: 8, y: branchRow, button: 'right' })
  expect(rowsOf(await ui.drawn(board)).slice(branchRow + 1, branchRow + 6)).toEqual([
    '     Move to ▸',
    '     New branch',
    '     Open in browser',
    '     Add link to prompt',
    '     Add full ticket to prompt'
  ])
  for (const key of ['down', 'down', 'down', 'return']) await ui.key({ ...board, key })
  expect(jira.filled).toEqual(['[ABC-101: Add export button](https://acme.atlassian.net/browse/ABC-101) '])
  await ui.unmount()

  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(80) })
  expect(await band.find({ type: 'Text', text: /ABC-102 → IN REVIEW/ })).toBeDefined()
  await band.unmount()

  jira.draft = 'half a thought'
  const plain = await $.ui.mount({ plugin: 'claudedockula', surface: 'vscode', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  expect((await plain.find({ key: 'jira-pick' }))?.props.value).toBe('357')
  await plain.press({ key: 'jira-lane-Done' })
  expect((await plain.find({ key: 'jira-card-ABC-103' }))?.props.label).toContain('▸ ABC-103')
  await plain.press({ key: 'jira-menu-ABC-102' })
  await plain.press({ key: 'jira-act-branch-ABC-102' })
  expect(await plain.find({ type: 'Text', text: /Clear the prompt box first/ })).toBeDefined()
  expect(jira.filled).toHaveLength(1)
  // A lane picked from the menu asks first, as a drop does.
  const movedBefore = jira.moves.length
  await plain.press({ key: 'jira-menu-ABC-102' })
  await plain.press({ key: 'jira-act-move-ABC-102' })
  await plain.press({ key: 'jira-to-ABC-102~IN%20REVIEW' })
  expect(jira.moves).toHaveLength(movedBefore)
  expect(await plain.find({ type: 'Text', text: 'Move to IN REVIEW?' })).toBeDefined()
  await plain.press({ key: 'jira-confirm-move-ABC-102~IN%20REVIEW' })
  expect(jira.moves).toHaveLength(movedBefore + 1)
  expect(jira.moves.at(-1)).toEqual({ cloudId: 'abc', issueIdOrKey: 'ABC-102', transition: { id: '91' } })
  expect(await plain.find({ key: 'jira-confirm-move-ABC-102~IN%20REVIEW' })).toBeUndefined()
  await plain.unmount()

  const mobile = await $.ui.mount({ plugin: 'claudedockula', surface: 'mobile', component: 'Pane', requestId: 'claudedockula', props: paneProps(40) })
  expect(await mobile.find({ key: 'jira-card-ABC-102' })).toBeDefined()
  expect(await mobile.find({ type: 'Text', text: /Clear the prompt box first/ })).toBeDefined()
  await mobile.press({ key: 'jira-pick-menu' })
  expect((await mobile.find({ key: 'jira-pick-357' }))?.props.label).toBe('● Team Board · kanban')
  await mobile.unmount()
})

test('the board picker: a click or the keys pick a board, kept once it loads; the menu keeps its lane by name', async ($, on) => {
  mock.clock(on)
  const saved: unknown[] = []
  on('store.set', { key: 'jiraBoardChoices' }, ($, e, next) => {
    saved.push(e.value)

    return next(e)
  })
  mock.store(on, { settings: SETTINGS })
  const jira = mockJira(on)
  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await enableJira(ui)
  const board = { in: 'jira-board-main' }
  await ui.press({ key: 'jira-refresh' })
  expect([...new Set(jira.configs)].sort()).toEqual([356, 357])

  // A click opens the list; a board that fails to load is not kept.
  jira.brokenBoards = [356]
  await ui.pointer({ ...board, type: 'down', x: 3, y: 0, button: 'left' })
  await ui.pointer({ ...board, type: 'up', x: 3, y: 0, button: 'left' })
  expect(rowsOf(await ui.drawn(board)).slice(0, 4)).toEqual([
    '›Board  Team Board · kanban  ▴',
    '     ● Team Board · kanban',
    '     ○ Sprint Board · scrum',
    ' '
  ])
  await ui.pointer({ ...board, type: 'down', x: 8, y: 2, button: 'left' })
  await ui.pointer({ ...board, type: 'up', x: 8, y: 2, button: 'left' })
  expect(rowsOf(await ui.drawn(board))[0]).toBe('›Board  Team Board · kanban  ▾')
  expect(await ui.find({ type: 'Text', text: /Couldn't read the board: claude\.ai Atlassian MCP: Board does not exist/ })).toBeDefined()
  expect(saved).toEqual([])
  jira.brokenBoards = []

  // Open Move to on ABC-102 and highlight IN REVIEW, the third entry.
  const from = rowsOf(await ui.drawn(board)).findIndex(row => row.includes('ABC-102'))
  await ui.pointer({ ...board, type: 'down', x: 8, y: from, button: 'right' })
  for (const key of ['return', 'down', 'down']) await ui.key({ ...board, key })
  expect(rowsOf(await ui.drawn(board)).slice(from + 1, from + 5)).toEqual(['     ‹ Back', '     → IN PROGRESS', '     → IN REVIEW', '     → DONE'])
  await ui.key({ ...board, key: 'right' })
  expect(jira.moves).toEqual([])

  // A pick in the vscode Select reorders the lanes under the open menu: Enter still picks IN REVIEW, which asks first.
  const plain = await $.ui.mount({ plugin: 'claudedockula', surface: 'vscode', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await plain.select({ key: 'jira-pick', value: '356' })
  await plain.unmount()
  expect(saved).toEqual([{ ABC: 356 }])
  const rows = rowsOf(await ui.drawn(board))
  expect(rows[0]).toBe(' Board  Sprint Board · scrum  ▾')
  expect(rows.slice(2).filter(row => /^ [A-Z]/.test(row))).toEqual([' TO DO  (1)', ' IN REVIEW  (1)', ' IN PROGRESS  (0)  ▸', ' OTHER  (1)'])
  await ui.key({ ...board, key: 'return' })
  expect(jira.moves).toEqual([])
  const asked = rowsOf(await ui.drawn(board))
  expect(asked[asked.findIndex(row => row.includes('ABC-102')) + 1]).toMatch(/^ {5}Move to IN REVIEW\? +\[Move\] {2}\[Cancel\]$/)
  await ui.key({ ...board, key: 'return' })
  expect(jira.moves).toEqual([{ cloudId: 'abc', issueIdOrKey: 'ABC-102', transition: { id: '91' } }])

  // Nothing drops onto Other.
  const after = rowsOf(await ui.drawn(board))
  const other = after.findIndex(row => row.startsWith(' OTHER'))
  const card = after.findIndex(row => row.includes('ABC-102'))
  await ui.pointer({ ...board, type: 'down', x: 6, y: card, button: 'left' })
  await ui.pointer({ ...board, type: 'move', x: 6, y: other, button: 'left' })
  await ui.pointer({ ...board, type: 'up', x: 6, y: other, button: 'left' })
  expect(rowsOf(await ui.drawn(board)).some(row => row.includes('Move to'))).toBe(false)

  // The keys: up to the picker, Enter opens it, ↓ to the release board, Enter picks it.
  for (const key of ['up', 'up', 'return', 'down', 'return']) await ui.key({ ...board, key })
  expect(rowsOf(await ui.drawn(board))[0]).toBe('›Board  Team Board · kanban  ▾')
  expect(saved.at(-1)).toEqual({ ABC: 357 })
  await ui.unmount()
})

test('a new session follows the board picked before, read from the store', async ($, on) => {
  mock.clock(on)
  mock.store(on, { settings: SETTINGS, jiraBoardChoices: { ABC: 356 } })
  const jira = mockJira(on)
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  expect(jira.configs).toEqual([])
  await enableJira(ui)
  expect(jira.configs).toEqual([356])
  expect(rowsOf(await ui.drawn({ in: 'jira-board-main' }))[0]).toBe(' Board  Sprint Board · scrum  ▾')
  await ui.unmount()
})

test('a refused read: the server says why, with the hint; the error notice opens and stays until ✕', async ($, on) => {
  const clock = mock.clock(on)
  // Every panel already announced, so this test's notice is the first one.
  const seen = Object.fromEntries(PANELS.map(panel => [panel.id, panel.revision ?? 1]))
  mock.store(on, { settings: SETTINGS, 'panels:seen': seen })
  const jira = mockJira(on)
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  // The GitGud panel's session setup reads the environment; unanswered it posts its own error notice first.
  on('env.get', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))

  jira.denied = ['searchJiraIssuesUsingJql', 'listJiraBoards']
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await enableJira(ui)
  await ui.press({ key: 'jira-refresh' })
  const listError = await ui.find({ type: 'Text', text: /^Couldn't load your tickets: / })
  expect(listError?.text).toBe(`Couldn't load your tickets: atlassian: ${DENIED}`)
  expect(await ui.find({ type: 'Text', text: 'Allow it in /permissions' })).toBeDefined()

  // The next refresh tries the board again.
  jira.denied = ['getTransitionsForJiraIssue', 'listJiraIssueTransitions']
  await ui.press({ key: 'jira-refresh' })
  expect(rowsOf(await ui.drawn({ in: 'jira-board-main' }))[0]).toBe(' Board  Team Board · kanban  ▾')
  await ui.post({ type: 'move', key: 'ABC-102', lane: 'IN REVIEW' }, { in: 'jira-board-main' })
  await ui.press({ key: 'jira-refresh' })
  expect(jira.moves).toHaveLength(0)
  await ui.unmount()

  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(80) })
  const row = await band.find({ type: 'Text', text: /Couldn't move ABC-102 → IN REVIEW/ })
  expect(row?.text).toMatch(/^⚠ Couldn't move ABC-102 → IN REVIEW +▸$/)
  const key = 'dock-notice-1'
  await band.press({ key })
  expect(await band.find({ type: 'Text', text: /^Couldn't read its transitions: atlassian: / })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'Allow it in /permissions' })).toBeDefined()
  await clock.advance(60_000)
  expect(await band.find({ key })).toBeDefined()
  await band.press({ key: 'dock-notice-x-1' })
  expect(await band.find({ key })).toBeUndefined()

  // An info notice clears by itself; a click on a row with nothing more to show does not keep it.
  jira.draft = 'half a thought'
  const plain = await $.ui.mount({ plugin: 'claudedockula', surface: 'vscode', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  const askBranch = async () => {
    await plain.press({ key: 'jira-menu-ABC-102' })
    await plain.press({ key: 'jira-act-branch-ABC-102' })
  }
  await askBranch()
  const infoRow = await band.find({ type: 'Button', text: /Clear the prompt box first/ })
  expect(infoRow).toBeDefined()
  await band.press({ key: infoRow?.key ?? '' })
  await clock.advance(10_000)
  expect(await band.find({ type: 'Text', text: /Clear the prompt box first/ })).toBeUndefined()

  // Cut to a narrow band the same row opens, and once opened it outlasts the sweeper.
  await band.redraw(bandProps(24))
  await askBranch()
  await plain.unmount()
  const cutRow = await band.find({ type: 'Button', text: /Clear the pr/ })
  await band.press({ key: cutRow?.key ?? '' })
  await clock.advance(30_000)
  expect(await band.find({ type: 'Text', text: 'Clear the prompt box first' })).toBeDefined()
  await band.redraw(bandProps(80))

  // A write Jira refuses is not sent again.
  jira.denied = []
  jira.isWriteFailing = true
  const again = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await again.post({ type: 'move', key: 'ABC-102', lane: 'IN REVIEW' }, { in: 'jira-board-main' })
  jira.isWriteFailing = false
  jira.writeRefusal = 'deny'
  await again.post({ type: 'move', key: 'ABC-102', lane: 'IN REVIEW' }, { in: 'jira-board-main' })
  jira.writeRefusal = 'throw'
  await again.post({ type: 'move', key: 'ABC-102', lane: 'IN REVIEW' }, { in: 'jira-board-main' })
  await again.unmount()
  expect(jira.writes).toEqual(['atlassian', 'atlassian', 'atlassian'])
  expect(await band.find({ type: 'Text', text: /Couldn't move ABC-102 → IN REVIEW/ })).toBeDefined()
  await band.unmount()
})

test('the board in two docks at once: an instance per dock, and one confirm makes one move', async ($, on) => {
  mock.clock(on)
  mock.store(on, { settings: SETTINGS })
  const jira = mockJira(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await enableJira(pane)
  await pane.press({ key: 'jira-refresh' })
  await pane.press({ key: 'dock-main-menu' })
  await pane.press({ key: 'dock-main-new-bottom' })
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(120) })
  await band.press({ key: 'dock-2-enable-1-jira' })
  await band.press({ key: 'dock-2-manage' })

  const inBand = { in: 'jira-board-2' }
  const rows = rowsOf(await band.drawn(inBand))
  expect(rowsOf(await pane.drawn({ in: 'jira-board-main' }))[0]).toBe(rows[0])
  const from = rows.findIndex(row => row.includes('ABC-102'))
  const to = rows.findIndex(row => row.startsWith(' IN REVIEW'))
  await band.pointer({ ...inBand, type: 'down', x: 6, y: from, button: 'left' })
  await band.pointer({ ...inBand, type: 'move', x: 6, y: to, button: 'left' })
  await band.pointer({ ...inBand, type: 'up', x: 6, y: to, button: 'left' })
  const confirmRow = rowsOf(await band.drawn(inBand))[from + 1] ?? ''
  expect(rowsOf(await pane.drawn({ in: 'jira-board-main' })).some(row => row.includes('[Move]'))).toBe(false)
  const moveX = confirmRow.indexOf('[Move]') + 1
  await band.pointer({ ...inBand, type: 'down', x: moveX, y: from + 1, button: 'left' })
  await band.pointer({ ...inBand, type: 'up', x: moveX, y: from + 1, button: 'left' })

  expect(jira.moves).toEqual([{ cloudId: 'abc', issueIdOrKey: 'ABC-102', transition: { id: '91' } }])
  await band.unmount()
  await pane.unmount()
})

test('a plain board\'s confirm goes when its ticket is moved another way', async ($, on) => {
  mock.clock(on)
  mock.store(on, { settings: SETTINGS })
  const jira = mockJira(on)
  const plain = await $.ui.mount({ plugin: 'claudedockula', surface: 'vscode', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await enableJira(plain)
  await plain.press({ key: 'jira-refresh' })
  await plain.press({ key: 'jira-menu-ABC-102' })
  await plain.press({ key: 'jira-act-move-ABC-102' })
  await plain.press({ key: 'jira-to-ABC-102~IN%20REVIEW' })
  expect(await plain.find({ type: 'Text', text: 'Move to IN REVIEW?' })).toBeDefined()

  const board = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await board.post({ type: 'move', key: 'ABC-102', lane: 'IN REVIEW' }, { in: 'jira-board-main' })
  expect(jira.moves).toHaveLength(1)
  expect(await plain.find({ type: 'Text', text: 'Move to IN REVIEW?' })).toBeUndefined()
  expect(await plain.find({ key: 'jira-confirm-move-ABC-102~IN%20REVIEW' })).toBeUndefined()
  await board.unmount()
  await plain.unmount()
})
