// The two git reads Branch makes, matched whole before any `$.process.run`: a write never matches. Pure.

export const GIT_STATUS = ['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'] as const
export const GIT_WORKTREES = ['git', '--no-optional-locks', 'worktree', 'list', '--porcelain'] as const

function isSameArgv(argv: readonly string[], allowed: readonly string[]): boolean {
  return argv.length === allowed.length && argv.every((part, index) => part === allowed[index])
}

/** Whether `argv` is exactly one of Branch's read-only commands. */
export function isAllowedBranchArgv(argv: readonly string[]): boolean {
  return isSameArgv(argv, GIT_STATUS) || isSameArgv(argv, GIT_WORKTREES)
}
