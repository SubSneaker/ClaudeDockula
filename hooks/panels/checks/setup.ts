import type { CheckSetting, ChecksSetup } from '../../../types'

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm'

/** The scripts offered when a package.json has them, in the order they are listed. */
const SUGGESTED_SCRIPTS = ['lint', 'typecheck', 'types', 'tsc', 'test', 'format', 'format:check', 'build']
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun']
]

/**
 * The package manager a folder uses, from the lockfiles it holds; npm when none.
 * @example
 * // before: ['package.json', 'pnpm-lock.yaml', 'src']
 * // after:  'pnpm'
 */
export function detectPackageManager(fileNames: readonly string[]): PackageManager {
  return LOCKFILES.find(([file]) => fileNames.includes(file))?.[1] ?? 'npm'
}

/** `format:check` → `Format check`. */
function scriptTitle(script: string): string {
  const spaced = script.replace(/[:_-]+/g, ' ')

  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`
}

function scriptNames(packageJson: string | undefined): string[] {
  if (packageJson === undefined) return []
  try {
    const parsed: unknown = JSON.parse(packageJson)
    const scripts = typeof parsed === 'object' && parsed !== null && 'scripts' in parsed ? parsed.scripts : undefined
    if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return []

    return Object.keys(scripts)
  } catch {
    return []
  }
}

/**
 * The checks a package.json suggests: the scripts that lint, type-check, test, format or build, run through the
 * package manager.
 * @example
 * // before: '{"scripts":{"dev":"next","lint":"eslint .","test":"vitest"}}', 'pnpm'
 * // after:  [{ id: 'lint', name: 'Lint', argv: ['pnpm', 'run', 'lint'] }, { id: 'test', name: 'Test', argv: ['pnpm', 'run', 'test'] }]
 */
export function suggestChecks(packageJson: string | undefined, manager: PackageManager): CheckSetting[] {
  const names = scriptNames(packageJson)

  return SUGGESTED_SCRIPTS.filter(script => names.includes(script)).map(script => ({
    id: script.replace(/[^a-z0-9]+/g, '-'),
    name: scriptTitle(script),
    argv: [manager, 'run', script]
  }))
}

/** `lint · pnpm run lint`, as an option's label. */
export function describeCheckOption(check: CheckSetting): string {
  return `${check.name.toLowerCase()} · ${check.argv.join(' ')}`
}

export interface ParsedCheckCommand {
  name: string
  argv: string[]
}

/**
 * Reads `name: command args`; without a name (a colon followed by a space) the command's first word names it.
 * The command is split on whitespace and run with no shell.
 * @example
 * // before: 'Types: pnpm exec tsc --noEmit'  /  'pnpm run format:check'
 * // after:  { name: 'Types', argv: ['pnpm', 'exec', 'tsc', '--noEmit'] }  /  { name: 'pnpm', argv: ['pnpm', 'run', 'format:check'] }
 */
export function parseCheckCommand(text: string): ParsedCheckCommand | undefined {
  const named = /^([^:]+):\s+(.+)$/.exec(text.trim())
  const command = (named?.[2] ?? text).trim()
  const argv = command === '' ? [] : command.split(/\s+/)
  const first = argv[0]
  const name = named?.[1]?.trim() ?? first
  if (first === undefined || !name) return undefined

  return { name, argv }
}

/**
 * An id for a new check: lowercase words from its name, made unique among `taken` (and never `all`, which is Run all).
 * @example
 * // before: 'Unit tests', ['lint', 'unit-tests']
 * // after:  'unit-tests-2'
 */
export function slugCheckId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'check'
  const unreserved = base === 'all' ? 'all-check' : base
  let id = unreserved
  for (let count = 2; taken.includes(id); count += 1) id = `${unreserved}-${count}`

  return id
}

/**
 * The setup form for a repo: its saved checks (ticked) beside the suggestions (not ticked).
 * @example
 * // before: [{ id: 'lint', … }], [{ id: 'lint', … }, { id: 'test', … }]
 * // after:  { options: [lint, test], picked: ['lint'] }
 */
export function buildChecksSetup(
  saved: readonly CheckSetting[] | undefined,
  suggestions: readonly CheckSetting[],
  manager?: PackageManager
): ChecksSetup {
  const kept = saved ?? []
  const isKept = (suggestion: CheckSetting) =>
    kept.some(check => check.id === suggestion.id || check.argv.join(' ') === suggestion.argv.join(' '))
  const options = [...kept, ...suggestions.filter(suggestion => !isKept(suggestion))]

  return { options, picked: kept.map(check => check.id), ...(manager ? { manager } : {}) }
}

export function toggleSetupCheck(setup: ChecksSetup, id: string): ChecksSetup {
  const isPicked = setup.picked.includes(id)

  return { ...setup, picked: isPicked ? setup.picked.filter(one => one !== id) : [...setup.picked, id] }
}

/** Adds a typed command as a ticked option; a blank line adds nothing. */
export function addSetupCheck(setup: ChecksSetup, text: string): ChecksSetup {
  const parsed = parseCheckCommand(text)
  if (!parsed) return setup
  const id = slugCheckId(parsed.name, setup.options.map(option => option.id))

  return { ...setup, options: [...setup.options, { id, ...parsed }], picked: [...setup.picked, id] }
}

/** The checks to save: the ticked options, in the order listed. */
export function pickedChecks(setup: ChecksSetup): CheckSetting[] {
  return setup.options.filter(option => setup.picked.includes(option.id))
}
