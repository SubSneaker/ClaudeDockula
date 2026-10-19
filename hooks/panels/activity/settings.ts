import type { ActivitySettings } from '../../../types'

export const ACTIVITY_SETTINGS_KEY = 'activity:settings'

export const ROWS_CHOICES = [5, 10, 20] as const
export const DEFAULT_ROWS_SHOWN = 5

/**
 * The saved settings, keeping only values the panel offers.
 * @example
 * // before: { rowsShown: 7, isSubagentShown: false }
 * // after:  { isSubagentShown: false }
 */
export function parseActivitySettings(raw: unknown): ActivitySettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const rowsShown: unknown = Reflect.get(raw, 'rowsShown')
  const isSubagentShown: unknown = Reflect.get(raw, 'isSubagentShown')

  return {
    ...(typeof rowsShown === 'number' && ROWS_CHOICES.some(choice => choice === rowsShown) ? { rowsShown } : {}),
    ...(typeof isSubagentShown === 'boolean' ? { isSubagentShown } : {})
  }
}

const CHOICE_KEY = /^activity-set-(rows|subagents)-(\w+)$/

/**
 * The settings after one choice button was pressed; undefined when the key is not a choice.
 * @example
 * // before: {}, 'activity-set-rows-10'
 * // after:  { rowsShown: 10 }
 */
export function withActivityChoice(settings: ActivitySettings, element: string): ActivitySettings | undefined {
  const [, field, value = ''] = CHOICE_KEY.exec(element) ?? []
  const number = Number(value)
  if (field === 'rows' && ROWS_CHOICES.some(choice => choice === number)) return { ...settings, rowsShown: number }
  if (field === 'subagents' && (value === 'show' || value === 'hide')) return { ...settings, isSubagentShown: value === 'show' }

  return undefined
}
