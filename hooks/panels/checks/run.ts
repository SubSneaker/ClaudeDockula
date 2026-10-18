import type { CheckRun, ChecksState } from '../../../types'
import { formatDuration, type CheckSummary } from './summary'

export interface CheckDefinition {
  id: string
  name: string
  /** The command and its arguments, run in the session's folder with no shell. */
  argv: readonly string[]
}

/** How one check of a Run all ended. */
export interface CheckResult {
  name: string
  isPassed: boolean
  problem?: string
}

export function withRun(state: ChecksState, id: string, run: CheckRun): ChecksState {
  return { ...state, runs: { ...state.runs, [id]: run } }
}

export function toggleExpanded(state: ChecksState, id: string): ChecksState {
  const expanded = state.expanded ?? []

  return { ...state, expanded: expanded.includes(id) ? expanded.filter(one => one !== id) : [...expanded, id] }
}

/** After a reload: a run the previous copy of the module started never reports back. */
function interrupted(run: CheckRun): CheckRun {
  return run.status === 'running' ? { status: 'failed', problem: 'interrupted by a reload' } : run
}

export function withRunsInterrupted(state: ChecksState): ChecksState {
  const runs: Record<string, CheckRun> = {}
  for (const [id, run] of Object.entries(state.runs ?? {})) runs[id] = interrupted(run)

  return { ...state, runs, isRunningAll: false }
}

/** `Types failed: 3 errors`, `Lint passed in 42s`. */
export function describeFinish(name: string, summary: CheckSummary, durationMs: number): string {
  if (summary.isPassed) return `${name} passed in ${formatDuration(durationMs)}`

  return `${name} failed: ${summary.problem ?? 'see the Checks panel'}`
}

/** `All 4 checks passed`, `2 of 4 checks failed: Types, Format`. */
export function describeRunAll(results: CheckResult[]): string {
  const failed = results.filter(result => !result.isPassed).map(result => result.name)
  if (failed.length === 0) return `All ${results.length} checks passed`

  return `${failed.length} of ${results.length} checks failed: ${failed.join(', ')}`
}

/** The Run all notice's detail: one line per failed check, `Types: 3 errors`. */
export function describeRunAllFailures(results: CheckResult[]): string {
  return results
    .filter(result => !result.isPassed)
    .map(result => `${result.name}: ${result.problem ?? 'failed'}`)
    .join('\n')
}
