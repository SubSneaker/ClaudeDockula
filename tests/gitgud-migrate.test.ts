import { expect, mock, test } from 'claude-code/testing'

import { PANEL_RENAMES, renamePanelId, renamePanelIds } from '../hooks/dock/layout'
import { renameSeen } from '../hooks/dock/panelNews'
import { MIGRATED_KEY, MIGRATION_VERSION, planMigration, planStoreMigration } from '../hooks/panels/gitgud/migrate'
import { legacyDocDirOf } from '../hooks/panels/gitgud/model'
import type { DockLayout, DockView } from '../types'

function dock(views: DockView['views'], change: Partial<DockView> = {}): DockView {
  return { id: 'main', name: 'Dock', position: 'right', views, activeViewId: '1', isOpen: false, view: 'panels', usedAt: 0, ...change }
}

const OLD_LAYOUT: DockLayout = {
  docks: [
    dock([{ id: '1', panels: ['branch', 'github'], minimized: ['github'], direction: 'row', widths: { github: 'half', branch: 'third' } }], { focused: 'github' })
  ],
  lastDockId: 'main',
  known: ['branch', 'github']
}

test('renamePanelId moves the id through panels, minimized, widths, focused and known', () => {
  const renamed = renamePanelId(OLD_LAYOUT, 'github', 'gitgud')
  const [view] = renamed.docks[0]?.views ?? []

  expect(view).toMatchObject({ panels: ['branch', 'gitgud'], minimized: ['gitgud'], widths: { gitgud: 'half', branch: 'third' } })
  expect(renamed.docks[0]?.focused).toBe('gitgud')
  expect(renamed.known).toEqual(['branch', 'gitgud'])
  expect(renamePanelId(renamed, 'github', 'gitgud')).toEqual(renamed)
  expect(renamePanelIds(OLD_LAYOUT, PANEL_RENAMES)).toEqual(renamed)
})

test('renamePanelId drops the old id when the new one is already there', () => {
  const both: DockLayout = {
    ...OLD_LAYOUT,
    docks: [dock([{ id: '1', panels: ['gitgud', 'github'], minimized: [], direction: 'column', widths: {} }])],
    known: ['github', 'gitgud']
  }
  const renamed = renamePanelId(both, 'github', 'gitgud')

  expect(renamed.docks[0]?.views[0]?.panels).toEqual(['gitgud'])
  expect(renamed.known).toEqual(['gitgud'])
})

test('renameSeen carries the heard revision to the new id', () => {
  expect(renameSeen({ github: 3, jira: 1 }, PANEL_RENAMES)).toEqual({ jira: 1, gitgud: 3 })
  expect(renameSeen({ github: 3, gitgud: 4 }, PANEL_RENAMES)).toEqual({ gitgud: 4 })
  expect(renameSeen({ jira: 1 }, PANEL_RENAMES)).toEqual({ jira: 1 })
  expect(renameSeen(undefined, PANEL_RENAMES)).toBeUndefined()
})

test('the store plan moves settings and docs once, drops the caches, and never overwrites a new key', () => {
  const plan = planStoreMigration({ 'github:settings': { isHaikuOn: false }, 'github:docs': [], 'gitgud:docs': [{ path: 'kept' }] })

  expect(plan.writes).toEqual({ 'gitgud:settings': { isHaikuOn: false } })
  expect(plan.deletes).toEqual(['github:settings', 'github:docs', 'github:alerted', 'github:alerted:overlap', 'github:oneliners', 'github:ciwhy'])
  expect(planStoreMigration({}).writes).toEqual({})
  expect(legacyDocDirOf('/c/', undefined)).toBe('/c/claudedockula/github')
})

test('session start moves the old keys once; a second start writes and deletes nothing', async ($, on) => {
  const sets: [string, unknown][] = []
  const deletes: string[] = []
  mock.clock(on, { now: Date.parse('2026-10-19T12:00:00Z') })
  for (const key of ['gitgud:settings', MIGRATED_KEY]) {
    on('store.set', { key }, ($, e, next) => {
      sets.push([e.key, e.value])

      return next(e)
    })
  }
  for (const key of ['github:settings', 'github:oneliners']) {
    on('store.delete', { key }, ($, e, next) => {
      deletes.push(e.key)

      return next(e)
    })
  }
  mock.store(on, { 'github:settings': { isHaikuOn: false }, 'github:oneliners': { a: 'x' } })
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.panes', () => ({ value: [] }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(sets).toContainEqual(['gitgud:settings', { isHaikuOn: false }])
  expect(sets).toContainEqual([MIGRATED_KEY, MIGRATION_VERSION])
  expect(deletes).toContain('github:settings')
  expect(deletes).toContain('github:oneliners')

  sets.length = 0
  deletes.length = 0
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(sets).toEqual([])
  expect(deletes).toEqual([])
})

test('version 2 gives repos and item ids their host, once, and leaves new-shape values alone', () => {
  const settings = { isHaikuOn: false, extraRepos: ['acme/web', 'gitlab.com/g/sub/proj'] }
  const docs = [{ path: '/d/a.md', itemId: 'acme/web#12' }, { path: '/d/b.md' }]
  const plan = planMigration({ [MIGRATED_KEY]: 1, 'gitgud:settings': settings, 'gitgud:docs': docs })

  expect(plan.marker).toBe(MIGRATION_VERSION)
  expect(plan.deletes).toEqual([])
  expect(plan.writes).toEqual({
    'gitgud:settings': { isHaikuOn: false, extraRepos: ['github.com/acme/web', 'gitlab.com/g/sub/proj'] },
    'gitgud:docs': [{ path: '/d/a.md', itemId: 'github.com/acme/web#12' }, { path: '/d/b.md' }]
  })

  const [hostedSettings, hostedDocs] = [plan.writes['gitgud:settings'], plan.writes['gitgud:docs']]
  expect(planMigration({ [MIGRATED_KEY]: 1, 'gitgud:settings': hostedSettings, 'gitgud:docs': hostedDocs }).writes).toEqual({})
  expect(planMigration({ [MIGRATED_KEY]: 2, 'gitgud:settings': settings }).writes).toEqual({})
  expect(planMigration({ [MIGRATED_KEY]: 1 }).writes).toEqual({})
})

test('from no marker one plan moves the old keys and gives hosts; odd values pass through', () => {
  const plan = planMigration({ 'github:settings': { extraRepos: ['o/r', 7] }, 'github:docs': 'not a list' })

  expect(plan.writes).toEqual({ 'gitgud:settings': { extraRepos: ['github.com/o/r', 7] }, 'gitgud:docs': 'not a list' })
  expect(plan.deletes).toContain('github:settings')
  expect(plan.marker).toBe(2)
})

test('a crash between the deletes and the marker leaves the marker out, so the next start finishes the move', async ($, on) => {
  const sets: [string, unknown][] = []
  const deletes: string[] = []
  let isDeleteFailing = true
  mock.clock(on, { now: Date.parse('2026-10-19T12:00:00Z') })
  on('store.set', { key: MIGRATED_KEY }, ($, e, next) => {
    sets.push([e.key, e.value])

    return next(e)
  })
  on('store.delete', { key: 'github:oneliners' }, ($, e, next) => {
    if (isDeleteFailing) return { deny: 'crashed' }
    deletes.push(e.key)

    return next(e)
  })
  mock.store(on, { 'github:settings': { isHaikuOn: false }, 'github:oneliners': { a: 'x' } })
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.panes', () => ({ value: [] }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(sets).toEqual([])

  isDeleteFailing = false
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(deletes).toEqual(['github:oneliners'])
  expect(sets).toEqual([[MIGRATED_KEY, MIGRATION_VERSION]])
})
