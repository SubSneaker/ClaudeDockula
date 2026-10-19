import type { Elements, RenderSurface } from 'claude-code'

import type { CardWidth, DockView } from '../../types'
import { type DockPanel } from '../panels/contract'
import {
  CARD_GAP,
  MEASURE_COLUMNS,
  SCROLLBAR_COLUMNS,
  activeView,
  cardKey,
  dockKey,
  gripKey,
  measureClientKey,
  nameKey,
  panelKey,
  scrollBarKey,
  shortLabel,
  viewActionKey,
  viewKey,
  viewNameKey,
  type CardSlot,
  type GripProps,
  type MeasureProps,
  type PanelAction,
  type ScrollBarProps,
  type ViewAction,
} from './layout'
import { cellWidth, drawCard, drawNote, fitEnd, padCells, type DockElements } from './ui'

// A dock's drawing, pure: every Button answers through the dock's `ui.press` hook in DockPane.tsx, which
// reads the dock, the view or the panel and the action back from the key.

export const ADD_ICON = '➕'
/** Below this width a right dock's controls drop their words and keep the glyphs. */
const WORDED_CONTROLS_COLUMNS = 48
/** Cells of a header's `↑ ↓`. */
const MOVE_CONTROL_CELLS = 3
/** A gap's divider: a join under the sections' rules, then bars far past any section's height; its Box clips them. */
const DIVIDER = `┬${'\n│'.repeat(200)}`
const TAB_GAP = 2
const MIN_TAB_CELLS = 4
const ADD_VIEW_LABEL = `${ADD_ICON} View`
/** Rows the open ➕ menu takes: its two lines and the blank row under them. */
const DOCK_MENU_ROWS = 3
/** Rows the open Layout section takes besides its width rows: rule, title, Direction (one row, its label cut) and the blank row under it. */
const LAYOUT_CARD_ROWS = 4
const WIDTH_CHOICES: ReadonlyArray<readonly [CardWidth, string, string]> = [
  ['auto', '[Auto]', 'A'],
  ['third', '[⅓]', '⅓'],
  ['half', '[½]', '½'],
  ['full', '[Full]', 'F'],
]
const DIRECTION_CHOICES: ReadonlyArray<readonly [ViewAction, string, string]> = [
  ['dir-column', '[Column]', 'Col'],
  ['dir-row', '[Row (wraps)]', 'Row'],
]
const DIRECTION_LABEL = 'Direction'

/** One view's tab in a dock's tab row. */
export interface ViewTab {
  id: string
  name: string
  isActive: boolean
}

/** What the bottom dock draws besides its cards: the grip, the height its cards are clipped to and how far they are scrolled. */
export interface BottomFrame {
  grip: GripProps
  drawsClient: boolean
  /** The rows the cards get under the dock's height, less what an open menu takes; 0 hides them. */
  bodyRows: number
  /** How many rows the cards are scrolled, held to their measured end. */
  scrollRow: number
  /** The probe measuring the cards' height, drawn where a `Client` is. */
  measure: MeasureProps
  /** The scrollbar beside the clipped cards, drawn where a `Client` is. */
  scrollBar: ScrollBarProps
}

/** What one dock's drawing needs, gathered by the dock's render hook. */
export interface DockScene {
  dock: DockView
  /** The active view's panels in its order. */
  panels: readonly DockPanel[]
  /** Every panel there is, for the Manage view's checkboxes. */
  registry: readonly DockPanel[]
  /** Panel ids the active view holds whose pack does not list them now: Manage offers to remove them. */
  strays: readonly string[]
  /** The active view's cards in lines, each at its width (cardLines in layout.ts). */
  lines: readonly CardSlot[][]
  /** Each shown panel's card body by id, drawn at its card's width; absent while minimized. */
  bodies: ReadonlyMap<string, JSX.Element | null>
  tabs: readonly ViewTab[]
  /** The bottom dock's name when there is one other than this dock: no second can be added. */
  bottomName?: string
  isLastDock: boolean
  columns: number
  /** Columns the cards are laid out in: `columns` less the measure probe and scrollbar beside a bottom dock's cards. */
  cardColumns: number
  bottom?: BottomFrame
}

/** A plain Button showing a choice or a state: bold and underlined while on, dim while off when `isDim`. */
function controlButton(ui: DockElements, key: string, label: string, isOn: boolean, isDim = false): JSX.Element {
  const { Button, Text } = ui

  return (
    <Button key={key} plain onPress={() => undefined}>
      <Text bold={isOn} underline={isOn} dimColor={isDim && !isOn}>
        {label}
      </Text>
    </Button>
  )
}

/** `⇄ ▤ ⚙ ➕ ✕`, with their words where there is room: swap sides, the view's layout, Manage, the dock menu, close. */
function drawControls(ui: DockElements, dock: DockView, isWorded: boolean): JSX.Element[] {
  const { Button } = ui
  const isManaging = dock.view === 'manage'
  const side = dock.position === 'right' ? 'Bottom' : 'Right'
  const words = isWorded
    ? { swap: `⇄ ${side}`, layout: '▤ Layout', manage: isManaging ? '✓ Done' : '⚙ Manage', menu: `${ADD_ICON} Dock`, close: '✕ Close' }
    : { swap: '⇄', layout: '▤', manage: isManaging ? '✓' : '⚙', menu: ADD_ICON, close: '✕' }
  const pressed = () => undefined

  return [
    <Button key={dockKey(dock.id, 'swap')} plain dimColor label={words.swap} onPress={pressed} />,
    controlButton(ui, dockKey(dock.id, 'layout'), words.layout, dock.isLayoutOpen === true),
    <Button key={dockKey(dock.id, 'manage')} plain label={words.manage} onPress={pressed} />,
    <Button key={dockKey(dock.id, 'menu')} plain label={words.menu} onPress={pressed} />,
    <Button key={dockKey(dock.id, 'close')} plain label={words.close} onPress={pressed} />,
  ]
}

/** The ➕ menu under the top row: a new dock on the right, or at the bottom while there is none. */
function drawDockMenu(ui: DockElements, scene: DockScene): JSX.Element {
  const { Box, Button } = ui
  const { dock, bottomName } = scene
  const isBottomTaken = bottomName !== undefined || dock.position === 'bottom'
  const holder = dock.position === 'bottom' ? 'this dock' : (bottomName ?? 'another dock')

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Button key={dockKey(dock.id, 'new-right')} plain label="New dock on the right" onPress={() => undefined} />
      {isBottomTaken ? (
        drawNote(ui, `New dock at the bottom: one fits there, and ${holder} is in it (⇄ swaps)`)
      ) : (
        <Button key={dockKey(dock.id, 'new-bottom')} plain label="New dock at the bottom" onPress={() => undefined} />
      )}
    </Box>
  )
}

/** The view tabs a row has room for, and the views left out of it. */
export interface FittedTabs {
  /** The tabs drawn in order: the view's place in the dock and its label cut to its cells. */
  shown: Array<{ index: number; label: string }>
  /** The places of the views not drawn; empty when every tab fits. */
  hidden: number[]
}

/** The first `count` places, the last swapped for `activeIndex` when that is past them: the active tab is always in. */
function shownPlaces(total: number, count: number, activeIndex: number): number[] {
  const places = Array.from({ length: Math.min(total, count) }, (_, index) => index)

  return activeIndex < count || places.length === 0 ? places : [...places.slice(0, -1), activeIndex]
}

/**
 * The tabs that fit `columns` on one row with `➕ View`: all of them cut to a share of the row, else as many as
 * keep at least four cells each (the active one always) and a `…+n` button for the rest.
 * @example
 * // before: ['🎫 Jira', 'Work things'], 24 columns, active 0
 * // after:  { shown: [{ index: 0, label: '🎫 Jira' }, { index: 1, label: 'Work…' }], hidden: [] }
 * // before: six views, 40 columns, active 5
 * // after:  { shown: views 0 to 2 and 5, hidden: [3, 4] }
 */
export function fitTabs(names: readonly string[], activeIndex: number, columns: number): FittedTabs {
  const addCells = cellWidth(ADD_VIEW_LABEL)
  const total = names.length
  const draw = (count: number): FittedTabs & { cells: number } => {
    const places = shownPlaces(total, count, activeIndex)
    const hidden = Array.from({ length: total }, (_, index) => index).filter(index => !places.includes(index))
    const moreCells = hidden.length > 0 ? cellWidth(moreLabel(hidden.length)) : 0
    const gaps = places.length + (hidden.length > 0 ? 1 : 0)
    const room = columns - addCells - moreCells - TAB_GAP * gaps
    const each = Math.max(places.length > 1 ? MIN_TAB_CELLS : 1, Math.floor(room / Math.max(1, places.length)))
    const shown = places.map(index => ({ index, label: fitEnd(names[index] ?? '', each) }))
    const cells = shown.reduce((sum, tab) => sum + cellWidth(tab.label), 0) + moreCells + addCells + TAB_GAP * gaps

    return { shown, hidden, cells }
  }
  for (let count = total; count > 1; count -= 1) {
    const fitted = draw(count)
    if (fitted.cells <= columns) return fitted
  }

  return draw(Math.min(1, total))
}

function moreLabel(hidden: number): string {
  return `…+${hidden}`
}

/** The view the `…+n` button switches to: the first hidden one after the active, else the first hidden. */
function nextHidden(hidden: readonly number[], activeIndex: number): number | undefined {
  return hidden.find(index => index > activeIndex) ?? hidden[0]
}

/** One tab per view that fits, the active one bold and underlined, `…+n` for the rest, then `➕ View`. */
function drawTabRow(ui: DockElements, scene: DockScene): JSX.Element {
  const { Box, Button } = ui
  const activeIndex = Math.max(
    0,
    scene.tabs.findIndex(tab => tab.isActive),
  )
  const fitted = fitTabs(
    scene.tabs.map(tab => tab.name),
    activeIndex,
    scene.columns,
  )
  const more = scene.tabs[nextHidden(fitted.hidden, activeIndex) ?? -1]

  return (
    <Box flexDirection="row" columnGap={TAB_GAP} width={scene.columns}>
      {fitted.shown.map(({ index, label }) => {
        const tab = scene.tabs[index]

        return tab ? controlButton(ui, viewKey(scene.dock.id, tab.id), label, tab.isActive, true) : null
      })}
      {more && <Button key={viewKey(scene.dock.id, more.id)} plain dimColor label={moreLabel(fitted.hidden.length)} onPress={() => undefined} />}
      <Button key={dockKey(scene.dock.id, 'add-view')} plain dimColor label={ADD_VIEW_LABEL} onPress={() => undefined} />
    </Box>
  )
}

/** ↑ and ↓ for one panel of the view's order; a blank keeps the column where a move is impossible. */
function drawMoves(ui: DockElements, dockId: string, viewId: string, panelId: string, index: number, count: number): JSX.Element[] {
  const { Button, Text } = ui

  return [
    index > 0 ? (
      <Button key={panelKey(dockId, 'up', panelId, viewId)} plain dimColor label="↑" onPress={() => undefined} />
    ) : (
      <Text> </Text>
    ),
    index < count - 1 ? (
      <Button key={panelKey(dockId, 'down', panelId, viewId)} plain dimColor label="↓" onPress={() => undefined} />
    ) : (
      <Text> </Text>
    ),
  ]
}

function activeTabName(scene: DockScene): string {
  return scene.tabs.find(tab => tab.isActive)?.name ?? ''
}

/** The cells of a row of controls drawn side by side with one column between them. */
function rowCells(parts: readonly string[]): number {
  return parts.reduce((sum, part) => sum + cellWidth(part), 0) + parts.length - 1
}

/** How the Layout card words its choices: in full while its widest row fits the card's body, else compact. */
function isLayoutCompact(scene: DockScene, labelCells: number): boolean {
  const direction = rowCells([DIRECTION_LABEL, ...DIRECTION_CHOICES.map(([, full]) => full)])
  const widths = rowCells(['x'.repeat(labelCells), ...WIDTH_CHOICES.map(([, full]) => full)])

  return scene.cardColumns < Math.max(direction, widths)
}

/** The width rows the Layout card draws: one per panel in a Row view, else one note. */
function layoutWidthRows(scene: DockScene): number {
  return activeView(scene.dock).direction === 'row' ? Math.max(1, scene.panels.length) : 1
}

/** The rows an open ➕ menu and Layout card take above the cards, which the bottom dock's body gives up. */
export function openMenuRows(scene: DockScene): number {
  const menu = scene.dock.isMenuOpen === true ? DOCK_MENU_ROWS : 0
  const layout = scene.dock.isLayoutOpen === true ? LAYOUT_CARD_ROWS + layoutWidthRows(scene) : 0

  return menu + layout
}

/** `▤ Layout`: Column or Row (wraps) for the active view, and in a row view each card's width. */
function drawLayoutMenu(ui: DockElements, scene: DockScene): JSX.Element {
  const { Box, Text } = ui
  const { dock, panels } = scene
  const columns = scene.cardColumns
  const view = activeView(dock)
  const isRow = view.direction === 'row'
  const labelCells = Math.min(Math.max(0, ...panels.map(panel => cellWidth(shortLabel(panel)))), Math.floor(columns / 3))
  const isCompact = isLayoutCompact(scene, labelCells)
  const widthRows = panels.map(panel => {
    const chosen = view.widths[panel.id] ?? 'auto'

    return (
      <Box flexDirection="row" columnGap={1}>
        <Text>{padCells(shortLabel(panel), labelCells)}</Text>
        {WIDTH_CHOICES.map(([width, full, compact]) => {
          const action: PanelAction = `width-${width}`

          return controlButton(ui, panelKey(dock.id, action, panel.id, view.id), isCompact ? compact : full, chosen === width, true)
        })}
      </Box>
    )
  })
  let widths: JSX.Element | JSX.Element[] = drawNote(ui, 'Card widths apply in Row (wraps).')
  if (isRow) widths = panels.length === 0 ? drawNote(ui, 'No panels in this view yet.') : widthRows

  return drawCard(ui, {
    key: cardKey(dock.id, 'layout'),
    cells: columns,
    title: `▤ Layout · ${activeTabName(scene)}`,
    body: (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor wrap="truncate-end">
            {DIRECTION_LABEL}
          </Text>
          <Box flexDirection="row" columnGap={1} flexShrink={0}>
            {DIRECTION_CHOICES.map(([action, full, compact]) =>
              controlButton(ui, viewActionKey(dock.id, action, view.id), isCompact ? compact : full, (action === 'dir-row') === isRow, true),
            )}
          </Box>
        </Box>
        <Box flexDirection="column">{widths}</Box>
      </Box>
    ),
  })
}

/** The active view's cards, in lines: one full-width card a line in a column view, side by side in a row view. */
function drawCards(ui: DockElements, scene: DockScene): JSX.Element {
  const { Box, Button, Text } = ui
  const { dock, panels, bodies, lines } = scene
  if (panels.length === 0) {
    return drawNote(ui, 'No panels in this view. Press ⚙ to choose some.')
  }
  const { minimized } = activeView(dock)
  const widths = new Map(lines.flat().map(slot => [slot.id, slot.width]))
  const cards = new Map(
    panels.map((panel, index) => {
      const isMinimized = minimized.includes(panel.id)
      const controlCells = MOVE_CONTROL_CELLS + (panel.hasSettings === true ? cellWidth('⚙') + 1 : 0)
      const room = Math.max(1, (widths.get(panel.id) ?? scene.cardColumns) - controlCells - 1)
      const heading = padCells(`${isMinimized ? '▸' : '▾'} ${panel.icon} ${panel.title}`, room)
      const toggle = (
        <Button key={panelKey(dock.id, 'toggle', panel.id)} plain label={heading} onPress={() => undefined}>
          <Text bold>{heading}</Text>
        </Button>
      )
      const settings = panel.hasSettings === true ? [<Button key={panelKey(dock.id, 'settings', panel.id)} plain dimColor label="⚙" onPress={() => undefined} />] : []
      const card = drawCard(ui, {
        key: cardKey(dock.id, panel.id),
        cells: widths.get(panel.id) ?? scene.cardColumns,
        title: toggle,
        controls: [...settings, ...drawMoves(ui, dock.id, activeView(dock).id, panel.id, index, panels.length)],
        body: isMinimized ? null : (bodies.get(panel.id) ?? null),
      })

      return [panel.id, card]
    }),
  )

  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.map(line => (
        <Box flexDirection="row" columnGap={CARD_GAP} alignItems="flex-start">
          {line.map(slot => (
            <Box width={slot.width} flexShrink={0}>
              {cards.get(slot.id) ?? null}
            </Box>
          ))}
          {dividerOffsets(line).map(left => (
            <Box position="absolute" left={left} top={0} bottom={0} width={CARD_GAP} overflow="hidden">
              <Text dimColor wrap="wrap">
                {DIVIDER}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

/**
 * The column of each gap between two sections side by side on a line.
 * @example
 * // before: [{ id: 'a', width: 49 }, { id: 'b', width: 48 }]
 * // after:  [49]
 */
export function dividerOffsets(line: readonly CardSlot[]): number[] {
  const offsets: number[] = []
  let edge = 0
  line.slice(0, -1).forEach(slot => {
    edge += slot.width
    offsets.push(edge)
    edge += CARD_GAP
  })

  return offsets
}

/** The registry in the view's order: its panels first, then the ones it does not show. */
function manageOrder(scene: DockScene): DockPanel[] {
  const shown = activeView(scene.dock).panels
  const hidden = scene.registry.filter(panel => !shown.includes(panel.id))

  return [...scene.panels, ...hidden]
}

/** The dock's and the view's names in fields, Enter renames; mobile draws no field, so no rename there. */
function drawRenames(ui: Elements[RenderSurface], scene: DockScene): JSX.Element | null {
  if (!('Input' in ui)) return null
  const { Box, Input } = ui
  const { dock } = scene

  return (
    <Box flexDirection="column">
      <Input key={nameKey(dock.id)} label="Dock " value={dock.name} placeholder="Dock name" submitLabel="rename" onSubmit={() => undefined} />
      <Input
        key={viewNameKey(dock.id, activeView(dock).id)}
        label="View "
        value={activeTabName(scene)}
        placeholder="View name (blank: named after its panel)"
        submitLabel="rename"
        onSubmit={() => undefined}
      />
    </Box>
  )
}

/** The view and dock removals the dock allows, and a note for those it does not. */
function drawRemovals(ui: DockElements, scene: DockScene): JSX.Element {
  const { Box, Button } = ui
  const { dock } = scene
  const isLastView = dock.views.length < 2
  let note = ''
  if (isLastView && scene.isLastDock) note = "The last view and the last dock can't be removed"
  else if (isLastView) note = "A dock's last view can't be removed"
  else if (scene.isLastDock) note = "The last dock can't be removed"

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={3}>
        <Button key={dockKey(dock.id, 'add-panel')} plain label={`${ADD_ICON} Add panel`} onPress={() => undefined} />
        {!isLastView && <Button key={viewActionKey(dock.id, 'remove-view', activeView(dock).id)} plain dimColor label="Remove view" onPress={() => undefined} />}
        {!scene.isLastDock && <Button key={dockKey(dock.id, 'remove')} plain dimColor label="Remove dock" onPress={() => undefined} />}
      </Box>
      {note !== '' && drawNote(ui, note)}
    </Box>
  )
}

/** Manage: the names, a checkbox per panel for the active view with ↑ ↓ for the shown ones, Add panel and the removals. */
function drawManage(ui: Elements[RenderSurface], scene: DockScene): JSX.Element {
  const { Box, Button, Text } = ui
  const { dock, panels } = scene
  const viewId = activeView(dock).id
  const rows = manageOrder(scene).map(panel => {
    const index = panels.indexOf(panel)
    const isShown = index >= 0

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Button
            key={panelKey(dock.id, 'enable', panel.id, viewId)}
            plain
            label={`${isShown ? '[x]' : '[ ]'} ${panel.icon} ${panel.title}`}
            onPress={() => undefined}
          />
          <Box flexDirection="row" columnGap={1} flexShrink={0}>
            {isShown && drawMoves(ui, dock.id, viewId, panel.id, index, panels.length)}
            {!panel.isBuiltIn && (
              <Button key={panelKey(dock.id, 'drop', panel.id)} plain dimColor label="Remove" onPress={() => undefined} />
            )}
          </Box>
        </Box>
        <Box paddingLeft={4}>{drawNote(ui, panel.description)}</Box>
      </Box>
    )
  })

  return drawCard(ui, {
    key: cardKey(dock.id, 'manage'),
    cells: scene.columns,
    title: `⚙ Manage · ${activeTabName(scene)}`,
    body: (
      <Box flexDirection="column" rowGap={1}>
        {drawRenames(ui, scene)}
        {drawNote(ui, 'Tick the panels this view shows; ↑ ↓ set their order.')}
        {rows}
        {scene.strays.map(id => (
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Text dimColor wrap="truncate-end">{`${id} (not loaded)`}</Text>
            <Button key={panelKey(dock.id, 'drop', id)} plain dimColor label="Remove" onPress={() => undefined} />
          </Box>
        ))}
        {drawRemovals(ui, scene)}
      </Box>
    ),
  })
}

/**
 * The cards beside a blank column holding the probe: the row stretches the column to the cards' whole height,
 * which the clip around them does not cut, so the probe's region measures it.
 */
function drawMeasuredCards(ui: Elements[RenderSurface], scene: DockScene, frame: BottomFrame): JSX.Element {
  const cards = drawCards(ui, scene)
  if (!frame.drawsClient || !('Client' in ui)) return cards
  const { Box, Client } = ui

  return (
    <Box flexDirection="row" alignItems="stretch" flexShrink={0}>
      <Box flexDirection="column" flexShrink={0}>
        {cards}
      </Box>
      <Box flexDirection="column" width={MEASURE_COLUMNS} flexShrink={0}>
        <Client key={measureClientKey(scene.dock.id)} module="./Measure.tsx" props={frame.measure} width={MEASURE_COLUMNS} flexGrow={1} />
      </Box>
    </Box>
  )
}

/** The scrollbar to the right of the clipped cards: a `Client`, fixed while the cards move. */
function drawScrollBar(ui: Elements[RenderSurface], scene: DockScene, frame: BottomFrame): JSX.Element | null {
  if (!frame.drawsClient || !('Client' in ui)) return null
  const { Box, Client } = ui

  return (
    <Box flexDirection="column" width={SCROLLBAR_COLUMNS} height={frame.bodyRows} flexShrink={0}>
      <Client key={scrollBarKey(scene.dock.id)} module="./ScrollBar.tsx" props={frame.scrollBar} width={SCROLLBAR_COLUMNS} height={frame.bodyRows} />
    </Box>
  )
}

/** The cards clipped to the rows the bottom dock gives them (none when menus leave too few), scrolled by the bar beside them; a right dock's as they are. */
function drawBody(ui: Elements[RenderSurface], scene: DockScene): JSX.Element | null {
  const { Box } = ui
  const frame = scene.bottom
  if (scene.dock.view === 'manage') return drawManage(ui, scene)
  if (frame === undefined) return drawCards(ui, scene)
  if (frame.bodyRows === 0) return null

  return (
    <Box flexDirection="row" height={frame.bodyRows} flexShrink={0}>
      <Box flexDirection="column" height={frame.bodyRows} overflow="hidden" flexShrink={0}>
        <Box flexDirection="column" marginTop={0 - frame.scrollRow} flexShrink={0}>
          {drawMeasuredCards(ui, scene, frame)}
        </Box>
      </Box>
      {drawScrollBar(ui, scene, frame)}
    </Box>
  )
}

/** Under the settings row: the ➕ menu, the view tabs, the Layout menu, then the active view's cards or Manage. */
function drawContent(ui: Elements[RenderSurface], scene: DockScene): JSX.Element {
  const { Box } = ui
  const { dock } = scene

  return (
    <Box flexDirection="column">
      {dock.isMenuOpen && (
        <Box flexDirection="column" marginBottom={1}>
          {drawDockMenu(ui, scene)}
        </Box>
      )}
      {drawTabRow(ui, scene)}
      {dock.isLayoutOpen && drawLayoutMenu(ui, scene)}
      {drawBody(ui, scene)}
    </Box>
  )
}

/** A right dock's pane: the controls on top, the view tabs, then the view's cards or its Manage card. */
export function drawRightDock(ui: Elements[RenderSurface], scene: DockScene): JSX.Element {
  const { Box } = ui

  return (
    <Box flexDirection="column" width={scene.columns}>
      <Box flexDirection="row" justifyContent="flex-end" columnGap={2}>
        {drawControls(ui, scene.dock, scene.columns >= WORDED_CONTROLS_COLUMNS)}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {drawContent(ui, scene)}
      </Box>
    </Box>
  )
}

/** `── 🧭 Bottom ───────…─ `: the bottom dock's name on a rule to `cells`. */
function headerRule(ui: DockElements, name: string, cells: number): JSX.Element {
  const { Text } = ui
  const title = `🧭 ${name}`
  const fill = Math.max(1, cells - cellWidth(title) - 4)

  return (
    <Text wrap="truncate-end">
      <Text dimColor>{'── '}</Text>
      <Text bold>{title}</Text>
      <Text dimColor>{` ${'─'.repeat(fill)}`}</Text>
    </Text>
  )
}

/** Cells the bottom header's glyph controls take, one between each and one before them. */
function headerControlCells(): number {
  const glyphs = ['⇄', '▤', '⚙', ADD_ICON, '✕']

  return glyphs.reduce((sum, glyph) => sum + cellWidth(glyph) + 1, 0)
}

/** The grip on the bottom dock's top edge; a surface with no `Client` draws none. */
function drawGrip(ui: Elements[RenderSurface], scene: DockScene): JSX.Element | null {
  const frame = scene.bottom
  if (!frame?.drawsClient || !('Client' in ui)) return null
  const { Client } = ui

  return <Client key={gripKey(scene.dock.id)} module="./ResizeGrip.tsx" props={frame.grip} width={scene.columns} />
}

/** The bottom dock in the band: the grip, `── 🧭 <name> ──…── ⇄ ▤ ⚙ ➕ ✕`, then the tabs and the view. */
export function drawBottomDock(ui: Elements[RenderSurface], scene: DockScene): JSX.Element {
  const { Box } = ui
  const { columns, dock } = scene

  return (
    <Box flexDirection="column" width={columns}>
      {drawGrip(ui, scene)}
      <Box flexDirection="row" width={columns}>
        <Box flexGrow={1} flexShrink={1}>
          {headerRule(ui, dock.name, columns - headerControlCells())}
        </Box>
        <Box flexDirection="row" columnGap={1} flexShrink={0} marginLeft={1}>
          {drawControls(ui, dock, false)}
        </Box>
      </Box>
      {drawContent(ui, scene)}
    </Box>
  )
}
