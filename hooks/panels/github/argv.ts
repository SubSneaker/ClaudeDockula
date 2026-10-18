import type { GhScope } from '../../../types'
import { isRecord } from '../jira/parse'
import { LIST_LIMIT } from './model'
import {
  COPY_EXCLUDES,
  EMPTY_TREE,
  FILTER_NAME,
  REVIEW_DIR_NAME,
  REVIEW_MAX_TURNS,
  REVIEW_MODELS,
  REVIEW_TOOLS,
  SECRET_DENY_RULES,
  WEB_TOOLS,
  isBorrowableAllow,
  isCommitSha,
  relayCommand,
  relayPathOf
} from './review'

export const GH_ENV: Record<string, string> = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
  CLICOLOR: '0',
  GH_PAGER: 'cat',
  PAGER: 'cat'
}
/** Executables tried in order when `gh` is not on PATH. */
export const GH_CANDIDATES: readonly string[] = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']

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

export function ghAuthStatus(gh: string): string[] {
  return [gh, 'auth', 'status', '--hostname', 'github.com']
}
/** The cheapest call that needs both the network and a valid token: tells offline from signed out. */
export function ghViewerCall(gh: string): string[] {
  return [gh, 'api', 'graphql', '-f', 'query=query { viewer { login } }']
}
export function ghRepoView(gh: string): string[] {
  return [gh, 'repo', 'view', '--json', REPO_FIELDS]
}
export function ghRepoValidate(gh: string, repo: string): string[] {
  return [gh, 'repo', 'view', repo, '--json', REPO_FIELDS]
}
export function ghRecentRepos(gh: string): string[] {
  return [gh, 'api', 'graphql', '-f', `query=${RECENT_REPOS_QUERY}`]
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
/** Every file of a PR with its patch (GET; one array per page). */
export function ghPrFilesCall(gh: string, repo: string, n: number): string[] {
  return [gh, 'api', `repos/${repo}/pulls/${n}/files?per_page=100`, '--paginate']
}
export function ghPrForBranch(gh: string): string[] {
  return [gh, 'pr', 'view', '--json', 'number,url,baseRefName,headRefName,title']
}

// git, always `git --no-optional-locks …`
export const GIT_BRANCH: string[] = ['git', '--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD']
export const GIT_TOPLEVEL: string[] = ['git', '--no-optional-locks', 'rev-parse', '--show-toplevel']
export const GIT_STATUS_PORCELAIN: string[] = ['git', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']
export function gitMergeBase(base: string): string[] {
  return ['git', '--no-optional-locks', 'merge-base', 'HEAD', `origin/${base}`]
}
export function gitChangedSince(mergeBase: string): string[] {
  return ['git', '--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', mergeBase, 'HEAD']
}
/** The commit two refs share. */
export function gitMergeBaseOf(a: string, b: string): string[] {
  return ['git', '--no-optional-locks', 'merge-base', a, b]
}
/** One path, named from the repo root and taken literally. */
function topPath(path: string): string {
  return `:(top,literal)${path}`
}
/** Whether one file is the same at two commits: exit 0 when it is. */
export function gitSameAt(a: string, b: string, path: string): string[] {
  return ['git', '--no-optional-locks', 'diff', '--quiet', '--no-ext-diff', '--no-textconv', a, b, '--', topPath(path)]
}
/** One file's working tree (uncommitted included) against a commit. */
export function gitDiffPath(mergeBase: string, path: string): string[] {
  return ['git', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', mergeBase, '--', topPath(path)]
}
/** One file's status: `?? path` when it is untracked. */
export function gitStatusPath(path: string): string[] {
  return [...GIT_STATUS_PORCELAIN, '--', topPath(path)]
}
export function gitLogSince(mergeBase: string): string[] {
  return ['git', '--no-optional-locks', 'log', '--no-merges', '--format=%h%x09%s', `${mergeBase}..HEAD`]
}
export function gitDiffStat(mergeBase: string): string[] {
  return ['git', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--stat', mergeBase, 'HEAD']
}
export function gitDiff(mergeBase: string): string[] {
  return ['git', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', mergeBase, 'HEAD', '--', '.', ':(exclude)*.lock', ':(exclude)pnpm-lock.yaml', ':(exclude)package-lock.json']
}

// The background review's clean copy: read from the local repo into the review's own folder, never a checkout.
export const GIT_VERSION: string[] = ['git', '--version']
/** The filter drivers the person's git config defines, which the copy switches off. */
export const GIT_FILTER_DRIVERS: string[] = ['git', '--no-optional-locks', 'config', '--null', '--get-regexp', '^filter\\.']
/** Exit 0 when the commit is on this machine. */
export function gitHasCommit(sha: string): string[] {
  return ['git', '--no-optional-locks', 'cat-file', '-e', `${sha}^{commit}`]
}
/**
 * The commit's files as stored, as a tar outside the repo, each under `tree/`: no attributes from the commit's own
 * `.gitattributes` (`--attr-source` the empty tree), and every filter driver of the person's config left with no
 * program and not required, so git passes the content through as stored (no git-crypt decryption, no git-lfs download).
 */
export function gitArchive(sha: string, tarPath: string, filterDrivers: readonly string[]): string[] {
  const offs = filterDrivers.flatMap(name => ['-c', `filter.${name}.process=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.required=false`])

  return ['git', '--no-optional-locks', `--attr-source=${EMPTY_TREE}`, ...offs, 'archive', '--format=tar', '--prefix=tree/', '-o', tarPath, sha]
}
/** The tar unpacked beside it, without Claude Code's project config and git hook folders. */
export function tarExtract(tarPath: string, dir: string): string[] {
  return ['tar', '-xf', tarPath, '-C', dir, ...COPY_EXCLUDES.flatMap(pattern => ['--exclude', pattern])]
}
/** A finished review's folder, gone. */
export function removeReviewDir(dir: string): string[] {
  return ['rm', '-rf', dir]
}

export interface ArgvGuardOptions {
  /** The panel's doc folder (`docDirOf`): an opener may open a file under it. */
  docDir?: string
  /** The background reviews' temporary root (`reviewsRootOf`): the copy, the reviewer and the cleanup stay in it. */
  reviewRoot?: string
  /** The plugin's own folder: the reviewer's one hook is the relay script there. */
  pluginRoot?: string
  /** The folders the reviewer may read besides its copy (the person's skill folders): its only `--add-dir`s. */
  readDirs?: readonly string[]
}

const GH_SUBCOMMANDS: Record<string, readonly string[]> = {
  auth: ['status'],
  repo: ['view'],
  search: ['repos'],
  pr: ['checks', 'diff', 'view', 'list'],
  run: ['view'],
  api: ['graphql']
}
/** The one REST path `gh api` may GET: a PR's files. */
const PR_FILES_PATH = /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/files(\?per_page=100)?$/
const GH_REFUSED = new Set([
  'checkout', 'merge', 'create', 'edit', 'close', 'reopen', 'comment', 'review', 'ready', 'delete', 'lock',
  'rerun', 'cancel', 'watch', 'sync', 'fork', 'clone', 'set-default', 'login', 'logout', 'refresh'
])
const GH_REFUSED_FLAGS = new Set(['--watch', '--web', '-w', '-X', '--method', '--input', '--hostname-override'])
const GIT_SUBCOMMANDS = new Set(['status', 'rev-parse', 'merge-base', 'diff', 'log', 'symbolic-ref'])
const GIT_REFUSED_FLAGS = ['--output', '-o', '--ext-diff', '--textconv', '--no-index']
/** `git symbolic-ref` reads only with one name and these flags; a second name, `-d` or `-m` writes. */
const SYMBOLIC_REF_READ_FLAGS = new Set(['-q', '--quiet', '--short', '--no-recurse'])
const QUERY_START = /^\s*(query\b|\{)/
const MUTATION_WORD = /\bmutation\b/i
const OPEN_TARGET_REFUSED = /[\s"<>^|]/

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? ''
}

function isRefusedFlag(token: string, refused: readonly string[] | ReadonlySet<string>): boolean {
  const flag = token.split('=')[0] ?? token
  const list = Array.isArray(refused) ? refused : [...refused]

  return list.includes(flag) || (token.startsWith('-X') && token.length > 2 && list.includes('-X'))
}

function isReadOnlyGraphql(args: readonly string[]): boolean {
  const queries: string[] = []

  for (let at = 0; at < args.length; at += 1) {
    const token = args[at] ?? ''
    const next = args[at + 1]

    if (token === '-F' || token === '--field') {
      if (next === undefined || next.startsWith('query=') || next.includes('=@')) return false
    }
    if ((token === '-f' || token === '--raw-field') && next?.startsWith('query=')) queries.push(next.slice('query='.length))
    if (token.startsWith('query=') && args[at - 1] !== '-f' && args[at - 1] !== '--raw-field') return false
  }

  const [query] = queries

  return queries.length === 1 && query !== undefined && QUERY_START.test(query) && !MUTATION_WORD.test(query)
}

/** `gh api repos/o/r/pulls/<n>/files[?per_page=100] [--paginate]`, nothing more: a GET with no field, header or method. */
function isPrFilesRead(argv: readonly string[]): boolean {
  const [, , path = '', ...rest] = argv
  const segments = path.split('?')[0]?.split('/') ?? []

  return PR_FILES_PATH.test(path) && !segments.some(part => /^\.+$/.test(part)) && rest.every(token => token === '--paginate') && rest.length <= 1
}

function isAllowedGh(argv: readonly string[]): boolean {
  const [, group = '', action = ''] = argv
  if (group === 'api' && action !== 'graphql') return isPrFilesRead(argv)
  const actions = GH_SUBCOMMANDS[group]

  if (actions === undefined || !actions.includes(action)) return false
  if (GH_REFUSED.has(group) || GH_REFUSED.has(action)) return false
  if (argv.slice(3).some(token => isRefusedFlag(token, GH_REFUSED_FLAGS))) return false

  return group === 'api' ? isReadOnlyGraphql(argv.slice(3)) : true
}

function isSymbolicRefRead(args: readonly string[]): boolean {
  const names = args.filter(token => !token.startsWith('-'))

  return names.length === 1 && args.every(token => !token.startsWith('-') || SYMBOLIC_REF_READ_FLAGS.has(token))
}

function isAllowedGit(argv: readonly string[]): boolean {
  if (argv[1] !== '--no-optional-locks' || !GIT_SUBCOMMANDS.has(argv[2] ?? '')) return false
  if (argv[2] === 'symbolic-ref' && !isSymbolicRefRead(argv.slice(3))) return false

  return !argv.slice(3).some(token => isRefusedFlag(token, GIT_REFUSED_FLAGS))
}

function isUnderDir(target: string, dir: string): boolean {
  const root = dir.replace(/[\\/]+$/, '')
  const isAbsolute = target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)

  if (!isAbsolute || target.split(/[\\/]/).includes('..')) return false

  return target.startsWith(`${root}/`) || target.startsWith(`${root}\\`)
}

function isOpenTarget(target: string | undefined, options: ArgvGuardOptions): boolean {
  if (target === undefined || target === '' || OPEN_TARGET_REFUSED.test(target)) return false
  if (target.startsWith('https://')) return true

  return options.docDir !== undefined && options.docDir !== '' && isUnderDir(target, options.docDir)
}

function isAllowedOpener(argv: readonly string[], name: string, options: ArgvGuardOptions): boolean {
  if (name === 'cmd') {
    const [, flag, start, empty, target] = argv

    return argv.length === 5 && flag === '/c' && start === 'start' && empty === '' && !target?.includes('&') && isOpenTarget(target, options)
  }

  return argv.length === 2 && isOpenTarget(argv[1], options)
}

function isSameArgv(argv: readonly string[], expected: readonly string[]): boolean {
  return argv.length === expected.length && argv.every((token, at) => token === expected[at])
}

/** `<root>/<name>`: one review's folder, exactly one level under an absolute reviews root. */
function isReviewDir(path: string | undefined, root: string | undefined): path is string {
  const base = root?.replace(/\/+$/, '') ?? ''
  if (path === undefined || !base.startsWith('/') || !path.startsWith(`${base}/`)) return false
  const name = path.slice(base.length + 1)

  return REVIEW_DIR_NAME.test(name) && name !== '.' && name !== '..'
}

/**
 * `git --version`, `git config --get-regexp ^filter\.`, `git cat-file -e <sha>^{commit}` and `git … archive … -o
 * <review dir>/pr.tar <sha>` with every filter driver it names switched off, each exactly as built.
 */
function isReviewCopyGit(argv: readonly string[], options: ArgvGuardOptions): boolean {
  const rest = argv.slice(1)
  if (isSameArgv(rest, GIT_VERSION.slice(1)) || isSameArgv(rest, GIT_FILTER_DRIVERS.slice(1))) return true
  if (argv[2] === 'cat-file') {
    const sha = argv[4]?.replace(/\^\{commit\}$/, '')

    return isCommitSha(sha) && isSameArgv(rest, gitHasCommit(sha).slice(1))
  }
  if (argv[2] !== `--attr-source=${EMPTY_TREE}`) return false
  const at = argv.indexOf('archive')
  const [tarPath, sha] = [argv[at + 4], argv[at + 5]]
  const drivers = argv.slice(3, at).flatMap(token => /^filter\.(.+)\.process=$/.exec(token)?.[1] ?? [])
  const isTarInReview = tarPath !== undefined && tarPath.endsWith('/pr.tar') && isReviewDir(tarPath.replace(/\/pr\.tar$/, ''), options.reviewRoot)

  return at > 0 && isCommitSha(sha) && isTarInReview && drivers.every(name => FILTER_NAME.test(name)) && isSameArgv(rest, gitArchive(sha, tarPath, drivers).slice(1))
}

/** `tar -xf <review dir>/pr.tar -C <review dir> --exclude …`, exactly as built. */
function isReviewTar(argv: readonly string[], options: ArgvGuardOptions): boolean {
  const dir = argv[4]

  return isReviewDir(dir, options.reviewRoot) && isSameArgv(argv, tarExtract(`${dir}/pr.tar`, dir))
}

/** `rm -rf <review dir>`: nothing above or beside one review's folder. */
function isReviewRemove(argv: readonly string[], options: ArgvGuardOptions): boolean {
  const dir = argv[2]

  return isReviewDir(dir, options.reviewRoot) && isSameArgv(argv, removeReviewDir(dir))
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort()

  return own.length === keys.length && [...keys].sort().every((key, at) => own[at] === key)
}

/**
 * The reviewer's `--settings`: allow rules for one WebFetch domain each only, the secret-file denies at least, and one
 * hook, the plugin's relay writing to one review's asks folder. Any other key is refused.
 */
function isReviewerSettings(text: string, options: ArgvGuardOptions): boolean {
  const { reviewRoot, pluginRoot } = options
  if (reviewRoot === undefined || pluginRoot === undefined || pluginRoot === '') return false
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  if (!isRecord(parsed) || !hasKeys(parsed, ['hooks', 'permissions'])) return false
  const { permissions, hooks } = parsed
  if (!isRecord(permissions) || !hasKeys(permissions, ['allow', 'deny']) || !isRecord(hooks) || !hasKeys(hooks, ['PermissionRequest'])) return false
  const { allow, deny } = permissions
  if (!isStringList(allow) || !allow.every(isBorrowableAllow) || !isStringList(deny) || !SECRET_DENY_RULES.every(rule => deny.includes(rule))) return false
  const [entry, ...moreEntries] = Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest : []
  if (!isRecord(entry) || moreEntries.length > 0 || !hasKeys(entry, ['hooks', 'matcher']) || entry.matcher !== '*') return false
  const [hook, ...moreHooks] = Array.isArray(entry.hooks) ? entry.hooks : []
  if (!isRecord(hook) || moreHooks.length > 0 || !hasKeys(hook, ['command', 'timeout', 'type']) || hook.type !== 'command') return false
  if (typeof hook.timeout !== 'number' || hook.timeout <= 0 || hook.timeout > 700 || typeof hook.command !== 'string') return false
  const dir = /'([^']*)\/asks'$/.exec(hook.command)?.[1]

  return isReviewDir(dir, reviewRoot) && hook.command === relayCommand(relayPathOf(pluginRoot), `${dir}/asks`)
}

/** Read, Grep and Glob, and WebFetch and WebSearch at most, each once. */
function isReviewerToolList(value: string): boolean {
  const names = value.split(',')
  const known = [...REVIEW_TOOLS, ...WEB_TOOLS]

  return new Set(names).size === names.length && names.every(name => known.includes(name)) && REVIEW_TOOLS.every(name => names.includes(name))
}

const CLAUDE_SWITCHES: readonly string[] = ['-p', '--verbose', '--include-hook-events', '--strict-mcp-config', '--no-session-persistence']

function claudeValueChecks(options: ArgvGuardOptions): Record<string, (value: string) => boolean> {
  return {
    '--model': value => REVIEW_MODELS.some(model => model === value),
    '--output-format': value => value === 'stream-json',
    '--tools': isReviewerToolList,
    '--setting-sources': value => value === '',
    '--permission-mode': value => value === 'default',
    '--max-turns': value => value === String(REVIEW_MAX_TURNS),
    '--settings': value => isReviewerSettings(value, options),
    '--append-system-prompt': value => value.trim() !== ''
  }
}

function isPlainAbsolute(path: string): boolean {
  return path.startsWith('/') && !path.split('/').includes('..')
}

function isReadDir(path: string, options: ArgvGuardOptions): boolean {
  return isPlainAbsolute(path) && (options.readDirs ?? []).includes(path)
}

/**
 * The background reviewer exactly: `claude -p` with every flag of `reviewerArgv` once and checked, `--add-dir` only to
 * the skill folders it was given, and nothing else: no prompt argument, no other flag, no other permission mode or MCP
 * server.
 */
function isReviewerArgv(argv: readonly string[], options: ArgvGuardOptions): boolean {
  const [claude = '', ...rest] = argv
  if (claude !== 'claude' && !isPlainAbsolute(claude)) return false
  const checks = claudeValueChecks(options)
  const seen = new Map<string, string>()
  for (let at = 0; at < rest.length; at += 1) {
    const flag = rest[at] ?? ''
    if (CLAUDE_SWITCHES.includes(flag) && !seen.has(flag)) {
      seen.set(flag, '')
      continue
    }
    const value = rest[at + 1]
    const isRepeatable = flag === '--add-dir'
    if (value === undefined || (!isRepeatable && (!Object.hasOwn(checks, flag) || seen.has(flag)))) return false
    if (isRepeatable && !isReadDir(value, options)) return false
    if (!isRepeatable) seen.set(flag, value)
    at += 1
  }

  return CLAUDE_SWITCHES.every(flag => seen.has(flag)) && Object.entries(checks).every(([flag, check]) => check(seen.get(flag) ?? '\0') && seen.has(flag))
}

/** The read-only guard every wiring file runs before `$.process.run` and `$.process.spawn`. */
export function isAllowedArgv(argv: readonly string[], options: ArgvGuardOptions = {}): boolean {
  const name = baseName(argv[0] ?? '')

  if (name === 'gh') return isAllowedGh(argv)
  if (name === 'git') return isReviewCopyGit(argv, options) || isAllowedGit(argv)
  if (name === 'tar' && argv[0] === 'tar') return isReviewTar(argv, options)
  if (name === 'rm' && argv[0] === 'rm') return isReviewRemove(argv, options)
  if (name === 'claude') return isReviewerArgv(argv, options)
  if (name === 'open' || name === 'xdg-open' || name === 'cmd') return isAllowedOpener(argv, name, options)

  return false
}
