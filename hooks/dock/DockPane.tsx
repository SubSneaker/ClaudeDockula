import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderInput, RenderSurface, ThemeKey, Timer, UiPane, UiScrollArgs } from 'claude-code'

import type { DockLayout, DockNotice, DockPosition, DockView, NoticeTone } from '../../types'
import { PANELS } from '../panels'
import { EMPTY_ACTIVITY, drawActivity, summarizeActivity } from '../panels/activity'
import { drawBranch, summarizeBranch } from '../panels/branch'
import { checksIcon, drawChecks, summarizeChecks } from '../panels/checks'
import { type DockPanel } from '../panels/contract'
import { drawGitgud, gitgudTabTone, summarizeGitgud } from '../panels/gitgud'
import { prBadgesByKey } from '../panels/gitgud/jiraLink'
import { drawJira, summarizeJira } from '../panels/jira'
import { drawSlacker, summarizeSlacker } from '../panels/slacker'
import { SET_UP_SUMMARY } from '../settings'
import { COMPANION_NAME, companionRoot } from './companion'
import {
  DEFAULT_LAYOUT,
  MEASURE_COLUMNS,
  SCROLLBAR_COLUMNS,
  MIN_DOCK_ROWS,
  NEW_PANEL_OPEN,
  PANEL_RENAMES,
  activeView,
  addDock,
  addView,
  bandLabel,
  bandPanelIds,
  bottomBody,
  bottomDock,
  cardKey,
  cardLines,
  changeActiveView,
  changeDock,
  changePanel,
  closeView,
  dockCapRows,
  dockHeight,
  dockIdOfPane,
  dockOpenArgs,
  findDock,
  fitBand,
  focusPanel,
  forgetPanel,
  hiddenPaneIds,
  isFocusedOn,
  isTabActive,
  lastDock,
  lastOpenRightDock,
  lastRightDock,
  maxScrollRow,
  measureKey,
  measureProps,
  measuredRows,
  messageOf,
  paneChanges,
  paneIdOf,
  parseDockKey,
  parseMeasureMessage,
  parseResizeMessage,
  parseScrollMessage,
  readLayout,
  reconcileLayout,
  removeDock,
  removeView,
  renameDock,
  renamePanelIds,
  renameView,
  restoreLayout,
  scrollBarProps,
  scrollRowOf,
  scrolledBy,
  selectView,
  setCardWidth,
  setDirection,
  showView,
  swapPosition,
  tabTarget,
  touchDock,
  viewName,
  widthOfAction,
  withKnownPanels,
  withScrollRow,
  type BandTab,
  type DockPress,
  type PanelPress,
  type ViewActionPress,
  type ViewPress,
} from './layout'
import {
  NO_NOTICES,
  NOTICE_SWEEP_MS,
  dismissNotice,
  expireNotices,
  noticeRowCount,
  noticeRows,
  pushNotice,
  toggleNotice
} from './notices'
import { readPackPanels } from './packs'
import { SEEN_STORE_KEY, panelNews, readSeen, renameSeen } from './panelNews'
import { EMPTY_DRAFT, EMPTY_FORM, buildRemovePanelPrompt, listMcpServerNames } from './prompts'
import { drawMore, drawNote, type DockElements } from './ui'
import { drawUserPanel, summarizeUserPanel, userPanelsOf } from './user'
import { ADD_ICON, drawBottomDock, drawRightDock, openMenuRows, type BottomFrame, type DockScene } from './views'

// The engine follows `$` only into functions of the same file and lets `read`/`update` take only
// atoms declared here, so every function that touches `$` lives in this file; panels only draw.

/** Where a dock is drawn: a right dock's pane, or the band above the prompt for the bottom dock. */
type DockSite = RenderInput<'Pane'> | RenderInput<'AbovePrompt'>

const LAYOUT_STORE_KEY = 'layout'
const READY_NOTICE = 'Prompt ready — review and press Enter'
const SCROLL_RETRY_MS = 250
const NAME_INPUT = /^dock-(main|\d+)-name$/
const VIEW_NAME_INPUT = /^dock-(main|\d+)-view-name-(\d+)$/
const GRIP = /^dock-(main|\d+)-grip$/
const MEASURE = /^dock-(main|\d+)-measure$/
const SCROLLBAR = /^dock-(main|\d+)-scrollbar$/

const layoutAtom = atom({ plugin: 'claudedockula', key: 'layout' } as const, DEFAULT_LAYOUT)
const branchAtom = atom({ plugin: 'claudedockula', key: 'branch' } as const, {})
const checksAtom = atom({ plugin: 'claudedockula', key: 'checks' } as const, {})
const activityAtom = atom({ plugin: 'claudedockula', key: 'activity' } as const, EMPTY_ACTIVITY)
const jiraAtom = atom({ plugin: 'claudedockula', key: 'jira' } as const, {})
const slackerAtom = atom({ plugin: 'claudedockula', key: 'slacker' } as const, {})
const gitgudAtom = atom({ plugin: 'claudedockula', key: 'gitgud' } as const, {})
const draftAtom = atom({ plugin: 'claudedockula', key: 'addDraft' } as const, EMPTY_DRAFT)
const formAtom = atom({ plugin: 'claudedockula', key: 'addForm' } as const, EMPTY_FORM)
const noticesAtom = atom({ plugin: 'claudedockula', key: 'notices' } as const, NO_NOTICES)
const scrollAtom = atom({ plugin: 'claudedockula', key: 'dockScroll' } as const, {})
const measureAtom = atom({ plugin: 'claudedockula', key: 'dockMeasure' } as const, {})
const userPanelsAtom = atom({ plugin: 'claudedockula', key: 'userPanels' } as const, [])

/** The built-in panels, then the ones panel packs list through `$.dockula.panels`. */
async function registryOf($: EngineInterface): Promise<DockPanel[]> {
  return [...PANELS, ...userPanelsOf(await read($, userPanelsAtom))]
}

const BUILT_IN_IDS = PANELS.map(panel => panel.id)
const OPT_IN_IDS = PANELS.filter(panel => panel.isOptIn).map(panel => panel.id)

async function panelIdsOf($: EngineInterface): Promise<string[]> {
  return (await registryOf($)).map(panel => panel.id)
}

/** The one timer that clears info and success notices once their time has passed. */
let noticeSweeper: Timer | undefined

function bandTab(panel: DockPanel, summary: string, icon = panel.icon, tone?: ThemeKey): BandTab {
  return { id: panel.id, icon, summary, ...(tone === undefined ? {} : { tone }) }
}

/** The docks as the session holds them, in the current shape and panels; a drawing that reads them redraws on a change. */
async function readDocks($: EngineInterface): Promise<DockLayout> {
  return withKnownPanels(readLayout(await read($, layoutAtom)), await panelIdsOf($), BUILT_IN_IDS, OPT_IN_IDS)
}

async function changeLayout($: EngineInterface, change: (layout: DockLayout) => DockLayout): Promise<DockLayout> {
  const ids = await panelIdsOf($)
  const after = await update($, layoutAtom, layout => change(withKnownPanels(readLayout(layout), ids, BUILT_IN_IDS, OPT_IN_IDS)))
  await $.store.set(LAYOUT_STORE_KEY, after).catch(() => undefined)

  return after
}

/** A change made from inside one dock: the dock becomes the last used. */
async function changeOwnDock($: EngineInterface, dockId: string, change: (dock: DockView) => DockView): Promise<void> {
  await changeLayout($, layout => touchDock(changeDock(layout, dockId, change), dockId))
}

/** Writes a change to the docks, then opens and closes the panes it takes: a dock moved, added, removed or renamed. */
async function changeDocks($: EngineInterface, change: (layout: DockLayout) => DockLayout): Promise<DockLayout> {
  const before = await readDocks($)
  const after = await changeLayout($, change)
  const { opens, closes } = paneChanges(before, after)
  for (const id of closes) await $.ui.close({ id }).catch(() => undefined)
  for (const dock of opens) await $.ui.open(dockOpenArgs(dock))

  return after
}

// The scroll and the measured heights live in atoms of their own that only the band reads, never in the layout:
// a scroll writes one small value, nothing on disk, and leaves which dock was used last alone.

/** A dock's cards back at the top: after a band tab or a view switch. */
async function resetScroll($: EngineInterface, dockId: string): Promise<void> {
  const scrolls = await read($, scrollAtom)
  if (withScrollRow(scrolls, dockId, 0) !== scrolls) await update($, scrollAtom, current => withScrollRow(current, dockId, 0))
}

/** The cards' height a probe posted on one surface, kept unless it is the one held already. */
async function storeMeasure($: EngineInterface, surface: RenderSurface, dockId: string, rows: number): Promise<void> {
  if (measuredRows(await read($, measureAtom), surface, dockId) === rows) return
  await update($, measureAtom, current => ({ ...current, [measureKey(surface, dockId)]: rows }))
}

async function listPanes($: EngineInterface): Promise<readonly UiPane[]> {
  return $.ui.panes().catch(() => [])
}

/** A right dock is in view when its pane is placed and shown; the bottom dock while it is open in the band. */
function isInView(dock: DockView, panes: readonly UiPane[]): boolean {
  if (dock.position === 'bottom') return dock.isOpen
  const pane = panes.find(one => one.id === paneIdOf(dock.id))

  return pane !== undefined && pane.isPlaced && pane.isShown
}

/** Opens a right dock's pane; one open behind another pane's tab is closed and opened again to come to the front. */
async function showPane($: EngineInterface, dock: DockView): Promise<void> {
  const pane = (await listPanes($)).find(one => one.id === paneIdOf(dock.id))
  if (pane !== undefined && !pane.isShown) {
    await $.ui.close({ id: pane.id })
  }
  await $.ui.open(dockOpenArgs(dock))
}

/** Shows a dock, its pane brought to the front or the band showing it, on `view` or the view it had. */
async function openDock($: EngineInterface, dockId: string, view?: DockView['view']): Promise<void> {
  const dock = findDock(await readDocks($), dockId)
  if (!dock) return
  if (dock.position === 'right') await showPane($, dock)
  await changeOwnDock($, dockId, current => showView(current, view ?? current.view))
}

async function closeDock($: EngineInterface, dockId: string): Promise<void> {
  const dock = findDock(await readDocks($), dockId)
  if (dock?.position === 'right') await $.ui.close({ id: paneIdOf(dockId) })
  await changeOwnDock($, dockId, closeView)
}

/** Brings a card to the top of its right dock; a pane opened a moment ago may not hold it yet, so once more after. The bottom dock's band always fits, so nothing scrolls there. */
async function scrollToCard($: EngineInterface, dock: DockView, panelId: string): Promise<void> {
  if (dock.position !== 'right') return
  const to = { key: cardKey(dock.id, panelId) }
  const target: UiScrollArgs = { in: paneIdOf(dock.id), to, block: 'start' }
  const scrolled = await $.ui.scroll(target).catch(() => ({ deny: 'failed' }))
  if (scrolled.deny !== undefined) {
    $.clock.after(SCROLL_RETRY_MS, () => void $.ui.scroll(target).catch(() => undefined))
  }
}

/**
 * A band tab: shows its panel in the most recently used open dock holding it (else the last used dock, which
 * takes it in), or closes that dock when the panel is the one already in view there.
 */
async function pressTab($: EngineInterface, panelId: string): Promise<void> {
  const target = tabTarget(await readDocks($), panelId)
  if (isInView(target, await listPanes($)) && isFocusedOn(target, panelId)) {
    await closeDock($, target.id)

    return
  }
  if (target.position === 'right') await showPane($, target)
  await changeLayout($, current => focusPanel(current, target.id, panelId))
  await resetScroll($, target.id)
  await scrollToCard($, target, panelId)
}

/** `/dock`: opens the last used dock, or closes it when it is in view. */
async function toggleDock($: EngineInterface): Promise<string> {
  const dock = lastDock(await readDocks($))
  if (isInView(dock, await listPanes($))) {
    await closeDock($, dock.id)

    return `${dock.name} closed.`
  }
  await openDock($, dock.id, 'panels')

  return `${dock.name} opened.`
}

/** `/dock right` and `/dock bottom`: opens the last used dock there, or a new one, empty and on its Manage view. */
async function openDockAt($: EngineInterface, position: DockPosition): Promise<string> {
  const layout = await readDocks($)
  const existing = position === 'right' ? lastRightDock(layout) : bottomDock(layout)
  if (existing) {
    await openDock($, existing.id)

    return `${existing.name} opened.`
  }
  let before = layout.docks.length
  const after = await changeDocks($, current => {
    before = current.docks.length

    return addDock(current, position)
  })
  const opened = lastDock(after)
  if (after.docks.length === before) return `${opened.name} opened.`

  return `${opened.name} added ${position === 'right' ? 'on the right' : 'at the bottom'}: tick the panels it shows.`
}

/**
 * Opens the New panel pane (hooks/dock/NewPanelPane.tsx), its fields starting from the draft and the
 * MCP servers read once here rather than on every redraw.
 */
async function openNewPanel($: EngineInterface): Promise<void> {
  const seed = await read($, draftAtom)
  const servers = await $.tool
    .list()
    .then(listMcpServerNames)
    .catch(() => [])
  await update($, formAtom, () => ({ seed, servers }))
  await $.ui.open(NEW_PANEL_OPEN)
}

async function notify($: EngineInterface, tone: NoticeTone, title: string, detail?: string): Promise<void> {
  const at = await $.clock.now()
  await update($, noticesAtom, list => pushNotice(list, { tone, title, at, ...(detail ? { detail } : {}) }))
}

/** Clears the info and success notices whose time has passed; writes nothing when none has. */
async function expireDueNotices($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const list = await read($, noticesAtom)
  if (expireNotices(list, now) !== list) await update($, noticesAtom, current => expireNotices(current, now))
}

async function requestRemoval($: EngineInterface, panel: DockPanel): Promise<void> {
  const root = companionRoot(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME')) ?? `~/.claude/skills/${COMPANION_NAME}`
  const paths = { guidePath: `${$.plugin.root}/PANEL_GUIDE.md`, companionRoot: root }
  const filled = await $.prompt.fill({ text: buildRemovePanelPrompt(panel, paths) })
  if (filled.isFilled) await notify($, 'success', READY_NOTICE)
  else await notify($, 'error', 'The prompt box did not take the prompt.')
}

/** Tells the person once about the built-in panels that are new or changed since they last heard, then keeps the record. */
async function announcePanelNews($: EngineInterface, knownIds: readonly string[]): Promise<void> {
  const seen = renameSeen(readSeen(await $.store.get(SEEN_STORE_KEY).catch(() => undefined)), PANEL_RENAMES)
  const { notices, record } = panelNews(seen, PANELS, knownIds)
  const at = await $.clock.now()
  for (const notice of notices) await update($, noticesAtom, list => pushNotice(list, { ...notice, at }))
  await $.store.set(SEEN_STORE_KEY, record).catch(() => undefined)
}

/** A dock's own control: its top row, its ➕ menu, Manage's Add panel and Remove dock. */
async function runDockPress($: EngineInterface, press: DockPress): Promise<void> {
  const { dockId } = press
  switch (press.action) {
    case 'swap':
      await changeDocks($, layout => swapPosition(layout, dockId))
      return
    case 'menu':
      await changeOwnDock($, dockId, dock => ({ ...dock, isMenuOpen: !dock.isMenuOpen }))
      return
    case 'manage':
      await changeOwnDock($, dockId, dock => showView(dock, dock.view === 'manage' ? 'panels' : 'manage'))
      return
    case 'close':
      await closeDock($, dockId)
      return
    case 'new-right':
    case 'new-bottom':
      await changeDocks($, layout => addDock(layout, press.action === 'new-right' ? 'right' : 'bottom'))
      return
    case 'remove':
      await changeDocks($, layout => removeDock(layout, dockId))
      return
    case 'add-panel':
      await openNewPanel($)
      return
    case 'layout':
      await changeOwnDock($, dockId, dock => ({ ...dock, isLayoutOpen: !dock.isLayoutOpen }))
      return
    case 'add-view':
      await changeOwnDock($, dockId, addView)
      await resetScroll($, dockId)
      return
  }
}

/** A control of one view, named by its key: a view no longer in the dock changes nothing. */
async function runViewActionPress($: EngineInterface, press: ViewActionPress): Promise<void> {
  const { dockId, viewId } = press
  await changeLayout($, layout => {
    const dock = findDock(layout, dockId)
    if (!dock?.views.some(view => view.id === viewId)) return layout
    if (press.action === 'remove-view') return touchDock(removeView(layout, dockId, viewId), dockId)

    return touchDock(changeDock(layout, dockId, current => setDirection(current, viewId, press.action === 'dir-row' ? 'row' : 'column')), dockId)
  })
  if (press.action === 'remove-view') await resetScroll($, dockId)
}

/**
 * A control on a panel's card, Manage row or Layout row in one dock; Remove asks Claude to delete one of the
 * person's own panels.
 */
async function runPanelPress($: EngineInterface, press: PanelPress): Promise<void> {
  const { action, dockId, panelId, viewId } = press
  const width = widthOfAction(action)
  if (width !== undefined && viewId !== undefined) {
    await changeOwnDock($, dockId, dock => setCardWidth(dock, viewId, panelId, width))
  } else if (action === 'drop') {
    const panel = (await registryOf($)).find(one => one.id === panelId)
    if (panel && !panel.isBuiltIn) await requestRemoval($, panel)
    else if (!panel && !BUILT_IN_IDS.includes(panelId)) await changeLayout($, layout => forgetPanel(layout, panelId))
  } else if (action === 'toggle' || action === 'up' || action === 'down' || action === 'enable') {
    await changeOwnDock($, dockId, dock => changePanel(dock, action, panelId, viewId))
  } else if (action === 'settings') {
    // The panel's own hook opens its settings; a minimized card opens so they show.
    await changeOwnDock($, dockId, dock => (activeView(dock).minimized.includes(panelId) ? changePanel(dock, 'toggle', panelId) : dock))
  }
}

/** A view's tab: the dock shows that view. */
async function runViewPress($: EngineInterface, press: ViewPress): Promise<void> {
  await changeOwnDock($, press.dockId, dock => selectView(dock, press.viewId))
  await resetScroll($, press.dockId)
}

/** The name a view's tab shows now, which its rename field holds; none for a view the dock no longer has. */
function shownViewName(dock: DockView, viewId: string, registry: readonly DockPanel[]): string | undefined {
  const view = dock.views.find(one => one.id === viewId)

  return view ? viewName(view, dock.views.indexOf(view), registry) : undefined
}

async function runDockCommand($: EngineInterface, args: string): Promise<string> {
  const action = args.trim().toLowerCase()
  if (action === '') {
    return toggleDock($)
  }
  if (action === 'right' || action === 'bottom') {
    return openDockAt($, action)
  }
  if (action === 'add') {
    await openNewPanel($)

    return 'New panel form open.'
  }
  if (action === 'manage') {
    const dock = lastDock(await readDocks($))
    await openDock($, dock.id, 'manage')

    return `Manage ${dock.name} open.`
  }

  return 'Usage: /dock (open or close the last used dock), /dock right, /dock bottom, /dock add, /dock manage'
}

function panelsOf(ids: readonly string[], registry: readonly DockPanel[]): DockPanel[] {
  return ids.flatMap(id => registry.find(panel => panel.id === id) ?? [])
}

/** One panel's band tab, from its state; a summary that throws shows `?`. */
async function readBandTab($: EngineInterface, panel: DockPanel): Promise<BandTab> {
  try {
    switch (panel.id) {
      case 'branch':
        return bandTab(panel, summarizeBranch(await read($, branchAtom)))
      case 'checks': {
        const checks = await read($, checksAtom)

        return bandTab(panel, summarizeChecks(checks), checksIcon(checks))
      }
      case 'activity':
        return bandTab(panel, summarizeActivity(await read($, activityAtom)))
      case 'jira':
        return bandTab(panel, summarizeJira(await read($, jiraAtom)))
      case 'slacker':
        return bandTab(panel, summarizeSlacker(await read($, slackerAtom)))
      case 'gitgud': {
        const gitgud = await read($, gitgudAtom)

        return bandTab(panel, summarizeGitgud(gitgud), panel.icon, gitgudTabTone(gitgud))
      }
      default:
        return bandTab(panel, await summarizeUserPanel($, panel.id))
    }
  } catch {
    return bandTab(panel, '?')
  }
}

/**
 * The newest notices, one row each: a click opens the whole text under the row, ✕ dismisses it.
 * Errors stay until dismissed; the dock's notice timer clears the rest.
 */
function drawNotices($: EngineInterface, ui: DockElements, list: readonly DockNotice[], columns: number): JSX.Element | null {
  if (list.length === 0) return null
  const { Box, Button, Text } = ui
  const { rows, hidden } = noticeRows(list, columns)

  return (
    <Box flexDirection="column" width={columns}>
      {rows.map(row => (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Button
              key={`dock-notice-${row.id}`}
              plain
              onPress={() => (row.hasMore ? update($, noticesAtom, current => toggleNotice(current, row.id)) : undefined)}
            >
              <Text color={row.color} wrap="truncate-end">
                {row.label}
              </Text>
            </Button>
            {row.action !== undefined && <Button key={row.action.key} plain label={row.action.label} onPress={() => undefined} />}
            <Button
              key={`dock-notice-x-${row.id}`}
              plain
              dimColor
              label="✕"
              onPress={() => update($, noticesAtom, current => dismissNotice(current, row.id))}
            />
          </Box>
          {row.lines.length > 0 && (
            <Box flexDirection="column" paddingLeft={2}>
              {row.lines.map(line => (
                <Text wrap="wrap">{line}</Text>
              ))}
            </Box>
          )}
        </Box>
      ))}
      {drawMore(ui, hidden)}
    </Box>
  )
}

/** One tab per panel some dock shows, then ➕, right-aligned; the panel in view in an open dock underlined. */
async function drawTabRow($: EngineInterface, ui: DockElements, layout: DockLayout, columns: number): Promise<JSX.Element> {
  const { Box, Button, Text } = ui
  const tabs = await Promise.all(panelsOf(bandPanelIds(layout), await registryOf($)).map(panel => readBandTab($, panel)))
  const hiddenPanes = hiddenPaneIds(await listPanes($))
  const fit = fitBand(tabs, columns, ADD_ICON)

  return (
    <Box flexDirection="row" justifyContent="flex-end" columnGap={fit.gap} width={columns}>
      {tabs.map(tab => {
        const label = bandLabel(tab, fit.hasSummaries)

        return (
          <Button key={`dock-tab-${tab.id}`} plain onPress={() => pressTab($, tab.id)}>
            {isTabActive(layout, tab.id, hiddenPanes) ? (
              <Text bold underline color={tab.tone}>
                {label}
              </Text>
            ) : tab.tone !== undefined ? (
              <Text bold color={tab.tone}>
                {label}
              </Text>
            ) : tab.summary === SET_UP_SUMMARY ? (
              <Text dimColor>{label}</Text>
            ) : (
              label
            )}
          </Button>
        )
      })}
      <Button key="dock-tab-add" plain label={ADD_ICON} onPress={() => openNewPanel($)} />
    </Box>
  )
}

/** One panel's card body in a dock, drawn by the panel from its state; a panel that throws costs one dim line. */
async function drawPanelBody($: EngineInterface, e: DockSite, panel: DockPanel, columns: number, dockId: string) {
  const ui = $.ui.resolve(e)
  try {
    switch (panel.id) {
      case 'branch':
        return drawBranch(ui, await read($, branchAtom), columns)
      case 'checks':
        return drawChecks(ui, await read($, checksAtom), columns)
      case 'activity':
        return drawActivity(ui, await read($, activityAtom), columns)
      case 'jira':
        return drawJira(ui, await read($, jiraAtom), columns, e.surface, dockId, prBadgesByKey(await read($, gitgudAtom)))
      case 'slacker':
        return drawSlacker(ui, await read($, slackerAtom), columns, e.surface, dockId)
      case 'gitgud':
        return drawGitgud(ui, await read($, gitgudAtom), columns, e.surface, dockId)
      default:
        return panel.isBuiltIn ? null : await drawUserPanel($, e, panel.id, columns, dockId)
    }
  } catch (error) {
    return drawNote(ui, `${panel.title} failed: ${messageOf(error)}`)
  }
}

/**
 * What a dock's drawing needs: its active view's panels and lines of cards (laid out in `cardColumns`, which the
 * bottom dock's probe column takes one from), the bodies of the cards it shows at their widths, its view tabs,
 * the bottom dock's name.
 */
async function readScene(
  $: EngineInterface,
  e: DockSite,
  layout: DockLayout,
  dock: DockView,
  columns: number,
  cardColumns = columns,
): Promise<DockScene> {
  const view = activeView(dock)
  const registry = await registryOf($)
  const panels = panelsOf(view.panels, registry)
  const loaded = new Set(registry.map(panel => panel.id))
  const lines = cardLines(changeActiveView(dock, one => ({ ...one, panels: one.panels.filter(id => loaded.has(id)) })), cardColumns)
  const strays = view.panels.filter(id => !loaded.has(id))
  const widths = new Map(lines.flat().map(slot => [slot.id, slot.width]))
  const shown = dock.view === 'panels' ? panels.filter(panel => !view.minimized.includes(panel.id)) : []
  const bodies = await Promise.all(
    shown.map(async (panel): Promise<[string, JSX.Element | null]> => {
      const bodyColumns = Math.max(1, widths.get(panel.id) ?? cardColumns)

      return [panel.id, await drawPanelBody($, e, panel, bodyColumns, dock.id)]
    }),
  )
  const bottom = bottomDock(layout)

  return {
    dock,
    panels,
    registry,
    strays,
    lines,
    bodies: new Map(bodies),
    tabs: dock.views.map((one, index) => ({ id: one.id, name: viewName(one, index, registry), isActive: one.id === view.id })),
    ...(bottom && bottom.id !== dock.id ? { bottomName: bottom.name } : {}),
    isLastDock: layout.docks.length === 1,
    columns,
    cardColumns,
  }
}

/** What the bottom dock's frame reads besides the scene: the notices under it and the cards' scroll and measured height. */
interface FrameInput {
  notices: readonly DockNotice[]
  scrolls: Readonly<Record<string, number>>
  measures: Readonly<Record<string, number>>
}

function drawsClientOn(surface: RenderSurface): boolean {
  return surface === 'terminal' || surface === 'desktop'
}

/**
 * The bottom dock's grip and height: the person's rows (else a default) held within what the band leaves it
 * under the notices and the tab row (the engine caps the band at half the terminal, the prompt included).
 * The cards get what is left under the dock's controls and any open menu, scrolled to their measured end at most;
 * the grip starts a drag from the height the dock is drawn at.
 */
function bottomFrame(e: RenderInput<'AbovePrompt'>, scene: DockScene, input: FrameInput, columns: number): BottomFrame {
  const { dock } = scene
  const cap = dockCapRows(e.props.maxRows, noticeRowCount(input.notices, columns) + 1)
  const height = dockHeight(dock.rows, cap)
  const menuRows = openMenuRows(scene)
  const body = bottomBody(height, menuRows)
  const measured = measuredRows(input.measures, e.surface, dock.id)
  const max = maxScrollRow(measured, body.rows)
  const scrollRow = scrollRowOf(input.scrolls, dock.id, max)

  return {
    grip: { base: dock.view === 'panels' ? body.drawnRows : height, min: Math.min(MIN_DOCK_ROWS, cap), max: cap, columns },
    drawsClient: drawsClientOn(e.surface),
    bodyRows: body.rows,
    scrollRow,
    measure: measureProps(dock.id, measured),
    scrollBar: scrollBarProps(dock.id, body.rows, measured, scrollRow, max),
  }
}

/** The band above the prompt: the bottom dock while it is open, the newest notices, then the tabs. */
async function renderBand($: EngineInterface, e: RenderInput<'AbovePrompt'>): Promise<JSX.Element> {
  const layout = await readDocks($)
  const columns = Math.max(1, e.props.bodyColumns)
  const ui = $.ui.resolve(e)
  const { Box } = ui
  const bottom = bottomDock(layout)
  const noticeList = await read($, noticesAtom)
  const probeColumns = bottom?.view === 'panels' && drawsClientOn(e.surface) ? MEASURE_COLUMNS + SCROLLBAR_COLUMNS : 0
  const scene = bottom?.isOpen ? await readScene($, e, layout, bottom, columns, Math.max(1, columns - probeColumns)) : undefined
  const frame = scene
    ? bottomFrame(e, scene, { notices: noticeList, scrolls: await read($, scrollAtom), measures: await read($, measureAtom) }, columns)
    : undefined
  const dock = scene && frame ? drawBottomDock(ui, { ...scene, bottom: frame }) : null
  const notices = drawNotices($, ui, noticeList, columns)
  const tabRow = await drawTabRow($, ui, layout, columns)
  if (!dock && !notices) return tabRow

  return (
    <Box flexDirection="column" width={columns}>
      {dock}
      {notices}
      {tabRow}
    </Box>
  )
}

/**
 * A right dock's pane: its controls on top, then a card per panel (or the Manage card). vscode and mobile draw
 * no band above the prompt, so their panes show the notices first.
 */
async function renderDock($: EngineInterface, e: RenderInput<'Pane'>): Promise<JSX.Element> {
  const layout = await readDocks($)
  const ui = $.ui.resolve(e)
  const { Box } = ui
  const columns = Math.max(1, e.props.bodyColumns)
  const dock = findDock(layout, dockIdOfPane(e.requestId))
  const content =
    dock?.position === 'right'
      ? drawRightDock(ui, await readScene($, e, layout, dock, columns))
      : drawNote(ui, 'This dock moved to the bottom or was removed.')
  const hasNoBand = e.surface === 'vscode' || e.surface === 'mobile'
  const notices = hasNoBand ? drawNotices($, ui, await read($, noticesAtom), columns) : null

  return (
    <Box flexDirection="column" width={columns}>
      {notices && <Box marginBottom={1}>{notices}</Box>}
      {content}
    </Box>
  )
}

/** The docks' own hooks: /dock, the band above the prompt, the right docks' panes and every dock's controls. */
export function registerDockHooks(on: On): void {
  // A reload of the mod runs this again: the layout the session holds is kept, never reset.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await $.command.register({
      name: 'dock',
      description: 'Docks of panels: open or close the last used dock, open one on the right or at the bottom, add or manage panels',
      argumentHint: '[right|bottom|add|manage]',
    })
    const held = await $.state.get({ plugin: 'claudedockula', key: 'layout' })
    const openPanes = (await listPanes($)).map(pane => pane.id)
    const stored = held.version > 0 ? undefined : await $.store.get(LAYOUT_STORE_KEY)
    const listed = readPackPanels(await $.dockula.panels().catch(() => []), BUILT_IN_IDS).panels
    await update($, userPanelsAtom, () => listed)
    const ids = await panelIdsOf($)
    // Before the layout below records every panel as known: an opt-in one not known yet is what gets announced.
    const startLayout = renamePanelIds(readLayout(held.version > 0 ? await read($, layoutAtom) : stored))
    await announcePanelNews($, startLayout.known)
    const layout = await update($, layoutAtom, current =>
      held.version > 0
        ? reconcileLayout(renamePanelIds(readLayout(current)), ids, openPanes, BUILT_IN_IDS, OPT_IN_IDS)
        : restoreLayout(startLayout, ids, BUILT_IN_IDS, OPT_IN_IDS),
    )
    if (held.version === 0 && Object.keys(await read($, scrollAtom)).length > 0) await update($, scrollAtom, () => ({}))
    // A pane left open across a reload keeps the width and title of the code that opened it; one whose dock
    // moved to the bottom or is gone closes.
    for (const paneId of openPanes) {
      const dock = findDock(layout, dockIdOfPane(paneId))
      if (dock?.position === 'right') await $.ui.open(dockOpenArgs(dock)).catch(() => undefined)
      else if (dockIdOfPane(paneId) !== undefined) await $.ui.close({ id: paneId }).catch(() => undefined)
    }
    // A reload drops timers with the old code: the sweeper starts again with the new.
    noticeSweeper?.cancel()
    noticeSweeper = $.clock.every(NOTICE_SWEEP_MS, () => void expireDueNotices($))

    return next(e)
  })

  on('command.run', { command: 'dock' }, async ($, e) => ({ text: await runDockCommand($, e.args) }))

  // A survey holds the band: no dock is drawn there.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => (e.props.hasSurvey ? next(e) : renderBand($, e)))

  on('ui.render', { component: 'Pane', requestId: /^claudedockula(-\d+)?$/ }, ($, e) => renderDock($, e))

  // Every dock control: `dock-<dockId>-<action>`, with `-<panelId>` for a card's, a Manage row's or a width's,
  // `-<viewId>` for a view's tab.
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(main|\d+)-/ }, async ($, e) => {
    const press = parseDockKey(e.element)
    if (press && 'panelId' in press) await runPanelPress($, press)
    else if (press && 'viewId' in press && press.action === 'view') await runViewPress($, press)
    else if (press && 'viewId' in press) await runViewActionPress($, press)
    else if (press) await runDockPress($, press)

    return { element: e.element }
  })

  on('ui.input', { plugin: 'claudedockula', element: NAME_INPUT, kind: 'submit' }, async ($, e) => {
    const [, dockId] = NAME_INPUT.exec(e.element) ?? []
    if (dockId) await changeDocks($, layout => touchDock(renameDock(layout, dockId, e.value), dockId))

    return { element: e.element, value: e.value }
  })

  on('ui.input', { plugin: 'claudedockula', element: VIEW_NAME_INPUT, kind: 'submit' }, async ($, e) => {
    const [, dockId, viewId] = VIEW_NAME_INPUT.exec(e.element) ?? []
    if (dockId && viewId) {
      const registry = await registryOf($)
      await changeOwnDock($, dockId, dock => {
        const shown = shownViewName(dock, viewId, registry)

        return shown === undefined ? dock : renameView(dock, viewId, e.value, shown)
      })
    }

    return { element: e.element, value: e.value }
  })

  // The bottom dock's grip posts the height the person dragged it to.
  on('ui.message', { element: GRIP }, async ($, e) => {
    const [, dockId] = GRIP.exec(e.element) ?? []
    const rows = parseResizeMessage(e.data)
    if (dockId && rows !== undefined) {
      const height = Math.max(MIN_DOCK_ROWS, rows)
      await changeOwnDock($, dockId, dock => ({ ...dock, rows: height }))
    }

    return {}
  })

  // The probe beside the bottom dock's cards posts their height; the answer hands it that height at once, so it
  // never posts the same one twice.
  on('ui.message', { element: MEASURE }, async ($, e) => {
    const [, dockId] = MEASURE.exec(e.element) ?? []
    const measured = parseMeasureMessage(e.data)
    if (!dockId || measured?.dockId !== dockId) return {}
    await storeMeasure($, e.surface, dockId, measured.rows)

    return { props: measureProps(dockId, measured.rows) }
  })

  // The scrollbar beside the bottom dock's cards posts a move: rows from where they are, or the row to land on.
  on('ui.message', { element: SCROLLBAR }, async ($, e) => {
    const [, dockId] = SCROLLBAR.exec(e.element) ?? []
    const move = parseScrollMessage(e.data)
    if (!dockId || !move) return {}
    const scrolls = await read($, scrollAtom)
    const scrollTo = (current: Readonly<Record<string, number>>) =>
      'by' in move ? scrolledBy(current, dockId, move.by, move.max) : withScrollRow(current, dockId, Math.min(move.max, move.to))
    if (scrollTo(scrolls) !== scrolls) await update($, scrollAtom, scrollTo)

    return {}
  })

  on('ui.close', { id: /^claudedockula(-\d+)?$/ }, async ($, e, next) => {
    const closed = await next(e)
    const dockId = dockIdOfPane(e.id)
    if (dockId) {
      await changeLayout($, layout => changeDock(layout, dockId, dock => (dock.position === 'right' ? closeView(dock) : dock)))
    }

    return closed
  }).catch(($, e, next) => next(e))

  // The last open sets the docks' shared width, so the docks take theirs back after the form closes.
  on('ui.close', { id: 'claudedockula-new' }, async ($, e, next) => {
    const closed = await next(e)
    const dock = lastOpenRightDock(await readDocks($))
    if (dock) {
      await $.ui.open(dockOpenArgs(dock))
    }

    return closed
  }).catch(($, e, next) => next(e))
}
