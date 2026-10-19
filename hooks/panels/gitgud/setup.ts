// The pick-and-set-up flow: the questions, the card copy and the per-host settings. Pure; nothing secret is kept here,
// a Bitbucket entry names where the token lives (keychain account or environment variable) and never holds it.
import { type DecidedBy, type GgDetect, UNSUPPORTED_NAMES, type UnsupportedProvider, unsupportedNamed } from './detect'
import type { ProviderId } from './providers/types'

export const KEYCHAIN_SERVICE = 'gitgud-bitbucket'
export const DEFAULT_TOKEN_ENV = 'BITBUCKET_TOKEN'
export const BITBUCKET_TOKEN_SCOPES = 'read:pullrequest, read:repository, read:user, read:workspace (read:pipeline optional)'
export const NOT_NOW = 'Not now'
export const CANCEL = 'Cancel'

export type TokenFrom = { kind: 'keychain'; service: typeof KEYCHAIN_SERVICE; account: string } | { kind: 'env'; name: string }

export interface GgHostConfig {
  provider: ProviderId
  /** The API's own host when the remote host is an alias or the API lives elsewhere. */
  apiHost?: string
  /** Bitbucket only: where to read the token from. */
  tokenFrom?: TokenFrom
  /** Bitbucket only: the Atlassian account email sent with the token. */
  email?: string
  decidedBy: DecidedBy
  at: number
}

export type HostSettings = Record<string, GgHostConfig>

/** A question for `$.ui.ask(question, { header, options })`. */
export interface SetupQuestion { question: string; header: string; options: string[] }

export type ServiceAnswer =
  | { kind: 'provider'; provider: ProviderId }
  | { kind: 'unsupported'; provider: UnsupportedProvider; notice: string }
  | { kind: 'cancel' }

export interface CardAction { id: 'pick' | 'later' | 'signin' | 'install' | 'copy' | 'check' | 'refresh'; label: string }
export interface SetupCard { text: string; actions: CardAction[] }

const HEADER = 'GitGud'
const GITHUB_LABEL = 'GitHub or GitHub Enterprise'
const GITLAB_LABEL = 'GitLab'
const BITBUCKET_LABEL = 'Bitbucket Cloud'
const LOOKS_LIKE = ' (looks like it)'
const SERVICE_LABELS: Readonly<Record<ProviderId, string>> = { github: GITHUB_LABEL, gitlab: GITLAB_LABEL, bitbucket: BITBUCKET_LABEL }
export const SERVICE_NAMES: Readonly<Record<ProviderId, string>> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' }

/** Q1. The probe's guess goes first, marked. */
export function serviceQuestion(host: string, guess?: ProviderId): SetupQuestion {
  const order: ProviderId[] = guess === undefined ? ['github', 'gitlab', 'bitbucket'] : [guess, ...(['github', 'gitlab', 'bitbucket'] as const).filter(id => id !== guess)]
  const labels = order.map(id => (id === guess ? `${SERVICE_LABELS[id]}${LOOKS_LIKE}` : SERVICE_LABELS[id]))

  return { header: HEADER, question: `Which service hosts ${host}?`, options: [...labels, NOT_NOW] }
}

/** The answer to Q1, which may be typed text under Other. */
export function parseServiceAnswer(answer: string | undefined): ServiceAnswer {
  const text = (answer ?? '').replace(LOOKS_LIKE, '').trim()
  if (text === '' || text === NOT_NOW || text === CANCEL) return { kind: 'cancel' }
  const unsupported = unsupportedNamed(text)
  if (unsupported !== undefined) return { kind: 'unsupported', provider: unsupported, notice: unsupportedNotice(unsupported) }
  if (text === BITBUCKET_LABEL || /^bitbucket/i.test(text)) return { kind: 'provider', provider: 'bitbucket' }
  if (text === GITLAB_LABEL || /^gitlab/i.test(text)) return { kind: 'provider', provider: 'gitlab' }
  if (text === GITHUB_LABEL || /^github/i.test(text)) return { kind: 'provider', provider: 'github' }

  return { kind: 'cancel' }
}

export function unsupportedNotice(provider: UnsupportedProvider): string {
  return `GitGud doesn't read ${UNSUPPORTED_NAMES[provider]} yet.`
}

/** Q2, only when the remote host may not be the web host. */
export function webAddressQuestion(host: string): SetupQuestion {
  return { header: HEADER, question: "What's the web address of that service? Pick it or type one.", options: [`https://${host}`, CANCEL] }
}

/** The host out of an answer to Q2 (`https://git.acme.dev/` or `git.acme.dev`), or undefined to cancel. */
export function apiHostFromAnswer(answer: string | undefined): string | undefined {
  const text = (answer ?? '').trim()
  if (text === '' || text === CANCEL) return undefined
  const host = /^(?:https?:\/\/)?([a-z0-9.-]+(?::\d+)?)\/?$/i.exec(text)?.[1]

  return host?.toLowerCase()
}

// Bitbucket: where the token lives.
export const TOKEN_KEYCHAIN = 'Keychain (recommended)'
export const TOKEN_ENV = 'An environment variable'

/** Q3; Windows has no keychain command, so the option is left out there. */
export function tokenSourceQuestion(platform: string): SetupQuestion {
  const options = platform === 'win32' ? [TOKEN_ENV, CANCEL] : [TOKEN_KEYCHAIN, TOKEN_ENV, CANCEL]

  return { header: HEADER, question: 'Where should GitGud read your Bitbucket API token from?', options }
}

export function parseTokenSource(answer: string | undefined): 'keychain' | 'env' | undefined {
  if (answer === TOKEN_KEYCHAIN) return 'keychain'
  if (answer === TOKEN_ENV) return 'env'

  return undefined
}

export const EMAIL_OTHER = 'A different email (type it under Other)'

/** Q4. A saved email is offered first; any other is free text under Other. */
export function emailQuestion(savedEmail?: string): SetupQuestion {
  const options = savedEmail === undefined ? [EMAIL_OTHER, CANCEL] : [savedEmail, EMAIL_OTHER, CANCEL]

  return { header: HEADER, question: "Which email is your Atlassian account under? It's sent with the token.", options }
}

/** Q5: only the variables the engine can read (`names`), each spelled out in the wiring. */
export function envQuestion(names: readonly string[]): SetupQuestion {
  return { header: HEADER, question: 'Which environment variable holds it?', options: [...names, CANCEL] }
}

/** The answer to Q4 or Q5 that means "stop here" rather than a mistake worth a notice. */
export function isDeclined(answer: string | undefined): boolean {
  const text = (answer ?? '').trim()

  return text === '' || text === CANCEL || text === EMAIL_OTHER
}

const EMAIL_TEXT = /^[^\s'"@]+@[^\s'"@]+$/

export function emailFromAnswer(answer: string | undefined): string | undefined {
  const text = (answer ?? '').trim()

  return EMAIL_TEXT.test(text) ? text : undefined
}

/** The variable an answer names, when it is one of `names`. */
export function envNameFromAnswer(answer: string | undefined, names: readonly string[]): string | undefined {
  const text = (answer ?? '').trim()

  return names.includes(text) ? text : undefined
}

/** The one command the person runs in their own terminal; `-w` prompts for the token, so it is never run for them. */
export function keychainAddCommand(email: string, platform: string): string {
  if (platform === 'linux') return `secret-tool store --label=GitGud service ${KEYCHAIN_SERVICE} account ${email}`

  return `security add-generic-password -a ${email} -s ${KEYCHAIN_SERVICE} -w`
}

export function bitbucketKeychainCard(email: string, platform: string): SetupCard {
  const text = [
    `1. Create a token with scopes ${BITBUCKET_TOKEN_SCOPES}: id.atlassian.com → Security → API tokens.`,
    `2. In your own terminal run: ${keychainAddCommand(email, platform)} (paste the token when asked)`
  ].join('\n')

  return { text, actions: [{ id: 'copy', label: 'Copy command' }, { id: 'check', label: 'Check' }] }
}

export function bitbucketEnvCard(name: string): SetupCard {
  return { text: `Set ${name} before starting Claude Code (or in settings.json "env"), then Check.`, actions: [{ id: 'check', label: 'Check' }] }
}

/** A check that found no token to send: where it looked. */
export function bitbucketNoTokenMessage(tokenFrom: TokenFrom): string {
  if (tokenFrom.kind === 'env') return `No token in $${tokenFrom.name}`

  return `No token found in the keychain (service ${tokenFrom.service}, account ${tokenFrom.account})`
}

/** The outcome of `GET /2.0/user` as one line for the card. */
export function bitbucketCheckMessage(status: number, name?: string): { ok: boolean; text: string } {
  if (status === 200) return { ok: true, text: `Signed in to Bitbucket as ${name ?? 'your account'}.` }
  if (status === 401) return { ok: false, text: "Bitbucket refused the token. Check the email and that it isn't expired." }
  if (status === 403) return { ok: false, text: 'The token lacks a scope: it needs read:pullrequest and read:user.' }

  return { ok: false, text: `Bitbucket answered ${status}.` }
}

/** Where `glab` can be fetched from, for the missing-CLI card. */
function cliCard(tool: 'glab' | 'gh', host: string, why: 'cli-missing' | 'signed-out', canInstall: boolean): SetupCard {
  const signIn = `Sign in to ${host}: press Sign in (fills ${tool} auth login --hostname ${host}), then ↻ Refresh.`
  if (why === 'signed-out') return { text: signIn, actions: [{ id: 'signin', label: 'Sign in' }, { id: 'refresh', label: 'Refresh' }] }
  if (tool === 'gh') return { text: 'Needs the GitHub CLI: install gh (cli.github.com), then ↻ Refresh.', actions: [{ id: 'refresh', label: 'Refresh' }] }
  const actions: CardAction[] = canInstall ? [{ id: 'install', label: 'Install' }, { id: 'refresh', label: 'Refresh' }] : [{ id: 'refresh', label: 'Refresh' }]

  return { text: 'Needs the GitLab CLI: install glab (gitlab.com/gitlab-org/cli), then ↻ Refresh.', actions }
}

/** The card a verdict shows, or undefined when nothing needs saying. */
export function setupCardOf(detect: GgDetect, options: { canInstallGlab?: boolean } = {}): SetupCard | undefined {
  if (detect.kind === 'unknown-host') {
    return { text: `Couldn't tell which service hosts ${detect.host}.`, actions: [{ id: 'pick', label: 'Pick the service' }, { id: 'later', label: NOT_NOW }] }
  }
  if (detect.kind === 'no-remote') {
    return { text: 'This folder has no git remote. Pick a service to see your pull requests anywhere, or ➕ add a repo.', actions: [{ id: 'pick', label: 'Pick a service' }] }
  }
  if (detect.kind === 'unsupported') return { text: unsupportedNotice(detect.provider), actions: [] }
  if (detect.kind === 'ready') return undefined
  const { provider, host, why } = detect
  if (provider === 'bitbucket') return { text: why === 'token-refused' ? "Bitbucket refused the token. Check the email and that it isn't expired." : 'GitGud needs a Bitbucket API token.', actions: [{ id: 'pick', label: 'Set up' }] }
  if (why === 'cli-missing' || why === 'signed-out') return cliCard(provider === 'github' ? 'gh' : 'glab', host, why, options.canInstallGlab === true)

  return undefined
}

/** `⚙` Service row: `git.acme.dev: GitLab · Change`. */
export function serviceRowText(host: string, provider: ProviderId): string {
  return `${host}: ${SERVICE_NAMES[provider]}`
}

/** A Bitbucket entry for the saved host map: the email and where the token lives, never the token. */
export function bitbucketHostConfig(email: string, tokenFrom: TokenFrom, now: number, apiHost?: string): GgHostConfig {
  return { provider: 'bitbucket', email, tokenFrom, ...(apiHost === undefined ? {} : { apiHost }), decidedBy: 'person', at: now }
}

/** An entry for `gh` and `glab` hosts, saved once the CLI check passes. */
export function cliHostConfig(provider: ProviderId, decidedBy: DecidedBy, now: number, apiHost?: string): GgHostConfig {
  return { provider, ...(apiHost === undefined ? {} : { apiHost }), decidedBy, at: now }
}

/** The saved map with one host set; the rest stay as they were. */
export function withHostConfig(hosts: HostSettings | undefined, hostKey: string, config: GgHostConfig): HostSettings {
  return { ...hosts, [hostKey]: config }
}

function isProvider(value: unknown): value is ProviderId {
  return value === 'github' || value === 'gitlab' || value === 'bitbucket'
}

function isDecidedBy(value: unknown): value is DecidedBy {
  return value === 'known' || value === 'cli' || value === 'probe' || value === 'person'
}

/** Where a token is read from, checked: a keychain account or an env var name, never the token. */
function parseTokenFrom(raw: unknown): GgHostConfig['tokenFrom'] {
  if (typeof raw !== 'object' || raw === null || !('kind' in raw)) return undefined
  if (raw.kind === 'env' && 'name' in raw && typeof raw.name === 'string') return { kind: 'env', name: raw.name }
  if (raw.kind === 'keychain' && 'account' in raw && typeof raw.account === 'string') return { kind: 'keychain', service: KEYCHAIN_SERVICE, account: raw.account }

  return undefined
}

function parseHostConfig(raw: unknown): GgHostConfig | undefined {
  if (typeof raw !== 'object' || raw === null || !('provider' in raw) || !isProvider(raw.provider)) return undefined
  const tokenFrom = 'tokenFrom' in raw ? parseTokenFrom(raw.tokenFrom) : undefined
  const apiHost = 'apiHost' in raw && typeof raw.apiHost === 'string' ? raw.apiHost : undefined
  const email = 'email' in raw && typeof raw.email === 'string' ? raw.email : undefined

  return {
    provider: raw.provider,
    ...(apiHost === undefined ? {} : { apiHost }),
    ...(tokenFrom === undefined ? {} : { tokenFrom }),
    ...(email === undefined ? {} : { email }),
    decidedBy: 'decidedBy' in raw && isDecidedBy(raw.decidedBy) ? raw.decidedBy : 'person',
    at: 'at' in raw && typeof raw.at === 'number' ? raw.at : 0
  }
}

/** The saved settings' per-host configs, checked and keyed by lowercase host; undefined when none is usable. */
export function parseHostSettings(raw: unknown): HostSettings | undefined {
  if (typeof raw !== 'object' || raw === null || !('hosts' in raw) || typeof raw.hosts !== 'object' || raw.hosts === null) return undefined
  const entries = Object.entries(raw.hosts).flatMap(([host, config]): Array<[string, GgHostConfig]> => {
    const parsed = parseHostConfig(config)

    return parsed === undefined ? [] : [[host.toLowerCase(), parsed]]
  })

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}
