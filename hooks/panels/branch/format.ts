import type { BranchStatus } from '../../../types'

/** `↑2 ahead of origin`, `↑2 ahead · ↓1 behind origin`, `Up to date with origin`. */
export function describeUpstream({ upstream, ahead, behind }: BranchStatus): string {
  if (upstream === undefined) return 'No upstream branch'
  if (ahead === undefined || behind === undefined) return `${upstream} is gone`
  const remote = upstream.split('/')[0] ?? upstream
  if (ahead > 0 && behind > 0) return `↑${ahead} ahead · ↓${behind} behind ${remote}`
  if (ahead > 0) return `↑${ahead} ahead of ${remote}`
  if (behind > 0) return `↓${behind} behind ${remote}`

  return `Up to date with ${remote}`
}

/** `1 staged · 2 modified · 3 untracked`, naming only the non-zero counts. */
export function describeCounts({ staged, modified, untracked, conflicted }: BranchStatus): string {
  const parts = [
    conflicted > 0 ? `${conflicted} conflicted` : '',
    staged > 0 ? `${staged} staged` : '',
    modified > 0 ? `${modified} modified` : '',
    untracked > 0 ? `${untracked} untracked` : ''
  ].filter((part) => part !== '')

  return parts.length > 0 ? parts.join(' · ') : 'Working tree clean'
}
