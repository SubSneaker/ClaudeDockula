/**
 * One card of the dock, listed in PANELS (./index.ts): metadata only. A panel's file also exports
 * `register<Id>Hooks(on)` (called in `registerPanelHooks`), a pure `draw<Id>(ui, state, columns)` for
 * its card and a pure `summarize<Id>(state)` for its band tab, which hooks/dock/DockPane.tsx calls;
 * see PANEL_GUIDE.md. The person's own panels come through `$.dockula.panels` with `isBuiltIn: false`.
 */
export interface DockPanel {
  /** Letters, digits and `-`; also the panel's key under `'claudedockula'` in types/index.d.ts. */
  id: string
  title: string
  /** One emoji (two cells wide), drawn on the band tab and the card's header. */
  icon: string
  /** One line, shown in Manage panels. */
  description: string
  isBuiltIn: boolean
  /** A built-in panel that joins no dock by itself when first seen: it is listed unticked in ⚙ Manage and the person ticks it in. */
  isOptIn?: boolean
  /** Starts at 1; bump it whenever a built-in panel changes in a way its users should hear about. */
  revision?: number
  /** One short line saying what the latest revision changed; required when `revision` is above 1. */
  whatsNew?: string
  /**
   * The card's header shows ⚙ beside its header toggle (`dock-<dockId>-settings-<id>`). The dock expands the card;
   * the panel's own `ui.press` hook on that key, after `next(e)`, opens or closes its settings in its body.
   */
  hasSettings?: boolean
}
