import type { On, RenderPropsOf, UiPane } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { DockLayout, DockView, DockViewTab } from '../types'
import {
  DEFAULT_LAYOUT,
  activeView,
  addDock,
  bandPanelIds,
  fitBand,
  focusPanel,
  hiddenPaneIds,
  isFocusedOn,
  isShownIn,
  isTabActive,
  paneChanges,
  parseDockKey,
  reconcileLayout,
  removeDock,
  restoreLayout,
  shownPanels,
  swapPosition,
  tabTarget,
  withKnownPanels,
} from '../hooks/dock/layout'
import { buildNewPanelPrompt, listMcpServerNames } from '../hooks/dock/prompts'
import { cellWidth, fitEnd, fitStart, splitPath } from '../hooks/dock/ui'

const SURFACES = ['terminal', 'desktop'] as const
const ALL_SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const IDS = ['branch', 'checks', 'jira']

function paneProps(bodyColumns: number): RenderPropsOf['Pane'] {
  return {
    title: 'Dock',
    isFocused: true,
    bodyColumns,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  }
}

function bandProps(bodyColumns: number): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns, scroll: { offset: 0, bodyRows: 5 }, view: {} }
}

/** A dock with one view holding `panels`, as the tests set it up. */
interface DockSetup extends Partial<Omit<DockView, 'views'>> {
  panels?: string[]
  minimized?: string[]
}

function dockOf(id: string, change: DockSetup = {}): DockView {
  const { panels = [], minimized = [], ...rest } = change
  const view: DockViewTab = { id: '1', panels, minimized, direction: rest.position === 'bottom' ? 'row' : 'column', widths: {} }

  return { id, name: `Dock ${id}`, position: 'right', views: [view], activeViewId: '1', isOpen: false, view: 'panels', usedAt: 0, ...rest }
}

function layoutOf(docks: DockView[], lastDockId = docks[0]?.id ?? 'main'): DockLayout {
  return { docks, lastDockId, known: IDS }
}

/** The panes the session holds, opened and closed through the engine's own events. */
function mockPanes(on: On): Set<string> {
  const panes = new Set<string>()
  on('ui.open', ($, e) => {
    panes.add(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => {
    const open: UiPane[] = [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true }))

    return { value: open }
  })
  on('ui.scroll', () => ({}))

  return panes
}

describe('buildNewPanelPrompt', () => {
  test('names the guide, the derived id and every answer', () => {
    const draft = { name: 'My Deploys!', icon: '🚀', shows: 'the last 5 deploys', connector: 'mcp:github', refresh: '5m' } as const
    const text = buildNewPanelPrompt(draft, { guidePath: '/mod/PANEL_GUIDE.md', companionRoot: '/me/panels' })

    expect(text).toContain('in my own panels plugin at /me/panels')
    expect(text).toContain('Read "Your own panels" in /mod/PANEL_GUIDE.md first')
    expect(text).toContain('Write and Edit tools only (no shell cp, mkdir or sed), and only under /me/panels')
    expect(text).toContain('npx -y -p typescript@5 tsc -p /me/panels')
    expect(text).toContain('claude plugin test /me/panels')
    expect(text).not.toContain('/reload-plugins')
    expect(buildNewPanelPrompt(draft, { guidePath: '/g', companionRoot: '/me/panels', isNew: true })).toContain(
      'Before the checks, ask me to run\n/reload-plugins and wait for me',
    )
    expect(text).not.toContain('hooks/panels/custom')
    expect(text).toContain('Panel id: `my-deploys`')
    expect(text).toContain('What it shows: the last 5 deploys')
    expect(text).toContain('the MCP server `github`')
    expect(text).toContain('every 5 min')
    expect(text).toMatch(/Actions \/ buttons: \(not given/)
  })
})

test('listMcpServerNames keeps each server once, sorted', () => {
  const tools = ['Read', 'mcp__github__get_me', 'mcp__claude_ai_Slack__send', 'mcp__github__list_issues'].map(name => ({
    name,
    description: '',
    mcp: name.startsWith('mcp__'),
  }))

  expect(listMcpServerNames(tools)).toEqual(['claude_ai_Slack', 'github'])
})

test('the one-dock layout of before becomes the main dock; a new session starts closed, a reload keeps what it holds', () => {
  const stored = { isOpen: true, view: 'manage', order: ['jira', 'gone', 'branch'], disabled: ['gone', 'checks'], minimized: ['jira'] }
  const restored = restoreLayout(stored, IDS)

  expect(restored).toEqual({
    docks: [dockOf('main', { name: 'Dock', panels: ['jira', 'branch'], minimized: ['jira'] })],
    lastDockId: 'main',
    known: IDS,
  })
  expect(reconcileLayout({ ...stored, focused: 'jira' }, IDS, ['claudedockula'])).toMatchObject({
    docks: [{ id: 'main', isOpen: true, view: 'manage', focused: 'jira', views: [{ panels: ['jira', 'branch'] }] }],
  })

  const held = layoutOf([dockOf('main', { isOpen: true, panels: ['jira'] }), dockOf('2', { position: 'bottom', isOpen: true })])
  expect(restoreLayout(held, IDS).docks.map(dock => dock.isOpen)).toEqual([false, true])
  expect(reconcileLayout(held, IDS, []).docks.map(dock => dock.isOpen)).toEqual([false, true])
  // An empty store: every panel in the main dock.
  expect(restoreLayout(undefined, IDS).docks.map(shownPanels)).toEqual([IDS])
})

test('a panel never placed before joins the last used dock once; one taken out stays out', () => {
  const layout = layoutOf([dockOf('main', { panels: ['branch'] }), dockOf('2', { panels: ['gone'] })], '2')
  const known = withKnownPanels({ ...layout, known: ['branch', 'checks', 'gone'] }, IDS)

  expect(known.docks.map(shownPanels)).toEqual([['branch'], ['jira']])
  expect(withKnownPanels(known, IDS)).toEqual(known)
  expect(bandPanelIds(known)).toEqual(['branch', 'jira'])
})

test('docks are added empty on their Manage view, one at the bottom at most, the last never removed', () => {
  const right = addDock(DEFAULT_LAYOUT, 'right')
  const both = addDock(right, 'bottom')

  expect(right.docks[1]).toMatchObject({ id: '2', name: 'Dock 2', position: 'right', views: [{ panels: [] }], isOpen: true, view: 'manage' })
  expect(right.lastDockId).toBe('2')
  expect(both.docks.map(dock => [dock.id, dock.position])).toEqual([['main', 'right'], ['2', 'right'], ['3', 'bottom']])
  expect(addDock(both, 'bottom')).toBe(both)
  expect(removeDock(both, '3').lastDockId).toBe('2')
  expect(removeDock(DEFAULT_LAYOUT, 'main')).toBe(DEFAULT_LAYOUT)
})

test('a removed dock hands the panels no other dock shows to the last used dock, minimized as they were', () => {
  const layout = layoutOf(
    [
      dockOf('main', { panels: ['branch', 'jira'], minimized: ['jira'], usedAt: 1 }),
      dockOf('2', { panels: ['jira', 'checks'], usedAt: 2 }),
      dockOf('3', { panels: ['branch'], usedAt: 3 }),
    ],
    '3',
  )
  const after = removeDock(layout, 'main')

  expect(after.docks.map(shownPanels)).toEqual([['jira', 'checks'], ['branch']])
  expect(removeDock(layout, '3').docks.map(shownPanels)).toEqual([['branch', 'jira'], ['jira', 'checks']])
  expect(removeDock(layout, '2').docks.map(dock => [shownPanels(dock), activeView(dock).minimized])).toEqual([[['branch', 'jira'], ['jira']], [['branch', 'checks'], []]])
  const alone = removeDock(layoutOf([dockOf('main', { panels: ['checks'], minimized: ['checks'] }), dockOf('2', { usedAt: 1 })], 'main'), 'main')
  expect(alone.docks[0]).toMatchObject({ id: '2', views: [{ panels: ['checks'], minimized: ['checks'] }] })
})

test('two stored open bottom docks leave one bottom dock, the other a closed right dock', () => {
  const held = layoutOf([dockOf('main'), dockOf('2', { position: 'bottom', isOpen: true }), dockOf('3', { position: 'bottom', isOpen: true })])

  for (const layout of [restoreLayout(held, IDS), reconcileLayout(held, IDS, [])]) {
    expect(layout.docks.map(dock => [dock.id, dock.position, dock.isOpen])).toEqual([['main', 'right', false], ['2', 'bottom', true], ['3', 'right', false]])
  }
})

test('a pane behind another pane\'s tab is not shown, nor its tab active', () => {
  const layout = layoutOf([dockOf('main', { isOpen: true, panels: ['jira'], focused: 'jira' })])
  const hidden = hiddenPaneIds([{ id: 'claudedockula', title: '', isShown: false, isFocused: false, isPlaced: true }])

  expect([isShownIn(layout, 'jira'), isTabActive(layout, 'jira')]).toEqual([true, true])
  expect([isShownIn(layout, 'jira', hidden), isTabActive(layout, 'jira', hidden)]).toEqual([false, false])
})

test('⇄ swaps a right dock with the bottom one; the panes follow', () => {
  const before = layoutOf([dockOf('main', { isOpen: true }), dockOf('2', { position: 'bottom', isOpen: true })])
  const after = swapPosition(before, 'main')

  expect(after.docks.map(dock => [dock.id, dock.position, dock.isOpen])).toEqual([
    ['main', 'bottom', true],
    ['2', 'right', true],
  ])
  expect(paneChanges(before, after)).toEqual({ opens: [after.docks[1]], closes: ['claudedockula'] })
  expect(swapPosition(after, 'main').docks.map(dock => dock.position)).toEqual(['right', 'right'])
})

test('a band tab shows its panel in the most recent open dock holding it, else in the last used dock', () => {
  const layout = layoutOf(
    [
      dockOf('main', { panels: ['branch', 'jira'], isOpen: true, usedAt: 1 }),
      dockOf('2', { panels: ['jira'], isOpen: true, usedAt: 3 }),
      dockOf('3', { position: 'bottom', panels: ['checks'], usedAt: 2 }),
    ],
    '3',
  )

  expect(tabTarget(layout, 'jira').id).toBe('2')
  expect(tabTarget(layout, 'branch').id).toBe('main')
  expect(tabTarget(layout, 'checks').id).toBe('3')

  const focused = focusPanel(layout, '3', 'jira')
  const bottom = focused.docks[2]
  expect(bottom).toMatchObject({ isOpen: true, views: [{ panels: ['checks', 'jira'] }], focused: 'jira' })
  expect(bottom && isFocusedOn(bottom, 'jira')).toBe(true)
  expect(focused.lastDockId).toBe('3')
})

test('dock keys name their dock, action and panel', () => {
  expect(parseDockKey('dock-2-swap')).toEqual({ dockId: '2', action: 'swap' })
  expect(parseDockKey('dock-main-new-bottom')).toEqual({ dockId: 'main', action: 'new-bottom' })
  expect(parseDockKey('dock-main-up-1-my-panel')).toEqual({ dockId: 'main', action: 'up', viewId: '1', panelId: 'my-panel' })
  expect(parseDockKey('dock-tab-jira')).toBe(undefined)
  expect(parseDockKey('dock-main-card-jira')).toBe(undefined)
})

test('cell widths: emoji and CJK take two cells; cuts keep the start or the end', () => {
  const tabs = [
    { id: 'branch', icon: '🌿', summary: 'ABC-101 ·3' },
    { id: 'checks', icon: '✅', summary: '4/4' },
  ]

  expect(cellWidth('🌿 ABC-101 ·3')).toBe(13)
  expect(cellWidth('進行中')).toBe(6)
  expect(cellWidth('⚙️')).toBe(2)
  expect(fitEnd('table-download', 8)).toBe('table-d…')
  expect(fitStart('src/a/Item.tsx', 9)).toBe('…Item.tsx')
  expect(splitPath('src/app/Item.tsx')).toEqual({ name: 'Item.tsx', dir: 'src/app' })
  expect(fitBand(tabs, 27, '➕')).toEqual({ hasSummaries: true, gap: 3 })
  expect(fitBand(tabs, 20, '➕')).toEqual({ hasSummaries: false, gap: 2 })
})

test('a band tab opens the pane on its panel, the same tab closes it, and so does ✕ Close', async ($, on) => {
  mock.store(on)
  const panes = mockPanes(on)

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'AbovePrompt', props: bandProps(80) })
    const pane = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
    expect((await band.find({ key: 'dock-tab-branch' }))?.text).toBe('🌿 …')
    expect(await band.find({ key: 'dock-tab-add' })).toBeDefined()

    await band.press({ key: 'dock-tab-jira' })
    expect(panes.has('claudedockula')).toBe(true)
    expect(await pane.find({ key: 'dock-main-card-jira' })).toBeDefined()
    expect(await pane.find({ key: 'jira-refresh' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /failed:/ })).toBeUndefined()

    await band.press({ key: 'dock-tab-jira' })
    expect(panes.has('claudedockula')).toBe(false)

    await band.press({ key: 'dock-tab-branch' })
    await pane.press({ key: 'dock-main-manage' })
    expect(await pane.find({ key: 'dock-main-enable-1-jira' })).toBeDefined()
    await pane.press({ key: 'dock-main-close' })
    expect(panes.has('claudedockula')).toBe(false)

    await band.redraw(bandProps(20))
    expect((await band.find({ key: 'dock-tab-branch' }))?.text).toBe('🌿')
    await band.unmount()
    await pane.unmount()
  }
})

test('a right dock and a bottom dock: ➕ adds one at the bottom, the band draws it above the tabs, ⇄ swaps them', async ($, on) => {
  mock.store(on)
  const panes = mockPanes(on)
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(120) })
  await band.press({ key: 'dock-tab-branch' })
  const main = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await main.press({ key: 'dock-main-menu' })
  expect(await main.find({ key: 'dock-main-new-right' })).toBeDefined()
  await main.press({ key: 'dock-main-new-bottom' })
  expect(await main.find({ key: 'dock-main-new-bottom' })).toBeUndefined()

  for (const surface of SURFACES) {
    const other = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'AbovePrompt', props: bandProps(120) })
    expect(await other.find({ type: 'Text', text: '🧭 Dock 2' })).toBeDefined()
    expect(await other.find({ key: 'dock-2-enable-1-branch' })).toBeDefined()
    await other.unmount()
  }
  await band.press({ key: 'dock-2-enable-1-branch' })
  await band.press({ key: 'dock-2-enable-1-jira' })
  await band.input({ key: 'dock-2-name', text: 'Bottom' })
  await band.press({ key: 'dock-2-manage' })
  expect(await band.find({ type: 'Text', text: '🧭 Bottom' })).toBeDefined()
  expect(await band.find({ key: 'dock-2-card-jira' })).toBeDefined()
  expect(await band.find({ key: 'dock-tab-branch' })).toBeDefined()

  // ⇄ on the right dock takes it down; the bottom dock comes up to the right in its place.
  await main.press({ key: 'dock-main-swap' })
  expect([...panes]).toEqual(['claudedockula-2'])
  expect(await band.find({ type: 'Text', text: '🧭 Dock' })).toBeDefined()
  // ⇄ in the band takes it back up: two right docks, none at the bottom.
  await band.press({ key: 'dock-main-swap' })
  expect([...panes].sort()).toEqual(['claudedockula', 'claudedockula-2'])
  expect(await band.find({ type: 'Text', text: /^🧭/ })).toBeUndefined()
  await band.unmount()
  await main.unmount()

  for (const surface of ALL_SURFACES) {
    const pane = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'Pane', requestId: 'claudedockula-2', props: paneProps(56) })
    await expect(pane.drawn()).resolves.toBeDefined()
    expect(await pane.find({ key: 'dock-2-card-jira' })).toBeDefined()
    await pane.unmount()
  }
})

test('the New panel form reads the servers once, sets up the panels plugin without overwriting it and sends the guide prompt', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/home/me' })
  const companion = '/home/me/.claude/skills/dockula-panels'
  const files = new Map([[`${companion}/hooks/register.tsx`, 'mine']])
  const written: string[] = []
  let isWriteFailing = false
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: `template of ${e.path.slice(e.path.indexOf('/template/'))}` }))
  on('fs.write', ($, e) => {
    if (isWriteFailing) return { deny: 'read-only file system' }
    written.push(e.path.slice(companion.length + 1))
    files.set(e.path, e.text)

    return { value: undefined }
  })
  const filled: string[] = []
  let listings = 0
  on('tool.list', () => {
    listings += 1

    return { value: [{ name: 'mcp__github__get_me', description: '', mcp: true }] }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))

  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(80) })
  await band.press({ key: 'dock-tab-add' })
  await band.unmount()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'Pane', requestId: 'claudedockula-new', props: paneProps(60) })
    expect(await ui.drawn()).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula-new', props: paneProps(60) })
  await ui.input({ key: 'dock-new-name', text: 'Deploys', kind: 'change' })
  await ui.input({ key: 'dock-new-shows', text: 'the last 5 deploys', kind: 'change' })
  expect((await ui.find({ key: 'dock-new-name' }))?.props.value).toBe('')
  await ui.select({ key: 'dock-new-connector', value: 'mcp:github' })
  await ui.press({ key: 'dock-new-send' })

  expect(listings).toBe(1)
  expect(filled).toHaveLength(1)
  expect(filled[0]).toContain('/PANEL_GUIDE.md')
  expect(filled[0]).toContain(`plugin at ${companion}`)
  expect(filled[0]).toContain('/reload-plugins')
  expect(filled[0]).toContain('Panel id: `deploys`')
  expect(filled[0]).toContain('the MCP server `github`')
  expect(written).toEqual([
    'hooks/hooks.json',
    'hooks/panels/index.ts',
    'hooks/kit/spans.ts',
    'types/index.d.ts',
    'tsconfig.json',
    'tests/panels.test.ts',
    '.claude-plugin/plugin.json',
  ])
  expect(files.get(`${companion}/hooks/register.tsx`)).toBe('mine')
  expect(files.get(`${companion}/hooks/kit/spans.ts`)).toBe('template of /template/companion/hooks/kit/spans.ts.tmpl')

  // Set up once: the next panel writes nothing.
  await ui.input({ key: 'dock-new-name', text: 'Deploys', kind: 'change' })
  await ui.input({ key: 'dock-new-shows', text: 'the last 5 deploys', kind: 'change' })
  await ui.press({ key: 'dock-new-send' })
  expect(written).toHaveLength(7)
  expect(filled).toHaveLength(2)
  expect(filled[1]).not.toContain('/reload-plugins')
  await ui.unmount()

  // A write that fails says where and why, and sends no prompt.
  files.delete(`${companion}/.claude-plugin/plugin.json`)
  isWriteFailing = true
  const retry = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula-new', props: paneProps(60) })
  await retry.input({ key: 'dock-new-name', text: 'Deploys', kind: 'change' })
  await retry.input({ key: 'dock-new-shows', text: 'the last 5 deploys', kind: 'change' })
  await retry.press({ key: 'dock-new-send' })
  await retry.unmount()
  expect(filled).toHaveLength(2)
  const failed = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(80) })
  const notice = await failed.find({ type: 'Button', text: /⚠ Couldn't set up your panels plugin/ })
  await failed.press({ key: notice?.key ?? '' })
  expect(await failed.find({ type: 'Text', text: /dockula-panels\/\.claude-plugin\/plugin\.json: .*read-only file system/ })).toBeDefined()
  await failed.unmount()

  const after = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(80) })
  expect(await after.find({ type: 'Text', text: /Prompt ready — review and press Enter/ })).toBeDefined()
  await after.unmount()
})

test('a reload runs session.start again and keeps the layout the session holds', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start(start)
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await pane.press({ key: 'dock-main-toggle-jira' })
  await pane.press({ key: 'dock-main-manage' })
  await $.session.start(start)

  expect(await pane.find({ key: 'dock-main-enable-1-jira' })).toBeDefined()
  await pane.press({ key: 'dock-main-manage' })
  expect(String((await pane.find({ key: 'dock-main-toggle-jira' }))?.props.label).trimEnd()).toBe('▸ 🎫 Jira · assigned to me')
  await pane.unmount()
})

test('an old held layout migrates on session.start, stale panes close, and /dock, Remove dock and rename drive the panes', async ($, on) => {
  const old = { isOpen: true, order: ['jira', 'branch'], disabled: ['checks'], minimized: ['branch'], focused: 'jira' }
  mock.store(on, { layout: old })
  mock.clock(on)
  const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
  const panes = new Map([['claudedockula', 'Old'], ['claudedockula-new', 'New panel'], ['claudedockula-7', 'Stale']])
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    panes.set(e.id, e.title ?? e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes].map(([id, title]) => ({ id, title, isShown: true, isFocused: false, isPlaced: true })) }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal', isStdoutTruncated: false, isStderrTruncated: false } }))
  const run = async (args: string) =>
    (await $.command.run({ command: 'dock', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text

  await $.session.start(start)
  const main = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  expect(await main.find({ key: 'dock-main-card-jira' })).toBeDefined()
  expect(String((await main.find({ key: 'dock-main-toggle-branch' }))?.props.label).trimEnd()).toBe('▸ 🌿 Branch')
  expect(panes.has('claudedockula-7')).toBe(false)
  expect(panes.has('claudedockula-new')).toBe(true)

  expect(await run('bottom')).toMatch(/added at the bottom/)
  expect(await run('bottom')).toBe('Dock 2 opened.')
  expect(await run('right')).toBe('Dock opened.')
  expect(await run('manage')).toBe('Manage Dock open.')
  expect(await main.find({ key: 'dock-main-enable-1-jira' })).toBeDefined()

  await main.press({ key: 'dock-main-menu' })
  await main.press({ key: 'dock-main-new-right' })
  expect(panes.has('claudedockula-3')).toBe(true)
  const third = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula-3', props: paneProps(56) })
  await third.press({ key: 'dock-3-remove' })
  await third.unmount()
  expect(panes.has('claudedockula-3')).toBe(false)
  expect(await run('bottom')).toBe('Dock 2 opened.')

  await main.input({ key: 'dock-main-name', text: 'Work', kind: 'submit' })
  expect(panes.get('claudedockula')).toContain('Work')
  await main.unmount()
})
