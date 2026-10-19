// Which service hosts the folder's remote: URL parsing, the known hosts, the probe and the verdict. Pure; the wiring
// runs the read-only git, CLI and GET steps these builders and parsers describe.
import type { ProviderId } from './providers/types'

export type UnsupportedProvider = 'bitbucket-dc' | 'gitea' | 'azure'
export type CliState = 'signed-in' | 'signed-out' | 'cli-missing'
export type TokenState = 'ok' | 'none' | 'refused'
export type NeedsSetupWhy = 'cli-missing' | 'signed-out' | 'no-token' | 'token-refused'
export type DecidedBy = 'known' | 'cli' | 'probe' | 'person'

export type GgDetect =
  | { kind: 'ready'; host: string; provider: ProviderId }
  | { kind: 'needs-setup'; host: string; provider: ProviderId; why: NeedsSetupWhy }
  | { kind: 'unknown-host'; host: string; remote: string; guess?: ProviderId }
  | { kind: 'no-remote' }
  | { kind: 'unsupported'; host: string; provider: UnsupportedProvider }

export interface ParsedRemote {
  /** Lowercase, aliases resolved (`ssh.github.com` is `github.com`). */
  host: string
  /** An HTTPS port only; an SSH port says nothing about the web host. */
  port?: number
  /** `host`, plus `:port` when there is an HTTPS port: the key of the saved host map. */
  hostKey: string
  /** Everything after the host, without `.git` or edge slashes: nested groups stay. */
  path: string
  scheme: 'https' | 'http' | 'ssh' | 'git'
}

export interface RemoteEntry { name: string; url: string }

export const KNOWN_HOSTS: Readonly<Record<string, ProviderId>> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket'
}
/** The API host of a provider whose API is not on its web host. */
export const KNOWN_API_HOSTS: Readonly<Record<string, string>> = { 'bitbucket.org': 'api.bitbucket.org' }
const HOST_ALIASES: Readonly<Record<string, string>> = {
  'ssh.github.com': 'github.com',
  'altssh.gitlab.com': 'gitlab.com',
  'altssh.bitbucket.org': 'bitbucket.org',
  'ssh.dev.azure.com': 'dev.azure.com',
  'vs-ssh.visualstudio.com': 'dev.azure.com'
}

// Read-only git the detection runs, each exactly as the guard allows.
export const GIT_REMOTE_URLS: string[] = ['git', '--no-optional-locks', 'config', '--null', '--get-regexp', '^remote\\..*\\.url$']
export const GIT_UPSTREAM: string[] = ['git', '--no-optional-locks', 'rev-parse', '--abbrev-ref', '@{upstream}']
/** The URL after the person's `insteadOf` rewrites; no network call. */
export function gitGetUrl(remote: string): string[] {
  return ['git', '--no-optional-locks', 'ls-remote', '--get-url', remote]
}

const SCHEME_URL = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/@]+)(?::(\d+))?(?:\/(.*))?$/i
const SCP_URL = /^(?:[^@/\s]+@)?([^:/\s@]{2,}):(?!\/\/)(.+)$/
const SCHEMES: Readonly<Record<string, ParsedRemote['scheme']>> = {
  https: 'https',
  http: 'http',
  ssh: 'ssh',
  'git+ssh': 'ssh',
  'ssh+git': 'ssh',
  git: 'git'
}

function cleanPath(raw: string): string {
  return raw
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+/, '')
}

function remoteOf(scheme: ParsedRemote['scheme'], rawHost: string, port: number | undefined, rawPath: string): ParsedRemote | undefined {
  const lower = rawHost.toLowerCase()
  const host = HOST_ALIASES[lower] ?? lower
  const path = cleanPath(rawPath)
  if (host === '' || host.startsWith('[') || path === '') return undefined
  const webPort = scheme === 'https' || scheme === 'http' ? port : undefined

  return { host, ...(webPort === undefined ? {} : { port: webPort }), hostKey: webPort === undefined ? host : `${host}:${webPort}`, path, scheme }
}

/**
 * `https://[user@]host[:port]/a/b.git`, `ssh://[user@]host[:port]/a/b.git`, `git://…` and scp-like `user@host:a/b.git`.
 * @example
 * // 'git@altssh.gitlab.com:g/sub/proj.git' → { host: 'gitlab.com', hostKey: 'gitlab.com', path: 'g/sub/proj', scheme: 'ssh' }
 */
export function parseRemote(url: string): ParsedRemote | undefined {
  const text = url.trim()
  const scheme = SCHEME_URL.exec(text)
  if (scheme !== null) {
    const kind = SCHEMES[(scheme[1] ?? '').toLowerCase()]

    return kind === undefined ? undefined : remoteOf(kind, scheme[2] ?? '', scheme[3] === undefined ? undefined : Number(scheme[3]), scheme[4] ?? '')
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith('/') || text.startsWith('.')) return undefined
  const scp = SCP_URL.exec(text)

  return scp === null ? undefined : remoteOf('ssh', scp[1] ?? '', undefined, scp[2] ?? '')
}

/**
 * The entries of `git config --null --get-regexp ^remote\..*\.url$`: `remote.<name>.url\n<url>\0` each.
 * @example
 * // 'remote.origin.url\nhttps://a/b.git\0' → [{ name: 'origin', url: 'https://a/b.git' }]
 */
export function parseRemoteEntries(output: string): RemoteEntry[] {
  return output.split('\0').flatMap(entry => {
    const [key = '', ...rest] = entry.split('\n')
    const name = /^remote\.(.+)\.url$/.exec(key.trim())?.[1]
    const url = rest.join('\n').trim()

    return name === undefined || url === '' ? [] : [{ name, url }]
  })
}

/** The remote a branch tracks, from `rev-parse --abbrev-ref @{upstream}` (`origin/main`); remote names may hold `/`. */
export function upstreamRemoteOf(upstream: string, remotes: readonly RemoteEntry[]): string | undefined {
  const ref = upstream.trim()

  return remotes
    .map(remote => remote.name)
    .filter(name => ref.startsWith(`${name}/`))
    .sort((a, b) => b.length - a.length)[0]
}

/** The branch's upstream remote, then `origin`, then `upstream`, then the first. */
export function pickRemote(remotes: readonly RemoteEntry[], upstreamRemote?: string): RemoteEntry | undefined {
  const named = (name: string | undefined) => remotes.find(remote => remote.name === name)

  return named(upstreamRemote) ?? named('origin') ?? named('upstream') ?? remotes[0]
}

/** `host` is a host this panel recognises as another service it does not read yet. */
export function unsupportedOf(remote: ParsedRemote): UnsupportedProvider | undefined {
  const { host, path } = remote
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) return 'azure'
  if (!(host in KNOWN_HOSTS) && /^scm\/[^/]+\/[^/]+$/.test(path)) return 'bitbucket-dc'

  return undefined
}

/** A word the person typed for a service this panel does not read yet. */
export function unsupportedNamed(text: string): UnsupportedProvider | undefined {
  if (/bitbucket\s*(server|data\s*center|dc)/i.test(text)) return 'bitbucket-dc'
  if (/gitea|forgejo|codeberg/i.test(text)) return 'gitea'
  if (/azure|visual\s*studio|vsts/i.test(text)) return 'azure'

  return undefined
}

export const UNSUPPORTED_NAMES: Readonly<Record<UnsupportedProvider, string>> = {
  'bitbucket-dc': 'Bitbucket Server',
  gitea: 'Gitea',
  azure: 'Azure DevOps'
}

/** The host a provider's API lives on when the web host is not it. */
export function apiHostOf(provider: ProviderId, host: string, saved?: { apiHost?: string }): string {
  if (saved?.apiHost !== undefined && saved.apiHost !== '') return saved.apiHost

  return (provider === 'bitbucket' ? KNOWN_API_HOSTS[host] : undefined) ?? host
}

// Step 5: the CLI's own record of the host.
/** `gh|glab auth status --hostname H`: 0 signed in; a missing program or a refusal otherwise. */
export function cliStateOf(outcome: { exitCode: number; stdout?: string; stderr?: string }): CliState {
  if (outcome.exitCode === 0) return 'signed-in'
  const text = `${outcome.stderr ?? ''}\n${outcome.stdout ?? ''}`
  if (outcome.exitCode === 127 || outcome.exitCode < 0 || /ENOENT|not found|no such file|cannot find/i.test(text)) return 'cli-missing'

  return 'signed-out'
}

// Step 6: an unauthenticated look at the host, only to preselect a service.
export interface ProbeResult { path: string; status: number; body: string }
export interface ProbeGuess { provider?: ProviderId; unsupported?: UnsupportedProvider }

export const PROBE_PATHS: readonly string[] = ['/api/v3/meta', '/api/v4/version', '/users/sign_in', '/rest/api/1.0/application-properties', '/api/v1/version']
export const PROBE_TIMEOUT_MS = 5000

export function probeUrl(hostKey: string, path: string): string {
  return `https://${hostKey}${path}`
}

function jsonRecord(body: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body)

    return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
  } catch {
    return undefined
  }
}

/** GitHub Enterprise Server, GitLab, Bitbucket Server and Gitea each answer their own probe paths in their own way. */
export function interpretProbes(results: readonly ProbeResult[]): ProbeGuess {
  const at = (path: string) => results.find(result => result.path === path)
  const meta = at('/api/v3/meta')
  if (meta?.status === 200 && typeof jsonRecord(meta.body)?.installed_version === 'string') return { provider: 'github' }
  const version = at('/api/v4/version')
  const signIn = at('/users/sign_in')
  const isGitlabApi = version?.status === 401 && jsonRecord(version.body)?.message === '401 Unauthorized'
  if (isGitlabApi && signIn?.status === 200 && /GitLab/.test(signIn.body)) return { provider: 'gitlab' }
  const props = at('/rest/api/1.0/application-properties')
  if (props?.status === 200 && jsonRecord(props.body)?.displayName === 'Bitbucket') return { unsupported: 'bitbucket-dc' }
  const gitea = at('/api/v1/version')
  if (gitea?.status === 200 && typeof jsonRecord(gitea.body)?.version === 'string') return { unsupported: 'gitea' }

  return {}
}

// Step 7: the verdict.
export interface DetectEvidence {
  /** The saved answer for this host (`settings.hosts[hostKey].provider`). */
  saved?: ProviderId
  /** `gh` and `glab` auth status for this host, when run. */
  cli?: { gh?: CliState; glab?: CliState }
  probe?: ProbeGuess
  /** The provider's own health once its provider is known: a CLI state or, for Bitbucket, a token state. */
  health?: CliState | TokenState
}

export interface HostProvider { provider: ProviderId; decidedBy: DecidedBy }

/** The provider the first of known host, saved answer or signed-in CLI names; a probe never decides alone. */
export function providerOfHost(host: string, evidence: DetectEvidence): HostProvider | undefined {
  const known = KNOWN_HOSTS[host]
  if (known !== undefined) return { provider: known, decidedBy: 'known' }
  if (evidence.saved !== undefined) return { provider: evidence.saved, decidedBy: 'person' }
  if (evidence.cli?.gh === 'signed-in') return { provider: 'github', decidedBy: 'cli' }
  if (evidence.cli?.glab === 'signed-in') return { provider: 'gitlab', decidedBy: 'cli' }

  return undefined
}

function whyOf(provider: ProviderId, health: DetectEvidence['health']): NeedsSetupWhy | undefined {
  if (health === undefined || health === 'signed-in' || health === 'ok') return undefined
  if (provider === 'bitbucket') return health === 'refused' ? 'token-refused' : health === 'none' ? 'no-token' : undefined

  return health === 'cli-missing' ? 'cli-missing' : health === 'signed-out' ? 'signed-out' : undefined
}

/** One folder's verdict. `needs-setup` is a known service that is not signed in; only the other kinds are failures to detect. */
export function detectVerdict(remote: ParsedRemote | undefined, remoteUrl: string | undefined, evidence: DetectEvidence = {}): GgDetect {
  if (remote === undefined) return remoteUrl === undefined || remoteUrl.trim() === '' ? { kind: 'no-remote' } : { kind: 'unknown-host', host: remoteUrl.trim(), remote: remoteUrl.trim() }
  const { host, hostKey } = remote
  const unsupported = unsupportedOf(remote)
  if (unsupported !== undefined) return { kind: 'unsupported', host: hostKey, provider: unsupported }
  const decided = providerOfHost(hostKey, evidence) ?? providerOfHost(host, evidence)
  if (decided === undefined) {
    if (evidence.probe?.unsupported !== undefined) return { kind: 'unsupported', host: hostKey, provider: evidence.probe.unsupported }

    return { kind: 'unknown-host', host: hostKey, remote: remoteUrl ?? hostKey, ...(evidence.probe?.provider === undefined ? {} : { guess: evidence.probe.provider }) }
  }
  const why = whyOf(decided.provider, evidence.health)

  return why === undefined ? { kind: 'ready', host: hostKey, provider: decided.provider } : { kind: 'needs-setup', host: hostKey, provider: decided.provider, why }
}
