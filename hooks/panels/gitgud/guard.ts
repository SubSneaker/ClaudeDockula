// The read-only guard every wiring file runs before `$.process.run`, `$.process.spawn` and `$.http.fetch`: each command
// and request is matched whole, so a write is refused whatever its provider. Pure.
import { isRecord } from '../jira/parse'
import { GIT_FILTER_DRIVERS, GIT_VERSION, gitArchive, gitHasCommit, removeReviewDir, tarExtract } from './argv'
import { GIT_REMOTE_URLS, PROBE_PATHS } from './detect'
import { BITBUCKET_READS } from './providers/bitbucket'
import { GITLAB_READS } from './providers/gitlab'
import { KEYCHAIN_SERVICE } from './setup'
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

export interface ArgvGuardOptions {
  /** The panel's doc folders (`docDirsOf`): an opener may open a file under any of them. */
  docDirs?: readonly string[]
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
/** A host name with an optional port, as `--hostname` takes it. */
const HOST_NAME = /^[a-z0-9.-]+(:\d+)?$/
const ACCOUNT_NAME = /^[^\s'"]+$/
const REMOTE_NAME = /^\w[\w.-]*$/
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

/** `gh api repos/o/r/pulls/<n>/files[?per_page=100] [--hostname <host>] [--paginate]`: a GET with no field, header or method. */
function isPrFilesRead(argv: readonly string[]): boolean {
  const [, , path = '', ...rest] = argv
  const segments = path.split('?')[0]?.split('/') ?? []
  const host = rest[0] === '--hostname' ? rest[1] : undefined
  const flags = rest[0] === '--hostname' ? rest.slice(2) : rest
  const isHostOk = rest[0] !== '--hostname' || (host !== undefined && HOST_NAME.test(host))

  return PR_FILES_PATH.test(path) && !segments.some(part => /^\.+$/.test(part)) && isHostOk && flags.every(token => token === '--paginate') && flags.length <= 1
}

/** A repo as `--repo` takes it: `owner/name`, or `host/owner/name` on an Enterprise host. */
const REPO_ARG = /^(?:[a-z0-9.-]+(?::\d+)?\/)?[\w.-]+\/[\w.-]+$/i

/** Every `--hostname` names a plain host, once, and every `--repo` a plain repo: an Enterprise host reads like github.com. */
function isHostFlagsOk(args: readonly string[]): boolean {
  const names = args.flatMap((token, at) => (token === '--hostname' ? [args[at + 1] ?? ''] : []))
  const repos = args.flatMap((token, at) => (token === '--repo' || token === '-R' ? [args[at + 1] ?? ''] : []))

  return names.length <= 1 && names.every(name => HOST_NAME.test(name)) && repos.length <= 1 && repos.every(repo => REPO_ARG.test(repo) && !repo.split('/').some(part => /^\.+$/.test(part)))
}

/** `--show-token`, or a short-flag cluster holding `-t`, prints the token. */
function isTokenFlag(token: string): boolean {
  return token === '--show-token' || token.startsWith('--show-token=') || /^-[a-z]*t[a-z]*$/i.test(token)
}

function isAllowedGh(argv: readonly string[]): boolean {
  const [, group = '', action = ''] = argv
  if (!isHostFlagsOk(argv.slice(1))) return false
  if (group === 'api' && action !== 'graphql') return isPrFilesRead(argv)
  if (group === 'auth' && argv.slice(3).some(isTokenFlag)) return false
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
  if (isSameArgv(argv, GIT_REMOTE_URLS)) return true
  if (argv[1] !== '--no-optional-locks') return false
  if (argv[2] === 'ls-remote') return argv.length === 5 && argv[3] === '--get-url' && REMOTE_NAME.test(argv[4] ?? '')
  if (!GIT_SUBCOMMANDS.has(argv[2] ?? '')) return false
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

  return (options.docDirs ?? []).some(dir => dir !== '' && isUnderDir(target, dir))
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

/** `glab auth status --hostname <host>` and `glab api <path> --hostname <host> [--paginate]`; nothing else of `glab`. */
function isAllowedGlab(argv: readonly string[]): boolean {
  const [, group = '', second = '', ...rest] = argv
  if (group === 'auth') return argv.length === 5 && second === 'status' && rest[0] === '--hostname' && HOST_NAME.test(rest[1] ?? '')
  if (group !== 'api') return false
  const [flag, host, ...more] = rest
  const isTail = flag === '--hostname' && HOST_NAME.test(host ?? '') && (more.length === 0 || (more.length === 1 && more[0] === '--paginate'))

  return isTail && isGitlabRead(second)
}

/** `security find-generic-password -s gitgud-bitbucket -a <account> -w` and `secret-tool lookup service gitgud-bitbucket account <account>`. */
function isKeychainLookup(argv: readonly string[]): boolean {
  const account = argv[5]
  const isAccount = account !== undefined && ACCOUNT_NAME.test(account) && !account.startsWith('-')
  const isSecurity = baseName(argv[0] ?? '') === 'security' && ['security', '/usr/bin/security'].includes(argv[0] ?? '')
  const isSecretTool = baseName(argv[0] ?? '') === 'secret-tool' && ['secret-tool', '/usr/bin/secret-tool'].includes(argv[0] ?? '')
  if (isSecurity) return argv.length === 7 && isSameArgv(argv.slice(1, 5), ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a']) && isAccount && argv[6] === '-w'
  if (isSecretTool) return argv.length === 6 && isSameArgv(argv.slice(1, 5), ['lookup', 'service', KEYCHAIN_SERVICE, 'account']) && isAccount

  return false
}

/** The read-only guard every wiring file runs before `$.process.run` and `$.process.spawn`. */
export function isAllowedArgv(argv: readonly string[], options: ArgvGuardOptions = {}): boolean {
  const name = baseName(argv[0] ?? '')

  if (name === 'gh') return isAllowedGh(argv)
  if (name === 'glab') return isAllowedGlab(argv)
  if (name === 'security' || name === 'secret-tool') return isKeychainLookup(argv)
  if (name === 'git') return isReviewCopyGit(argv, options) || isAllowedGit(argv)
  if (name === 'tar' && argv[0] === 'tar') return isReviewTar(argv, options)
  if (name === 'rm' && argv[0] === 'rm') return isReviewRemove(argv, options)
  if (name === 'claude') return isReviewerArgv(argv, options)
  if (name === 'open' || name === 'xdg-open' || name === 'cmd') return isAllowedOpener(argv, name, options)

  return false
}

// What a read-only REST path may be: the provider adapters export these as data; the guard applies them.
export interface ReadRule {
  /** Matched against the path without its leading slash or API prefix, and without the query. */
  path: RegExp
  /** The query keys this path may carry, each with its value check (a key list means any plain value). */
  query?: Readonly<Record<string, RegExp>> | readonly string[]
  /** Query keys that must be present. */
  required?: readonly string[]
}

const PLAIN_QUERY_VALUE = /^[^\s&#]*$/
const API_PREFIXES: readonly string[] = ['api/v4/', '2.0/']

function hasDotSegment(path: string): boolean {
  return path.split('/').some(segment => {
    let text = segment
    try {
      text = decodeURIComponent(segment)
    } catch {
      return true
    }

    return text === '..' || text === '.' || /(^|[\\/])\.\.($|[\\/])/.test(text)
  })
}

function queryPairs(query: string): [string, string][] | undefined {
  if (query === '') return []
  const pairs: [string, string][] = []
  for (const part of query.split('&')) {
    const at = part.indexOf('=')
    const [key, value] = at < 0 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)]
    if (key === '' || pairs.some(([seen]) => seen === key)) return undefined
    pairs.push([key, value])
  }

  return pairs
}

function isKeyList(value: NonNullable<ReadRule['query']>): value is readonly string[] {
  return Array.isArray(value)
}

function isQueryAllowed(pairs: readonly [string, string][], rule: ReadRule): boolean {
  const checks = rule.query
  const check = (key: string): RegExp | undefined => {
    if (checks === undefined) return undefined
    if (isKeyList(checks)) return checks.includes(key) ? PLAIN_QUERY_VALUE : undefined

    return Object.hasOwn(checks, key) ? checks[key] : undefined
  }

  return pairs.every(([key, value]) => check(key)?.test(value) === true) && (rule.required ?? []).every(key => pairs.some(([seen]) => seen === key))
}

/** `path` is a read one of `rules` lists: no dot segment, the path template, and only that entry's query keys. */
export function isReadPath(path: string, query: string, rules: readonly ReadRule[]): boolean {
  const bare = path.replace(/^\/+/, '')
  const pairs = queryPairs(query)
  if (pairs === undefined || hasDotSegment(bare)) return false
  const stripped = API_PREFIXES.find(prefix => bare.startsWith(prefix))
  const candidates = stripped === undefined ? [bare] : [bare.slice(stripped.length), bare]

  return rules.some(rule => candidates.some(candidate => rule.path.test(candidate)) && isQueryAllowed(pairs, rule))
}

/** The `<path>` of `glab api`, with its query. */
function isGitlabRead(target: string): boolean {
  const at = target.indexOf('?')
  const [path, query] = at < 0 ? [target, ''] : [target.slice(0, at), target.slice(at + 1)]

  return path !== '' && !path.startsWith('-') && isReadPath(path, query, GITLAB_READS)
}

export interface GuardedRequest {
  method: string
  url: string
  headers?: Readonly<Record<string, string>>
  body?: unknown
  needsToken?: boolean
}

export interface RequestHosts {
  /** The configured API hosts: the only ones a token or an API path may go to. */
  apiHosts?: readonly string[]
  /** Hosts the detection may probe, with no headers and one of the probe paths. */
  probeHosts?: readonly string[]
}

const HTTPS_URL = /^https:\/\/([a-z0-9.-]+(?::\d+)?)((?:\/[^?#\s]*)?)(?:\?([^#\s]*))?$/
const API_HEADERS = new Set(['authorization', 'accept'])

/** A GET over https to a configured API host and a listed path, or an unauthenticated probe: nothing else leaves. */
export function isAllowedRequest(req: GuardedRequest, hosts: RequestHosts = {}): boolean {
  if (req.method !== 'GET' || req.body !== undefined) return false
  const match = HTTPS_URL.exec(req.url)
  if (match === null) return false
  const [, host = '', path = '', query = ''] = match
  const names = Object.keys(req.headers ?? {}).map(name => name.toLowerCase())
  if ((hosts.apiHosts ?? []).includes(host)) {
    return path.startsWith('/2.0/') && names.every(name => API_HEADERS.has(name)) && isReadPath(path, query, BITBUCKET_READS)
  }
  if (req.needsToken === true || names.length > 0) return false

  return (hosts.probeHosts ?? []).includes(host) && query === '' && PROBE_PATHS.includes(path)
}
