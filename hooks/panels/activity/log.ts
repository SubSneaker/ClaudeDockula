import type { ActivityCall, ActivityCallStatus, ActivityFile, ActivityState } from '../../../types'

export const MAX_CALLS = 50
const MAX_FILES = 100

export const EMPTY_ACTIVITY: ActivityState = { calls: [], files: [] }

export interface EditedFile {
  path: string
}

export interface FinishedCall {
  id: string
  status: ActivityCallStatus
  /** The file a landed write changed. */
  edited?: EditedFile
}

export function withCallStarted(state: ActivityState, call: ActivityCall): ActivityState {
  const others = state.calls.filter((one) => one.id !== call.id)

  return { ...state, calls: [call, ...others].slice(0, MAX_CALLS) }
}

export function withCallFinished(state: ActivityState, finished: FinishedCall): ActivityState {
  const calls = state.calls.map((one) =>
    one.id === finished.id ? { ...one, status: finished.status } : one
  )
  const { edited } = finished
  if (edited === undefined) return { ...state, calls }

  return { ...state, calls, files: withFileEdited(state.files, edited.path) }
}

/** Marks the calls a loop left running when its turn ended (an interrupt) as stopped. */
export function withLoopEnded(state: ActivityState, agentId: string | undefined): ActivityState {
  const calls = state.calls.map(
    (one): ActivityCall =>
      one.status === 'running' && one.agentId === agentId ? { ...one, status: 'stopped' } : one
  )

  return { ...state, calls }
}

/** Empties the panel, keeping the calls still running so their outcome still shows. */
export function cleared(state: ActivityState): ActivityState {
  const running = state.calls.filter((one) => one.status === 'running')

  return { ...state, calls: running, files: [] }
}

/**
 * Moves the file to the front with one more edit.
 * @example
 * // before: [{ path: 'a', edits: 1 }, { path: 'b', edits: 2 }], 'b'
 * // after:  [{ path: 'b', edits: 3 }, { path: 'a', edits: 1 }]
 */
function withFileEdited(files: ActivityFile[], path: string): ActivityFile[] {
  const edits = (files.find((one) => one.path === path)?.edits ?? 0) + 1
  const others = files.filter((one) => one.path !== path)

  return [{ path, edits }, ...others].slice(0, MAX_FILES)
}
