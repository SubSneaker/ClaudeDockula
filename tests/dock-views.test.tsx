import type { On, RenderPropsOf, UiPane } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { DockLayout, DockView, DockViewTab } from '../types'
import {
  activeView,
  addView,
  bottomBody,
  changePanel,
  dockCapRows,
  dockHeight,
  focusPanel,
  isFocusedOn,
  isShownIn,
  maxScrollRow,
  parseDockKey,
  parseMeasureMessage,
  parseResizeMessage,
  parseScrollMessage,
  presetColumns,
  readLayout,
  removeView,
  renameView,
  resizeTarget,
  restoreLayout,
  rowLines,
  scrollBarDragTarget,
  scrollBarGlyphs,
  scrollBarKeyMove,
  scrollBarPress,
  scrollRowOf,
  scrolledBy,
  setCardWidth,
  setDirection,
  shouldPostMeasure,
  tabTarget,
  viewName,
  type ScrollBarProps,
} from '../hooks/dock/layout'
import { noticeRowCount } from '../hooks/dock/notices'
import { cellWidth } from '../hooks/dock/ui'

const IDS = ['branch', 'checks', 'activity', 'jira']
const ALL_SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const REGISTRY = [
  { id: 'branch', icon: '🌿', title: 'Branch' },
  { id: 'jira', icon: '🎫', title: 'Jira · assigned to me' },
]

function paneProps(bodyColumns: number): RenderPropsOf['Pane'] {
  return { title: 'Dock', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }
}

function bandProps(bodyColumns: number, maxRows = 20): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows, bodyColumns, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} }
}

function viewOf(id: string, panels: string[], change: Partial<DockViewTab> = {}): DockViewTab {
  return { id, panels, minimized: [], direction: 'column', widths: {}, ...change }
}

function dockOf(id: string, views: DockViewTab[], change: Partial<DockView> = {}): DockView {
  return { id, name: `Dock ${id}`, position: 'right', views, activeViewId: views[0]?.id ?? '1', isOpen: false, view: 'panels', usedAt: 0, ...change }
}

function layoutOf(docks: DockView[]): DockLayout {
  return { docks, lastDockId: docks[0]?.id ?? 'main', known: IDS }
}

function childrenOf(node: unknown): unknown[] {
  const children = typeof node === 'object' && node !== null && 'children' in node ? node.children : []

  return Array.isArray(children) ? children : []
}

function propOf(node: unknown, name: string): unknown {
  const props = typeof node === 'object' && node !== null && 'props' in node ? node.props : undefined

  return typeof props === 'object' && props !== null && name in props ? Reflect.get(props, name) : undefined
}

/** Every node of a drawn tree, outermost first. */
function nodesOf(tree: unknown): unknown[] {
  return [tree, ...childrenOf(tree).flatMap(nodesOf)]
}

/**
 * The dock's cards as drawn, line by line, with the width each takes.
 * @example
 * // before: a drawn band holding `dock-2-card-branch` and `dock-2-card-checks` side by side
 * // after:  [[['branch', 50], ['checks', 49]]]
 */
function cardWidthsOf(tree: unknown, dockId: string): Array<Array<[string, number]>> {
  const prefix = `dock-${dockId}-card-`
  const slotOf = (node: unknown): [string, number] | undefined => {
    const width = propOf(node, 'width')
    const key = propOf(childrenOf(node)[0], 'key')

    return typeof width === 'number' && typeof key === 'string' && key.startsWith(prefix) ? [key.slice(prefix.length), width] : undefined
  }

  return nodesOf(tree).flatMap(node => {
    const slots = childrenOf(node).map(slotOf)
    const line = slots.filter((slot): slot is [string, number] => slot !== undefined)

    return propOf(node, 'flexDirection') === 'row' && line.length > 0 && line.length === slots.length ? [line] : []
  })
}

/** The clipped box of the bottom dock's cards: its height and how far its cards are scrolled. */
function clipOf(tree: unknown): { height: unknown; scroll: unknown } | undefined {
  const box = nodesOf(tree).find(node => propOf(node, 'overflow') === 'hidden')

  return box === undefined ? undefined : { height: propOf(box, 'height'), scroll: propOf(childrenOf(box)[0], 'marginTop') }
}

function mockPanes(on: On): void {
  const panes = new Set<string>()
  on('ui.open', ($, e) => {
    panes.add(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes].map((id): UiPane => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.scroll', () => ({}))
}

describe('the view model', () => {
  test('a dock of panels becomes one view, nothing lost; malformed views and heights are dropped, never thrown', () => {
    const stored = {
      docks: [
        { id: 'main', name: 'Work', panels: ['jira', 'branch'], minimized: ['jira'], isOpen: true },
        { id: '2', position: 'bottom', panels: ['checks'], isOpen: true },
      ],
      lastDockId: 'main',
      known: IDS,
    }
    const [main, bottom] = readLayout(stored).docks

    expect(main).toMatchObject({ name: 'Work', activeViewId: '1', views: [viewOf('1', ['jira', 'branch'], { minimized: ['jira'] })] })
    expect(main?.views[0]?.name).toBeUndefined()
    expect(bottom?.views).toEqual([viewOf('1', ['checks'], { direction: 'row' })])

    const junk = {
      docks: [
        { id: 'main', views: 'x', activeViewId: 7, rows: -3, scrollRow: 'a' },
        { id: '2', views: [{ id: 'bad' }, { id: '3', panels: [1], direction: 'diagonal', widths: { jira: 'huge', branch: 'half' } }, null] },
      ],
    }
    expect(() => restoreLayout(junk, IDS)).not.toThrow()
    const [first, second] = readLayout(junk).docks
    expect(first).toMatchObject({ views: [viewOf('1', [])], activeViewId: '1' })
    expect(first?.rows).toBeUndefined()
    expect(second).toMatchObject({ activeViewId: '3', views: [viewOf('3', [], { widths: { branch: 'half' } })] })
    for (const saved of [null, 42, 'x', { docks: [42, { id: 'main', views: [{ id: '1', panels: 'no' }] }] }]) {
      expect(() => restoreLayout(saved, IDS)).not.toThrow()
    }
  })

  test('views: added empty in Manage, named after their one panel or their place, renamed, removed but never the last', () => {
    const dock = dockOf('main', [viewOf('1', ['jira'])])
    const added = addView(dock)

    expect(viewName(activeView(dock), 0, REGISTRY)).toBe('🎫 Jira')
    expect(added).toMatchObject({ activeViewId: '2', view: 'manage', views: [{ id: '1' }, viewOf('2', [])] })
    expect(viewName(activeView(added), 1, REGISTRY)).toBe('View 2')
    expect(viewName(viewOf('3', ['jira', 'branch']), 2, REGISTRY)).toBe('View 3')

    const named = renameView(added, '2', '  Tickets ', 'View 2')
    expect(viewName({ ...activeView(named), panels: ['jira'] }, 1, REGISTRY)).toBe('Tickets')
    expect(renameView(named, '2', 'Tickets', 'Tickets')).toBe(named)
    expect(activeView(renameView(named, '2', ' ', 'Tickets')).name).toBeUndefined()

    // A removed view's panels no other view shows join the view left active, minimized as they were.
    const layout = layoutOf([dockOf('main', [viewOf('1', ['branch']), viewOf('2', ['jira', 'branch'], { minimized: ['jira'] })], { activeViewId: '2' })])
    const removed = removeView(layout, 'main', '2')
    expect(removed.docks[0]).toMatchObject({ activeViewId: '1', views: [viewOf('1', ['branch', 'jira'], { minimized: ['jira'] })] })
    expect(removeView(removed, 'main', '1')).toBe(removed)
  })

  test('a band tab switches the dock to the view holding its panel, else adds it to the active view', () => {
    const layout = layoutOf([dockOf('main', [viewOf('1', ['branch']), viewOf('2', ['jira'])], { isOpen: true })])
    const jira = focusPanel(layout, tabTarget(layout, 'jira').id, 'jira')
    const [dock] = jira.docks

    expect(dock).toMatchObject({ activeViewId: '2', focused: 'jira', views: [viewOf('1', ['branch']), viewOf('2', ['jira'])] })
    expect(dock && isFocusedOn(dock, 'jira')).toBe(true)
    expect([isShownIn(jira, 'jira'), isShownIn(jira, 'branch')]).toEqual([true, false])
    expect(focusPanel(jira, 'main', 'checks').docks[0]?.views[1]?.panels).toEqual(['jira', 'checks'])
  })

  test('row widths: auto shares the row down to 36 columns; fractions and the gap never overflow', () => {
    expect(rowLines(['a', 'b', 'c'], {}, 120)).toEqual([[{ id: 'a', width: 40 }, { id: 'b', width: 39 }, { id: 'c', width: 39 }]])
    expect(rowLines(['a', 'b'], {}, 70)).toEqual([[{ id: 'a', width: 70 }], [{ id: 'b', width: 70 }]])
    expect(rowLines(['a', 'b', 'c'], { a: 'third', b: 'third', c: 'third' }, 80).map(line => line.map(slot => slot.width))).toEqual([[26, 26, 26]])
    expect(rowLines(['a', 'b'], { a: 'full' }, 60)).toEqual([[{ id: 'a', width: 60 }], [{ id: 'b', width: 60 }]])
    expect(rowLines(['a', 'b'], { a: 'half' }, 100)).toEqual([[{ id: 'a', width: 49 }, { id: 'b', width: 50 }]])
    expect(rowLines(['a'], {}, 20)).toEqual([[{ id: 'a', width: 20 }]])
    expect([presetColumns('third', 2), presetColumns('half', 1), presetColumns('full', 0)]).toEqual([1, 1, 1])

    for (const columns of [37, 56, 81, 100, 133]) {
      const lines = rowLines(['a', 'b', 'c', 'd'], { b: 'half', c: 'third', d: 'third' }, columns)
      for (const line of lines) expect(line.reduce((sum, slot) => sum + slot.width, line.length - 1)).toBeLessThanOrEqual(columns)
    }
  })

  test('height: the rows the person dragged, held between the minimum and what the band leaves under the notices', () => {
    const notices = [{ id: 1, tone: 'error', title: 'A' } as const, { id: 2, tone: 'info', title: 'B', detail: 'x'.repeat(100), isExpanded: true } as const]
    const below = noticeRowCount(notices, 52) + 1

    expect(below).toBe(5)
    expect(dockCapRows(20, below)).toBe(15)
    expect(dockCapRows(5, 3)).toBe(4)
    // A dock never sized has the default 12 rows, held to the cap.
    expect([dockHeight(undefined, 15), dockHeight(undefined, 8), dockHeight(30, 15), dockHeight(2, 15), dockHeight(9, 15)]).toEqual([12, 8, 15, 5, 9])
    expect([resizeTarget(10, -3, 5, 15), resizeTarget(10, 8, 5, 15), resizeTarget(10, -20, 5, 15)]).toEqual([13, 5, 15])
    expect([parseResizeMessage({ type: 'resize', rows: 30, max: 15 }), parseResizeMessage({ type: 'resize', rows: 9 })]).toEqual([15, 9])
  })

  test('the cards scroll by rows between the top and their measured end; nothing is written at either edge', () => {
    const atEnd = { '2': 5 }
    const atTop = {}

    expect(scrolledBy(atTop, '2', 3, 5)).toEqual({ '2': 3 })
    expect(scrolledBy(atEnd, '2', 1, 5)).toBe(atEnd)
    expect(scrolledBy(atTop, '2', -1, 5)).toBe(atTop)
    expect(scrolledBy({ '2': 1 }, '2', -4, 5)).toEqual({})
    // Cards measured shorter than the scroll held clamp it before a move.
    expect(scrolledBy({ '2': 40 }, '2', -1, 10)).toEqual({ '2': 9 })
    expect([scrollRowOf({ '2': 'x' }, '2', 5), scrollRowOf({ '2': 9 }, '2', 5), scrollRowOf({}, '2', 5)]).toEqual([0, 5, 0])
    // Unmeasured, nothing scrolls; measured, where the last card row reaches the bottom.
    expect([maxScrollRow(undefined, 9), maxScrollRow(30, 9), maxScrollRow(5, 9)]).toEqual([0, 21, 0])
  })

  test('the probe posts the height it was laid out at only when the dock holds another', () => {
    expect([shouldPostMeasure({ dockId: '2' }, 0), shouldPostMeasure({ dockId: '2' }, 30), shouldPostMeasure({ dockId: '2', measured: 30 }, 30)]).toEqual([
      false,
      true,
      false,
    ])
    expect(parseMeasureMessage({ type: 'measure', dockId: '2', rows: 30 })).toEqual({ dockId: '2', rows: 30 })
    for (const junk of [{ type: 'resize', dockId: '2', rows: 30 }, { type: 'measure', dockId: 'x', rows: 30 }, { type: 'measure', dockId: '2', rows: -1 }, null]) {
      expect(parseMeasureMessage(junk)).toBeUndefined()
    }
  })

  test('the scrollbar: its thumb, what a press, a drag and a key ask for, and the message it posts', () => {
    const bar = (change: Partial<ScrollBarProps> = {}): ScrollBarProps => ({ dockId: '2', rows: 8, measured: 24, scrollRow: 9, max: 16, ...change })

    expect(scrollBarGlyphs(bar())).toEqual(['▲', '│', '│', '┃', '┃', '│', '│', '▼'])
    expect(scrollBarGlyphs(bar({ scrollRow: 0 })).slice(1, 3)).toEqual(['┃', '┃'])
    expect(scrollBarGlyphs(bar({ scrollRow: 16 })).slice(5, 7)).toEqual(['┃', '┃'])
    expect(scrollBarGlyphs(bar({ rows: 2, max: 22 }))).toEqual(['▲', '▼'])
    // Fitting cards, or none measured yet, leave the bar blank.
    expect(scrollBarGlyphs(bar({ measured: 8, max: 0 }))).toEqual(Array.from({ length: 8 }, () => ' '))
    expect(scrollBarGlyphs(bar({ measured: undefined }))).toEqual(Array.from({ length: 8 }, () => ' '))

    // Arrows by a row, the track by a page either side of the thumb (rows 3-4), the thumb is grabbed.
    expect([0, 7, 1, 6, 3].map(y => scrollBarPress(bar(), y))).toEqual([{ by: -1 }, { by: 1 }, { by: -7 }, { by: 7 }, { isThumb: true }])
    expect(scrollBarPress(bar({ measured: 8, max: 0 }), 0)).toBeUndefined()
    // A drag maps rows moved to cards' rows (4 free track rows for 16 rows), held between the ends.
    expect([scrollBarDragTarget(bar(), 0, 2), scrollBarDragTarget(bar(), 0, 9), scrollBarDragTarget(bar(), 4, -9)]).toEqual([8, 16, 0])
    expect(scrollBarDragTarget(bar({ rows: 2, max: 22 }), 5, 3)).toBe(5)
    expect(['up', 'down', 'pageup', 'pagedown', 'home', 'end', 'x'].map(key => scrollBarKeyMove(bar(), key))).toEqual([
      { by: -1 },
      { by: 1 },
      { by: -7 },
      { by: 7 },
      { to: 0 },
      { to: 16 },
      undefined,
    ])
    expect(scrollBarKeyMove(bar({ measured: undefined }), 'end')).toBeUndefined()
    expect(parseScrollMessage({ type: 'scroll', by: -7, max: 16 })).toEqual({ by: -7, max: 16 })
    expect(parseScrollMessage({ type: 'scroll', to: 0, max: 16 })).toEqual({ to: 0, max: 16 })
    for (const junk of [{ type: 'measure', by: 1, max: 4 }, { type: 'scroll', by: 1 }, { type: 'scroll', max: 4 }, { type: 'scroll', to: -1, max: 4 }, null]) {
      expect(parseScrollMessage(junk)).toBeUndefined()
    }
  })

  test('the cards need two rows: open menus that leave fewer hide them, and the dock is drawn without them', () => {
    expect([bottomBody(12, 0), bottomBody(12, 7), bottomBody(12, 8), bottomBody(9, 7)]).toEqual([
      { rows: 9, drawnRows: 12 },
      { rows: 2, drawnRows: 12 },
      { rows: 0, drawnRows: 11 },
      { rows: 0, drawnRows: 10 },
    ])
  })

  test('a new view never takes the id of a removed one, so a press drawn for that view finds nothing', () => {
    const added = addView(dockOf('main', [viewOf('1', ['jira'])]))
    const [left] = removeView(layoutOf([added]), 'main', '2').docks

    expect(left && addView(left).views.map(view => view.id)).toEqual(['1', '3'])
    expect(readLayout({ docks: [{ id: 'main', views: [{ id: '4' }], nextViewId: 2 }] }).docks[0]?.nextViewId).toBe(5)
    expect(readLayout({ docks: [{ id: 'main', views: [{ id: '1' }], nextViewId: 'x' }] }).docks[0]?.nextViewId).toBeUndefined()
  })

  test('view-scoped keys name their dock and view, hyphenated panel ids included; a key without its view names nothing', () => {
    expect(parseDockKey('dock-main-view-2')).toEqual({ dockId: 'main', action: 'view', viewId: '2' })
    expect(parseDockKey('dock-2-width-half-3-my-panel')).toEqual({ dockId: '2', action: 'width-half', viewId: '3', panelId: 'my-panel' })
    expect(parseDockKey('dock-2-up-1-2-fast')).toEqual({ dockId: '2', action: 'up', viewId: '1', panelId: '2-fast' })
    expect(parseDockKey('dock-main-toggle-2-fast')).toEqual({ dockId: 'main', action: 'toggle', panelId: '2-fast' })
    expect(parseDockKey('dock-main-remove-view-2')).toEqual({ dockId: 'main', action: 'remove-view', viewId: '2' })
    expect(parseDockKey('dock-main-dir-row-2')).toEqual({ dockId: 'main', action: 'dir-row', viewId: '2' })
    for (const bare of ['dock-main-remove-view', 'dock-main-dir-row', 'dock-main-width-half-jira', 'dock-main-enable-jira', 'dock-main-view-name-2', 'dock-3-scroll-down']) {
      expect(parseDockKey(bare)).toBe(undefined)
    }
    expect(parseDockKey('dock-main-width-wide-1-jira')).toBe(undefined)
  })
})

test('the view tabs: ➕ View opens an empty view in Manage, a tab switches views, a band tab finds its view', async ($, on) => {
  mock.store(on)
  mockPanes(on)
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(80) })
  await band.press({ key: 'dock-tab-branch' })
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  expect((await pane.find({ key: 'dock-main-view-1' }))?.props.label).toBe('View 1')

  await pane.press({ key: 'dock-main-add-view' })
  expect((await pane.find({ key: 'dock-main-view-2' }))?.props.label).toBe('View 2')
  expect(await pane.find({ type: 'Text', text: '⚙ Manage · View 2' })).toBeDefined()
  await pane.press({ key: 'dock-main-enable-2-jira' })
  expect((await pane.find({ key: 'dock-main-view-2' }))?.props.label).toBe('🎫 Jira')
  await pane.press({ key: 'dock-main-manage' })
  expect(await pane.find({ key: 'dock-main-card-jira' })).toBeDefined()
  expect(await pane.find({ key: 'dock-main-card-branch' })).toBeUndefined()

  await pane.press({ key: 'dock-main-view-1' })
  expect(await pane.find({ key: 'dock-main-card-branch' })).toBeDefined()
  await pane.press({ key: 'dock-main-manage' })
  await pane.press({ key: 'dock-main-enable-1-jira' })
  await pane.press({ key: 'dock-main-manage' })
  await band.press({ key: 'dock-tab-jira' })
  expect(await pane.find({ key: 'dock-main-card-jira' })).toBeDefined()
  expect(await pane.find({ key: 'dock-main-card-branch' })).toBeUndefined()

  // Row (wraps) for the Jira view, then every surface draws the tabs, the Layout menu and the cards.
  await pane.press({ key: 'dock-main-layout' })
  await pane.press({ key: 'dock-main-dir-row-2' })
  expect(await pane.find({ key: 'dock-main-width-half-2-jira' })).toBeDefined()
  await band.unmount()
  await pane.unmount()
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
    await expect(ui.drawn()).resolves.toBeDefined()
    expect(await ui.find({ key: 'dock-main-add-view' })).toBeDefined()
    expect(await ui.find({ key: 'dock-main-dir-column-2' })).toBeDefined()
    expect(cardWidthsOf(await ui.drawn(), 'main')).toEqual([[['jira', 56]]])
    await ui.unmount()
  }
})

test('view-scoped presses name their view: Remove view takes the view in its key; a view that is gone changes nothing', async ($, on) => {
  mock.store(on)
  mockPanes(on)
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await pane.press({ key: 'dock-main-add-view' })
  expect(await pane.find({ key: 'dock-main-remove-view-2' })).toBeDefined()
  expect(await pane.find({ key: 'dock-main-view-name-2' })).toBeDefined()
  await pane.press({ key: 'dock-main-remove-view-2' })
  expect(await pane.find({ key: 'dock-main-view-2' })).toBeUndefined()
  expect(await pane.find({ key: 'dock-main-view-1' })).toBeDefined()
  await pane.unmount()

  const dock = dockOf('main', [viewOf('1', ['jira']), viewOf('2', ['branch'])])
  const layout = layoutOf([dock])
  expect(removeView(layout, 'main', '9')).toBe(layout)
  expect(setDirection(dock, '9', 'row')).toBe(dock)
  expect(setCardWidth(dock, '9', 'jira', 'half')).toBe(dock)
  expect(changePanel(dock, 'enable', 'jira', '9')).toBe(dock)
  expect(setDirection(dock, '2', 'row').views.map(view => view.direction)).toEqual(['column', 'row'])
  expect(changePanel(dock, 'up', 'branch', '2').views[1]?.panels).toEqual(['branch'])
})

test('with many views the tab row never passes its width: the active tab stays and …+n steps to a hidden view', async ($, on) => {
  mock.store(on)
  mockPanes(on)
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(40) })
  for (let count = 0; count < 5; count += 1) await pane.press({ key: 'dock-main-add-view' })
  const ids = ['1', '2', '3', '4', '5', '6']
  const rowLabels = async (): Promise<Array<[string, string]>> => {
    const found = await Promise.all(ids.map(async (id): Promise<[string, unknown]> => [id, (await pane.find({ key: `dock-main-view-${id}` }))?.props.label]))
    const add = (await pane.find({ key: 'dock-main-add-view' }))?.props.label

    const addEntry: [string, unknown] = ['add', add]

    return [...found, addEntry].flatMap(([id, label]): Array<[string, string]> => (typeof label === 'string' ? [[id, label]] : []))
  }
  const cellsOf = (row: Array<[string, string]>): number => row.reduce((sum, [, label]) => sum + cellWidth(label), 0) + 2 * (row.length - 1)

  const row = await rowLabels()
  expect(cellsOf(row)).toBeLessThanOrEqual(40)
  expect(row.some(([id]) => id === '6')).toBe(true)
  const more = row.find(([, label]) => label.startsWith('…+'))
  expect(more).toBeDefined()

  await pane.press({ key: `dock-main-view-${more?.[0]}` })
  const after = await rowLabels()
  expect(cellsOf(after)).toBeLessThanOrEqual(40)
  expect(after.find(([id]) => id === more?.[0])?.[1]).toMatch(/^View/)
  await pane.unmount()
})

test('the Layout card words its choices compactly in a narrow pane, so no row passes the body', async ($, on) => {
  mock.store(on)
  mockPanes(on)
  for (const columns of [56, 30]) {
    const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(columns) })
    if (columns === 56) {
      await pane.press({ key: 'dock-main-layout' })
      await pane.press({ key: 'dock-main-dir-row-1' })
    }
    const labels = [
      (await pane.find({ key: 'dock-main-width-auto-1-jira' }))?.props.label,
      (await pane.find({ key: 'dock-main-width-full-1-jira' }))?.props.label,
      (await pane.find({ key: 'dock-main-dir-row-1' }))?.props.label,
    ]
    expect(labels).toEqual(columns === 56 ? ['[Auto]', '[Full]', '[Row (wraps)]'] : ['A', 'F', 'Row'])
    expect((await pane.find({ type: 'Text', text: 'Direction' }))?.props.wrap).toBe('truncate-end')
    await pane.unmount()
  }
})

test('Row (wraps) in the bottom dock: cards side by side, a width sends one to its own row, Column stacks them', async ($, on) => {
  mock.store(on)
  mockPanes(on)
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await pane.press({ key: 'dock-main-menu' })
  await pane.press({ key: 'dock-main-new-bottom' })
  await pane.unmount()
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(100) })
  for (const id of ['branch', 'checks', 'activity']) await band.press({ key: `dock-2-enable-1-${id}` })
  await band.press({ key: 'dock-2-manage' })

  // The cards share the band less the probe's blank column and the scrollbar's.
  expect(cardWidthsOf(await band.drawn(), '2')).toEqual([[['branch', 49], ['checks', 48]], [['activity', 98]]])
  // Taller, the dock keeps rows for its cards under the Layout card's nine.
  await band.pointer({ in: 'dock-2-grip', type: 'down', x: 40, y: 0, button: 'left' })
  await band.pointer({ in: 'dock-2-grip', type: 'up', x: 40, y: -7, button: 'left' })
  await band.press({ key: 'dock-2-layout' })
  await band.press({ key: 'dock-2-width-full-1-checks' })
  expect(cardWidthsOf(await band.drawn(), '2')).toEqual([[['branch', 98]], [['checks', 98]], [['activity', 98]]])
  await band.press({ key: 'dock-2-width-third-1-branch' })
  await band.press({ key: 'dock-2-width-auto-1-checks' })
  expect(cardWidthsOf(await band.drawn(), '2')).toEqual([[['branch', 32], ['checks', 65]], [['activity', 98]]])
  await band.press({ key: 'dock-2-dir-column-1' })
  expect(await band.find({ key: 'dock-2-width-full-1-checks' })).toBeUndefined()
  expect(cardWidthsOf(await band.drawn(), '2')).toEqual([[['branch', 98]], [['checks', 98]], [['activity', 98]]])
  await band.unmount()
})

test('the grip: a bottom dock always has a height, a drag is exact from it, the cards clip to it and an open menu comes out of it', async ($, on) => {
  mock.store(on)
  mockPanes(on)
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await pane.press({ key: 'dock-main-menu' })
  await pane.press({ key: 'dock-main-new-bottom' })
  await pane.unmount()
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(100) })
  await band.press({ key: 'dock-2-enable-1-checks' })
  await band.press({ key: 'dock-2-manage' })
  const grip = { in: 'dock-2-grip' }
  const label = async () => (await band.find({ ...grip, type: 'Text' }))?.text
  expect(await label()).toMatch(/^╶─+ ⠿ drag to resize ─+╴$/)

  // Never sized, it draws 12 rows (9 for the cards) and a drag up makes it taller from there.
  expect(clipOf(await band.drawn())).toEqual({ height: 9, scroll: 0 })
  await band.pointer({ ...grip, type: 'down', x: 40, y: 0, button: 'left' })
  await band.pointer({ ...grip, type: 'move', x: 40, y: -3, button: 'left' })
  expect(await label()).toContain(' ↕ 15 rows ')
  await band.pointer({ ...grip, type: 'up', x: 40, y: -3, button: 'left' })
  expect(clipOf(await band.drawn())).toEqual({ height: 12, scroll: 0 })

  await band.pointer({ ...grip, type: 'down', x: 40, y: 0, button: 'left' })
  await band.pointer({ ...grip, type: 'move', x: 40, y: 6, button: 'left' })
  expect(await label()).toContain(' ↕ 9 rows ')
  await band.pointer({ ...grip, type: 'up', x: 40, y: 6, button: 'left' })
  expect(clipOf(await band.drawn())).toEqual({ height: 6, scroll: 0 })

  // Up past the cap (20 rows less the tab row) stops at it; a click without a drag changes nothing.
  await band.pointer({ ...grip, type: 'down', x: 40, y: 0, button: 'left' })
  await band.pointer({ ...grip, type: 'move', x: 40, y: -30, button: 'left' })
  expect(await label()).toContain(' ↕ 19 rows · max ')
  await band.pointer({ ...grip, type: 'up', x: 40, y: -30, button: 'left' })
  await band.pointer({ ...grip, type: 'down', x: 3, y: 0, button: 'left' })
  await band.pointer({ ...grip, type: 'up', x: 3, y: 0, button: 'left' })
  expect(clipOf(await band.drawn())).toEqual({ height: 16, scroll: 0 })

  // The ➕ menu (3 rows) and the Layout card (6 rows and one for its note) come out of the cards' rows.
  await band.press({ key: 'dock-2-menu' })
  expect(clipOf(await band.drawn())?.height).toBe(13)
  await band.press({ key: 'dock-2-menu' })
  await band.press({ key: 'dock-2-layout' })
  expect(clipOf(await band.drawn())?.height).toBe(9)
  await band.press({ key: 'dock-2-layout' })

  // A smaller band holds the dock to what it leaves, however tall it was stored.
  await band.redraw(bandProps(100, 10))
  expect(clipOf(await band.drawn())?.height).toBe(6)
  expect(await band.find({ key: 'dock-2-scroll-down' })).toBeUndefined()
  // Under the Layout card so small a dock has no room left for its cards: none are drawn.
  await band.press({ key: 'dock-2-layout' })
  expect(clipOf(await band.drawn())).toBeUndefined()
  await band.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'AbovePrompt', props: bandProps(60) })
    await expect(ui.drawn()).resolves.toBeDefined()
    await expect(ui.drawn(grip)).resolves.toBeDefined()
    await ui.unmount()
  }
})

test('the probe measures the cards and the scrollbar beside them moves them, to their end at most', async ($, on) => {
  mock.store(on)
  mockPanes(on)
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await pane.press({ key: 'dock-main-menu' })
  await pane.press({ key: 'dock-main-new-bottom' })
  await pane.unmount()
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(100) })
  await band.press({ key: 'dock-2-enable-1-checks' })
  await band.press({ key: 'dock-2-manage' })
  const probe = { in: 'dock-2-measure' }
  const bar = { in: 'dock-2-scrollbar' }
  const scrolled = async () => clipOf(await band.drawn())?.scroll
  expect((await band.find({ ...probe, type: 'Text' }))?.text).toBe(' ')

  // Laid out 30 rows tall, the probe posts: the cards stop where their last row meets the bottom (30 - 9).
  await band.resize({ ...probe, columns: 1, rows: 30 })
  await band.pointer({ ...bar, type: 'down', x: 0, y: 8, button: 'left' })
  await band.pointer({ ...bar, type: 'up', x: 0, y: 8, button: 'left' })
  expect(await scrolled()).toBe(-1)
  await band.pointer({ ...bar, type: 'down', x: 0, y: 5, button: 'left' })
  await band.pointer({ ...bar, type: 'up', x: 0, y: 5, button: 'left' })
  expect(await scrolled()).toBe(-9)
  await band.pointer({ ...bar, type: 'down', x: 0, y: 5, button: 'left' })
  await band.pointer({ ...bar, type: 'up', x: 0, y: 5, button: 'left' })
  await band.pointer({ ...bar, type: 'down', x: 0, y: 7, button: 'left' })
  await band.pointer({ ...bar, type: 'up', x: 0, y: 7, button: 'left' })
  expect(await scrolled()).toBe(-21)

  // Dragging the thumb (rows 5-6, track 7 less its 2: 21 rows over 5) two rows down from the top, then Home and End by key.
  await band.key({ ...bar, key: 'home' })
  expect(await scrolled()).toBe(0)
  await band.pointer({ ...bar, type: 'down', x: 0, y: 1, button: 'left' })
  await band.pointer({ ...bar, type: 'move', x: 0, y: 3, button: 'left' })
  await band.pointer({ ...bar, type: 'up', x: 0, y: 3, button: 'left' })
  expect(await scrolled()).toBe(-8)
  await band.key({ ...bar, key: 'end' })
  expect(await scrolled()).toBe(-21)

  // A band tab brings the cards back to the top.
  await band.press({ key: 'dock-tab-checks' })
  expect(await scrolled()).toBe(0)
  await band.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'AbovePrompt', props: bandProps(60) })
    await expect(ui.drawn(probe)).resolves.toBeDefined()
    await expect(ui.drawn(bar)).resolves.toBeDefined()
    await ui.unmount()
  }
})
