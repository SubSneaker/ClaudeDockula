import type { GhCheck, GhCheckState, GhCiState, GhItem, GhRepo, GhReviewState } from '../../../types'
import { findTicketKey } from '../../settings'
import { isRecord, textAt, valueAt } from '../jira/parse'

export type Parsed<T> = { isOk: true; value: T } | { isOk: false; error: string }
export type GhFailure = 'missing' | 'logged-out' | 'rate-limited' | 'not-found' | 'network' | 'other'

const EXCERPT_CHARS = 600
const FAILURE_PATTERNS: readonly [GhFailure, RegExp][] = [
  ['missing', /enoent|executable file not found|command not found|gh: not found/i],
  ['logged-out', /gh auth login|not logged in|bad credentials|http 401|authentication required|requires authentication/i],
  ['rate-limited', /rate limit|http 429|abuse detection|secondary rate/i],
  ['network', /could not resolve host|dial tcp|no such host|timed? ?out|connection (refused|reset)|network is unreachable|tls|error connecting to|check your internet connection/i],
  ['not-found', /could not resolve to a|http 404|not found|not a git repository|no git remotes|no pull requests? found/i]
]

/** CSI, OSC, character-set picks such as tput's `ESC ( B`, and the two-byte escapes (`ESC =`, `ESC 7`…). */
const ESCAPE_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[ -/]+[0-~]?|\u001b[0-~]?|\u009b[0-9;?]*[ -/]*[@-~]/g
const SPACE_CONTROL_RE = /[\t\n\v\f\r]/g
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g

/**
 * GitHub text as one drawn row: a drawn row may not hold a control character, so escape sequences go,
 * tabs and line breaks become spaces, and any other control character is dropped.
 * Split text into lines first when its line breaks matter.
 */
export function drawable(text: string): string {
  return text.replace(ESCAPE_RE, '').replace(SPACE_CONTROL_RE, ' ').replace(CONTROL_RE, '')
}

/** From a failed run's stderr / exit code (ENOENT reject → 'missing'). */
export function classifyGhFailure(stderr: string, exitCode?: number): GhFailure {
  const found = FAILURE_PATTERNS.find(([, pattern]) => pattern.test(stderr))

  if (found !== undefined) return found[0]

  return exitCode === 127 ? 'missing' : 'other'
}

/** Text at `path`, made drawable: what GitHub hands back reaches the card as typed by anyone. */
function drawableAt(value: unknown, ...path: string[]): string | undefined {
  const text = textAt(value, ...path)

  return text === undefined ? undefined : drawable(text)
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return undefined
  }
}

function failed<T>(error: string): Parsed<T> {
  return { isOk: false, error }
}

function listAt(value: unknown, ...path: string[]): unknown[] {
  const found = valueAt(value, path)

  return Array.isArray(found) ? found : []
}

function firstError(root: unknown): string | undefined {
  const [first] = listAt(root, 'errors')

  return textAt(first, 'message')
}

function numberAt(value: unknown, ...path: string[]): number | undefined {
  const found = valueAt(value, path)

  return typeof found === 'number' ? found : undefined
}

export interface ListsResult {
  login: string
  review: GhItem[]
  mine: GhItem[]
  issues: GhItem[]
  rateRemaining?: number
  rateResetAt?: string
}

/** statusCheckRollup.state SUCCESS→pass, FAILURE|ERROR→fail, PENDING|EXPECTED→pending, null→none. */
export function foldCi(state: string | null | undefined): GhCiState {
  if (state === 'SUCCESS') return 'pass'
  if (state === 'FAILURE' || state === 'ERROR') return 'fail'
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending'

  return 'none'
}

/** reviewDecision APPROVED→approved, CHANGES_REQUESTED→changes, REVIEW_REQUIRED→required, null→none. */
export function foldReview(decision: string | null | undefined): GhReviewState {
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes'
  if (decision === 'REVIEW_REQUIRED') return 'required'

  return 'none'
}

function excerptOf(body: string | undefined): string | undefined {
  const text = body === undefined ? undefined : drawable(body).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS)

  return text === undefined || text === '' ? undefined : text
}

/** True when the request reached the viewer only through a team. */
function isTeamOnlyRequest(node: unknown, login: string): boolean {
  const reviewers = listAt(node, 'reviewRequests', 'nodes').map(request => valueAt(request, ['requestedReviewer']))
  const isUserRequest = reviewers.some(reviewer => textAt(reviewer, '__typename') === 'User' && textAt(reviewer, 'login') === login)
  const isTeamRequest = reviewers.some(reviewer => textAt(reviewer, '__typename') === 'Team')

  return !isUserRequest && isTeamRequest
}

function parseItem(node: unknown, login: string, ticketPattern: string | undefined, isReviewList: boolean): GhItem | undefined {
  const number = numberAt(node, 'number')
  const repo = textAt(node, 'repository', 'nameWithOwner')
  const rawTitle = textAt(node, 'title')
  const url = textAt(node, 'url')

  if (number === undefined || repo === undefined || rawTitle === undefined || url === undefined) return undefined

  const title = drawable(rawTitle)
  const headRef = drawableAt(node, 'headRefName')
  const isPr = headRef !== undefined || url.includes('/pull/')
  const labels = listAt(node, 'labels', 'nodes').flatMap(label => drawableAt(label, 'name') ?? [])
  const item: GhItem = {
    id: `${repo}#${number}`,
    kind: isPr ? 'pr' : 'issue',
    repo,
    number,
    title,
    url,
    author: drawableAt(node, 'author', 'login') ?? 'ghost',
    updatedAt: textAt(node, 'updatedAt') ?? '',
    comments: numberAt(node, 'comments', 'totalCount') ?? 0
  }
  const excerpt = excerptOf(textAt(node, 'bodyText'))
  const ticket = findTicketKey(title, ticketPattern) ?? (headRef === undefined ? undefined : findTicketKey(headRef, ticketPattern))

  if (excerpt !== undefined) item.excerpt = excerpt
  if (labels.length > 0) item.labels = labels
  if (ticket !== undefined) item.ticket = ticket
  if (!isPr) return item

  const [commit] = listAt(node, 'commits', 'nodes')
  const [approval] = listAt(node, 'lastApproval', 'nodes')
  const [changeRequest] = listAt(node, 'lastChangeRequest', 'nodes')
  const baseRef = drawableAt(node, 'baseRefName')
  const headSha = textAt(node, 'headRefOid')
  const approvalId = textAt(approval, 'id')
  const changeRequestId = textAt(changeRequest, 'id')

  item.isDraft = valueAt(node, ['isDraft']) === true
  if (headRef !== undefined) item.headRef = headRef
  if (baseRef !== undefined) item.baseRef = baseRef
  if (headSha !== undefined) item.headSha = headSha
  item.ci = foldCi(textAt(commit, 'commit', 'statusCheckRollup', 'state'))
  item.review = foldReview(textAt(node, 'reviewDecision'))
  if (approvalId !== undefined) item.approvalId = approvalId
  if (changeRequestId !== undefined) item.changeRequestId = changeRequestId
  if (isReviewList && isTeamOnlyRequest(node, login)) item.isTeamRequest = true

  return item
}

function parseItems(nodes: unknown[], login: string, ticketPattern: string | undefined, isReviewList: boolean): GhItem[] {
  return nodes.flatMap(node => parseItem(node, login, ticketPattern, isReviewList) ?? [])
}

export function parseListsResponse(stdout: string, ticketPattern?: string): Parsed<ListsResult> {
  const root = parseJson(stdout)
  const login = textAt(root, 'data', 'viewer', 'login')

  if (!isRecord(valueAt(root, ['data'])) || login === undefined) return failed(firstError(root) ?? 'unexpected GitHub response')

  const result: ListsResult = {
    login,
    review: parseItems(listAt(root, 'data', 'review', 'nodes'), login, ticketPattern, true),
    mine: parseItems(listAt(root, 'data', 'mine', 'nodes'), login, ticketPattern, false),
    issues: parseItems(listAt(root, 'data', 'issues', 'nodes'), login, ticketPattern, false)
  }
  const rateRemaining = numberAt(root, 'data', 'rateLimit', 'remaining')
  const rateResetAt = textAt(root, 'data', 'rateLimit', 'resetAt')

  if (rateRemaining !== undefined) result.rateRemaining = rateRemaining
  if (rateResetAt !== undefined) result.rateResetAt = rateResetAt

  return { isOk: true, value: result }
}

export function parseSearchResponse(stdout: string, ticketPattern?: string): Parsed<GhItem[]> {
  const root = parseJson(stdout)

  if (!isRecord(valueAt(root, ['data', 'search']))) return failed(firstError(root) ?? 'unexpected GitHub response')

  return { isOk: true, value: parseItems(listAt(root, 'data', 'search', 'nodes'), '', ticketPattern, false) }
}

export function parseRepoView(stdout: string): Parsed<GhRepo> {
  const root = parseJson(stdout)
  const nameWithOwner = textAt(root, 'nameWithOwner')
  const url = textAt(root, 'url')

  if (nameWithOwner === undefined || url === undefined) return failed('unexpected repo response')

  const defaultBranch = textAt(root, 'defaultBranchRef', 'name')

  return { isOk: true, value: defaultBranch === undefined ? { nameWithOwner, url } : { nameWithOwner, url, defaultBranch } }
}

export function parseRecentRepos(stdout: string): string[] {
  return listAt(parseJson(stdout), 'data', 'viewer', 'repositories', 'nodes').flatMap(node => textAt(node, 'nameWithOwner') ?? [])
}

export function parseSearchRepos(stdout: string): string[] {
  const root = parseJson(stdout)

  return (Array.isArray(root) ? root : []).flatMap(node => textAt(node, 'fullName') ?? [])
}

const CHECK_STATES: Record<string, GhCheckState> = { pass: 'pass', fail: 'fail', pending: 'pending', skipping: 'skipped', cancel: 'cancelled' }
const CHECK_ORDER: Record<GhCheckState, number> = { fail: 0, pending: 1, pass: 2, skipped: 2, cancelled: 2 }
const JOB_LINK = /\/actions\/runs\/(\d+)\/job\/(\d+)/

function parseCheck(node: unknown): GhCheck | undefined {
  const name = drawableAt(node, 'name')

  if (name === undefined) return undefined

  const check: GhCheck = { name, state: CHECK_STATES[textAt(node, 'bucket') ?? ''] ?? 'pending' }
  const workflow = drawableAt(node, 'workflow')
  const link = textAt(node, 'link')
  const description = drawableAt(node, 'description')
  const ids = link === undefined ? null : JOB_LINK.exec(link)

  if (workflow !== undefined) check.workflow = workflow
  if (link !== undefined) check.link = link
  if (description !== undefined) check.description = description
  if (ids !== null) {
    check.runId = Number(ids[1])
    check.jobId = Number(ids[2])
  }

  return check
}

/** Accepts non-zero exit with JSON (exit 8 = pending, 1 = failed). Failed first, then pending, then the rest. */
export function parseChecks(stdout: string): Parsed<GhCheck[]> {
  const root = parseJson(stdout)

  if (!Array.isArray(root)) return failed('unexpected checks response')

  const checks = root.flatMap(node => parseCheck(node) ?? [])

  return { isOk: true, value: checks.sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]) }
}

export interface ThreadComment {
  author: string
  body: string
  createdAt?: string
  url?: string
  diffHunk?: string
}

export interface ReviewThread {
  path: string
  line?: number
  isResolved: boolean
  isOutdated: boolean
  comments: ThreadComment[]
}

export interface FullThread {
  kind: 'pr' | 'issue'
  repo: string
  number: number
  title: string
  url: string
  author: string
  state?: string
  body: string
  headRef?: string
  baseRef?: string
  /** A pull request's head commit. */
  headSha?: string
  comments: ThreadComment[]
  reviews: { author: string; state: string; body: string }[]
  threads: ReviewThread[]
}

function parseComment(node: unknown): ThreadComment {
  const comment: ThreadComment = { author: textAt(node, 'author', 'login') ?? 'ghost', body: valueAt(node, ['body']) === undefined ? '' : String(valueAt(node, ['body'])) }
  const createdAt = textAt(node, 'createdAt')
  const url = textAt(node, 'url')
  const diffHunk = textAt(node, 'diffHunk')

  if (createdAt !== undefined) comment.createdAt = createdAt
  if (url !== undefined) comment.url = url
  if (diffHunk !== undefined) comment.diffHunk = diffHunk

  return comment
}

function parseReviewThread(node: unknown): ReviewThread {
  const line = numberAt(node, 'line') ?? numberAt(node, 'originalLine')
  const thread: ReviewThread = {
    path: textAt(node, 'path') ?? '',
    isResolved: valueAt(node, ['isResolved']) === true,
    isOutdated: valueAt(node, ['isOutdated']) === true,
    comments: listAt(node, 'comments', 'nodes').map(parseComment)
  }

  if (line !== undefined) thread.line = line

  return thread
}

export function parseThreadResponse(stdout: string, repo: string, kind: 'pr' | 'issue'): Parsed<FullThread> {
  const root = parseJson(stdout)
  const node = valueAt(root, ['data', 'repository', kind === 'pr' ? 'pullRequest' : 'issue'])
  const title = textAt(node, 'title')
  const url = textAt(node, 'url')
  const number = numberAt(node, 'number') ?? Number(/(\d+)$/.exec(url ?? '')?.[1])

  if (title === undefined || url === undefined) return failed(firstError(root) ?? 'thread not found')

  const thread: FullThread = {
    kind,
    repo,
    number,
    title,
    url,
    author: textAt(node, 'author', 'login') ?? 'ghost',
    body: String(valueAt(node, ['body']) ?? ''),
    comments: listAt(node, 'comments', 'nodes').map(parseComment),
    reviews: listAt(node, 'reviews', 'nodes').map(review => ({
      author: textAt(review, 'author', 'login') ?? 'ghost',
      state: textAt(review, 'state') ?? '',
      body: String(valueAt(review, ['body']) ?? '')
    })),
    threads: listAt(node, 'reviewThreads', 'nodes').map(parseReviewThread)
  }
  const state = textAt(node, 'state')
  const headRef = textAt(node, 'headRefName')
  const baseRef = textAt(node, 'baseRefName')
  const headSha = textAt(node, 'headRefOid')

  if (state !== undefined) thread.state = state
  if (headRef !== undefined) thread.headRef = headRef
  if (baseRef !== undefined) thread.baseRef = baseRef
  if (headSha !== undefined) thread.headSha = headSha

  return { isOk: true, value: thread }
}

export interface PrFiles {
  number: number
  title: string
  author: string
  url: string
  headRef: string
  files: string[]
  isPartial: boolean
}

export function parseOpenPrFiles(stdout: string): Parsed<PrFiles[]> {
  const root = parseJson(stdout)

  if (!Array.isArray(root)) return failed('unexpected pull request list')

  const prs = root.flatMap((node): PrFiles[] => {
    const number = numberAt(node, 'number')
    const url = textAt(node, 'url')

    if (number === undefined || url === undefined) return []

    const files = listAt(node, 'files').flatMap(file => textAt(file, 'path') ?? [])

    return [{
      number,
      title: drawableAt(node, 'title') ?? '',
      author: drawableAt(node, 'author', 'login') ?? 'ghost',
      url,
      headRef: drawableAt(node, 'headRefName') ?? '',
      files,
      isPartial: files.length < (numberAt(node, 'changedFiles') ?? 0)
    }]
  })

  return { isOk: true, value: prs }
}

export function parseBranchPr(stdout: string): { number: number; url: string; baseRef: string; title: string } | undefined {
  const root = parseJson(stdout)
  const number = numberAt(root, 'number')
  const url = textAt(root, 'url')
  const baseRef = textAt(root, 'baseRefName')

  if (number === undefined || url === undefined || baseRef === undefined) return undefined

  return { number, url, baseRef, title: drawableAt(root, 'title') ?? '' }
}
