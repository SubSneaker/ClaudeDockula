import type { SlackerItem, SlackerSettings, SlackerSource } from '../../../types'
import { FEED_DAYS } from './feed'

// Pure settings logic: the choices, reading what was stored, and what a change does. No `$` here.

export const STORE_SETTINGS = 'slacker:settings'
export const DEFAULT_REFRESH_SECONDS = 30
export const SOURCES: readonly SlackerSource[] = ['mention', 'dm', 'thread']
export const SOURCE_LABEL: Record<SlackerSource, string> = { mention: 'Mentions', dm: 'DMs', thread: 'Thread replies' }
export const REFRESH_CHOICES = [
  { seconds: 30, label: '30 s' },
  { seconds: 60, label: '1 min' },
  { seconds: 300, label: '5 min' }
] as const
export const DAYS_CHOICES = [
  { days: 7, label: '7 days' },
  { days: 3, label: '3 days' },
  { days: 1, label: '1 day' }
] as const

/**
 * The stored settings, keeping only values the choices allow.
 * @example
 * // { sources: ['dm', 'x'], refreshSeconds: 45, days: 3 } → { sources: ['dm'], days: 3 }
 */
export function parseSlackerSettings(raw: unknown): SlackerSettings {
  if (typeof raw !== 'object' || raw === null) return {}
  const settings: SlackerSettings = {}
  if ('sources' in raw && Array.isArray(raw.sources)) {
    const saved: unknown[] = raw.sources
    const sources = SOURCES.filter(source => saved.includes(source))
    if (sources.length > 0) settings.sources = sources
  }
  if ('refreshSeconds' in raw && REFRESH_CHOICES.some(choice => choice.seconds === raw.refreshSeconds)) settings.refreshSeconds = Number(raw.refreshSeconds)
  if ('days' in raw && DAYS_CHOICES.some(choice => choice.days === raw.days)) settings.days = Number(raw.days)

  return settings
}

/** The sources read: the saved ones, else all. */
export function sourcesOf(settings: SlackerSettings | undefined): readonly SlackerSource[] {
  return settings?.sources && settings.sources.length > 0 ? settings.sources : SOURCES
}

export function refreshMsOf(settings: SlackerSettings | undefined): number {
  return (settings?.refreshSeconds ?? DEFAULT_REFRESH_SECONDS) * 1000
}

export function daysOf(settings: SlackerSettings | undefined): number {
  return settings?.days ?? FEED_DAYS
}

/** One source flipped; the last one on stays on. */
export function toggleSource(settings: SlackerSettings, source: SlackerSource): SlackerSettings {
  const on = sourcesOf(settings)
  if (!on.includes(source)) return { ...settings, sources: SOURCES.filter(one => one === source || on.includes(one)) }
  if (on.length === 1) return settings

  return { ...settings, sources: on.filter(one => one !== source) }
}

/** Feed rows that came from a source still on; watched words and searches always stay. */
export function keepSources(items: readonly SlackerItem[], settings: SlackerSettings | undefined): SlackerItem[] {
  const on = sourcesOf(settings)

  return items.filter(item => item.kind === 'keyword' || item.kind === 'search' || on.includes(item.kind))
}
