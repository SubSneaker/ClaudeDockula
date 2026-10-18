import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderSurface, Timer, UiCopyResult } from 'claude-code'

import type { GhCheck, GhDetail, GhHealth, GhItem, GhRepo, GhReviewDone, GhReviewModel, GhScope, GhSettings, GhView, GhViewState, GithubState, NoticeTone } from '../../types'
import { DEFAULT_LAYOUT, bandPanelIds, hiddenPaneIds, isShownIn, readLayout } from '../dock/layout'
import { NO_NOTICES, VISIBLE_NOTICES, dropTopics, pushNotice, type NewNotice } from '../dock/notices'
import { SETTINGS_KEY, openCommands, parseSettings } from '../settings'
import type { DockPanel } from './contract'
import { deriveListAlerts, parseLedger, pruneLedger, scopeSignature, takeNewAlerts, type AlertCandidate } from './github/alerts'
import {
  GH_ENV,
  GIT_BRANCH,
  GIT_TOPLEVEL,
  ghAuthStatus,
  ghChecks,
  ghDiff,
  ghJobLog,
  ghListsCall,
  ghRecentRepos,
  ghRepoValidate,
  ghRepoView,
  ghSearchCall,
  ghSearchRepos,
  ghThreadCall,
  ghViewerCall,
  isAllowedArgv,
  type ListsQuery
} from './github/argv'
import { jiraStatusesFromState, missingTicketKeys } from './github/jiraLink'
import { excerptFailedLog } from './github/logs'
import {
  DEFAULT_SHOWN,
  DETAIL_REFRESH_MS,
  HAIKU_CONCURRENCY,
  JIRA_STATUS_TTL_MS,
  KEY,
  MAX_JIRA_READS_PER_POLL,
  STORE,
  WORK_ACTIONS,
  decodeItemId,
  decodeRepoName,
  docDirOf,
  parseActKey,
  parseListMessage,
  type GhAction
} from './github/model'
import {
  classifyGhFailure,
  parseChecks,
  parseListsResponse,
  parseRecentRepos,
  parseRepoView,
  parseSearchRepos,
  parseSearchResponse,
  parseThreadResponse,
  type FullThread,
  type ListsResult
} from './github/parse'
import { isPollDue, nextPollDelay } from './github/poll'
import { REVIEW_DONE, REVIEW_MODELS, notifyChannelOf } from './github/review'
import {
  addressCommentsPrompt,
  checkoutCommand,
  ciWhyAsk,
  cleanOneLine,
  fixCiPrompt,
  fullThreadMarkdown,
  fullThreadPrompt,
  linkMarkdown,
  oneLinerAsk,
  prPlaceOf,
  reviewHereText,
  titleBodyMarkdown,
  type ModelAsk
} from './github/prompts'
import { findItem, listItemsOf, scopeOf } from './github/rows'
import {
  GH_TIMEOUT_MS,
  NOT_RUN,
  NOT_STARTED,
  createGate,
  enter,
  ghCandidates,
  ghGate,
  leave,
  missingGh,
  outcomeOf,
  refusedRun,
  rememberGh,
  thrownRun,
  type Gate,
  type RunOutcome
} from './github/run'
import { parseJiraIssue } from './jira/parse'
import { errorText, isPermissionDenial, jiraIssueArgs } from './jira/servers'

export { drawGithub, githubTabTone, summarizeGithub } from './github/draw'

// The engine follows `$` only into functions declared in the same file, so every function that takes `$`
// lives here; github/* is pure. Every command goes through `runGh`, `runGit` or `openUrl`, which check
// `isAllowedArgv` first: the panel only ever reads.

const PANEL_ID = 'github'
const TICK_MS = 30_000
/** Opening the card reads data older than this again. */
const STALE_MS = 30_000
const LONG_TIMEOUT_MS = 30_000
const GIT_TIMEOUT_MS = 10_000
const HAIKU_TIMEOUT_MS = 20_000
/** Past this a copy goes to a file: OSC 52 may drop a big one while saying it took. */
const COPY_MAX_CHARS = 64_000
/** Where Homebrew installs itself: Apple silicon, Intel macOS, Linux. */
const BREW_PATHS: readonly string[] = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew']
const MAX_ONE_LINERS = 400
const MAX_CI_WHY = 200
const MAX_FAILED_LOGS = 3
const MAX_REPO_CHOICES = 3
const RATE_FLOOR = 100
const RATE_SLACK_MS = 5_000
const CANCEL = 'Cancel'
const CLEAR_SEARCH = 'Clear search'
const ALL_REPOS = 'Show all repos'
const POLL_TOPIC = 'github-poll'
const COPY_TOPIC = 'github-copy'
const REPOS_TOPIC = 'github-repos'
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/
const REPO_URL = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/#?]|$)/
const NO_CHECKS = /no checks reported/i

const githubState = atom({ plugin: 'claudedockula', key: 'github' } as const, {})
const jiraState = atom({ plugin: 'claudedockula', key: 'jira' } as const, {})
const layoutAtom = atom({ plugin: 'claudedockula', key: 'layout' } as const, DEFAULT_LAYOUT)
const noticesAtom = atom({ plugin: 'claudedockula', key: 'notices' } as const, NO_NOTICES)


/** Work a hook does not wait for: a failure in it ends there, never as an unhandled rejection. */
function detach(work: Promise<unknown>): void {
  work.catch(() => undefined)
}

const haikuGate: Gate = createGate(HAIKU_CONCURRENCY)
/** One cache write at a time: each reads the stored record, adds to it and writes it back. */
const storeGate: Gate = createGate(1)

let ticker: Timer | undefined
let isStarted = false
let starting: Promise<void> | undefined
/** When the last start could not reach GitHub: the next one waits for the poll's backoff. */
let startFailedAt: number | undefined
let latestPoll = 0
let latestSearch = 0
let lastPollAt: number | undefined
let rateResetAt: string | undefined
const askedOneLiners = new Set<string>()
/** The opened rows' loads under way: a second ask (Fix failing CI) waits for the same one. */
const detailLoads = new Map<string, Promise<void>>()
/** When each Jira key was last read here: read again once that is older than the TTL. */
const jiraReadAt = new Map<string, number>()

interface NoticeOptions {
  detail?: string
  topic?: string
}

interface CachedLine {
  /** The item's `updatedAt` the line was written for; absent for a CI job. */
  u?: string
  t: string
  at: number
}

// --- pure helpers ---

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map(line => line.trim())
      .find(line => line !== '') ?? ''
  )
}

/** The saved settings, checked; anything unusable is left out. */
function parseGhSettings(raw: unknown): GhSettings {
  if (typeof raw !== 'object' || raw === null) return {}
  const settings: GhSettings = {}
  if ('extraRepos' in raw && Array.isArray(raw.extraRepos)) {
    const repos = raw.extraRepos.filter((repo): repo is string => typeof repo === 'string' && REPO_NAME.test(repo))
    if (repos.length > 0) settings.extraRepos = [...new Set(repos)]
  }
  if ('scope' in raw && (raw.scope === 'repos' || raw.scope === 'all')) settings.scope = raw.scope
  if ('pollSeconds' in raw && typeof raw.pollSeconds === 'number' && raw.pollSeconds > 0) settings.pollSeconds = raw.pollSeconds
  if ('isHaikuOn' in raw && typeof raw.isHaikuOn === 'boolean') settings.isHaikuOn = raw.isHaikuOn
  if ('reviewDone' in raw && isReviewDone(raw.reviewDone)) settings.reviewDone = raw.reviewDone
  if ('reviewModel' in raw && isReviewModel(raw.reviewModel)) settings.reviewModel = raw.reviewModel
  if ('isReviewWebOn' in raw && typeof raw.isReviewWebOn === 'boolean') settings.isReviewWebOn = raw.isReviewWebOn

  return settings
}

function isReviewDone(value: unknown): value is GhReviewDone {
  return REVIEW_DONE.some(one => one === value)
}

function isReviewModel(value: unknown): value is GhReviewModel {
  return REVIEW_MODELS.some(one => one === value)
}

/** The session's repo, then the added ones, each once. */
function reposOf(state: GithubState): string[] {
  const repos = [state.currentRepo?.nameWithOwner, ...(state.settings?.extraRepos ?? [])].filter(repo => repo !== undefined)

  return [...new Set(repos)]
}

function listsQueryOf(state: GithubState): ListsQuery {
  return { scope: scopeOf(state), repos: reposOf(state) }
}

/** `owner/name` from what the person typed: the name itself, or a GitHub URL. */
function repoFromText(text: string): string | undefined {
  const trimmed = text.trim()
  if (REPO_NAME.test(trimmed)) return trimmed

  return REPO_URL.exec(trimmed)?.[1]
}

function isView(value: string): value is GhView {
  return value === 'review' || value === 'mine' || value === 'issues' || value === 'search'
}

/** `20261016-153012`, local time. */
function fileStamp(at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`

  return `${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function readCache(raw: unknown): Record<string, CachedLine> {
  const cache: Record<string, CachedLine> = {}
  if (typeof raw !== 'object' || raw === null) return cache
  for (const [id, entry] of Object.entries(raw)) {
    if (typeof entry !== 'object' || entry === null || !('t' in entry) || !('at' in entry)) continue
    if (typeof entry.t !== 'string' || typeof entry.at !== 'number') continue
    cache[id] = 'u' in entry && typeof entry.u === 'string' ? { u: entry.u, t: entry.t, at: entry.at } : { t: entry.t, at: entry.at }
  }

  return cache
}

/**
 * The cache with one entry set, the oldest dropped past `max`.
 * @example
 * // before: { a: { t: 'x', at: 1 }, b: { t: 'y', at: 2 } }, 'c', { t: 'z', at: 3 }, 2
 * // after:  { c: { t: 'z', at: 3 }, b: { t: 'y', at: 2 } }
 */
function withCached(cache: Record<string, CachedLine>, id: string, entry: CachedLine, max: number): Record<string, CachedLine> {
  const entries = Object.entries({ ...cache, [id]: entry })
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, max)

  return Object.fromEntries(entries)
}

/** A reloaded check keeps what an earlier load of the same job learned: its log lines and Haiku's line. */
function withKnownWhy(check: GhCheck, previous: readonly GhCheck[] | undefined, whyCache: Record<string, CachedLine>): GhCheck {
  if (check.state !== 'fail' || check.jobId === undefined) return check
  const before = previous?.find(one => one.jobId === check.jobId)
  const whyLine = before?.whyLine ?? (whyCache[String(check.jobId)]?.t || undefined)

  return { ...check, ...(before?.why ? { why: before.why } : {}), ...(whyLine ? { whyLine } : {}) }
}

/** The details still worth keeping: the listed items' and the opened row's. */
function keptDetails(details: Record<string, GhDetail> | undefined, state: GithubState): Record<string, GhDetail> | undefined {
  if (!details) return undefined
  const kept = Object.entries(details).filter(([id]) => id === state.ui?.openId || findItem(state, id) !== undefined)

  return kept.length === Object.keys(details).length ? details : Object.fromEntries(kept)
}

/** After a reload nothing is in flight: no poll, search, checks or log left marked as loading. */
function afterReload(state: GithubState): GithubState {
  const details = state.details
    ? Object.fromEntries(
        Object.entries(state.details).map(([id, detail]) => [
          id,
          { ...detail, isLoading: false, ...(detail.checks ? { checks: detail.checks.map(check => ({ ...check, isLogLoading: false })) } : {}) }
        ])
      )
    : undefined

  return {
    ...state,
    isLoading: false,
    ...(state.search ? { search: { ...state.search, isLoading: false } } : {}),
    ...(details ? { details } : {})
  }
}

/** Whether a reload left anything marked as loading (so a write is needed: every write redraws the Jira cards too). */
function hasLoadingLeft(state: GithubState): boolean {
  const details = Object.values(state.details ?? {})

  return Boolean(state.isLoading || state.search?.isLoading || details.some(detail => detail.isLoading || detail.checks?.some(check => check.isLogLoading)))
}

/** Whether a start that could not reach GitHub may be tried again: at the poll's cadence, then backing off. */
function isStartDue(state: GithubState, isShown: boolean, now: number): boolean {
  if (startFailedAt === undefined) return true
  const delay = nextPollDelay({ isShown, failures: Math.max(0, (state.failures ?? 0) - 1), pollSeconds: state.settings?.pollSeconds, now })

  return isPollDue(startFailedAt, delay, now)
}

function sameStatuses(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a)

  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key])
}

/**
 * The notices for a poll's new alerts: one each, or one summing them up when there are more than the band shows.
 * @example
 * // before: [{ id: 'rr:o/r#1', tone: 'info', title: '👀 Review requested: #1 Fix', topic: 'github' }], 100
 * // after:  [{ tone: 'info', title: '👀 Review requested: #1 Fix', topic: 'github:rr:o/r#1', at: 100 }]
 */
function alertNotices(fresh: readonly AlertCandidate[], at: number): NewNotice[] {
  const [first] = fresh
  if (!first) return []
  if (fresh.length > VISIBLE_NOTICES) {
    const tone: NoticeTone = fresh.some(alert => alert.tone === 'error') ? 'error' : 'info'

    return [{ tone, title: `🐙 ${fresh.length} GitHub updates`, detail: fresh.map(alert => alert.title).join('\n'), topic: first.topic, at }]
  }

  return fresh.map(alert => ({
    tone: alert.tone,
    title: alert.title,
    ...(alert.detail ? { detail: alert.detail } : {}),
    topic: `${alert.topic}:${alert.id}`,
    at
  }))
}

// --- engine calls ---

/** Tells the person something in the band above the prompt: errors stay until dismissed, the rest clear by themselves. */
async function notify($: EngineInterface, tone: NoticeTone, title: string, options: NoticeOptions = {}): Promise<void> {
  const at = await $.clock.now()
  await update($, noticesAtom, list => pushNotice(list, { tone, title, at, ...options }))
}

async function dropNoticeTopic($: EngineInterface, topic: string): Promise<void> {
  if (!(await read($, noticesAtom)).some(notice => notice.topic === topic)) return
  await update($, noticesAtom, list => dropTopics(list, [topic]))
}

/**
 * Runs a read-only `gh` command: the guard first, the `gh` that started last first, then the usual install folders
 * while none is found; at most GH_CONCURRENCY at once across the panel. Never throws.
 */
async function runGh($: EngineInterface, build: (gh: string) => string[], timeoutMs = GH_TIMEOUT_MS): Promise<RunOutcome> {
  let outcome = missingGh()
  for (const gh of ghCandidates()) {
    const argv = build(gh)
    if (!isAllowedArgv(argv)) return refusedRun(argv)
    await enter(ghGate)
    try {
      outcome = outcomeOf(await $.process.run(argv, { env: GH_ENV, timeoutMs }))
    } catch (error) {
      outcome = thrownRun(error)
    } finally {
      leave(ghGate)
    }
    if (outcome.exitCode !== NOT_STARTED) {
      rememberGh(gh)

      return outcome
    }
  }

  return outcome
}

async function runGit($: EngineInterface, argv: string[]): Promise<RunOutcome> {
  if (!isAllowedArgv(argv)) return refusedRun(argv)
  try {
    return outcomeOf(await $.process.run(argv, { timeoutMs: GIT_TIMEOUT_MS }))
  } catch (error) {
    return thrownRun(error)
  }
}

/** Opens the link with the first opener the machine has: `open` (macOS), `xdg-open` (Linux), `start` (Windows). */
async function openUrl($: EngineInterface, url: string): Promise<void> {
  const failures: string[] = []
  for (const argv of openCommands(url)) {
    if (!isAllowedArgv(argv)) {
      failures.push(`ClaudeDockula refused to open ${url}`)
      break
    }
    try {
      const { exitCode, stderr } = await $.process.run(argv, { timeoutMs: GIT_TIMEOUT_MS })
      if (exitCode === 0) return
      failures.push(firstLine(stderr) || `${argv[0]} exited with code ${exitCode}`)
    } catch (error) {
      failures.push(errorText(error))
    }
  }
  await notify($, 'error', "Couldn't open the browser", { detail: failures.join('\n'), topic: 'github-open' })
}

async function readDocDir($: EngineInterface): Promise<string | undefined> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  const home = await $.env.get('HOME').catch(() => undefined)

  return docDirOf(configDir ?? undefined, home ?? undefined)
}

async function isPlaced($: EngineInterface): Promise<boolean> {
  return bandPanelIds(readLayout(await read($, layoutAtom))).includes(PANEL_ID)
}

/** Whether some open dock shows the card expanded, not only its band tab. */
async function isCardShown($: EngineInterface): Promise<boolean> {
  const hidden = hiddenPaneIds(await $.ui.panes().catch(() => []))

  return isShownIn(await read($, layoutAtom), PANEL_ID, hidden)
}

async function changeUi($: EngineInterface, change: (ui: GhViewState) => GhViewState): Promise<void> {
  await update($, githubState, value => ({ ...value, ui: change(value.ui ?? {}) }))
}

async function changeDetail($: EngineInterface, id: string, change: (detail: GhDetail) => GhDetail): Promise<void> {
  await update($, githubState, value => ({ ...value, details: { ...value.details, [id]: change(value.details?.[id] ?? {}) } }))
}

async function changeCheck($: EngineInterface, id: string, jobId: number, change: (check: GhCheck) => GhCheck): Promise<void> {
  await changeDetail($, id, detail =>
    detail.checks ? { ...detail, checks: detail.checks.map(check => (check.jobId === jobId ? change(check) : check)) } : detail
  )
}

/** The settings saved for every session, read from the store each time so another session's change shows here too. */
async function loadSettings($: EngineInterface): Promise<GhSettings> {
  const settings = parseGhSettings(await $.store.get(STORE.settings).catch(() => undefined))
  const state = await read($, githubState)
  if (!state.isSettingsLoaded || JSON.stringify(state.settings) !== JSON.stringify(settings)) {
    await update($, githubState, value => ({ ...value, isSettingsLoaded: true, settings }))
  }

  return settings
}

async function saveSettings($: EngineInterface, change: (settings: GhSettings) => GhSettings): Promise<GhSettings> {
  const settings = change(parseGhSettings(await $.store.get(STORE.settings).catch(() => undefined)))
  await $.store.set(STORE.settings, settings).catch(() => undefined)
  await update($, githubState, value => ({ ...value, isSettingsLoaded: true, settings }))

  return settings
}

/** A run's failure: one that never finished (timed out, refused) counts as GitHub out of reach. */
function failureOf(ran: RunOutcome): ReturnType<typeof classifyGhFailure> {
  return ran.exitCode === NOT_RUN ? 'network' : classifyGhFailure(`${ran.stderr}\n${ran.stdout}`, ran.exitCode)
}

/**
 * Finds a `gh` that starts, and whether it is signed in. `health` is left out when GitHub could not be reached
 * (offline, VPN down, rate limited): that is no sign-out, and the start is tried again under the backoff.
 */
async function checkGh($: EngineInterface): Promise<{ health?: GhHealth; healthError?: string }> {
  const ran = await runGh($, ghAuthStatus)
  if (ran.exitCode === NOT_STARTED) {
    rememberGh(undefined)
    const why = firstLine(ran.stderr)

    return { health: 'missing', ...(why ? { healthError: why } : {}) }
  }
  if (ran.exitCode === 0) return { health: 'ok' }
  const why = firstLine(ran.stderr) || firstLine(ran.stdout) || `gh auth status exited with code ${ran.exitCode}`
  const kind = failureOf(ran)
  if (kind === 'missing') return { health: 'missing', healthError: why }
  if (kind !== 'logged-out') return { healthError: why }
  // Offline, `gh auth status` calls a token it could not check invalid: GitHub itself tells the two apart.
  const probe = await runGh($, ghViewerCall)
  if (probe.exitCode === 0) return { health: 'ok' }

  return failureOf(probe) === 'logged-out' ? { health: 'logged-out', healthError: why } : { healthError: firstLine(probe.stderr) || why }
}

/** Whether Homebrew is at one of its usual install paths (no command run). */
async function hasHomebrew($: EngineInterface): Promise<boolean> {
  for (const path of BREW_PATHS) {
    if (await $.fs.exists(path).catch(() => false)) return true
  }

  return false
}

/** The session folder's repo; null when it is none, undefined when GitHub could not be asked (kept as it was). */
async function detectRepo($: EngineInterface): Promise<GhRepo | null | undefined> {
  const ran = await runGh($, ghRepoView)
  if (ran.exitCode === 0) {
    const parsed = parseRepoView(ran.stdout)

    return parsed.isOk ? parsed.value : null
  }
  const kind = classifyGhFailure(ran.stderr, ran.exitCode)

  return kind === 'network' || kind === 'rate-limited' ? undefined : null
}

async function readBranch($: EngineInterface): Promise<string | undefined> {
  const ran = await runGit($, GIT_BRANCH)

  return ran.exitCode === 0 ? ran.stdout.trim() || undefined : undefined
}

function pickCommand(names: readonly string[], base: string): string | undefined {
  return names.find(name => name === base) ?? names.find(name => name.endsWith(`:${base}`))
}

/** A `pr-review` skill the command list may not show: the repo's own, then the person's. */
async function findReviewSkill($: EngineInterface): Promise<string | undefined> {
  const top = await runGit($, GIT_TOPLEVEL)
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined))?.trim()
  const home = (await $.env.get('HOME').catch(() => undefined))?.trim()
  const claudeDir = configDir || (home ? `${home.replace(/\/+$/, '')}/.claude` : undefined)
  const root = top.exitCode === 0 ? top.stdout.trim() : ''
  const paths = [root ? `${root}/.claude/skills/pr-review/SKILL.md` : '', claudeDir ? `${claudeDir.replace(/\/+$/, '')}/skills/pr-review/SKILL.md` : '']
  for (const path of paths) {
    if (path !== '' && (await $.fs.exists(path).catch(() => false))) return 'pr-review'
  }

  return undefined
}

/** `/pr-review` (or a plugin's) for Review here, and the optional `/pr-summary` and `/commit-summary`. */
async function detectCommands($: EngineInterface): Promise<{ reviewCommand: string | null; commands: string[] }> {
  const names = (await $.command.list().catch(() => [])).map(command => command.name)
  const reviewCommand = pickCommand(names, 'pr-review') ?? (await findReviewSkill($)) ?? null
  const commands = ['pr-summary', 'commit-summary'].flatMap(base => pickCommand(names, base) ?? [])

  return { reviewCommand, commands }
}

/** GitHub could not be reached: the card says so and the start is tried again, never shown as signed out. */
async function startFailed($: EngineInterface, error: string): Promise<void> {
  if ((await read($, githubState)).health === 'ok') {
    // The lists stay; the poll reports its own failure and backs off.
    isStarted = true

    return
  }
  startFailedAt = await $.clock.now()
  await update($, githubState, value => ({ ...value, health: undefined, healthError: undefined, error, failures: (value.failures ?? 0) + 1, isLoading: false }))
}

/** Once per session, and again after ↻: the settings, `gh`, the repo, the branch and the commands. */
async function startGithub($: EngineInterface): Promise<void> {
  await loadSettings($)
  const checked = await checkGh($)
  if (checked.health === undefined) {
    await startFailed($, checked.healthError ?? "Couldn't reach GitHub")

    return
  }
  startFailedAt = undefined
  if (checked.health !== 'ok') {
    const hasBrew = checked.health === 'missing' && (await hasHomebrew($))
    await update($, githubState, value => ({ ...value, health: checked.health, healthError: checked.healthError, hasBrew, isLoading: false }))
    isStarted = true

    return
  }
  const [repo, branch, commands] = await Promise.all([detectRepo($), readBranch($), detectCommands($)])
  await update($, githubState, (value): GithubState => ({
    ...value,
    health: 'ok',
    healthError: undefined,
    ...(repo === undefined ? {} : { currentRepo: repo }),
    branch,
    reviewCommand: commands.reviewCommand,
    commands: commands.commands
  }))
  isStarted = true
}

async function ensureStarted($: EngineInterface): Promise<void> {
  if (isStarted) return
  starting ??= startGithub($)
  try {
    await starting
  } finally {
    starting = undefined
  }
}

/** Records this poll's alerts in the store's ledger, which every session shares, and posts only the new ones. */
async function raiseAlerts($: EngineInterface, lists: ListsResult, scopeSig: string): Promise<void> {
  const now = await $.clock.now()
  const ledger = parseLedger(await $.store.get(STORE.alerted).catch(() => undefined))
  const taken = takeNewAlerts(ledger, deriveListAlerts(lists), scopeSig, now)
  if (taken.isChanged) await $.store.set(STORE.alerted, pruneLedger(taken.ledger, now)).catch(() => undefined)
  const notices = alertNotices(taken.fresh, now)
  if (notices.length > 0) await update($, noticesAtom, list => notices.reduce(pushNotice, list))
}

async function failPoll($: EngineInterface, ran: RunOutcome, parseError: string | undefined): Promise<void> {
  const kind = ran.exitCode === 0 ? 'other' : classifyGhFailure(ran.stderr, ran.exitCode)
  const why = (ran.exitCode === 0 ? parseError : firstLine(ran.stderr)) || parseError || `gh exited with code ${ran.exitCode}`
  if (kind === 'missing' || kind === 'logged-out') {
    // Polling stops until ↻; the card says how to fix it.
    await update($, githubState, value => ({ ...value, health: kind, healthError: why, isLoading: false }))

    return
  }
  const before = await read($, githubState)
  await update($, githubState, value => ({ ...value, isLoading: false, error: why, failures: (value.failures ?? 0) + 1 }))
  if ((before.failures ?? 0) === 0) await notify($, 'error', "Couldn't load GitHub", { detail: why, topic: POLL_TOPIC })
}

/** One GraphQL call for the three lists, then the alerts, the Jira statuses and the one-liners. */
async function poll($: EngineInterface): Promise<void> {
  try {
    await pollLists($)
  } catch (error) {
    // Only an engine call failing unexpectedly lands here: never leave the card marked as loading.
    await update($, githubState, value => ({ ...value, isLoading: false, error: errorText(error) }))
  }
}

async function pollLists($: EngineInterface): Promise<void> {
  await ensureStarted($)
  await loadSettings($)
  const state = await read($, githubState)
  if (state.health !== 'ok') return
  const request = ++latestPoll
  const now = await $.clock.now()
  lastPollAt = now
  const query = listsQueryOf(state)
  const { ticketPattern } = parseSettings(await $.store.get(SETTINGS_KEY).catch(() => undefined))
  if (!state.isLoading) await update($, githubState, value => ({ ...value, isLoading: true }))
  const [ran, branch] = await Promise.all([runGh($, gh => ghListsCall(gh, query)), readBranch($)])
  if (request !== latestPoll) return
  const isJson = ran.exitCode === 0 || ran.stdout.trim().startsWith('{')
  const parsed = isJson ? parseListsResponse(ran.stdout, ticketPattern) : undefined
  if (!parsed?.isOk) {
    await failPoll($, ran, parsed?.error)

    return
  }
  const lists = parsed.value
  rateResetAt = lists.rateResetAt
  const resetAt = lists.rateResetAt === undefined ? Number.NaN : Date.parse(lists.rateResetAt)
  const isRateLow = lists.rateRemaining !== undefined && lists.rateRemaining < RATE_FLOOR && !Number.isNaN(resetAt)
  await update($, githubState, value => {
    const next: GithubState = {
      ...value,
      login: lists.login,
      review: lists.review,
      mine: lists.mine,
      issues: lists.issues,
      rateRemaining: lists.rateRemaining,
      pausedUntil: isRateLow ? resetAt + RATE_SLACK_MS : undefined,
      updatedAt: now,
      failures: 0,
      error: undefined,
      isLoading: false,
      branch: branch ?? value.branch
    }

    return { ...next, details: keptDetails(value.details, next) }
  })
  if ((state.failures ?? 0) > 0) await dropNoticeTopic($, POLL_TOPIC)
  await raiseAlerts($, lists, scopeSignature(query.scope, query.repos))
  detach(joinJiraStatuses($))
  detach(fillOneLiners($))
}

/**
 * The Jira status of each listed ticket: what the Jira panel already knows, else at most a few reads per poll through
 * its configured server, each kept a while. A refusal stops the reads until ↻, silently: the rows just show the key.
 */
async function joinJiraStatuses($: EngineInterface): Promise<void> {
  const jira = await read($, jiraState)
  const fromJira = jiraStatusesFromState(jira)
  const state = await read($, githubState)
  const items = [...(state.review ?? []), ...(state.mine ?? []), ...(state.issues ?? [])]
  const server = jira.settings?.jira ?? parseSettings(await $.store.get(SETTINGS_KEY).catch(() => undefined)).jira
  const now = await $.clock.now()
  const recent: Record<string, string> = { ...fromJira }
  for (const [key, at] of jiraReadAt) if (now - at < JIRA_STATUS_TTL_MS) recent[key] ??= ''
  const keys = server && !state.isJiraRefused ? missingTicketKeys(items, recent, MAX_JIRA_READS_PER_POLL) : []
  const fetched: Record<string, string> = {}
  let isRefused = false
  for (const key of keys) {
    if (!server || isRefused) break
    jiraReadAt.set(key, now)
    try {
      const result = await $.mcp.call(server.server, 'getJiraIssue', jiraIssueArgs(server.flavour, server.site.cloudId, key))
      const parsed = parseJiraIssue(result, server.site.url)
      if (parsed.isOk && parsed.issue.status) fetched[key] = parsed.issue.status
      else if (!parsed.isOk && isPermissionDenial(parsed.error)) isRefused = true
    } catch {
      isRefused = true
    }
  }
  if (!isRefused && sameStatuses(state.jiraStatus ?? {}, { ...state.jiraStatus, ...fromJira, ...fetched })) return
  await update($, githubState, value => ({
    ...value,
    jiraStatus: { ...value.jiraStatus, ...fromJira, ...fetched },
    ...(isRefused ? { isJiraRefused: true } : {})
  }))
}

/** One Haiku line, at most HAIKU_CONCURRENCY at once; undefined when it gave none. */
async function askHaiku($: EngineInterface, ask: ModelAsk): Promise<string | undefined> {
  await enter(haikuGate)
  try {
    const result = await $.model.complete({ model: 'haiku', system: ask.system, prompt: ask.prompt, maxTokens: ask.maxTokens, timeoutMs: HAIKU_TIMEOUT_MS })

    return result.isAnswered ? result.text : undefined
  } catch {
    return undefined
  } finally {
    leave(haikuGate)
  }
}

async function rememberLine($: EngineInterface, storeKey: string, id: string, entry: CachedLine, max: number): Promise<void> {
  await enter(storeGate)
  try {
    const cache = readCache(await $.store.get(storeKey).catch(() => undefined))
    await $.store.set(storeKey, withCached(cache, id, entry, max)).catch(() => undefined)
  } finally {
    leave(storeGate)
  }
}

async function askOneLiner($: EngineInterface, item: GhItem): Promise<void> {
  askedOneLiners.add(item.id)
  try {
    const text = await askHaiku($, oneLinerAsk(item))
    // No answer is kept as an empty line, so it is asked again only once the item changes.
    const line = text === undefined ? '' : cleanOneLine(text)
    await rememberLine($, STORE.oneLiners, item.id, { u: item.updatedAt, t: line, at: await $.clock.now() }, MAX_ONE_LINERS)
    if (line !== '') await update($, githubState, value => ({ ...value, oneLiners: { ...value.oneLiners, [item.id]: line } }))
  } finally {
    askedOneLiners.delete(item.id)
  }
}

/** Haiku one-liners for the rows drawn while the card shows, kept per item until it changes. */
async function fillOneLiners($: EngineInterface): Promise<void> {
  const state = await read($, githubState)
  if (state.health !== 'ok' || state.settings?.isHaikuOn === false) return
  const items = listItemsOf(state).slice(0, state.ui?.shown ?? DEFAULT_SHOWN)
  if (items.length === 0 || !(await isCardShown($))) return
  const cache = readCache(await $.store.get(STORE.oneLiners).catch(() => undefined))
  const known: Record<string, string> = {}
  const asks: GhItem[] = []
  for (const item of items) {
    const cached = cache[item.id]
    if (cached?.u === item.updatedAt) {
      if (cached.t !== '' && state.oneLiners?.[item.id] !== cached.t) known[item.id] = cached.t
    } else if (!askedOneLiners.has(item.id)) {
      asks.push(item)
    }
  }
  if (Object.keys(known).length > 0) await update($, githubState, value => ({ ...value, oneLiners: { ...value.oneLiners, ...known } }))
  await Promise.all(asks.map(item => askOneLiner($, item)))
}

/** Why each failed job failed: its log's telling lines, then Haiku's one line on them; at most three jobs, one by one. */
async function explainFailures($: EngineInterface, item: GhItem, checks: readonly GhCheck[]): Promise<void> {
  const failed = checks.filter(check => check.state === 'fail').slice(0, MAX_FAILED_LOGS)
  const isHaikuOn = (await read($, githubState)).settings?.isHaikuOn !== false
  // A job Haiku had no line for is cached as '' and not asked again.
  const whyCache = readCache(await $.store.get(STORE.ciWhy).catch(() => undefined))
  for (const check of failed) {
    const { runId, jobId } = check
    if (runId === undefined || jobId === undefined) continue
    let why = check.why
    if (why === undefined) {
      await changeCheck($, item.id, jobId, one => ({ ...one, isLogLoading: true }))
      const ran = await runGh($, gh => ghJobLog(gh, item.repo, runId, jobId), LONG_TIMEOUT_MS)
      if (ran.exitCode === 0) {
        const excerpt = excerptFailedLog(ran.stdout)
        why = excerpt.lines.length > 0 ? excerpt.lines : excerpt.problem ? [excerpt.problem] : []
      }
      const lines = why
      await changeCheck($, item.id, jobId, one => ({ ...one, isLogLoading: false, ...(lines ? { why: lines } : {}) }))
    }
    if (!isHaikuOn || check.whyLine !== undefined || whyCache[String(jobId)] !== undefined || !why || why.length === 0) continue
    const text = await askHaiku($, ciWhyAsk({ ...check, why }))
    const line = text === undefined ? '' : cleanOneLine(text)
    await rememberLine($, STORE.ciWhy, String(jobId), { t: line, at: await $.clock.now() }, MAX_CI_WHY)
    if (line !== '') await changeCheck($, item.id, jobId, one => ({ ...one, whyLine: line }))
  }
}

/** An opened PR's checks (kept a minute unless forced), then why the failed ones failed; a load under way is joined. */
function loadDetail($: EngineInterface, id: string, isForced: boolean): Promise<void> {
  const inFlight = detailLoads.get(id)
  if (inFlight) return inFlight
  const load = readDetail($, id, isForced).finally(() => detailLoads.delete(id))
  detailLoads.set(id, load)

  return load
}

async function readDetail($: EngineInterface, id: string, isForced: boolean): Promise<void> {
  const state = await read($, githubState)
  const item = findItem(state, id)
  if (item?.kind !== 'pr' || state.health !== 'ok') return
  const cached = state.details?.[id]
  const now = await $.clock.now()
  if (!isForced && cached?.checks && cached.loadedAt !== undefined && now - cached.loadedAt < DETAIL_REFRESH_MS) return
  await changeDetail($, id, detail => ({ ...detail, isLoading: true, error: undefined }))
  const ran = await runGh($, gh => ghChecks(gh, item.repo, item.number))
  const hasNoChecks = ran.stdout.trim() === '' && NO_CHECKS.test(ran.stderr)
  const parsed = hasNoChecks ? { isOk: true as const, value: [] } : parseChecks(ran.stdout)
  if (!parsed.isOk) {
    const error = firstLine(ran.stderr) || parsed.error
    await changeDetail($, id, detail => ({ ...detail, isLoading: false, error, loadedAt: now }))

    return
  }
  const whyCache = readCache(await $.store.get(STORE.ciWhy).catch(() => undefined))
  const checks = parsed.value.map(check => withKnownWhy(check, cached?.checks, whyCache))
  await changeDetail($, id, () => ({ checks, loadedAt: now, isLoading: false }))
  await explainFailures($, item, checks)
}

/** The opened row's pending checks again, every minute while the card shows. */
async function refreshOpenDetail($: EngineInterface, now: number): Promise<void> {
  const state = await read($, githubState)
  const openId = state.ui?.openId
  if (!openId) return
  const detail = state.details?.[openId]
  const isPending = detail?.checks?.some(check => check.state === 'pending') ?? false
  if (isPending && detail?.loadedAt !== undefined && now - detail.loadedAt >= DETAIL_REFRESH_MS) await loadDetail($, openId, true)
}

/** Every 30 s while the panel is on some dock: a poll when one is due (cadence, backoff, rate limit), then the opened row. */
async function tick($: EngineInterface): Promise<void> {
  if (!(await isPlaced($))) return
  const now = await $.clock.now()
  const isShown = await isCardShown($)
  if (!isStarted && !isStartDue(await read($, githubState), isShown, now)) return
  await ensureStarted($)
  const state = await read($, githubState)
  if (state.health !== 'ok') return
  const isPaused = state.pausedUntil !== undefined && now < state.pausedUntil
  const delay = nextPollDelay({
    isShown,
    failures: state.failures ?? 0,
    pollSeconds: state.settings?.pollSeconds,
    rateRemaining: state.rateRemaining,
    rateResetAt,
    now
  })
  if (!isPaused && !state.isLoading && isPollDue(lastPollAt ?? state.updatedAt, delay, now)) await poll($)
  if (isShown) await refreshOpenDetail($, now)
}

/** The card came into view: data older than half a minute is read again, and the rows drawn get their one-liners. */
async function cardOpened($: EngineInterface): Promise<void> {
  await ensureStarted($)
  const state = await read($, githubState)
  if (state.health !== 'ok') return
  const now = await $.clock.now()
  const isStale = state.updatedAt === undefined || now - state.updatedAt > STALE_MS
  const isPaused = state.pausedUntil !== undefined && now < state.pausedUntil
  if (isStale && !state.isLoading && !isPaused) await poll($)
  else await fillOneLiners($)
}

/** ↻: `gh`, the repo and the branch checked again, the backoff and a Jira refusal forgotten, then a poll. */
async function refreshAll($: EngineInterface): Promise<void> {
  isStarted = false
  jiraReadAt.clear()
  await update($, githubState, value => ({ ...value, failures: 0, pausedUntil: undefined, error: undefined, isJiraRefused: false }))
  await ensureStarted($)
  await poll($)
  const openId = (await read($, githubState)).ui?.openId
  if (openId) await loadDetail($, openId, true)
}

async function runSearch($: EngineInterface, query: string): Promise<void> {
  await ensureStarted($)
  const request = ++latestSearch
  await update($, githubState, (value): GithubState => ({
    ...value,
    search: { query, isLoading: true },
    ui: { ...value.ui, view: 'search', openId: undefined, menuId: undefined, shown: undefined }
  }))
  const state = await read($, githubState)
  const { ticketPattern } = parseSettings(await $.store.get(SETTINGS_KEY).catch(() => undefined))
  const ran = await runGh($, gh => ghSearchCall(gh, query, listsQueryOf(state)))
  if (request !== latestSearch) return
  const parsed = ran.exitCode === 0 || ran.stdout.trim().startsWith('{') ? parseSearchResponse(ran.stdout, ticketPattern) : undefined
  const error = parsed?.isOk ? undefined : firstLine(ran.stderr) || parsed?.error || `gh exited with code ${ran.exitCode}`
  await update($, githubState, value => {
    if (value.search?.query !== query) return value

    return { ...value, search: parsed?.isOk ? { query, items: parsed.value } : { query, error } }
  })
  detach(fillOneLiners($))
}

async function askSearch($: EngineInterface): Promise<void> {
  const options = { header: 'Search', options: [CLEAR_SEARCH, CANCEL] }
  const answer = await $.ui.ask('What should the GitHub panel search for in open pull requests and issues?', options).catch(() => undefined)
  if (answer === undefined || answer === CANCEL || answer.trim() === '') return
  if (answer === CLEAR_SEARCH) {
    latestSearch += 1
    await update($, githubState, value => ({ ...value, search: undefined, ui: { ...value.ui, openId: undefined, menuId: undefined } }))

    return
  }
  await runSearch($, answer.trim())
}

/** A repo the person picks from a few `gh search repos` matches for what they typed. */
async function pickFromSearch($: EngineInterface, typed: string, present: ReadonlySet<string>): Promise<string | undefined> {
  const found = await runGh($, gh => ghSearchRepos(gh, typed.replace(/^-+/, '')))
  const matches = parseSearchRepos(found.stdout)
    .filter(repo => !present.has(repo.toLowerCase()))
    .slice(0, MAX_REPO_CHOICES)
  if (matches.length === 0) {
    await notify($, 'info', `No repo matches “${typed}”`, { topic: REPOS_TOPIC })

    return undefined
  }
  const options = { header: 'Add repo', options: [...matches, CANCEL] }
  const answer = await $.ui.ask(`Which repo did you mean by “${typed}”?`, options).catch(() => undefined)

  return answer === undefined || answer === CANCEL ? undefined : repoFromText(answer)
}

/** ➕: a repo you pushed to lately, or one typed (`owner/name`, a URL, words to search); checked with GitHub, then kept for every session. */
async function addRepo($: EngineInterface): Promise<void> {
  await ensureStarted($)
  const state = await read($, githubState)
  if (state.health !== 'ok') return
  const present = new Set(reposOf(state).map(repo => repo.toLowerCase()))
  const recent = await runGh($, ghRecentRepos)
  const choices = parseRecentRepos(recent.stdout)
    .filter(repo => !present.has(repo.toLowerCase()))
    .slice(0, MAX_REPO_CHOICES)
  const question = 'Which repo should the GitHub panel follow too? Pick one, or type owner/name or words to search for.'
  const options = { header: 'Add repo', options: choices.length > 0 ? [...choices, CANCEL] : [CANCEL, ALL_REPOS] }
  const answer = await $.ui.ask(question, options).catch(() => undefined)
  if (answer === undefined || answer === CANCEL || answer.trim() === '') return
  if (answer === ALL_REPOS) {
    await saveSettings($, settings => ({ ...settings, scope: 'all' }))
    detach(poll($))

    return
  }
  const typed = answer.trim()
  const repo = choices.find(choice => choice === typed) ?? repoFromText(typed) ?? (await pickFromSearch($, typed, present))
  if (!repo) return
  const checked = await runGh($, gh => ghRepoValidate(gh, repo))
  const parsed = checked.exitCode === 0 ? parseRepoView(checked.stdout) : undefined
  if (!parsed?.isOk) {
    await notify($, 'error', `Couldn't find ${repo}`, { detail: firstLine(checked.stderr) || 'GitHub did not know it', topic: REPOS_TOPIC })

    return
  }
  const name = parsed.value.nameWithOwner
  if (present.has(name.toLowerCase())) {
    await notify($, 'info', `${name} is already listed`, { topic: REPOS_TOPIC })

    return
  }
  await saveSettings($, settings => ({ ...settings, extraRepos: [...(settings.extraRepos ?? []), name] }))
  await notify($, 'success', `Added ${name}`, { topic: REPOS_TOPIC })
  detach(poll($))
}

async function removeRepo($: EngineInterface, name: string): Promise<void> {
  const isListed = (repo: string) => repo.toLowerCase() === name.toLowerCase()
  if (!(await read($, githubState)).settings?.extraRepos?.some(isListed)) return
  await saveSettings($, settings => {
    const { extraRepos = [], ...rest } = settings
    const kept = extraRepos.filter(repo => !isListed(repo))

    return kept.length > 0 ? { ...rest, extraRepos: kept } : rest
  })
  detach(poll($))
}

/** Fills a command into an empty prompt box for the person to send; a draft in the box is never touched. */
async function fillEmptyBox($: EngineInterface, text: string, hint: string, topic: string): Promise<void> {
  const box = await $.prompt.read().catch(() => ({ text: '' }))
  if (box.text.trim() !== '') {
    await notify($, 'info', 'Clear the prompt box first', { topic })

    return
  }
  // Insert, not replace: a box that read empty but was not keeps the person's draft.
  const filled = await $.prompt.fill({ text, mode: 'insert' })
  if (filled.isFilled) await notify($, 'info', hint, { topic })
  else await notify($, 'error', "The prompt box didn't take it", { topic })
}

async function insertText($: EngineInterface, text: string, success: string, topic: string): Promise<void> {
  const filled = await $.prompt.fill({ text, mode: 'insert' })
  if (filled.isFilled) await notify($, 'success', success, { topic })
  else await notify($, 'error', "The prompt box didn't take it", { topic })
}

async function readThread($: EngineInterface, item: GhItem, topic: string): Promise<FullThread | undefined> {
  await notify($, 'info', `Reading #${item.number}…`, { topic })
  const ran = await runGh($, gh => ghThreadCall(gh, item.repo, item.number, item.kind))
  const parsed = ran.exitCode === 0 ? parseThreadResponse(ran.stdout, item.repo, item.kind) : undefined
  if (parsed?.isOk) return parsed.value
  await notify($, 'error', `Couldn't read #${item.number}`, { detail: firstLine(ran.stderr) || parsed?.error || 'gh gave nothing back', topic })

  return undefined
}

/** A file under the panel's folder holding what could not go on the clipboard. */
async function writeClipFile($: EngineInterface, text: string, item: GhItem): Promise<string | undefined> {
  const dir = await readDocDir($)
  if (!dir) return undefined
  const path = `${dir}/clip-${item.number}-${fileStamp(await $.clock.now())}.md`
  try {
    await $.fs.write(path, text)

    return path
  } catch {
    return undefined
  }
}

/** On the clipboard of the surface pressed; when that fails, or the text is too big for it, into a file. */
async function copyText($: EngineInterface, text: string, what: string, item: GhItem, surface: RenderSurface): Promise<void> {
  if (text.length <= COPY_MAX_CHARS) {
    const copied = await $.ui.copy({ text, surface }).catch((): UiCopyResult => ({ isCopied: false, reason: 'refused' }))
    if (copied.isCopied) {
      await notify($, 'success', `${what} copied`, { topic: COPY_TOPIC })

      return
    }
  }
  const path = await writeClipFile($, text, item)
  if (path) await notify($, 'info', `${what} saved to a file instead of the clipboard`, { detail: path, topic: COPY_TOPIC })
  else await notify($, 'error', `Couldn't copy the ${what.toLowerCase()}`, { topic: COPY_TOPIC })
}

async function copyThread($: EngineInterface, item: GhItem, isWhole: boolean, surface: RenderSurface): Promise<void> {
  const topic = `github-act-${item.id}`
  const thread = await readThread($, item, topic)
  if (!thread) return
  await dropNoticeTopic($, topic)
  await copyText($, isWhole ? fullThreadMarkdown(thread) : titleBodyMarkdown(thread), isWhole ? 'Thread' : 'Title and body', item, surface)
}

async function copyDiff($: EngineInterface, item: GhItem, surface: RenderSurface): Promise<void> {
  const ran = await runGh($, gh => ghDiff(gh, item.repo, item.number), LONG_TIMEOUT_MS)
  if (ran.exitCode !== 0) {
    await notify($, 'error', `Couldn't read the diff of #${item.number}`, { detail: firstLine(ran.stderr) || 'gh gave nothing back', topic: COPY_TOPIC })

    return
  }
  await copyText($, ran.stdout, 'Diff', item, surface)
}

async function fixCi($: EngineInterface, item: GhItem): Promise<void> {
  const topic = `github-act-${item.id}`
  await notify($, 'info', `Reading why #${item.number} fails…`, { topic })
  // Waits for a load the opened row started, so the prompt carries the failed jobs and their logs.
  await loadDetail($, item.id, false).catch(() => undefined)
  const state = await read($, githubState)
  const failed = (state.details?.[item.id]?.checks ?? []).filter(check => check.state === 'fail')
  const place = prPlaceOf(item, state.currentRepo?.nameWithOwner, state.branch)
  await insertText($, fixCiPrompt(item, failed, place), `Fixing CI of #${item.number}: added to the prompt`, topic)
}

async function runAction($: EngineInterface, action: GhAction, id: string, surface: RenderSurface): Promise<void> {
  const state = await read($, githubState)
  const item = findItem(state, id)
  const topic = `github-act-${id}`
  if (!item) {
    await notify($, 'info', `${id} is no longer listed`, { topic })

    return
  }
  switch (action) {
    case 'review-here': {
      const text = reviewHereText(state.reviewCommand, item.url)
      if (state.reviewCommand) await fillEmptyBox($, text, `Press Enter to review #${item.number} here`, topic)
      else await insertText($, text, `Review of #${item.number}: added to the prompt`, topic)

      return
    }
    case 'checkout': {
      const command = checkoutCommand(item, state.currentRepo?.nameWithOwner)
      if (command) await fillEmptyBox($, command, `Press Enter to check out #${item.number}`, topic)
      else await notify($, 'info', `#${item.number} is not in this folder's repo`, { topic })

      return
    }
    case 'fix-ci':
      return fixCi($, item)
    case 'address': {
      const thread = await readThread($, item, topic)
      if (thread) await insertText($, addressCommentsPrompt(thread), `Review comments of #${item.number}: added to the prompt`, topic)

      return
    }
    case 'add-link':
      return insertText($, linkMarkdown(item), `#${item.number} link added to the prompt`, topic)
    case 'add-full': {
      const thread = await readThread($, item, topic)
      if (thread) await insertText($, fullThreadPrompt(thread), `#${item.number} thread added to the prompt`, topic)

      return
    }
    case 'copy-link':
      return copyText($, item.url, 'Link', item, surface)
    case 'copy-body':
      return copyThread($, item, false, surface)
    case 'copy-thread':
      return copyThread($, item, true, surface)
    case 'copy-diff':
      return copyDiff($, item, surface)
    case 'open':
      return openUrl($, item.url)
    case 'open-ticket':
      return openTicket($, item, topic)
    default:
      // githubWork.tsx answers its own actions (WORK_ACTIONS).
      return undefined
  }
}

/** The row's Jira ticket in the browser: the Jira panel's link for it, else the configured site's. */
async function openTicket($: EngineInterface, item: GhItem, topic: string): Promise<void> {
  const key = item.ticket
  if (!key) return
  const jira = await read($, jiraState)
  const known = [...(jira.tickets ?? []), ...(jira.issue ? [jira.issue] : [])].find(ticket => ticket.key === key)?.url
  const site = (jira.settings?.jira ?? parseSettings(await $.store.get(SETTINGS_KEY).catch(() => undefined)).jira)?.site.url
  const url = known ?? (site ? `${site.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}` : undefined)
  if (url) await openUrl($, url)
  else await notify($, 'info', `Set up the Jira panel to open ${key}`, { topic })
}

async function openRow($: EngineInterface, id: string | undefined): Promise<void> {
  await changeUi($, ui => ({ ...ui, openId: id, menuId: undefined }))
  if (id) detach(loadDetail($, id, false))
}

async function showMore($: EngineInterface): Promise<void> {
  await changeUi($, ui => ({ ...ui, shown: (ui.shown ?? DEFAULT_SHOWN) + DEFAULT_SHOWN }))
  detach(fillOneLiners($))
}

/** ⚙ in the card's header or Done: the settings open or close; opening reads what this client can notify with. */
async function toggleSettings($: EngineInterface): Promise<void> {
  const isOpening = (await read($, githubState)).ui?.isSettingsOpen !== true
  await changeUi($, ui => ({ ...ui, isSettingsOpen: isOpening }))
  if (!isOpening) return
  const notifyChannel = notifyChannelOf(await $.config.list().catch(() => undefined))
  if ((await read($, githubState)).notifyChannel !== notifyChannel) await update($, githubState, value => ({ ...value, notifyChannel }))
}

async function toggleHaiku($: EngineInterface): Promise<void> {
  const settings = await saveSettings($, current => ({ ...current, isHaikuOn: current.isHaikuOn === false }))
  if (settings.isHaikuOn === false) await update($, githubState, value => ({ ...value, oneLiners: undefined }))
  else detach(fillOneLiners($))
}

/** Core wiring: settings, `gh` health, polling, alerts, Jira statuses, one-liners, CI details and every row action. */
export function registerGithubHooks(on: On): void {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    ticker?.cancel()
    isStarted = false
    if (hasLoadingLeft(await read($, githubState))) await update($, githubState, afterReload)
    ticker = $.clock.every(TICK_MS, () => detach(tick($)))
    if (await isPlaced($)) detach(poll($))

    return started
  })

  // Opening the card (its band tab, or its minimize toggle in any dock) reads stale data again.
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(tab|main-toggle|\d+-toggle)-github$/ }, async ($, e, next) => {
    const pressed = await next(e)
    if (await isPlaced($)) detach(cardOpened($))

    return pressed
  })

  // Ticking the panel into a view in ⚙ Manage starts it at once rather than at the next tick.
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(main|\d+)-enable-\d+-github$/ }, async ($, e, next) => {
    const pressed = await next(e)
    if (await isPlaced($)) detach(cardOpened($))

    return pressed
  })

  // githubOverlap.tsx hooks ↻ too, beneath this one.
  on('ui.press', { plugin: 'claudedockula', element: 'github-refresh' }, async ($, e, next) => {
    const pressed = await next(e)
    detach(refreshAll($))

    return pressed
  })

  // The card header's ⚙ (the dock opens a minimized card first) and the settings' Done.
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(main|\d+)-settings-github$/ }, async ($, e, next) => {
    const pressed = await next(e)
    await toggleSettings($)

    return pressed
  })

  on('ui.press', { plugin: 'claudedockula', element: 'github-settings' }, async ($, e) => {
    await toggleSettings($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^github-review-(done-(notice|bell|notify)|model-(sonnet|opus)|web-(on|off))$/ }, async ($, e) => {
    const [, kind = '', value = ''] = /^github-review-(done|model|web)-(.+)$/.exec(e.element) ?? []
    if (kind === 'done' && isReviewDone(value)) await saveSettings($, settings => ({ ...settings, reviewDone: value }))
    if (kind === 'model' && isReviewModel(value)) await saveSettings($, settings => ({ ...settings, reviewModel: value }))
    if (kind === 'web') await saveSettings($, settings => ({ ...settings, isReviewWebOn: value === 'on' }))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'github-more' }, async ($, e) => {
    await showMore($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^github-view-(review|mine|issues|search)$/ }, async ($, e) => {
    const view = e.element.slice(KEY.view.length)
    if (isView(view)) await changeUi($, ui => ({ ...ui, view, openId: undefined, menuId: undefined, shown: undefined }))
    detach(fillOneLiners($))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^github-scope-(repos|all)$/ }, async ($, e) => {
    const scope: GhScope = e.element.slice(KEY.scope.length) === 'all' ? 'all' : 'repos'
    await saveSettings($, settings => ({ ...settings, scope }))
    detach(poll($))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'github-repo-add' }, async ($, e) => {
    detach(addRepo($))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^github-repo-remove-/ }, async ($, e) => {
    const name = decodeRepoName(e.element.slice(KEY.repoRemove.length))
    if (name) await removeRepo($, name)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'github-search' }, async ($, e) => {
    detach(askSearch($))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^github-poll-(60|90|300)$/ }, async ($, e) => {
    const pollSeconds = Number(e.element.slice(KEY.poll.length))
    await saveSettings($, settings => ({ ...settings, pollSeconds }))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'github-haiku-toggle' }, async ($, e) => {
    await toggleHaiku($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'github-install' }, async ($, e) => {
    await fillEmptyBox($, '! brew install gh', 'Press Enter to install gh, then gh auth login and ↻ Refresh', 'github-install')

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'github-login' }, async ($, e) => {
    await fillEmptyBox($, '! gh auth login', 'Press Enter to sign in to GitHub, then ↻ Refresh', 'github-login')

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^github-row-/ }, async ($, e) => {
    const id = decodeItemId(e.element.slice(KEY.row.length))
    const openId = (await read($, githubState)).ui?.openId
    if (id) await openRow($, openId === id ? undefined : id)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^github-menu-/ }, async ($, e) => {
    const id = decodeItemId(e.element.slice(KEY.menu.length))
    if (id) await changeUi($, ui => ({ ...ui, reviewMenu: undefined, overlapMenu: undefined, menuId: ui.menuId === id ? undefined : id }))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^github-act-/ }, async ($, e) => {
    const act = parseActKey(e.element)
    if (act && !WORK_ACTIONS.includes(act.action)) {
      await changeUi($, ui => ({ ...ui, menuId: undefined }))
      detach(runAction($, act.action, act.id, e.surface))
    }

    return { element: e.element }
  })

  // The list Client's posts; the actions githubWork.tsx answers go on to its hook beneath this one.
  on('ui.message', { element: /^github-list-/ }, async ($, e, next) => {
    const message = parseListMessage(e.data)
    if (message?.type === 'act' && WORK_ACTIONS.includes(message.action)) return next(e)
    if (message?.type === 'open') await openRow($, message.id ?? undefined)
    else if (message?.type === 'more') await showMore($)
    else if (message?.type === 'act') detach(runAction($, message.action, message.id, e.surface))

    return {}
  })
}

export const githubPanel: DockPanel = {
  id: 'github',
  title: 'GitHub',
  icon: '🐙',
  description: 'Your review requests, PRs and issues: CI, reviews, Jira, overlaps; right-click or ⋯ for more',
  isBuiltIn: true,
  isOptIn: true,
  hasSettings: true,
  revision: 3,
  whatsNew: 'Background reviews run in their own locked-down session on a clean copy of the PR, and ask you in the card'
}
