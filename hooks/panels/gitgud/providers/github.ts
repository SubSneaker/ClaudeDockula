// The GitHub adapter (github.com and GitHub Enterprise Server, both through `gh`): the `gh` argv builders and
// the operations that wrap them. Pure: no `$`; the wiring file runs each yielded request.
import type { GhCheck, GhHealth, GhItem, GhRepo, GhScope } from '../../../../types'
import { parseBaseRef, parseHeadSha, parsePrFiles } from '../diff'
import { itemId, parseItemId, parseRepoKey, repoKeyOf } from '../ids'
import { LIST_LIMIT } from '../model'
import {
  classifyGhFailure,
  parseBranchPr,
  parseChecks,
  parseListsResponse,
  parseOpenPrFiles,
  parseRecentRepos,
  parseRepoView,
  parseSearchRepos,
  parseSearchResponse,
  parseThreadResponse,
  type FullThread,
  type ListsResult,
  type Parsed,
  type PrFiles
} from '../parse'
import type { BranchPr, ListsCtx, Op, Outcome, OverlapCache, PrFilesRead, ProviderAdapter, RepoRef, Req } from './types'

const DEFAULT_HOST = 'github.com'
const GH = 'gh'
const NOT_RUN = -1
const NOT_STARTED = -2
const FULL_SHA = /^[0-9a-f]{40}$/

/** A `gh api` call on an Enterprise host names it; github.com is the default and gets no flag. */
function onHost(argv: string[], host: string): string[] {
  return host === DEFAULT_HOST ? argv : [...argv, '--hostname', host]
}

export const GH_ENV: Record<string, string> = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
  CLICOLOR: '0',
  GH_PAGER: 'cat',
  PAGER: 'cat'
}

const SEARCH_LIMIT = 20
const ITEM_FRAGMENT = `fragment item on SearchResultItem {
  ... on PullRequest { number title url updatedAt isDraft reviewDecision headRefName baseRefName headRefOid bodyText
    author { login } repository { nameWithOwner } comments { totalCount } labels(first: 5) { nodes { name } }
    reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
    lastApproval: reviews(last: 1, states: [APPROVED]) { nodes { id } }
    lastChangeRequest: reviews(last: 1, states: [CHANGES_REQUESTED]) { nodes { id } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
  ... on Issue { number title url updatedAt bodyText author { login } repository { nameWithOwner }
    comments { totalCount } labels(first: 5) { nodes { name } } }
}`
const LISTS_QUERY = `query($review: String!, $mine: String!, $issues: String!) {
  viewer { login }
  rateLimit { cost remaining resetAt }
  review: search(query: $review, type: ISSUE, first: ${LIST_LIMIT}) { issueCount nodes { ...item } }
  mine: search(query: $mine, type: ISSUE, first: ${LIST_LIMIT}) { issueCount nodes { ...item } }
  issues: search(query: $issues, type: ISSUE, first: ${LIST_LIMIT}) { issueCount nodes { ...item } }
}
${ITEM_FRAGMENT}`
const SEARCH_QUERY = `query($q: String!) {
  rateLimit { cost remaining resetAt }
  search(query: $q, type: ISSUE, first: ${SEARCH_LIMIT}) { nodes { ...item } }
}
${ITEM_FRAGMENT}`
const RECENT_REPOS_QUERY = `query {
  viewer { repositories(first: 20, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: { field: PUSHED_AT, direction: DESC }) { nodes { nameWithOwner } } }
}`
const THREAD_COMMENTS = 'comments(first: 100) { nodes { author { login } body createdAt url } }'
const PR_THREAD_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    title body url state headRefName baseRefName headRefOid author { login }
    ${THREAD_COMMENTS}
    reviews(first: 50) { nodes { author { login } state body } }
    reviewThreads(first: 100) { nodes { isResolved isOutdated path line originalLine
      comments(first: 50) { nodes { author { login } body createdAt url diffHunk } } } }
  } }
}`
const ISSUE_THREAD_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    title body url state author { login }
    ${THREAD_COMMENTS}
  } }
}`
const CHECK_FIELDS = 'name,state,bucket,link,workflow,description,startedAt,completedAt'
const REPO_FIELDS = 'nameWithOwner,url,defaultBranchRef'

export function ghAuthStatus(gh: string, host: string = DEFAULT_HOST): string[] {
  return [gh, 'auth', 'status', '--hostname', host]
}
/** The cheapest call that needs both the network and a valid token: tells offline from signed out. */
export function ghViewerCall(gh: string, host: string = DEFAULT_HOST): string[] {
  return onHost([gh, 'api', 'graphql', '-f', 'query=query { viewer { login } }'], host)
}
export function ghRepoView(gh: string): string[] {
  return [gh, 'repo', 'view', '--json', REPO_FIELDS]
}
export function ghRepoValidate(gh: string, repo: string): string[] {
  return [gh, 'repo', 'view', repo, '--json', REPO_FIELDS]
}
export function ghRecentRepos(gh: string, host: string = DEFAULT_HOST): string[] {
  return onHost([gh, 'api', 'graphql', '-f', `query=${RECENT_REPOS_QUERY}`], host)
}
export function ghSearchRepos(gh: string, text: string): string[] {
  return [gh, 'search', 'repos', text, '--limit', '4', '--json', 'fullName,description']
}

export interface ListsQuery {
  scope: GhScope
  repos: readonly string[]
}

function repoQualifiers(query: ListsQuery): string {
  return query.scope === 'repos' ? query.repos.map(repo => ` repo:${repo}`).join('') : ''
}

/** Search qualifiers per list, each + `repo:a repo:b` in `repos` scope. */
export function listQueries(query: ListsQuery): { review: string; mine: string; issues: string } {
  const repos = repoQualifiers(query)

  return {
    review: `is:pr is:open review-requested:@me archived:false${repos}`,
    mine: `is:pr is:open author:@me${repos}`,
    issues: `is:issue is:open assignee:@me${repos}`
  }
}
export function searchQuery(text: string, query: ListsQuery): string {
  return `${text.trim()} is:open${repoQualifiers(query)}`
}
/** One graphql call: viewer, rateLimit, three aliased searches (first: LIST_LIMIT). */
export function ghListsCall(gh: string, query: ListsQuery): string[] {
  const { review, mine, issues } = listQueries(query)

  return [gh, 'api', 'graphql', '-f', `query=${LISTS_QUERY}`, '-f', `review=${review}`, '-f', `mine=${mine}`, '-f', `issues=${issues}`]
}
export function ghSearchCall(gh: string, text: string, query: ListsQuery): string[] {
  return [gh, 'api', 'graphql', '-f', `query=${SEARCH_QUERY}`, '-f', `q=${searchQuery(text, query)}`]
}
export function ghChecks(gh: string, repo: string, n: number): string[] {
  return [gh, 'pr', 'checks', String(n), '--repo', repo, '--json', CHECK_FIELDS]
}
export function ghJobLog(gh: string, repo: string, runId: number, jobId: number): string[] {
  return [gh, 'run', 'view', String(runId), '--job', String(jobId), '--log-failed', '--repo', repo]
}
export function ghThreadCall(gh: string, repo: string, n: number, kind: 'pr' | 'issue'): string[] {
  const [owner = '', name = ''] = repo.split('/')
  const query = kind === 'pr' ? PR_THREAD_QUERY : ISSUE_THREAD_QUERY

  return [gh, 'api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${n}`]
}
export function ghDiff(gh: string, repo: string, n: number): string[] {
  return [gh, 'pr', 'diff', String(n), '--repo', repo]
}
export function ghOpenPrFiles(gh: string, repo: string): string[] {
  return [gh, 'pr', 'list', '--state', 'open', '--limit', '50', '--repo', repo, '--json', 'number,title,author,headRefName,url,changedFiles,files']
}
/** The PR's head commit (the inspector's cache key for its files) and its base branch. */
export function ghPrHead(gh: string, repo: string, n: number): string[] {
  return [gh, 'pr', 'view', String(n), '--repo', repo, '--json', 'headRefOid,baseRefName']
}
/** Every file of a PR with its patch (GET; one array per page). The host flag comes right after the path, as the guard reads it. */
export function ghPrFilesCall(gh: string, repo: string, n: number, host: string = DEFAULT_HOST): string[] {
  const path = `repos/${repo}/pulls/${n}/files?per_page=100`

  return host === DEFAULT_HOST ? [gh, 'api', path, '--paginate'] : [gh, 'api', path, '--hostname', host, '--paginate']
}
export function ghPrForBranch(gh: string): string[] {
  return [gh, 'pr', 'view', '--json', 'number,url,baseRefName,headRefName,title']
}

// The adapter: what a wiring file's runner steps through.

type HealthValue = { health: GhHealth; login?: string; userId?: string; error?: string }

function ok<T>(value: T): Parsed<T> {
  return { isOk: true, value }
}

function fail<T>(error: string): Parsed<T> {
  return { isOk: false, error }
}

function one(outcome: Outcome | Outcome[]): Outcome {
  return Array.isArray(outcome) ? (outcome[0] ?? { exitCode: NOT_RUN, stdout: '', stderr: 'no outcome' }) : outcome
}

function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
}

/** What a failed run said, whole, so the wiring can tell a rate limit from a missing repo. */
function failureText(outcome: Outcome): string {
  return `${outcome.stderr}\n${outcome.stdout}`.trim() || `gh exited with code ${outcome.exitCode}`
}

function cli(argv: string[], host: string, timeoutMs?: number): Req {
  const env = host === DEFAULT_HOST ? GH_ENV : { ...GH_ENV, GH_HOST: host }

  return { kind: 'cli', tool: 'gh', argv, env, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
}

/** The repo as `gh` names it: `owner/name` on github.com, `host/owner/name` elsewhere. */
function repoArg(host: string, path: string): string {
  return host === DEFAULT_HOST ? path : `${host}/${path}`
}

interface Place {
  host: string
  path: string
  arg: string
}

function placeOf(repo: string): Place | undefined {
  const parsed = parseRepoKey(repo)

  return parsed === undefined ? undefined : { ...parsed, arg: repoArg(parsed.host, parsed.path) }
}

function placeOfRef(ref: RepoRef): Place {
  return { host: ref.host, path: ref.path, arg: repoArg(ref.host, ref.path) }
}

/** A parsed item given its host: `acme/web#7` read on github.com becomes `github.com/acme/web#7`. */
function keyItem(item: GhItem, host: string): GhItem {
  const repo = repoKeyOf(host, item.repo)

  return { ...item, provider: 'github', repo, id: itemId(repo, item.number) }
}

function keyLists(result: ListsResult, host: string): ListsResult {
  return { ...result, review: result.review.map(item => keyItem(item, host)), mine: result.mine.map(item => keyItem(item, host)), issues: result.issues.map(item => keyItem(item, host)) }
}

function queryOf(ctx: ListsCtx): { scope: GhScope; repos: string[] } {
  return { scope: ctx.scope, repos: ctx.repos.filter(ref => ref.host === ctx.host).map(ref => ref.path) }
}

function listOf(ctx: ListsCtx): { host: string } & ReturnType<typeof queryOf> {
  return { host: ctx.host, ...queryOf(ctx) }
}

/** `gh api graphql` exits 1 when the response has `errors` but still prints its `data`: parse any JSON object it printed. */
function hasGraphqlBody(outcome: Outcome): boolean {
  return outcome.exitCode === 0 || outcome.stdout.trimStart().startsWith('{')
}

function* health(host: string): Op<HealthValue> {
  const ran = one(yield cli(ghAuthStatus(GH, host), host))
  if (ran.exitCode === NOT_STARTED) {
    const why = firstLine(ran.stderr)

    return ok({ health: 'missing', ...(why ? { error: why } : {}) })
  }
  const login = /account (\S+)/.exec(`${ran.stderr}\n${ran.stdout}`)?.[1]
  if (ran.exitCode === 0) return ok({ health: 'ok', ...(login === undefined ? {} : { login }) })
  const why = firstLine(ran.stderr) || firstLine(ran.stdout) || `gh auth status exited with code ${ran.exitCode}`
  const kind = ran.exitCode === NOT_RUN ? 'network' : classifyGhFailure(`${ran.stderr}\n${ran.stdout}`, ran.exitCode)
  if (kind === 'missing') return ok({ health: 'missing', error: why })
  if (kind !== 'logged-out') return fail(why)
  // Offline, `gh auth status` calls a token it could not check invalid: GitHub itself tells the two apart.
  const probe = one(yield cli(ghViewerCall(GH, host), host))
  if (probe.exitCode === 0) return ok({ health: 'ok' })
  const probeKind = probe.exitCode === NOT_RUN ? 'network' : classifyGhFailure(`${probe.stderr}\n${probe.stdout}`, probe.exitCode)

  return probeKind === 'logged-out' ? ok({ health: 'logged-out', error: why }) : fail(firstLine(probe.stderr) || why)
}

function* repoOf(ref: RepoRef): Op<GhRepo> {
  const place = placeOfRef(ref)
  const ran = one(yield cli(ghRepoValidate(GH, place.arg), ref.host))
  if (ran.exitCode !== 0) return fail(failureText(ran))
  const parsed = parseRepoView(ran.stdout)

  return parsed.isOk ? ok({ ...parsed.value, provider: 'github', host: ref.host, path: parsed.value.nameWithOwner }) : parsed
}

function* lists(ctx: ListsCtx): Op<ListsResult> {
  const { host, ...query } = listOf(ctx)
  const ran = one(yield cli(onHost(ghListsCall(GH, query), host), host, 30_000))
  if (!hasGraphqlBody(ran)) return fail(failureText(ran))
  const parsed = parseListsResponse(ran.stdout, ctx.ticketPattern)
  if (!parsed.isOk && ran.exitCode !== 0) return fail(failureText(ran))

  return parsed.isOk ? ok(keyLists(parsed.value, host)) : parsed
}

function* search(ctx: ListsCtx, text: string): Op<GhItem[]> {
  const { host, ...query } = listOf(ctx)
  const ran = one(yield cli(onHost(ghSearchCall(GH, text, query), host), host, 30_000))
  if (!hasGraphqlBody(ran)) return fail(failureText(ran))
  const parsed = parseSearchResponse(ran.stdout, ctx.ticketPattern)
  if (!parsed.isOk && ran.exitCode !== 0) return fail(failureText(ran))

  return parsed.isOk ? ok(parsed.value.map(item => keyItem(item, ctx.host))) : parsed
}

/** The lists already carry CI and review state. */
function* details(_ctx: ListsCtx, _items: readonly GhItem[]): Op<Record<string, Partial<GhItem>>> {
  return ok({})
}

function* checks(item: GhItem): Op<GhCheck[]> {
  const place = placeOf(item.repo)
  if (place === undefined) return fail(`unreadable repo ${item.repo}`)
  const ran = one(yield cli(ghChecks(GH, place.arg, item.number), place.host, 30_000))
  // Exit 8 (pending) and 1 (failed) still carry the JSON.
  if (ran.stdout.trim() === '') return fail(failureText(ran))

  return parseChecks(ran.stdout)
}

function* failedLog(item: GhItem, check: GhCheck): Op<string> {
  const place = placeOf(item.repo)
  if (place === undefined || check.runId === undefined || check.jobId === undefined) return fail('this check has no job log')
  const ran = one(yield cli(ghJobLog(GH, place.arg, check.runId, check.jobId), place.host, 30_000))

  return ran.exitCode === 0 ? ok(ran.stdout) : fail(failureText(ran))
}

function* thread(item: GhItem): Op<FullThread> {
  const place = placeOf(item.repo)
  if (place === undefined) return fail(`unreadable repo ${item.repo}`)
  const ran = one(yield cli(onHost(ghThreadCall(GH, place.path, item.number, item.kind), place.host), place.host, 30_000))
  if (ran.exitCode !== 0) return fail(failureText(ran))

  return parseThreadResponse(ran.stdout, item.repo, item.kind)
}

function* diff(item: GhItem): Op<string> {
  const place = placeOf(item.repo)
  if (place === undefined) return fail(`unreadable repo ${item.repo}`)
  const ran = one(yield cli(ghDiff(GH, place.arg, item.number), place.host, 30_000))

  return ran.exitCode === 0 ? ok(ran.stdout) : fail(failureText(ran))
}

function* head(item: GhItem): Op<{ headSha: string; baseSha?: string; baseRef: string }> {
  const place = placeOf(item.repo)
  if (place === undefined) return fail(`unreadable repo ${item.repo}`)
  const ran = one(yield cli(ghPrHead(GH, place.arg, item.number), place.host))
  if (ran.exitCode !== 0) return fail(failureText(ran))
  const headSha = parseHeadSha(ran.stdout)
  const baseRef = parseBaseRef(ran.stdout)

  return headSha !== undefined && FULL_SHA.test(headSha) && baseRef !== undefined ? ok({ headSha, baseRef }) : fail('unexpected pull request head')
}

function* prFiles(item: GhItem): Op<PrFilesRead> {
  const place = placeOf(item.repo)
  if (place === undefined) return fail(`unreadable repo ${item.repo}`)
  const ran = one(yield cli(ghPrFilesCall(GH, place.path, item.number, place.host), place.host, 30_000))
  if (ran.exitCode !== 0) return fail(failureText(ran))
  const files = parsePrFiles(ran.stdout)

  return ok(ran.isTruncated === true ? Object.assign(files, { isPartial: true }) : files)
}

/** One call lists every open PR with its files, so the cache is not needed. */
function* openPrFiles(ref: RepoRef, _known: OverlapCache): Op<PrFiles[]> {
  const ran = one(yield cli(ghOpenPrFiles(GH, placeOfRef(ref).arg), ref.host, 30_000))
  if (ran.exitCode !== 0) return fail(failureText(ran))
  const parsed = parseOpenPrFiles(ran.stdout)
  if (!parsed.isOk || ran.isTruncated !== true) return parsed

  return ok(parsed.value.map(pr => ({ ...pr, isPartial: true })))
}

/** The PR of the checked-out branch: `gh` reads it from the working folder, so `branch` is not sent. */
function* prForBranch(ref: RepoRef, _branch: string): Op<BranchPr | undefined> {
  const ran = one(yield cli(ghPrForBranch(GH), ref.host))
  if (ran.exitCode === 0) return ok(parseBranchPr(ran.stdout))

  return classifyGhFailure(ran.stderr, ran.exitCode) === 'not-found' ? ok(undefined) : fail(failureText(ran))
}

function* recentRepos(host: string): Op<string[]> {
  const ran = one(yield cli(ghRecentRepos(GH, host), host))
  if (ran.exitCode !== 0) return fail(failureText(ran))

  return ok(parseRecentRepos(ran.stdout).map(name => repoKeyOf(host, name)))
}

function* searchRepos(host: string, text: string): Op<string[]> {
  const ran = one(yield cli(ghSearchRepos(GH, text), host))
  if (ran.exitCode !== 0) return fail(failureText(ran))

  return ok(parseSearchRepos(ran.stdout).map(name => repoKeyOf(host, name)))
}

/** The item's PR number, from its id; the number field when the id does not read. */
function checkoutCommand(item: GhItem): string | undefined {
  return item.kind === 'pr' ? `! gh pr checkout ${parseItemId(item.id)?.number ?? item.number}` : undefined
}

export const githubAdapter: ProviderAdapter = {
  id: 'github',
  caps: {
    issues: true,
    failedLogs: true,
    checkoutCommand,
    vocab: { noun: 'pull request', short: 'PR', sigil: '#' },
    templatePaths: ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'pull_request_template.md']
  },
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
