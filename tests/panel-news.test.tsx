import { expect, mock, test } from 'claude-code/testing'

import { withKnownPanels } from '../hooks/dock/layout'
import { SEEN_STORE_KEY, panelNews, readSeen } from '../hooks/dock/panelNews'
import { PANELS } from '../hooks/panels'
import type { DockPanel } from '../hooks/panels/contract'
import type { DockLayout } from '../types'

function panel(id: string, change: Partial<DockPanel> = {}): DockPanel {
  return { id, title: id.toUpperCase(), icon: '🧪', description: `The ${id} panel`, isBuiltIn: true, ...change }
}

const OLD = panel('old')
const OPT_IN = panel('slack', { isOptIn: true })

test('panelNews: a new panel, an opt-in one and a revision bump are told once; the record keeps every panel', () => {
  const changed = panel('old', { revision: 2, whatsNew: 'Now sorts by date' })
  const news = panelNews({ old: 1 }, [changed, OPT_IN, panel('fresh')], [])

  expect(news.notices.map(notice => [notice.title, notice.topic])).toEqual([
    ['Updated: 🧪 OLD', 'panel-news-old'],
    ['New panel: 🧪 SLACK', 'panel-news-slack'],
    ['New panel: 🧪 FRESH', 'panel-news-fresh'],
  ])
  expect(news.notices[0]?.detail).toBe('Now sorts by date')
  expect(news.notices[1]?.detail).toBe('Add it from ⚙ Manage (/dock manage).\nThe slack panel')
  expect(news.notices[2]?.detail).toBe('Added to your dock.\nThe fresh panel')
  expect(news.record).toEqual({ old: 2, slack: 1, fresh: 1 })
  expect(panelNews(news.record, [changed, OPT_IN, panel('fresh')], []).notices).toEqual([])
})

test('panelNews: with no record, panels the layout knows are taken as heard and only unseen opt-in ones are announced', () => {
  const news = panelNews(undefined, [OLD, OPT_IN, panel('fresh', { revision: 3, whatsNew: 'x' })], ['old'])

  expect(news.notices.map(notice => notice.title)).toEqual(['New panel: 🧪 SLACK'])
  expect(news.record).toEqual({ old: 1, slack: 1, fresh: 3 })
  expect(panelNews(undefined, [OPT_IN], ['slack']).notices).toEqual([])
  expect(readSeen('nope')).toBeUndefined()
  expect(readSeen({ a: 2, b: 'x', c: 0 })).toEqual({ a: 2 })
})

test('an opt-in panel is recorded as known but joins no view; a normal new one still joins the last dock', () => {
  const layout: DockLayout = {
    docks: [{ id: 'main', name: 'Dock', position: 'right', views: [{ id: '1', panels: ['a'], minimized: [], direction: 'column', widths: {} }], activeViewId: '1', isOpen: false, view: 'panels', usedAt: 0 }],
    lastDockId: 'main',
    known: ['a'],
  }
  const after = withKnownPanels(layout, ['a', 'opt', 'plain'], ['a', 'opt', 'plain'], ['opt'])

  expect(after.docks[0]?.views[0]?.panels).toEqual(['a', 'plain'])
  expect(after.known).toEqual(expect.arrayContaining(['a', 'opt', 'plain']))
  expect(withKnownPanels(after, ['a', 'opt', 'plain'], ['a', 'opt', 'plain'], ['opt'])).toEqual(after)
})

test('every built-in panel has a whole revision, and a line saying what changed once it is above 1', () => {
  for (const one of PANELS) {
    const revision = one.revision ?? 1
    expect(Number.isInteger(revision) && revision > 0, `${one.id} revision`).toBe(true)
    if (revision > 1) expect((one.whatsNew ?? '').trim(), `${one.id} whatsNew`).not.toBe('')
  }
})

test('session start posts the notice for a panel missing from the stored record, then saves the record', async ($, on) => {
  const stored: Record<string, unknown> = {}
  const seen = Object.fromEntries(PANELS.filter(one => one.id !== 'jira').map(one => [one.id, one.revision ?? 1]))
  on('store.set', { key: SEEN_STORE_KEY }, ($, e, next) => {
    stored[e.key] = e.value

    return next(e)
  })
  mock.store(on, { [SEEN_STORE_KEY]: seen })
  const clock = mock.clock(on)
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({
    plugin: 'claudedockula',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 5 }, view: {} },
  })

  expect(await band.find({ type: 'Text', text: /New panel: 🎫 Jira/ })).toBeDefined()
  await clock.advance(60_000)
  expect(await band.find({ type: 'Text', text: /New panel: 🎫 Jira/ })).toBeDefined()
  expect(stored[SEEN_STORE_KEY]).toMatchObject({ jira: 3 })
  await band.unmount()
})
