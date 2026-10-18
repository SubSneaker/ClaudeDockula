import type { PaneOpenArgs, RenderSurface, ThemeKey, UiPane } from 'claude-code'

import type { CardWidth, DockDirection, DockLayout, DockPosition, DockView, DockViewTab } from '../../types'
import type { DockPanel } from '../panels/contract'
import { cellWidth } from './ui'

// The docks are views of one shared set of panels: this file is their pure model. Every change is a
// function from layout to layout; hooks/dock/DockPane.tsx writes the result and opens or closes panes.

export const DOCK_PANE = 'claudedockula'
export const NEW_PANEL_PANE = 'claudedockula-new'
export const MAIN_DOCK_ID = 'main'
/** Auto cards share a row down to this width, then wrap rather than get crushed. */
export const AUTO_CARD_COLUMNS = 36
/** Columns between two cards side by side. */
export const CARD_GAP = 1
/** The bottom dock's rows above its cards: the resize grip, the settings row and the view tabs. */
export const BOTTOM_CHROME_ROWS = 3
/** The shortest bottom dock: its three rows of controls and two of cards. */
export const MIN_DOCK_ROWS = 5
/** The bottom dock's height until the person drags it, held to what the band leaves. */
export const DEFAULT_DOCK_ROWS = 12
/** The fewest rows the bottom dock's cards are drawn in; open menus that leave fewer hide them. */
export const MIN_BODY_ROWS = 2
/** The blank column beside the bottom dock's cards holding the probe that measures their height. */
export const MEASURE_COLUMNS = 1
/** The column of the scrollbar to the right of the bottom dock's cards. */
export const SCROLLBAR_COLUMNS = 1
/** A request: a width the person dragged the docks to wins, so nothing depends on it. */
const DOCK_COLUMNS = 56
const MAX_NAME_LENGTH = 40
const CARD_WIDTHS: readonly CardWidth[] = ['auto', 'third', 'half', 'full']

export const NEW_PANEL_OPEN: PaneOpenArgs = {
  id: NEW_PANEL_PANE,
  title: '✨ New panel',
  columns: 60,
  focus: true,
  closeOnEscape: true,
}

/** A dock's first view lays its cards out as the dock's side suits: stacked on the right, side by side at the bottom. */
function newView(id: string, position: DockPosition, panels: string[] = [], minimized: string[] = []): DockViewTab {
  return { id, panels, minimized, direction: position === 'bottom' ? 'row' : 'column', widths: {} }
}

const MAIN_DOCK: DockView = {
  id: MAIN_DOCK_ID,
  name: 'Dock',
  position: 'right',
  views: [newView('1', 'right')],
  activeViewId: '1',
  isOpen: false,
  view: 'panels',
  usedAt: 0,
}

export const DEFAULT_LAYOUT: DockLayout = { docks: [MAIN_DOCK], lastDockId: MAIN_DOCK_ID, known: [] }

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function fieldOf(saved: unknown, field: string): unknown {
  return typeof saved === 'object' && saved !== null && field in saved ? Reflect.get(saved, field) : undefined
}

function readList(saved: unknown, field: string): string[] {
  const value = fieldOf(saved, field)

  return isStringList(value) ? value : []
}

/** `main`, or a number from 2: what pane ids and Button keys are built from. */
function isDockId(value: unknown): value is string {
  return typeof value === 'string' && /^(main|\d+)$/.test(value)
}

function isViewId(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value)
}

function isCardWidth(value: unknown): value is CardWidth {
  return CARD_WIDTHS.some(width => width === value)
}

/** A whole number of rows from a stored value, or none when it is not a finite number of at least `min`. */
function readCount(value: unknown, min: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.round(value) : undefined
}

/** The pane a right dock draws in: `claudedockula` for the main dock, `claudedockula-<id>` for the others. */
export function paneIdOf(dockId: string): string {
  return dockId === MAIN_DOCK_ID ? DOCK_PANE : `${DOCK_PANE}-${dockId}`
}

/** The dock a pane draws: `claudedockula` → `main`, `claudedockula-2` → `2`; none for the New panel pane. */
export function dockIdOfPane(paneId: string): string | undefined {
  if (paneId === DOCK_PANE) return MAIN_DOCK_ID
  const [, id] = /^claudedockula-(\d+)$/.exec(paneId) ?? []

  return id
}

/** How a right dock's pane opens: its name is the tab's title when several panes are open. */
export function dockOpenArgs(dock: DockView): PaneOpenArgs {
  return { id: paneIdOf(dock.id), title: `🧭 ${dock.name}`, columns: DOCK_COLUMNS }
}

/** The stored widths that name a width there is; anything else is dropped. */
function readWidths(saved: unknown): Record<string, CardWidth> {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return {}

  return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, CardWidth] => isCardWidth(entry[1])))
}

function readView(saved: unknown, position: DockPosition): DockViewTab | undefined {
  const id = fieldOf(saved, 'id')
  if (!isViewId(id)) return undefined
  const name = fieldOf(saved, 'name')
  const direction = fieldOf(saved, 'direction')
  const view = newView(id, position, readList(saved, 'panels'), readList(saved, 'minimized'))

  return {
    ...view,
    ...(typeof name === 'string' && name.trim() !== '' ? { name: name.trim().slice(0, MAX_NAME_LENGTH) } : {}),
    direction: direction === 'row' || direction === 'column' ? direction : view.direction,
    widths: readWidths(fieldOf(saved, 'widths')),
  }
}

/**
 * A dock's views as stored, each id once; a dock of the versions before views keeps its panels as its one view.
 * @example
 * // before: { position: 'bottom', panels: ['jira', 'branch'], minimized: ['jira'] }
 * // after:  [{ id: '1', panels: ['jira', 'branch'], minimized: ['jira'], direction: 'row', widths: {} }]
 */
export function readViews(saved: unknown, position: DockPosition): DockViewTab[] {
  const stored = fieldOf(saved, 'views')
  const read = Array.isArray(stored) ? stored.flatMap(one => readView(one, position) ?? []) : []
  const unique = read.filter((view, index) => read.findIndex(one => one.id === view.id) === index)

  return unique.length > 0 ? unique : [newView('1', position, readList(saved, 'panels'), readList(saved, 'minimized'))]
}

function readDock(saved: unknown): DockView | undefined {
  const id = fieldOf(saved, 'id')
  if (!isDockId(id)) return undefined
  const name = fieldOf(saved, 'name')
  const usedAt = fieldOf(saved, 'usedAt')
  const focused = fieldOf(saved, 'focused')
  const position: DockPosition = fieldOf(saved, 'position') === 'bottom' ? 'bottom' : 'right'
  const views = readViews(saved, position)
  const activeViewId = fieldOf(saved, 'activeViewId')
  const rows = readCount(fieldOf(saved, 'rows'), 1)
  const nextViewId = readCount(fieldOf(saved, 'nextViewId'), 1)

  return {
    id,
    name: typeof name === 'string' && name.trim() !== '' ? name : defaultName(id),
    position,
    views,
    activeViewId: typeof activeViewId === 'string' && views.some(view => view.id === activeViewId) ? activeViewId : (views[0]?.id ?? '1'),
    isOpen: fieldOf(saved, 'isOpen') === true,
    view: fieldOf(saved, 'view') === 'manage' ? 'manage' : 'panels',
    usedAt: typeof usedAt === 'number' && Number.isFinite(usedAt) ? usedAt : 0,
    ...(typeof focused === 'string' ? { focused } : {}),
    ...(fieldOf(saved, 'isMenuOpen') === true ? { isMenuOpen: true } : {}),
    ...(fieldOf(saved, 'isLayoutOpen') === true ? { isLayoutOpen: true } : {}),
    ...(rows === undefined ? {} : { rows }),
    ...(nextViewId === undefined ? {} : { nextViewId: Math.max(nextViewId, highestViewId(views) + 1) }),
  }
}

function highestViewId(views: readonly DockViewTab[]): number {
  return Math.max(0, ...views.map(view => Number(view.id)).filter(Number.isFinite))
}

function defaultName(id: string): string {
  return id === MAIN_DOCK_ID ? MAIN_DOCK.name : `Dock ${id}`
}

/**
 * The one-dock layout of earlier versions as the main dock: on the right, its enabled panels in their order.
 * @example
 * // before: { isOpen: true, order: ['jira', 'branch', 'checks'], disabled: ['checks'], minimized: ['jira'], view: 'panels' }
 * // after:  { docks: [{ id: 'main', name: 'Dock', position: 'right', views: [{ id: '1', panels: ['jira', 'branch'],
 * //           minimized: ['jira'], … }], isOpen: true, … }], lastDockId: 'main', known: ['jira', 'branch', 'checks'] }
 */
export function migrateSingleLayout(saved: unknown): DockLayout {
  const order = readList(saved, 'order')
  const disabled = readList(saved, 'disabled')
  const focused = fieldOf(saved, 'focused')
  const panels = order.filter(id => !disabled.includes(id))
  const main: DockView = {
    ...MAIN_DOCK,
    views: [newView('1', 'right', panels, readList(saved, 'minimized'))],
    isOpen: fieldOf(saved, 'isOpen') === true,
    view: fieldOf(saved, 'view') === 'manage' ? 'manage' : 'panels',
    ...(typeof focused === 'string' ? { focused } : {}),
  }

  return { docks: [main], lastDockId: MAIN_DOCK_ID, known: [...new Set([...order, ...disabled])] }
}

/** A stored or held layout of any earlier shape, read field by field: docks of views, docks of panels, or one dock. */
export function readLayout(saved: unknown): DockLayout {
  const docks = fieldOf(saved, 'docks')
  if (!Array.isArray(docks)) return migrateSingleLayout(saved)
  const read = docks.flatMap(one => readDock(one) ?? [])
  const unique = read.filter((dock, index) => read.findIndex(one => one.id === dock.id) === index)
  const lastDockId = fieldOf(saved, 'lastDockId')

  return { docks: unique, lastDockId: isDockId(lastDockId) ? lastDockId : MAIN_DOCK_ID, known: readList(saved, 'known') }
}

/** The view a dock shows: its active one, else its first; a dock with none (never stored so) gets an empty one. */
export function activeView(dock: DockView): DockViewTab {
  return dock.views.find(view => view.id === dock.activeViewId) ?? dock.views[0] ?? newView('1', dock.position)
}

/** The panels a dock shows now: its active view's. */
export function shownPanels(dock: DockView): string[] {
  return activeView(dock).panels
}

/** The dock with `change` applied to the view `viewId`; a view that is not there leaves the dock as it is. */
export function changeViewById(dock: DockView, viewId: string, change: (view: DockViewTab) => DockViewTab): DockView {
  if (!dock.views.some(view => view.id === viewId)) return dock

  return { ...dock, views: dock.views.map(view => (view.id === viewId ? change(view) : view)) }
}

export function changeActiveView(dock: DockView, change: (view: DockViewTab) => DockViewTab): DockView {
  const active = activeView(dock)
  const views = dock.views.some(view => view.id === active.id) ? dock.views : [active]

  return { ...dock, activeViewId: active.id, views: views.map(view => (view.id === active.id ? change(view) : view)) }
}

/** The docks with the first bottom one kept there and any other bottom one moved to the right. */
function keepOneBottom(docks: readonly DockView[]): DockView[] {
  const first = docks.find(dock => dock.position === 'bottom')

  return docks.map(dock => (dock.position === 'bottom' && dock !== first ? { ...dock, position: 'right' } : dock))
}

/** The view holding only the panels `isKept` keeps, each once, its widths for those panels only. */
function keepKnown(view: DockViewTab, isKept: (id: string) => boolean): DockViewTab {
  const panels = [...new Set(view.panels)].filter(isKept)
  const widths = Object.fromEntries(Object.entries(view.widths).filter(([id]) => panels.includes(id)))

  return { ...view, panels, minimized: view.minimized.filter(isKept), widths }
}

/**
 * Whether a layout keeps a panel: one that exists, or, given the built-in ids, any other one too, since a pack's
 * panel may be missing only for now (its plugin not loaded yet); Manage's Remove forgets it.
 */
function keeperOf(ids: readonly string[], builtInIds: readonly string[] | undefined): (id: string) => boolean {
  const exists = new Set(ids)

  return id => exists.has(id) || (builtInIds !== undefined && !builtInIds.includes(id))
}

/**
 * The layout held to the panels that exist and to its rules: one dock at least, one bottom dock at most,
 * `lastDockId` naming a dock, every dock with a view, and a panel never placed before added to the last used
 * dock's active view (an opt-in panel is only recorded as known, so it joins no view until ticked in Manage).
 * @example
 * // before: docks [{ id: 'main', views: [{ panels: ['jira', 'gone'] }] }], known ['jira', 'gone'], ids ['branch', 'jira']
 * // after:  docks [{ id: 'main', views: [{ panels: ['jira', 'branch'] }] }], known ['branch', 'jira']
 */
export function withKnownPanels(
  layout: DockLayout,
  ids: readonly string[],
  builtInIds?: readonly string[],
  optInIds: readonly string[] = [],
): DockLayout {
  const isKept = keeperOf(ids, builtInIds)
  const fresh = ids.filter(id => !layout.known.includes(id) && !optInIds.includes(id))
  const docks = keepOneBottom(layout.docks.length > 0 ? layout.docks : [MAIN_DOCK])
  const lastDockId = docks.some(dock => dock.id === layout.lastDockId) ? layout.lastDockId : (docks[0]?.id ?? MAIN_DOCK_ID)

  return {
    docks: docks.map(dock => {
      const known = changeActiveView({ ...dock, views: dock.views.map(view => keepKnown(view, isKept)) }, view => view)
      if (dock.id !== lastDockId || fresh.length === 0) return known

      return changeActiveView(known, view => ({ ...view, panels: [...view.panels, ...fresh.filter(id => !view.panels.includes(id))] }))
    }),
    lastDockId,
    known: [...new Set([...ids, ...layout.known.filter(isKept)])],
  }
}

/** The layout with one panel gone from every view and from `known`: Manage's Remove of a panel not loaded. */
export function forgetPanel(layout: DockLayout, panelId: string): DockLayout {
  const isKept = (id: string) => id !== panelId

  return {
    ...layout,
    docks: layout.docks.map(dock => ({ ...dock, views: dock.views.map(view => keepKnown(view, isKept)) })),
    known: layout.known.filter(isKept),
  }
}

/** A dock as a new session finds it: its panel cards in view from the top, nothing focused, no menu open. */
function freshView(dock: DockView): DockView {
  const { focused: _focused, isMenuOpen: _isMenuOpen, isLayoutOpen: _isLayoutOpen, ...rest } = dock

  return { ...rest, view: 'panels' }
}

/**
 * The layout a new session starts with: the stored one (or the default). No pane is open yet, so every right
 * dock starts closed; the bottom dock, part of the band, stays as it was.
 */
export function restoreLayout(
  stored: unknown,
  ids: readonly string[],
  builtInIds?: readonly string[],
  optInIds?: readonly string[],
): DockLayout {
  const layout = readLayout(stored)
  const docks = keepOneBottom(layout.docks).map(dock => ({ ...freshView(dock), isOpen: dock.position === 'bottom' && dock.isOpen }))

  return withKnownPanels({ ...layout, docks }, ids, builtInIds, optInIds)
}

/**
 * The layout the session already holds, after a reload of the mod: kept as it was (earlier shapes moved to
 * docks of views), each right dock open exactly when its pane is.
 */
export function reconcileLayout(
  held: unknown,
  ids: readonly string[],
  openPanes: readonly string[],
  builtInIds?: readonly string[],
  optInIds?: readonly string[],
): DockLayout {
  const layout = readLayout(held)
  const docks = keepOneBottom(layout.docks).map(dock =>
    dock.position === 'right' ? { ...dock, isOpen: openPanes.includes(paneIdOf(dock.id)) } : dock,
  )

  return withKnownPanels({ ...layout, docks }, ids, builtInIds, optInIds)
}

export function findDock(layout: DockLayout, dockId: string | undefined): DockView | undefined {
  return layout.docks.find(dock => dock.id === dockId)
}

/** The dock used last: what `/dock` toggles. */
export function lastDock(layout: DockLayout): DockView {
  return findDock(layout, layout.lastDockId) ?? layout.docks[0] ?? MAIN_DOCK
}

export function bottomDock(layout: DockLayout): DockView | undefined {
  return layout.docks.find(dock => dock.position === 'bottom')
}

/** The docks, most recently used first. */
function byRecency(docks: readonly DockView[]): DockView[] {
  return [...docks].sort((a, b) => b.usedAt - a.usedAt)
}

/** The right dock used last, which `/dock right` opens. */
export function lastRightDock(layout: DockLayout): DockView | undefined {
  return byRecency(layout.docks.filter(dock => dock.position === 'right'))[0]
}

/** The open right dock used last: the one whose width the docks take back after the New panel pane closes. */
export function lastOpenRightDock(layout: DockLayout): DockView | undefined {
  return byRecency(layout.docks.filter(dock => dock.position === 'right' && dock.isOpen))[0]
}

function holdsPanel(dock: DockView, panelId: string): boolean {
  return dock.views.some(view => view.panels.includes(panelId))
}

/** The dock a band tab shows its panel in: the most recently used open dock with a view holding it, else the last used dock. */
export function tabTarget(layout: DockLayout, panelId: string): DockView {
  return byRecency(layout.docks).find(dock => dock.isOpen && holdsPanel(dock, panelId)) ?? lastDock(layout)
}

/** Whether a panel's card is in the dock's active view, its body showing. */
function isExpandedIn(dock: DockView, panelId: string): boolean {
  const view = activeView(dock)

  return dock.view === 'panels' && view.panels.includes(panelId) && !view.minimized.includes(panelId)
}

/** Whether `panelId`'s card is the one a band tab brought into view in this dock, its body showing. */
export function isFocusedOn(dock: DockView, panelId: string): boolean {
  return dock.focused === panelId && isExpandedIn(dock, panelId)
}

/** The ids of the panes that are open but behind another pane's tab. */
export function hiddenPaneIds(panes: readonly UiPane[]): Set<string> {
  return new Set(panes.filter(pane => !pane.isShown).map(pane => pane.id))
}

/** Whether a dock is open and, for a right dock, its pane is not a hidden tab. */
function isVisible(dock: DockView, hiddenPanes: ReadonlySet<string>): boolean {
  return dock.isOpen && !hiddenPanes.has(paneIdOf(dock.id))
}

/** Whether a band tab shows its panel as the one in view: some visible dock is focused on it. */
export function isTabActive(layout: DockLayout, panelId: string, hiddenPanes: ReadonlySet<string> = new Set()): boolean {
  return layout.docks.some(dock => isVisible(dock, hiddenPanes) && isFocusedOn(dock, panelId))
}

/**
 * Whether a panel's card body is on screen in some dock: open, on its panels view, the panel in its active
 * view and not minimized. A panel's timer reads the layout atom in its own file and skips work while this is false.
 */
export function isShownIn(layout: DockLayout, panelId: string, hiddenPanes: ReadonlySet<string> = new Set()): boolean {
  return readLayout(layout).docks.some(dock => isVisible(dock, hiddenPanes) && isExpandedIn(dock, panelId))
}

/** The panels the band has a tab for: every one some dock's view shows, the first dock's order first. */
export function bandPanelIds(layout: DockLayout): string[] {
  return [...new Set(layout.docks.flatMap(dock => dock.views.flatMap(view => view.panels)))]
}

export function changeDock(layout: DockLayout, dockId: string, change: (dock: DockView) => DockView): DockLayout {
  return { ...layout, docks: layout.docks.map(dock => (dock.id === dockId ? change(dock) : dock)) }
}

/** The layout with `dockId` as the most recently used dock. */
export function touchDock(layout: DockLayout, dockId: string): DockLayout {
  const usedAt = Math.max(0, ...layout.docks.map(dock => dock.usedAt)) + 1
  const touched = changeDock(layout, dockId, dock => ({ ...dock, usedAt }))

  return findDock(layout, dockId) ? { ...touched, lastDockId: dockId } : layout
}

/** The dock showing `view`, open, with no panel in focus and its menu closed: only a band tab brings a card into view. */
export function showView(dock: DockView, view: DockView['view']): DockView {
  const { focused: _focused, isMenuOpen: _isMenuOpen, ...rest } = dock

  return { ...rest, view, isOpen: true }
}

export function closeView(dock: DockView): DockView {
  const { focused: _focused, isMenuOpen: _isMenuOpen, ...rest } = dock

  return { ...rest, isOpen: false }
}

/** The view a band tab brings a panel into: the active one when it holds the panel, else the first that does. */
function viewHolding(dock: DockView, panelId: string): DockViewTab | undefined {
  const active = activeView(dock)

  return active.panels.includes(panelId) ? active : dock.views.find(view => view.panels.includes(panelId))
}

/**
 * What a band tab makes of the layout: the dock open on the view holding the panel (its active view, which
 * takes the panel in when no view has it), the panel's card expanded, the dock the last used.
 */
export function focusPanel(layout: DockLayout, dockId: string, panelId: string): DockLayout {
  const focused = changeDock(layout, dockId, dock => {
    const top = showView(dock, 'panels')
    const viewId = viewHolding(dock, panelId)?.id ?? activeView(dock).id
    const switched = viewId === activeView(dock).id ? top : selectView(top, viewId)

    return {
      ...changeActiveView(switched, view => ({
        ...view,
        panels: view.panels.includes(panelId) ? view.panels : [...view.panels, panelId],
        minimized: view.minimized.filter(id => id !== panelId),
      })),
      focused: panelId,
    }
  })

  return touchDock(focused, dockId)
}

/** The smallest number from 2 that no dock has as its id. */
function nextDockId(layout: DockLayout): string {
  let next = 2
  while (layout.docks.some(dock => dock.id === String(next))) next += 1

  return String(next)
}

/**
 * A new empty dock at `position`, open on its Manage view and the last used, every dock's menu closed.
 * A second bottom dock is refused: the layout comes back unchanged.
 */
export function addDock(layout: DockLayout, position: DockPosition): DockLayout {
  if (position === 'bottom' && bottomDock(layout)) return layout
  const id = nextDockId(layout)
  const dock: DockView = { ...MAIN_DOCK, id, name: defaultName(id), position, views: [newView('1', position)], isOpen: true, view: 'manage' }
  const docks = layout.docks.map(({ isMenuOpen: _isMenuOpen, ...rest }) => rest)

  return touchDock({ ...layout, docks: [...docks, dock] }, id)
}

/** The view with `panels` added last, minimized when they were where they came from; the ones it has stay. */
function adoptPanels(view: DockViewTab, panels: readonly string[], minimized: readonly string[]): DockViewTab {
  const added = panels.filter(id => !view.panels.includes(id))

  return {
    ...view,
    panels: [...view.panels, ...added],
    minimized: [...view.minimized, ...added.filter(id => minimized.includes(id))],
  }
}

/**
 * The layout without the dock; the last dock stays. The most recently used dock left becomes the last used,
 * and its active view takes the panels no other dock shows, minimized as they were.
 */
export function removeDock(layout: DockLayout, dockId: string): DockLayout {
  const removed = findDock(layout, dockId)
  const rest = layout.docks.filter(dock => dock.id !== dockId)
  if (!removed || rest.length === 0) return layout
  const lastDockId = layout.lastDockId === dockId ? (byRecency(rest)[0]?.id ?? MAIN_DOCK_ID) : layout.lastDockId
  const shown = new Set(rest.flatMap(dock => dock.views.flatMap(view => view.panels)))
  const orphans = [...new Set(removed.views.flatMap(view => view.panels))].filter(id => !shown.has(id))
  const minimized = removed.views.flatMap(view => view.minimized)
  const docks = rest.map(dock =>
    dock.id === lastDockId && orphans.length > 0 ? changeActiveView(dock, view => adoptPanels(view, orphans, minimized)) : dock,
  )

  return { ...layout, docks, lastDockId }
}

/**
 * Moves a dock to the other side, open and last used: right to bottom, where the bottom dock (if any) takes
 * its place on the right, open as it was; bottom to right.
 * @example
 * // before: [{ id: 'main', position: 'right' }, { id: '2', position: 'bottom', isOpen: true }], swap 'main'
 * // after:  [{ id: 'main', position: 'bottom', isOpen: true }, { id: '2', position: 'right', isOpen: true }]
 */
export function swapPosition(layout: DockLayout, dockId: string): DockLayout {
  const dock = findDock(layout, dockId)
  if (!dock) return layout
  const position: DockPosition = dock.position === 'right' ? 'bottom' : 'right'
  const displaced = position === 'bottom' ? bottomDock(layout) : undefined
  const docks = layout.docks.map((one): DockView => {
    if (one.id === dockId) return { ...showView(one, one.view), position }
    if (one.id === displaced?.id) return { ...one, position: 'right' }

    return one
  })

  return touchDock({ ...layout, docks }, dockId)
}

/** The dock under its new name, trimmed and cut to a tab's length; a blank name changes nothing. */
export function renameDock(layout: DockLayout, dockId: string, name: string): DockLayout {
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH)

  return trimmed === '' ? layout : changeDock(layout, dockId, dock => ({ ...dock, name: trimmed }))
}

/**
 * What a panel's control in a dock does to its view (the active one unless the control names another): `toggle` minimizes or expands its card, `up` and
 * `down` move it in the view's order, `enable` (a Manage checkbox) shows it last or takes it out.
 */
export function changePanel(dock: DockView, action: 'toggle' | 'up' | 'down' | 'enable', panelId: string, viewId?: string): DockView {
  return changeViewById(dock, viewId ?? activeView(dock).id, view => {
    switch (action) {
      case 'toggle':
        return { ...view, minimized: toggleMember(view.minimized, panelId) }
      case 'up':
      case 'down':
        return { ...view, panels: moveInOrder(view.panels, panelId, action === 'up' ? -1 : 1) }
      case 'enable':
        return view.panels.includes(panelId)
          ? { ...view, panels: view.panels.filter(id => id !== panelId), minimized: view.minimized.filter(id => id !== panelId) }
          : { ...view, panels: [...view.panels, panelId] }
    }
  })
}

/** A panel's emoji and its title up to the first ` · `: `🎫 Jira · assigned to me` → `🎫 Jira`. */
export function shortLabel(panel: Pick<DockPanel, 'icon' | 'title'>): string {
  return `${panel.icon} ${panel.title.split(' · ')[0] ?? panel.title}`
}

/** What a view's tab says: its own name, its one panel (`🎫 Jira`), or its place (`View 2`). */
export function viewName(view: DockViewTab, index: number, registry: readonly Pick<DockPanel, 'id' | 'icon' | 'title'>[]): string {
  if (view.name !== undefined) return view.name
  const only = view.panels.length === 1 ? registry.find(panel => panel.id === view.panels[0]) : undefined

  return only ? shortLabel(only) : `View ${index + 1}`
}

/** The dock on another of its views, no panel in focus; Manage stays open on the new view. */
export function selectView(dock: DockView, viewId: string): DockView {
  if (!dock.views.some(view => view.id === viewId)) return dock
  const { focused: _focused, ...rest } = dock

  return { ...rest, activeViewId: viewId }
}

/**
 * A new empty view, last and active, open in Manage so its panels can be ticked. Its id is never one an
 * earlier view had, so a press drawn for a removed view never reaches the new one.
 */
export function addView(dock: DockView): DockView {
  const id = Math.max(dock.nextViewId ?? 1, highestViewId(dock.views) + 1)
  const view = newView(String(id), dock.position)

  return { ...selectView({ ...dock, views: [...dock.views, view] }, view.id), view: 'manage', isOpen: true, nextViewId: id + 1 }
}

/**
 * The dock without the view; its last view stays. The view beside it becomes active when it was, and the active
 * view takes the panels no other view of any dock shows, minimized as they were.
 * @example
 * // before: main views [1: ['branch'], 2: ['jira']], active 2; remove 2
 * // after:  main views [1: ['branch', 'jira']], active 1
 */
export function removeView(layout: DockLayout, dockId: string, viewId: string): DockLayout {
  const dock = findDock(layout, dockId)
  const index = dock?.views.findIndex(view => view.id === viewId) ?? -1
  const removed = dock?.views[index]
  if (!dock || !removed || dock.views.length < 2) return layout
  const views = dock.views.filter(view => view.id !== viewId)
  const neighbour = views[Math.max(0, index - 1)] ?? views[0]
  const activeViewId = dock.activeViewId === viewId ? (neighbour?.id ?? '1') : dock.activeViewId
  const others = layout.docks.flatMap(one => (one.id === dockId ? views : one.views))
  const shown = new Set(others.flatMap(view => view.panels))
  const orphans = removed.panels.filter(id => !shown.has(id))
  const kept: DockView = { ...selectView({ ...dock, views }, activeViewId), view: 'panels' }

  return changeDock(layout, dockId, () => changeActiveView(kept, view => adoptPanels(view, orphans, removed.minimized)))
}

/**
 * The view under its new name; a blank name gives it back the name its panels make, and the name it shows
 * now, sent back unchanged, changes nothing.
 */
export function renameView(dock: DockView, viewId: string, name: string, shownName: string): DockView {
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH)
  if (trimmed === shownName) return dock

  return {
    ...dock,
    views: dock.views.map(view => {
      if (view.id !== viewId) return view
      const { name: _name, ...unnamed } = view

      return trimmed === '' ? unnamed : { ...view, name: trimmed }
    }),
  }
}

/** The view's direction; a view that is not there changes nothing. */
export function setDirection(dock: DockView, viewId: string, direction: DockDirection): DockView {
  return changeViewById(dock, viewId, view => ({ ...view, direction }))
}

/** A card's width in a view; `auto` is kept as no entry. */
export function setCardWidth(dock: DockView, viewId: string, panelId: string, width: CardWidth): DockView {
  return changeViewById(dock, viewId, view => {
    const { [panelId]: _old, ...widths } = view.widths

    return { ...view, widths: width === 'auto' ? widths : { ...widths, [panelId]: width } }
  })
}

/** One card's place in a line of the dock: its panel and its width in columns, its frame included. */
export interface CardSlot {
  id: string
  width: number
}

/** A card's place while its line is built: `isAuto` cards share what the line has left. */
interface LineSlot extends CardSlot {
  isAuto: boolean
}

/** A fixed width in whole columns: three thirds or two halves and the gaps between them fit `columns`. */
export function presetColumns(width: Exclude<CardWidth, 'auto'>, columns: number, gap = CARD_GAP): number {
  const room = Math.max(1, columns)
  if (width === 'third') return Math.max(1, Math.floor((room - 2 * gap) / 3))
  if (width === 'half') return Math.max(1, Math.floor((room - gap) / 2))

  return room
}

/**
 * The cards of a row view laid out in lines, as `flex-wrap: wrap` would: each card in turn on the current line
 * when it fits at its least width (an auto card's minimum, else its fraction), else on a new line; then each
 * line's auto cards share what the line has left.
 * @example
 * // before: ['branch', 'checks', 'jira'], { jira: 'full' }, 80 columns
 * // after:  [[{ id: 'branch', width: 40 }, { id: 'checks', width: 39 }], [{ id: 'jira', width: 80 }]]
 */
export function rowLines(panels: readonly string[], widths: Readonly<Record<string, CardWidth>>, columns: number, gap = CARD_GAP): CardSlot[][] {
  const room = Math.max(1, columns)
  const autoMin = Math.min(AUTO_CARD_COLUMNS, room)
  const lines: LineSlot[][] = []
  for (const id of panels) {
    const choice = widths[id] ?? 'auto'
    const width = choice === 'auto' ? autoMin : presetColumns(choice, room, gap)
    const line = lines[lines.length - 1]
    const used = line ? line.reduce((sum, slot) => sum + slot.width + gap, -gap) : 0
    if (line && line.length > 0 && used + gap + width <= room) line.push({ id, width, isAuto: choice === 'auto' })
    else lines.push([{ id, width, isAuto: choice === 'auto' }])
  }

  return lines.map(line => {
    const spare = room - line.reduce((sum, slot) => sum + slot.width + gap, -gap)
    const autos = line.filter(slot => slot.isAuto).length
    let given = 0

    return line.map(slot => {
      if (!slot.isAuto || spare <= 0) return { id: slot.id, width: slot.width }
      const extra = Math.floor(spare / autos) + (given < spare % autos ? 1 : 0)
      given += 1

      return { id: slot.id, width: slot.width + extra }
    })
  })
}

/** The active view's cards in lines: one full-width card per line in a column view, wrapped in a row view. */
export function cardLines(dock: DockView, columns: number): CardSlot[][] {
  const view = activeView(dock)
  if (view.direction === 'column') return view.panels.map(id => [{ id, width: Math.max(1, columns) }])

  return rowLines(view.panels, view.widths, columns)
}

/** The most rows the bottom dock may take: the band's, less the notices and the tab row under the dock. */
export function dockCapRows(maxRows: number, belowRows: number): number {
  return Math.max(BOTTOM_CHROME_ROWS + 1, maxRows - belowRows)
}

/** The bottom dock's height: the person's rows (else the default) held between the minimum and the cap. */
export function dockHeight(rows: number | undefined, capRows: number): number {
  return Math.min(capRows, Math.max(MIN_DOCK_ROWS, rows ?? DEFAULT_DOCK_ROWS))
}

/** The rows the bottom dock's cards get under its height and the open menus, and the rows the dock is drawn in. */
export interface BottomBody {
  /** 0 when the menus leave fewer than MIN_BODY_ROWS: the cards are not drawn. */
  rows: number
  /** The dock as drawn: its controls, the open menus and the cards. */
  drawnRows: number
}

/**
 * The bottom dock's card rows: what its height leaves under the controls and the open menus, none under two.
 * @example
 * // before: height 12, menus 3   after: { rows: 6, drawnRows: 12 }
 * // before: height 12, menus 8   after: { rows: 0, drawnRows: 11 }
 */
export function bottomBody(height: number, menuRows: number): BottomBody {
  const room = height - BOTTOM_CHROME_ROWS - menuRows
  const rows = room >= MIN_BODY_ROWS ? room : 0

  return { rows, drawnRows: BOTTOM_CHROME_ROWS + menuRows + rows }
}

/** What the bottom dock's resize grip is drawn with (hooks/dock/ResizeGrip.tsx). */
export interface GripProps {
  /** The height a drag starts from: the dock's as drawn. */
  base: number
  min: number
  max: number
  columns: number
}

/** The rows a grip posted on release, held to the `max` it posts with them; none for anything else. */
export function parseResizeMessage(data: unknown): number | undefined {
  if (fieldOf(data, 'type') !== 'resize') return undefined
  const rows = readCount(fieldOf(data, 'rows'), 1)
  const max = readCount(fieldOf(data, 'max'), 1)

  return rows === undefined || max === undefined ? rows : Math.min(rows, max)
}

/** The rows the drag lands on: up (a negative `dy`) makes the dock taller, held between `min` and `max`. */
export function resizeTarget(base: number, dy: number, min: number, max: number): number {
  return Math.min(max, Math.max(Math.min(min, max), base - dy))
}

/** A whole number of rows held for a key, or none when what is held there is not one. */
function heldRows(held: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = held[key]

  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
}

/** The cards' height as the probe beside them measured it on one surface: `<surface>:<dockId>`. */
export function measureKey(surface: RenderSurface, dockId: string): string {
  return `${surface}:${dockId}`
}

export function measuredRows(measures: Readonly<Record<string, unknown>>, surface: RenderSurface, dockId: string): number | undefined {
  return heldRows(measures, measureKey(surface, dockId))
}

/** The furthest the bottom dock's cards scroll: to their measured end; none until the probe has measured them. */
export function maxScrollRow(measured: number | undefined, bodyRows: number): number {
  return measured === undefined ? 0 : Math.max(0, measured - bodyRows)
}

/** How far a dock's cards are scrolled, held between the top and `max`. */
export function scrollRowOf(scrolls: Readonly<Record<string, unknown>>, dockId: string, max: number): number {
  return Math.min(Math.max(0, max), heldRows(scrolls, dockId) ?? 0)
}

/** The docks' scroll with the dock at `row` (0 drops it); the same object when it is there already, so nothing is written. */
export function withScrollRow(scrolls: Readonly<Record<string, number>>, dockId: string, row: number): Readonly<Record<string, number>> {
  if ((scrolls[dockId] ?? 0) === row) return scrolls
  const { [dockId]: _old, ...rest } = scrolls

  return row === 0 ? rest : { ...rest, [dockId]: row }
}

/**
 * The docks' scroll with one dock's cards moved by `by` (negative toward the top), held between the top and `max`.
 * @example
 * // before: { '2': 4 }, dock '2', by 3, max 5   after: { '2': 5 }
 * // before: { '2': 5 }, dock '2', by 1, max 5   after: the same object: nothing to write
 * // before: { '2': 1 }, dock '2', by -4, max 5  after: {}
 */
export function scrolledBy(scrolls: Readonly<Record<string, number>>, dockId: string, by: number, max: number): Readonly<Record<string, number>> {
  const row = Math.min(Math.max(0, max), Math.max(0, scrollRowOf(scrolls, dockId, max) + Math.round(by)))

  return withScrollRow(scrolls, dockId, row)
}

/** What the probe beside the bottom dock's cards is drawn with (hooks/dock/Measure.tsx). */
export interface MeasureProps {
  dockId: string
  /** The cards' rows the dock already holds for this surface; absent before the first measure. */
  measured?: number
}

export function measureProps(dockId: string, measured: number | undefined): MeasureProps {
  return measured === undefined ? { dockId } : { dockId, measured }
}

/** Whether the probe posts what it measured: once laid out, and only when the dock holds another height. */
export function shouldPostMeasure(props: MeasureProps, rows: number): boolean {
  return rows > 0 && rows !== props.measured
}

/** The dock and rows a probe posted; none for anything else. */
export function parseMeasureMessage(data: unknown): { dockId: string; rows: number } | undefined {
  const dockId = fieldOf(data, 'dockId')
  const rows = readCount(fieldOf(data, 'rows'), 1)

  return fieldOf(data, 'type') === 'measure' && isDockId(dockId) && rows !== undefined ? { dockId, rows } : undefined
}

/** What the bottom dock's scrollbar is drawn with (hooks/dock/ScrollBar.tsx). */
export interface ScrollBarProps {
  dockId: string
  /** The bar's height: the rows the cards are clipped to. */
  rows: number
  /** The cards' rows the dock holds for this surface; absent before the first measure. */
  measured?: number
  scrollRow: number
  /** The furthest row the cards scroll to. */
  max: number
}

export function scrollBarProps(dockId: string, rows: number, measured: number | undefined, scrollRow: number, max: number): ScrollBarProps {
  const props = { dockId, rows, scrollRow, max }

  return measured === undefined ? props : { ...props, measured }
}

/** A move of the cards the bar asks for: rows from where they are, or the row to land on. */
export type ScrollMove = { by: number } | { to: number }

/** Where the thumb sits in the track, counted from the track's first row. */
interface ScrollThumb {
  start: number
  length: number
}

/** Whether the cards are taller than the bar, so there is something to scroll. */
export function isScrollable(props: ScrollBarProps): boolean {
  return props.rows >= 2 && props.measured !== undefined && props.measured > props.rows && props.max > 0
}

/**
 * The thumb in a track of `rows - 2`; none when the cards fit, are not measured yet, or the bar has no track.
 * @example
 * // before: rows 8, measured 24, scrollRow 9, max 16  after: { start: 2, length: 2 }
 * // before: rows 8, measured 8                       after: undefined
 */
function thumbOf(props: ScrollBarProps): ScrollThumb | undefined {
  const track = props.rows - 2
  if (!isScrollable(props) || track < 1 || props.measured === undefined) return undefined
  const length = Math.min(track, Math.max(1, Math.round((track * props.rows) / props.measured)))
  const start = Math.round(((track - length) * Math.min(props.scrollRow, props.max)) / props.max)

  return { start, length }
}

/**
 * The bar's glyph for each row: arrows at the ends, a rule between, a thumb on it; blanks when nothing scrolls.
 * @example
 * // before: rows 5, measured 15, scrollRow 0, max 10  after: ['▲', '┃', '│', '│', '▼']
 * // before: rows 5, measured 5                        after: [' ', ' ', ' ', ' ', ' ']
 */
export function scrollBarGlyphs(props: ScrollBarProps): string[] {
  const rows = Math.max(0, props.rows)
  if (!isScrollable(props)) return Array.from({ length: rows }, () => ' ')
  const thumb = thumbOf(props)

  return Array.from({ length: rows }, (_, row) => {
    if (row === 0) return '▲'
    if (row === rows - 1) return '▼'
    const inThumb = thumb !== undefined && row - 1 >= thumb.start && row - 1 < thumb.start + thumb.length

    return inThumb ? '┃' : '│'
  })
}

/** What a press on the bar's row `y` does: an arrow or a page move, or grabbing the thumb; nothing when the bar is blank. */
export function scrollBarPress(props: ScrollBarProps, y: number): { by: number } | { isThumb: true } | undefined {
  if (!isScrollable(props) || y < 0 || y >= props.rows) return undefined
  if (y === 0) return { by: -1 }
  if (y === props.rows - 1) return { by: 1 }
  const thumb = thumbOf(props)
  if (thumb === undefined) return undefined
  if (y < 1 + thumb.start) return { by: -(props.rows - 1) }
  if (y >= 1 + thumb.start + thumb.length) return { by: props.rows - 1 }

  return { isThumb: true }
}

/**
 * The row a dragged thumb lands on, `dy` rows from the press that took it at `dragRow`, held between 0 and `max`.
 * @example
 * // before: rows 8, measured 24 (track 6, thumb 2, max 16), dragRow 0, dy 2  after: 8
 * // before: the same, dy 9                                                   after: 16
 */
export function scrollBarDragTarget(props: ScrollBarProps, dragRow: number, dy: number): number {
  const thumb = thumbOf(props)
  const span = thumb === undefined ? 0 : props.rows - 2 - thumb.length
  if (span <= 0) return dragRow

  return Math.min(props.max, Math.max(0, dragRow + Math.round((dy * props.max) / span)))
}

/** What a key does once the bar has the focus: arrows by a row, Page keys by a page, Home and End to the ends. */
export function scrollBarKeyMove(props: ScrollBarProps, key: string): ScrollMove | undefined {
  if (!isScrollable(props)) return undefined
  const page = Math.max(1, props.rows - 1)
  if (key === 'up') return { by: -1 }
  if (key === 'down') return { by: 1 }
  if (key === 'pageup') return { by: -page }
  if (key === 'pagedown') return { by: page }
  if (key === 'home') return { to: 0 }
  if (key === 'end') return { to: props.max }

  return undefined
}

/** The move and the furthest row the bar posted; none for anything else. */
export function parseScrollMessage(data: unknown): (ScrollMove & { max: number }) | undefined {
  if (fieldOf(data, 'type') !== 'scroll') return undefined
  const max = readCount(fieldOf(data, 'max'), 0)
  const by = fieldOf(data, 'by')
  const to = readCount(fieldOf(data, 'to'), 0)
  if (max === undefined) return undefined
  if (typeof by === 'number' && Number.isFinite(by)) return { by: Math.round(by), max }

  return to === undefined ? undefined : { to, max }
}

/** What opening and closing the docks' panes takes to go from one layout to the next. */
export interface PaneChanges {
  /** Right docks to open, or to retitle after a rename. */
  opens: DockView[]
  /** Pane ids to close: a dock closed, removed or moved to the bottom. */
  closes: string[]
}

function isPaneOpen(dock: DockView | undefined): dock is DockView {
  return dock !== undefined && dock.position === 'right' && dock.isOpen
}

/**
 * The panes to open and close for the docks' change.
 * @example
 * // before: main right open, 2 bottom open;  after: main bottom open, 2 right open
 * // after:  { opens: [dock 2], closes: ['claudedockula'] }
 */
export function paneChanges(before: DockLayout, after: DockLayout): PaneChanges {
  const opens = after.docks.filter(dock => {
    const was = findDock(before, dock.id)

    return isPaneOpen(dock) && (!isPaneOpen(was) || was.name !== dock.name)
  })
  const closes = before.docks
    .filter(dock => isPaneOpen(dock) && !isPaneOpen(findDock(after, dock.id)))
    .map(dock => paneIdOf(dock.id))

  return { opens, closes }
}

/** Swaps `id` with its neighbour `delta` places away; an edge leaves the order as it is. */
export function moveInOrder(order: readonly string[], id: string, delta: -1 | 1): string[] {
  const from = order.indexOf(id)
  const to = from + delta
  const neighbour = order[to]
  if (from < 0 || neighbour === undefined) {
    return [...order]
  }
  const moved = [...order]
  moved[to] = id
  moved[from] = neighbour

  return moved
}

export function toggleMember(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter(one => one !== id) : [...list, id]
}

// Every dock control's key holds its dock's id, `dock-<dockId>-<action>`, then `-<viewId>` for a control of one
// view (Remove view, Direction, a card's width or order, a Manage checkbox: what a stale press must not move to
// another view), `-<panelId>` for a card's, a Manage row's or a width's, and `-<viewId>` alone for a view's tab;
// the dock's `ui.press` hook matches them all with one literal pattern. A view id is digits, so the first
// `-<digits>-` of a view-scoped panel key ends it, whatever hyphens the panel id has.

const DOCK_ACTIONS = [
  'swap',
  'menu',
  'manage',
  'close',
  'new-right',
  'new-bottom',
  'remove',
  'add-panel',
  'layout',
  'add-view',
] as const
const VIEW_ACTIONS = ['remove-view', 'dir-column', 'dir-row'] as const
const PANEL_ACTIONS = ['toggle', 'settings', 'up', 'down', 'enable', 'drop', 'width-auto', 'width-third', 'width-half', 'width-full'] as const
/** The card controls that name no view: the minimize toggle and ⚙ (a panel's own hook matches their keys) and Remove panel. */
const UNSCOPED_PANEL_ACTIONS: readonly PanelAction[] = ['toggle', 'settings', 'drop']

export type DockAction = (typeof DOCK_ACTIONS)[number]
export type ViewAction = (typeof VIEW_ACTIONS)[number]
export type PanelAction = (typeof PANEL_ACTIONS)[number]

export interface DockPress {
  dockId: string
  action: DockAction
}

/** A press of a control that belongs to one view. */
export interface ViewActionPress {
  dockId: string
  action: ViewAction
  viewId: string
}

/** A press of a panel's control; `viewId` is the view it was drawn in, absent for the unscoped actions. */
export interface PanelPress {
  dockId: string
  action: PanelAction
  panelId: string
  viewId?: string
}

export interface ViewPress {
  dockId: string
  action: 'view'
  viewId: string
}

function isDockAction(value: string | undefined): value is DockAction {
  return DOCK_ACTIONS.some(action => action === value)
}

function isViewAction(value: string | undefined): value is ViewAction {
  return VIEW_ACTIONS.some(action => action === value)
}

function isPanelAction(value: string | undefined): value is PanelAction {
  return PANEL_ACTIONS.some(action => action === value)
}

/** The width a `width-<w>` action sets, or none for another action. */
export function widthOfAction(action: PanelAction): CardWidth | undefined {
  const [, width] = /^width-(.+)$/.exec(action) ?? []

  return isCardWidth(width) ? width : undefined
}

export function dockKey(dockId: string, action: DockAction): string {
  return `dock-${dockId}-${action}`
}

/** A control of one view: `dock-main-remove-view-2`. */
export function viewActionKey(dockId: string, action: ViewAction, viewId: string): string {
  return `dock-${dockId}-${action}-${viewId}`
}

/** A panel's control; the view it is drawn in goes before the panel id, except for the unscoped actions. */
export function panelKey(dockId: string, action: PanelAction, panelId: string, viewId?: string): string {
  return viewId === undefined ? `dock-${dockId}-${action}-${panelId}` : `dock-${dockId}-${action}-${viewId}-${panelId}`
}

/** A view's tab in its dock. */
export function viewKey(dockId: string, viewId: string): string {
  return `dock-${dockId}-view-${viewId}`
}

/** The dock's rename field. */
export function nameKey(dockId: string): string {
  return `dock-${dockId}-name`
}

/** A view's rename field. */
export function viewNameKey(dockId: string, viewId: string): string {
  return `dock-${dockId}-view-name-${viewId}`
}

/** The bottom dock's resize grip, a `Client` whose posts arrive at `ui.message` under this key. */
export function gripKey(dockId: string): string {
  return `dock-${dockId}-grip`
}

/** The probe beside the bottom dock's cards, a `Client` whose posts arrive at `ui.message` under this key. */
export function measureClientKey(dockId: string): string {
  return `dock-${dockId}-measure`
}

/** The bottom dock's scrollbar, a `Client` whose posts arrive at `ui.message` under this key. */
export function scrollBarKey(dockId: string): string {
  return `dock-${dockId}-scrollbar`
}

/** A card's address in a dock, which `$.ui.scroll` brings into view. */
export function cardKey(dockId: string, panelId: string): string {
  return `dock-${dockId}-card-${panelId}`
}

/**
 * Which dock control a key names.
 * @example
 * // before: 'dock-2-swap'              after: { dockId: '2', action: 'swap' }
 * // before: 'dock-main-remove-view-2'  after: { dockId: 'main', action: 'remove-view', viewId: '2' }
 * // before: 'dock-main-up-1-jira'      after: { dockId: 'main', action: 'up', viewId: '1', panelId: 'jira' }
 * // before: 'dock-main-toggle-jira'    after: { dockId: 'main', action: 'toggle', panelId: 'jira' }
 * // before: 'dock-main-view-2'         after: { dockId: 'main', action: 'view', viewId: '2' }
 * // before: 'dock-tab-jira'            after: undefined
 */
export function parseDockKey(key: string): DockPress | ViewActionPress | PanelPress | ViewPress | undefined {
  const pattern =
    /^dock-(main|\d+)-(new-right|new-bottom|add-panel|add-view|remove-view|dir-column|dir-row|width-[a-z]+|[a-z]+)(?:-(.+))?$/
  const [, dockId, action, rest] = pattern.exec(key) ?? []
  if (dockId === undefined) return undefined
  if (action === 'view') return isViewId(rest) ? { dockId, action, viewId: rest } : undefined
  if (isViewAction(action)) return isViewId(rest) ? { dockId, action, viewId: rest } : undefined
  if (rest === undefined) return isDockAction(action) ? { dockId, action } : undefined
  if (!isPanelAction(action)) return undefined
  if (UNSCOPED_PANEL_ACTIONS.includes(action)) return { dockId, action, panelId: rest }
  const [, viewId, panelId] = /^(\d+)-(.+)$/.exec(rest) ?? []

  return viewId === undefined || panelId === undefined ? undefined : { dockId, action, viewId, panelId }
}

/** One tab of the band above the prompt: the panel's emoji and its live summary. */
export interface BandTab {
  id: string
  icon: string
  summary: string
  /** A colour the panel asks for while something needs the person; a panel alternates it to blink. */
  tone?: ThemeKey
}

export interface BandFit {
  hasSummaries: boolean
  gap: number
}

const BAND_FITS: readonly BandFit[] = [
  { hasSummaries: true, gap: 3 },
  { hasSummaries: true, gap: 2 },
  { hasSummaries: false, gap: 2 },
  { hasSummaries: false, gap: 1 },
]

/** The text a tab draws: `🌿 ABC-101 ·3`, or the emoji alone. */
export function bandLabel(tab: BandTab, hasSummaries: boolean): string {
  return hasSummaries && tab.summary !== '' ? `${tab.icon} ${tab.summary}` : tab.icon
}

/** Cells the band takes with the tabs drawn that way, the trailing ➕ included. */
export function bandWidth(tabs: readonly BandTab[], fit: BandFit, addIcon: string): number {
  const labels = [...tabs.map(tab => bandLabel(tab, fit.hasSummaries)), addIcon]

  return labels.reduce((sum, label) => sum + cellWidth(label), 0) + fit.gap * (labels.length - 1)
}

/** The roomiest way to draw the tabs within `columns`: summaries and wide gaps first, emoji alone last. */
export function fitBand(tabs: readonly BandTab[], columns: number, addIcon: string): BandFit {
  const fit = BAND_FITS.find(one => bandWidth(tabs, one, addIcon) <= columns)

  return fit ?? { hasSummaries: false, gap: 1 }
}
