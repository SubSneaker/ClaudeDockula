// The GitLab adapter: `glab api` GETs only (never -f/-F/-X/--method: any field turns `glab api` into a POST,
// https://docs.gitlab.com/cli/api/). Pure generators; a wiring file runs the requests. Works on gitlab.com and
// self-managed hosts; a nested-group project path is one URL-encoded `:id` segment.
import type { GhCheck, GhItem, GhRepo } from '../../../../types'
import { repoKeyOf } from '../ids'
import { cleanGitlabTrace } from '../logs'
import { LIST_LIMIT } from '../model'
import type { ListsResult, PrFiles } from '../parse'
import type { BranchPr, ListsCtx, Op, Outcome, OverlapCache, PrFilesRead, ProviderAdapter, ProviderCaps, RepoRef, Req } from './types'
import {
  foldMrDetail,
  healthOfAuthStatus,
  parseHeadPipeline,
  parseItemList,
  parseJobs,
  parseJsonLoose,
  parseMrHead,
  parseProject,
  parseProjectPaths,
  parseRawDiffFiles,
  parseThread,
  parseUser
} from './gitlabParse'

export const GLAB_ENV: Record<string, string> = {
  GLAB_NO_PROMPT: 'true',
  NO_COLOR: '1',
  GLAB_PAGER: 'cat',
  GLAB_CHECK_UPDATE: 'false',
  GLAB_SEND_TELEMETRY: 'false'
}

const TEXT_VALUE = /^[A-Za-z0-9\-_.!~*'()%]+$/
const NAME_VALUE = /^[A-Za-z0-9._-]+$/
const DIGITS = /^\d{1,4}$/
const OPENED = /^opened$/
const PROJECT = 'projects/[^/?#]+'

/**
 * One allowed `glab api` GET, as data for the guard (the same shape as its `ReadRule`). `path` is tested against the
 * path without its leading slash or query; the project is one URL-encoded segment (no raw `/`). `query` maps each
 * allowed key to the check its percent-encoded value must pass; `required` keys must be present.
 */
export interface GitlabRead {
  path: RegExp
  query?: Readonly<Record<string, RegExp>>
  required?: readonly string[]
}

export const GITLAB_READS: readonly GitlabRead[] = [
  { path: /^user$/ },
  {
    path: /^projects$/,
    query: { membership: /^true$/, order_by: /^last_activity_at$/, search: TEXT_VALUE, per_page: DIGITS },
    required: ['membership']
  },
  { path: new RegExp(`^${PROJECT}$`) },
  {
    path: new RegExp(`^${PROJECT}/merge_requests$`),
    query: { state: OPENED, reviewer_username: NAME_VALUE, author_username: NAME_VALUE, source_branch: TEXT_VALUE, search: TEXT_VALUE, order_by: /^updated_at$/, sort: /^desc$/, per_page: DIGITS },
    required: ['state']
  },
  {
    path: /^merge_requests$/,
    query: { scope: /^(all|created_by_me)$/, state: OPENED, reviewer_username: NAME_VALUE, search: TEXT_VALUE, per_page: DIGITS },
    required: ['scope', 'state']
  },
  { path: /^issues$/, query: { scope: /^assigned_to_me$/, state: OPENED, search: TEXT_VALUE, per_page: DIGITS }, required: ['scope', 'state'] },
  { path: new RegExp(`^${PROJECT}/merge_requests/\\d+$`) },
  { path: new RegExp(`^${PROJECT}/merge_requests/\\d+/approvals$`) },
  { path: new RegExp(`^${PROJECT}/merge_requests/\\d+/discussions$`), query: { per_page: DIGITS } },
  // `raw_diffs` carries no version note in https://docs.gitlab.com/api/merge_requests/, so no older-server fallback.
  { path: new RegExp(`^${PROJECT}/merge_requests/\\d+/raw_diffs$`) },
  { path: new RegExp(`^${PROJECT}/pipelines/\\d+/jobs$`), query: { per_page: DIGITS } },
  { path: new RegExp(`^${PROJECT}/jobs/\\d+/trace$`) },
  { path: new RegExp(`^${PROJECT}/issues/\\d+$`) },
  { path: new RegExp(`^${PROJECT}/issues/\\d+/notes$`), query: { per_page: DIGITS, sort: /^asc$/ } }
]

const TIMEOUT_MS = 20_000
const DETAIL_CAP = 8
const OVERLAP_CAP = 20
const TRACE_TAIL_CHARS = 400_000
const NO_OUTCOME: Outcome = { exitCode: -1, stdout: '', stderr: 'no outcome' }

function api(path: string, host: string): Req {
  return { kind: 'cli', tool: 'glab', argv: ['glab', 'api', path, '--hostname', host], env: GLAB_ENV, timeoutMs: TIMEOUT_MS }
}

function authStatus(host: string): Req {
  return { kind: 'cli', tool: 'glab', argv: ['glab', 'auth', 'status', '--hostname', host], env: GLAB_ENV, timeoutMs: TIMEOUT_MS }
}

function one(outcome: Outcome | Outcome[] | undefined): Outcome {
  return (Array.isArray(outcome) ? outcome[0] : outcome) ?? NO_OUTCOME
}

function many(outcome: Outcome | Outcome[] | undefined): Outcome[] {
  return Array.isArray(outcome) ? outcome : outcome === undefined ? [] : [outcome]
}

function errorOf(outcome: Outcome): string {
  const text = `${outcome.stderr}\n${outcome.stdout}`.replace(/\s+/g, ' ').trim()

  return text === '' ? `glab exited ${outcome.exitCode}` : text.slice(0, 300)
}

function failure(outcome: Outcome): { isOk: false; error: string } {
  return { isOk: false, error: errorOf(outcome) }
}

const enc = encodeURIComponent

function projectId(path: string): string {
  return enc(path)
}

function mrPath(path: string, iid: number, suffix = ''): string {
  return `projects/${projectId(path)}/merge_requests/${iid}${suffix}`
}

/** The host and project path of an item's repo key (`gitlab.com/g/sub/proj`). */
export function projectOf(item: Pick<GhItem, 'repo'>): { host: string; path: string } {
  const at = item.repo.indexOf('/')

  return { host: item.repo.slice(0, at), path: item.repo.slice(at + 1) }
}

function listPath(base: string, query: Readonly<Record<string, string | number | undefined>>): string {
  const pairs = Object.entries(query).flatMap(([key, value]) => (value === undefined ? [] : `${key}=${typeof value === 'number' ? value : enc(value)}`))

  return `${base}?${pairs.join('&')}`
}

function followed(ctx: ListsCtx): RepoRef[] {
  return ctx.repos.filter(repo => repo.provider === 'gitlab' && repo.host === ctx.host)
}

/** The list requests for a scope: instance-wide, or one per followed project. */
function mrRequests(ctx: ListsCtx, role: 'review' | 'mine', login: string): Req[] {
  if (ctx.scope === 'all') {
    const query = role === 'review'
      ? { scope: 'all', state: 'opened', reviewer_username: login, per_page: LIST_LIMIT }
      : { scope: 'created_by_me', state: 'opened', per_page: LIST_LIMIT }

    return [api(listPath('merge_requests', query), ctx.host)]
  }

  const who = role === 'review' ? { reviewer_username: login } : { author_username: login }

  return followed(ctx).map(repo => api(listPath(`projects/${projectId(repo.path)}/merge_requests`, { state: 'opened', ...who, per_page: LIST_LIMIT }), ctx.host))
}

function* lists(ctx: ListsCtx): Op<ListsResult> {
  let login = ctx.login
  if (login === undefined) {
    const who = parseUser(one(yield api('user', ctx.host)).stdout)
    if (!who.isOk) return who
    login = who.value.login
  }

  const requests = [
    ...mrRequests(ctx, 'review', login).map(req => ({ role: 'review', req })),
    ...mrRequests(ctx, 'mine', login).map(req => ({ role: 'mine', req })),
    { role: 'issues', req: api(listPath('issues', { scope: 'assigned_to_me', state: 'opened', per_page: LIST_LIMIT }), ctx.host) }
  ]
  const outcomes = many(yield requests.map(entry => entry.req))
  const result: ListsResult = { login, review: [], mine: [], issues: [] }
  const keys = new Set(followed(ctx).map(repo => `${repo.host}/${repo.path}`))

  for (const [index, entry] of requests.entries()) {
    const outcome = outcomes[index] ?? NO_OUTCOME
    if (outcome.exitCode !== 0) return failure(outcome)
    const items = parseItemList(outcome.stdout, ctx.host, ctx.ticketPattern)
    if (!items.isOk) return items

    if (entry.role === 'issues') result.issues.push(...items.value.filter(item => ctx.scope === 'all' || keys.has(item.repo)))
    else if (entry.role === 'review') result.review.push(...items.value)
    else result.mine.push(...items.value)
  }

  const newest = (a: GhItem, b: GhItem) => b.updatedAt.localeCompare(a.updatedAt)
  result.review = result.review.sort(newest).slice(0, LIST_LIMIT)
  result.mine = result.mine.sort(newest).slice(0, LIST_LIMIT)
  result.issues = result.issues.sort(newest).slice(0, LIST_LIMIT)

  return { isOk: true, value: result }
}

function* search(ctx: ListsCtx, text: string): Op<GhItem[]> {
  const query = text.trim()
  const mrs = ctx.scope === 'all'
    ? [api(listPath('merge_requests', { scope: 'all', state: 'opened', search: query, per_page: 20 }), ctx.host)]
    : followed(ctx).map(repo => api(listPath(`projects/${projectId(repo.path)}/merge_requests`, { state: 'opened', search: query, per_page: 20 }), ctx.host))
  const requests = [...mrs, api(listPath('issues', { scope: 'assigned_to_me', state: 'opened', search: query, per_page: 20 }), ctx.host)]
  const found: GhItem[] = []

  for (const outcome of many(yield requests)) {
    if (outcome.exitCode !== 0) return failure(outcome)
    const items = parseItemList(outcome.stdout, ctx.host, ctx.ticketPattern)
    if (!items.isOk) return items
    found.push(...items.value)
  }

  return { isOk: true, value: found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20) }
}

function* details(ctx: ListsCtx, items: readonly GhItem[]): Op<Record<string, Partial<GhItem>>> {
  const shown = items.filter(item => item.kind === 'pr').slice(0, DETAIL_CAP)
  const folded: Record<string, Partial<GhItem>> = {}

  if (shown.length === 0) return { isOk: true, value: folded }

  const requests = shown.flatMap(item => {
    const { path } = projectOf(item)

    return [api(mrPath(path, item.number), ctx.host), api(mrPath(path, item.number, '/approvals'), ctx.host)]
  })
  const outcomes = many(yield requests)

  for (const [index, item] of shown.entries()) {
    const detail = outcomes[index * 2] ?? NO_OUTCOME
    const approvals = outcomes[index * 2 + 1] ?? NO_OUTCOME
    const fill = detail.exitCode === 0 ? foldMrDetail(detail.stdout, approvals.exitCode === 0 ? approvals.stdout : '') : undefined

    if (fill !== undefined) folded[item.id] = fill
  }

  return { isOk: true, value: folded }
}

function* health(host: string): Op<{ health: 'ok' | 'missing' | 'logged-out'; login?: string; userId?: string; error?: string }> {
  const status = one(yield authStatus(host))
  const verdict = healthOfAuthStatus(status.exitCode, `${status.stderr}\n${status.stdout}`)

  if (!verdict.isOk) return verdict
  if (verdict.value !== 'ok') return { isOk: true, value: { health: verdict.value } }

  const who = one(yield api('user', host))
  const user = who.exitCode === 0 ? parseUser(who.stdout) : failure(who)

  return user.isOk ? { isOk: true, value: { health: 'ok', ...user.value } } : { isOk: true, value: { health: 'ok', error: user.error } }
}

function* repoOf(ref: RepoRef): Op<GhRepo> {
  const outcome = one(yield api(`projects/${projectId(ref.path)}`, ref.host))

  return outcome.exitCode === 0 ? parseProject(outcome.stdout, ref.host) : failure(outcome)
}

function* checks(item: GhItem): Op<GhCheck[]> {
  const { host, path } = projectOf(item)
  const detail = one(yield api(mrPath(path, item.number), host))
  if (detail.exitCode !== 0) return failure(detail)

  const pipeline = parseHeadPipeline(detail.stdout)
  if (pipeline === undefined) return { isOk: true, value: [] }

  const jobs = one(yield api(listPath(`projects/${projectId(path)}/pipelines/${pipeline.id}/jobs`, { per_page: 100 }), host))

  return jobs.exitCode === 0 ? parseJobs(jobs.stdout) : failure(jobs)
}

function* failedLog(item: GhItem, check: GhCheck): Op<string> {
  const { host, path } = projectOf(item)
  if (check.jobKey === undefined || !/^\d+$/.test(check.jobKey)) return { isOk: false, error: 'no job id' }

  const outcome = one(yield api(`projects/${projectId(path)}/jobs/${check.jobKey}/trace`, host))
  if (outcome.exitCode !== 0) return failure(outcome)

  return { isOk: true, value: cleanGitlabTrace(outcome.stdout.slice(-TRACE_TAIL_CHARS)) }
}

function* thread(item: GhItem) {
  const { host, path } = projectOf(item)
  const isPr = item.kind === 'pr'
  const base = isPr ? mrPath(path, item.number) : `projects/${projectId(path)}/issues/${item.number}`
  const requests = isPr
    ? [api(base, host), api(listPath(`${base}/discussions`, { per_page: 100 }), host), api(`${base}/approvals`, host)]
    : [api(base, host), api(listPath(`${base}/notes`, { per_page: 100, sort: 'asc' }), host)]
  const [detail = NO_OUTCOME, notes = NO_OUTCOME, approvals] = many(yield requests)

  if (detail.exitCode !== 0) return failure(detail)
  if (notes.exitCode !== 0) return failure(notes)

  return parseThread(item.kind, item.repo, detail.stdout, notes.stdout, approvals?.exitCode === 0 ? approvals.stdout : '')
}

function* diff(item: GhItem): Op<string> {
  const { host, path } = projectOf(item)
  const outcome = one(yield api(mrPath(path, item.number, '/raw_diffs'), host))

  return outcome.exitCode === 0 ? { isOk: true, value: outcome.stdout } : failure(outcome)
}

function* head(item: GhItem): Op<{ headSha: string; baseSha?: string; baseRef: string }> {
  const { host, path } = projectOf(item)
  const outcome = one(yield api(mrPath(path, item.number), host))

  return outcome.exitCode === 0 ? parseMrHead(outcome.stdout) : failure(outcome)
}

function* prFiles(item: GhItem): Op<PrFilesRead> {
  const { host, path } = projectOf(item)
  const outcome = one(yield api(mrPath(path, item.number, '/raw_diffs'), host))
  if (outcome.exitCode !== 0) return failure(outcome)
  const files = parseRawDiffFiles(outcome.stdout)

  return { isOk: true, value: outcome.isTruncated === true ? Object.assign(files, { isPartial: true }) : files }
}

/** Open MRs of a project and the files each touches: the 20 most recently updated, read again only when the head sha moved. */
function* openPrFiles(ref: RepoRef, known: OverlapCache) {
  const listing = one(yield api(listPath(`projects/${projectId(ref.path)}/merge_requests`, { state: 'opened', order_by: 'updated_at', sort: 'desc', per_page: 50 }), ref.host))
  if (listing.exitCode !== 0) return failure(listing)

  const parsed = parseItemList(listing.stdout, ref.host)
  if (!parsed.isOk) return parsed

  const open = parsed.value.filter(item => item.kind === 'pr').slice(0, OVERLAP_CAP)
  const stale = open.filter(item => known[item.id]?.headSha !== item.headSha || item.headSha === undefined)
  const outcomes = stale.length === 0 ? [] : many(yield stale.map(item => api(mrPath(ref.path, item.number, '/raw_diffs'), ref.host)))
  const filesOf = new Map<string, string[]>()
  const partial = new Set<string>()

  for (const [index, item] of stale.entries()) {
    const outcome = outcomes[index] ?? NO_OUTCOME
    if (outcome.exitCode !== 0) continue
    filesOf.set(item.id, parseRawDiffFiles(outcome.stdout).map(file => file.filename))
    if (outcome.isTruncated === true) partial.add(item.id)
  }

  const prs = open.flatMap(item => {
    const files = filesOf.get(item.id) ?? known[item.id]?.files
    if (files === undefined) return []
    const entry: PrFiles & { headSha?: string } = {
      number: item.number,
      title: item.title,
      author: item.author,
      url: item.url,
      headRef: item.headRef ?? '',
      files,
      isPartial: partial.has(item.id)
    }
    if (item.headSha !== undefined) entry.headSha = item.headSha

    return [entry]
  })

  return { isOk: true as const, value: prs }
}

function* prForBranch(ref: RepoRef, branch: string): Op<BranchPr | undefined> {
  const outcome = one(yield api(listPath(`projects/${projectId(ref.path)}/merge_requests`, { state: 'opened', source_branch: branch, per_page: 1 }), ref.host))
  if (outcome.exitCode !== 0) return failure(outcome)

  const root = parseJsonLoose(outcome.stdout)
  const [node] = Array.isArray(root) ? root : []
  const found = parseItemList(JSON.stringify(node === undefined ? [] : [node]), ref.host)
  if (!found.isOk) return found

  const [item] = found.value

  return { isOk: true, value: item === undefined || item.baseRef === undefined ? undefined : { number: item.number, url: item.url, baseRef: item.baseRef, title: item.title } }
}

function* recentRepos(host: string): Op<string[]> {
  const outcome = one(yield api(listPath('projects', { membership: 'true', order_by: 'last_activity_at', per_page: 20 }), host))

  return outcome.exitCode === 0 ? { isOk: true, value: parseProjectPaths(outcome.stdout).map(path => repoKeyOf(host, path)) } : failure(outcome)
}

function* searchRepos(host: string, text: string): Op<string[]> {
  const outcome = one(yield api(listPath('projects', { membership: 'true', search: text.trim(), per_page: 4 }), host))

  return outcome.exitCode === 0 ? { isOk: true, value: parseProjectPaths(outcome.stdout).map(path => repoKeyOf(host, path)) } : failure(outcome)
}

const caps: ProviderCaps = {
  issues: true,
  failedLogs: true,
  checkoutCommand: item => (item.kind === 'pr' ? `! glab mr checkout ${item.number}` : undefined),
  vocab: { noun: 'merge request', short: 'MR', sigil: '!' },
  templatePaths: ['.gitlab/merge_request_templates/Default.md']
}

export const gitlabAdapter: ProviderAdapter = {
  id: 'gitlab',
  caps,
  health,
  repoOf,
  lists,
  search,
  details,
  checks,
  failedLog,
  thread,
  diff,
  head,
  prFiles,
  openPrFiles,
  prForBranch,
  recentRepos,
  searchRepos
}
