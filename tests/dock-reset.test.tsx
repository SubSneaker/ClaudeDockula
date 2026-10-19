import type { On, RenderPropsOf } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import { parseDockKey } from '../hooks/dock/layout'
import { keysToClear, resetLayout } from '../hooks/dock/reset'

function paneProps(bodyColumns: number): RenderPropsOf['Pane'] {
  return { title: 'Dock', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }
}

const SLOW = { timeoutMs: 30_000 }
const IDS = ['branch', 'checks', 'activity', 'jira', 'slacker', 'gitgud']
const BUILT_IN = IDS
const OPT_IN = ['jira', 'slacker']

const STORED = {
  settings: { ticketPattern: 'X' },
  'settings:/repo': { checks: [] },
  'slacker:keywords': ['ship'],
  'gitgud:settings': { pollSeconds: 300 },
  'gitgud:alerted': ['a'],
  'gitgud:migrated': 1,
  'gitgud:docs': ['/doc.md'],
  'panels:seen': { jira: 1 }
}

test('the reset keys parse as dock actions, and the pure helpers pick the layout and keys', () => {
  for (const action of ['reset-layout', 'reset-all', 'reset-layout-yes', 'reset-all-yes', 'reset-no']) {
    expect(parseDockKey(`dock-main-${action}`)).toEqual({ dockId: 'main', action })
    expect(parseDockKey(`dock-2-${action}`)).toEqual({ dockId: '2', action })
  }
  const fresh = resetLayout(IDS, BUILT_IN, OPT_IN)
  expect(fresh.docks).toHaveLength(1)
  expect(fresh.docks[0]).toMatchObject({ id: 'main', isOpen: true, view: 'panels' })
  expect(fresh.docks[0]?.views[0]?.panels).toEqual(['branch', 'checks', 'activity', 'gitgud'])
  expect(keysToClear(['layout', 'settings', 'gitgud:docs', 'gitgud:migrated', 'settings:/repo'])).toEqual(['settings', 'settings:/repo'])
})

async function start($: Engine, on: On, layout: unknown) {
  mock.clock(on)
  const closed: string[] = []
  const written: string[] = []
  const deleted: string[] = []
  on('store.set', { key: /./ }, ($, e, next) => {
    written.push(e.key)

    return next(e)
  })
  on('store.delete', { key: /./ }, ($, e, next) => {
    deleted.push(e.key)

    return next(e)
  })
  mock.store(on, { layout, ...STORED })
  const commands: string[] = []
  let isEnvSet = false
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', ($, e) => {
    closed.push(e.id)

    return { value: undefined }
  })
  on('env.set', () => {
    isEnvSet = true

    return { deny: 'test' }
  })
  on('process.run', (_$, e) => {
    commands.push(JSON.stringify(e))

    return { value: { exitCode: 128, stdout: '', stderr: 'fatal', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(80) })
  await pane.press({ key: 'dock-main-manage' })

  return { pane, closed, written, deleted, commands, isEnvSet: () => isEnvSet }
}

const BIG_LAYOUT = {
  docks: [
    { id: 'main', name: 'Dock', position: 'right', views: [{ id: '1', panels: ['branch', 'slacker'], minimized: [], direction: 'column', widths: {} }], activeViewId: '1', isOpen: true, view: 'panels', usedAt: 1 },
    { id: '2', name: 'Dock 2', position: 'right', views: [{ id: '1', panels: ['jira'], minimized: [], direction: 'column', widths: {} }], activeViewId: '1', isOpen: true, view: 'panels', usedAt: 2 }
  ],
  lastDockId: '2',
  known: IDS
}

test('Reset layout asks, then gives back a new install layout and touches nothing else', SLOW, async ($, on) => {
  const { pane, closed, written, deleted } = await start($, on, BIG_LAYOUT)
  await pane.press({ key: 'dock-main-reset-layout' })
  expect(await pane.find({ key: 'dock-main-reset-layout-yes' })).toBeDefined()
  expect(await pane.find({ key: 'dock-main-reset-layout' })).toBeUndefined()
  written.length = 0
  await pane.press({ key: 'dock-main-reset-layout-yes' })

  expect(new Set(written)).toEqual(new Set(['layout']))
  expect(deleted).toEqual([])
})

test('Reset all settings clears every key but the kept ones, and never reaches the keychain or the environment', SLOW, async ($, on) => {
  const { pane, deleted, written, commands, isEnvSet } = await start($, on, BIG_LAYOUT)
  await pane.press({ key: 'dock-main-reset-all' })
  await pane.press({ key: 'dock-main-reset-all-yes' })

  const kept = ['layout', 'gitgud:migrated', 'gitgud:docs']
  expect(deleted.sort()).toEqual(Object.keys(STORED).filter(key => !kept.includes(key)).sort())
  expect(commands.some(command => /security|secret-tool/.test(command))).toBe(false)
  expect(isEnvSet()).toBe(false)
})

test('No closes the question and changes nothing', SLOW, async ($, on) => {
  const { pane, deleted } = await start($, on, BIG_LAYOUT)
  for (const action of ['reset-layout', 'reset-all']) {
    await pane.press({ key: `dock-main-${action}` })
    expect(await pane.find({ key: `dock-main-${action}-yes` })).toBeDefined()
    await pane.press({ key: 'dock-main-reset-no' })
    expect(await pane.find({ key: `dock-main-${action}` })).toBeDefined()
    expect(await pane.find({ key: `dock-main-${action}-yes` })).toBeUndefined()
  }
  expect(deleted).toEqual([])
})
