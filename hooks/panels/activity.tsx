import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, On, ToolCallInput } from 'claude-code'

import type { ActivityCall, ActivityCallStatus, ActivitySettings, ActivityState } from '../../types'
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
import { drawChoiceRow, drawSettingRow, drawSettingsView } from '../dock/settingsView'
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
import {
  ACTIVITY_SETTINGS_KEY,
  DEFAULT_ROWS_SHOWN,
  ROWS_CHOICES,
  parseActivitySettings,
  withActivityChoice
} from './activity/settings'
import type { DockPanel } from './contract'

const activityState = atom({ plugin: 'claudedockula', key: 'activity' } as const, EMPTY_ACTIVITY)

export { EMPTY_ACTIVITY }

/** The key of the Clear button; its press is handled by this panel's own `ui.press` hook. */
export const ACTIVITY_CLEAR_KEY = 'activity-clear'

const SETTINGS_DONE_KEY = 'activity-settings-done'
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

async function loadActivitySettings($: EngineInterface): Promise<void> {
  const settings = parseActivitySettings(await $.store.get(ACTIVITY_SETTINGS_KEY).catch(() => undefined))
  await update($, activityState, state => ({ ...state, settings }))
}

async function toggleActivitySettings($: EngineInterface): Promise<void> {
  const isOpening = (await read($, activityState)).isSettingsOpen !== true
  if (isOpening) await loadActivitySettings($)
  await update($, activityState, state => ({ ...state, isSettingsOpen: isOpening }))
}

async function saveActivityChoice($: EngineInterface, element: string): Promise<void> {
  const next = withActivityChoice((await read($, activityState)).settings ?? {}, element)
  if (next === undefined) return

  await $.store.set(ACTIVITY_SETTINGS_KEY, next)
  await update($, activityState, state => ({ ...state, settings: next }))
}

async function forgetActivitySettings($: EngineInterface): Promise<void> {
  await update($, activityState, state => {
    const { settings: _settings, isSettingsOpen: _isOpen, ...rest } = state

    return rest
  })
}

/** The panel's own hooks; they never change or block a call. */
export function registerActivityHooks(on: On): void {
  // A matcher keeps this beside the dock's own session.start hook; the dock is interactive only.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    await loadActivitySettings($)

    return started
  })

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

  // The card header's ⚙ (the dock opens a minimized card first) and the settings' Done.
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(main|\d+)-settings-activity$/ }, async ($, e, next) => {
    const pressed = await next(e)
    await toggleActivitySettings($)

    return pressed
  })

  on('ui.press', { plugin: 'claudedockula', element: SETTINGS_DONE_KEY }, async ($, e) => {
    await toggleActivitySettings($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^activity-set-(rows-(5|10|20)|subagents-(show|hide))$/ }, async ($, e) => {
    await saveActivityChoice($, e.element)

    return { element: e.element }
  })

  // The dock has cleared the store by now.
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(main|\d+)-reset-all-yes$/ }, async ($, e, next) => {
    const pressed = await next(e)
    await forgetActivitySettings($)

    return pressed
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

/** The ⚙ view: each change is saved as it is pressed. */
function drawActivitySettings(ui: DockElements, settings: ActivitySettings, columns: number): JSX.Element {
  const { Button } = ui
  const rows = settings.rowsShown ?? DEFAULT_ROWS_SHOWN
  const isSubagentShown = settings.isSubagentShown !== false

  return drawSettingsView(ui, {
    title: '⚙ Activity settings',
    detail: 'for every session',
    columns,
    rows: [
      drawSettingRow(
        ui,
        'Rows shown',
        drawChoiceRow(ui, ROWS_CHOICES.map(count => ({ key: `activity-set-rows-${count}`, label: String(count), isOn: rows === count })))
      ),
      drawSettingRow(
        ui,
        'Calls by other agents',
        drawChoiceRow(ui, [
          { key: 'activity-set-subagents-show', label: 'Show', isOn: isSubagentShown },
          { key: 'activity-set-subagents-hide', label: 'Hide', isOn: !isSubagentShown }
        ])
      )
    ],
    footer: [<Button key={SETTINGS_DONE_KEY} variant="primary" label="Done" onPress={() => undefined} />]
  })
}

/** The card's body, drawn from the panel's state alone; the Clear press is answered above. */
export function drawActivity(ui: DockElements, state: ActivityState, columns: number): JSX.Element {
  if (state.isSettingsOpen === true) return drawActivitySettings(ui, state.settings ?? {}, columns)
  const { Box, Button } = ui
  const { files } = state
  const calls = state.settings?.isSubagentShown === false ? state.calls.filter(call => call.agentId === undefined) : state.calls
  const shown = state.settings?.rowsShown ?? DEFAULT_ROWS_SHOWN
  const cwd = state.cwd ?? ''

  if (calls.length === 0 && files.length === 0) {
    return drawNote(ui, 'No activity yet: tool calls and edited files show here.')
  }

  const shownFiles = files.slice(0, shown)
  const shownCalls = calls.slice(0, shown)
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
  isBuiltIn: true,
  hasSettings: true,
  revision: 2,
  whatsNew: 'The card’s ⚙ sets rows shown and calls by other agents'
}
