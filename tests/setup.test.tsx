import type { McpToolResult, On, ProcessRunResult, RenderPropsOf, ToolInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PACKAGE_JSON = JSON.stringify({ scripts: { dev: 'next', lint: 'eslint .', test: 'vitest' } })
const SITE = { cloudId: 'abc', url: 'https://acme.atlassian.net' }

function paneProps(bodyColumns: number): RenderPropsOf['Pane'] {
  return { title: 'Dock', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }
}

function bandProps(bodyColumns: number): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns, scroll: { offset: 0, bodyRows: 11 }, view: {} }
}

function ran(exitCode: number, stdout: string): ProcessRunResult {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function tool(name: string): ToolInfo {
  return { name, description: '', mcp: name.startsWith('mcp__') }
}

function startSession(on: On, root = '/repo'): void {
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.root', () => ({ value: root }))
  on('session.cwd', () => ({ value: root }))
}

test('Checks: a repo with none saved asks, suggests from package.json, saves what is ticked, then runs it', async ($, on) => {
  const stored: Record<string, unknown> = {}
  const clock = mock.clock(on)
  // Started in a subfolder: the checks are the repo's, keyed by its top folder.
  startSession(on, '/repo/packages/app')
  on('store.set', { key: 'settings:/repo' }, ($, e, next) => {
    stored[e.key] = e.value

    return next(e)
  })
  mock.store(on)
  on('fs.read', ($, e) => (e.path === '/repo/package.json' ? { value: PACKAGE_JSON } : { deny: 'ENOENT' }))
  on('fs.list', () => ({ value: [{ name: 'pnpm-lock.yaml', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  const runs: string[][] = []
  on('process.run', ($, e) => {
    if (e.argv.includes('--show-toplevel')) return { value: ran(0, '/repo\n') }
    if (e.argv[0] !== 'git' && e.argv[0] !== 'gh') runs.push([...e.argv])

    return { value: ran(0, '') }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(80) })
  expect((await band.find({ key: 'dock-tab-checks' }))?.text).toBe('✅ set up')

  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  expect(await ui.find({ type: 'Text', text: /⚙ Checks settings/ })).toBeDefined()
  expect((await ui.find({ key: 'checks-pick-lint' }))?.props.label).toBe('☐ lint · pnpm run lint')
  expect(await ui.find({ key: 'checks-run-lint' })).toBeUndefined()

  await ui.press({ key: 'checks-pick-lint' })
  expect((await ui.find({ key: 'checks-pick-lint' }))?.props.label).toBe('☑ lint · pnpm run lint')
  await ui.input({ key: 'checks-add-2', text: 'Smoke: make smoke', kind: 'submit' })
  expect((await ui.find({ key: 'checks-pick-smoke' }))?.props.label).toBe('☑ smoke · make smoke')
  await ui.press({ key: 'checks-settings-done' })

  expect(stored['settings:/repo']).toEqual({
    checks: [
      { id: 'lint', name: 'Lint', argv: ['pnpm', 'run', 'lint'] },
      { id: 'smoke', name: 'Smoke', argv: ['make', 'smoke'] }
    ]
  })
  expect(await ui.find({ key: 'checks-pick-lint' })).toBeUndefined()
  expect(await ui.find({ key: 'checks-run-smoke' })).toBeDefined()
  expect((await band.find({ key: 'dock-tab-checks' }))?.text).toBe('✅ –')
  expect(runs).toEqual([])

  await ui.press({ key: 'checks-run-smoke' })
  await clock.advance(10)
  expect(runs).toEqual([['make', 'smoke']])

  // ⚙ reopens the form with the saved checks ticked and the other suggestions beside them.
  await ui.press({ key: 'dock-main-settings-checks' })
  expect((await ui.find({ key: 'checks-pick-smoke' }))?.props.label).toBe('☑ smoke · make smoke')
  expect((await ui.find({ key: 'checks-pick-test' }))?.props.label).toBe('☐ test · pnpm run test')
  await ui.unmount()
  await band.unmount()
})

function json(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }
}

test('Jira: no server says so and polls nothing; two servers ask once, then the choice is saved and the tickets load', async ($, on) => {
  const stored: Record<string, unknown> = {}
  const calls: string[] = []
  let tools: ToolInfo[] = []
  const clock = mock.clock(on)
  startSession(on)
  on('store.set', { key: 'settings' }, ($, e, next) => {
    stored[e.key] = e.value

    return next(e)
  })
  mock.store(on)
  on('tool.list', () => ({ value: tools }))
  on('process.run', () => ({ value: ran(0, 'develop\n') }))
  on('mcp.call', ($, e) => {
    calls.push(`${e.server}:${e.tool}`)
    if (e.tool === 'getAccessibleAtlassianResources') return { value: json([{ id: SITE.cloudId, url: SITE.url, name: 'acme' }]) }
    if (e.tool === 'searchJiraIssuesUsingJql') {
      return { value: json({ issues: [{ key: 'ABC-1', fields: { summary: 'First', status: { name: 'To Do', id: '1', statusCategory: { key: 'new' } } } }] }) }
    }

    return { value: json({}) }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await ui.press({ key: 'dock-main-manage' })
  await ui.press({ key: 'dock-main-enable-1-jira' })
  await ui.press({ key: 'dock-main-manage' })
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(80) })
  expect(await ui.find({ type: 'Text', text: 'Connect an Atlassian MCP server to use this panel' })).toBeDefined()
  expect((await band.find({ key: 'dock-tab-jira' }))?.text).toBe('🎫 –')
  await clock.advance(300_000)
  expect(calls).toEqual([])

  tools = ['atlassian', 'other'].flatMap(server => ['getJiraIssue', 'searchJiraIssuesUsingJql'].map(name => tool(`mcp__${server}__${name}`)))
  await ui.press({ key: 'jira-refresh' })
  expect((await band.find({ key: 'dock-tab-jira' }))?.text).toBe('🎫 set up')
  expect(await ui.find({ type: 'Text', text: 'Pick the Atlassian MCP server to read Jira through.' })).toBeDefined()
  await ui.press({ key: 'jira-save' })
  expect(await ui.find({ type: 'Text', text: 'Pick a server and a site first.' })).toBeDefined()
  expect(stored.settings).toBeUndefined()

  await ui.press({ key: 'jira-setup-server-1' })
  expect(calls).toEqual(['other:getAccessibleAtlassianResources'])
  await ui.press({ key: 'jira-save' })
  expect(stored.settings).toEqual({ jira: { server: 'other', flavour: 'standard', site: { ...SITE, name: 'acme' } } })
  expect(calls).toContain('other:searchJiraIssuesUsingJql')
  expect(await ui.find({ key: 'jira-save' })).toBeUndefined()
  expect(await ui.find({ key: 'jira-setup' })).toBeUndefined()
  expect(await ui.find({ key: 'jira-setup-server-0' })).toBeUndefined()

  // ⚙ reopens it filled in, with the query and branch fields.
  await ui.press({ key: 'dock-main-settings-jira' })
  await ui.input({ key: 'jira-setup-field-jql', text: 'project = ABC', kind: 'change' })
  await ui.input({ key: 'jira-setup-field-branchTemplate', text: 'feat/{key}-', kind: 'change' })
  await ui.press({ key: 'jira-save' })
  expect(stored.settings).toEqual({
    jira: { server: 'other', flavour: 'standard', site: { ...SITE, name: 'acme' }, jql: 'project = ABC' },
    branchTemplate: 'feat/{key}-'
  })
  await ui.unmount()
  await band.unmount()
})
