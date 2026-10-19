import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, ProcessRunResult, RenderSurface, Timer, UiCopyResult } from 'claude-code'

import type { GhDiffInspect, GhItem, GhOverlap, GhRepo, GitgudDocState, GitgudState } from '../../types'
import { DEFAULT_LAYOUT, bandPanelIds, messageOf } from '../dock/layout'
import { NO_NOTICES, pushNotice } from '../dock/notices'
import type { NewNotice } from '../dock/notices'
import { openCommands } from '../settings'
import {
  GIT_BRANCH,
  GIT_STATUS_PORCELAIN,
  GIT_TOPLEVEL,
  gitChangedSince,
  gitDiffPath,
  gitMergeBase,
  gitMergeBaseOf,
  gitSameAt,
  gitStatusPath
} from './gitgud/argv'
import { deriveOverlapAlerts, parseLedger, pruneLedger, scopeSignature, takeNewAlerts, type AlertLedger } from './gitgud/alerts'
import { diffSide, findPrFile, isSafeRepoPath, overlapSummary, parseHunks, sideText, untrackedHunk, type PrFileEntry } from './gitgud/diff'
import { diffPaneTitle, inspectorCopyText } from './gitgud/diffPane'
import { DOC_PANE_ID, KEY, STORE, LOCAL_CHECK_DEBOUNCE_MS, parseOverlapFileKey } from './gitgud/model'
import { computeOverlaps, parseNameStatusZ, parsePorcelainZ } from './gitgud/overlap'
import { classifyGhFailure, parseRepoView, type Parsed } from './gitgud/parse'
import type { PrFiles } from './gitgud/parse'
import { isAllowedArgv } from './gitgud/guard'
import { GH_ENV, ghRepoView } from './gitgud/providers/github'
import type { Op, Outcome, OverlapCache, ProviderAdapter, Req } from './gitgud/providers/types'
import { conflictResolutionPrompt, type ConflictFile } from './gitgud/prompts'
import { outcomeOf, thrownRun } from './gitgud/run'
import { outcomeOfRun, runOpTracked, runOpWith, runReqWith, type RunnerIo } from './gitgud/runner'
import { adapterOfRepo, itemStubOf, overlapPollMsOf, repoRefOf } from './gitgud/hosts'
import { itemId, repoKeyOfRepo } from './gitgud/ids'
import { SERVICE_NAMES, parseHostSettings } from './gitgud/setup'

// The engine follows `$` only into functions declared in the same file, so every function that takes `$` lives here.
// Reads only: every command goes through `runCommand`, which refuses anything `isAllowedArgv` does not allow.

const LOCAL_TICK_MS = 60_000
const COMMAND_TIMEOUT_MS = 20_000
const FALLBACK_BASE = 'main'
/** A seen alert is written back this long after its last write, so the ledger keeps it without a write every check. */
const LEDGER_REFRESH_MS = 86_400_000

/** The inspector's width beside a fullscreen transcript; the docks take theirs back when it closes. */
const DIFF_COLUMNS = 100
const COPY_MAX_CHARS = 64_000
/** PRs whose files stay cached, by head commit. */
const FILES_CACHE_SIZE = 4
const MAX_PROMPT_FILES = 5

const gitgudState = atom({ plugin: 'claudedockula', key: 'gitgud' } as const, {})
const docAtom = atom({ plugin: 'claudedockula', key: 'gitgudDoc' } as const, {})
const layoutAtom = atom({ plugin: 'claudedockula', key: 'layout' } as const, DEFAULT_LAYOUT)
const noticesAtom = atom({ plugin: 'claudedockula', key: 'notices' } as const, NO_NOTICES)

interface OwnPr {
  branch?: string
  number?: number
  baseRef?: string
}

interface CheckOptions {
  /** Fetch the open PRs' files now, whatever their age. */
  isForced: boolean
}

let openPrs: { repo: string; prs: PrFiles[]; fetchedAt: number } | undefined
let branchPr: OwnPr | undefined
let ownRepo: GhRepo | undefined
let running: Promise<void> | undefined
let queued: CheckOptions | undefined
let ticker: Timer | undefined
let pending: Timer | undefined
/** What the adapters may reuse of the open PRs' files, by `<repo>#<number>`, while the head commit is the same. */
const overlapCache: OverlapCache = {}
/** A PR's files by `<prId>@<head sha>`, oldest first. */
const filesCache = new Map<string, PrFileEntry[]>()

/** Keeps each PR's files with its head commit, for the adapters that read them one PR at a time; a cut list is never kept. */
function rememberFiles(repo: string, prs: readonly PrFiles[]): void {
  for (const pr of prs) {
    if (pr.headSha !== undefined && pr.isPartial !== true) overlapCache[`${repo}#${pr.number}`] = { headSha: pr.headSha, files: pr.files }
  }
}

async function notify($: EngineInterface, notice: Omit<NewNotice, 'at'>): Promise<void> {
  const at = await $.clock.now()
  await update($, noticesAtom, (list) => pushNotice(list, { ...notice, at }))
}

/** Runs one read-only command; undefined when the guard refuses it or it could not start. */
async function runCommand($: EngineInterface, argv: readonly string[], env?: Record<string, string>): Promise<ProcessRunResult | undefined> {
  if (!isAllowedArgv(argv)) return undefined
  try {
    return await $.process.run([...argv], { timeoutMs: COMMAND_TIMEOUT_MS, ...(env ? { env } : {}) })
  } catch {
    return undefined
  }
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
    git: async argv => {
      const ran = await runCommand($, argv)

      return ran === undefined ? { exitCode: -1, stdout: '', stderr: 'refused' } : outcomeOfRun(outcomeOf(ran))
    },
    keychain: async argv => {
      try {
        return await $.process.run(argv, { timeoutMs: COMMAND_TIMEOUT_MS })
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
      const state = await read($, gitgudState)

      return state.isSettingsLoaded === true ? state.settings?.hosts : parseHostSettings(await $.store.get(STORE.settings).catch(() => undefined))
    }
  }
}

async function runReq($: EngineInterface, req: Req): Promise<Outcome> {
  return runReqWith(ioOf($), req)
}

/** Steps an adapter's operation: each request it yields runs through the guards, and its outcome goes back in. */
async function runOp<T>($: EngineInterface, op: Op<T>): Promise<Parsed<T>> {
  return runOpWith(ioOf($), op)
}

/** One line for a failed read, naming the service it was asked of. */
function describeError(error: string, service: string): string {
  const failure = classifyGhFailure(error)
  if (failure === 'rate-limited') return `${service} rate limit reached.`
  if (failure === 'logged-out') return `${service} did not accept the sign-in.`
  if (failure === 'network') return `Could not reach ${service}.`
  if (failure === 'not-found') return 'The repo was not found.'

  return error.trim().split('\n')[0]?.slice(0, 80) || `${service} failed.`
}

/** The service, adapter and number sign of a repo key's host. */
async function vocabOfRepo($: EngineInterface, repo: string): Promise<{ adapter?: ProviderAdapter; sigil: string; service: string }> {
  const adapter = adapterOfRepo(await read($, gitgudState), repo)

  return { ...(adapter ? { adapter } : {}), sigil: adapter?.caps.vocab.sigil ?? '#', service: SERVICE_NAMES[adapter?.id ?? 'github'] }
}

/** The number sign and noun a conflict prompt writes for a repo's service. */
async function sigilInput($: EngineInterface, repo: string): Promise<{ sigil?: string; noun?: string }> {
  const vocab = (await vocabOfRepo($, repo)).adapter?.caps.vocab

  return vocab === undefined ? {} : { sigil: vocab.sigil, noun: vocab.noun }
}

/** Where a service shows a PR's changed files. */
function filesUrlOf(adapter: ProviderAdapter | undefined, url: string): string {
  if (adapter?.id === 'gitlab') return `${url}/diffs`
  if (adapter?.id === 'bitbucket') return `${url}/diff`

  return `${url}/files`
}

/** The paths changed here: uncommitted and untracked, plus committed since the base branch (as last fetched). */
async function readLocalPaths($: EngineInterface, base: string): Promise<string[]> {
  const paths = new Set<string>()
  const status = await runCommand($, GIT_STATUS_PORCELAIN)
  if (status?.exitCode === 0) parsePorcelainZ(status.stdout).forEach((path) => paths.add(path))

  const mergeBase = await runCommand($, gitMergeBase(base))
  const sha = mergeBase?.exitCode === 0 ? mergeBase.stdout.trim() : ''
  if (sha) {
    const changed = await runCommand($, gitChangedSince(sha))
    if (changed?.exitCode === 0) {
      for (const { path, from } of parseNameStatusZ(changed.stdout)) {
        paths.add(path)
        if (from !== undefined) paths.add(from)
      }
    }
  }

  return [...paths]
}

/** The checked-out branch as git says now (`HEAD` when detached), read on every check: a Bash `git checkout` changes it. */
async function readHead($: EngineInterface): Promise<string | undefined> {
  const result = await runCommand($, GIT_BRANCH)
  const head = result?.exitCode === 0 ? result.stdout.trim() : ''

  return head === '' ? undefined : head
}

/** The branch's own PR and its base, re-read when the branch changed or with the open PRs. */
async function readBranchPr($: EngineInterface, state: GitgudState, repo: string, branch: string | undefined, isStale: boolean): Promise<OwnPr> {
  if (branchPr !== undefined && branchPr.branch === branch && !isStale) return branchPr
  const adapter = adapterOfRepo(state, repo)
  const ref = repoRefOf(state, repo)
  const result = branch === undefined || adapter === undefined || ref === undefined ? undefined : await runOp($, adapter.prForBranch(ref, branch))
  const found = result?.isOk ? result.value : undefined
  branchPr = { branch, ...(found ? { number: found.number, baseRef: found.baseRef } : {}) }

  return branchPr
}

/** The session's repo as the core wiring found it; until it has, asked from gh once. */
async function resolveRepo($: EngineInterface, state: GitgudState): Promise<GhRepo | undefined> {
  if (state.currentRepo !== undefined) return state.currentRepo ?? undefined
  if (ownRepo !== undefined) return ownRepo
  const result = await runReq($, { kind: 'cli', tool: 'gh', argv: ghRepoView('gh'), env: GH_ENV })
  const parsed = result.exitCode === 0 ? parseRepoView(result.stdout) : undefined
  if (parsed?.isOk) ownRepo = { ...parsed.value, provider: 'github', host: 'github.com', path: parsed.value.nameWithOwner }

  return ownRepo
}

/**
 * Whether the ledger after a check differs from the stored one by more than refreshed times: a new id, a newly
 * seeded scope, or a seen id whose time moved by a day or more.
 */
function isLedgerChanged(before: AlertLedger, after: AlertLedger): boolean {
  if (after.seeded.some((sig) => !before.seeded.includes(sig))) return true

  return Object.entries(after.ids).some(([id, at]) => {
    const was = before.ids[id]

    return was === undefined || at - was >= LEDGER_REFRESH_MS
  })
}

async function raiseOverlapAlerts($: EngineInterface, repo: string, overlaps: readonly GhOverlap[]): Promise<void> {
  const now = await $.clock.now()
  const ledger = parseLedger(await $.store.get(STORE.alertedOverlap).catch(() => undefined))
  const { ledger: next, fresh } = takeNewAlerts(ledger, deriveOverlapAlerts(overlaps), scopeSignature('repos', [repo]), now)
  if (fresh.length > 0 || isLedgerChanged(ledger, next)) await $.store.set(STORE.alertedOverlap, pruneLedger(next, now)).catch(() => undefined)
  for (const alert of fresh) {
    await notify($, { tone: alert.tone, title: alert.title, detail: alert.detail, topic: `${alert.topic}-${alert.id}` })
  }
}

type OverlapPatch = Pick<GitgudState, 'overlaps' | 'localChangeCount' | 'overlapCheckedAt' | 'overlapError' | 'overlapBase' | 'branch'>

async function storeOverlap($: EngineInterface, patch: OverlapPatch): Promise<void> {
  const previous = await read($, gitgudState)
  const pick = (state: OverlapPatch) =>
    JSON.stringify([state.overlaps, state.localChangeCount, state.overlapCheckedAt, state.overlapError, state.overlapBase, state.branch])
  if (pick(previous) === pick(patch)) return

  await update($, gitgudState, (value) => ({ ...value, ...patch }))
}

async function checkOverlap($: EngineInterface, { isForced }: CheckOptions): Promise<void> {
  const state = await read($, gitgudState)
  if (state.health === 'missing' || state.health === 'logged-out') return
  if (!isForced && !bandPanelIds(await read($, layoutAtom)).includes('gitgud')) return
  const currentRepo = await resolveRepo($, state)
  if (currentRepo === undefined) return
  const repo = repoKeyOfRepo(currentRepo)
  const adapter = adapterOfRepo(state, repo)
  const ref = repoRefOf(state, repo)
  if (adapter === undefined || ref === undefined) return
  const service = SERVICE_NAMES[adapter.id]

  const now = await $.clock.now()
  const isFetchDue = isForced || openPrs === undefined || openPrs.repo !== repo || now - openPrs.fetchedAt >= overlapPollMsOf(adapter.id)
  let fetchError: string | undefined
  if (isFetchDue) {
    const parsed = await runOp($, adapter.openPrFiles(ref, overlapCache))
    if (parsed.isOk) {
      rememberFiles(repo, parsed.value)
      openPrs = { repo, prs: parsed.value, fetchedAt: now }
    } else fetchError = describeError(parsed.error, service)
  }
  if (openPrs === undefined || openPrs.repo !== repo) {
    if (fetchError !== undefined) {
      const { overlaps, localChangeCount, overlapCheckedAt, overlapBase, branch } = state
      await storeOverlap($, { overlaps, localChangeCount, overlapCheckedAt, overlapError: fetchError, overlapBase, branch })
    }

    return
  }

  // The branch as git says now, written back so "This branch" agrees; the last known one only when git can't say.
  const head = (await readHead($)) ?? state.branch
  const branch = head === 'HEAD' ? undefined : head
  const own = await readBranchPr($, state, repo, branch, isFetchDue)
  const base = own.baseRef ?? currentRepo.defaultBranch ?? FALLBACK_BASE
  const local = await readLocalPaths($, base)
  const overlaps = computeOverlaps({ local, prs: openPrs.prs, repo, branch, branchPr: own.number })

  await storeOverlap($, { overlaps, localChangeCount: local.length, overlapCheckedAt: openPrs.fetchedAt, overlapError: fetchError, overlapBase: base, branch: head })
  await raiseOverlapAlerts($, repo, overlaps)
}

/** Runs one check at a time; a request made meanwhile runs once more after, forced if any asked for it. */
function requestCheck($: EngineInterface, options: CheckOptions): Promise<void> {
  if (running !== undefined) {
    queued = { isForced: options.isForced || queued?.isForced === true }

    return running
  }

  running = (async () => {
    try {
      let next: CheckOptions | undefined = options
      while (next !== undefined) {
        queued = undefined
        await checkOverlap($, next).catch(() => undefined)
        next = queued
      }
    } finally {
      running = undefined
    }
  })()

  return running
}

function checkSoon($: EngineInterface): void {
  pending?.cancel()
  pending = $.clock.after(LOCAL_CHECK_DEBOUNCE_MS, () => void requestCheck($, { isForced: false }))
}

function startTicker($: EngineInterface): void {
  ticker?.cancel()
  ticker = $.clock.every(LOCAL_TICK_MS, () => void requestCheck($, { isForced: false }))
}

async function toggleOverlap($: EngineInterface): Promise<void> {
  await update($, gitgudState, (value) => ({ ...value, ui: { ...value.ui, isOverlapOpen: value.ui?.isOverlapOpen !== true } }))
}

// --- the overlap row's menu and the diff inspector ---

interface PrRef {
  prId: string
  number: number
  repo: string
  url: string
  /** `#` or `!`, the service's name for sentences, and where it lists a PR's files. */
  sigil: string
  service: string
  filesUrl: string
}

/** What the PR changed: its files with their patches, as of its head commit. */
interface Theirs {
  files?: PrFileEntry[]
  headSha?: string
  /** The PR's own base branch. */
  baseRef?: string
  error?: string
  /** The files list was too large to read whole, so a missing file proves nothing. */
  isIncomplete?: boolean
}

/** The base the overlap check compares with, the merge-base it lands on and the repo root. */
interface LocalBase {
  base: string
  mergeBase?: string
  root?: string
}

/** One side's diff text for a file, or why there is none. */
interface FileDiff {
  text?: string
  note?: string
}

function overlapOf(state: GitgudState, number: number): GhOverlap | undefined {
  return state.overlaps?.find(overlap => overlap.number === number)
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
      const { exitCode, stderr } = await $.process.run(argv, { timeoutMs: COMMAND_TIMEOUT_MS })
      if (exitCode === 0) return
      failures.push(stderr.trim().split('\n')[0] || `${argv[0]} exited with code ${exitCode}`)
    } catch (error) {
      failures.push(messageOf(error))
    }
  }
  await notify($, { tone: 'error', title: "Couldn't open the browser", detail: failures.join('\n'), topic: 'gitgud-open' })
}

async function copyText($: EngineInterface, text: string, what: string, surface: RenderSurface): Promise<void> {
  if (text.length > COPY_MAX_CHARS) {
    await notify($, { tone: 'info', title: `${what} is too long for the clipboard`, detail: '➕ Add to prompt takes it instead.', topic: 'gitgud-copy' })

    return
  }
  const copied = await $.ui.copy({ text, surface }).catch((): UiCopyResult => ({ isCopied: false, reason: 'refused' }))
  if (copied.isCopied) await notify($, { tone: 'success', title: `${what} copied`, topic: 'gitgud-copy' })
  else await notify($, { tone: 'error', title: `Couldn't copy the ${what.toLowerCase()} (${copied.reason})`, topic: 'gitgud-copy' })
}

async function insertPrompt($: EngineInterface, text: string, success: string, topic: string): Promise<void> {
  const filled = await $.prompt.fill({ text, mode: 'insert' })
  if (filled.isFilled) await notify($, { tone: 'success', title: success, topic })
  else await notify($, { tone: 'error', title: "The prompt box didn't take it", topic })
}

/** The PR's files at its head commit: from the cache when the head has not moved, else read from its service (GET only). */
async function readTheirs($: EngineInterface, pr: PrRef): Promise<Theirs> {
  const state = await read($, gitgudState)
  const adapter = adapterOfRepo(state, pr.repo)
  if (adapter === undefined) return { error: 'This PR is on a service GitGud cannot read.' }
  const service = SERVICE_NAMES[adapter.id]
  const item: GhItem = itemStubOf(pr.prId, pr.repo, pr.number, adapter.id)
  const head = await runOp($, adapter.head(item))
  const headSha = head.isOk ? head.value.headSha : undefined
  const baseRef = head.isOk ? head.value.baseRef : undefined
  const known = { ...(headSha ? { headSha } : {}), ...(baseRef ? { baseRef } : {}) }
  const key = headSha === undefined ? undefined : `${pr.prId}@${headSha}`
  const cached = key === undefined ? undefined : filesCache.get(key)
  if (cached !== undefined) return { files: cached, ...known }
  const { parsed: ran, isTruncated } = await runOpTracked(ioOf($), adapter.prFiles(item))
  if (isTruncated || (ran.isOk && ran.value.isPartial === true)) return { ...(ran.isOk ? { files: ran.value } : {}), isIncomplete: true, ...known }
  if (!ran.isOk) return { error: describeError(ran.error, service), ...known }
  const files = ran.value
  if (key !== undefined) {
    filesCache.delete(key)
    filesCache.set(key, files)
    for (const old of filesCache.keys()) {
      if (filesCache.size <= FILES_CACHE_SIZE) break
      filesCache.delete(old)
    }
  }

  return { files, ...known }
}

async function readLocalBase($: EngineInterface): Promise<LocalBase> {
  const state = await read($, gitgudState)
  const base = state.overlapBase ?? state.currentRepo?.defaultBranch ?? FALLBACK_BASE
  const [mergeBase, top] = await Promise.all([runCommand($, gitMergeBase(base)), runCommand($, GIT_TOPLEVEL)])
  const sha = mergeBase?.exitCode === 0 ? mergeBase.stdout.trim() : ''
  const root = top?.exitCode === 0 ? top.stdout.trim() : ''

  return { base, ...(sha ? { mergeBase: sha } : {}), ...(root ? { root } : {}) }
}

type BaseCheck = 'exact' | 'differs' | 'unknown'

/**
 * Whether one file is the same at the PR's own merge-base (with its base branch) and the local one, so the two diffs'
 * line numbers line up; 'unknown' when a commit is missing here (a PR head that is not fetched).
 */
async function checkBase($: EngineInterface, local: LocalBase, theirs: Theirs, path: string): Promise<BaseCheck> {
  if (local.mergeBase === undefined || theirs.headSha === undefined || theirs.baseRef === undefined) return 'unknown'
  const prBase = await runCommand($, gitMergeBaseOf(`origin/${theirs.baseRef}`, theirs.headSha))
  const prMergeBase = prBase?.exitCode === 0 ? prBase.stdout.trim() : ''
  if (prMergeBase === '') return 'unknown'
  if (prMergeBase === local.mergeBase) return 'exact'
  const same = await runCommand($, gitSameAt(local.mergeBase, prMergeBase, path))
  if (same?.exitCode === 0) return 'exact'

  return same?.exitCode === 1 ? 'differs' : 'unknown'
}

/** A diff with hunks as text; with none, binary when git says so, else a change with no lines (mode or rename). */
function diffOrNote(stdout: string): FileDiff {
  if (parseHunks(stdout).length > 0) return { text: stdout }

  return { note: /^Binary files .* differ$/m.test(stdout) ? 'Binary file: no text diff.' : 'No text changes (mode or rename only).' }
}

/** The working tree against the merge-base for one file, read fresh; an untracked file as all added. */
async function readMine($: EngineInterface, local: LocalBase, path: string): Promise<FileDiff> {
  if (local.mergeBase === undefined) return { note: `Couldn't find where this branch left origin/${local.base}.` }
  const ran = await runCommand($, gitDiffPath(local.mergeBase, path))
  if (ran?.exitCode !== 0) return { note: "Couldn't read your diff of this file." }
  if (ran.stdout.trim() !== '') return diffOrNote(ran.stdout)
  const status = await runCommand($, gitStatusPath(path))
  if (status?.exitCode !== 0 || !status.stdout.startsWith('??')) return { note: 'You have no changes to this file now.' }
  if (local.root === undefined || !isSafeRepoPath(path)) return { note: "Untracked file: couldn't read it." }
  try {
    const full = `${local.root}/${path}`
    if ((await $.fs.stat(full)).isLink) return { note: 'Untracked symlink: not read through to its target.' }
    const hunk = untrackedHunk(await $.fs.read(full))
    if (hunk === undefined) return { note: 'Untracked binary file.' }

    return { text: hunk.text, note: hunk.isCut ? 'Untracked file, shown as all added (cut to fit).' : 'Untracked file, shown as all added.' }
  } catch {
    return { note: "Untracked file: couldn't read it." }
  }
}

/** The PR's patch for one file, or why there is none (binary, too large for GitHub, no longer in the PR). */
function theirsOf(theirs: Theirs, path: string, pr: Pick<PrRef, 'number' | 'sigil' | 'service' | 'filesUrl'>): FileDiff {
  const name = `${pr.sigil}${pr.number}`
  if (theirs.error !== undefined) return { note: `Couldn't read ${name}'s files: ${theirs.error}` }
  const entry = findPrFile(theirs.files ?? [], path)
  if (entry === undefined && theirs.isIncomplete === true) return { note: `${name}'s file list is too large to read here: ${pr.filesUrl}` }
  if (entry === undefined) return { note: `${name} no longer lists this file.` }
  if (entry.patch === undefined) return { note: `${pr.service} shows no text diff for it (binary or too large): ${pr.filesUrl}` }
  const renamed = entry.previousFilename === path ? `Renamed to ${entry.filename} in ${name}.` : undefined

  return { text: entry.patch, ...(renamed ? { note: renamed } : {}) }
}

async function prRefOf($: EngineInterface, diff: Pick<GhDiffInspect, 'number' | 'repo' | 'url'>, prId?: string): Promise<PrRef> {
  const { adapter, sigil, service } = await vocabOfRepo($, diff.repo)

  return { prId: prId ?? itemId(diff.repo, diff.number), number: diff.number, repo: diff.repo, url: diff.url, sigil, service, filesUrl: filesUrlOf(adapter, diff.url) }
}

/** Reads both diffs for the open inspector; dropped when another file opened or the pane closed meanwhile. */
async function loadInspector($: EngineInterface, openedAt: number): Promise<void> {
  const current = (await read($, docAtom)).diff
  if (current === undefined || current.openedAt !== openedAt) return
  const settle = (patch: (diff: GhDiffInspect) => GhDiffInspect) =>
    update($, docAtom, (doc): GitgudDocState => (doc.diff?.openedAt === openedAt ? { diff: patch(doc.diff) } : doc))
  try {
    const pr = await prRefOf($, current)
    const [local, theirs] = await Promise.all([readLocalBase($), readTheirs($, pr)])
    const [mine, baseCheck] = await Promise.all([readMine($, local, current.path), checkBase($, local, theirs, current.path)])
    const theirFile = theirsOf(theirs, current.path, pr)
    const mineHunks = parseHunks(mine.text ?? '')
    const theirHunks = parseHunks(theirFile.text ?? '')
    const overlap = overlapSummary(mineHunks, theirHunks)
    await settle((diff) => ({
      openedAt: diff.openedAt,
      number: diff.number,
      ...(diff.provider === undefined ? {} : { provider: diff.provider }),
      repo: diff.repo,
      title: diff.title,
      author: diff.author,
      headRef: diff.headRef,
      url: diff.url,
      path: diff.path,
      base: local.base,
      ...(local.mergeBase ? { mergeBase: local.mergeBase } : {}),
      mine: diffSide(mineHunks, theirHunks, mine.note),
      theirs: diffSide(theirHunks, mineHunks, theirFile.note),
      ...(overlap ? { overlap } : {}),
      ...(baseCheck === 'differs' ? { isApproximate: true } : {}),
      ...(baseCheck === 'unknown' ? { isBaseUnknown: true } : {})
    }))
  } catch (error) {
    await settle((diff) => ({ ...diff, isLoading: false, error: messageOf(error) }))
  }
}

/** Opens the inspector on one shared file, in the doc pane on the right. */
async function openInspector($: EngineInterface, number: number, path: string): Promise<void> {
  const state = await read($, gitgudState)
  const overlap = overlapOf(state, number)
  if (overlap === undefined || !overlap.files.includes(path)) {
    const { sigil } = await vocabOfRepo($, state.currentRepo ? repoKeyOfRepo(state.currentRepo) : '')
    await notify($, { tone: 'info', title: `${sigil}${number} no longer overlaps that file`, topic: 'gitgud-overlap-inspect' })

    return
  }
  const openedAt = await $.clock.now()
  const { repo, title, author, headRef, url } = overlap
  const { adapter } = await vocabOfRepo($, repo)
  const provider = adapter?.id
  await update($, docAtom, (): GitgudDocState => ({ diff: { openedAt, number, ...(provider === undefined ? {} : { provider }), repo, title, author, headRef, url, path, isLoading: true } }))
  const opened = await $.ui.open({ id: DOC_PANE_ID, title: diffPaneTitle(path, number, adapter?.caps.vocab.sigil), columns: DIFF_COLUMNS, focus: true, closeOnEscape: true }).catch(() => undefined)
  if (opened?.isPlaced === false) await notify($, { tone: 'info', title: 'The diff opens once there is room', topic: 'gitgud-overlap-inspect' })
  await loadInspector($, openedAt)
}

async function refreshInspector($: EngineInterface): Promise<void> {
  const diff = (await read($, docAtom)).diff
  if (diff === undefined) return
  await update($, docAtom, (doc): GitgudDocState => (doc.diff?.openedAt === diff.openedAt ? { diff: { ...doc.diff, isLoading: true } } : doc))
  await loadInspector($, diff.openedAt)
}

/** One file of the inspector as the prompt takes it: what is shown, plus what was cut. */
function conflictFileOf(diff: Pick<GhDiffInspect, 'path' | 'mine' | 'theirs'>): ConflictFile {
  const noteOf = (note: string | undefined, cut: number | undefined) =>
    [note, cut ? `${cut} more hunks left out` : undefined].filter((part) => part !== undefined).join('; ') || undefined
  const mine = sideText(diff.mine)
  const theirs = sideText(diff.theirs)
  const mineNote = noteOf(diff.mine?.note, diff.mine?.cut)
  const theirsNote = noteOf(diff.theirs?.note, diff.theirs?.cut)

  return { path: diff.path, ...(mine ? { mine } : {}), ...(mineNote ? { mineNote } : {}), ...(theirs ? { theirs } : {}), ...(theirsNote ? { theirsNote } : {}) }
}

async function answerInspector($: EngineInterface, element: string, surface: RenderSurface): Promise<void> {
  const diff = (await read($, docAtom)).diff
  if (diff === undefined) return
  if (element === 'gitgud-diffpane-refresh') return refreshInspector($)
  if (element === 'gitgud-diffpane-open') return openUrl($, filesUrlOf((await vocabOfRepo($, diff.repo)).adapter, diff.url))
  if (diff.isLoading === true) {
    await notify($, { tone: 'info', title: 'Still reading the diffs…', detail: 'Try again in a moment.', topic: 'gitgud-overlap-prompt' })

    return
  }
  if (element === 'gitgud-diffpane-copy') return copyText($, inspectorCopyText(diff), 'Both diffs', surface)
  const text = conflictResolutionPrompt({
    pr: { number: diff.number, title: diff.title, author: diff.author, headRef: diff.headRef, url: diff.url },
    service: (await vocabOfRepo($, diff.repo)).service,
    ...(await sigilInput($, diff.repo)),
    ...(diff.base ? { base: diff.base } : {}),
    ...(diff.mergeBase ? { mergeBase: diff.mergeBase } : {}),
    ...(diff.isApproximate ? { isApproximate: true } : {}),
    files: [conflictFileOf(diff)]
  })
  await insertPrompt($, text, `Conflict resolution for ${diff.path.split('/').pop() ?? diff.path}: added to the prompt`, 'gitgud-overlap-prompt')
}

/** The conflict-resolution prompt for a whole overlap: both diffs of its first files, read now. */
async function addConflictPrompt($: EngineInterface, overlap: GhOverlap): Promise<void> {
  const topic = `gitgud-overlap-${overlap.number}`
  await notify($, { tone: 'info', title: `Reading ${(await vocabOfRepo($, overlap.repo)).sigil}${overlap.number}'s changes…`, topic })
  const pr = await prRefOf($, overlap, overlap.prId)
  const [local, theirs] = await Promise.all([readLocalBase($), readTheirs($, pr)])
  const files: ConflictFile[] = []
  const checks: BaseCheck[] = []
  for (const [index, path] of overlap.files.entries()) {
    if (index >= MAX_PROMPT_FILES) {
      files.push({ path })
      continue
    }
    const mine = await readMine($, local, path)
    const theirFile = theirsOf(theirs, path, pr)
    const mineHunks = parseHunks(mine.text ?? '')
    const theirHunks = parseHunks(theirFile.text ?? '')
    checks.push(await checkBase($, local, theirs, path))
    files.push(conflictFileOf({ path, mine: diffSide(mineHunks, theirHunks, mine.note), theirs: diffSide(theirHunks, mineHunks, theirFile.note) }))
  }
  const isApproximate = checks.includes('differs')
  const text = conflictResolutionPrompt({
    pr: { number: overlap.number, title: overlap.title, author: overlap.author, headRef: overlap.headRef, url: overlap.url },
    service: pr.service,
    ...(await sigilInput($, overlap.repo)),
    base: local.base,
    ...(local.mergeBase ? { mergeBase: local.mergeBase } : {}),
    ...(isApproximate ? { isApproximate: true } : {}),
    files
  })
  await insertPrompt($, text, `Conflict resolution for ${(await vocabOfRepo($, overlap.repo)).sigil}${overlap.number}: added to the prompt`, topic)
}

async function runOverlapAction($: EngineInterface, action: string, number: number, surface: RenderSurface): Promise<void> {
  const state = await read($, gitgudState)
  const overlap = overlapOf(state, number)
  if (overlap === undefined) {
    const { sigil } = await vocabOfRepo($, state.currentRepo ? repoKeyOfRepo(state.currentRepo) : '')
    await notify($, { tone: 'info', title: `${sigil}${number} no longer overlaps your changes`, topic: `gitgud-overlap-${number}` })

    return
  }
  if (action === 'open') return openUrl($, overlap.url)
  if (action === 'copy') return copyText($, overlap.url, 'Link', surface)

  return addConflictPrompt($, overlap)
}

/** The overlap check: local changes against other open PRs' files, on a timer, after writing tools and on ↻. */
export function registerGitgudOverlapHooks(on: On): void {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    startTicker($)

    return started
  })

  // Tools whose calls may change the files changed here.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Bash'] }, async ($, e, next) => {
    const ran = await next(e)
    checkSoon($)

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.press', { plugin: 'claudedockula', element: 'gitgud-overlap-toggle' }, async ($, e) => {
    await toggleOverlap($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'gitgud-overlap-refresh' }, async ($, e) => {
    await requestCheck($, { isForced: true })

    return { element: e.element }
  })

  // The card's own ↻ answers first, then this reloads the overlaps with it.
  on('ui.press', { plugin: 'claudedockula', element: 'gitgud-refresh' }, async ($, e, next) => {
    const pressed = await next(e)
    void requestCheck($, { isForced: true })

    return pressed
  })

  // An overlap row's press opens its menu (one in the whole card); a second press closes it.
  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-overlap-row-\d+$/ }, async ($, e) => {
    const number = Number(e.element.slice(KEY.overlapRow.length))
    await update($, gitgudState, (value) => ({
      ...value,
      ui: { ...value.ui, menuId: undefined, reviewMenu: undefined, overlapMenu: value.ui?.overlapMenu === number ? undefined : number }
    }))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-overlap-act-(open|prompt|copy)-\d+$/ }, async ($, e) => {
    const [, action = '', number = ''] = /^gitgud-overlap-act-(open|prompt|copy)-(\d+)$/.exec(e.element) ?? []
    await update($, gitgudState, (value) => ({ ...value, ui: { ...value.ui, overlapMenu: undefined } }))
    void runOverlapAction($, action, Number(number), e.surface).catch(() => undefined)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-overlap-file-\d+-/ }, async ($, e) => {
    const target = parseOverlapFileKey(e.element)
    if (target !== undefined) void openInspector($, target.number, target.path).catch(() => undefined)

    return { element: e.element }
  })

  // The inspector's own actions; ✕ is the doc pane's (gitgudWork.tsx).
  on('ui.press', { plugin: 'claudedockula', element: /^gitgud-diffpane-(prompt|copy|open|refresh)$/ }, async ($, e) => {
    void answerInspector($, e.element, e.surface).catch(() => undefined)

    return { element: e.element }
  })
}
