import type { McpToolResult, On, ProcessRunResult, RenderPropsOf, ToolInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SITE = { cloudId: 'abc', url: 'https://acme.atlassian.net' }
const SEED = { jira: { server: 'atlassian', flavour: 'standard', site: SITE } }
const SEARCH = 'searchJiraIssuesUsingJql'

const SLOW = { timeoutMs: 30_000 }

function paneProps(): RenderPropsOf['Pane'] {
  return { title: 'Dock', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }
}

function ran(stdout: string): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function tool(name: string): ToolInfo {
  return { name, description: '', mcp: true }
}

function json(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }
}

/** A set up Jira session; `branch.write` is another panel saving the shared settings after Jira read them. */
async function start($: Parameters<NonNullable<Parameters<typeof test>[2]>>[0], on: On, servers: string[], seed: unknown = SEED) {
  const stored: Record<string, unknown> = {}
  const searches: number[] = []
  const branch = { latest: undefined as unknown }
  const clock = mock.clock(on)
  on('store.get', { key: 'settings' }, ($, e, next) => (branch.latest === undefined ? next(e) : { value: branch.latest }))
  for (const key of ['settings', 'jira:settings']) {
    on('store.set', { key }, ($, e, next) => {
      stored[e.key] = e.value
      if (e.key === 'settings') branch.latest = e.value

      return next(e)
    })
  }
  mock.store(on, { settings: seed })
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: ran('develop\n') }))
  on('tool.list', () => ({ value: servers.flatMap(server => ['getJiraIssue', SEARCH].map(name => tool(`mcp__${server}__${name}`))) }))
  on('mcp.call', ($, e) => {
    if (e.tool === 'getAccessibleAtlassianResources') return { value: json([{ id: SITE.cloudId, url: SITE.url, name: 'acme' }]) }
    if (e.tool === SEARCH) searches.push(1)

    return { value: json({ issues: [] }) }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps() })
  // Jira is off by default: tick it into the main dock's view.
  await ui.press({ key: 'dock-main-manage' })
  await ui.press({ key: 'dock-main-enable-1-jira' })
  await ui.press({ key: 'dock-main-manage' })

  return { ui, stored, searches, branch, clock }
}

test('the header ⚙ opens the form, the body has no ⚙, and Save keeps a ticket pattern Branch wrote meanwhile', SLOW, async ($, on) => {
  const { ui, stored, branch } = await start($, on, ['atlassian'])
  expect(await ui.find({ key: 'jira-setup' })).toBeUndefined()

  await ui.press({ key: 'dock-main-settings-jira' })
  expect(await ui.find({ type: 'Text', text: /⚙ Jira settings/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Ticket pattern: set in 🌿 Branch ⚙' })).toBeDefined()
  expect(await ui.find({ key: 'jira-setup-field-ticketPattern' })).toBeUndefined()

  await ui.input({ key: 'jira-setup-field-jql', text: 'project = ABC', kind: 'change' })
  // Branch's ⚙ saves a pattern after this form was opened.
  branch.latest = { ...SEED, ticketPattern: 'ABC-\\d+' }
  await ui.press({ key: 'jira-save' })

  expect(stored.settings).toMatchObject({ jira: { server: 'atlassian', jql: 'project = ABC' }, ticketPattern: 'ABC-\\d+' })
  await ui.unmount()
})

test('List refresh saves with Save and restarts the timer at the new pace', SLOW, async ($, on) => {
  const { ui, stored, searches, clock } = await start($, on, ['atlassian'])
  await clock.advance(1000)
  const loaded = searches.length

  await ui.press({ key: 'dock-main-settings-jira' })
  await ui.press({ key: 'jira-set-refresh-300' })
  expect(stored['jira:settings']).toBeUndefined()
  await ui.press({ key: 'jira-save' })
  expect(stored['jira:settings']).toEqual({ listRefreshSeconds: 300 })

  const saved = searches.length
  expect(saved).toBeGreaterThan(loaded)
  await clock.advance(200_000)
  expect(searches.length).toBe(saved)
  await clock.advance(150_000)
  expect(searches.length).toBe(saved + 1)
  await ui.unmount()
})

test('Reset all settings makes Jira ask again', SLOW, async ($, on) => {
  const { ui } = await start($, on, ['atlassian', 'other'])
  expect(await ui.find({ key: 'jira-setup-server-0' })).toBeUndefined()

  await ui.press({ key: 'dock-main-manage' })
  await ui.press({ key: 'dock-main-reset-all' })
  await ui.press({ key: 'dock-main-reset-all-yes' })
  // The reset takes the opt-in panel out of the dock: tick it in again.
  await ui.press({ key: 'dock-main-manage' })
  await ui.press({ key: 'dock-main-enable-1-jira' })
  await ui.press({ key: 'dock-main-manage' })
  expect(await ui.find({ key: 'jira-setup-server-0' })).toBeDefined()
  await ui.unmount()
})

test('an unplaced Jira makes no call at session start or on reset, and ticking it in starts it', SLOW, async ($, on) => {
  const calls: string[] = []
  mock.clock(on)
  mock.store(on, { settings: SEED })
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: ran('develop\n') }))
  on('tool.list', () => ({ value: ['getJiraIssue', SEARCH].map(name => tool(`mcp__atlassian__${name}`)) }))
  on('mcp.call', ($, e) => {
    calls.push(e.tool)

    return { value: json({ issues: [] }) }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps() })
  expect(calls).toEqual([])

  await ui.press({ key: 'dock-main-manage' })
  await ui.press({ key: 'dock-main-reset-all' })
  await ui.press({ key: 'dock-main-reset-all-yes' })
  expect(calls).toEqual([])

  await ui.press({ key: 'dock-main-manage' })
  await ui.press({ key: 'dock-main-enable-1-jira' })
  expect(calls.length).toBeGreaterThan(0)
  await ui.unmount()
})
