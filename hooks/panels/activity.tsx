import { atom, update } from 'claude-code'
import type { Color, On, ToolCallInput } from 'claude-code'

import type { ActivityCall, ActivityCallStatus, ActivityState } from '../../types'
import {
  cellWidth,
  drawActions,
  drawFileRow,
  drawHeading,
  drawMore,
  drawNote,
  padCells,
  TONE,
  type DockElements
} from '../dock/ui'
import { describeToolCall, relativePath } from './activity/describe'
import {
  cleared,
  EMPTY_ACTIVITY,
  type FinishedCall,
  MAX_CALLS,
  withCallFinished,
  withCallStarted,
  withLoopEnded
} from './activity/log'
import type { DockPanel } from './contract'

const activityState = atom({ plugin: 'claudedockula', key: 'activity' } as const, EMPTY_ACTIVITY)

export { EMPTY_ACTIVITY }

/** The key of the Clear button; its press is handled by this panel's own `ui.press` hook. */
export const ACTIVITY_CLEAR_KEY = 'activity-clear'

const SHOWN = 5
const NAME_CELLS = 10

interface StatusMark {
  glyph: string
  color: Color
}

const STATUS_MARKS: Record<ActivityCallStatus, StatusMark> = {
  running: { glyph: '⋯', color: 'warning' },
  done: { glyph: '✓', color: 'success' },
  error: { glyph: '✗', color: 'error' },
  stopped: { glyph: '-', color: 'inactive' }
}

/** Whether the call was refused or its tool reported an error. */
interface CallOutcome {
  deny?: string
  isError?: boolean
}

/** The file an Edit, Write or NotebookEdit call writes. */
function writtenPath(e: ToolCallInput): string | undefined {
  if (e.tool === 'Edit' || e.tool === 'Write') return e.file_path
  if (e.tool === 'NotebookEdit') return e.notebook_path

  return undefined
}

function finishedCall(e: ToolCallInput, outcome: CallOutcome): FinishedCall {
  const id = e.tool_use_id
  if (outcome.deny !== undefined || outcome.isError === true) return { id, status: 'error' }

  const path = writtenPath(e)

  return path === undefined ? { id, status: 'done' } : { id, status: 'done', edited: { path } }
}

/** The panel's own hooks; they never change or block a call. */
export function registerActivityHooks(on: On): void {
  // `/./` matches every tool: the mod keeps its one unmatched tool.call hook free for others.
  on('tool.call', { tool: /./ }, async ($, e, next) => {
    const cwd = await $.session.cwd().catch(() => '')
    const started: ActivityCall = {
      id: e.tool_use_id,
      status: 'running',
      ...describeToolCall(String(e.tool), e, cwd),
      ...(e.agentId === undefined ? {} : { agentId: e.agentId })
    }
    await update($, activityState, (state) => ({ ...withCallStarted(state, started), cwd }))
    const ran = await next(e)
    await update($, activityState, (state) => withCallFinished(state, finishedCall(e, ran)))

    return ran
  }).catch(($, e, next) => next(e))

  // Only an interrupted or failed turn can leave a call running.
  on('turn.complete', { reason: ['aborted', 'error'] }, async ($, e, next) => {
    await update($, activityState, (state) => withLoopEnded(state, e.agentId))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.press', { plugin: 'claudedockula', element: ACTIVITY_CLEAR_KEY }, async ($, e, next) => {
    await update($, activityState, cleared)

    return next(e)
  })
}

/** What the band shows for the activity: the tool calls this session, `50+` once the log is full. */
export function summarizeActivity(state: ActivityState): string {
  return state.calls.length >= MAX_CALLS ? `${MAX_CALLS}+` : String(state.calls.length)
}

function drawCall(ui: DockElements, call: ActivityCall, nameCells: number): JSX.Element {
  const { Box, Text } = ui
  const mark = STATUS_MARKS[call.status]

  return (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text color={mark.color}>{`${mark.glyph} `}</Text>
        <Text bold>{padCells(call.name, nameCells)}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} marginLeft={2}>
        <Text dimColor wrap="truncate-end">
          {call.summary}
        </Text>
      </Box>
    </Box>
  )
}

/** The card's body, drawn from the panel's state alone; the Clear press is answered above. */
export function drawActivity(ui: DockElements, state: ActivityState, columns: number): JSX.Element {
  const { Box, Button } = ui
  const { calls, files } = state
  const cwd = state.cwd ?? ''

  if (calls.length === 0 && files.length === 0) {
    return drawNote(ui, 'No activity yet: tool calls and edited files show here.')
  }

  const shownFiles = files.slice(0, SHOWN)
  const shownCalls = calls.slice(0, SHOWN)
  const nameCells = Math.min(NAME_CELLS, Math.max(4, ...shownCalls.map(call => cellWidth(call.name))))

  return (
    <Box flexDirection="column" width={columns}>
      {drawHeading(ui, 'Files edited', String(files.length))}
      {files.length === 0 && drawNote(ui, 'None yet.')}
      {shownFiles.map((file) =>
        drawFileRow(ui, { path: relativePath(file.path, cwd), trail: `×${file.edits}` }, columns)
      )}
      {drawMore(ui, files.length - shownFiles.length)}

      <Box flexDirection="column" marginTop={1}>
        {drawHeading(ui, 'Recent calls', String(calls.length))}
        {shownCalls.map((call) => drawCall(ui, call, nameCells))}
      </Box>

      {drawActions(ui, [<Button key={ACTIVITY_CLEAR_KEY} plain dimColor label="Clear" onPress={() => undefined} />])}
    </Box>
  )
}

export const activityPanel: DockPanel = {
  id: 'activity',
  title: 'Activity',
  icon: '🕘',
  description: 'Files edited and tools run this session',
  isBuiltIn: true
}
