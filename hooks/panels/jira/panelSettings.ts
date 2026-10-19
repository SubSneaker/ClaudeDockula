import type { JiraPanelSettings } from '../../../types'

/** Where the panel's own settings live in the store, apart from the shared `settings` blob. */
export const JIRA_PANEL_SETTINGS_KEY = 'jira:settings'

export const REFRESH_CHOICES = [60, 120, 300] as const
export const DEFAULT_REFRESH_SECONDS = 120

/** How often the assigned list refreshes, in ms. */
export function listRefreshMs(settings: JiraPanelSettings | undefined): number {
  return (settings?.listRefreshSeconds ?? DEFAULT_REFRESH_SECONDS) * 1000
}

/**
 * The saved panel settings, checked; a value that is not one of the choices counts as not set.
 * @example
 * // before: { listRefreshSeconds: 300, extra: 1 }  /  { listRefreshSeconds: 7 }
 * // after:  { listRefreshSeconds: 300 }  /  {}
 */
export function parseJiraPanelSettings(raw: unknown): JiraPanelSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  if (!('listRefreshSeconds' in raw)) return {}
  const seconds = REFRESH_CHOICES.find(choice => choice === raw.listRefreshSeconds)

  return seconds === undefined ? {} : { listRefreshSeconds: seconds }
}
