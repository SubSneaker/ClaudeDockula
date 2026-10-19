// The panel's store keys from before it was renamed from `github`, and the plans for moving them. Pure: no `$`.
// Version 1 moved the keys; version 2 gives repos and item ids their host.

import { canonicalItemId, canonicalRepoKey } from './ids'

/** Holds the version of the last move done: 1 moved the keys, 2 added hosts to repos and ids. */
export const MIGRATED_KEY = 'gitgud:migrated'
/** The version a finished migration leaves in `MIGRATED_KEY`. */
export const MIGRATION_VERSION = 2

/** Kept under the new name. */
export const MOVED_KEYS = [
  { from: 'github:settings', to: 'gitgud:settings' },
  { from: 'github:docs', to: 'gitgud:docs' }
] as const

/** Dropped: they rebuild themselves (alerts re-seed, one-liners regenerate, CI reasons are read again). */
export const DROPPED_KEYS = ['github:alerted', 'github:alerted:overlap', 'github:oneliners', 'github:ciwhy'] as const

export interface StoreMigration {
  /** New key → value, only where the old key held something and the new one is still empty. */
  writes: Record<string, unknown>
  /** Every old key, once the writes are in and before the marker. */
  deletes: string[]
}

/**
 * What to write and delete, given the current value of each old and new key. Saved items keep their ids and
 * repos as they were; `planHostMigration` gives them their host.
 * @example
 * // before: { 'github:settings': { isHaikuOn: false } }
 * // after:  { writes: { 'gitgud:settings': { isHaikuOn: false } }, deletes: ['github:settings', 'github:docs', 'github:alerted', …] }
 */
export function planStoreMigration(values: Readonly<Record<string, unknown>>): StoreMigration {
  const writes: Record<string, unknown> = {}
  for (const { from, to } of MOVED_KEYS) {
    if (values[from] !== undefined && values[to] === undefined) writes[to] = values[from]
  }

  return { writes, deletes: [...MOVED_KEYS.map(key => key.from), ...DROPPED_KEYS] }
}

/** Every key the plan may read. */
export const MIGRATION_READ_KEYS: readonly string[] = [MIGRATED_KEY, ...MOVED_KEYS.flatMap(key => [key.from, key.to])]

const SETTINGS_KEY = 'gitgud:settings'
const DOCS_KEY = 'gitgud:docs'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Settings with their followed repos given a host; anything else stays as it was.
 * @example
 * // before: { extraRepos: ['acme/web', 'github.com/acme/api'] }
 * // after:  { extraRepos: ['github.com/acme/web', 'github.com/acme/api'] }
 */
export function hostSettings(settings: unknown): unknown {
  if (!isRecord(settings) || !Array.isArray(settings.extraRepos)) return settings

  return { ...settings, extraRepos: settings.extraRepos.map(repo => (typeof repo === 'string' ? canonicalRepoKey(repo) : repo)) }
}

/**
 * Saved file links with their item ids given a host; a link with no item id stays as it was.
 * @example
 * // before: [{ path: '/d/a.md', itemId: 'acme/web#12' }]
 * // after:  [{ path: '/d/a.md', itemId: 'github.com/acme/web#12' }]
 */
export function hostDocs(docs: unknown): unknown {
  if (!Array.isArray(docs)) return docs

  return docs.map(doc => (isRecord(doc) && typeof doc.itemId === 'string' ? { ...doc, itemId: canonicalItemId(doc.itemId) } : doc))
}

export interface MigrationPlan extends StoreMigration {
  /** What `MIGRATED_KEY` holds once the writes and deletes are in; it is written last so a crash redoes the lot. */
  marker: number
}

function versionOf(values: Readonly<Record<string, unknown>>): number {
  const marker = values[MIGRATED_KEY]

  return typeof marker === 'number' ? marker : 0
}

function isSame(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Version 2, for a store already at version 1: the settings' repos and the saved links' item ids gain `github.com/`.
 * Nothing is written for a value already in the new shape, so a re-run changes nothing.
 */
export function planHostMigration(values: Readonly<Record<string, unknown>>): MigrationPlan {
  const writes: Record<string, unknown> = {}
  if (versionOf(values) >= MIGRATION_VERSION) return { writes, deletes: [], marker: MIGRATION_VERSION }
  for (const [key, rewrite] of [[SETTINGS_KEY, hostSettings], [DOCS_KEY, hostDocs]] as const) {
    const current = values[key]
    const rewritten = rewrite(current)
    if (current !== undefined && !isSame(current, rewritten)) writes[key] = rewritten
  }

  return { writes, deletes: [], marker: MIGRATION_VERSION }
}

/**
 * Everything a start has to do, from the marker's value: version 0 moves the keys and then gives hosts, version 1 only
 * gives hosts, version 2 does nothing.
 */
export function planMigration(values: Readonly<Record<string, unknown>>): MigrationPlan {
  const version = versionOf(values)
  if (version >= MIGRATION_VERSION) return { writes: {}, deletes: [], marker: MIGRATION_VERSION }
  const moved = version < 1 ? planStoreMigration(values) : { writes: {}, deletes: [] }
  const hosted = planHostMigration({ ...values, ...moved.writes, [MIGRATED_KEY]: 1 })

  return { writes: { ...moved.writes, ...hosted.writes }, deletes: moved.deletes, marker: MIGRATION_VERSION }
}
