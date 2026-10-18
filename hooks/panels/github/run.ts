// What the GitHub panel's three wiring files share about running commands: one outcome shape that is never thrown,
// one memory of the `gh` that started, and one limit on how many `gh` commands run at once. Pure: no `$`; each
// wiring file keeps its own small runner that calls the engine and builds on these.
import { errorText } from '../jira/servers'
import { GH_CANDIDATES } from './argv'
import { GH_CONCURRENCY } from './model'

/** What a command gave back. */
export interface RunOutcome {
  exitCode: number
  stdout: string
  stderr: string
  /** The engine kept only the first part of stdout. */
  isStdoutTruncated?: boolean
}

/** The exit code of a command that never finished: refused by the guard, timed out or failed to spawn. */
export const NOT_RUN = -1
/** The exit code of a `gh` that is not at that path, so the next install folder is tried. */
export const NOT_STARTED = -2
export const GH_TIMEOUT_MS = 20_000
const NO_SUCH_FILE = /no such file|not found|enoent/i

export function refusedRun(argv: readonly string[]): RunOutcome {
  return { exitCode: NOT_RUN, stdout: '', stderr: `ClaudeDockula refused to run ${argv.slice(0, 3).join(' ')}` }
}

export function outcomeOf(ran: RunOutcome): RunOutcome {
  return { exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr, ...(ran.isStdoutTruncated === true ? { isStdoutTruncated: true } : {}) }
}

/** A run that threw: NOT_STARTED when the executable is not there, else NOT_RUN. */
export function thrownRun(error: unknown): RunOutcome {
  const text = errorText(error)

  return { exitCode: NO_SUCH_FILE.test(text) ? NOT_STARTED : NOT_RUN, stdout: '', stderr: text }
}

export function missingGh(): RunOutcome {
  return { exitCode: NOT_STARTED, stdout: '', stderr: 'gh is not installed' }
}

/** The first line of a failed run that says something, else its exit code. */
export function failureLine(ran: RunOutcome): string {
  return (
    `${ran.stderr}\n${ran.stdout}`
      .split('\n')
      .map(line => line.trim())
      .find(line => line !== '') ?? `exit code ${ran.exitCode}`
  )
}

/** The `gh` that started last, shared by the three files; found again after a reload. */
let lastGh: string | undefined

/** Where to look for `gh`: the one that started last first, then the PATH and the usual install folders. */
export function ghCandidates(): string[] {
  return lastGh === undefined ? [...GH_CANDIDATES] : [lastGh, ...GH_CANDIDATES.filter(one => one !== lastGh)]
}

/** Records the `gh` that started; undefined forgets it when none did. */
export function rememberGh(path: string | undefined): void {
  lastGh = path
}

/** At most `limit` callers inside at once; the rest wait their turn. */
export interface Gate {
  active: number
  limit: number
  waiting: Array<() => void>
}

export function createGate(limit: number): Gate {
  return { active: 0, limit, waiting: [] }
}

export async function enter(gate: Gate): Promise<void> {
  while (gate.active >= gate.limit) await new Promise<void>(resolve => gate.waiting.push(resolve))
  gate.active += 1
}

export function leave(gate: Gate): void {
  gate.active -= 1
  gate.waiting.shift()?.()
}

/** Every `gh` command the panel runs, whichever file runs it, passes this one gate. */
export const ghGate: Gate = createGate(GH_CONCURRENCY)
