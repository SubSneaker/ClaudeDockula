import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderSurface, Timer, UiCopyResult } from 'claude-code'

import type { GgHostState, GgSetupView, GhCheck, GhDetail, GhItem, GhRepo, GhReviewDone, GhReviewModel, GhScope, GhSettings, GhView, GhViewState, GitgudState, NoticeTone } from '../../types'
import { DEFAULT_LAYOUT, bandPanelIds, hiddenPaneIds, isShownIn, readLayout } from '../dock/layout'
import { NO_NOTICES, VISIBLE_NOTICES, dropTopics, pushNotice, type NewNotice } from '../dock/notices'
import { SETTINGS_KEY, openCommands, parseSettings } from '../settings'
import type { DockPanel } from './contract'
import { deriveListAlerts, parseLedger, pruneLedger, scopeSignature, takeNewAlerts, type AlertCandidate } from './gitgud/alerts'
import { GIT_BRANCH, GIT_TOPLEVEL } from './gitgud/argv'
import { ENV_TOKEN_NAMES } from './gitgud/credentials'
import {
  GIT_REMOTE_URLS,
  GIT_UPSTREAM,
  KNOWN_HOSTS,
  PROBE_PATHS,
  PROBE_TIMEOUT_MS,
  apiHostOf,
  cliStateOf,
  detectVerdict,
  gitGetUrl,
  interpretProbes,
  parseRemote,
  parseRemoteEntries,
  pickRemote,
  probeUrl,
  providerOfHost,
  upstreamRemoteOf,
  type CliState,
  type DecidedBy,
  type GgDetect,
  type ParsedRemote,
  type TokenState
} from './gitgud/detect'
import { canonicalItemId, canonicalRepoKey, isSessionRepo, parseRepoKey, repoKeyOf, repoKeyOfRepo } from './gitgud/ids'
import { adapterOfRepo, currentKeyOf, hostInfoOf, repoRefOf, type HostInfo } from './gitgud/hosts'
import { jiraStatusesFromState, missingTicketKeys } from './gitgud/jiraLink'
import { excerptFailedLog } from './gitgud/logs'
import { MIGRATED_KEY, MIGRATION_READ_KEYS, MIGRATION_VERSION, planMigration } from './gitgud/migrate'
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
} from './gitgud/model'
import { classifyGhFailure, parseRepoView, type FullThread, type ListsResult, type Parsed } from './gitgud/parse'
import { isPollDue, nextPollDelay } from './gitgud/poll'
import { BITBUCKET_API_HOST } from './gitgud/providers/bitbucket'
import { isAllowedArgv } from './gitgud/guard'
import { GH_ENV, ghAuthStatus, ghRepoView } from './gitgud/providers/github'
import { GLAB_ENV } from './gitgud/providers/gitlab'
import { adapterOf } from './gitgud/providers'
import type { ListsCtx, Op, Outcome, ProviderAdapter, ProviderId, RepoRef, Req } from './gitgud/providers/types'
import { REVIEW_DONE, REVIEW_MODELS, notifyChannelOf } from './gitgud/review'
import {
  addressCommentsPrompt,
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
} from './gitgud/prompts'
import { findItem, listItemsOf, scopeOf } from './gitgud/rows'
import {
  NOT_RUN,
  createGate,
  enter,
  leave,
  outcomeOf,
  refusedRun,
  thrownRun,
  type Gate,
  type RunOutcome
} from './gitgud/run'
import {
  forgetTokens,
  hostConfigOf,
  isNoToken,
  outcomeOfRun,
  savedTokenWith,
  runOpWith,
  runReqWith,
  type RunnerIo,
  type RunOptions
} from './gitgud/runner'
import {
  SERVICE_NAMES,
  apiHostFromAnswer,
  bitbucketCheckMessage,
  bitbucketNoTokenMessage,
  bitbucketHostConfig,
  cliHostConfig,
  emailFromAnswer,
  emailQuestion,
  envNameFromAnswer,
  isDeclined,
  envQuestion,
  keychainAddCommand,
  parseServiceAnswer,
  parseTokenSource,
  serviceQuestion,
  tokenSourceQuestion,
  webAddressQuestion,
  parseHostSettings,
  withHostConfig,
  KEYCHAIN_SERVICE,
  type GgHostConfig,
  type HostSettings,
  type TokenFrom
} from './gitgud/setup'
import { parseJiraIssue } from './jira/parse'
import { errorText, isPermissionDenial, jiraIssueArgs } from './jira/servers'

export { drawGitgud, gitgudTabTone, summarizeGitgud } from './gitgud/draw'

// The engine follows `$` only into functions declared in the same file, so every function that takes `$`
// lives here; gitgud/* is pure. Every command goes through `runReq`, `runGit` or `openUrl`, which check
// `isAllowedArgv` or `isAllowedRequest` first: the panel only ever reads.

const PANEL_ID = 'gitgud'
const TICK_MS = 30_000
/** Opening the card reads data older than this again. */
const STALE_MS = 30_000
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
const POLL_TOPIC = 'gitgud-poll'
const SETUP_TOPIC = 'gitgud-setup'
const COPY_TOPIC = 'gitgud-copy'
const REPOS_TOPIC = 'gitgud-repos'
const REPO_URL = /^https?:\/\/([a-z0-9.-]+(?::\d+)?)\/([^?#\s]+)/i
/** Where a repo's path ends in a pasted link. */
const URL_TAIL = new Set(['-', 'pull', 'pulls', 'issues', 'merge_requests', 'pull-requests', 'tree', 'blob', 'commits', 'actions'])
const NO_CHECKS = /no checks reported/i
const DEFAULT_HOST = 'github.com'
const MAX_PROBE_PATHS = 5

const gitgudState = atom({ plugin: 'claudedockula', key: 'gitgud' } as const, {})
const jiraState = atom({ plugin: 'claudedockula', key: 'jira' } as const, {})
const layoutAtom = atom({ plugin: 'claudedockula', key: 'layout' } as const, DEFAULT_LAYOUT)
const noticesAtom = atom({ plugin: 'claudedockula', key: 'notices' } as const, NO_NOTICES)


/** Work a hook does not wait for: a failure in it ends there, never as an unhandled rejection. */
function detach(work: Promise<unknown>): void {
  work.catch(() => undefined)
}

/** A setup question or check is under way: a second press (or the card in another dock) does nothing until it ends. */
let isSetupBusy = false

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
    const repos = raw.extraRepos.flatMap((repo): string[] => (typeof repo === 'string' && parseRepoKey(repo) !== undefined ? [canonicalRepoKey(repo)] : []))
    if (repos.length > 0) settings.extraRepos = [...new Set(repos)]
  }
  const hosts = parseHostSettings(raw)
  if (hosts !== undefined) settings.hosts = hosts
  if ('defaultHost' in raw && typeof raw.defaultHost === 'string' && raw.defaultHost !== '') settings.defaultHost = raw.defaultHost.toLowerCase()
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

/** The session's repo, then the added ones, as repo keys, each once. */
function reposOf(state: GitgudState): string[] {
  const current = state.currentRepo ? [repoKeyOfRepo(state.currentRepo)] : []
  const repos = [...current, ...(state.settings?.extraRepos ?? [])]
  const seen = new Set<string>()

  return repos.filter(repo => {
    const key = repo.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)

    return true
  })
}

/** The host the session reads first, then the hosts of the added repos, each once. */
function hostsOf(state: GitgudState): HostInfo[] {
  const names = [state.host ?? state.settings?.defaultHost ?? DEFAULT_HOST, ...(state.settings?.extraRepos ?? []).map(repo => parseRepoKey(repo)?.host ?? '')]
  const infos = [...new Set(names)].flatMap(host => hostInfoOf(state, host) ?? [])

  return infos
}

function listsCtxOf(state: GitgudState, info: HostInfo, ticketPattern: string | undefined): ListsCtx {
  const repos = reposOf(state).flatMap(repo => repoRefOf(state, repo) ?? [])
  const login = state.hosts?.[info.host]?.login

  return {
    host: info.host,
    apiHost: info.apiHost,
    scope: scopeOf(state),
    repos: repos.filter(repo => repo.host === info.host),
    ...(login === undefined ? {} : { login }),
    ...(ticketPattern === undefined ? {} : { ticketPattern })
  }
}

/** The repo key from what the person typed: a repo key, `owner/name` on the session's host, or a link to a repo. */
function repoFromText(text: string, host: string): string | undefined {
  const trimmed = text.trim()
  const link = REPO_URL.exec(trimmed)
  if (link !== null) {
    const segments = (link[2] ?? '').split('/').filter(part => part !== '')
    const end = segments.findIndex(part => URL_TAIL.has(part))
    const path = (end < 0 ? segments : segments.slice(0, end)).map((part, at, all) => (at === all.length - 1 ? part.replace(/\.git$/, '') : part))
    const kept = (link[1] ?? '').toLowerCase() === DEFAULT_HOST ? path.slice(0, 2) : path

    return kept.length >= 2 ? repoKeyOf(link[1] ?? host, kept.join('/')) : undefined
  }
  const parsed = parseRepoKey(trimmed)
  if (parsed === undefined || trimmed.startsWith('-')) return undefined
  const parts = trimmed.split('/')
  if (parts.length === 2 || !(parts[0] ?? '').includes('.')) return repoKeyOf(host, trimmed)

  return canonicalRepoKey(trimmed)
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

/** A job's id as text, whichever service numbered it. */
function checkIdOf(check: GhCheck): string {
  return check.jobKey ?? (check.jobId === undefined ? '' : String(check.jobId))
}

/** The CI-why cache key: ids of two services never meet. */
function whyKeyOf(item: GhItem, jobId: string): string {
  return `${item.provider ?? 'github'}:${jobId}`
}

/** A reloaded check keeps what an earlier load of the same job learned: its log lines and Haiku's line. */
function withKnownWhy(item: GhItem, check: GhCheck, previous: readonly GhCheck[] | undefined, whyCache: Record<string, CachedLine>): GhCheck {
  const id = checkIdOf(check)
  if (check.state !== 'fail' || id === '') return check
  const before = previous?.find(one => checkIdOf(one) === id)
  const whyLine = before?.whyLine ?? (whyCache[whyKeyOf(item, id)]?.t || undefined)

  return { ...check, ...(before?.why ? { why: before.why } : {}), ...(whyLine ? { whyLine } : {}) }
}

/** The details still worth keeping: the listed items' and the opened row's. */
function keptDetails(details: Record<string, GhDetail> | undefined, state: GitgudState): Record<string, GhDetail> | undefined {
  if (!details) return undefined
  const kept = Object.entries(details).filter(([id]) => id === state.ui?.openId || findItem(state, id) !== undefined)

  return kept.length === Object.keys(details).length ? details : Object.fromEntries(kept)
}

/** After a reload nothing is in flight: no poll, search, checks or log left marked as loading. */
function afterReload(state: GitgudState): GitgudState {
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
function hasLoadingLeft(state: GitgudState): boolean {
  const details = Object.values(state.details ?? {})

  return Boolean(state.isLoading || state.search?.isLoading || details.some(detail => detail.isLoading || detail.checks?.some(check => check.isLogLoading)))
}

/** Whether a start that could not reach GitHub may be tried again: at the poll's cadence, then backing off. */
function isStartDue(state: GitgudState, isShown: boolean, now: number): boolean {
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
 * // before: [{ id: 'rr:o/r#1', tone: 'info', title: '👀 Review requested: #1 Fix', topic: 'gitgud' }], 100
 * // after:  [{ tone: 'info', title: '👀 Review requested: #1 Fix', topic: 'gitgud:rr:o/r#1', at: 100 }]
 */
function alertNotices(fresh: readonly AlertCandidate[], at: number): NewNotice[] {
  const [first] = fresh
  if (!first) return []
  if (fresh.length > VISIBLE_NOTICES) {
    const tone: NoticeTone = fresh.some(alert => alert.tone === 'error') ? 'error' : 'info'

    return [{ tone, title: `🐙 ${fresh.length} GitGud updates`, detail: fresh.map(alert => alert.title).join('\n'), topic: first.topic, at }]
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

/** The engine calls the shared runner makes: each is one `$` call, so the runner itself stays free of `$`. */
function ioOf($: EngineInterface): RunnerIo {
  const found = (value: Promise<string | undefined | null>) => value.then(text => text ?? undefined, () => undefined)

  return {
    cli: async (argv, cliEnv, timeoutMs) => {
      try {
        return outcomeOf(await $.process.run(argv, { env: cliEnv, timeoutMs }))
      } catch (error) {
        return thrownRun(error)
      }
    },
    git: async argv => outcomeOfRun(await runGit($, argv)),
    keychain: async argv => {
      try {
        return await $.process.run(argv, { timeoutMs: GIT_TIMEOUT_MS })
      } catch {
        return undefined
      }
    },
    env: async name => {
      if (name === 'BITBUCKET_TOKEN') return found($.env.get('BITBUCKET_TOKEN'))
      if (name === 'BITBUCKET_API_TOKEN') return found($.env.get('BITBUCKET_API_TOKEN'))
      if (name === 'ATLASSIAN_API_TOKEN') return found($.env.get('ATLASSIAN_API_TOKEN'))

      return undefined
    },
    fetch: (url, headers) => $.http.fetch(url, { method: 'GET', headers }),
    hosts: async () => (await read($, gitgudState)).settings?.hosts
  }
}

async function runHttp($: EngineInterface, req: Extract<Req, { kind: 'http' }>, options: RunOptions = {}): Promise<Outcome> {
  return runReqWith(ioOf($), req, options)
}

async function runReq($: EngineInterface, req: Req): Promise<Outcome> {
  return runReqWith(ioOf($), req)
}

/** Steps an adapter's operation: each request it yields runs through the guards, and its outcome goes back in. */
async function runOp<T>($: EngineInterface, op: Op<T>): Promise<Parsed<T>> {
  return runOpWith(ioOf($), op)
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
  await notify($, 'error', "Couldn't open the browser", { detail: failures.join('\n'), topic: 'gitgud-open' })
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
  await update($, gitgudState, value => ({ ...value, ui: change(value.ui ?? {}) }))
}

async function changeDetail($: EngineInterface, id: string, change: (detail: GhDetail) => GhDetail): Promise<void> {
  await update($, gitgudState, value => ({ ...value, details: { ...value.details, [id]: change(value.details?.[id] ?? {}) } }))
}

async function changeCheck($: EngineInterface, id: string, jobId: string, change: (check: GhCheck) => GhCheck): Promise<void> {
  await changeDetail($, id, detail =>
    detail.checks ? { ...detail, checks: detail.checks.map(check => (checkIdOf(check) === jobId ? change(check) : check)) } : detail
  )
}

/** The settings saved for every session, read from the store each time so another session's change shows here too. */
async function loadSettings($: EngineInterface): Promise<GhSettings> {
  const settings = parseGhSettings(await $.store.get(STORE.settings).catch(() => undefined))
  const state = await read($, gitgudState)
  if (!state.isSettingsLoaded || JSON.stringify(state.settings) !== JSON.stringify(settings)) {
    await update($, gitgudState, value => ({ ...value, isSettingsLoaded: true, settings }))
  }

  return settings
}

async function saveSettings($: EngineInterface, change: (settings: GhSettings) => GhSettings): Promise<GhSettings> {
  const settings = change(parseGhSettings(await $.store.get(STORE.settings).catch(() => undefined)))
  await $.store.set(STORE.settings, settings).catch(() => undefined)
  await update($, gitgudState, value => ({ ...value, isSettingsLoaded: true, settings }))

  return settings
}

/** The service's name for a sentence; GitHub until a host says otherwise. */
function serviceOf(provider: ProviderId | undefined): string {
  return SERVICE_NAMES[provider ?? 'github']
}

interface HostCheck {
  health?: GitgudState['health']
  healthError?: string
  login?: string
  userId?: string
  /** A Bitbucket host with no token to read: nothing was asked of it. */
  isTokenMissing?: boolean
}

/**
 * Whether a host's service can be used. `health` is left out when it could not be reached (offline, VPN down, rate
 * limited): that is no sign-out, and the start is tried again under the backoff.
 */
async function checkHost($: EngineInterface, info: HostInfo): Promise<HostCheck> {
  const adapter = adapterOf(info.provider)
  if (adapter === undefined) return { healthError: `${serviceOf(info.provider)} is not supported yet` }
  if (info.provider === 'bitbucket') {
    const token = await savedTokenWith(ioOf($), info.config)
    if (token === undefined) return { health: 'logged-out', healthError: 'No Bitbucket token found', isTokenMissing: true }
  }
  const ran = await runOp($, adapter.health(info.host))
  if (!ran.isOk) return { healthError: ran.error }
  const { health, login, userId, error } = ran.value

  return { health, ...(error === undefined ? {} : { healthError: error }), ...(login === undefined ? {} : { login }), ...(userId === undefined ? {} : { userId }) }
}

/** Whether Homebrew is at one of its usual install paths (no command run). */
async function hasHomebrew($: EngineInterface): Promise<boolean> {
  for (const path of BREW_PATHS) {
    if (await $.fs.exists(path).catch(() => false)) return true
  }

  return false
}

/** The session folder's repo; null when it is none, undefined when its service could not be asked (kept as it was). */
async function detectRepo($: EngineInterface, info: HostInfo, remote: ParsedRemote | undefined): Promise<GhRepo | null | undefined> {
  const adapter = adapterOf(info.provider)
  if (adapter === undefined) return null
  if (remote === undefined) return info.provider === 'github' ? detectGithubCwdRepo($, info) : null
  const ref: RepoRef = { provider: info.provider, host: info.host, apiHost: info.apiHost, path: remote.path }
  const ran = await runOp($, adapter.repoOf(ref))
  if (ran.isOk) return { ...ran.value, provider: info.provider, host: info.host, path: ran.value.path ?? ran.value.nameWithOwner }
  const kind = classifyGhFailure(ran.error)

  return kind === 'network' || kind === 'rate-limited' ? undefined : null
}

/** A folder with no remote may still be a GitHub repo `gh` resolves by itself. */
async function detectGithubCwdRepo($: EngineInterface, info: HostInfo): Promise<GhRepo | null | undefined> {
  const ran = await runReq($, { kind: 'cli', tool: 'gh', argv: ghRepoView('gh'), env: GH_ENV })
  if (ran.exitCode === 0) {
    const parsed = parseRepoView(ran.stdout)

    return parsed.isOk ? { ...parsed.value, provider: 'github', host: info.host, path: parsed.value.nameWithOwner } : null
  }
  const kind = classifyGhFailure(`${ran.stderr}\n${ran.stdout}`, ran.exitCode === NOT_RUN ? undefined : ran.exitCode)

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

/** The service's CLI as one `auth status` request for a host. */
function cliStatusReq(tool: 'gh' | 'glab', host: string): Req {
  if (tool === 'gh') return { kind: 'cli', tool, argv: ghAuthStatus('gh', host), env: GH_ENV }

  return { kind: 'cli', tool, argv: ['glab', 'auth', 'status', '--hostname', host], env: GLAB_ENV }
}

/** The remote the folder's branch tracks, as the person's own git config rewrites it; none when there is no remote. */
async function readRemote($: EngineInterface): Promise<{ remote?: ParsedRemote; url?: string }> {
  const listed = await runGit($, GIT_REMOTE_URLS)
  const entries = listed.exitCode === 0 ? parseRemoteEntries(listed.stdout) : []
  if (entries.length === 0) return {}
  const upstream = await runGit($, GIT_UPSTREAM)
  const picked = pickRemote(entries, upstream.exitCode === 0 ? upstreamRemoteOf(upstream.stdout, entries) : undefined)
  if (picked === undefined) return {}
  const rewritten = await runGit($, gitGetUrl(picked.name))
  const url = rewritten.exitCode === 0 && rewritten.stdout.trim() !== '' ? rewritten.stdout.trim() : picked.url
  const remote = parseRemote(url)

  return remote === undefined ? { url } : { remote, url }
}

/** An unauthenticated look at a host no step has named, only to preselect a service; a host that never answers is no guess. */
async function probeHost($: EngineInterface, hostKey: string): Promise<ReturnType<typeof interpretProbes>> {
  const paths = PROBE_PATHS.slice(0, MAX_PROBE_PATHS)
  const answers = Promise.all(
    paths.map(async path => {
      const ran = await runHttp($, { kind: 'http', method: 'GET', url: probeUrl(hostKey, path), needsToken: false, accept: 'text' }, { probeHosts: [hostKey] })

      return { path, status: ran.status ?? 0, body: ran.stdout }
    })
  )
  const timeout = $.clock.sleep(PROBE_TIMEOUT_MS).then(() => undefined, () => undefined)
  const results = await Promise.race([answers, timeout])

  return results === undefined ? {} : interpretProbes(results)
}

/** What the CLIs and the token say of a service, as the verdict reads them. */
function evidenceHealthOf(provider: ProviderId, check: HostCheck): CliState | TokenState | undefined {
  if (check.health === undefined) return undefined
  if (provider === 'bitbucket') return check.health === 'ok' ? 'ok' : check.isTokenMissing === true ? 'none' : 'refused'

  return check.health === 'ok' ? 'signed-in' : check.health === 'missing' ? 'cli-missing' : 'signed-out'
}

interface Detected {
  verdict: GgDetect
  /** The service and host the lists read first; absent while the service is unknown. */
  info?: HostInfo
  remote?: ParsedRemote
  check?: HostCheck
  decidedBy?: DecidedBy
}

/** A folder with no usable remote reads the default host, as the panel always did for GitHub. */
async function detectDefaultHost($: EngineInterface, state: GitgudState, verdict: GgDetect): Promise<Detected> {
  const host = state.setup?.host ?? state.settings?.defaultHost ?? DEFAULT_HOST
  const info = hostInfoOf(state, host)
  if (info === undefined) return { verdict }
  const isPicked = state.setup?.host === host && hostConfigOf(state.settings?.hosts, host) === undefined

  return { verdict, info, check: await checkHost($, info), ...(isPicked ? { decidedBy: 'person' as const } : {}) }
}

/** Which service hosts the folder's remote, and whether it can be used: known host, saved answer, CLI, probe, then health. */
async function detectSession($: EngineInterface, state: GitgudState): Promise<Detected> {
  const { remote, url } = await readRemote($)
  if (remote === undefined) return detectDefaultHost($, state, detectVerdict(undefined, url))
  const { hostKey } = remote
  const config = hostConfigOf(state.settings?.hosts, hostKey) ?? hostConfigOf(state.settings?.hosts, remote.host)
  const pending = state.setup?.host === hostKey ? state.setup : undefined
  const saved = config?.provider ?? pending?.provider
  const evidence: Parameters<typeof detectVerdict>[2] = { ...(saved === undefined ? {} : { saved }) }
  const isKnown = providerOfHost(hostKey, evidence) !== undefined || providerOfHost(remote.host, evidence) !== undefined
  if (!isKnown) {
    const [gh, glab] = await Promise.all([runReq($, cliStatusReq('gh', hostKey)), runReq($, cliStatusReq('glab', hostKey))])
    evidence.cli = { gh: cliStateOf(gh), glab: cliStateOf(glab) }
    if (providerOfHost(hostKey, evidence) === undefined) evidence.probe = await probeHost($, hostKey)
  }
  const first = detectVerdict(remote, url, evidence)
  if (first.kind !== 'ready') return { verdict: first, remote }
  const decided = providerOfHost(hostKey, evidence) ?? providerOfHost(remote.host, evidence)
  const apiHost = config?.apiHost ?? pending?.apiHost
  const info: HostInfo = { host: first.host, provider: first.provider, apiHost: apiHostOf(first.provider, first.host, { apiHost }), ...(config ? { config } : {}) }
  const check = await checkHost($, info)
  const health = evidenceHealthOf(first.provider, check)

  return { verdict: detectVerdict(remote, url, { ...evidence, ...(health === undefined ? {} : { health }) }), info, remote, check, ...(decided ? { decidedBy: decided.decidedBy } : {}) }
}

/** The service could not be reached: the card says so and the start is tried again, never shown as signed out. */
async function startFailed($: EngineInterface, error: string): Promise<void> {
  if ((await read($, gitgudState)).health === 'ok') {
    // The lists stay; the poll reports its own failure and backs off.
    isStarted = true

    return
  }
  startFailedAt = await $.clock.now()
  await update($, gitgudState, value => ({ ...value, health: undefined, healthError: undefined, error, failures: (value.failures ?? 0) + 1, isLoading: false }))
}

/** A host answered once its CLI or token worked: its service is kept, so the next start need not ask again. */
async function rememberHost($: EngineInterface, found: Detected): Promise<void> {
  const { info, decidedBy } = found
  if (info === undefined || decidedBy === undefined || decidedBy === 'known' || info.provider === 'bitbucket') return
  const settings = await loadSettings($)
  if (hostConfigOf(settings.hosts, info.host) !== undefined) return
  const pending = (await read($, gitgudState)).setup
  const apiHost = pending?.host === info.host ? pending.apiHost : undefined
  const config = cliHostConfig(info.provider, decidedBy, await $.clock.now(), apiHost)
  await saveSettings($, current => ({ ...current, hosts: withHostConfig(current.hosts, info.host, config) satisfies HostSettings }))
}

/** The other hosts of the added repos: whether each can be read. */
async function checkOtherHosts($: EngineInterface, primary: string): Promise<Record<string, GgHostState>> {
  const others = hostsOf(await read($, gitgudState)).filter(info => info.host !== primary)
  const entries = await Promise.all(
    others.map(async (info): Promise<[string, GgHostState]> => {
      const check = await checkHost($, info)

      return [info.host, { provider: info.provider, ...(check.health === undefined ? {} : { health: check.health }), ...(check.login === undefined ? {} : { login: check.login }), ...(check.userId === undefined ? {} : { userId: check.userId }) }]
    })
  )

  return Object.fromEntries(entries)
}

/** Once per session, and again after ↻: the settings, the service, its sign-in, the repo, the branch and the commands. */
async function startGitgud($: EngineInterface): Promise<void> {
  await loadSettings($)
  const found = await detectSession($, await read($, gitgudState))
  const { verdict, info, check } = found
  if (info === undefined) {
    // Nothing named the service: the setup card asks.
    await update($, gitgudState, value => ({ ...value, detect: verdict, health: undefined, healthError: undefined, error: undefined, isLoading: false }))
    isStarted = true

    return
  }
  if (check?.health === undefined) {
    await startFailed($, check?.healthError ?? `Couldn't reach ${serviceOf(info.provider)}`)

    return
  }
  startFailedAt = undefined
  const hostState = { provider: info.provider, health: check.health, ...(check.healthError === undefined ? {} : { healthError: check.healthError }), ...(check.login === undefined ? {} : { login: check.login }), ...(check.userId === undefined ? {} : { userId: check.userId }) }
  if (check.health !== 'ok') {
    const hasBrew = check.health === 'missing' && (await hasHomebrew($))
    await update($, gitgudState, value => ({
      ...value,
      detect: verdict,
      host: info.host,
      provider: info.provider,
      hosts: { ...value.hosts, [info.host]: hostState },
      health: check.health,
      healthError: check.healthError,
      hasBrew,
      isLoading: false
    }))
    isStarted = true

    return
  }
  const [repo, branch, commands, others] = await Promise.all([detectRepo($, info, found.remote), readBranch($), detectCommands($), checkOtherHosts($, info.host)])
  await rememberHost($, found)
  await update($, gitgudState, (value): GitgudState => {
    const { setup: _setup, ...rest } = value

    return {
      ...rest,
      detect: verdict,
      host: info.host,
      provider: info.provider,
      hosts: { ...value.hosts, ...others, [info.host]: hostState },
      health: 'ok',
      healthError: undefined,
      login: check.login ?? value.login,
      ...(repo === undefined ? {} : { currentRepo: repo }),
      branch,
      reviewCommand: commands.reviewCommand,
      commands: commands.commands
    }
  })
  isStarted = true
}

async function ensureStarted($: EngineInterface): Promise<void> {
  if (isStarted) return
  starting ??= startGitgud($)
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

/** What a failed read says about its host: a sign-out stops polling until ↻, anything else is retried under the backoff. */
function failureKindOf(error: string): ReturnType<typeof classifyGhFailure> {
  return /did not accept the token|refused the token/i.test(error) ? 'logged-out' : classifyGhFailure(error)
}

async function failPoll($: EngineInterface, error: string, provider: ProviderId | undefined): Promise<void> {
  const kind = failureKindOf(error)
  const why = firstLine(error) || 'the service gave nothing back'
  if (kind === 'missing' || kind === 'logged-out') {
    // Polling stops until ↻; the card says how to fix it.
    await update($, gitgudState, value => ({ ...value, health: kind, healthError: why, isLoading: false }))

    return
  }
  const before = await read($, gitgudState)
  await update($, gitgudState, value => ({ ...value, isLoading: false, error: why, failures: (value.failures ?? 0) + 1 }))
  if ((before.failures ?? 0) === 0) await notify($, 'error', `Couldn't load ${serviceOf(provider)}`, { detail: why, topic: POLL_TOPIC })
}

/** What an item's detail read answered, kept while its head commit (or last update) stays the same. */
const detailPatches = new Map<string, { at: string; patch: Partial<GhItem> }>()
const MAX_DETAIL_PATCHES = 200

function versionOf(item: GhItem): string {
  return item.headSha ?? item.updatedAt
}

/** CI and review state a service's list leaves out, read for the rows shown and reused until the item changes. */
async function withDetails($: EngineInterface, adapter: ProviderAdapter, ctx: ListsCtx, lists: ListsResult): Promise<ListsResult> {
  const shown = [...lists.review, ...lists.mine].filter(item => item.kind === 'pr')
  const stale = shown.filter(item => detailPatches.get(item.id)?.at !== versionOf(item))
  if (stale.length > 0) {
    const read = await runOp($, adapter.details(ctx, stale))
    if (read.isOk) {
      for (const item of stale) {
        const patch = read.value[item.id]
        if (patch !== undefined) detailPatches.set(item.id, { at: versionOf(item), patch })
      }
      for (const key of [...detailPatches.keys()].slice(0, Math.max(0, detailPatches.size - MAX_DETAIL_PATCHES))) detailPatches.delete(key)
    }
  }
  const apply = (item: GhItem): GhItem => {
    const known = detailPatches.get(item.id)

    return known?.at === versionOf(item) ? { ...item, ...known.patch } : item
  }

  return { ...lists, review: lists.review.map(apply), mine: lists.mine.map(apply) }
}

/** The lists of every followed host, merged: the first failure is kept when none answered. */
async function readLists($: EngineInterface, state: GitgudState, ticketPattern: string | undefined): Promise<Parsed<ListsResult>> {
  const hosts = hostsOf(state).filter(info => state.hosts?.[info.host]?.health === 'ok' || info.host === state.host)
  const answers = await Promise.all(
    hosts.map(async info => {
      const adapter = adapterOf(info.provider)

      if (adapter === undefined) return undefined
      const ctx = listsCtxOf(state, info, ticketPattern)
      const result = await runOp($, adapter.lists(ctx))

      return { info, result: result.isOk && info.provider !== 'github' ? { isOk: true as const, value: await withDetails($, adapter, ctx, result.value) } : result }
    })
  )
  const merged: ListsResult = { login: state.login ?? '', review: [], mine: [], issues: [] }
  let failure: string | undefined
  let isAnswered = false
  for (const answer of answers) {
    if (answer === undefined) continue
    if (!answer.result.isOk) {
      failure ??= answer.result.error
      continue
    }
    const lists = answer.result.value
    if (!isAnswered && answer.info.host === state.host) merged.login = lists.login
    isAnswered = true
    merged.review.push(...lists.review)
    merged.mine.push(...lists.mine)
    merged.issues.push(...lists.issues)
    if (lists.rateRemaining !== undefined && (merged.rateRemaining === undefined || lists.rateRemaining < merged.rateRemaining)) {
      merged.rateRemaining = lists.rateRemaining
      if (lists.rateResetAt !== undefined) merged.rateResetAt = lists.rateResetAt
    }
  }
  if (!isAnswered) return { isOk: false, error: failure ?? 'no service to read' }

  return { isOk: true, value: merged }
}

/** One read per host for the three lists, then the alerts, the Jira statuses and the one-liners. */
async function poll($: EngineInterface): Promise<void> {
  try {
    await pollLists($)
  } catch (error) {
    // Only an engine call failing unexpectedly lands here: never leave the card marked as loading.
    await update($, gitgudState, value => ({ ...value, isLoading: false, error: errorText(error) }))
  }
}

async function pollLists($: EngineInterface): Promise<void> {
  await ensureStarted($)
  await loadSettings($)
  const state = await read($, gitgudState)
  if (state.health !== 'ok') return
  const request = ++latestPoll
  const now = await $.clock.now()
  lastPollAt = now
  const { ticketPattern } = parseSettings(await $.store.get(SETTINGS_KEY).catch(() => undefined))
  if (!state.isLoading) await update($, gitgudState, value => ({ ...value, isLoading: true }))
  const [parsed, branch] = await Promise.all([readLists($, state, ticketPattern), readBranch($)])
  if (request !== latestPoll) return
  if (!parsed.isOk) {
    await failPoll($, parsed.error, state.provider)

    return
  }
  const lists = parsed.value
  rateResetAt = lists.rateResetAt
  const resetAt = lists.rateResetAt === undefined ? Number.NaN : Date.parse(lists.rateResetAt)
  const isRateLow = lists.rateRemaining !== undefined && lists.rateRemaining < RATE_FLOOR && !Number.isNaN(resetAt)
  await update($, gitgudState, value => {
    const next: GitgudState = {
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
  await raiseAlerts($, lists, scopeSignature(scopeOf(state), reposOf(state)))
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
  const state = await read($, gitgudState)
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
  await update($, gitgudState, value => ({
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
    if (line !== '') await update($, gitgudState, value => ({ ...value, oneLiners: { ...value.oneLiners, [item.id]: line } }))
  } finally {
    askedOneLiners.delete(item.id)
  }
}

/** Haiku one-liners for the rows drawn while the card shows, kept per item until it changes. */
async function fillOneLiners($: EngineInterface): Promise<void> {
  const state = await read($, gitgudState)
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
  if (Object.keys(known).length > 0) await update($, gitgudState, value => ({ ...value, oneLiners: { ...value.oneLiners, ...known } }))
  await Promise.all(asks.map(item => askOneLiner($, item)))
}

/** Why each failed job failed: its log's telling lines, then Haiku's one line on them; at most three jobs, one by one. */
async function explainFailures($: EngineInterface, item: GhItem, checks: readonly GhCheck[]): Promise<void> {
  const failed = checks.filter(check => check.state === 'fail').slice(0, MAX_FAILED_LOGS)
  const state = await read($, gitgudState)
  const adapter = adapterOfRepo(state, item.repo)
  const isHaikuOn = state.settings?.isHaikuOn !== false
  // A job Haiku had no line for is cached as '' and not asked again.
  const whyCache = readCache(await $.store.get(STORE.ciWhy).catch(() => undefined))
  for (const check of failed) {
    const jobId = checkIdOf(check)
    if (jobId === '') continue
    let why = check.why
    if (why === undefined && adapter?.caps.failedLogs === true) {
      await changeCheck($, item.id, jobId, one => ({ ...one, isLogLoading: true }))
      const log = await runOp($, adapter.failedLog(item, check))
      if (log.isOk) {
        const excerpt = excerptFailedLog(log.value)
        why = excerpt.lines.length > 0 ? excerpt.lines : excerpt.problem ? [excerpt.problem] : []
      }
      const lines = why
      await changeCheck($, item.id, jobId, one => ({ ...one, isLogLoading: false, ...(lines ? { why: lines } : {}) }))
    }
    const key = whyKeyOf(item, jobId)
    if (!isHaikuOn || check.whyLine !== undefined || whyCache[key] !== undefined || !why || why.length === 0) continue
    const text = await askHaiku($, ciWhyAsk({ ...check, why }))
    const line = text === undefined ? '' : cleanOneLine(text)
    await rememberLine($, STORE.ciWhy, key, { t: line, at: await $.clock.now() }, MAX_CI_WHY)
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
  const state = await read($, gitgudState)
  const item = findItem(state, id)
  if (item?.kind !== 'pr' || state.health !== 'ok') return
  const cached = state.details?.[id]
  const now = await $.clock.now()
  if (!isForced && cached?.checks && cached.loadedAt !== undefined && now - cached.loadedAt < DETAIL_REFRESH_MS) return
  await changeDetail($, id, detail => ({ ...detail, isLoading: true, error: undefined }))
  const adapter = adapterOfRepo(state, item.repo)
  const ran = adapter === undefined ? undefined : await runOp($, adapter.checks(item))
  const hasNoChecks = ran?.isOk === false && NO_CHECKS.test(ran.error)
  const parsed = hasNoChecks ? { isOk: true as const, value: [] } : ran
  if (!parsed?.isOk) {
    const error = firstLine(parsed?.error ?? '') || 'no service to read'
    await changeDetail($, id, detail => ({ ...detail, isLoading: false, error, loadedAt: now }))

    return
  }
  const whyCache = readCache(await $.store.get(STORE.ciWhy).catch(() => undefined))
  const checks = parsed.value.map(check => withKnownWhy(item, check, cached?.checks, whyCache))
  await changeDetail($, id, () => ({ checks, loadedAt: now, isLoading: false }))
  await explainFailures($, item, checks)
}

/** The opened row's pending checks again, every minute while the card shows. */
async function refreshOpenDetail($: EngineInterface, now: number): Promise<void> {
  const state = await read($, gitgudState)
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
  if (!isStarted && !isStartDue(await read($, gitgudState), isShown, now)) return
  await ensureStarted($)
  const state = await read($, gitgudState)
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
  const state = await read($, gitgudState)
  if (state.health !== 'ok') return
  const now = await $.clock.now()
  const isStale = state.updatedAt === undefined || now - state.updatedAt > STALE_MS
  const isPaused = state.pausedUntil !== undefined && now < state.pausedUntil
  if (isStale && !state.isLoading && !isPaused) await poll($)
  else await fillOneLiners($)
}

/**
 * Reset all settings: its settings, Haiku lines and open setup are forgotten, so it asks again. Background reviews
 * keep running; the alert ledgers were emptied with the store and refill without alerts. No keychain, env or file is touched.
 */
async function forgetSettings($: EngineInterface): Promise<void> {
  jiraReadAt.clear()
  await update($, gitgudState, (value): GitgudState => {
    const { setup: _setup, ...rest } = value

    return { ...rest, isSettingsLoaded: undefined, settings: undefined, oneLiners: undefined, ui: value.ui ? { ...value.ui, isSettingsOpen: undefined } : value.ui }
  })
  await loadSettings($)
  if (await isPlaced($)) detach(refreshAll($))
}

/** ↻: `gh`, the repo and the branch checked again, the backoff and a Jira refusal forgotten, then a poll. */
async function refreshAll($: EngineInterface): Promise<void> {
  isStarted = false
  jiraReadAt.clear()
  forgetTokens()
  await update($, gitgudState, value => ({ ...value, failures: 0, pausedUntil: undefined, error: undefined, isJiraRefused: false }))
  await ensureStarted($)
  await poll($)
  const openId = (await read($, gitgudState)).ui?.openId
  if (openId) await loadDetail($, openId, true)
}

async function runSearch($: EngineInterface, query: string): Promise<void> {
  await ensureStarted($)
  const request = ++latestSearch
  await update($, gitgudState, (value): GitgudState => ({
    ...value,
    search: { query, isLoading: true },
    ui: { ...value.ui, view: 'search', openId: undefined, menuId: undefined, shown: undefined }
  }))
  const state = await read($, gitgudState)
  const { ticketPattern } = parseSettings(await $.store.get(SETTINGS_KEY).catch(() => undefined))
  const answers = await Promise.all(
    hostsOf(state).map(async info => {
      const adapter = adapterOf(info.provider)

      return adapter === undefined ? undefined : runOp($, adapter.search(listsCtxOf(state, info, ticketPattern), query))
    })
  )
  if (request !== latestSearch) return
  const found = answers.flatMap(answer => answer ?? [])
  const items = found.flatMap(answer => (answer.isOk ? answer.value : []))
  const failed = found.find(answer => !answer.isOk)
  const error = items.length === 0 && failed !== undefined && !failed.isOk ? firstLine(failed.error) || 'the service gave nothing back' : undefined
  await update($, gitgudState, value => {
    if (value.search?.query !== query) return value

    return { ...value, search: error === undefined ? { query, items } : { query, error } }
  })
  detach(fillOneLiners($))
}

async function askSearch($: EngineInterface): Promise<void> {
  const options = { header: 'Search', options: [CLEAR_SEARCH, CANCEL] }
  const answer = await $.ui.ask('What should the GitGud panel search for in open pull requests and issues?', options).catch(() => undefined)
  if (answer === undefined || answer === CANCEL || answer.trim() === '') return
  if (answer === CLEAR_SEARCH) {
    latestSearch += 1
    await update($, gitgudState, value => ({ ...value, search: undefined, ui: { ...value.ui, openId: undefined, menuId: undefined } }))

    return
  }
  await runSearch($, answer.trim())
}

/** A repo the person picks from a few matches for what they typed. */
async function pickFromSearch($: EngineInterface, info: HostInfo, typed: string, present: ReadonlySet<string>): Promise<string | undefined> {
  const adapter = adapterOf(info.provider)
  const found = adapter === undefined ? undefined : await runOp($, adapter.searchRepos(info.host, typed.replace(/^-+/, '')))
  const matches = (found?.isOk ? found.value : []).filter(repo => !present.has(repo.toLowerCase())).slice(0, MAX_REPO_CHOICES)
  if (matches.length === 0) {
    await notify($, 'info', `No repo matches “${typed}”`, { topic: REPOS_TOPIC })

    return undefined
  }
  const options = { header: 'Add repo', options: [...matches.map(repo => parseRepoKey(repo)?.path ?? repo), CANCEL] }
  const answer = await $.ui.ask(`Which repo did you mean by “${typed}”?`, options).catch(() => undefined)
  if (answer === undefined || answer === CANCEL) return undefined

  return matches.find(repo => parseRepoKey(repo)?.path === answer) ?? repoFromText(answer, info.host)
}

/** ➕: a repo you pushed to lately, or one typed (a path, a URL, words to search); checked with its service, then kept for every session. */
async function addRepo($: EngineInterface): Promise<void> {
  await ensureStarted($)
  const state = await read($, gitgudState)
  const info = state.host === undefined ? undefined : hostInfoOf(state, state.host)
  const adapter = info === undefined ? undefined : adapterOf(info.provider)
  if (state.health !== 'ok' || info === undefined || adapter === undefined) return
  const present = new Set(reposOf(state).map(repo => repo.toLowerCase()))
  const recent = await runOp($, adapter.recentRepos(info.host))
  const choices = (recent.isOk ? recent.value : []).filter(repo => !present.has(repo.toLowerCase())).slice(0, MAX_REPO_CHOICES)
  const question = 'Which repo should the GitGud panel follow too? Pick one, or type its path or words to search for.'
  const names = choices.map(repo => parseRepoKey(repo)?.path ?? repo)
  const options = { header: 'Add repo', options: names.length > 0 ? [...names, CANCEL] : [CANCEL, ALL_REPOS] }
  const answer = await $.ui.ask(question, options).catch(() => undefined)
  if (answer === undefined || answer === CANCEL || answer.trim() === '') return
  if (answer === ALL_REPOS) {
    await saveSettings($, settings => ({ ...settings, scope: 'all' }))
    detach(poll($))

    return
  }
  const typed = answer.trim()
  const repo = choices.find(choice => parseRepoKey(choice)?.path === typed) ?? repoFromText(typed, info.host) ?? (await pickFromSearch($, info, typed, present))
  if (!repo) return
  const ref = repoRefOf(state, repo)
  const checked = ref === undefined ? undefined : await runOp($, adapter.repoOf(ref))
  if (!checked?.isOk) {
    await notify($, 'error', `Couldn't find ${repo}`, { detail: firstLine(checked?.error ?? '') || `${serviceOf(info.provider)} did not know it`, topic: REPOS_TOPIC })

    return
  }
  const name = repoKeyOf(info.host, checked.value.nameWithOwner)
  if (present.has(name.toLowerCase())) {
    await notify($, 'info', `${checked.value.nameWithOwner} is already listed`, { topic: REPOS_TOPIC })

    return
  }
  await saveSettings($, settings => ({ ...settings, extraRepos: [...(settings.extraRepos ?? []), name] }))
  await notify($, 'success', `Added ${checked.value.nameWithOwner}`, { topic: REPOS_TOPIC })
  detach(poll($))
}

async function removeRepo($: EngineInterface, name: string): Promise<void> {
  const key = canonicalRepoKey(name).toLowerCase()
  const isListed = (repo: string) => repo.toLowerCase() === key
  if (!(await read($, gitgudState)).settings?.extraRepos?.some(isListed)) return
  await saveSettings($, settings => {
    const { extraRepos = [], ...rest } = settings
    const kept = extraRepos.filter(repo => !isListed(repo))

    return kept.length > 0 ? { ...rest, extraRepos: kept } : rest
  })
  detach(poll($))
}

/** `#` or `!`, as the item's service writes its numbers. */
function sigilOf(item: GhItem): string {
  return adapterOf(item.provider ?? 'github')?.caps.vocab.sigil ?? '#'
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
  await notify($, 'info', `Reading ${sigilOf(item)}${item.number}…`, { topic })
  const adapter = adapterOfRepo(await read($, gitgudState), item.repo)
  const thread = adapter === undefined ? undefined : await runOp($, adapter.thread(item))
  if (thread?.isOk) return thread.value
  await notify($, 'error', `Couldn't read ${sigilOf(item)}${item.number}`, { detail: firstLine(thread?.error ?? '') || 'the service gave nothing back', topic })

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
  const topic = `gitgud-act-${item.id}`
  const thread = await readThread($, item, topic)
  if (!thread) return
  await dropNoticeTopic($, topic)
  await copyText($, isWhole ? fullThreadMarkdown(thread) : titleBodyMarkdown(thread), isWhole ? 'Thread' : 'Title and body', item, surface)
}

async function copyDiff($: EngineInterface, item: GhItem, surface: RenderSurface): Promise<void> {
  const adapter = adapterOfRepo(await read($, gitgudState), item.repo)
  const diff = adapter === undefined ? undefined : await runOp($, adapter.diff(item))
  if (!diff?.isOk) {
    await notify($, 'error', `Couldn't read the diff of ${sigilOf(item)}${item.number}`, { detail: firstLine(diff?.error ?? '') || 'the service gave nothing back', topic: COPY_TOPIC })

    return
  }
  await copyText($, diff.value, 'Diff', item, surface)
}

async function fixCi($: EngineInterface, item: GhItem): Promise<void> {
  const topic = `gitgud-act-${item.id}`
  await notify($, 'info', `Reading why ${sigilOf(item)}${item.number} fails…`, { topic })
  // Waits for a load the opened row started, so the prompt carries the failed jobs and their logs.
  await loadDetail($, item.id, false).catch(() => undefined)
  const state = await read($, gitgudState)
  const failed = (state.details?.[item.id]?.checks ?? []).filter(check => check.state === 'fail')
  const place = prPlaceOf(item, currentKeyOf(state), state.branch)
  await insertText($, fixCiPrompt(item, failed, place), `Fixing CI of ${sigilOf(item)}${item.number}: added to the prompt`, topic)
}

async function runAction($: EngineInterface, action: GhAction, id: string, surface: RenderSurface): Promise<void> {
  const state = await read($, gitgudState)
  const item = findItem(state, id)
  const topic = `gitgud-act-${id}`
  if (!item) {
    await notify($, 'info', `${id} is no longer listed`, { topic })

    return
  }
  switch (action) {
    case 'review-here': {
      const text = reviewHereText(state.reviewCommand, item.url, adapterOf(item.provider ?? 'github')?.caps.vocab.noun)
      if (state.reviewCommand) await fillEmptyBox($, text, `Press Enter to review ${sigilOf(item)}${item.number} here`, topic)
      else await insertText($, text, `Review of ${sigilOf(item)}${item.number}: added to the prompt`, topic)

      return
    }
    case 'checkout': {
      const command = isSessionRepo(item.repo, currentKeyOf(state)) ? adapterOf(item.provider ?? 'github')?.caps.checkoutCommand(item) : undefined
      if (command) await fillEmptyBox($, command, `Press Enter to check out ${sigilOf(item)}${item.number}`, topic)
      else await notify($, 'info', `${sigilOf(item)}${item.number} is not in this folder's repo`, { topic })

      return
    }
    case 'fix-ci':
      return fixCi($, item)
    case 'address': {
      const thread = await readThread($, item, topic)
      if (thread) await insertText($, addressCommentsPrompt(thread), `Review comments of ${sigilOf(item)}${item.number}: added to the prompt`, topic)

      return
    }
    case 'add-link':
      return insertText($, linkMarkdown(item), `${sigilOf(item)}${item.number} link added to the prompt`, topic)
    case 'add-full': {
      const thread = await readThread($, item, topic)
      if (thread) await insertText($, fullThreadPrompt(thread), `${sigilOf(item)}${item.number} thread added to the prompt`, topic)

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
      // gitgudWork.tsx answers its own actions (WORK_ACTIONS).
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

async function openRow($: EngineInterface, rowId: string | undefined): Promise<void> {
  const id = rowId === undefined ? undefined : canonicalItemId(rowId)
  await changeUi($, ui => ({ ...ui, openId: id, menuId: undefined }))
  if (id) detach(loadDetail($, id, false))
}

async function showMore($: EngineInterface): Promise<void> {
  await changeUi($, ui => ({ ...ui, shown: (ui.shown ?? DEFAULT_SHOWN) + DEFAULT_SHOWN }))
  detach(fillOneLiners($))
}

/** ⚙ in the card's header or Done: the settings open or close; opening reads what this client can notify with. */
async function toggleSettings($: EngineInterface): Promise<void> {
  const isOpening = (await read($, gitgudState)).ui?.isSettingsOpen !== true
  await changeUi($, ui => ({ ...ui, isSettingsOpen: isOpening }))
  if (!isOpening) return
  const notifyChannel = notifyChannelOf(await $.config.list().catch(() => undefined))
  if ((await read($, gitgudState)).notifyChannel !== notifyChannel) await update($, gitgudState, value => ({ ...value, notifyChannel }))
}

async function toggleHaiku($: EngineInterface): Promise<void> {
  const settings = await saveSettings($, current => ({ ...current, isHaikuOn: current.isHaikuOn === false }))
  if (settings.isHaikuOn === false) await update($, gitgudState, value => ({ ...value, oneLiners: undefined }))
  else detach(fillOneLiners($))
}

/**
 * Moves the saved settings and file list to the `gitgud` keys and gives repos and ids their host, once each: new keys
 * first, then the old keys go, then the marker. A failed step ends it early, so the next start does it all again.
 */
async function migrateStore($: EngineInterface): Promise<void> {
  const marker = await $.store.get(MIGRATED_KEY).catch(() => undefined)
  if (typeof marker === 'number' && marker >= MIGRATION_VERSION) return
  const values: Record<string, unknown> = {}
  for (const key of MIGRATION_READ_KEYS) values[key] = await $.store.get(key).catch(() => undefined)
  const { writes, deletes, marker: next } = planMigration(values)
  for (const [key, value] of Object.entries(writes)) {
    if (!(await $.store.set(key, value).then(() => true, () => false))) return
  }
  for (const key of deletes) {
    if (!(await $.store.delete(key).then(() => true, () => false))) return
  }
  await $.store.set(MIGRATED_KEY, next).catch(() => undefined)
}

// --- picking and setting up a service ---

/** Which keychain tool this machine has; neither means the environment variable is the only way. */
async function platformOf($: EngineInterface): Promise<'darwin' | 'linux' | 'win32'> {
  if (await $.fs.exists('/usr/bin/security').catch(() => false)) return 'darwin'
  if (await $.fs.exists('/usr/bin/secret-tool').catch(() => false)) return 'linux'

  return 'win32'
}

async function askSetup($: EngineInterface, question: { question: string; header: string; options: string[] }): Promise<string | undefined> {
  return $.ui.ask(question.question, { header: question.header, options: question.options }).catch(() => undefined)
}

async function setSetup($: EngineInterface, change: (setup: GgSetupView | undefined) => GgSetupView | undefined): Promise<void> {
  await update($, gitgudState, value => {
    const { setup: _before, ...rest } = value
    const setup = change(value.setup)

    return setup === undefined ? rest : { ...rest, setup }
  })
}

/** Runs one setup question flow or check; a press while another is under way does nothing. */
async function exclusiveSetup(work: () => Promise<void>): Promise<void> {
  if (isSetupBusy) return
  isSetupBusy = true
  try {
    await work()
  } finally {
    isSetupBusy = false
  }
}

/** Q3 to Q5, then the card that says what to do next; the token is neither asked for nor kept. */
async function setUpBitbucket($: EngineInterface, host: string, apiHost: string | undefined): Promise<void> {
  const platform = await platformOf($)
  const source = parseTokenSource(await askSetup($, tokenSourceQuestion(platform)))
  if (source === undefined) return
  const savedEmail = hostConfigOf((await read($, gitgudState)).settings?.hosts, host)?.email
  const emailAnswer = await askSetup($, emailQuestion(savedEmail))
  const email = emailFromAnswer(emailAnswer)
  if (email === undefined) {
    if (!isDeclined(emailAnswer)) await notify($, 'info', "That doesn't look like an email address", { topic: SETUP_TOPIC })

    return
  }
  const envAnswer = source === 'env' ? await askSetup($, envQuestion(ENV_TOKEN_NAMES)) : undefined
  const name = envNameFromAnswer(envAnswer, ENV_TOKEN_NAMES)
  if (source === 'env' && name === undefined) {
    if (!isDeclined(envAnswer)) await notify($, 'info', `GitGud can read ${ENV_TOKEN_NAMES.join(', ')}: pick one of those`, { topic: SETUP_TOPIC })

    return
  }
  const tokenFrom: GgHostConfig['tokenFrom'] = name === undefined ? { kind: 'keychain', service: KEYCHAIN_SERVICE, account: email } : { kind: 'env', name }
  await setSetup($, () => ({ host, provider: 'bitbucket', step: 'token', email, tokenFrom, ...(platform === 'win32' ? {} : { platform }), ...(apiHost === undefined ? {} : { apiHost }) }))
}

/** A service is chosen for a host: Bitbucket asks where its token lives, the others wait for their CLI. */
async function startSetup($: EngineInterface, host: string, provider: ProviderId, apiHost: string | undefined, isDefaultHost: boolean): Promise<void> {
  await changeUi($, ui => ({ ...ui, isSetupDismissed: false }))
  if (isDefaultHost) await saveSettings($, settings => ({ ...settings, defaultHost: host }))
  if (provider === 'bitbucket') {
    await setUpBitbucket($, host, apiHost)

    return
  }
  await setSetup($, () => ({ host, provider, step: 'cli', ...(apiHost === undefined ? {} : { apiHost }) }))
  await refreshAll($)
}

/** The pick-a-service questions: which service hosts the host, where its web address is, then that service's own setup. */
async function pickService($: EngineInterface, host?: string, guess?: ProviderId): Promise<void> {
  const state = await read($, gitgudState)
  const { detect } = state
  const isOpen = detect?.kind === 'unknown-host' || detect?.kind === 'no-remote'
  let hostKey = host ?? (detect?.kind === 'unknown-host' ? detect.host : undefined)
  const isTyped = hostKey === undefined
  if (hostKey === undefined) {
    hostKey = apiHostFromAnswer(await askSetup($, webAddressQuestion(DEFAULT_HOST)))
    if (hostKey === undefined) return
  }
  const preselected = guess ?? (detect?.kind === 'unknown-host' ? detect.guess : undefined)
  const answer = parseServiceAnswer(await askSetup($, serviceQuestion(hostKey, preselected)))
  if (answer.kind === 'cancel') {
    if (isOpen) await changeUi($, ui => ({ ...ui, isSetupDismissed: true }))

    return
  }
  if (answer.kind === 'unsupported') {
    await notify($, 'info', answer.notice, { topic: SETUP_TOPIC })

    return
  }
  let apiHost: string | undefined
  if (!isTyped && KNOWN_HOSTS[hostKey] === undefined) {
    const web = apiHostFromAnswer(await askSetup($, webAddressQuestion(hostKey)))
    if (web === undefined) return
    apiHost = web === hostKey ? undefined : web
  }
  await startSetup($, hostKey, answer.provider, apiHost, detect?.kind === 'no-remote')
}

/** The card's Set up / Pick: a known service that needs setup goes straight to it, never the which-service question. */
async function pressSetupPick($: EngineInterface): Promise<void> {
  const state = await read($, gitgudState)
  const { detect } = state
  if (detect?.kind !== 'needs-setup') return pickService($)
  await startSetup($, detect.host, detect.provider, hostInfoOf(state, detect.host)?.config?.apiHost, false)
}

/** Checks the Bitbucket token being set up with one GET; saved only once Bitbucket accepts it. */
async function checkBitbucketToken($: EngineInterface): Promise<void> {
  const { setup } = await read($, gitgudState)
  const { email, tokenFrom } = setup ?? {}
  if (setup?.provider !== 'bitbucket' || email === undefined || tokenFrom === undefined || setup.host === undefined) return
  const host = setup.host
  const source: TokenFrom = tokenFrom.kind === 'env' ? { kind: 'env', name: tokenFrom.name } : { kind: 'keychain', service: KEYCHAIN_SERVICE, account: tokenFrom.account }
  const config = bitbucketHostConfig(email, source, await $.clock.now(), setup.apiHost)
  const outcome = await runHttp($, { kind: 'http', method: 'GET', url: `https://${BITBUCKET_API_HOST}/2.0/user`, needsToken: true, accept: 'json' }, { config })
  const name = displayNameOf(outcome.stdout)
  const checked = checkMessageOf(outcome, source, name)
  if (!checked.ok) {
    await setSetup($, current => (current === undefined ? current : { ...current, note: checked.text }))

    return
  }
  await saveSettings($, settings => ({ ...settings, hosts: withHostConfig(settings.hosts, host, config) }))
  forgetTokens()
  await notify($, 'success', checked.text, { topic: SETUP_TOPIC })
  await refreshAll($)
}

/** The line a check says: no token found, no answer, or what Bitbucket answered. */
function checkMessageOf(outcome: Outcome, source: TokenFrom, name: string | undefined): { ok: boolean; text: string } {
  if (isNoToken(outcome)) return { ok: false, text: bitbucketNoTokenMessage(source) }
  if (outcome.status === undefined) return { ok: false, text: "Couldn't reach Bitbucket." }

  return bitbucketCheckMessage(outcome.status, name)
}

function displayNameOf(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body)

    return typeof parsed === 'object' && parsed !== null && 'display_name' in parsed && typeof parsed.display_name === 'string' ? drawableName(parsed.display_name) : undefined
  } catch {
    return undefined
  }
}

function drawableName(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 80)
}

async function copyKeychainCommand($: EngineInterface, surface: RenderSurface): Promise<void> {
  const { setup } = await read($, gitgudState)
  if (setup?.email === undefined || setup.tokenFrom?.kind !== 'keychain') return
  const text = keychainAddCommand(setup.email, setup.platform ?? 'darwin')
  const copied = await $.ui.copy({ text, surface }).catch((): UiCopyResult => ({ isCopied: false, reason: 'refused' }))
  await notify($, copied.isCopied ? 'success' : 'error', copied.isCopied ? 'Command copied: run it in your own terminal' : "Couldn't copy the command", { topic: SETUP_TOPIC })
}

/** The sign-in command to fill, for the service the card is about. */
function signInCommandOf(state: GitgudState): string {
  const host = state.host ?? DEFAULT_HOST
  if (state.provider === 'gitlab') return `! glab auth login --hostname ${host}`

  return host === DEFAULT_HOST ? '! gh auth login' : `! gh auth login --hostname ${host}`
}

/** Core wiring: settings, `gh` health, polling, alerts, Jira statuses, one-liners, CI details and every row action. */
export function registerGitgudHooks(on: On): void {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await migrateStore($)
    forgetTokens()
    const started = await next(e)
    ticker?.cancel()
    isStarted = false
    if (hasLoadingLeft(await read($, gitgudState))) await update($, gitgudState, afterReload)
    ticker = $.clock.every(TICK_MS, () => detach(tick($)))
    if (await isPlaced($)) detach(poll($))

    return started
  })

  // Opening the card (its band tab, or its header toggle in any dock) reads stale data again.
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(tab|main-toggle|\d+-toggle)-gitgud$/ }, async ($, e, next) => {
    const pressed = await next(e)
    if (await isPlaced($)) detach(cardOpened($))

    return pressed
  })

  // Ticking the panel into a view in ⚙ Manage starts it at once rather than at the next tick.
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(main|\d+)-enable-\d+-gitgud$/ }, async ($, e, next) => {
    const pressed = await next(e)
    if (await isPlaced($)) detach(cardOpened($))

    return pressed
  })

  // gitgudOverlap.tsx hooks ↻ too, beneath this one.
  on('ui.press', { plugin: 'claudedockula', element: 'gitgud-refresh' }, async ($, e, next) => {
    const pressed = await next(e)
    detach(refreshAll($))

    return pressed
  })

  // The card header's ⚙ (the dock opens a minimized card first) and the settings' Done.
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(main|\d+)-settings-gitgud$/ }, async ($, e, next) => {
    const pressed = await next(e)
    await toggleSettings($)

    return pressed
  })

  // Reset all settings in ⚙ Manage: the dock has emptied the store by the time `next` returns.
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(main|\d+)-reset-all-yes$/ }, async ($, e, next) => {
    const pressed = await next(e)
    await forgetSettings($)

    return pressed
  })

  on('ui.press', { plugin: 'claudedockula', element: 'gitgud-settings' }, async ($, e) => {
    await toggleSettings($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-review-(done-(notice|bell|notify)|model-(sonnet|opus)|web-(on|off))$/ }, async ($, e) => {
    const [, kind = '', value = ''] = /^gitgud-review-(done|model|web)-(.+)$/.exec(e.element) ?? []
    if (kind === 'done' && isReviewDone(value)) await saveSettings($, settings => ({ ...settings, reviewDone: value }))
    if (kind === 'model' && isReviewModel(value)) await saveSettings($, settings => ({ ...settings, reviewModel: value }))
    if (kind === 'web') await saveSettings($, settings => ({ ...settings, isReviewWebOn: value === 'on' }))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'gitgud-more' }, async ($, e) => {
    await showMore($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-view-(review|mine|issues|search)$/ }, async ($, e) => {
    const view = e.element.slice(KEY.view.length)
    if (isView(view)) await changeUi($, ui => ({ ...ui, view, openId: undefined, menuId: undefined, shown: undefined }))
    detach(fillOneLiners($))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-scope-(repos|all)$/ }, async ($, e) => {
    const scope: GhScope = e.element.slice(KEY.scope.length) === 'all' ? 'all' : 'repos'
    await saveSettings($, settings => ({ ...settings, scope }))
    detach(poll($))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'gitgud-repo-add' }, async ($, e) => {
    detach(addRepo($))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-repo-remove-/ }, async ($, e) => {
    const name = decodeRepoName(e.element.slice(KEY.repoRemove.length))
    if (name) await removeRepo($, name)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'gitgud-search' }, async ($, e) => {
    detach(askSearch($))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-poll-(60|90|300)$/ }, async ($, e) => {
    const pollSeconds = Number(e.element.slice(KEY.poll.length))
    await saveSettings($, settings => ({ ...settings, pollSeconds }))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'gitgud-haiku-toggle' }, async ($, e) => {
    await toggleHaiku($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'gitgud-install' }, async ($, e) => {
    const tool = (await read($, gitgudState)).provider === 'gitlab' ? 'glab' : 'gh'
    await fillEmptyBox($, `! brew install ${tool}`, `Press Enter to install ${tool}, then ${tool} auth login and ↻ Refresh`, 'gitgud-install')

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'gitgud-login' }, async ($, e) => {
    const state = await read($, gitgudState)
    await fillEmptyBox($, signInCommandOf(state), `Press Enter to sign in to ${serviceOf(state.provider)}, then ↻ Refresh`, 'gitgud-login')

    return { element: e.element }
  })

  // Nothing here runs a sign-in, an install or a keychain write: each is filled into the prompt or copied for the person.
  on('ui.press', { plugin: 'claudedockula', element: 'gitgud-setup-pick' }, async ($, e) => {
    detach(exclusiveSetup(() => pressSetupPick($)))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'gitgud-setup-later' }, async ($, e) => {
    const isTokenCard = (await read($, gitgudState)).setup?.tokenFrom !== undefined
    if (isTokenCard) await setSetup($, () => undefined)
    else await changeUi($, ui => ({ ...ui, isSetupDismissed: true }))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'gitgud-setup-copy' }, async ($, e) => {
    detach(copyKeychainCommand($, e.surface))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'gitgud-setup-check' }, async ($, e) => {
    detach(exclusiveSetup(() => checkBitbucketToken($)))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-service-change-/ }, async ($, e) => {
    const host = e.element.slice(KEY.serviceChange.length)
    const info = hostInfoOf(await read($, gitgudState), host)
    detach(exclusiveSetup(() => pickService($, host, info?.provider)))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-row-/ }, async ($, e) => {
    const id = decodeItemId(e.element.slice(KEY.row.length))
    const openId = (await read($, gitgudState)).ui?.openId
    if (id) await openRow($, openId === id ? undefined : id)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-menu-/ }, async ($, e) => {
    const id = decodeItemId(e.element.slice(KEY.menu.length))
    if (id) await changeUi($, ui => ({ ...ui, reviewMenu: undefined, overlapMenu: undefined, menuId: ui.menuId === id ? undefined : id }))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-act-/ }, async ($, e) => {
    const act = parseActKey(e.element)
    if (act && !WORK_ACTIONS.includes(act.action)) {
      await changeUi($, ui => ({ ...ui, menuId: undefined }))
      detach(runAction($, act.action, act.id, e.surface))
    }

    return { element: e.element }
  })

  // The list Client's posts; the actions gitgudWork.tsx answers go on to its hook beneath this one.
  on('ui.message', { element: /^gitgud-list-/ }, async ($, e, next) => {
    const message = parseListMessage(e.data)
    if (message?.type === 'act' && WORK_ACTIONS.includes(message.action)) return next(e)
    if (message?.type === 'open') await openRow($, message.id ?? undefined)
    else if (message?.type === 'more') await showMore($)
    else if (message?.type === 'act') detach(runAction($, message.action, message.id, e.surface))

    return {}
  })
}

export const gitgudPanel: DockPanel = {
  id: 'gitgud',
  title: 'GitGud',
  icon: '🐙',
  description: 'Your review requests, PRs/MRs and issues on GitHub, GitLab or Bitbucket: CI, reviews, Jira, overlaps',
  isBuiltIn: true,
  hasSettings: true,
  revision: 4,
  whatsNew: "The GitHub panel is now GitGud: it reads GitLab and Bitbucket too, and asks which service when it can't tell"
}
