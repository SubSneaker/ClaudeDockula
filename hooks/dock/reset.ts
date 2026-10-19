import type { DockLayout, DockView } from '../../types'
import { DEFAULT_LAYOUT, withKnownPanels } from './layout'

// Reset, pure: the layout a new install gets, and which stored keys a full reset deletes.

/** Store keys a full reset keeps: the layout it just wrote, the migration marker, and the files GitGud listed. */
export const KEPT_STORE_KEYS: readonly string[] = ['layout', 'gitgud:migrated', 'gitgud:docs']

/**
 * What a new install holds: every panel but the opt-in ones in the main dock, which is open so the person
 * keeps seeing a dock.
 * @example
 * // before: docks main (closed), 2 (open, right), a bottom dock; Slacker ticked
 * // after:  one dock `main`, open on its panels, Branch, Checks, Activity and GitGud; Jira and Slacker unticked
 */
export function resetLayout(ids: readonly string[], builtInIds: readonly string[], optInIds: readonly string[]): DockLayout {
  const fresh = withKnownPanels(DEFAULT_LAYOUT, ids, builtInIds, optInIds)

  return { ...fresh, docks: fresh.docks.map(dock => (dock.id === fresh.lastDockId ? { ...dock, isOpen: true, view: 'panels' } : dock)) }
}

/** The opt-in panels some view of the layout shows. */
export function placedOptIns(layout: DockLayout, optInIds: readonly string[]): string[] {
  const shown = layout.docks.flatMap(dock => dock.views.flatMap(view => view.panels))

  return optInIds.filter(id => shown.includes(id))
}

/**
 * The stored keys a full reset deletes: every key but the kept ones.
 * @example
 * // before: ['layout', 'settings', 'settings:/repo', 'gitgud:docs', 'slacker:keywords']
 * // after:  ['settings', 'settings:/repo', 'slacker:keywords']
 */
export function keysToClear(keys: readonly string[], keep: readonly string[] = KEPT_STORE_KEYS): string[] {
  return keys.filter(key => !keep.includes(key))
}

/** The layout asking `dockId` to confirm a reset; no other dock keeps a question open. */
export function askReset(layout: DockLayout, dockId: string, confirm: NonNullable<DockView['confirm']>): DockLayout {
  return { ...layout, docks: layout.docks.map(({ confirm: _confirm, ...dock }) => (dock.id === dockId ? { ...dock, confirm } : dock)) }
}

/** The layout with no reset question open. */
export function dropConfirms(layout: DockLayout): DockLayout {
  return { ...layout, docks: layout.docks.map(({ confirm: _confirm, ...dock }) => dock) }
}

export function hasConfirm(layout: DockLayout): boolean {
  return layout.docks.some(dock => dock.confirm !== undefined)
}
