// Bitbucket Cloud REST responses as the panel's shapes. Pure: no `$`, no network.
import type { GhCheck, GhCheckState, GhCiState, GhItem, GhRepo, GhReviewState } from '../../../../types'
import { findTicketKey } from '../../../settings'
import { isRecord, textAt, valueAt } from '../../jira/parse'
import { redactSecrets } from '../credentials'
import type { PrFileEntry } from '../diff'
import { drawable, type FullThread, type Parsed, type PrFiles, type ReviewThread, type ThreadComment } from '../parse'

export type BitbucketFailure = 'unauthorized' | 'forbidden' | 'rate-limited' | 'not-found' | 'network' | 'other'

/** What a request gave back: the HTTP status when one arrived. */
export interface BitbucketOutcome {
  exitCode: number
  stdout: string
  stderr: string
  status?: number
  headers?: Record<string, string>
}

/** One list row with the reviewer facts the row itself does not keep. */
export interface BitbucketPr {
  item: GhItem
  authorUuid?: string
  /** Absent when the payload carried no participants (a list that did not include them). */
  participants?: Participant[]
}

export interface Participant {
  uuid?: string
  name: string
  role: 'REVIEWER' | 'PARTICIPANT'
  isApproved: boolean
  state?: 'approved' | 'changes_requested'
  participatedOn?: string
}

export interface PrSelf {
  headShort?: string
  baseShort?: string
  headRef?: string
  baseRef?: string
  /** `workspace/slug` of the source and destination repositories. */
  headRepo?: string
  baseRepo?: string
}

const EXCERPT_CHARS = 600
const ERROR_CHARS = 160
const SHORT_HASH = /^[0-9a-f]{7,40}$/
const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const CHECK_ORDER: Record<GhCheckState, number> = { fail: 0, pending: 1, pass: 2, skipped: 2, cancelled: 2 }

/** Percent-encodes everything but unreserved characters, so one value never escapes its query slot. */
export function enc(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function isShortHash(hash: string): boolean {
  return SHORT_HASH.test(hash) && !FULL_HASH.test(hash)
}

export function isFullHash(hash: string): boolean {
  return FULL_HASH.test(hash)
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

function numberAt(value: unknown, ...path: string[]): number | undefined {
  const found = valueAt(value, path)

  return typeof found === 'number' ? found : undefined
}

function drawableAt(value: unknown, ...path: string[]): string | undefined {
  const text = textAt(value, ...path)

  return text === undefined ? undefined : drawable(text)
}

function nameOf(account: unknown): string {
  return drawableAt(account, 'nickname') ?? drawableAt(account, 'display_name') ?? 'ghost'
}

// --- failures ---

function headerOf(outcome: BitbucketOutcome, name: string): string | undefined {
  const found = Object.entries(outcome.headers ?? {}).find(([key]) => key.toLowerCase() === name)

  return found?.[1]
}

/** True when Bitbucket says the hourly allowance is nearly used. */
export function isNearRateLimit(outcome: BitbucketOutcome): boolean {
  return headerOf(outcome, 'x-ratelimit-nearlimit')?.toLowerCase() === 'true'
}

export function isSuccess(outcome: BitbucketOutcome): boolean {
  const status = outcome.status ?? 200

  return outcome.exitCode === 0 && status >= 200 && status < 300
}

export function classifyBitbucketFailure(outcome: BitbucketOutcome): BitbucketFailure {
  if (outcome.status === 401) return 'unauthorized'
  if (outcome.status === 403) return 'forbidden'
  if (outcome.status === 429) return 'rate-limited'
  if (outcome.status === 404) return 'not-found'
  if (outcome.status === undefined || outcome.status === 0) return 'network'

  return 'other'
}

const FAILURE_TEXT: Record<BitbucketFailure, string> = {
  unauthorized: 'Bitbucket did not accept the token (401). Check the email and token.',
  forbidden: 'The token lacks a scope this needs (403): read:pullrequest, read:repository, read:user and read:workspace.',
  'rate-limited': 'Bitbucket rate limit reached (429). GitGud waits before asking again.',
  'not-found': 'Not found on Bitbucket (404).',
  network: 'Could not reach Bitbucket.',
  other: 'Bitbucket returned an error.'
}

/** One short line for a failed request; the response's own message is drawn clean and never holds a credential. */
export function failureMessage(outcome: BitbucketOutcome): string {
  const kind = classifyBitbucketFailure(outcome)
  const detail = textAt(parseJson(outcome.stdout), 'error', 'message')
  const base = kind === 'other' && detail !== undefined ? `Bitbucket: ${detail}` : FAILURE_TEXT[kind]

  return redactSecrets(drawable(base)).slice(0, ERROR_CHARS * 2)
}

/** The request's body when it succeeded, else the failure line. */
export function bodyOf(outcome: BitbucketOutcome): Parsed<string> {
  return isSuccess(outcome) ? { isOk: true, value: outcome.stdout } : failed(failureMessage(outcome))
}

// --- folds ---

/** FAILED|STOPPED → fail, INPROGRESS → pending, all SUCCESSFUL → pass, none → none. */
export function foldStatusState(state: string | undefined): GhCheckState {
  if (state === 'SUCCESSFUL') return 'pass'
  if (state === 'FAILED') return 'fail'
  if (state === 'STOPPED') return 'cancelled'

  return 'pending'
}

export function ciOfChecks(checks: readonly GhCheck[]): GhCiState {
  if (checks.length === 0) return 'none'
  if (checks.some(check => check.state === 'fail' || check.state === 'cancelled')) return 'fail'
  if (checks.some(check => check.state === 'pending')) return 'pending'

  return 'pass'
}

/** `…/statuses` → the checks list, failed first then pending then the rest. */
export function parseStatuses(stdout: string): Parsed<GhCheck[]> {
  const root = parseJson(stdout)

  if (!isRecord(root)) return failed('unexpected statuses response')

  const checks = listAt(root, 'values').flatMap((node): GhCheck[] => {
    const name = drawableAt(node, 'name') ?? drawableAt(node, 'key')

    if (name === undefined) return []

    const check: GhCheck = { name, state: foldStatusState(textAt(node, 'state')) }
    const link = textAt(node, 'url')
    const description = drawableAt(node, 'description')

    if (link !== undefined) check.link = link
    if (description !== undefined) check.description = description

    return [check]
  })

  return { isOk: true, value: checks.sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]) }
}

export function parseParticipants(node: unknown): Participant[] | undefined {
  const found = valueAt(node, ['participants'])

  if (!Array.isArray(found)) return undefined

  return found.flatMap((entry): Participant[] => {
    const state = textAt(entry, 'state')
    const uuid = textAt(entry, 'user', 'uuid')
    const participatedOn = textAt(entry, 'participated_on')
    const participant: Participant = {
      name: nameOf(valueAt(entry, ['user'])),
      role: textAt(entry, 'role') === 'REVIEWER' ? 'REVIEWER' : 'PARTICIPANT',
      isApproved: valueAt(entry, ['approved']) === true
    }

    if (uuid !== undefined) participant.uuid = uuid
    if (state === 'approved' || state === 'changes_requested') participant.state = state
    if (participatedOn !== undefined) participant.participatedOn = participatedOn

    return [participant]
  })
}

export interface ReviewFold {
  review: GhReviewState
  approvalId?: string
  changeRequestId?: string
}

function latestOn(people: readonly Participant[]): Participant | undefined {
  return [...people].sort((a, b) => (b.participatedOn ?? '').localeCompare(a.participatedOn ?? ''))[0]
}

/** Participants → review: any change request wins, then any approval, then reviewers who have not answered. */
export function foldParticipants(participants: readonly Participant[]): ReviewFold {
  const changes = participants.filter(one => one.state === 'changes_requested')
  const approvals = participants.filter(one => one.isApproved || one.state === 'approved')
  const latestChange = latestOn(changes)
  const latestApproval = latestOn(approvals)
  const result: ReviewFold = { review: 'none' }

  if (latestChange !== undefined) result.changeRequestId = `${latestChange.uuid ?? latestChange.name}@${latestChange.participatedOn ?? ''}`
  if (latestApproval !== undefined) result.approvalId = `${latestApproval.uuid ?? latestApproval.name}@${latestApproval.participatedOn ?? ''}`
  if (changes.length > 0) result.review = 'changes'
  else if (approvals.length > 0) result.review = 'approved'
  else if (participants.some(one => one.role === 'REVIEWER')) result.review = 'required'

  return result
}

/** True when this person is a reviewer of the PR who has not approved or asked for changes yet. */
export function isReviewPendingFor(participants: readonly Participant[], uuid: string): boolean {
  return participants.some(one => one.role === 'REVIEWER' && one.uuid === uuid && !one.isApproved && one.state === undefined)
}

// --- lists ---

function excerptOf(raw: string | undefined): string | undefined {
  const text = raw === undefined ? undefined : drawable(raw).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS)

  return text === undefined || text === '' ? undefined : text
}

/** The repo key `host/workspace/slug`, and the path after the host. */
export function repoKeyOf(host: string, fullName: string): string {
  return `${host}/${fullName}`
}

/** `bitbucket.org/ws/slug` → `ws/slug`. */
export function repoPathOfKey(repoKey: string): string {
  return repoKey.split('/').slice(1).join('/')
}

function parsePr(node: unknown, host: string, fallbackFullName: string | undefined, ticketPattern: string | undefined): BitbucketPr | undefined {
  const number = numberAt(node, 'id')
  const rawTitle = textAt(node, 'title')
  const fullName = textAt(node, 'destination', 'repository', 'full_name') ?? fallbackFullName
  const url = textAt(node, 'links', 'html', 'href')

  if (number === undefined || rawTitle === undefined || fullName === undefined || url === undefined) return undefined

  const repo = repoKeyOf(host, fullName)
  const title = drawable(rawTitle)
  const headRef = drawableAt(node, 'source', 'branch', 'name')
  const baseRef = drawableAt(node, 'destination', 'branch', 'name')
  const headSha = textAt(node, 'source', 'commit', 'hash')
  const excerpt = excerptOf(textAt(node, 'summary', 'raw'))
  const ticket = findTicketKey(title, ticketPattern) ?? (headRef === undefined ? undefined : findTicketKey(headRef, ticketPattern))
  const item: GhItem = {
    id: `${repo}#${number}`,
    kind: 'pr',
    repo,
    number,
    title,
    url,
    author: nameOf(valueAt(node, ['author'])),
    updatedAt: textAt(node, 'updated_on') ?? '',
    comments: numberAt(node, 'comment_count') ?? 0,
    isDraft: valueAt(node, ['draft']) === true
  }
  const participants = parseParticipants(node)
  const authorUuid = textAt(node, 'author', 'uuid')
  const pr: BitbucketPr = { item }

  if (excerpt !== undefined) item.excerpt = excerpt
  if (ticket !== undefined) item.ticket = ticket
  if (headRef !== undefined) item.headRef = headRef
  if (baseRef !== undefined) item.baseRef = baseRef
  if (headSha !== undefined) {
    item.headSha = headSha
    if (isShortHash(headSha)) item.isHeadShaShort = true
  }
  if (authorUuid !== undefined) pr.authorUuid = authorUuid
  if (participants !== undefined) {
    const folded = foldParticipants(participants)

    pr.participants = participants
    item.review = folded.review
    if (folded.approvalId !== undefined) item.approvalId = folded.approvalId
    if (folded.changeRequestId !== undefined) item.changeRequestId = folded.changeRequestId
  }

  return pr
}

/** A paginated `values` list of pull requests; `fullName` is used when a row names no destination repository. */
export function parsePullRequests(stdout: string, host: string, fullName?: string, ticketPattern?: string): Parsed<BitbucketPr[]> {
  const root = parseJson(stdout)

  if (!isRecord(root) || !Array.isArray(root['values'])) return failed('unexpected pull request list')

  return { isOk: true, value: root['values'].flatMap(node => parsePr(node, host, fullName, ticketPattern) ?? []) }
}

/** `/2.0/user` → the name to show and the uuid the workspace lists key on. */
export function parseUser(stdout: string): Parsed<{ login: string; uuid: string }> {
  const root = parseJson(stdout)
  const uuid = textAt(root, 'uuid')

  if (uuid === undefined) return failed('unexpected user response')

  return { isOk: true, value: { login: nameOf(root), uuid } }
}

/** `/2.0/user/workspaces` → workspace slugs. */
export function parseWorkspaces(stdout: string): Parsed<string[]> {
  const root = parseJson(stdout)

  if (!isRecord(root) || !Array.isArray(root['values'])) return failed('unexpected workspaces response')

  return { isOk: true, value: root['values'].flatMap(node => textAt(node, 'workspace', 'slug') ?? []) }
}

/** `/2.0/repositories/{ws}` → `workspace/slug` names. */
export function parseRepoNames(stdout: string): string[] {
  const root = parseJson(stdout)

  return listAt(root, 'values').flatMap(node => textAt(node, 'full_name') ?? [])
}

export function parseRepo(stdout: string): Parsed<GhRepo> {
  const root = parseJson(stdout)
  const nameWithOwner = textAt(root, 'full_name')
  const url = textAt(root, 'links', 'html', 'href')

  if (nameWithOwner === undefined || url === undefined) return failed('unexpected repository response')

  const repo: GhRepo = { nameWithOwner, url }
  const defaultBranch = textAt(root, 'mainbranch', 'name')

  if (defaultBranch !== undefined) repo.defaultBranch = defaultBranch

  return { isOk: true, value: repo }
}

// --- one PR ---

export function parsePrSelf(stdout: string): Parsed<PrSelf & { participants?: Participant[] }> {
  const root = parseJson(stdout)

  if (!isRecord(root)) return failed('unexpected pull request response')

  const self: PrSelf & { participants?: Participant[] } = {}
  const parts: [keyof PrSelf, string | undefined][] = [
    ['headShort', textAt(root, 'source', 'commit', 'hash')],
    ['baseShort', textAt(root, 'destination', 'commit', 'hash')],
    ['headRef', textAt(root, 'source', 'branch', 'name')],
    ['baseRef', textAt(root, 'destination', 'branch', 'name')],
    ['headRepo', textAt(root, 'source', 'repository', 'full_name')],
    ['baseRepo', textAt(root, 'destination', 'repository', 'full_name')]
  ]
  const participants = parseParticipants(root)

  for (const [key, value] of parts) if (value !== undefined) self[key] = value
  if (participants !== undefined) self.participants = participants

  return { isOk: true, value: self }
}

/** `…/commit/{hash}` → the full hash. */
export function parseCommitHash(stdout: string): string | undefined {
  const hash = textAt(parseJson(stdout), 'hash')

  return hash !== undefined && isFullHash(hash) ? hash : undefined
}

/** `git rev-parse --verify` output → the full hash, when it printed one. */
export function parseRevParse(stdout: string): string | undefined {
  const hash = stdout.trim()

  return isFullHash(hash) ? hash : undefined
}

/** `…/diffstat/{a}..{b}` → changed paths; partial when another page exists. */
export function parseDiffstat(stdout: string): Parsed<{ files: string[]; isPartial: boolean }> {
  const root = parseJson(stdout)

  if (!isRecord(root) || !Array.isArray(root['values'])) return failed('unexpected diffstat response')

  const files = root['values'].flatMap(node => textAt(node, 'new', 'path') ?? textAt(node, 'old', 'path') ?? [])

  return { isOk: true, value: { files, isPartial: typeof root['next'] === 'string' } }
}

/** Open-PR rows for the overlap scan: no participants, just what names the PR and its two commits. */
export interface OverlapRow {
  number: number
  title: string
  author: string
  url: string
  headRef: string
  headShort: string
  baseShort: string
  updatedAt: string
  /** The head commit is in another repository than the destination. */
  isFork?: boolean
}

function isForkNode(node: unknown): boolean {
  const head = textAt(node, 'source', 'repository', 'full_name')
  const base = textAt(node, 'destination', 'repository', 'full_name')

  return head !== undefined && base !== undefined && head !== base
}

export function parseOverlapRows(stdout: string): Parsed<OverlapRow[]> {
  const root = parseJson(stdout)

  if (!isRecord(root) || !Array.isArray(root['values'])) return failed('unexpected pull request list')

  const rows = root['values'].flatMap((node): OverlapRow[] => {
    const number = numberAt(node, 'id')
    const url = textAt(node, 'links', 'html', 'href')
    const headShort = textAt(node, 'source', 'commit', 'hash')
    const baseShort = textAt(node, 'destination', 'commit', 'hash')

    if (number === undefined || url === undefined || headShort === undefined || baseShort === undefined) return []

    return [{
      number,
      title: drawableAt(node, 'title') ?? '',
      author: nameOf(valueAt(node, ['author'])),
      url,
      headRef: drawableAt(node, 'source', 'branch', 'name') ?? '',
      headShort,
      baseShort,
      updatedAt: textAt(node, 'updated_on') ?? '',
      ...(isForkNode(node) ? { isFork: true } : {})
    }]
  })

  return { isOk: true, value: rows }
}

export function toPrFiles(row: OverlapRow, files: string[], isPartial: boolean): PrFiles & { headSha: string } {
  return { number: row.number, title: row.title, author: row.author, url: row.url, headRef: row.headRef, files, isPartial, headSha: row.headShort }
}

// --- thread ---

function parseComment(node: unknown): ThreadComment & { id?: number; parentId?: number; path?: string; line?: number } {
  const raw = valueAt(node, ['content', 'raw'])
  const comment: ThreadComment & { id?: number; parentId?: number; path?: string; line?: number } = {
    author: nameOf(valueAt(node, ['user'])),
    body: typeof raw === 'string' ? raw : ''
  }
  const createdAt = textAt(node, 'created_on')
  const url = textAt(node, 'links', 'html', 'href')
  const id = numberAt(node, 'id')
  const parentId = numberAt(node, 'parent', 'id')
  const path = textAt(node, 'inline', 'path')
  const line = numberAt(node, 'inline', 'to') ?? numberAt(node, 'inline', 'from')

  if (createdAt !== undefined) comment.createdAt = createdAt
  if (url !== undefined) comment.url = url
  if (id !== undefined) comment.id = id
  if (parentId !== undefined) comment.parentId = parentId
  if (path !== undefined) comment.path = path
  if (line !== undefined) comment.line = line

  return comment
}

/**
 * A PR and its comment page as one thread: plain comments stay flat, inline comments (and their replies)
 * group by the first comment of the chain. Bitbucket does not say whether a thread is resolved.
 * @example
 * // before: [{ id: 1, inline: { path: 'a.ts', to: 4 } }, { id: 2, parent: { id: 1 } }, { id: 3 }]
 * // after:  { comments: [#3], threads: [{ path: 'a.ts', line: 4, comments: [#1, #2] }] }
 */
export function parseBitbucketThread(selfStdout: string, commentsStdout: string, repo: string, number: number): Parsed<FullThread> {
  const pr = parseJson(selfStdout)
  const title = drawableAt(pr, 'title')
  const url = textAt(pr, 'links', 'html', 'href')

  if (title === undefined || url === undefined) return failed('unexpected pull request response')

  const parsed = listAt(parseJson(commentsStdout), 'values')
    .filter(node => valueAt(node, ['deleted']) !== true)
    .map(parseComment)
  const byId = new Map(parsed.flatMap(comment => (comment.id === undefined ? [] : [[comment.id, comment] as const])))
  const rootOf = (comment: (typeof parsed)[number]): (typeof parsed)[number] => {
    let at = comment

    for (let hops = 0; at.parentId !== undefined && hops < 50; hops += 1) {
      const parent = byId.get(at.parentId)

      if (parent === undefined) break
      at = parent
    }

    return at
  }
  const threads = new Map<(typeof parsed)[number], ReviewThread>()
  const flat: ThreadComment[] = []

  for (const comment of parsed) {
    const { id: _id, parentId: _parent, path: _path, line: _line, ...plain } = comment
    const root = rootOf(comment)

    if (root.path === undefined) {
      flat.push(plain)
      continue
    }

    const thread = threads.get(root) ?? { path: root.path, ...(root.line === undefined ? {} : { line: root.line }), isResolved: false, isOutdated: false, comments: [] }

    thread.comments.push(plain)
    threads.set(root, thread)
  }

  const participants = parseParticipants(pr) ?? []
  const reviews = participants.flatMap(one => {
    if (one.state === 'changes_requested') return [{ author: one.name, state: 'CHANGES_REQUESTED', body: '' }]

    return one.isApproved || one.state === 'approved' ? [{ author: one.name, state: 'APPROVED', body: '' }] : []
  })
  const thread: FullThread = {
    kind: 'pr',
    repo,
    number,
    title,
    url,
    author: nameOf(valueAt(pr, ['author'])),
    body: textAt(pr, 'summary', 'raw') ?? '',
    comments: flat,
    reviews,
    threads: [...threads.values()]
  }
  const state = textAt(pr, 'state')
  const headRef = drawableAt(pr, 'source', 'branch', 'name')
  const baseRef = drawableAt(pr, 'destination', 'branch', 'name')

  if (state !== undefined) thread.state = state
  if (headRef !== undefined) thread.headRef = headRef
  if (baseRef !== undefined) thread.baseRef = baseRef

  return { isOk: true, value: thread }
}

// --- diff ---

const DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/

/**
 * A raw git-style diff as one entry per file, each with its patch from the first hunk on.
 * @example
 * // before: 'diff --git a/x.ts b/x.ts\nindex 1..2\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n'
 * // after:  [{ filename: 'x.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }]
 */
export function splitUnifiedDiff(text: string): PrFileEntry[] {
  const entries: PrFileEntry[] = []
  let lines: string[] = []

  const flush = (): void => {
    const [header, ...rest] = lines
    const match = header === undefined ? null : DIFF_HEADER.exec(header)

    lines = []
    if (match === null) return

    const [, from = '', to = ''] = match
    const firstHunk = rest.findIndex(line => line.startsWith('@@'))
    const head = firstHunk === -1 ? rest : rest.slice(0, firstHunk)
    const isRename = head.some(line => line.startsWith('rename from '))
    const status = head.some(line => line.startsWith('new file mode')) ? 'added' : head.some(line => line.startsWith('deleted file mode')) ? 'removed' : isRename ? 'renamed' : 'modified'
    const entry: PrFileEntry = { filename: status === 'removed' ? from : to, status }

    if (isRename) entry.previousFilename = from
    if (firstHunk !== -1) entry.patch = rest.slice(firstHunk).join('\n').replace(/\n+$/, '')
    entries.push(entry)
  }

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) flush()
    lines.push(line)
  }
  flush()

  return entries
}
