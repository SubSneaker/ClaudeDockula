import type { BranchSettings, BranchWorktree } from '../../../types'

export const BRANCH_SETTINGS_KEY = 'branch:settings'

export const REFRESH_CHOICES = [20, 60, 300] as const
export const FILES_CHOICES = [5, 10] as const
export const DEFAULT_REFRESH_SECONDS = 20
export const DEFAULT_FILES_SHOWN = 5

const REFRESH_LABELS: Record<number, string> = { 20: '20 s', 60: '1 min', 300: '5 min' }

/** `20 s`, `1 min`, `5 min`. */
export function describeRefresh(seconds: number): string {
  return REFRESH_LABELS[seconds] ?? `${seconds} s`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The store value as a plain record, so a field can be changed without losing the others. */
export function asRecord(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? { ...raw } : {}
}

/**
 * The saved settings, keeping only values the panel offers.
 * @example
 * // before: { refreshSeconds: 45, filesShown: 10, isUntrackedShown: false, other: 1 }
 * // after:  { filesShown: 10, isUntrackedShown: false }
 */
export function parseBranchSettings(raw: unknown): BranchSettings {
  if (!isRecord(raw)) return {}
  const { refreshSeconds, filesShown, isUntrackedShown, isWorktreesShown } = raw

  return {
    ...(REFRESH_CHOICES.some(choice => choice === refreshSeconds) && typeof refreshSeconds === 'number' ? { refreshSeconds } : {}),
    ...(FILES_CHOICES.some(choice => choice === filesShown) && typeof filesShown === 'number' ? { filesShown } : {}),
    ...(typeof isUntrackedShown === 'boolean' ? { isUntrackedShown } : {}),
    ...(typeof isWorktreesShown === 'boolean' ? { isWorktreesShown } : {})
  }
}

const CHOICE_KEY = /^branch-set-(refresh|files|untracked|worktrees)-(\w+)$/

/**
 * The settings after one choice button was pressed; undefined when the key is not a choice.
 * @example
 * // before: {}, 'branch-set-refresh-60'
 * // after:  { refreshSeconds: 60 }
 */
export function withBranchChoice(settings: BranchSettings, element: string): BranchSettings | undefined {
  const [, field, value = ''] = CHOICE_KEY.exec(element) ?? []
  const number = Number(value)
  if (field === 'refresh' && REFRESH_CHOICES.some(choice => choice === number)) return { ...settings, refreshSeconds: number }
  if (field === 'files' && FILES_CHOICES.some(choice => choice === number)) return { ...settings, filesShown: number }
  if (field === 'untracked' && (value === 'show' || value === 'hide')) return { ...settings, isUntrackedShown: value === 'show' }
  if (field === 'worktrees' && (value === 'show' || value === 'hide')) return { ...settings, isWorktreesShown: value === 'show' }

  return undefined
}

/**
 * Reads `git worktree list --porcelain` into worktrees; the current one is the deepest that holds `cwd`.
 * @example
 * // before: 'worktree /r/main\nHEAD abc\nbranch refs/heads/develop\n\nworktree /r/wt\nHEAD def\ndetached\n', '/r/wt/src'
 * // after:  [{ path: '/r/main', branch: 'develop', isCurrent: false },
 * //          { path: '/r/wt', isDetached: true, isCurrent: true }]
 */
export function parseWorktrees(stdout: string, cwd: string): BranchWorktree[] {
  const worktrees: BranchWorktree[] = []
  let current: BranchWorktree | undefined

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), isCurrent: false }
      worktrees.push(current)
    } else if (current === undefined) continue
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    else if (line === 'bare') current.isBare = true
    else if (line === 'detached') current.isDetached = true
    else if (line === 'locked' || line.startsWith('locked ')) current.isLocked = true
  }

  const holders = worktrees.filter(one => cwd === one.path || cwd.startsWith(`${one.path}/`))
  const deepest = holders.reduce<BranchWorktree | undefined>((best, one) => (best === undefined || one.path.length > best.path.length ? one : best), undefined)

  return worktrees.map(one => (one === deepest ? { ...one, isCurrent: true } : one))
}
