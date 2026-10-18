import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'

import type { BranchState } from '../../types'
import {
  drawActions,
  drawFileRow,
  drawHeading,
  drawMore,
  drawNote,
  fitEnd,
  TONE,
  type DockElements
} from '../dock/ui'
import { SETTINGS_KEY, parseSettings } from '../settings'
import { describeCounts, describeUpstream } from './branch/format'
import { describeGitFailure, parseGitStatus } from './branch/parse'
import type { DockPanel } from './contract'

// The engine follows `$` only into functions declared in the same file, so every
// function that takes `$` lives here; the drawing below takes no `$`.

const GIT_STATUS = ['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch']
const REFRESH_KEY = 'branch-refresh'
const STORED_FILES = 8
const INTERVAL_MS = 20_000
const DEBOUNCE_MS = 1_500

const branchState = atom({ plugin: 'claudedockula', key: 'branch' } as const, {})

let running: Promise<void> | undefined
let isQueued = false
let ticker: Timer | undefined
let pending: Timer | undefined

async function readGitStatus($: EngineInterface): Promise<Pick<BranchState, 'status' | 'error'>> {
  try {
    const { exitCode, stdout, stderr } = await $.process.run(GIT_STATUS, { timeoutMs: 10_000 })
    if (exitCode !== 0) return { error: describeGitFailure(stderr) }
    const { ticketPattern } = parseSettings(await $.store.get(SETTINGS_KEY).catch(() => undefined))
    const status = parseGitStatus(stdout, ticketPattern)

    return { status: { ...status, files: status.files.slice(0, STORED_FILES) } }
  } catch {
    return { error: 'Could not run git.' }
  }
}

async function storeGitStatus($: EngineInterface): Promise<void> {
  const next = await readGitStatus($)
  const previous = await read($, branchState)
  if (JSON.stringify([previous.status, previous.error]) === JSON.stringify([next.status, next.error])) return

  await update($, branchState, (value) => ({ ...value, status: next.status, error: next.error }))
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

function startBranchTicker($: EngineInterface): void {
  ticker?.cancel()
  ticker = $.clock.every(INTERVAL_MS, () => void refreshBranch($))
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
    startBranchTicker($)
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
}

const FILES_SHOWN = 5
const BAND_NAME_CELLS = 16

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

/** The card's body, from its stored state; the Refresh press is answered by registerBranchHooks. */
export function drawBranch(ui: DockElements, state: BranchState, columns: number): JSX.Element {
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

  const shownFiles = status.files.slice(0, FILES_SHOWN)

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
      {actions}
    </Box>
  )
}

export const branchPanel: DockPanel = {
  id: 'branch',
  title: 'Branch',
  icon: '🌿',
  description: 'Branch, ticket and uncommitted files',
  isBuiltIn: true
}
