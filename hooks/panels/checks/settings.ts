import type { ChecksSettings } from '../../../types'

/** Where the panel-wide settings live in the store (the checks themselves are per repo). */
export const CHECKS_SETTINGS_KEY = 'checks:settings'

/** The engine stops `$.process.run` at 10 minutes, so that is the longest limit on offer. */
export const TIME_LIMIT_MINUTES = [5, 10] as const
export const DEFAULT_TIME_LIMIT_SECONDS = 600

/** The run limit in ms, 10 minutes unless the person chose another. */
export function timeLimitMs(settings: ChecksSettings | undefined): number {
  return (settings?.timeLimitSeconds ?? DEFAULT_TIME_LIMIT_SECONDS) * 1000
}

/** Whether a single run's end posts a notice; on unless turned off. */
export function isNoticeOn(settings: ChecksSettings | undefined): boolean {
  return settings?.isNoticeOnFinish !== false
}

/**
 * The saved panel settings, checked; a value that is not one of the choices counts as not set.
 * @example
 * // before: { timeLimitSeconds: 300, isNoticeOnFinish: false, extra: 1 }  /  { timeLimitSeconds: 7 }
 * // after:  { timeLimitSeconds: 300, isNoticeOnFinish: false }  /  {}
 */
export function parseChecksSettings(raw: unknown): ChecksSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const settings: ChecksSettings = {}
  if ('timeLimitSeconds' in raw && TIME_LIMIT_MINUTES.some(minutes => minutes * 60 === raw.timeLimitSeconds)) {
    if (typeof raw.timeLimitSeconds === 'number') settings.timeLimitSeconds = raw.timeLimitSeconds
  }
  if ('isNoticeOnFinish' in raw && typeof raw.isNoticeOnFinish === 'boolean') settings.isNoticeOnFinish = raw.isNoticeOnFinish

  return settings
}
