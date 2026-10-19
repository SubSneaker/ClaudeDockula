import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, On, RenderSurface, Timer } from 'claude-code'

import type { BranchSettings, BranchState, BranchWorktree } from '../../types'
import {
  cellWidth,
  drawActions,
  drawFileRow,
  drawHeading,
  drawMore,
  drawNote,
  fitEnd,
  fitStart,
  TONE,
  type DockElements
} from '../dock/ui'
import { drawChoiceRow, drawSettingRow, drawSettingsView } from '../dock/settingsView'
import { DEFAULT_TICKET_PATTERN, SETTINGS_KEY, compileTicketPattern, parseSettings } from '../settings'
import { describeCounts, describeUpstream } from './branch/format'
import { GIT_STATUS, GIT_WORKTREES, isAllowedBranchArgv } from './branch/guard'
import { describeGitFailure, parseGitStatus } from './branch/parse'
import {
  BRANCH_SETTINGS_KEY,
  DEFAULT_FILES_SHOWN,
  DEFAULT_REFRESH_SECONDS,
  FILES_CHOICES,
  REFRESH_CHOICES,
  asRecord,
  describeRefresh,
  parseBranchSettings,
  parseWorktrees,
  withBranchChoice
} from './branch/settings'
import type { DockPanel } from './contract'

// The engine follows `$` only into functions declared in the same file, so every
// function that takes `$` lives here; the drawing below takes no `$`.

const REFRESH_KEY = 'branch-refresh'
const SETTINGS_DONE_KEY = 'branch-settings-done'
const TICKET_PATTERN_KEY = 'branch-set-ticket-pattern'
const STORED_FILES = 10
const INVALID_PATTERN_NOTE = 'That ticket pattern is not valid. It was not saved.'
const DEBOUNCE_MS = 1_500

const branchState = atom({ plugin: 'claudedockula', key: 'branch' } as const, {})

let running: Promise<void> | undefined
let isQueued = false
let ticker: Timer | undefined
let pending: Timer | undefined

/** Runs one of Branch's own git reads; any other argv is refused before it runs. */
async function runGit($: EngineInterface, argv: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!isAllowedBranchArgv(argv)) return { exitCode: 1, stdout: '', stderr: 'Not a read Branch makes.' }

  return $.process.run([...argv], { timeoutMs: 10_000 })
}

async function readWorktrees($: EngineInterface): Promise<BranchWorktree[] | undefined> {
  try {
    const { exitCode, stdout } = await runGit($, GIT_WORKTREES)
    if (exitCode !== 0) return undefined
    const cwd = await $.session.cwd().catch(() => '')

    return parseWorktrees(stdout, cwd)
  } catch {
    return undefined
  }
}

async function readGitStatus($: EngineInterface): Promise<Pick<BranchState, 'status' | 'error' | 'worktrees'>> {
  try {
    const { exitCode, stdout, stderr } = await runGit($, GIT_STATUS)
    if (exitCode !== 0) return { error: describeGitFailure(stderr) }
    const { ticketPattern } = parseSettings(await $.store.get(SETTINGS_KEY).catch(() => undefined))
    const { settings = {} } = await read($, branchState)
    const status = parseGitStatus(stdout, ticketPattern, settings.isUntrackedShown !== false)
    const worktrees = settings.isWorktreesShown === false ? undefined : await readWorktrees($)

    return { status: { ...status, files: status.files.slice(0, STORED_FILES) }, worktrees }
  } catch {
    return { error: 'Could not run git.' }
  }
}

async function storeGitStatus($: EngineInterface): Promise<void> {
  const next = await readGitStatus($)
  const previous = await read($, branchState)
  if (JSON.stringify([previous.status, previous.error, previous.worktrees]) === JSON.stringify([next.status, next.error, next.worktrees])) return

  await update($, branchState, (value) => ({ ...value, status: next.status, error: next.error, worktrees: next.worktrees }))
}

/** Re-reads git status and stores it when it changed; a call made meanwhile runs once more after. */
function refreshBranch($: EngineInterface): Promise<void> {
  if (running !== undefined) {
    isQueued = true
    return running
  }

  running = (async () => {
    try {
      do {
        isQueued = false
        await storeGitStatus($).catch(() => undefined)
      } while (isQueued)
    } finally {
      running = undefined
    }
  })()

  return running
}

/** Refreshes once the burst of tool calls asking for it has gone quiet. */
function refreshBranchSoon($: EngineInterface): void {
  pending?.cancel()
  pending = $.clock.after(DEBOUNCE_MS, () => void refreshBranch($))
}

function startBranchTicker($: EngineInterface, seconds: number): void {
  ticker?.cancel()
  ticker = $.clock.every(seconds * 1000, () => void refreshBranch($))
}

/** The saved settings plus the ticket pattern, which lives in the settings Jira and GitGud share. */
async function loadBranchSettings($: EngineInterface): Promise<BranchSettings> {
  const saved = parseBranchSettings(await $.store.get(BRANCH_SETTINGS_KEY).catch(() => undefined))
  const { ticketPattern } = parseSettings(await $.store.get(SETTINGS_KEY).catch(() => undefined))
  const settings: BranchSettings = { ...saved, ...(ticketPattern === undefined ? {} : { ticketPattern }) }
  await update($, branchState, value => ({ ...value, settings }))

  return settings
}

async function toggleBranchSettings($: EngineInterface): Promise<void> {
  const isOpening = (await read($, branchState)).isSettingsOpen !== true
  if (isOpening) await loadBranchSettings($)
  await update($, branchState, value => {
    const { patternNote: _note, ...rest } = value

    return { ...rest, isSettingsOpen: isOpening }
  })
}

async function saveBranchChoice($: EngineInterface, element: string): Promise<void> {
  const { settings = {} } = await read($, branchState)
  const next = withBranchChoice(settings, element)
  if (next === undefined) return

  const { ticketPattern: _shared, ...own } = next
  await $.store.set(BRANCH_SETTINGS_KEY, own)
  await update($, branchState, value => ({ ...value, settings: next }))
  startBranchTicker($, next.refreshSeconds ?? DEFAULT_REFRESH_SECONDS)
  await refreshBranch($)
}

/** Edits the one shared `ticketPattern`; a blank value removes it so the default applies. */
async function saveTicketPattern($: EngineInterface, text: string): Promise<void> {
  const pattern = text.trim()
  if (pattern !== '' && !compileTicketPattern(pattern).isValid) {
    await update($, branchState, value => ({ ...value, patternNote: INVALID_PATTERN_NOTE }))

    return
  }
  const { ticketPattern: _old, ...others } = asRecord(await $.store.get(SETTINGS_KEY).catch(() => undefined))
  await $.store.set(SETTINGS_KEY, pattern === '' ? others : { ...others, ticketPattern: pattern })
  await update($, branchState, value => {
    const { ticketPattern: _shown, ...rest } = value.settings ?? {}
    const { patternNote: _note, ...kept } = value

    return { ...kept, settings: pattern === '' ? rest : { ...rest, ticketPattern: pattern } }
  })
  await refreshBranch($)
}

async function forgetBranchSettings($: EngineInterface): Promise<void> {
  await update($, branchState, value => {
    const { settings: _settings, isSettingsOpen: _isOpen, patternNote: _note, ...rest } = value

    return rest
  })
  startBranchTicker($, DEFAULT_REFRESH_SECONDS)
  await refreshBranch($)
}

async function handleRefreshPress($: EngineInterface): Promise<void> {
  await update($, branchState, (value) => ({ ...value, isRefreshing: true }))
  await refreshBranch($)
  await update($, branchState, (value) => ({ ...value, isRefreshing: false }))
}

/** The panel's hooks: refresh at session start, on a timer, after writing tools, and on its Refresh button. */
export function registerBranchHooks(on: On): void {
  // A matcher keeps this beside the dock's own session.start hook; the dock is interactive only.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    const settings = await loadBranchSettings($)
    startBranchTicker($, settings.refreshSeconds ?? DEFAULT_REFRESH_SECONDS)
    void refreshBranch($)

    return started
  })

  // Tools whose calls may change what git status reports.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Bash'] }, async ($, e, next) => {
    const ran = await next(e)
    refreshBranchSoon($)

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.press', { plugin: 'claudedockula', element: REFRESH_KEY }, async ($, e) => {
    await handleRefreshPress($)

    return { element: e.element }
  })

  // The card header's ⚙ (the dock opens a minimized card first) and the settings' Done.
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(main|\d+)-settings-branch$/ }, async ($, e, next) => {
    const pressed = await next(e)
    await toggleBranchSettings($)

    return pressed
  })

  on('ui.press', { plugin: 'claudedockula', element: SETTINGS_DONE_KEY }, async ($, e) => {
    await toggleBranchSettings($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^branch-set-(refresh-(20|60|300)|files-(5|10)|untracked-(show|hide)|worktrees-(show|hide))$/ }, async ($, e) => {
    await saveBranchChoice($, e.element)

    return { element: e.element }
  })

  on('ui.input', { plugin: 'claudedockula', element: TICKET_PATTERN_KEY, kind: 'submit' }, async ($, e) => {
    await saveTicketPattern($, e.value)

    return { element: e.element, value: e.value }
  })

  // The dock has cleared the store by now.
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(main|\d+)-reset-all-yes$/ }, async ($, e, next) => {
    const pressed = await next(e)
    await forgetBranchSettings($)

    return pressed
  })
}

const BAND_NAME_CELLS = 16
const WORKTREE_BRANCH_CELLS = 16

/** What the band shows for the branch: its ticket key, else its short name, and `·N` changed paths. */
export function summarizeBranch(state: BranchState): string {
  const { status } = state
  if (status === undefined) return state.error === undefined ? '…' : '–'
  const leaf = status.branch?.split('/').pop()
  const name = status.ticket ?? (leaf === undefined ? status.commit ?? 'detached' : fitEnd(leaf, BAND_NAME_CELLS))

  return status.fileCount > 0 ? `${name} ·${status.fileCount}` : name
}

/** The two status columns `git status -s` prints: staged green, working tree red, untracked dim. */
function drawCode(ui: DockElements, code: string): JSX.Element {
  const { Box, Text } = ui
  if (code === '??') return <Text dimColor>{'??  '}</Text>

  return (
    <Box flexDirection="row" flexShrink={0}>
      <Text color={TONE.pass}>{code[0] ?? ' '}</Text>
      <Text color={TONE.fail}>{code[1] ?? ' '}</Text>
      <Text>{'  '}</Text>
    </Box>
  )
}

/** One worktree: a mark for the current one, its branch, then its path cut from the start. */
function drawWorktree(ui: DockElements, worktree: BranchWorktree, columns: number): JSX.Element {
  const { Box, Text } = ui
  const name = worktree.branch ?? (worktree.isBare === true ? 'bare' : 'detached')
  const shownName = fitEnd(name, WORKTREE_BRANCH_CELLS)
  const pathCells = Math.max(1, columns - 2 - cellWidth(shownName) - 2)

  return (
    <Box flexDirection="row">
      <Text color={TONE.pass}>{worktree.isCurrent ? '● ' : '  '}</Text>
      <Text bold={worktree.isCurrent}>{shownName}</Text>
      <Text dimColor wrap="truncate-end">{`  ${fitStart(worktree.path, pathCells)}`}</Text>
    </Box>
  )
}

/** The Worktrees section: only with more than one worktree, and only while the setting shows it. */
function drawWorktrees(ui: DockElements, state: BranchState, columns: number): JSX.Element | null {
  const { Box } = ui
  const worktrees = state.worktrees ?? []
  if (worktrees.length < 2 || state.settings?.isWorktreesShown === false) return null

  return (
    <Box flexDirection="column" marginTop={1}>
      {drawHeading(ui, 'Worktrees', String(worktrees.length))}
      {worktrees.map(worktree => drawWorktree(ui, worktree, columns))}
    </Box>
  )
}

function drawTicketPatternRow(ui: Elements[RenderSurface], settings: BranchSettings, note?: string): JSX.Element {
  const { Box, Text } = ui
  if (!('Input' in ui)) {
    return drawSettingRow(ui, 'Ticket pattern', <Text dimColor>{settings.ticketPattern ?? DEFAULT_TICKET_PATTERN}</Text>)
  }
  const { Input } = ui

  return drawSettingRow(
    ui,
    'Ticket pattern',
    <Box flexDirection="column">
      <Input key={TICKET_PATTERN_KEY} placeholder={DEFAULT_TICKET_PATTERN} value={settings.ticketPattern ?? ''} submitLabel="done" onSubmit={() => undefined} />
      {note !== undefined && drawNote(ui, note)}
    </Box>
  )
}

/** The ⚙ view: each change is saved as it is pressed. */
function drawBranchSettings(ui: Elements[RenderSurface], settings: BranchSettings, columns: number, note?: string): JSX.Element {
  const { Button } = ui
  const refresh = settings.refreshSeconds ?? DEFAULT_REFRESH_SECONDS
  const filesShown = settings.filesShown ?? DEFAULT_FILES_SHOWN
  const isUntrackedShown = settings.isUntrackedShown !== false
  const isWorktreesShown = settings.isWorktreesShown !== false

  return drawSettingsView(ui, {
    title: '⚙ Branch settings',
    detail: 'for every session',
    columns,
    rows: [
      drawTicketPatternRow(ui, settings, note),
      drawSettingRow(
        ui,
        'Refresh',
        drawChoiceRow(ui, REFRESH_CHOICES.map(seconds => ({ key: `branch-set-refresh-${seconds}`, label: describeRefresh(seconds), isOn: refresh === seconds })))
      ),
      drawSettingRow(
        ui,
        'Files shown',
        drawChoiceRow(ui, FILES_CHOICES.map(count => ({ key: `branch-set-files-${count}`, label: String(count), isOn: filesShown === count })))
      ),
      drawSettingRow(
        ui,
        'Untracked files',
        drawChoiceRow(ui, [
          { key: 'branch-set-untracked-show', label: 'Show', isOn: isUntrackedShown },
          { key: 'branch-set-untracked-hide', label: 'Hide', isOn: !isUntrackedShown }
        ])
      ),
      drawSettingRow(
        ui,
        'Worktrees',
        drawChoiceRow(ui, [
          { key: 'branch-set-worktrees-show', label: 'Show', isOn: isWorktreesShown },
          { key: 'branch-set-worktrees-hide', label: 'Hide', isOn: !isWorktreesShown }
        ])
      )
    ],
    footer: [<Button key={SETTINGS_DONE_KEY} variant="primary" label="Done" onPress={() => undefined} />]
  })
}

/** The card's body, from its stored state; the Refresh press is answered by registerBranchHooks. */
export function drawBranch(ui: Elements[RenderSurface], state: BranchState, columns: number): JSX.Element {
  if (state.isSettingsOpen === true) return drawBranchSettings(ui, state.settings ?? {}, columns, state.patternNote)
  const { Box, Text, Button } = ui
  const { status, error, isRefreshing } = state

  const actions = drawActions(ui, [
    <Button key={REFRESH_KEY} plain dimColor label={isRefreshing ? '↻ Refreshing…' : '↻ Refresh'} onPress={() => undefined} />
  ])

  if (status === undefined) {
    return (
      <Box flexDirection="column">
        {drawNote(ui, error ?? 'Reading git status…')}
        {actions}
      </Box>
    )
  }

  const shownFiles = status.files.slice(0, state.settings?.filesShown ?? DEFAULT_FILES_SHOWN)

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {status.branch === undefined ? (
          <Text bold color={TONE.run} wrap="truncate-end">
            Detached at {status.commit ?? 'no commit'}
          </Text>
        ) : (
          <Text bold wrap="truncate-end">
            {status.branch}
          </Text>
        )}
        {drawNote(ui, describeUpstream(status))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {status.fileCount === 0 ? (
          <Text color={TONE.pass}>✔ Working tree clean</Text>
        ) : (
          drawHeading(ui, describeCounts(status))
        )}
        {shownFiles.map((file) =>
          drawFileRow(ui, { path: file.path, lead: drawCode(ui, file.code), leadCells: 4 }, columns)
        )}
        {drawMore(ui, status.fileCount - shownFiles.length)}
      </Box>
      {drawWorktrees(ui, state, columns)}
      {actions}
    </Box>
  )
}

export const branchPanel: DockPanel = {
  id: 'branch',
  title: 'Branch',
  icon: '🌿',
  description: 'Branch, ticket and uncommitted files',
  isBuiltIn: true,
  hasSettings: true,
  revision: 2,
  whatsNew: 'The card’s ⚙ sets refresh, files shown, worktrees and the ticket pattern'
}
