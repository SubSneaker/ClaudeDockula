// GitLab REST responses (as `glab api` prints them) folded into the shapes the panel draws. Pure: no `$`.
// Field names: https://docs.gitlab.com/api/merge_requests/, /api/discussions/, /api/merge_request_approvals/, /api/jobs/
import type { GhCheck, GhCheckState, GhCiState, GhHealth, GhItem, GhRepo, GhReviewState } from '../../../../types'
import { isRecord, textAt, valueAt } from '../../jira/parse'
import { findTicketKey } from '../../../settings'
import type { PrFileEntry } from '../diff'
import { drawable } from '../parse'
import type { FullThread, ReviewThread, ThreadComment } from '../parse'
import type { Parsed } from './types'

const EXCERPT_CHARS = 600

function fail<T>(error: string): Parsed<T> {
  return { isOk: false, error }
}

/** One JSON value; `--paginate` may print several arrays back to back, which are joined into one. */
export function parseJsonLoose(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    try {
      return JSON.parse(stdout.replace(/\]\s*\[/g, ','))
    } catch {
      return undefined
    }
  }
}

function listOf(root: unknown): unknown[] {
  return Array.isArray(root) ? root : []
}

function numberAt(value: unknown, ...path: string[]): number | undefined {
  const found = valueAt(value, path)

  return typeof found === 'number' ? found : undefined
}

function drawableAt(value: unknown, ...path: string[]): string | undefined {
  const text = textAt(value, ...path)

  return text === undefined ? undefined : drawable(text)
}

function excerptOf(body: string | undefined): string | undefined {
  const text = body === undefined ? undefined : drawable(body).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS)

  return text === undefined || text === '' ? undefined : text
}

export type GlabFailure = 'missing' | 'logged-out' | 'rate-limited' | 'not-found' | 'network' | 'other'

const FAILURE_PATTERNS: readonly [GlabFailure, RegExp][] = [
  ['missing', /enoent|executable file not found|command not found|glab: not found/i],
  ['logged-out', /glab auth login|not logged in|no token found|401|unauthorized|invalid token|token (?:has )?expired/i],
  ['rate-limited', /429|rate limit|too many requests/i],
  ['network', /could not resolve host|dial tcp|no such host|timed? ?out|connection (?:refused|reset)|network is unreachable|tls|x509/i],
  ['not-found', /404|not found/i]
]

/** What a failed `glab` call says about itself. */
export function classifyGlabFailure(text: string): GlabFailure {
  return FAILURE_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other'
}

/** `glab auth status` output → health; a failure that says nothing about sign-in stays an error. */
export function healthOfAuthStatus(exitCode: number, text: string): Parsed<GhHealth> {
  if (exitCode === 0) return { isOk: true, value: 'ok' }
  const kind = classifyGlabFailure(text)
  if (kind === 'missing') return { isOk: true, value: 'missing' }
  if (kind === 'logged-out') return { isOk: true, value: 'logged-out' }

  return fail(drawable(text).trim().slice(0, 300) || 'glab auth status failed')
}

/** `GET /user` → login and numeric id. */
export function parseUser(stdout: string): Parsed<{ login: string; userId?: string }> {
  const root = parseJsonLoose(stdout)
  const login = textAt(root, 'username')
  const id = numberAt(root, 'id')

  if (login === undefined) return fail('unexpected GitLab user response')

  return { isOk: true, value: id === undefined ? { login } : { login, userId: String(id) } }
}

/** `GET /projects/:id` → the repo; `nameWithOwner` is the full namespaced path. */
export function parseProject(stdout: string, host: string): Parsed<GhRepo> {
  const root = parseJsonLoose(stdout)
  const path = textAt(root, 'path_with_namespace')
  const url = textAt(root, 'web_url')

  if (path === undefined || url === undefined) return fail('unexpected project response')

  const defaultBranch = textAt(root, 'default_branch')
  const repo: GhRepo = { nameWithOwner: path, url, provider: 'gitlab', host, path }
  if (defaultBranch !== undefined) repo.defaultBranch = defaultBranch

  return { isOk: true, value: repo }
}

/** `GET /projects` → namespaced paths. */
export function parseProjectPaths(stdout: string): string[] {
  return listOf(parseJsonLoose(stdout)).flatMap(node => textAt(node, 'path_with_namespace') ?? [])
}

/**
 * The project path of an MR or issue: `references.full` (`g/sub/proj!12`), else its web URL.
 * @example
 * // before: { references: { full: 'g/sub/proj!12' } }
 * // after:  'g/sub/proj'
 */
export function projectPathOf(node: unknown): string | undefined {
  const full = textAt(node, 'references', 'full')
  const fromRef = full === undefined ? null : /^(.+)[!#]\d+$/.exec(full)
  if (fromRef?.[1]) return fromRef[1]
  const url = textAt(node, 'web_url')
  const fromUrl = url === undefined ? null : /^https?:\/\/[^/]+\/(.+?)\/-\/(?:merge_requests|issues)\/\d+/.exec(url)

  return fromUrl?.[1]
}

function labelsOf(node: unknown): string[] {
  const labels = valueAt(node, ['labels'])

  return Array.isArray(labels)
    ? labels.flatMap(label => (typeof label === 'string' ? drawable(label) : (drawableAt(label, 'name') ?? [])))
    : []
}

/** `detailed_merge_status` requested_changes → changes; with approvers and `approved` → approved; not_approved → required. */
export function foldGitlabReview(mergeStatus: string | undefined, isApproved: boolean, approvers: readonly string[]): GhReviewState {
  if (mergeStatus === 'requested_changes') return 'changes'
  if (isApproved && approvers.length > 0) return 'approved'
  if (mergeStatus === 'not_approved') return 'required'

  return 'none'
}

/** Pipeline status: success → pass, failed → fail, in-flight or waiting → pending, anything else → none. */
export function foldPipelineStatus(status: string | null | undefined): GhCiState {
  if (status === 'success') return 'pass'
  if (status === 'failed') return 'fail'
  if (
    status === 'running' || status === 'pending' || status === 'created' || status === 'preparing' ||
    status === 'scheduled' || status === 'waiting_for_resource' || status === 'waiting_for_callback'
  ) return 'pending'

  return 'none'
}

/** One entry of an MR or issue list. `repoKey` is `host/path`. */
export function parseListItem(node: unknown, host: string, ticketPattern?: string): GhItem | undefined {
  const number = numberAt(node, 'iid')
  const rawTitle = textAt(node, 'title')
  const url = textAt(node, 'web_url')
  const path = projectPathOf(node)

  if (number === undefined || rawTitle === undefined || url === undefined || path === undefined) return undefined

  const repo = `${host}/${path}`
  const title = drawable(rawTitle)
  const headRef = drawableAt(node, 'source_branch')
  const isPr = headRef !== undefined || url.includes('/merge_requests/')
  const labels = labelsOf(node)
  const item: GhItem = {
    id: `${repo}#${number}`,
    provider: 'gitlab',
    kind: isPr ? 'pr' : 'issue',
    repo,
    number,
    title,
    url,
    author: drawableAt(node, 'author', 'username') ?? 'ghost',
    updatedAt: textAt(node, 'updated_at') ?? '',
    comments: numberAt(node, 'user_notes_count') ?? 0
  }
  const excerpt = excerptOf(textAt(node, 'description'))
  const ticket = findTicketKey(title, ticketPattern) ?? (headRef === undefined ? undefined : findTicketKey(headRef, ticketPattern))

  if (excerpt !== undefined) item.excerpt = excerpt
  if (labels.length > 0) item.labels = labels
  if (ticket !== undefined) item.ticket = ticket
  if (!isPr) return item

  const baseRef = drawableAt(node, 'target_branch')
  const headSha = textAt(node, 'sha')

  item.isDraft = valueAt(node, ['draft']) === true
  if (headRef !== undefined) item.headRef = headRef
  if (baseRef !== undefined) item.baseRef = baseRef
  if (headSha !== undefined) item.headSha = headSha
  if (textAt(node, 'detailed_merge_status') === 'requested_changes') {
    item.review = 'changes'
    if (headSha !== undefined) item.changeRequestId = headSha
  }

  return item
}

/** A list response → items, newest update first. */
export function parseItemList(stdout: string, host: string, ticketPattern?: string): Parsed<GhItem[]> {
  const root = parseJsonLoose(stdout)

  if (!Array.isArray(root)) return fail(drawableAt(root, 'message') ?? 'unexpected GitLab list response')

  const items = root.flatMap(node => parseListItem(node, host, ticketPattern) ?? [])

  return { isOk: true, value: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
}

/** The usernames in `approved_by`, sorted. */
export function approversOf(approvalsStdout: string): string[] {
  const list = valueAt(parseJsonLoose(approvalsStdout), ['approved_by'])

  return (Array.isArray(list) ? list : []).flatMap(entry => textAt(entry, 'user', 'username') ?? []).sort()
}

/**
 * MR detail + approvals → the row's CI and review. The approved alert keys on the sorted approver list, changes on the head sha.
 * @example
 * // before: detail { head_pipeline: { status: 'failed' }, detailed_merge_status: 'not_approved', diff_refs: { head_sha: 'abc' } }, approvals { approved_by: [] }
 * // after:  { ci: 'fail', review: 'required', headSha: 'abc' }
 */
export function foldMrDetail(detailStdout: string, approvalsStdout: string): Partial<GhItem> | undefined {
  const detail = parseJsonLoose(detailStdout)

  if (!isRecord(detail) || numberAt(detail, 'iid') === undefined) return undefined

  const approvals = parseJsonLoose(approvalsStdout)
  const approvers = approversOf(approvalsStdout)
  const review = foldGitlabReview(textAt(detail, 'detailed_merge_status'), valueAt(approvals, ['approved']) === true, approvers)
  const headSha = textAt(detail, 'diff_refs', 'head_sha') ?? textAt(detail, 'sha')
  const folded: Partial<GhItem> = { ci: foldPipelineStatus(textAt(detail, 'head_pipeline', 'status')), review }

  if (headSha !== undefined) folded.headSha = headSha
  if (review === 'approved') folded.approvalId = approvers.join(',')
  if (review === 'changes' && headSha !== undefined) folded.changeRequestId = headSha

  return folded
}

/** `diff_refs` and target branch of an MR detail. */
export function parseMrHead(stdout: string): Parsed<{ headSha: string; baseSha?: string; baseRef: string }> {
  const root = parseJsonLoose(stdout)
  const headSha = textAt(root, 'diff_refs', 'head_sha') ?? textAt(root, 'sha')
  const baseRef = textAt(root, 'target_branch')

  if (headSha === undefined || baseRef === undefined) return fail(drawableAt(root, 'message') ?? 'merge request not found')

  const baseSha = textAt(root, 'diff_refs', 'base_sha')

  return { isOk: true, value: baseSha === undefined ? { headSha, baseRef } : { headSha, baseSha, baseRef } }
}

/** The head pipeline of an MR detail: its id and web URL. */
export function parseHeadPipeline(stdout: string): { id: number; url?: string } | undefined {
  const root = parseJsonLoose(stdout)
  const id = numberAt(root, 'head_pipeline', 'id')
  const url = textAt(root, 'head_pipeline', 'web_url')

  if (id === undefined) return undefined

  return url === undefined ? { id } : { id, url }
}

const JOB_STATES: Record<string, GhCheckState> = {
  success: 'pass',
  failed: 'fail',
  skipped: 'skipped',
  manual: 'skipped',
  canceled: 'cancelled',
  canceling: 'cancelled'
}
const CHECK_ORDER: Record<GhCheckState, number> = { fail: 0, pending: 1, pass: 2, skipped: 2, cancelled: 2 }

/** Pipeline jobs → checks: stage as the workflow, a failed job allowed to fail as skipped; failed first, then pending. */
export function parseJobs(stdout: string): Parsed<GhCheck[]> {
  const root = parseJsonLoose(stdout)

  if (!Array.isArray(root)) return fail(drawableAt(root, 'message') ?? 'unexpected jobs response')

  const checks = root.flatMap((node): GhCheck[] => {
    const name = drawableAt(node, 'name')
    const id = numberAt(node, 'id')
    if (name === undefined || id === undefined) return []

    const status = textAt(node, 'status') ?? ''
    const isAllowedFailure = status === 'failed' && valueAt(node, ['allow_failure']) === true
    const check: GhCheck = { name, state: isAllowedFailure ? 'skipped' : (JOB_STATES[status] ?? 'pending'), jobKey: String(id) }
    const stage = drawableAt(node, 'stage')
    const link = textAt(node, 'web_url')
    const reason = isAllowedFailure ? 'failed (allowed to fail)' : status === 'failed' ? drawableAt(node, 'failure_reason') : undefined

    if (stage !== undefined) check.workflow = stage
    if (link !== undefined) check.link = link
    if (reason !== undefined) check.description = reason

    return [check]
  })

  return { isOk: true, value: checks.sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]) }
}

function parseNoteComment(note: unknown): ThreadComment {
  const comment: ThreadComment = { author: drawableAt(note, 'author', 'username') ?? 'ghost', body: String(valueAt(note, ['body']) ?? '') }
  const createdAt = textAt(note, 'created_at')
  if (createdAt !== undefined) comment.createdAt = createdAt

  return comment
}

function isUserNote(note: unknown): boolean {
  return valueAt(note, ['system']) !== true
}

/**
 * Discussions → plain comments and diff threads. A thread is resolved when every resolvable note is; it is outdated
 * when its position was made on another head commit.
 * @example
 * // before: [{ individual_note: true, notes: [{ body: 'hi' }] }, { individual_note: false, notes: [{ position: { new_path: 'a.ts', new_line: 3 }, resolved: true, resolvable: true }] }]
 * // after:  { comments: [{ body: 'hi', … }], threads: [{ path: 'a.ts', line: 3, isResolved: true, … }] }
 */
export function foldDiscussions(stdout: string, headSha?: string): { comments: ThreadComment[]; threads: ReviewThread[] } {
  const comments: ThreadComment[] = []
  const threads: ReviewThread[] = []

  for (const discussion of listOf(parseJsonLoose(stdout))) {
    const notes = listOf(valueAt(discussion, ['notes'])).filter(isUserNote)
    const [first] = notes
    const position = valueAt(first, ['position'])
    const path = textAt(position, 'new_path') ?? textAt(position, 'old_path')

    if (first === undefined) continue
    if (path === undefined) {
      comments.push(...notes.map(parseNoteComment))
      continue
    }

    const resolvable = notes.filter(note => valueAt(note, ['resolvable']) === true)
    const line = numberAt(position, 'new_line') ?? numberAt(position, 'old_line')
    const positionSha = textAt(position, 'head_sha')
    const thread: ReviewThread = {
      path,
      isResolved: resolvable.length > 0 && resolvable.every(note => valueAt(note, ['resolved']) === true),
      isOutdated: headSha !== undefined && positionSha !== undefined && positionSha !== headSha,
      comments: notes.map(parseNoteComment)
    }

    if (line !== undefined) thread.line = line
    threads.push(thread)
  }

  return { comments, threads }
}

/** Issue notes (`GET …/issues/:iid/notes`) → comments. */
export function foldIssueNotes(stdout: string): ThreadComment[] {
  return listOf(parseJsonLoose(stdout)).filter(isUserNote).map(parseNoteComment)
}

/** MR or issue detail + its discussions or notes (+ approvals for an MR) → the full thread. */
export function parseThread(kind: 'pr' | 'issue', repo: string, detailStdout: string, discussionsStdout: string, approvalsStdout = ''): Parsed<FullThread> {
  const root = parseJsonLoose(detailStdout)
  const title = textAt(root, 'title')
  const url = textAt(root, 'web_url')
  const number = numberAt(root, 'iid')

  if (title === undefined || url === undefined || number === undefined) return fail(drawableAt(root, 'message') ?? 'thread not found')

  const headSha = textAt(root, 'diff_refs', 'head_sha') ?? textAt(root, 'sha')
  const thread: FullThread = {
    kind,
    repo,
    number,
    title,
    url,
    author: drawableAt(root, 'author', 'username') ?? 'ghost',
    body: String(valueAt(root, ['description']) ?? ''),
    comments: [],
    reviews: approversOf(approvalsStdout).map(author => ({ author, state: 'APPROVED', body: '' })),
    threads: []
  }
  const state = textAt(root, 'state')
  const headRef = textAt(root, 'source_branch')
  const baseRef = textAt(root, 'target_branch')

  if (state !== undefined) thread.state = state
  if (headRef !== undefined) thread.headRef = headRef
  if (baseRef !== undefined) thread.baseRef = baseRef
  if (kind === 'pr' && headSha !== undefined) thread.headSha = headSha

  if (kind === 'issue') {
    thread.comments = foldIssueNotes(discussionsStdout)
  } else {
    const folded = foldDiscussions(discussionsStdout, headSha)
    thread.comments = folded.comments
    thread.threads = folded.threads
  }

  return { isOk: true, value: thread }
}

const DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/

function unquote(path: string): string {
  return path.replace(/^"|"$/g, '')
}

function fileOfBlock(block: string[]): PrFileEntry | undefined {
  const [header = ''] = block
  const names = DIFF_HEADER.exec(header)
  if (names === null) return undefined

  const hunkAt = block.findIndex(line => line.startsWith('@@'))
  const meta = hunkAt === -1 ? block : block.slice(0, hunkAt)
  const renameFrom = meta.find(line => line.startsWith('rename from '))?.slice('rename from '.length)
  const renameTo = meta.find(line => line.startsWith('rename to '))?.slice('rename to '.length)
  const isNew = meta.some(line => line.startsWith('new file mode'))
  const isDeleted = meta.some(line => line.startsWith('deleted file mode'))
  const filename = unquote(renameTo ?? (isDeleted ? names[1] : names[2]) ?? '')
  const entry: PrFileEntry = { filename, status: isNew ? 'added' : isDeleted ? 'removed' : renameTo === undefined ? 'modified' : 'renamed' }

  if (renameFrom !== undefined) entry.previousFilename = unquote(renameFrom)
  if (hunkAt !== -1) entry.patch = block.slice(hunkAt).join('\n').replace(/\n+$/, '')

  return filename === '' ? undefined : entry
}

/**
 * A git-style raw diff → one entry per file; `patch` starts at the first `@@` and is absent for binary or hunkless files.
 * @example
 * // before: 'diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n'
 * // after:  [{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' }]
 */
export function parseRawDiffFiles(raw: string): PrFileEntry[] {
  const blocks: string[][] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) blocks.push([line])
    else blocks.at(-1)?.push(line)
  }

  return blocks.flatMap(block => fileOfBlock(block) ?? [])
}
