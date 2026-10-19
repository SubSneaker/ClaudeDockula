// The Bitbucket Cloud adapter: REST GETs on api.bitbucket.org, folded into the panel's shapes. Pure: it only
// yields requests; the wiring file runs them, adds the token header and feeds each outcome back in.
import type { GhCheck, GhItem, GhRepo, GhHealth } from '../../../../types'
import { repoKeyOf } from '../ids'
import type { FullThread, ListsResult, Parsed, PrFiles } from '../parse'
import {
  bodyOf, ciOfChecks, isSuccess, enc, foldParticipants, isFullHash, isNearRateLimit, isReviewPendingFor, isShortHash, parseBitbucketThread, parseCommitHash, parseDiffstat,
  parseOverlapRows, parsePrSelf, parsePullRequests, parseRepo, parseRepoNames, parseRevParse, parseStatuses, parseUser, parseWorkspaces, repoPathOfKey, splitUnifiedDiff,
  toPrFiles, classifyBitbucketFailure, failureMessage, type BitbucketOutcome, type BitbucketPr, type OverlapRow
} from './bitbucketParse'
import type { BranchPr, ListsCtx, Op, Outcome, OverlapCache, PrFilesRead, ProviderAdapter, ProviderCaps, RepoRef, Req } from './types'

export const BITBUCKET_API_HOST = 'api.bitbucket.org'
const API = `https://${BITBUCKET_API_HOST}/2.0`

/** Regex source for each `{placeholder}` in a read template; each matches one path segment. */
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  ws: '[A-Za-z0-9._~-]+',
  slug: '[A-Za-z0-9._~-]+',
  id: '[0-9]+',
  uuid: '(?:%7B|\\{)[0-9A-Fa-f-]+(?:%7D|\\})',
  hash: '[0-9a-f]{7,64}',
  a: '[0-9a-f]{7,64}',
  b: '[0-9a-f]{7,64}'
}

const NUMBER = '[0-9]{1,4}'
/** A value the adapter has percent-encoded with `enc`. */
const ENCODED = '(?:[A-Za-z0-9_.~-]|%[0-9A-Fa-f]{2}){1,600}'

/** One allowed GET, compiled for the read-only guard. */
export interface BitbucketRead {
  /** Matches the path without its leading slash and `2.0/` prefix. */
  path: RegExp
  /** The query keys allowed, each with an anchored value check. */
  query: Readonly<Record<string, RegExp>>
}

const LIST_QUERY = { pagelen: NUMBER, page: NUMBER, fields: ENCODED, q: ENCODED, sort: ENCODED }

function read(template: string, query: Readonly<Record<string, string>>): BitbucketRead {
  const source = template
    .replace(/^\/2\.0\//, '')
    .split('/')
    .map(segment =>
      segment
        .split(/(\{\w+\})/)
        .map(part => (/^\{\w+\}$/.test(part) ? (PLACEHOLDERS[part.slice(1, -1)] ?? 'x^') : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('')
    )
    .join('/')

  return {
    path: new RegExp(`^${source}$`),
    query: Object.fromEntries(Object.entries(query).map(([key, value]) => [key, new RegExp(`^(?:${value})$`)]))
  }
}

/** Every request the adapter makes, as data: all GETs. The read-only guard allows nothing outside this table. */
export const BITBUCKET_READS: readonly BitbucketRead[] = [
  read('/2.0/user', {}),
  read('/2.0/user/workspaces', { pagelen: NUMBER, page: NUMBER }),
  read('/2.0/repositories/{ws}', { role: 'member', ...LIST_QUERY }),
  read('/2.0/repositories/{ws}/{slug}', { fields: ENCODED }),
  read('/2.0/repositories/{ws}/{slug}/pullrequests', { state: 'OPEN', ...LIST_QUERY }),
  read('/2.0/workspaces/{ws}/pullrequests/{uuid}', { state: 'OPEN', ...LIST_QUERY }),
  read('/2.0/repositories/{ws}/{slug}/pullrequests/{id}', { fields: ENCODED }),
  read('/2.0/repositories/{ws}/{slug}/pullrequests/{id}/comments', LIST_QUERY),
  read('/2.0/repositories/{ws}/{slug}/pullrequests/{id}/statuses', LIST_QUERY),
  read('/2.0/repositories/{ws}/{slug}/pullrequests/{id}/activity', LIST_QUERY),
  // A fork PR's commits are not on the destination repo, so its diff is read through the PR (documented 302 to the repo diff).
  read('/2.0/repositories/{ws}/{slug}/pullrequests/{id}/diff', {}),
  read('/2.0/repositories/{ws}/{slug}/pullrequests/{id}/diffstat', { pagelen: NUMBER, page: NUMBER }),
  read('/2.0/repositories/{ws}/{slug}/diff/{a}..{b}', { topic: 'true', path: ENCODED }),
  read('/2.0/repositories/{ws}/{slug}/diffstat/{a}..{b}', { topic: 'true', pagelen: NUMBER, page: NUMBER }),
  read('/2.0/repositories/{ws}/{slug}/commit/{hash}', { fields: ENCODED })
]

const REVIEW_CAP = 20
const DETAILS_CAP = 8
const OVERLAP_CAP = 20
const PAGE_LEN = 50
const RECENT_WORKSPACES = 3
const NEAR_LIMIT_PAUSE_MS = 5 * 60 * 1000
const BRANCH = /^[\w./-]+$/
const PARTICIPANTS = '%2Bvalues.participants'
const OVERLAP_FIELDS = enc('next,values.id,values.title,values.updated_on,values.author.nickname,values.author.display_name,values.links.html.href,values.source.branch.name,values.source.commit.hash,values.destination.commit.hash,values.source.repository.full_name,values.destination.repository.full_name')
const GIT_OUTCOME_MISSING: Outcome = { exitCode: -1, stdout: '', stderr: '' }

type Query = readonly (readonly [string, string])[]

function get(path: string, query: Query = [], accept: 'json' | 'text' = 'json'): Req {
  const search = query.map(([key, value]) => `${key}=${value}`).join('&')

  return { kind: 'http', method: 'GET', url: `${API}${path}${search === '' ? '' : `?${search}`}`, needsToken: true, accept }
}

function repoPath(path: string): string {
  return path
    .split('/')
    .map(enc)
    .join('/')
}

function prPath(repoKeyPath: string, id: number | string): string {
  return `/repositories/${repoPath(repoKeyPath)}/pullrequests/${id}`
}

function one(outcome: Outcome | Outcome[]): Outcome {
  return Array.isArray(outcome) ? (outcome[0] ?? GIT_OUTCOME_MISSING) : outcome
}

function many(outcome: Outcome | Outcome[]): Outcome[] {
  return Array.isArray(outcome) ? outcome : [outcome]
}

function failed<T>(error: string): Parsed<T> {
  return { isOk: false, error }
}

function withStatus(outcome: Outcome): BitbucketOutcome {
  return outcome
}

/** The first auth or rate failure among the outcomes: it stops a whole list, where a missing repo does not. */
function blockingFailure(outcomes: readonly Outcome[]): string | undefined {
  const blocked = outcomes.find(outcome => {
    const kind = classifyBitbucketFailure(outcome)

    return kind === 'unauthorized' || kind === 'forbidden' || kind === 'rate-limited'
  })

  return blocked === undefined ? undefined : failureMessage(withStatus(blocked))
}

function bitbucketRepos(repos: readonly RepoRef[]): RepoRef[] {
  return repos.filter(repo => repo.provider === 'bitbucket')
}

/** A user's PRs from several list outcomes, de-duplicated by item id. */
function uniqueById(prs: readonly BitbucketPr[]): BitbucketPr[] {
  const seen = new Set<string>()

  return prs.filter(pr => {
    if (seen.has(pr.item.id)) return false
    seen.add(pr.item.id)

    return true
  })
}

function parseLists(outcomes: readonly Outcome[], host: string, repoPaths: readonly (string | undefined)[], ticketPattern: string | undefined): BitbucketPr[] {
  return outcomes.flatMap((outcome, at) => {
    const parsed = outcome.exitCode === 0 && (outcome.status ?? 200) < 300 ? parsePullRequests(outcome.stdout, host, repoPaths[at], ticketPattern) : undefined

    return parsed?.isOk === true ? parsed.value : []
  })
}

function pauseFor(outcomes: readonly Outcome[]): Pick<ListsResult, 'rateRemaining' | 'rateResetAt'> {
  if (!outcomes.some(outcome => isNearRateLimit(withStatus(outcome)))) return {}

  return { rateRemaining: 0, rateResetAt: new Date(Date.now() + NEAR_LIMIT_PAUSE_MS).toISOString() }
}

function* lists(ctx: ListsCtx): Op<ListsResult> {
  const [userOut, workspacesOut] = many(yield [get('/user'), get('/user/workspaces', [['pagelen', '100']])])
  const user = parseUser(userOut?.stdout ?? '')
  const workspaces = parseWorkspaces(workspacesOut?.stdout ?? '')

  if (userOut === undefined || workspacesOut === undefined) return failed('no response')
  if (!isSuccess(withStatus(userOut))) return failed(failureMessage(withStatus(userOut)))
  if (!isSuccess(withStatus(workspacesOut))) return failed(failureMessage(withStatus(workspacesOut)))
  if (!user.isOk) return user
  if (!workspaces.isOk) return workspaces

  const followed = bitbucketRepos(ctx.repos)
  const followedKeys = new Set(followed.map(repo => `${repo.host}/${repo.path}`))
  const mineSpaces = ctx.scope === 'all' ? workspaces.value : [...new Set(followed.map(repo => repo.path.split('/')[0] ?? ''))].filter(slug => slug !== '')
  const uuid = enc(user.value.uuid)
  const reviewReqs = followed.map(repo => get(`/repositories/${repoPath(repo.path)}/pullrequests`, [['state', 'OPEN'], ['pagelen', String(PAGE_LEN)], ['sort', enc('-updated_on')], ['fields', PARTICIPANTS]]))
  const mineReqs = mineSpaces.map(space => get(`/workspaces/${enc(space)}/pullrequests/${uuid}`, [['state', 'OPEN'], ['pagelen', String(PAGE_LEN)], ['sort', enc('-updated_on')], ['fields', PARTICIPANTS]]))
  const outcomes = many(yield [...reviewReqs, ...mineReqs])
  const blocked = blockingFailure(outcomes)

  if (blocked !== undefined) return failed(blocked)
  if (outcomes.length > 0 && outcomes.every(outcome => outcome.exitCode !== 0 || (outcome.status ?? 200) >= 300)) return failed(failureMessage(withStatus(outcomes[0] ?? GIT_OUTCOME_MISSING)))

  const reviewOutcomes = outcomes.slice(0, followed.length)
  const mineOutcomes = outcomes.slice(followed.length)
  const candidates = parseLists(reviewOutcomes, ctx.host, followed.map(repo => repo.path), ctx.ticketPattern).filter(pr => pr.authorUuid !== user.value.uuid)
  const review = yield* withReviewers(candidates, user.value.uuid)
  const mine = parseLists(mineOutcomes, ctx.host, mineSpaces.map(() => undefined), ctx.ticketPattern)
  const mineItems = uniqueById(mine.filter(pr => ctx.scope === 'all' || followedKeys.has(pr.item.repo))).map(pr => pr.item)

  return { isOk: true, value: { login: user.value.login, review, mine: mineItems, issues: [], ...pauseFor(outcomes) } }
}

/** Review requests of this person: rows whose list lacked participants get one fetch of their own first. */
function* withReviewers(candidates: readonly BitbucketPr[], uuid: string): Generator<Req[], GhItem[], Outcome | Outcome[]> {
  const missing = candidates.filter(pr => pr.participants === undefined).slice(0, REVIEW_CAP)
  const fetched = missing.length === 0 ? [] : many(yield missing.map(pr => get(prPath(repoPathOfKey(pr.item.repo), pr.item.number))))
  const filled = new Map<string, BitbucketPr['participants']>()

  missing.forEach((pr, at) => {
    const self = parsePrSelf(fetched[at]?.stdout ?? '')

    if (self.isOk) filled.set(pr.item.id, self.value.participants)
  })

  return candidates.flatMap(pr => {
    const participants = pr.participants ?? filled.get(pr.item.id)

    if (participants === undefined || !isReviewPendingFor(participants, uuid)) return []

    const folded = foldParticipants(participants)
    const item: GhItem = { ...pr.item, review: folded.review }

    if (folded.approvalId !== undefined) item.approvalId = folded.approvalId
    if (folded.changeRequestId !== undefined) item.changeRequestId = folded.changeRequestId

    return [item]
  })
}

function* search(ctx: ListsCtx, text: string): Op<GhItem[]> {
  const needle = text.replace(/["\\]/g, ' ').trim()
  const followed = bitbucketRepos(ctx.repos)

  if (needle === '' || followed.length === 0) return { isOk: true, value: [] }

  const q = enc(`title ~ "${needle}"`)
  const outcomes = many(yield followed.map(repo => get(`/repositories/${repoPath(repo.path)}/pullrequests`, [['state', 'OPEN'], ['q', q], ['pagelen', '20'], ['fields', PARTICIPANTS]])))
  const blocked = blockingFailure(outcomes)

  if (blocked !== undefined) return failed(blocked)

  return { isOk: true, value: parseLists(outcomes, ctx.host, followed.map(repo => repo.path), ctx.ticketPattern).map(pr => pr.item) }
}

function* details(_ctx: ListsCtx, items: readonly GhItem[]): Op<Record<string, Partial<GhItem>>> {
  const shown = items.filter(item => item.kind === 'pr').slice(0, DETAILS_CAP)
  const reqs = shown.flatMap(item => {
    const path = prPath(repoPathOfKey(item.repo), item.number)
    const statuses = get(`${path}/statuses`, [['pagelen', '50']])

    return item.review === undefined ? [statuses, get(path)] : [statuses]
  })

  if (reqs.length === 0) return { isOk: true, value: {} }

  const outcomes = many(yield reqs)
  const blocked = blockingFailure(outcomes)

  if (blocked !== undefined) return failed(blocked)

  const result: Record<string, Partial<GhItem>> = {}
  let at = 0

  for (const item of shown) {
    const statuses = parseStatuses(outcomes[at]?.stdout ?? '')
    const self = item.review === undefined ? parsePrSelf(outcomes[at + 1]?.stdout ?? '') : undefined
    const patch: Partial<GhItem> = {}

    at += item.review === undefined ? 2 : 1
    if (statuses.isOk) patch.ci = ciOfChecks(statuses.value)
    if (self?.isOk === true && self.value.participants !== undefined) {
      const folded = foldParticipants(self.value.participants)

      patch.review = folded.review
      if (folded.approvalId !== undefined) patch.approvalId = folded.approvalId
      if (folded.changeRequestId !== undefined) patch.changeRequestId = folded.changeRequestId
    }
    if (Object.keys(patch).length > 0) result[item.id] = patch
  }

  return { isOk: true, value: result }
}

function* checks(item: GhItem): Op<GhCheck[]> {
  const outcome = one(yield get(`${prPath(repoPathOfKey(item.repo), item.number)}/statuses`, [['pagelen', '100']]))
  const body = bodyOf(withStatus(outcome))

  return body.isOk ? parseStatuses(body.value) : body
}

function* failedLog(): Op<string> {
  return failed('Bitbucket step logs are not available: open the pipeline in Bitbucket.')
}

function* thread(item: GhItem): Op<FullThread> {
  const path = prPath(repoPathOfKey(item.repo), item.number)
  const [selfOut, commentsOut] = many(yield [get(path), get(`${path}/comments`, [['pagelen', '100']])])

  if (selfOut === undefined) return failed('no response')

  const self = bodyOf(withStatus(selfOut))

  if (!self.isOk) return self

  return parseBitbucketThread(self.value, commentsOut !== undefined && bodyOf(withStatus(commentsOut)).isOk ? commentsOut.stdout : '', item.repo, item.number)
}

/** A short commit hash made full: the local clone first (read-only), then the commit endpoint. */
function* resolveHashes(requests: readonly { fullName: string; short: string }[]): Generator<Req[], (string | undefined)[], Outcome | Outcome[]> {
  const needed = requests.map(({ short }) => (isShortHash(short) ? short : undefined))
  const gitReqs = needed.flatMap((short): Req[] => (short === undefined ? [] : [{ kind: 'git', argv: ['git', '--no-optional-locks', 'rev-parse', '--verify', '--quiet', `${short}^{commit}`] }]))
  const gitOuts = gitReqs.length === 0 ? [] : many(yield gitReqs)
  const resolved = requests.map(({ short }) => (isFullHash(short) ? short : undefined))
  let gitAt = 0

  needed.forEach((short, at) => {
    if (short === undefined) return

    const out = gitOuts[gitAt]

    gitAt += 1
    if (out?.exitCode === 0) resolved[at] = parseRevParse(out.stdout)
  })

  const missing = requests.flatMap((request, at) => (resolved[at] === undefined ? [{ at, request }] : []))

  if (missing.length === 0) return resolved

  const outs = many(yield missing.map(({ request }) => get(`/repositories/${repoPath(request.fullName)}/commit/${request.short}`, [['fields', 'hash']])))

  missing.forEach(({ at }, index) => {
    const out = outs[index]

    if (out !== undefined && out.exitCode === 0 && (out.status ?? 200) < 300) resolved[at] = parseCommitHash(out.stdout)
  })

  return resolved
}

function* head(item: GhItem): Op<{ headSha: string; baseSha?: string; baseRef: string }> {
  const selfOut = one(yield get(prPath(repoPathOfKey(item.repo), item.number)))
  const body = bodyOf(withStatus(selfOut))

  if (!body.isOk) return body

  const self = parsePrSelf(body.value)

  if (!self.isOk) return self
  if (self.value.headShort === undefined) return failed('unexpected pull request response')

  const base = self.value.baseShort
  const baseFull = self.value.baseRepo ?? repoPathOfKey(item.repo)
  const wanted = [{ fullName: self.value.headRepo ?? repoPathOfKey(item.repo), short: self.value.headShort }, ...(base === undefined ? [] : [{ fullName: baseFull, short: base }])]
  const [headSha, baseSha] = yield* resolveHashes(wanted)
  const baseRef = self.value.baseRef ?? item.baseRef

  if (headSha === undefined) return failed('Could not resolve the PR head commit: fetch the branch locally and try again.')
  if (baseRef === undefined) return failed('unexpected pull request response')

  return { isOk: true, value: baseSha === undefined ? { headSha, baseRef } : { headSha, baseSha, baseRef } }
}

/** The PR's head lives in another repository. */
function isForkPr(headRepo: string | undefined, baseRepo: string | undefined): boolean {
  return headRepo !== undefined && baseRepo !== undefined && headRepo !== baseRepo
}

interface DiffText {
  text: string
  isTruncated: boolean
}

function diffTextOf(out: Outcome): Parsed<DiffText> {
  const body = bodyOf(withStatus(out))

  return body.isOk ? { isOk: true, value: { text: body.value, isTruncated: out.isTruncated === true } } : body
}

function* diffRead(item: GhItem): Generator<Req | Req[], Parsed<DiffText>, Outcome | Outcome[]> {
  const selfOut = one(yield get(prPath(repoPathOfKey(item.repo), item.number)))
  const body = bodyOf(withStatus(selfOut))

  if (!body.isOk) return body

  const self = parsePrSelf(body.value)

  if (!self.isOk) return self
  if (self.value.headShort === undefined || self.value.baseShort === undefined) return failed('unexpected pull request response')
  if (isForkPr(self.value.headRepo, self.value.baseRepo)) return diffTextOf(one(yield get(`${prPath(repoPathOfKey(item.repo), item.number)}/diff`, [], 'text')))

  const fullName = self.value.headRepo ?? repoPathOfKey(item.repo)
  const [headFull, baseFull] = yield* resolveHashes([{ fullName, short: self.value.headShort }, { fullName: self.value.baseRepo ?? fullName, short: self.value.baseShort }])
  const out = one(yield get(`/repositories/${repoPath(repoPathOfKey(item.repo))}/diff/${headFull ?? self.value.headShort}..${baseFull ?? self.value.baseShort}`, [['topic', 'true']], 'text'))

  return diffTextOf(out)
}

function* diff(item: GhItem): Op<string> {
  const read = yield* diffRead(item)

  return read.isOk ? { isOk: true, value: read.value.text } : read
}

function* prFiles(item: GhItem): Op<PrFilesRead> {
  const read = yield* diffRead(item)
  if (!read.isOk) return read
  const files = splitUnifiedDiff(read.value.text)

  return { isOk: true, value: read.value.isTruncated ? Object.assign(files, { isPartial: true }) : files }
}

/** The PR's changed paths: by commits on the destination repo, or through the PR when its head is in a fork. */
function diffstatReq(ref: RepoRef, row: OverlapRow): Req {
  if (row.isFork === true) return get(`${prPath(ref.path, row.number)}/diffstat`, [['pagelen', '100']])

  return get(`/repositories/${repoPath(ref.path)}/diffstat/${row.headShort}..${row.baseShort}`, [['topic', 'true'], ['pagelen', '100']])
}

function* openPrFiles(ref: RepoRef, known: OverlapCache): Op<PrFiles[]> {
  const repoKey = `${ref.host}/${ref.path}`
  const listOut = one(yield get(`/repositories/${repoPath(ref.path)}/pullrequests`, [['state', 'OPEN'], ['sort', enc('-updated_on')], ['pagelen', String(OVERLAP_CAP)], ['fields', OVERLAP_FIELDS]]))
  const body = bodyOf(withStatus(listOut))

  if (!body.isOk) return body

  const rows = parseOverlapRows(body.value)

  if (!rows.isOk) return rows

  const capped = rows.value.slice(0, OVERLAP_CAP)
  const isFresh = (row: OverlapRow): boolean => known[`${repoKey}#${row.number}`]?.headSha === row.headShort
  const stale = capped.filter(row => !isFresh(row))
  const outs = stale.length === 0 ? [] : many(yield stale.map(row => diffstatReq(ref, row)))
  const blocked = blockingFailure(outs)

  if (blocked !== undefined) return failed(blocked)

  const prs = capped.flatMap((row): PrFiles[] => {
    if (isFresh(row)) return [toPrFiles(row, known[`${repoKey}#${row.number}`]?.files ?? [], false)]

    const out = outs[stale.indexOf(row)]
    const stat = out === undefined ? undefined : parseDiffstat(out.stdout)

    return stat?.isOk === true && out !== undefined && (out.status ?? 200) < 300 ? [toPrFiles(row, stat.value.files, stat.value.isPartial || out.isTruncated === true)] : []
  })

  return { isOk: true, value: prs }
}

function* prForBranch(ref: RepoRef, branch: string): Op<BranchPr | undefined> {
  if (!BRANCH.test(branch) || branch.startsWith('-')) return { isOk: true, value: undefined }

  const q = enc(`source.branch.name = "${branch}"`)
  const out = one(yield get(`/repositories/${repoPath(ref.path)}/pullrequests`, [['state', 'OPEN'], ['q', q], ['pagelen', '1']]))
  const body = bodyOf(withStatus(out))

  if (!body.isOk) return body

  const parsed = parsePullRequests(body.value, ref.host, ref.path)

  if (!parsed.isOk) return parsed

  const [first] = parsed.value
  const found: BranchPr | undefined = first?.item.baseRef === undefined ? undefined : { number: first.item.number, url: first.item.url, baseRef: first.item.baseRef, title: first.item.title }

  return { isOk: true, value: found }
}

function* health(_host: string): Op<{ health: GhHealth; login?: string; userId?: string; error?: string }> {
  const out = one(yield get('/user'))
  const kind = classifyBitbucketFailure(withStatus(out))

  if (out.exitCode === 0 && (out.status ?? 200) < 300) {
    const user = parseUser(out.stdout)

    return user.isOk ? { isOk: true, value: { health: 'ok', login: user.value.login, userId: user.value.uuid } } : { isOk: true, value: { health: 'logged-out', error: user.error } }
  }
  if (kind === 'rate-limited') return { isOk: true, value: { health: 'ok', error: failureMessage(withStatus(out)) } }
  if (kind === 'unauthorized' || kind === 'forbidden') return { isOk: true, value: { health: 'logged-out', error: failureMessage(withStatus(out)) } }
  if (/no token/i.test(out.stderr)) return { isOk: true, value: { health: 'logged-out', error: 'No Bitbucket token found. Set one up in GitGud settings.' } }

  return failed(failureMessage(withStatus(out)))
}

function* repoOf(ref: RepoRef): Op<GhRepo> {
  const out = one(yield get(`/repositories/${repoPath(ref.path)}`, [['fields', enc('full_name,links.html.href,mainbranch.name')]]))
  const body = bodyOf(withStatus(out))

  return body.isOk ? parseRepo(body.value) : body
}

function* workspaceSlugs(limit: number): Generator<Req, Parsed<string[]>, Outcome | Outcome[]> {
  const out = one(yield get('/user/workspaces', [['pagelen', '100']]))
  const body = bodyOf(withStatus(out))
  const slugs = body.isOk ? parseWorkspaces(body.value) : body

  return slugs.isOk ? { isOk: true, value: slugs.value.slice(0, limit) } : slugs
}

function* recentRepos(host: string): Op<string[]> {
  const spaces = yield* workspaceSlugs(RECENT_WORKSPACES)

  if (!spaces.isOk) return spaces

  const outs = spaces.value.length === 0 ? [] : many(yield spaces.value.map(space => get(`/repositories/${enc(space)}`, [['role', 'member'], ['sort', enc('-updated_on')], ['pagelen', '10']])))

  return { isOk: true, value: outs.flatMap(out => (out.exitCode === 0 && (out.status ?? 200) < 300 ? parseRepoNames(out.stdout) : [])).slice(0, 10).map(name => repoKeyOf(host, name)) }
}

function* searchRepos(host: string, text: string): Op<string[]> {
  const needle = text.replace(/["\\]/g, ' ').trim()

  if (needle === '') return { isOk: true, value: [] }

  const spaces = yield* workspaceSlugs(RECENT_WORKSPACES)

  if (!spaces.isOk) return spaces

  const q = enc(`name ~ "${needle}"`)
  const outs = spaces.value.length === 0 ? [] : many(yield spaces.value.map(space => get(`/repositories/${enc(space)}`, [['role', 'member'], ['q', q], ['pagelen', '4']])))

  return { isOk: true, value: outs.flatMap(out => (out.exitCode === 0 && (out.status ?? 200) < 300 ? parseRepoNames(out.stdout) : [])).slice(0, 4).map(name => repoKeyOf(host, name)) }
}

function checkoutCommand(item: GhItem): string | undefined {
  const branch = item.headRef

  if (item.kind !== 'pr' || branch === undefined || !BRANCH.test(branch) || branch.startsWith('-')) return undefined

  return `! git fetch origin ${branch} && git switch ${branch}`
}

const caps: ProviderCaps = {
  issues: false,
  failedLogs: false,
  checkoutCommand,
  vocab: { noun: 'pull request', short: 'PR', sigil: '#' },
  templatePaths: []
}

export const bitbucketAdapter: ProviderAdapter = {
  id: 'bitbucket',
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
