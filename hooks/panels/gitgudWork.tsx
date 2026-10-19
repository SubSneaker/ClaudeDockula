// The GitGud panel's work that writes files: background reviews by a locked-down headless Claude Code session, a PR
// description and a commit summary from Haiku, and the doc pane that shows what was written. Every function that
// touches `$` lives in this file; gitgud/* helpers are pure.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, ProcessSpawnChunk, ProcessSpawnResult, RenderSurface, Timer } from 'claude-code'

import type { GhDocKind, GhDocLink, GhGenJob, GhItem, GhReviewAsk, GhReviewJob, GitgudDocState, GitgudState, NoticeTone } from '../../types'
import { DEFAULT_LAYOUT, bandPanelIds, dockOpenArgs, lastOpenRightDock, messageOf, readLayout } from '../dock/layout'
import { NO_NOTICES, pushNotice } from '../dock/notices'
import { openCommands } from '../settings'
import {
  GIT_BRANCH,
  GIT_FILTER_DRIVERS,
  GIT_TOPLEVEL,
  GIT_VERSION,
  gitArchive,
  gitChangedSince,
  gitDiff,
  gitDiffStat,
  gitHasCommit,
  gitLogSince,
  gitMergeBase,
  removeReviewDir,
  tarExtract
} from './gitgud/argv'
import { isAllowedArgv, type ArgvGuardOptions } from './gitgud/guard'
import { parseHostSettings } from './gitgud/setup'
import { cleanDocText, docPaneTitle, drawDocPane, fitDocText } from './gitgud/docPane'
import { adapterOfRepo, currentKeyOf, itemStubOf, repoRefOf } from './gitgud/hosts'
import { parseItemId, repoFolderOf } from './gitgud/ids'
import { ticketOfItem } from './gitgud/jiraLink'
import {
  DOC_PANE_ID,
  GH_PANEL_ID,
  KEY,
  MAX_BACKGROUND_REVIEWS,
  STORE,
  WORK_ACTIONS,
  decodeItemId,
  docDirOf,
  docDirsOf,
  encodeItemId,
  isSessionRepo,
  parseActKey,
  parseAskKey,
  parseListMessage,
  type AskAnswerKind
} from './gitgud/model'
import { parseNameStatusZ } from './gitgud/overlap'
import { drawable, type FullThread, type Parsed } from './gitgud/parse'
import type { Op } from './gitgud/providers/types'
import {
  commitSummaryAsk,
  docFileName,
  formatCommitSummary,
  prDescriptionAsk,
  reviewFileMarkdown,
  reviewTaskPrompt,
  reviewerSystemPrompt,
  type BranchFacts,
  type ReviewCopy
} from './gitgud/prompts'
import {
  MIN_GIT,
  REVIEW_LIMIT_MS,
  STALE_REVIEW_MS,
  askAnswerJson,
  askDeadline,
  askIdOf,
  askPathOf,
  askTimeOf,
  borrowedRules,
  claudeCandidates,
  filterDriversOf,
  gitVersionOf,
  isAskPending,
  isCommitSha,
  isGitNewEnough,
  noReviewsRootText,
  parseAskFile,
  readStreamLine,
  relayPathOf,
  reviewBaseName,
  reviewDirTime,
  reviewLogMarkdown,
  reviewPaths,
  reviewSettingsOf,
  reviewerArgv,
  reviewerSettings,
  reviewsRootOf,
  splitLines,
  stepWords,
  wantsNotification,
  withTimedOutAsks,
  type ReviewLog,
  type ReviewPaths,
  type ReviewerLaunch,
  type StepPlaces,
  type StreamEvent
} from './gitgud/review'
import { findItem, isReviewRunning } from './gitgud/rows'
import {
  NOT_STARTED,
  failureLine,
  outcomeOf,
  refusedRun,
  thrownRun,
  type RunOutcome
} from './gitgud/run'
import { outcomeOfRun, runOpWith, type RunnerIo } from './gitgud/runner'

/** The reviewer starts with none of the person's plugins: their settings' plugin folders are cleared for it. */
const REVIEWER_ENV: Record<string, string> = { CLAUDE_CODE_PLUGIN_DIRS: '' }
/** How often a running review's asks folder is read; a waiting ask's warning blinks at this pace. */
const REVIEW_TICK_MS = 1_000
/** Every this many ticks the elapsed times and the readable log on disk catch up. */
const FLUSH_TICKS = 5
/** Every this many ticks the raw stream on disk catches up (it holds every file the reviewer read). */
const STREAM_FLUSH_TICKS = 30
const COPY_TIMEOUT_MS = 120_000
const MAX_STDERR_CHARS = 4_000
const MAX_DOCS = 30
const MAX_FINISHED_REVIEWS = 6
/** Above this the terminal's clipboard may drop the text without saying so (OSC 52). */
const MAX_COPY_CHARS = 64_000
/** The doc pane's width beside a fullscreen transcript; the docks take theirs back when it closes. */
const DOC_COLUMNS = 80
/** The folder of several templates a service reads beside its single-file paths. */
const TEMPLATE_FOLDERS: Record<string, string | undefined> = { github: '.github/PULL_REQUEST_TEMPLATE', gitlab: '.gitlab/merge_request_templates' }
const GEN_LABEL: Record<GenKind, string> = { 'pr-description': 'PR description', 'commit-summary': 'Commit summary' }

type GenKind = 'pr-description' | 'commit-summary'

type ResultEvent = Extract<StreamEvent, { type: 'result' }>

/** What the guard holds a review's commands to: the reviews root and the plugin's own folder. */
type ReviewGuard = Required<Pick<ArgvGuardOptions, 'reviewRoot' | 'pluginRoot'>> & Pick<ArgvGuardOptions, 'readDirs'>

/** A review this module runs: its folders, its log so far (kept here and written out as it goes), and its stream. */
interface ReviewRun {
  id: string
  paths: ReviewPaths
  places: StepPlaces
  log: ReviewLog
  /** The stream-json lines as they came. */
  lines: string[]
  logPath: string
  streamPath: string
  isDirty: boolean
  /** The copy's folder as the file system resolves it: a read that lands outside it went through a link. */
  realTree?: string
  /** Why it was stopped from outside (Stop, the time limit), once it was. */
  stopReason?: string
  /** Settles when it is stopped: the stream's next read is raced against it, so a silent reviewer stops too. */
  stopped: Promise<void>
  onStop: () => void
}

/** One review ready to start: everything its reviewer is given. */
interface ReviewPlan {
  run: ReviewRun
  item: GhItem
  copy: ReviewCopy
  launch: Omit<ReviewerLaunch, 'claude'>
  prompt: string
  candidates: string[]
  guard: ReviewGuard
}

/** How a reviewer ended: its last stream event and exit, or why it never ran. */
type ReviewOutcome = { error: string } | { result?: ResultEvent; exit: string }

const gitgudAtom = atom({ plugin: 'claudedockula', key: 'gitgud' } as const, {})
const docAtom = atom({ plugin: 'claudedockula', key: 'gitgudDoc' } as const, {})
const noticesAtom = atom({ plugin: 'claudedockula', key: 'notices' } as const, NO_NOTICES)
const layoutAtom = atom({ plugin: 'claudedockula', key: 'layout' } as const, DEFAULT_LAYOUT)

let areDocsLoaded = false
/** Item ids whose review is being prepared, so a double press starts one. */
const startingReviews = new Set<string>()
/** The reviews this module runs, by item id: a reload drops them with their children. */
const reviewRuns = new Map<string, ReviewRun>()
const generating = new Set<GenKind>()
let reviewTicker: Timer | undefined
let ticks = 0
let isTicking = false

/** Starts work a hook does not wait for; a failure is dropped rather than left unhandled. */
function detach(work: Promise<unknown>): void {
  work.catch(() => undefined)
}

async function notify($: EngineInterface, tone: NoticeTone, title: string, detail?: string, topic?: string): Promise<void> {
  const at = await $.clock.now()
  await update($, noticesAtom, list => pushNotice(list, { tone, title, at, ...(detail ? { detail } : {}), ...(topic ? { topic } : {}) }))
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
        return await $.process.run(argv, { timeoutMs: 10_000 })
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
    hosts: async () => {
      const state = await read($, gitgudAtom)

      return state.isSettingsLoaded === true ? state.settings?.hosts : parseHostSettings(await $.store.get(STORE.settings).catch(() => undefined))
    }
  }
}

/** Steps an adapter's operation: each request it yields runs through the guards, and its outcome goes back in. */
async function runOp<T>($: EngineInterface, op: Op<T>): Promise<Parsed<T>> {
  return runOpWith(ioOf($), op)
}

/** Runs a guarded command: read-only git, or the review's copy and cleanup inside the reviews root. Never throws. */
async function runGit($: EngineInterface, argv: string[], timeoutMs = 20_000, guard: ArgvGuardOptions = {}): Promise<RunOutcome> {
  if (!isAllowedArgv(argv, guard)) return refusedRun(argv)
  try {
    return outcomeOf(await $.process.run(argv, { timeoutMs }))
  } catch (error) {
    return thrownRun(error)
  }
}

function failureOf(ran: RunOutcome, what: string): Error {
  return new Error(`${what}: ${failureLine(ran)}`)
}

async function docDirOrNone($: EngineInterface): Promise<string | undefined> {
  return docDirOf(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'))
}

async function docDirsOrNone($: EngineInterface): Promise<string[]> {
  return docDirsOf(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'))
}

async function docDirOrThrow($: EngineInterface): Promise<string> {
  const dir = await docDirOrNone($)
  if (dir === undefined) throw new Error('Neither CLAUDE_CONFIG_DIR nor HOME is set, so there is nowhere to write.')

  return dir
}

/** A file this panel wrote: under one of its folders, with no `..` that could leave it. */
function isUnderDocDir(path: string, dirs: readonly string[]): boolean {
  return dirs.some(dir => path.startsWith(`${dir}/`)) && !path.split('/').includes('..')
}

function splitItemId(id: string): { repo: string; number: number } | undefined {
  const [, repo = '', number = ''] = /^([^#]+)#(\d+)$/.exec(id) ?? []

  return repo ? { repo, number: Number(number) } : undefined
}

function isDocKind(value: unknown): value is GhDocKind {
  return value === 'review' || value === 'pr-description' || value === 'commit-summary' || value === 'review-log'
}

function fieldOf(value: unknown, field: string): unknown {
  return typeof value === 'object' && value !== null && field in value ? Reflect.get(value, field) : undefined
}

/** The stored file list, checked: anything malformed is dropped, titles made drawable. */
function parseDocLinks(raw: unknown): GhDocLink[] {
  if (!Array.isArray(raw)) return []

  return raw.flatMap((entry: unknown): GhDocLink[] => {
    const [kind, title, path, createdAt, itemId] = ['kind', 'title', 'path', 'createdAt', 'itemId'].map(field => fieldOf(entry, field))
    if (!isDocKind(kind) || typeof title !== 'string' || typeof path !== 'string' || typeof createdAt !== 'number') return []

    return [{ kind, title: drawable(title), path, createdAt, ...(typeof itemId === 'string' ? { itemId } : {}) }]
  })
}

/** A row's item when the lists hold it; else what the thread says, which is all a review needs. */
function itemOf(id: string, thread: Pick<FullThread, 'repo' | 'number' | 'title' | 'url' | 'author'>, known: GhItem | undefined, provider: GhItem['provider']): GhItem {
  return known ?? { id, kind: 'pr', ...(provider === undefined ? {} : { provider }), repo: thread.repo, number: thread.number, title: thread.title, url: thread.url, author: thread.author, updatedAt: '', comments: 0 }
}

function firstLineOf(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.trim() ?? 'the service gave nothing back'
}

/** The full head commit: what the thread or the lists gave, else the adapter reads it (an abbreviated hash is resolved). */
async function headShaOf($: EngineInterface, item: GhItem, known: string | undefined): Promise<string | undefined> {
  if (known !== undefined) return known
  const adapter = adapterOfRepo(await read($, gitgudAtom), item.repo)
  const head = adapter === undefined ? undefined : await runOp($, adapter.head(item))

  return head?.isOk ? head.value.headSha : undefined
}

/** `#` or `!`, as the item's service writes its numbers. */
async function sigilOfId($: EngineInterface, id: string): Promise<string> {
  const repo = parseItemId(id)?.repo
  const adapter = repo === undefined ? undefined : adapterOfRepo(await read($, gitgudAtom), repo)

  return adapter?.caps.vocab.sigil ?? '#'
}

function isActive(job: GhReviewJob): boolean {
  return job.phase === 'queued' || job.phase === 'running'
}

/** Running jobs, plus the newest finished ones: older finished jobs drop off the card. */
function prunedReviews(reviews: Record<string, GhReviewJob>): Record<string, GhReviewJob> {
  const finished = Object.values(reviews)
    .filter(job => !isActive(job))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(MAX_FINISHED_REVIEWS)
    .map(job => job.itemId)

  return Object.fromEntries(Object.entries(reviews).filter(([id]) => !finished.includes(id)))
}

function cleanJob(job: GhReviewJob): GhReviewJob {
  return { ...job, title: drawable(job.title), ...(job.error === undefined ? {} : { error: drawable(job.error) }) }
}

async function setJob($: EngineInterface, id: string, job: GhReviewJob): Promise<void> {
  const now = await $.clock.now()
  await update($, gitgudAtom, state => ({ ...state, now, reviews: prunedReviews({ ...state.reviews, [id]: cleanJob(job) }) }))
}

/** Changes a job as the state holds it at the write, so a step and an ask landing together both stay. */
async function changeJob($: EngineInterface, id: string, change: (job: GhReviewJob) => GhReviewJob): Promise<void> {
  const now = await $.clock.now()
  if ((await read($, gitgudAtom)).reviews?.[id] === undefined) return
  await update($, gitgudAtom, state => {
    const job = state.reviews?.[id]

    return job === undefined ? state : { ...state, now, reviews: prunedReviews({ ...state.reviews, [id]: cleanJob(change(job)) }) }
  })
}

async function failJob($: EngineInterface, id: string, error: string): Promise<void> {
  const endedAt = await $.clock.now()
  await changeJob($, id, job => ({ ...job, phase: 'failed', endedAt, error, activity: undefined }))
}

async function setGen($: EngineInterface, kind: GenKind, job: GhGenJob): Promise<void> {
  await update($, gitgudAtom, state => ({ ...state, gen: { ...state.gen, [kind]: job } }))
}

/**
 * Adds a written file to the card and to the store (shared by sessions), newest first. Its `createdAt` is made
 * unique in the list, since the card's Buttons name a file by it.
 */
async function addDoc($: EngineInterface, link: GhDocLink): Promise<void> {
  const stored = parseDocLinks(await $.store.get(STORE.docs).catch(() => []))
  const others = stored.filter(one => one.path !== link.path)
  const taken = new Set(others.map(one => one.createdAt))
  let createdAt = link.createdAt
  while (taken.has(createdAt)) createdAt += 1
  const docs = [{ ...link, title: drawable(link.title), createdAt }, ...others].slice(0, MAX_DOCS)
  await $.store.set(STORE.docs, docs).catch(() => undefined)
  await update($, gitgudAtom, state => ({ ...state, docs }))
}

// --- background reviews: a headless Claude Code session on a clean copy of the PR ---

/**
 * The reviews root and the plugin's folder: the guard holds the copy, the reviewer and the cleanup to them. Throws,
 * saying why, when there is no absolute temp folder: nothing is made under the session's working directory.
 */
async function reviewGuard($: EngineInterface): Promise<ReviewGuard> {
  const tmpDir = await $.env.get('TMPDIR')
  const reviewRoot = reviewsRootOf(tmpDir, await $.env.get('HOME'))
  if (reviewRoot === undefined) throw new Error(noReviewsRootText(tmpDir))

  return { reviewRoot, pluginRoot: $.plugin.root }
}

/** A finished review's folder, gone; only ever one inside the reviews root. */
async function removeWorkDir($: EngineInterface, dir: string): Promise<void> {
  const guard = await reviewGuard($).catch(() => undefined)
  if (guard !== undefined) await runGit($, removeReviewDir(dir), 60_000, guard)
}

/** Reads the PR's thread and diff, makes its copy and starts its reviewer in the background. */
async function startReview($: EngineInterface, id: string): Promise<void> {
  const parts = splitItemId(id)
  if (parts === undefined || startingReviews.has(id)) return
  // Taken before the first wait, so a second press on the same PR stops at the check above.
  startingReviews.add(id)
  let plan: ReviewPlan | undefined
  try {
    const state = await read($, gitgudAtom)
    if (isReviewRunning(state, id)) {
      await notify($, 'info', `A review of ${await sigilOfId($, id)}${parts.number} is already running`)

      return
    }
    // Reviews still starting count too: two quick presses on different PRs can't both pass the limit.
    const counted = new Set([...Object.values(state.reviews ?? {}).filter(isActive).map(job => job.itemId), ...startingReviews])
    if (counted.size > MAX_BACKGROUND_REVIEWS) {
      await notify($, 'info', `${MAX_BACKGROUND_REVIEWS} reviews are already running`, 'Start another when one is done.')

      return
    }
    const known = findItem(state, id)
    const startedAt = await $.clock.now()
    await setJob($, id, { itemId: id, title: known?.title ?? `${await sigilOfId($, id)}${parts.number}`, phase: 'queued', startedAt, activity: 'reading the pull request…' })
    plan = await prepareReview($, id, parts, known, state, startedAt)
  } catch (error) {
    const workDir = (await read($, gitgudAtom)).reviews?.[id]?.workDir
    await failJob($, id, messageOf(error))
    if (workDir !== undefined) await removeWorkDir($, workDir)
  } finally {
    startingReviews.delete(id)
  }
  if (plan !== undefined) await runReview($, plan)
}

/**
 * The PR's committed files at its head commit, unpacked in the review's folder: only when the commit is already on
 * this machine (nothing is fetched). Otherwise no copy, and why.
 */
async function makeCopy($: EngineInterface, sha: string | undefined, isOwnRepo: boolean, paths: ReviewPaths, guard: ReviewGuard, noun: string): Promise<ReviewCopy> {
  if (!isOwnRepo) return { kind: 'none', why: `the ${noun} is not in this folder's repo` }
  if (!isCommitSha(sha)) return { kind: 'none', why: `the service didn't give the ${noun}'s head commit` }
  const version = gitVersionOf((await runGit($, GIT_VERSION, 20_000, guard)).stdout)
  if (!isGitNewEnough(version)) return { kind: 'none', why: `git ${version?.join('.') ?? '(version unknown)'} is older than ${MIN_GIT.join('.')}, which the clean copy needs` }
  const has = await runGit($, gitHasCommit(sha), 20_000, guard)
  if (has.exitCode !== 0) return { kind: 'none', why: `its head commit ${sha.slice(0, 7)} is not on this machine` }
  const listed = await runGit($, GIT_FILTER_DRIVERS, 20_000, guard)
  // `git config --get-regexp` exits 1 when no filter driver is set.
  const drivers = listed.exitCode === 0 || (listed.exitCode === 1 && listed.stdout === '') ? filterDriversOf(listed.stdout) : undefined
  if (drivers === undefined) return { kind: 'none', why: "couldn't read git's filter drivers, so the copy could not switch them off" }
  const archived = await runGit($, gitArchive(sha, paths.tar, drivers), COPY_TIMEOUT_MS, guard)
  if (archived.exitCode !== 0) return { kind: 'none', why: `couldn't copy it: ${failureLine(archived)}` }
  const unpacked = await runGit($, tarExtract(paths.tar, paths.dir), COPY_TIMEOUT_MS, guard)
  if (unpacked.exitCode !== 0) return { kind: 'none', why: `couldn't unpack the copy: ${failureLine(unpacked)}` }

  return { kind: 'copy', sha }
}

/** The person's skill folders that exist: their own, and this checkout's (never the PR copy's). */
async function findSkillDirs($: EngineInterface): Promise<string[]> {
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR'))?.trim()
  const home = (await $.env.get('HOME'))?.trim()
  const claudeDir = configDir || (home ? `${home.replace(/\/+$/, '')}/.claude` : undefined)
  const top = await runGit($, GIT_TOPLEVEL)
  const root = top.exitCode === 0 ? top.stdout.trim() : ''
  const candidates = [claudeDir ? `${claudeDir.replace(/\/+$/, '')}/skills` : '', root ? `${root}/.claude/skills` : '', root ? `${root}/.agents/skills` : '']
  const found: string[] = []
  for (const dir of candidates) {
    if (dir !== '' && (await $.fs.stat(dir).catch(() => undefined))?.kind === 'dir') found.push(dir)
  }

  return found
}

/** Reads the thread and the diff, makes the copy, and puts together the reviewer's argv, settings, prompt and log. */
async function prepareReview(
  $: EngineInterface,
  id: string,
  parts: { repo: string; number: number },
  known: GhItem | undefined,
  state: GitgudState,
  startedAt: number
): Promise<ReviewPlan> {
  const adapter = adapterOfRepo(state, parts.repo)
  if (adapter === undefined) throw new Error('this pull request is on a service GitGud cannot read')
  const stub = known ?? itemStubOf(id, parts.repo, parts.number, adapter.id)
  const [thread, diff] = await Promise.all([runOp($, adapter.thread(stub)), runOp($, adapter.diff(stub))])
  if (!thread.isOk) throw new Error(`couldn't read the ${adapter.caps.vocab.noun}: ${firstLineOf(thread.error)}`)
  if (!diff.isOk) throw new Error(`couldn't read the diff: ${firstLineOf(diff.error)}`)
  const item = itemOf(id, thread.value, known, adapter.id)
  const headSha = await headShaOf($, stub, thread.value.headSha ?? (known?.isHeadShaShort === true ? undefined : known?.headSha))
  const guard = await reviewGuard($)
  const paths = reviewPaths(guard.reviewRoot, parts.repo, parts.number, startedAt)
  await $.fs.write(`${paths.asks}/.keep`, '')
  await changeJob($, id, job => ({ ...job, title: item.title, workDir: paths.dir, activity: 'making a clean copy of the pull request…' }))
  const copy = await makeCopy($, headSha, isSessionRepo(parts.repo, currentKeyOf(state)), paths, guard, adapter.caps.vocab.noun)
  if (copy.kind === 'none') await $.fs.write(`${paths.tree}/NO-COPY.md`, `No copy of the pull request's code: ${copy.why}. Review from the diff and the discussion.\n`)
  const settings = reviewSettingsOf(await $.store.get(STORE.settings).catch(() => undefined))
  const skillDirs = await findSkillDirs($)
  const realTree = (await $.fs.stat(paths.tree, { resolve: true }).catch(() => undefined))?.realPath
  const borrowed = borrowedRules(await $.settings.read().catch(() => ({})), settings.isWebOn)
  const launch: Omit<ReviewerLaunch, 'claude'> = {
    model: settings.model,
    isWebOn: settings.isWebOn,
    settings: reviewerSettings(relayPathOf(guard.pluginRoot), paths.asks, borrowed),
    system: reviewerSystemPrompt({ copy, tree: paths.tree, skillDirs, isWebOn: settings.isWebOn }),
    addDirs: skillDirs
  }
  const prompt = reviewTaskPrompt({ item, thread: thread.value, diff: diff.value, copy })
  const home = (await $.env.get('HOME'))?.trim()
  const base = `${await docDirOrThrow($)}/${repoFolderOf(parts.repo)}/${reviewBaseName(parts.number, startedAt)}`
  const log: ReviewLog = {
    title: item.title,
    number: parts.number,
    url: item.url,
    logPath: `${base}.log.md`,
    streamPath: `${base}.jsonl`,
    env: REVIEWER_ENV,
    startedAt,
    model: settings.model,
    isWebOn: settings.isWebOn,
    copy: copy.kind === 'copy' ? `a clean copy of the pull request at ${copy.sha}` : `no copy: ${copy.why}`,
    readable: [paths.tree, ...skillDirs],
    argv: [],
    promptChars: prompt.length,
    steps: [],
    asks: [],
    denials: [],
    notes: [],
    stderr: ''
  }
  let onStop: () => void = () => undefined
  const stopped = new Promise<void>(resolve => {
    onStop = resolve
  })
  const run: ReviewRun = {
    id,
    paths,
    stopped,
    onStop,
    places: { tree: paths.tree, ...(home ? { home: home.replace(/\/+$/, '') } : {}) },
    log,
    lines: [],
    logPath: `${base}.log.md`,
    streamPath: `${base}.jsonl`,
    isDirty: true,
    ...(realTree === undefined ? {} : { realTree })
  }

  return { run, item, copy, launch, prompt, candidates: claudeCandidates(home), guard: { ...guard, readDirs: skillDirs } }
}

/** Writes the readable log beside the review file, and the raw stream with it unless `isLogOnly`. */
async function flushLog($: EngineInterface, run: ReviewRun, isLogOnly = false): Promise<void> {
  run.isDirty = false
  if (!isLogOnly) await $.fs.write(run.streamPath, run.lines.length > 0 ? `${run.lines.join('\n')}\n` : '').catch(() => undefined)
  await $.fs.write(run.logPath, reviewLogMarkdown(run.log)).catch(() => undefined)
}

/**
 * Ends a running reviewer from outside: Stop, or the time limit. Every ask still waiting is denied first, so the relay
 * lets the reviewer go on to its next output (where the engine ends it); then its stream is left and the review fails
 * saying why.
 */
async function stopReview($: EngineInterface, run: ReviewRun, reason: string): Promise<void> {
  if (run.stopReason !== undefined) return
  run.stopReason = reason
  await denyWaitingAsks($, run).catch(() => undefined)
  run.onStop()
}

/** Writes a deny answer for every ask the relay left without one, read by the card yet or not. */
async function denyWaitingAsks($: EngineInterface, run: ReviewRun): Promise<void> {
  const names = (await $.fs.list(run.paths.asks).catch(() => [])).map(entry => entry.name)
  const waiting = names.flatMap(name => askIdOf(name) ?? []).filter(id => !names.includes(`answer-${id}.json`))
  const now = await $.clock.now()
  for (const id of waiting) await $.fs.write(`${run.paths.asks}/answer-${id}.json`, askAnswerJson('deny', {}))
  await changeJob($, run.id, job => ({ ...job, asks: (job.asks ?? []).map(ask => (waiting.includes(ask.id) && ask.answer === undefined ? { ...ask, answer: 'deny', answeredAt: now } : ask)) }))
  for (const ask of run.log.asks) if (waiting.includes(ask.id) && ask.answer === undefined) Object.assign(ask, { answer: 'deny', answeredAt: now })
  run.isDirty = true
}

/** Runs the reviewer to its end (30 minutes at most), then writes the review, tells the person and removes the copy. */
async function runReview($: EngineInterface, plan: ReviewPlan): Promise<void> {
  const { run, copy } = plan
  reviewRuns.set(run.id, run)
  const limit = $.clock.after(REVIEW_LIMIT_MS, () => detach(stopReview($, run, 'it ran past 30 minutes and was stopped')))
  let outcome: ReviewOutcome
  try {
    await changeJob($, run.id, job => ({
      ...job,
      phase: 'running',
      activity: 'starting the reviewer…',
      steps: 0,
      asks: [],
      model: plan.launch.model,
      logPath: run.logPath,
      streamPath: run.streamPath,
      ...(copy.kind === 'copy' ? { copySha: copy.sha } : { noCopy: copy.why })
    }))
    await flushLog($, run)
    startReviewTicker($)
    outcome = await streamReviewer($, plan)
  } catch (error) {
    outcome = { error: messageOf(error) }
  } finally {
    limit.cancel()
  }
  await endReview($, plan, outcome)
}

/** Starts the reviewer (the first `claude` that starts) and reads its stream until it exits. */
async function streamReviewer($: EngineInterface, plan: ReviewPlan): Promise<ReviewOutcome> {
  let lastError = 'claude is not installed'
  for (const claude of plan.candidates) {
    const argv = reviewerArgv({ ...plan.launch, claude })
    if (!isAllowedArgv(argv, plan.guard)) return { error: 'ClaudeDockula refused to start the reviewer' }
    const { run } = plan
    run.log.argv = argv
    const child = $.process.spawn({ argv, cwd: run.paths.tree, env: REVIEWER_ENV, input: plan.prompt })
    let step: IteratorResult<ProcessSpawnChunk, ProcessSpawnResult>
    try {
      const first = child.next()
      first.catch(() => undefined)
      const raced = await Promise.race([first, run.stopped.then(() => undefined)])
      if (raced === undefined) {
        child.return({ code: null, signal: null }).catch(() => undefined)

        return { exit: 'stopped' }
      }
      step = raced
    } catch (error) {
      lastError = messageOf(error)
      if (thrownRun(error).exitCode === NOT_STARTED) continue

      return { error: `couldn't start claude: ${lastError}` }
    }
    let buffer = ''
    let result: ResultEvent | undefined
    try {
      while (!step.done) {
        const piece = step.value
        if (piece.stream === 'stderr') {
          run.log.stderr = `${run.log.stderr}${piece.text}`.slice(-MAX_STDERR_CHARS)
        } else {
          const split = splitLines(buffer + piece.text)
          buffer = split.rest
          for (const line of split.lines) result = (await takeLine($, run, line)) ?? result
        }
        const pending = child.next()
        pending.catch(() => undefined)
        const raced = await Promise.race([pending, run.stopped.then(() => undefined)])
        if (raced === undefined) break
        step = raced
      }
    } finally {
      // Leaving the stream early (a throw above, Stop, the time limit) asks the engine to end the child: `return()` is
      // the only way the spawn API offers, and it takes effect at the child's next output at the latest.
      if (!step.done) child.return({ code: null, signal: null }).catch(() => undefined)
    }
    if (buffer.trim() !== '') result = (await takeLine($, run, buffer)) ?? result
    const exit = step.done ? (step.value.signal ?? String(step.value.code ?? '?')) : 'stopped'

    return { ...(result === undefined ? {} : { result }), exit }
  }

  return { error: `couldn't start claude: ${lastError}` }
}

/** One stream-json line: kept verbatim for the stream file, read into the log and the card's progress. */
async function takeLine($: EngineInterface, run: ReviewRun, line: string): Promise<ResultEvent | undefined> {
  run.lines.push(line)
  run.isDirty = true
  const at = await $.clock.now()
  let result: ResultEvent | undefined
  for (const event of readStreamLine(line)) {
    if (event.type === 'tool') {
      const words = stepWords(event.name, event.input, run.places)
      run.log.steps.push({ id: event.id, at, tool: event.name, words, status: 'running' })
      await changeJob($, run.id, job => ({ ...job, activity: words, steps: (job.steps ?? 0) + 1 }))
    } else if (event.type === 'tool-result') {
      const step = run.log.steps.find(one => one.id === event.id)
      if (step) Object.assign(step, { status: event.isError ? 'error' : 'ok', ...(event.error === undefined ? {} : { error: event.error }) })
    } else if (event.type === 'denied') {
      run.log.denials.push({ ...event.denial, at })
    } else if (event.type === 'init') {
      run.log.notes.push(`Claude Code started with the tools ${event.tools.join(', ') || 'none'} and the skills ${event.skills.join(', ') || 'none'}.`)
    } else if (event.type === 'result') {
      result = event
    }
  }

  return result
}

/** Why a review gave no review file, or undefined when it answered. */
function failureText(outcome: ReviewOutcome, stopReason: string | undefined): string | undefined {
  if (stopReason !== undefined) return stopReason
  if ('error' in outcome) return outcome.error
  const { result } = outcome
  if (result === undefined) return `the reviewer stopped without an answer (exit ${outcome.exit})`
  if (result.subtype === 'error_max_turns') return 'it hit the 30-turn limit'
  if (result.isError || result.subtype !== 'success') return `it ended with ${result.subtype}`

  return result.text.trim() === '' ? 'it gave no review' : undefined
}

/** The review is over: the log written out, the review file and its notice, the notification asked for, the copy gone. */
async function endReview($: EngineInterface, plan: ReviewPlan, outcome: ReviewOutcome): Promise<void> {
  const { run } = plan
  reviewRuns.delete(run.id)
  try {
    const endedAt = await $.clock.now()
    const failure = failureText(outcome, run.stopReason)
    const result = 'result' in outcome ? outcome.result : undefined
    run.log.end = {
      at: endedAt,
      status: failure ?? 'review written',
      ...(result?.turns === undefined ? {} : { turns: result.turns }),
      ...(result?.costUsd === undefined ? {} : { costUsd: result.costUsd }),
      exit: 'exit' in outcome ? outcome.exit : 'never started'
    }
    // The final result lists every denial; ones the stream did not report on their own join the log there.
    for (const denial of result?.denials.slice(run.log.denials.length) ?? []) run.log.denials.push({ ...denial, at: endedAt })
    for (const ask of run.log.asks) if (ask.answer === undefined) Object.assign(ask, { answer: 'ended', answeredAt: endedAt })
    await flushLog($, run)
    if (failure !== undefined || result === undefined) await failReview($, run, failure ?? 'it gave no review')
    else await writeReview($, plan, result.text, endedAt)
  } catch (error) {
    await failJob($, run.id, messageOf(error)).catch(() => undefined)
  } finally {
    await removeWorkDir($, run.paths.dir).catch(() => undefined)
  }
}

/** The answer saved under the doc folder (never the repo), listed under Files, then the person told. */
async function writeReview($: EngineInterface, plan: ReviewPlan, answer: string, endedAt: number): Promise<void> {
  const { run, item, copy } = plan
  const path = run.logPath.replace(/\.log\.md$/, '.md')
  try {
    const origin = { model: plan.launch.model, ...(copy.kind === 'copy' ? { copySha: copy.sha } : { noCopy: copy.why }) }
    await $.fs.write(path, reviewFileMarkdown(item, answer, endedAt, origin))
    await addDoc($, { kind: 'review', title: `Review ${await sigilOfId($, run.id)}${item.number} · ${item.title}`, path, createdAt: endedAt, itemId: run.id })
    await changeJob($, run.id, job => ({ ...job, phase: 'done', endedAt, path, activity: undefined }))
    await announceEnd($, run.id, true, path)
  } catch (error) {
    await failReview($, run, `couldn't write the review: ${messageOf(error)}`)
  }
}

async function failReview($: EngineInterface, run: ReviewRun, error: string): Promise<void> {
  await failJob($, run.id, error)
  await announceEnd($, run.id, false, error)
}

/**
 * The notice (Open, or Log for a failure) and, when the settings ask for it, a notification through the person's
 * own channel: the bell or a system notification. A notification that was not sent says why in the notice.
 */
async function announceEnd($: EngineInterface, id: string, isDone: boolean, detail: string): Promise<void> {
  const number = `${await sigilOfId($, id)}${id.slice(id.lastIndexOf('#') + 1)}`
  const title = isDone ? `Review of ${number} ready` : `Review of ${number} failed`
  const { done } = reviewSettingsOf(await $.store.get(STORE.settings).catch(() => undefined))
  let unsent = ''
  if (wantsNotification(done)) {
    const sent = await $.ui.notify(title, { title: 'ClaudeDockula' }).catch(() => ({ isSent: false as const, reason: 'refused' as const }))
    if (!sent.isSent) unsent = `\nNo notification: ${sent.reason}`
  }
  const action = { key: `${KEY.reviewAct}${isDone ? 'open' : 'log'}-${encodeItemId(id)}`, label: isDone ? 'Open' : 'Log' }
  const at = await $.clock.now()
  await update($, noticesAtom, list => pushNotice(list, { tone: isDone ? 'success' : 'error', title, detail: `${detail}${unsent}`, topic: `gitgud-review-${id}`, action, at }))
}

// --- the reviewer's asks: relayed through files, answered from the card ---

/** Started again with each review, so a ticker the engine stopped never leaves asks unread. */
function startReviewTicker($: EngineInterface): void {
  reviewTicker?.cancel()
  reviewTicker = $.clock.every(REVIEW_TICK_MS, () => detach(tickReviews($)))
}

/** The asks the relay left since the last look, read; `askedAt` is when the panel first saw them. */
async function readNewAsks($: EngineInterface, run: ReviewRun, now: number): Promise<GhReviewAsk[]> {
  const entries = await $.fs.list(run.paths.asks).catch(() => [])
  const known = new Set(run.log.asks.map(ask => ask.id))
  const fresh: GhReviewAsk[] = []
  for (const entry of entries) {
    const id = askIdOf(entry.name)
    if (id === undefined || known.has(id)) continue
    const text = await $.fs.read(`${run.paths.asks}/${entry.name}`).catch(() => undefined)
    const parsed = text === undefined ? undefined : parseAskFile(id, text, run.places)
    if (text === undefined || parsed === undefined) continue
    const link = await linkTarget($, run, askPathOf(text))
    const what = link === undefined ? parsed.what : `${parsed.what}, a link out of the copy to ${drawable(link)}`
    const askedAt = askTimeOf(id, now)
    fresh.push({ ...parsed, what, askedAt })
    run.log.asks.push({ id, at: askedAt, tool: parsed.tool, what })
    run.isDirty = true
  }

  return fresh
}

/** Where a path the reviewer named inside its copy really lands, when that is outside the copy (a link in the PR). */
async function linkTarget($: EngineInterface, run: ReviewRun, path: string | undefined): Promise<string | undefined> {
  if (path === undefined || run.realTree === undefined || !path.startsWith(`${run.paths.tree}/`)) return undefined
  const real = (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath

  return real !== undefined && !real.startsWith(`${run.realTree}/`) ? real : undefined
}

/**
 * Every second while a review runs: new asks join their job, asks past 10 minutes show as denied, and a waiting ask
 * blinks (the state's `blink` flips). Every few seconds the elapsed times and the logs on disk catch up.
 */
async function tickReviews($: EngineInterface): Promise<void> {
  if (reviewRuns.size === 0) {
    reviewTicker?.cancel()
    reviewTicker = undefined
    if ((await read($, gitgudAtom)).blink === true) await update($, gitgudAtom, state => ({ ...state, blink: false }))

    return
  }
  // A slow tick is never overlapped: the next one would read the same asks again.
  if (isTicking) return
  isTicking = true
  try {
    await tickRunning($)
  } finally {
    isTicking = false
  }
}

async function tickRunning($: EngineInterface): Promise<void> {
  ticks += 1
  const now = await $.clock.now()
  const fresh = new Map<string, GhReviewAsk[]>()
  for (const run of reviewRuns.values()) {
    const asks = await readNewAsks($, run, now)
    if (asks.length > 0) fresh.set(run.id, asks)
  }
  const state = await read($, gitgudAtom)
  const isWaiting = Object.values(state.reviews ?? {}).some(job => job.phase === 'running' && [...(job.asks ?? []), ...(fresh.get(job.itemId) ?? [])].some(ask => isAskPending(ask, now)))
  const isFlushTick = ticks % FLUSH_TICKS === 0
  if (fresh.size > 0 || isWaiting || isFlushTick || state.blink === true) {
    await update($, gitgudAtom, value => ({ ...value, now, blink: isWaiting && value.blink !== true, reviews: withAsks(value.reviews, fresh, now) }))
  }
  noteTimeouts(now)
  if (!isFlushTick) return
  const isStreamTick = ticks % STREAM_FLUSH_TICKS === 0
  for (const run of reviewRuns.values()) if (run.isDirty || isStreamTick) await flushLog($, run, !isStreamTick)
}

/**
 * The running jobs with their new asks added and the ones past 10 minutes marked as denied.
 * @example
 * // before: { 'o/r#1': { phase: 'running', asks: [] } }, Map { 'o/r#1' → [ask] }
 * // after:  { 'o/r#1': { phase: 'running', asks: [ask] } }
 */
function withAsks(reviews: Record<string, GhReviewJob> | undefined, fresh: ReadonlyMap<string, GhReviewAsk[]>, now: number): Record<string, GhReviewJob> | undefined {
  if (reviews === undefined) return reviews

  return Object.fromEntries(
    Object.entries(reviews).map(([id, job]) => {
      if (job.phase !== 'running') return [id, job]
      const asks = withTimedOutAsks([...(job.asks ?? []), ...(fresh.get(id) ?? [])], now)

      return [id, { ...job, asks }]
    })
  )
}

/** The log learns which asks went unanswered, as the card does. */
function noteTimeouts(now: number): void {
  for (const run of reviewRuns.values()) {
    for (const ask of run.log.asks) {
      if (ask.answer !== undefined || now < askDeadline(ask.at)) continue
      ask.answer = 'timeout'
      ask.answeredAt = askDeadline(ask.at)
      run.isDirty = true
    }
  }
}

/** Allow once, Allow … for this review, or Deny: the relay's answer file, while the ask still waits. */
async function answerAsk($: EngineInterface, itemId: string, askId: string, answer: AskAnswerKind): Promise<void> {
  const run = reviewRuns.get(itemId)
  const job = (await read($, gitgudAtom)).reviews?.[itemId]
  const ask = job?.asks?.find(one => one.id === askId)
  const now = await $.clock.now()
  if (run === undefined || job?.phase !== 'running' || ask === undefined || !isAskPending(ask, now)) return
  const given: AskAnswerKind = answer === 'review' && (ask.rules ?? []).length === 0 ? 'once' : answer
  await $.fs.write(`${run.paths.asks}/answer-${askId}.json`, askAnswerJson(given, ask))
  await changeJob($, itemId, current => ({ ...current, asks: (current.asks ?? []).map(one => (one.id === askId ? { ...one, answer: given, answeredAt: now } : one)) }))
  const logged = run.log.asks.find(one => one.id === askId)
  if (logged) Object.assign(logged, { answer: given, answeredAt: now })
  run.isDirty = true
}

/**
 * Review folders no running review owns: older than any review lasts, left by a session that quit mid-review. A
 * folder of another session's review is younger, and stays.
 */
async function sweepStaleReviews($: EngineInterface): Promise<void> {
  const reviewRoot = (await reviewGuard($).catch(() => undefined))?.reviewRoot
  if (reviewRoot === undefined) return
  const now = await $.clock.now()
  const owned = new Set([...reviewRuns.values()].map(run => run.paths.dir))
  for (const entry of await $.fs.list(reviewRoot).catch(() => [])) {
    const madeAt = reviewDirTime(entry.name)
    const dir = `${reviewRoot}/${entry.name}`
    if (entry.kind === 'dir' && madeAt !== undefined && now - madeAt > STALE_REVIEW_MS && !owned.has(dir)) await removeWorkDir($, dir)
  }
}

/**
 * At session start and after a reload: a review this module is not running lost its reviewer with the old code. It
 * fails saying so, its log says it too, and its copy goes.
 */
async function recoverReviews($: EngineInterface): Promise<void> {
  const orphans = Object.values((await read($, gitgudAtom)).reviews ?? {}).filter(job => isActive(job) && !reviewRuns.has(job.itemId) && !startingReviews.has(job.itemId))
  const dirs = await docDirsOrNone($)
  for (const job of orphans) {
    await failJob($, job.itemId, 'interrupted by a reload — Retry')
    if (job.logPath !== undefined && isUnderDocDir(job.logPath, dirs)) {
      const text = await $.fs.read(job.logPath).catch(() => undefined)
      if (text !== undefined) await $.fs.write(job.logPath, `${text}\nInterrupted: ClaudeDockula reloaded and its reviewer stopped with it.\n`).catch(() => undefined)
    }
    if (job.workDir !== undefined) await removeWorkDir($, job.workDir)
  }
}

/** After a reload a write in progress was lost with the module: it says so, and a press starts it again. */
async function recoverGeneration($: EngineInterface): Promise<void> {
  const gen = (await read($, gitgudAtom)).gen ?? {}
  const interrupted = (['pr-description', 'commit-summary'] as const).filter(kind => gen[kind]?.phase === 'running' && !generating.has(kind))
  for (const kind of interrupted) {
    await setGen($, kind, { phase: 'failed', startedAt: gen[kind]?.startedAt ?? 0, error: 'interrupted by a reload' })
  }
}

/** Forgets a job: Retry starts a new one, Dismiss drops a finished one. */
async function dropJob($: EngineInterface, id: string): Promise<void> {
  await update($, gitgudAtom, state => {
    const { [id]: _dropped, ...reviews } = state.reviews ?? {}

    return { ...state, reviews, ui: { ...state.ui, reviewMenu: undefined } }
  })
}

/**
 * A background review row's menu entry (Open, Log, Raw stream, Stop, Retry, Dismiss), its inline Retry or Log, or a
 * notice's Open or Log.
 */
async function runReviewAction($: EngineInterface, action: string, id: string): Promise<void> {
  const job = (await read($, gitgudAtom)).reviews?.[id]
  await update($, gitgudAtom, state => ({ ...state, ui: { ...state.ui, reviewMenu: undefined } }))
  if (job === undefined) return
  const number = `${await sigilOfId($, id)}${id.slice(id.lastIndexOf('#') + 1)}`
  if (action === 'open' && job.path !== undefined) return openInPane($, { kind: 'review', title: `Review ${number} · ${job.title}`, path: job.path })
  if (action === 'log' && job.logPath !== undefined) {
    const run = reviewRuns.get(id)
    if (run !== undefined) await flushLog($, run)

    return openInPane($, { kind: 'review-log', title: `Log · Review ${number}`, path: job.logPath })
  }
  if (action === 'dismiss' && !isActive(job)) return dropJob($, id)
  const live = reviewRuns.get(id)
  if (action === 'stop' && live !== undefined) return stopReview($, live, 'stopped')
  if (action === 'raw' && job.streamPath !== undefined) {
    if (live !== undefined) await flushLog($, live)

    return openWithOs($, job.streamPath)
  }
  if (action === 'retry' && startingReviews.has(id)) {
    await notify($, 'info', `The review of ${number} is still starting`, undefined, `gitgud-review-${id}`)

    return
  }
  if (action === 'retry' && !isActive(job)) {
    await dropJob($, id)
    await startReview($, id)
  }
}

// --- PR description and commit summary ---

async function readTemplate($: EngineInterface, root: string, paths: readonly string[], folder: string | undefined): Promise<string | undefined> {
  for (const relative of paths) {
    const path = `${root}/${relative}`
    if (!(await $.fs.exists(path).catch(() => false))) continue
    const text = await $.fs.read(path).catch(() => '')
    if (text.trim() !== '') return text
  }
  if (folder === undefined || !(await $.fs.exists(`${root}/${folder}`).catch(() => false))) return undefined
  const entries = await $.fs.list(`${root}/${folder}`).catch(() => [])
  const [first] = entries
    .filter(entry => entry.kind === 'file' && /\.md$/i.test(entry.name))
    .map(entry => entry.name)
    .sort()
  if (first === undefined) return undefined
  const text = await $.fs.read(`${root}/${folder}/${first}`).catch(() => '')

  return text.trim() === '' ? undefined : text
}

/** What the branch did since it left its base (`origin/<base>` as last fetched): commits, files, diff, template. */
async function gatherBranchFacts($: EngineInterface, state: GitgudState, withTemplate: boolean): Promise<BranchFacts> {
  const repo = state.currentRepo
  const key = currentKeyOf(state)
  const adapter = key === undefined ? undefined : adapterOfRepo(state, key)
  if (!repo || key === undefined || adapter === undefined) throw new Error("this folder isn't a repo of a service GitGud reads")
  const ref = repoRefOf(state, key)
  const [branchRun, rootRun] = await Promise.all([runGit($, GIT_BRANCH), runGit($, GIT_TOPLEVEL)])
  const branch = branchRun.stdout.trim()
  if (branchRun.exitCode !== 0 || branch === '' || branch === 'HEAD') throw new Error('no branch is checked out')
  const prRun = ref === undefined ? undefined : await runOp($, adapter.prForBranch(ref, branch))
  const pr = prRun?.isOk ? prRun.value : undefined
  const base = pr?.baseRef ?? repo.defaultBranch ?? 'main'
  const mergeBaseRun = await runGit($, gitMergeBase(base))
  const mergeBase = mergeBaseRun.stdout.trim()
  if (mergeBaseRun.exitCode !== 0 || mergeBase === '') throw failureOf(mergeBaseRun, `couldn't compare with origin/${base}`)
  const [logRun, statRun, diffRun, namesRun] = await Promise.all([
    runGit($, gitLogSince(mergeBase)),
    runGit($, gitDiffStat(mergeBase)),
    runGit($, gitDiff(mergeBase), 30_000),
    runGit($, gitChangedSince(mergeBase))
  ])
  const nameStatus = parseNameStatusZ(namesRun.stdout)
  if (nameStatus.length === 0) throw new Error(`no changes since origin/${base}`)
  const root = rootRun.stdout.trim()
  const template = withTemplate && root !== '' ? await readTemplate($, root, adapter.caps.templatePaths, TEMPLATE_FOLDERS[adapter.id]) : undefined
  const ticket = ticketOfItem(pr?.title ?? '', branch)

  return {
    repo: repo.nameWithOwner,
    folder: repoFolderOf(key),
    branch,
    base,
    commits: logRun.stdout.split('\n').filter(line => line.trim() !== ''),
    diffStat: statRun.stdout,
    diff: diffRun.stdout,
    nameStatus,
    ...(template === undefined ? {} : { template }),
    ...(ticket === undefined ? {} : { ticket })
  }
}

/** Haiku writes it from the branch's facts; a commit summary still lists every file when Haiku gives no reasons. */
async function writeGenerated($: EngineInterface, kind: GenKind, facts: BranchFacts): Promise<string> {
  const ask = kind === 'pr-description' ? prDescriptionAsk(facts) : commitSummaryAsk(facts)
  const answer = await $.model.complete({ model: 'haiku', ...ask, timeoutMs: 90_000 })
  if (kind === 'pr-description' && (!answer.isAnswered || answer.text.trim() === '')) {
    throw new Error(answer.isAnswered ? 'Haiku wrote nothing' : `Haiku did not answer (${answer.reason})`)
  }
  const text = kind === 'pr-description' ? (answer.isAnswered ? answer.text.trim() : '') : formatCommitSummary(facts.nameStatus, answer.isAnswered ? answer.text : '')
  const at = await $.clock.now()
  const path = `${await docDirOrThrow($)}/${facts.folder ?? repoFolderOf(facts.repo)}/${docFileName(kind, facts.branch, at)}`
  await $.fs.write(path, `${text}\n`)
  await addDoc($, { kind, title: `${GEN_LABEL[kind]} · ${facts.branch}`, path, createdAt: at })

  return path
}

async function generate($: EngineInterface, kind: GenKind): Promise<void> {
  if (generating.has(kind)) return
  generating.add(kind)
  const state = await read($, gitgudAtom)
  const startedAt = await $.clock.now()
  try {
    await setGen($, kind, { phase: 'running', startedAt })
    const path = await writeGenerated($, kind, await gatherBranchFacts($, state, kind === 'pr-description'))
    await setGen($, kind, { phase: 'done', startedAt })
    await notify($, 'info', `${GEN_LABEL[kind]} ready`, path, `gitgud-gen-${kind}`)
  } catch (error) {
    await setGen($, kind, { phase: 'failed', startedAt, error: drawable(messageOf(error)) })
  } finally {
    generating.delete(kind)
  }
}

// --- files: the doc pane, the OS, the clipboard, the prompt ---

async function readDocFile($: EngineInterface, path: string): Promise<string> {
  await docDirOrThrow($)
  if (!isUnderDocDir(path, await docDirsOrNone($))) throw new Error('not a file this panel wrote')

  return $.fs.read(path)
}

/** The pane still shows this file's own load: not another file, and not the overlap inspector. */
function isStillOpen(doc: GitgudDocState, path: string): boolean {
  return doc.diff === undefined && doc.path === path && doc.isLoading === true
}

/** Shows the file in its own pane on the right, beside the docks; the docks' view stays as it was. */
async function openInPane($: EngineInterface, link: Pick<GhDocLink, 'kind' | 'title' | 'path'>): Promise<void> {
  const title = docPaneTitle(link.kind, link.title)
  await update($, docAtom, (): GitgudDocState => ({ path: link.path, title, isLoading: true }))
  const opened = await $.ui.open({ id: DOC_PANE_ID, title, columns: DOC_COLUMNS, focus: true, closeOnEscape: true }).catch(() => undefined)
  if (opened?.isPlaced === false) await notify($, 'info', 'The file opens once there is room', '↗ opens it in your editor instead.')
  try {
    const fitted = fitDocText(cleanDocText(await readDocFile($, link.path)))
    const loaded: GitgudDocState = { path: link.path, title, text: fitted.text, ...(fitted.isTruncated ? { isTruncated: true } : {}) }
    await update($, docAtom, (doc): GitgudDocState => (isStillOpen(doc, link.path) ? loaded : doc))
  } catch (error) {
    const failed: GitgudDocState = { path: link.path, title, error: messageOf(error) }
    await update($, docAtom, (doc): GitgudDocState => (isStillOpen(doc, link.path) ? failed : doc))
  }
}

/** Opens the file in the person's default app: `open` (macOS), `xdg-open` (Linux), `start` (Windows); only a file under the doc folder. */
async function openWithOs($: EngineInterface, path: string): Promise<void> {
  const docDirs = await docDirsOrNone($)
  const failures: string[] = []
  for (const argv of openCommands(path)) {
    if (!isAllowedArgv(argv, { docDirs })) {
      failures.push(refusedRun(argv).stderr)
      continue
    }
    try {
      const ran = await $.process.run(argv, { timeoutMs: 10_000 })
      if (ran.exitCode === 0) return
      failures.push(ran.stderr.trim() || `${argv[0]} exited with code ${ran.exitCode}`)
    } catch (error) {
      failures.push(messageOf(error))
    }
  }
  await notify($, 'error', "Couldn't open the file", `${path}\n${failures.join('\n')}`, 'gitgud-doc-open')
}

async function copyFile($: EngineInterface, path: string, surface: RenderSurface): Promise<void> {
  try {
    const text = await readDocFile($, path)
    if (text.length > MAX_COPY_CHARS) {
      await notify($, 'info', 'Too long for the clipboard', `Open it or add it to the prompt instead:\n${path}`, 'gitgud-copy')

      return
    }
    const copied = await $.ui.copy({ text, surface })
    if (copied.isCopied) await notify($, 'success', 'Copied', undefined, 'gitgud-copy')
    else await notify($, 'info', `Couldn't copy (${copied.reason})`, `The file is here:\n${path}`, 'gitgud-copy')
  } catch (error) {
    await notify($, 'error', "Couldn't copy the file", `${path}\n${messageOf(error)}`, 'gitgud-copy')
  }
}

/** `@<path>` in the prompt box, so the model reads the file when the person sends. */
async function addToPrompt($: EngineInterface, path: string): Promise<void> {
  const filled = await $.prompt.fill({ text: `@${path} `, mode: 'insert' })
  if (!filled.isFilled) await notify($, 'error', 'The prompt box did not take the file', path, 'gitgud-doc-prompt')
}

/** The docks take back the width the doc pane's open set; nothing to do when no right dock is open. */
async function restoreDockWidth($: EngineInterface): Promise<void> {
  const dock = lastOpenRightDock(readLayout(await read($, layoutAtom)))
  if (dock) await $.ui.open(dockOpenArgs(dock)).catch(() => undefined)
}

async function isGitgudPlaced($: EngineInterface): Promise<boolean> {
  return bandPanelIds(readLayout(await read($, layoutAtom))).includes(GH_PANEL_ID)
}

/** The files written in earlier sessions, read once the panel is in a dock: those still there, under the doc folder. */
async function loadDocs($: EngineInterface): Promise<void> {
  if (areDocsLoaded) return
  areDocsLoaded = true
  const dirs = await docDirsOrNone($)
  const stored = parseDocLinks(await $.store.get(STORE.docs).catch(() => []))
  const kept: GhDocLink[] = []
  for (const link of stored) {
    if (isUnderDocDir(link.path, dirs) && (await $.fs.exists(link.path).catch(() => false))) kept.push(link)
  }
  if (kept.length !== stored.length) await $.store.set(STORE.docs, kept).catch(() => undefined)
  if (kept.length > 0) await update($, gitgudAtom, state => ({ ...state, docs: kept }))
}

/**
 * At session start and after a reload, silent: a review or a write left running is settled (only someone who used
 * the panel has one). Only while the panel is in a dock: the files list is read.
 */
async function resumeWork($: EngineInterface): Promise<void> {
  await recoverReviews($).catch(() => undefined)
  await sweepStaleReviews($).catch(() => undefined)
  await recoverGeneration($).catch(() => undefined)
  if (await isGitgudPlaced($)) await loadDocs($)
}

export function registerGitgudWorkHooks(on: On): void {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    detach(resumeWork($))

    return started
  })

  // Ticking the panel in mid-session reads the files list then (gitgud.tsx starts its poll on the same press).
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(main|\d+)-enable-\d+-gitgud$/ }, async ($, e, next) => {
    const pressed = await next(e)
    if (await isGitgudPlaced($)) detach(loadDocs($))

    return pressed
  })

  // The list Client's posts: gitgud.tsx answers every other one and passes these on.
  on('ui.message', { element: /^gitgud-list-/ }, async ($, e, next) => {
    const message = parseListMessage(e.data)
    if (message?.type !== 'act' || !WORK_ACTIONS.includes(message.action)) return next(e)
    detach(startReview($, message.id))

    return {}
  }).catch(($, e, next) => next(e))

  // The plain list's ⋯ menu entry: the menu closes as the review starts.
  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-work-/ }, async ($, e) => {
    const act = parseActKey(e.element, KEY.work)
    if (act === undefined || act.action !== 'review-bg') return { element: e.element }
    await update($, gitgudAtom, state => ({ ...state, ui: { ...state.ui, menuId: undefined } }))
    detach(startReview($, act.id))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-gen-(pr|commits)$/ }, async ($, e) => {
    detach(generate($, e.element === 'gitgud-gen-pr' ? 'pr-description' : 'commit-summary'))

    return { element: e.element }
  })

  // A file's Buttons name it by its `createdAt`, so a list that moved under the press still opens the right one.
  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-doc-(open|os|copy|prompt)-\d+$/ }, async ($, e) => {
    const [, action = '', createdAt = ''] = /^gitgud-doc-(open|os|copy|prompt)-(\d+)$/.exec(e.element) ?? []
    const link = (await read($, gitgudAtom)).docs?.find(doc => String(doc.createdAt) === createdAt)
    if (link === undefined) return { element: e.element }
    if (action === 'open') await openInPane($, link)
    else if (action === 'os') await openWithOs($, link.path)
    else if (action === 'copy') await copyFile($, link.path, e.surface)
    else await addToPrompt($, link.path)

    return { element: e.element }
  })

  // A background review row toggles its menu; one open at a time.
  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-review-row-/ }, async ($, e) => {
    const id = decodeItemId(e.element.slice(KEY.reviewRow.length))
    if (id !== undefined) await update($, gitgudAtom, state => ({ ...state, ui: { ...state.ui, menuId: undefined, overlapMenu: undefined, reviewMenu: state.ui?.reviewMenu === id ? undefined : id } }))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-review-(act|inline)-(open|log|raw|stop|retry|dismiss)-/ }, async ($, e) => {
    const [, action = '', encoded = ''] = /^gitgud-review-(?:act|inline)-(open|log|raw|stop|retry|dismiss)-(.+)$/.exec(e.element) ?? []
    const id = decodeItemId(encoded)
    if (id !== undefined) detach(runReviewAction($, action, id))

    return { element: e.element }
  })

  // The answers under a reviewer's ask.
  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-review-ask-(once|review|deny)-/ }, async ($, e) => {
    const asked = parseAskKey(e.element)
    if (asked !== undefined) await answerAsk($, asked.itemId, asked.askId, asked.answer)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-docpane-(close|os|copy|prompt)$/ }, async ($, e) => {
    const path = (await read($, docAtom)).path
    if (e.element === 'gitgud-docpane-close') await $.ui.close({ id: DOC_PANE_ID })
    else if (path === undefined) return { element: e.element }
    else if (e.element === 'gitgud-docpane-os') await openWithOs($, path)
    else if (e.element === 'gitgud-docpane-copy') await copyFile($, path, e.surface)
    else await addToPrompt($, path)

    return { element: e.element }
  })

  on('ui.render', { component: 'Pane', requestId: 'claudedockula-doc' }, async ($, e) => {
    const ui = $.ui.resolve(e)

    return drawDocPane(ui, await read($, docAtom), Math.max(1, e.props.bodyColumns))
  })

  on('ui.close', { id: 'claudedockula-doc' }, async ($, e, next) => {
    const closed = await next(e)
    await update($, docAtom, (): GitgudDocState => ({}))
    if (e.origin.kind !== 'unload') await restoreDockWidth($)

    return closed
  }).catch(($, e, next) => next(e))
}
