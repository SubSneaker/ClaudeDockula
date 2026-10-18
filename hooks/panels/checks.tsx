import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, On, RenderSurface, ThemeKey, Timer } from 'claude-code'

import type { CheckRun, CheckSetting, ChecksSetup, ChecksState } from '../../types'
import { NO_NOTICES, dropTopics, pushNotice, type NewNotice } from '../dock/notices'
import { drawActions, drawNote, fitEnd, TONE, type DockElements } from '../dock/ui'
import { SET_UP_SUMMARY, parseRepoSettings, repoSettingsKey } from '../settings'
import {
  describeFinish,
  describeRunAll,
  describeRunAllFailures,
  toggleExpanded,
  withRun,
  withRunsInterrupted,
  type CheckDefinition,
  type CheckResult
} from './checks/run'
import {
  addSetupCheck,
  buildChecksSetup,
  describeCheckOption,
  detectPackageManager,
  pickedChecks,
  suggestChecks,
  toggleSetupCheck
} from './checks/setup'
import { formatDuration, summarizeCheckOutput, type CheckSummary } from './checks/summary'
import type { DockPanel } from './contract'

// The engine follows `$` only into functions declared in the same file, so every
// function that takes `$` lives here; the drawing below takes no `$`.

const GIT_TOPLEVEL = ['git', '--no-optional-locks', 'rev-parse', '--show-toplevel']
const GIT_TIMEOUT_MS = 5_000
const RUN_ALL_KEY = 'checks-run-all'
const RUN_KEY_PREFIX = 'checks-run-'
const TOGGLE_KEY_PREFIX = 'checks-toggle-'
const SETUP_KEY = 'checks-setup'
const PICK_KEY_PREFIX = 'checks-pick-'
const ADD_KEY_PREFIX = 'checks-add-'
const SAVE_KEY = 'checks-save'
const CANCEL_KEY = 'checks-cancel'
const TIMEOUT_MS = 10 * 60 * 1000
const TICK_MS = 5000
const PLAIN_OUTPUT_ENV = { NO_COLOR: '1', FORCE_COLOR: '0' }

const checksState = atom({ plugin: 'claudedockula', key: 'checks' } as const, {})
const noticesAtom = atom({ plugin: 'claudedockula', key: 'notices' } as const, NO_NOTICES)

/** The checks the person saved for this repo, in order; none until they set them up. */
function checksOf(state: ChecksState): readonly CheckDefinition[] {
  return state.checks ?? []
}

/** Checks running in this copy of the module; a reload loses them, and the guards below with them. */
const liveRuns = new Set<string>()
let isRunAllLive = false
let ticker: Timer | undefined

/**
 * Tells the person how a check went; a newer notice on the same `topic` (a re-run) replaces the older, and
 * the notices on `replaces` go (a Run all's tally says what each check's own said).
 */
async function notify($: EngineInterface, notice: Omit<NewNotice, 'at'>, replaces: readonly string[] = []): Promise<void> {
  const at = await $.clock.now()
  await update($, noticesAtom, list => pushNotice(dropTopics(list, replaces), { ...notice, at }))
}

function checkTopic(check: CheckDefinition): string {
  return `check-${check.id}`
}

async function summarizeRun($: EngineInterface, check: CheckDefinition): Promise<CheckSummary> {
  try {
    const [output, cwd] = await Promise.all([
      $.process.run(check.argv, { timeoutMs: TIMEOUT_MS, env: PLAIN_OUTPUT_ENV }),
      $.session.cwd()
    ])

    return summarizeCheckOutput(output, cwd)
  } catch (error) {
    return {
      isPassed: false,
      problem: 'did not finish',
      lines: [error instanceof Error ? error.message : String(error)]
    }
  }
}

/** Runs the check unless it already runs here and stores the outcome; on its own (not in Run all) it posts a notice. */
async function runCheck($: EngineInterface, check: CheckDefinition, isInRunAll = false): Promise<CheckSummary | undefined> {
  if (liveRuns.has(check.id)) return undefined
  liveRuns.add(check.id)
  try {
    const startedAt = await $.clock.now()
    await update($, checksState, state => ({
      ...withRun(state, check.id, { status: 'running', startedAt }),
      now: startedAt
    }))
    startTicker($)

    const summary = await summarizeRun($, check)
    const durationMs = (await $.clock.now()) - startedAt
    await update($, checksState, state =>
      withRun(state, check.id, {
        status: summary.isPassed ? 'passed' : 'failed',
        durationMs,
        problem: summary.problem,
        lines: summary.lines
      })
    )
    if (!isInRunAll) {
      const detail = summary.lines.join('\n')
      await notify($, {
        tone: summary.isPassed ? 'success' : 'error',
        title: describeFinish(check.name, summary, durationMs),
        topic: checkTopic(check),
        ...(detail ? { detail } : {})
      })
    }

    return summary
  } finally {
    liveRuns.delete(check.id)
  }
}

/** One check after another, skipping any already running, then one notice with the tally. */
async function runAllChecks($: EngineInterface): Promise<void> {
  if (isRunAllLive) return
  isRunAllLive = true
  try {
    await update($, checksState, state => ({ ...state, isRunningAll: true }))
    const results: CheckResult[] = []
    const checks = checksOf(await read($, checksState))
    for (const check of checks) {
      const summary = await runCheck($, check, true)
      const problem = summary?.problem ? { problem: summary.problem } : {}
      if (summary) results.push({ name: check.name, isPassed: summary.isPassed, ...problem })
    }
    if (results.length > 0) {
      const detail = describeRunAllFailures(results)
      const tally: Omit<NewNotice, 'at'> = {
        tone: results.every(result => result.isPassed) ? 'success' : 'error',
        title: describeRunAll(results),
        topic: 'checks-all',
        ...(detail ? { detail } : {})
      }
      await notify($, tally, checks.map(checkTopic))
    }
  } finally {
    isRunAllLive = false
    await update($, checksState, state => ({ ...state, isRunningAll: false }))
  }
}

/** The repo's top folder, so a session started in a subfolder finds the same saved checks. */
async function readRepoRoot($: EngineInterface): Promise<string> {
  const git = await $.process.run(GIT_TOPLEVEL, { timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined)
  const top = git?.exitCode === 0 ? git.stdout.trim() : ''
  if (top !== '') return top
  try {
    return await $.session.root()
  } catch {
    return $.session.cwd()
  }
}

/** Opens the setup form: the repo's saved checks ticked, beside what its package.json suggests. */
async function openSetup($: EngineInterface): Promise<void> {
  const state = await read($, checksState)
  const root = state.repo ?? (await readRepoRoot($))
  const [packageJson, names] = await Promise.all([
    $.fs.read(`${root}/package.json`).catch(() => undefined),
    $.fs
      .list(root)
      .then(entries => entries.map(entry => entry.name))
      .catch(() => [])
  ])
  const manager = detectPackageManager(names)
  const suggestions = suggestChecks(packageJson, manager)
  const setup = buildChecksSetup(state.checks, suggestions, packageJson === undefined ? undefined : manager)
  await update($, checksState, value => ({ ...value, repo: root, setup }))
}

/** Reads this repo's saved checks once; a repo with none opens the setup form. */
async function loadChecks($: EngineInterface): Promise<void> {
  if ((await read($, checksState)).isLoaded) return
  const root = await readRepoRoot($)
  const saved = parseRepoSettings(await $.store.get(repoSettingsKey(root)).catch(() => undefined))
  await update($, checksState, value => ({ ...value, isLoaded: true, repo: root, checks: saved.checks }))
  if (!saved.checks) await openSetup($)
}

async function saveChecks($: EngineInterface): Promise<void> {
  const { setup, repo } = await read($, checksState)
  if (!setup || repo === undefined) return
  const checks = pickedChecks(setup)
  await $.store.set(repoSettingsKey(repo), { checks }).catch(() => undefined)
  await update($, checksState, value => {
    const { setup: _setup, ...rest } = value

    return { ...rest, checks }
  })
}

async function changeSetup($: EngineInterface, change: (setup: ChecksSetup) => ChecksSetup): Promise<void> {
  await update($, checksState, value => (value.setup ? { ...value, setup: change(value.setup) } : value))
}

function startTicker($: EngineInterface): void {
  if (ticker) return
  ticker = $.clock.every(TICK_MS, () => void tick($))
}

async function tick($: EngineInterface): Promise<void> {
  if (liveRuns.size === 0) {
    ticker?.cancel()
    ticker = undefined

    return
  }
  const now = await $.clock.now()
  await update($, checksState, state => ({ ...state, now }))
}

/** The panel's hooks: its Run, Run all and details buttons. Runs start on a timer so they outlive the press. */
export function registerChecksHooks(on: On): void {
  // Also fires after a reload of the mod, which drops the runs in flight.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    await update($, checksState, withRunsInterrupted)
    await loadChecks($).catch(() => undefined)

    return started
  })

  on('ui.press', { plugin: 'claudedockula', element: RUN_ALL_KEY }, async ($, e) => {
    await loadChecks($)
    const { checks } = await read($, checksState)
    if (checks === undefined || checks.length === 0) return { element: e.element }
    if (isRunAllLive) void notify($, { tone: 'info', title: 'Already running all checks', topic: 'checks-busy' })
    else $.clock.after(1, () => void runAllChecks($))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^checks-run-(?!all$)/ }, async ($, e) => {
    await loadChecks($)
    const check = checksOf(await read($, checksState)).find(one => `${RUN_KEY_PREFIX}${one.id}` === e.element)
    if (check && liveRuns.has(check.id)) {
      void notify($, { tone: 'info', title: `${check.name} is already running`, topic: `check-busy-${check.id}` })
    }
    else if (check) $.clock.after(1, () => void runCheck($, check))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^checks-toggle-/ }, async ($, e) => {
    const id = e.element.slice(TOGGLE_KEY_PREFIX.length)
    await update($, checksState, state => toggleExpanded(state, id))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: SETUP_KEY }, async ($, e) => {
    await openSetup($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^checks-pick-/ }, async ($, e) => {
    const id = e.element.slice(PICK_KEY_PREFIX.length)
    await changeSetup($, setup => toggleSetupCheck(setup, id))

    return { element: e.element }
  })

  on('ui.input', { plugin: 'claudedockula', element: /^checks-add-/, kind: 'submit' }, async ($, e) => {
    await changeSetup($, setup => addSetupCheck(setup, e.value))

    return { element: e.element, value: e.value }
  })

  on('ui.press', { plugin: 'claudedockula', element: SAVE_KEY }, async ($, e) => {
    await saveChecks($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: CANCEL_KEY }, async ($, e) => {
    await update($, checksState, value => {
      const { setup: _setup, ...rest } = value

      return rest
    })

    return { element: e.element }
  })
}

const NAME_CELLS = 12

/** The band's emoji for the checks: ⏳ while any runs, ❌ once one failed, else ✅. */
export function checksIcon(state: ChecksState): string {
  const runs = checksOf(state).flatMap(check => state.runs?.[check.id] ?? [])
  if (state.isRunningAll === true || runs.some(run => run.status === 'running')) return '⏳'

  return runs.some(run => run.status === 'failed') ? '❌' : '✅'
}

/** What the band shows beside that emoji: `4/4` passed, `2` failed, nothing while running, `set up` before the repo's checks are chosen, `–` never run. */
export function summarizeChecks(state: ChecksState): string {
  if (state.isLoaded && state.checks === undefined) return SET_UP_SUMMARY
  const checks = checksOf(state)
  const runs = checks.flatMap(check => state.runs?.[check.id] ?? [])
  if (state.isRunningAll === true || runs.some(run => run.status === 'running')) return ''
  const failed = runs.filter(run => run.status === 'failed').length
  if (failed > 0) return String(failed)

  return runs.length === 0 ? '–' : `${runs.length}/${checks.length}`
}

interface CheckCell {
  text: string
  /** Dim, after the text: the time it took or has taken. */
  time: string
  tone?: ThemeKey
}

/** One check's status column: `✔ passed  42s`, `✘ 197 errors`, `◌ running  15s`, `· not run`. */
function describeCheckCell(run: CheckRun | undefined, now: number | undefined): CheckCell {
  if (!run) return { text: '· not run', time: '' }
  if (run.status === 'running') {
    const startedAt = run.startedAt ?? now ?? 0

    return { text: '◌ running', time: formatDuration(Math.max(0, (now ?? startedAt) - startedAt)), tone: TONE.run }
  }
  if (run.status === 'failed') return { text: `✘ ${run.problem ?? 'failed'}`, time: '', tone: TONE.fail }

  return { text: '✔ passed', time: run.durationMs === undefined ? '' : formatDuration(run.durationMs), tone: TONE.pass }
}

function drawCheck(ui: DockElements, check: CheckDefinition, state: ChecksState): JSX.Element {
  const { Box, Text, Button } = ui
  const run = state.runs?.[check.id]
  const cell = describeCheckCell(run, state.now)
  const lines = run?.status === 'failed' ? (run.lines ?? []) : []
  const isExpanded = (state.expanded ?? []).includes(check.id)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={NAME_CELLS} flexShrink={0}>
          <Text bold>{check.name}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={cell.tone} dimColor={cell.tone === undefined}>
              {cell.text}
            </Text>
            {cell.time !== '' && <Text dimColor>{`  ${cell.time}`}</Text>}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Button
            key={`${RUN_KEY_PREFIX}${check.id}`}
            label="Run"
            dimColor={run?.status === 'running'}
            onPress={() => undefined}
          />
        </Box>
      </Box>
      {lines.length > 0 && (
        <Box paddingLeft={NAME_CELLS}>
          <Button key={`${TOGGLE_KEY_PREFIX}${check.id}`} plain dimColor onPress={() => undefined}>
            {isExpanded ? '▾ hide details' : '▸ show details'}
          </Button>
        </Box>
      )}
      {isExpanded && lines.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} marginY={1}>
          {lines.map(line => (
            <Text wrap="wrap">{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

function drawSetup(ui: Elements[RenderSurface], setup: ChecksSetup, isSaved: boolean, columns: number): JSX.Element {
  const { Box, Button } = ui
  const intro = setup.manager ? `Pick what to run in this repo (${setup.manager}).` : 'Add what to run in this repo.'
  let field: JSX.Element | null = null
  if ('Input' in ui) {
    const { Input } = ui
    field = (
      <Box marginTop={1}>
        <Input
          key={`${ADD_KEY_PREFIX}${setup.options.length}`}
          label="Add a command "
          placeholder="name: command"
          submitLabel="add"
          onSubmit={() => undefined}
        />
      </Box>
    )
  } else if (setup.options.length === 0) {
    field = <Box marginTop={1}>{drawNote(ui, 'Add commands from the terminal.')}</Box>
  }
  const buttons = [
    <Button key={SAVE_KEY} variant="primary" label="Save" onPress={() => undefined} />,
    ...(isSaved ? [<Button key={CANCEL_KEY} plain dimColor label="Cancel" onPress={() => undefined} />] : [])
  ]

  return (
    <Box flexDirection="column" width={columns}>
      {drawNote(ui, intro)}
      {setup.options.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {setup.options.map(option => (
            <Button
              key={`${PICK_KEY_PREFIX}${option.id}`}
              plain
              label={fitEnd(`${setup.picked.includes(option.id) ? '☑' : '☐'} ${describeCheckOption(option)}`, columns)}
              onPress={() => undefined}
            />
          ))}
        </Box>
      )}
      {field}
      {drawActions(ui, buttons)}
    </Box>
  )
}

/** The card's body, from its stored state; every press is answered by registerChecksHooks. */
export function drawChecks(ui: Elements[RenderSurface], state: ChecksState, columns: number): JSX.Element {
  const { Box, Button } = ui
  if (!state.isLoaded) return drawNote(ui, 'Reading this repo’s settings…')
  if (state.setup) return drawSetup(ui, state.setup, state.checks !== undefined, columns)
  const checks = checksOf(state)
  const settingsButton = <Button key={SETUP_KEY} plain dimColor label="⚙" onPress={() => undefined} />

  return (
    <Box flexDirection="column" width={columns}>
      {checks.length === 0 && drawNote(ui, 'No checks: ⚙ to add')}
      {checks.map(check => drawCheck(ui, check, state))}
      {drawActions(ui, [
        ...(checks.length > 0
          ? [
              <Button
                key={RUN_ALL_KEY}
                label={state.isRunningAll ? 'Running all…' : 'Run all'}
                variant={state.isRunningAll ? undefined : 'primary'}
                dimColor={state.isRunningAll === true}
                onPress={() => undefined}
              />
            ]
          : []),
        settingsButton
      ])}
    </Box>
  )
}

export const checksPanel: DockPanel = {
  id: 'checks',
  title: 'Checks',
  icon: '✅',
  description: 'Run this repo’s lint, type, test and format commands in the background',
  isBuiltIn: true
}
