import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, ProcessRunResult, RenderSurface, Timer, UiCopyResult } from 'claude-code'

import type { GhDiffInspect, GhOverlap, GhRepo, GithubDocState, GithubState } from '../../types'
import { DEFAULT_LAYOUT, bandPanelIds, messageOf } from '../dock/layout'
import { NO_NOTICES, pushNotice } from '../dock/notices'
import type { NewNotice } from '../dock/notices'
import { openCommands } from '../settings'
import {
  GH_ENV,
  GIT_BRANCH,
  GIT_STATUS_PORCELAIN,
  GIT_TOPLEVEL,
  ghOpenPrFiles,
  ghPrFilesCall,
  ghPrForBranch,
  ghPrHead,
  ghRepoView,
  gitChangedSince,
  gitDiffPath,
  gitMergeBase,
  gitMergeBaseOf,
  gitSameAt,
  gitStatusPath,
  isAllowedArgv
} from './github/argv'
import { deriveOverlapAlerts, parseLedger, pruneLedger, scopeSignature, takeNewAlerts, type AlertLedger } from './github/alerts'
import { diffSide, findPrFile, isSafeRepoPath, overlapSummary, parseBaseRef, parseHeadSha, parseHunks, parsePrFiles, sideText, untrackedHunk, type PrFileEntry } from './github/diff'
import { diffPaneTitle, inspectorCopyText } from './github/diffPane'
import { DOC_PANE_ID, KEY, STORE, LOCAL_CHECK_DEBOUNCE_MS, OVERLAP_POLL_MS, parseOverlapFileKey } from './github/model'
import { computeOverlaps, parseNameStatusZ, parsePorcelainZ } from './github/overlap'
import { classifyGhFailure, parseBranchPr, parseOpenPrFiles, parseRepoView } from './github/parse'
import type { PrFiles } from './github/parse'
import { conflictResolutionPrompt, type ConflictFile } from './github/prompts'
import { GH_TIMEOUT_MS, NOT_RUN, NOT_STARTED, enter, ghCandidates, ghGate, leave, missingGh, outcomeOf, refusedRun, rememberGh, thrownRun, type RunOutcome } from './github/run'

// The engine follows `$` only into functions declared in the same file, so every function that takes `$` lives here.
// Reads only: every command goes through `runCommand`, which refuses anything `isAllowedArgv` does not allow.

const LOCAL_TICK_MS = 60_000
const COMMAND_TIMEOUT_MS = 20_000
const FALLBACK_BASE = 'main'
/** A seen alert is written back this long after its last write, so the ledger keeps it without a write every check. */
const LEDGER_REFRESH_MS = 86_400_000

/** The PR files read can be long on a big PR. */
const FILES_TIMEOUT_MS = 60_000
/** The inspector's width beside a fullscreen transcript; the docks take theirs back when it closes. */
const DIFF_COLUMNS = 100
const COPY_MAX_CHARS = 64_000
/** PRs whose files stay cached, by head commit. */
const FILES_CACHE_SIZE = 4
const MAX_PROMPT_FILES = 5

const githubState = atom({ plugin: 'claudedockula', key: 'github' } as const, {})
const docAtom = atom({ plugin: 'claudedockula', key: 'githubDoc' } as const, {})
const layoutAtom = atom({ plugin: 'claudedockula', key: 'layout' } as const, DEFAULT_LAYOUT)
const noticesAtom = atom({ plugin: 'claudedockula', key: 'notices' } as const, NO_NOTICES)

interface BranchPr {
  branch?: string
  number?: number
  baseRef?: string
}

interface CheckOptions {
  /** Fetch the open PRs' files now, whatever their age. */
  isForced: boolean
}

let openPrs: { repo: string; prs: PrFiles[]; fetchedAt: number } | undefined
let branchPr: BranchPr | undefined
let ownRepo: GhRepo | undefined
let running: Promise<void> | undefined
let queued: CheckOptions | undefined
let ticker: Timer | undefined
let pending: Timer | undefined
/** A PR's files by `<prId>@<head sha>`, oldest first. */
const filesCache = new Map<string, PrFileEntry[]>()

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

function describeFailure(result: RunOutcome): string {
  if (result.exitCode === NOT_RUN || result.exitCode === NOT_STARTED) return 'Could not run gh.'
  const failure = classifyGhFailure(result.stderr, result.exitCode)
  if (failure === 'rate-limited') return 'GitHub rate limit reached.'
  if (failure === 'logged-out') return 'gh is not logged in.'
  if (failure === 'network') return 'Could not reach GitHub.'
  if (failure === 'not-found') return 'The repo was not found.'

  return result.stderr.trim().split('\n')[0]?.slice(0, 80) || 'gh failed.'
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
async function readBranchPr($: EngineInterface, branch: string | undefined, isStale: boolean): Promise<BranchPr> {
  if (branchPr !== undefined && branchPr.branch === branch && !isStale) return branchPr
  const result = branch === undefined ? undefined : await runGh($, ghPrForBranch)
  const found = result?.exitCode === 0 ? parseBranchPr(result.stdout) : undefined
  branchPr = { branch, ...(found ? { number: found.number, baseRef: found.baseRef } : {}) }

  return branchPr
}

/** The session's repo as the core wiring found it; until it has, asked from gh once. */
async function resolveRepo($: EngineInterface, state: GithubState): Promise<GhRepo | undefined> {
  if (state.currentRepo !== undefined) return state.currentRepo ?? undefined
  if (ownRepo !== undefined) return ownRepo
  const result = await runGh($, ghRepoView)
  const parsed = result.exitCode === 0 ? parseRepoView(result.stdout) : undefined
  if (parsed?.isOk) ownRepo = parsed.value

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

type OverlapPatch = Pick<GithubState, 'overlaps' | 'localChangeCount' | 'overlapCheckedAt' | 'overlapError' | 'overlapBase' | 'branch'>

async function storeOverlap($: EngineInterface, patch: OverlapPatch): Promise<void> {
  const previous = await read($, githubState)
  const pick = (state: OverlapPatch) =>
    JSON.stringify([state.overlaps, state.localChangeCount, state.overlapCheckedAt, state.overlapError, state.overlapBase, state.branch])
  if (pick(previous) === pick(patch)) return

  await update($, githubState, (value) => ({ ...value, ...patch }))
}

async function checkOverlap($: EngineInterface, { isForced }: CheckOptions): Promise<void> {
  const state = await read($, githubState)
  if (state.health === 'missing' || state.health === 'logged-out') return
  if (!isForced && !bandPanelIds(await read($, layoutAtom)).includes('github')) return
  const currentRepo = await resolveRepo($, state)
  if (currentRepo === undefined) return
  const repo = currentRepo.nameWithOwner

  const now = await $.clock.now()
  const isFetchDue = isForced || openPrs === undefined || openPrs.repo !== repo || now - openPrs.fetchedAt >= OVERLAP_POLL_MS
  let fetchError: string | undefined
  if (isFetchDue) {
    const result = await runGh($, (gh) => ghOpenPrFiles(gh, repo))
    const parsed = result.exitCode === 0 ? parseOpenPrFiles(result.stdout) : undefined
    if (parsed?.isOk) openPrs = { repo, prs: parsed.value, fetchedAt: now }
    else fetchError = parsed ? parsed.error : describeFailure(result)
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
  const own = await readBranchPr($, branch, isFetchDue)
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
  await update($, githubState, (value) => ({ ...value, ui: { ...value.ui, isOverlapOpen: value.ui?.isOverlapOpen !== true } }))
}

// --- the overlap row's menu and the diff inspector ---

interface PrRef {
  prId: string
  number: number
  repo: string
  url: string
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

function overlapOf(state: GithubState, number: number): GhOverlap | undefined {
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
  await notify($, { tone: 'error', title: "Couldn't open the browser", detail: failures.join('\n'), topic: 'github-open' })
}

async function copyText($: EngineInterface, text: string, what: string, surface: RenderSurface): Promise<void> {
  if (text.length > COPY_MAX_CHARS) {
    await notify($, { tone: 'info', title: `${what} is too long for the clipboard`, detail: '➕ Add to prompt takes it instead.', topic: 'github-copy' })

    return
  }
  const copied = await $.ui.copy({ text, surface }).catch((): UiCopyResult => ({ isCopied: false, reason: 'refused' }))
  if (copied.isCopied) await notify($, { tone: 'success', title: `${what} copied`, topic: 'github-copy' })
  else await notify($, { tone: 'error', title: `Couldn't copy the ${what.toLowerCase()} (${copied.reason})`, topic: 'github-copy' })
}

async function insertPrompt($: EngineInterface, text: string, success: string, topic: string): Promise<void> {
  const filled = await $.prompt.fill({ text, mode: 'insert' })
  if (filled.isFilled) await notify($, { tone: 'success', title: success, topic })
  else await notify($, { tone: 'error', title: "The prompt box didn't take it", topic })
}

/** The PR's files at its head commit: from the cache when the head has not moved, else read from GitHub (GET only). */
async function readTheirs($: EngineInterface, pr: PrRef): Promise<Theirs> {
  const head = await runGh($, (gh) => ghPrHead(gh, pr.repo, pr.number))
  const headSha = head.exitCode === 0 ? parseHeadSha(head.stdout) : undefined
  const baseRef = head.exitCode === 0 ? parseBaseRef(head.stdout) : undefined
  const known = { ...(headSha ? { headSha } : {}), ...(baseRef ? { baseRef } : {}) }
  const key = headSha === undefined ? undefined : `${pr.prId}@${headSha}`
  const cached = key === undefined ? undefined : filesCache.get(key)
  if (cached !== undefined) return { files: cached, ...known }
  const ran = await runGh($, (gh) => ghPrFilesCall(gh, pr.repo, pr.number), FILES_TIMEOUT_MS)
  if (ran.exitCode !== 0) return { error: describeFailure(ran), ...known }
  const files = parsePrFiles(ran.stdout)
  if (ran.isStdoutTruncated === true) return { files, isIncomplete: true, ...known }
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
  const state = await read($, githubState)
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
function theirsOf(theirs: Theirs, path: string, pr: Pick<PrRef, 'number' | 'url'>): FileDiff {
  if (theirs.error !== undefined) return { note: `Couldn't read #${pr.number}'s files: ${theirs.error}` }
  const entry = findPrFile(theirs.files ?? [], path)
  if (entry === undefined && theirs.isIncomplete === true) return { note: `#${pr.number}'s file list is too large to read here: ${pr.url}/files` }
  if (entry === undefined) return { note: `#${pr.number} no longer lists this file.` }
  if (entry.patch === undefined) return { note: `GitHub shows no text diff for it (binary or too large): ${pr.url}/files` }
  const renamed = entry.previousFilename === path ? `Renamed to ${entry.filename} in #${pr.number}.` : undefined

  return { text: entry.patch, ...(renamed ? { note: renamed } : {}) }
}

function prRefOf(diff: Pick<GhDiffInspect, 'number' | 'repo' | 'url'>): PrRef {
  return { prId: `${diff.repo}#${diff.number}`, number: diff.number, repo: diff.repo, url: diff.url }
}

/** Reads both diffs for the open inspector; dropped when another file opened or the pane closed meanwhile. */
async function loadInspector($: EngineInterface, openedAt: number): Promise<void> {
  const current = (await read($, docAtom)).diff
  if (current === undefined || current.openedAt !== openedAt) return
  const settle = (patch: (diff: GhDiffInspect) => GhDiffInspect) =>
    update($, docAtom, (doc): GithubDocState => (doc.diff?.openedAt === openedAt ? { diff: patch(doc.diff) } : doc))
  try {
    const pr = prRefOf(current)
    const [local, theirs] = await Promise.all([readLocalBase($), readTheirs($, pr)])
    const [mine, baseCheck] = await Promise.all([readMine($, local, current.path), checkBase($, local, theirs, current.path)])
    const theirFile = theirsOf(theirs, current.path, pr)
    const mineHunks = parseHunks(mine.text ?? '')
    const theirHunks = parseHunks(theirFile.text ?? '')
    const overlap = overlapSummary(mineHunks, theirHunks)
    await settle((diff) => ({
      openedAt: diff.openedAt,
      number: diff.number,
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
  const overlap = overlapOf(await read($, githubState), number)
  if (overlap === undefined || !overlap.files.includes(path)) {
    await notify($, { tone: 'info', title: `#${number} no longer overlaps that file`, topic: 'github-overlap-inspect' })

    return
  }
  const openedAt = await $.clock.now()
  const { repo, title, author, headRef, url } = overlap
  await update($, docAtom, (): GithubDocState => ({ diff: { openedAt, number, repo, title, author, headRef, url, path, isLoading: true } }))
  const opened = await $.ui.open({ id: DOC_PANE_ID, title: diffPaneTitle(path, number), columns: DIFF_COLUMNS, focus: true, closeOnEscape: true }).catch(() => undefined)
  if (opened?.isPlaced === false) await notify($, { tone: 'info', title: 'The diff opens once there is room', topic: 'github-overlap-inspect' })
  await loadInspector($, openedAt)
}

async function refreshInspector($: EngineInterface): Promise<void> {
  const diff = (await read($, docAtom)).diff
  if (diff === undefined) return
  await update($, docAtom, (doc): GithubDocState => (doc.diff?.openedAt === diff.openedAt ? { diff: { ...doc.diff, isLoading: true } } : doc))
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
  if (element === 'github-diffpane-refresh') return refreshInspector($)
  if (element === 'github-diffpane-open') return openUrl($, `${diff.url}/files`)
  if (diff.isLoading === true) {
    await notify($, { tone: 'info', title: 'Still reading the diffs…', detail: 'Try again in a moment.', topic: 'github-overlap-prompt' })

    return
  }
  if (element === 'github-diffpane-copy') return copyText($, inspectorCopyText(diff), 'Both diffs', surface)
  const text = conflictResolutionPrompt({
    pr: { number: diff.number, title: diff.title, author: diff.author, headRef: diff.headRef, url: diff.url },
    ...(diff.base ? { base: diff.base } : {}),
    ...(diff.mergeBase ? { mergeBase: diff.mergeBase } : {}),
    ...(diff.isApproximate ? { isApproximate: true } : {}),
    files: [conflictFileOf(diff)]
  })
  await insertPrompt($, text, `Conflict resolution for ${diff.path.split('/').pop() ?? diff.path}: added to the prompt`, 'github-overlap-prompt')
}

/** The conflict-resolution prompt for a whole overlap: both diffs of its first files, read now. */
async function addConflictPrompt($: EngineInterface, overlap: GhOverlap): Promise<void> {
  const topic = `github-overlap-${overlap.number}`
  await notify($, { tone: 'info', title: `Reading #${overlap.number}'s changes…`, topic })
  const pr: PrRef = { prId: overlap.prId, number: overlap.number, repo: overlap.repo, url: overlap.url }
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
    base: local.base,
    ...(local.mergeBase ? { mergeBase: local.mergeBase } : {}),
    ...(isApproximate ? { isApproximate: true } : {}),
    files
  })
  await insertPrompt($, text, `Conflict resolution for #${overlap.number}: added to the prompt`, topic)
}

async function runOverlapAction($: EngineInterface, action: string, number: number, surface: RenderSurface): Promise<void> {
  const overlap = overlapOf(await read($, githubState), number)
  if (overlap === undefined) {
    await notify($, { tone: 'info', title: `#${number} no longer overlaps your changes`, topic: `github-overlap-${number}` })

    return
  }
  if (action === 'open') return openUrl($, overlap.url)
  if (action === 'copy') return copyText($, overlap.url, 'Link', surface)

  return addConflictPrompt($, overlap)
}

/** The overlap check: local changes against other open PRs' files, on a timer, after writing tools and on ↻. */
export function registerGithubOverlapHooks(on: On): void {
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

  on('ui.press', { plugin: 'claudedockula', element: 'github-overlap-toggle' }, async ($, e) => {
    await toggleOverlap($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: 'github-overlap-refresh' }, async ($, e) => {
    await requestCheck($, { isForced: true })

    return { element: e.element }
  })

  // The card's own ↻ answers first, then this reloads the overlaps with it.
  on('ui.press', { plugin: 'claudedockula', element: 'github-refresh' }, async ($, e, next) => {
    const pressed = await next(e)
    void requestCheck($, { isForced: true })

    return pressed
  })

  // An overlap row's press opens its menu (one in the whole card); a second press closes it.
  on('ui.press', { plugin: 'claudedockula', element: /^github-overlap-row-\d+$/ }, async ($, e) => {
    const number = Number(e.element.slice(KEY.overlapRow.length))
    await update($, githubState, (value) => ({
      ...value,
      ui: { ...value.ui, menuId: undefined, reviewMenu: undefined, overlapMenu: value.ui?.overlapMenu === number ? undefined : number }
    }))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^github-overlap-act-(open|prompt|copy)-\d+$/ }, async ($, e) => {
    const [, action = '', number = ''] = /^github-overlap-act-(open|prompt|copy)-(\d+)$/.exec(e.element) ?? []
    await update($, githubState, (value) => ({ ...value, ui: { ...value.ui, overlapMenu: undefined } }))
    void runOverlapAction($, action, Number(number), e.surface).catch(() => undefined)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^github-overlap-file-\d+-/ }, async ($, e) => {
    const target = parseOverlapFileKey(e.element)
    if (target !== undefined) void openInspector($, target.number, target.path).catch(() => undefined)

    return { element: e.element }
  })

  // The inspector's own actions; ✕ is the doc pane's (githubWork.tsx).
  on('ui.press', { plugin: 'claudedockula', element: /^github-diffpane-(prompt|copy|open|refresh)$/ }, async ($, e) => {
    void answerInspector($, e.element, e.surface).catch(() => undefined)

    return { element: e.element }
  })
}
