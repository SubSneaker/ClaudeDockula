// What the three wiring files share about running an adapter's requests, with no `$`: which executables to try, the
// env a command may carry, the plan for an http request, the Bitbucket token's memory and the loop that steps an
// operation. A wiring file hands in its own `$` calls as a small `RunnerIo`; nothing else of the engine crosses.
import { errorText } from '../jira/servers'
import { GH_CANDIDATES } from './argv'
import { basicAuthHeader, isReadableTokenEnv, keychainLookupArgv, redactSecrets, tokenFromEnv, tokenFromKeychainOutput } from './credentials'
import { isAllowedArgv, isAllowedRequest } from './guard'
import { drawable, type Parsed } from './parse'
import { BITBUCKET_API_HOST } from './providers/bitbucket'
import type { Op, Outcome, Req } from './providers/types'
import { GH_TIMEOUT_MS, NOT_STARTED, enter, ghGate, leave, refusedRun, type RunOutcome } from './run'
import type { GgHostConfig } from './setup'

type Tool = 'gh' | 'glab'

export const GLAB_CANDIDATES: readonly string[] = ['glab', '/opt/homebrew/bin/glab', '/usr/local/bin/glab', '/usr/bin/glab']
const CANDIDATES: Readonly<Record<Tool, readonly string[]>> = { gh: GH_CANDIDATES, glab: GLAB_CANDIDATES }
/** Only these reach a command: what the adapters set, and `GH_HOST` for an Enterprise host. */
const ENV_KEYS = new Set([
  'GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER', 'NO_COLOR', 'CLICOLOR', 'GH_PAGER', 'PAGER', 'GH_HOST',
  'GLAB_NO_PROMPT', 'GLAB_PAGER', 'GLAB_CHECK_UPDATE', 'GLAB_SEND_TELEMETRY'
])
const HOST_NAME = /^[a-z0-9.-]+(:\d+)?$/
const ERROR_CHARS = 400

/** The outcome of a request that never ran or never answered. */
export const NO_OUTCOME: Outcome = { exitCode: -1, stdout: '', stderr: 'no outcome' }

/** What a request needing a token answers when none could be read; adapters read it as a refusal (401). */
export const NO_TOKEN_TEXT = 'no token'
/** A fork PR's diff is read through the PR, which Bitbucket answers with a redirect the engine gives no way to see. */
const PR_LEVEL_DIFF = /^https:\/\/[^/]+\/2\.0\/repositories\/[^/]+\/[^/]+\/pullrequests\/\d+\/diff(stat)?(\?|$)/
export const FORK_DIFF_TEXT = "fork PR diffs aren't available"
const FORK_DIFF: Outcome = { exitCode: 1, stdout: '', stderr: FORK_DIFF_TEXT, status: 501 }
const NO_TOKEN: Outcome = { exitCode: 1, stdout: '', stderr: NO_TOKEN_TEXT, status: 401 }

const lastTool: Partial<Record<Tool, string>> = {}
const tokens = new Map<string, string>()

/** Where to look for a CLI: the one that started last first, then the PATH and the usual install folders. */
export function toolCandidates(tool: Tool): string[] {
  const last = lastTool[tool]
  const all = CANDIDATES[tool]

  return last === undefined ? [...all] : [last, ...all.filter(one => one !== last)]
}

export function rememberTool(tool: Tool, path: string | undefined): void {
  if (path === undefined) delete lastTool[tool]
  else lastTool[tool] = path
}

/** The command's env, cut to the keys the adapters may set; an Enterprise host must be a plain host name. */
export function cliEnvOf(env: Readonly<Record<string, string>>): Record<string, string> {
  const kept = Object.entries(env).filter(([key, value]) => ENV_KEYS.has(key) && (key !== 'GH_HOST' || HOST_NAME.test(value)))

  return Object.fromEntries(kept)
}

/** `argv` with the executable that was found in place of the bare name. */
export function withExecutable(argv: readonly string[], executable: string): string[] {
  return [executable, ...argv.slice(1)]
}

/** The saved config of a remote host; the host is read without its case. */
export function hostConfigOf(hosts: Readonly<Record<string, GgHostConfig>> | undefined, host: string): GgHostConfig | undefined {
  return hosts?.[host.toLowerCase()]
}

/** The one API host a token may go to. */
export function isTokenHost(host: string): boolean {
  return host === BITBUCKET_API_HOST
}

export interface HttpPlan {
  url: string
  headers: Record<string, string>
}

/**
 * The request to send, or undefined when the guard refuses it. The `Authorization` header goes only on a request that
 * needs the token and only to the API host.
 */
export function httpPlanOf(req: Extract<Req, { kind: 'http' }>, token: string | undefined, email: string | undefined, probeHosts: readonly string[] = []): HttpPlan | undefined {
  const host = /^https:\/\/([a-z0-9.-]+(?::\d+)?)/.exec(req.url)?.[1] ?? ''
  const isToken = req.needsToken && isTokenHost(host) && token !== undefined && email !== undefined
  const headers: Record<string, string> = { ...req.headers, ...(isToken ? { authorization: basicAuthHeader(email, token) } : {}) }
  const guarded = { method: req.method, url: req.url, headers, needsToken: req.needsToken }
  if (!isAllowedRequest(guarded, { apiHosts: [BITBUCKET_API_HOST], probeHosts })) return undefined
  if (req.needsToken && !isToken) return undefined

  return { url: req.url, headers }
}

export function outcomeOfResponse(response: { status: number; ok: boolean; headers: Record<string, string>; text: string }): Outcome {
  return { exitCode: response.ok ? 0 : 1, stdout: response.text, stderr: '', status: response.status, headers: response.headers }
}

/** A command's outcome as an adapter reads it: the engine's cut stdout becomes `isTruncated`. */
export function outcomeOfRun(ran: RunOutcome): Outcome {
  return { exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr, ...(ran.isStdoutTruncated === true ? { isTruncated: true } : {}) }
}

/** A request that threw: no status, so it reads as unreachable; its text is drawn clean and never holds a credential. */
export function outcomeOfThrown(error: unknown, secrets: readonly string[] = []): Outcome {
  const text = error instanceof Error ? error.message : String(error)

  return { exitCode: -1, stdout: '', stderr: redactSecrets(drawable(text), secrets).slice(0, ERROR_CHARS) }
}

/** A request the guard refused. */
export function refusedRequest(req: Req): Outcome {
  return { exitCode: -1, stdout: '', stderr: `ClaudeDockula refused to send ${req.kind === 'http' ? req.url.split('?')[0] : req.kind}` }
}

/** Whether a request found no token to send, as opposed to Bitbucket refusing one. */
export function isNoToken(outcome: Outcome): boolean {
  return outcome.stderr === NO_TOKEN_TEXT && outcome.status === 401
}

/** Dropped on a 401 and on a reload, so the next request reads the source again. */
export function forgetTokens(): void {
  tokens.clear()
}

/** How to read a host's token: a lookup argv per platform to try, or an env var name. */
export type TokenRead = { kind: 'keychain'; argvs: string[][] } | { kind: 'env'; name: string }

export function tokenReadOf(config: GgHostConfig | undefined): TokenRead | undefined {
  const from = config?.tokenFrom
  if (from === undefined) return undefined
  if (from.kind === 'env') return { kind: 'env', name: from.name }
  const argvs = ['darwin', 'linux'].flatMap(platform => {
    const argv = keychainLookupArgv(platform, from.account)

    return argv === undefined ? [] : [argv]
  })

  return { kind: 'keychain', argvs }
}

export interface HttpResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  text: string
}

/** The engine calls a wiring file makes for the runner; each is one `$` call in a small closure. */
export interface RunnerIo {
  /** One try of a CLI at one path; a spawn that failed is NOT_STARTED. Never throws. */
  cli: (argv: string[], env: Record<string, string>, timeoutMs: number) => Promise<RunOutcome>
  /** Read-only git, guarded by the file. Never throws. */
  git: (argv: string[]) => Promise<Outcome>
  /** A keychain lookup; undefined when its tool is not there. */
  keychain: (argv: string[]) => Promise<{ exitCode: number; stdout: string } | undefined>
  /** One of `ENV_TOKEN_NAMES`: the engine wants each `$.env.get` name written out. */
  env: (name: string) => Promise<string | undefined>
  /** One GET. May throw. */
  fetch: (url: string, headers: Record<string, string>) => Promise<HttpResponse>
  /** The saved hosts, as the panel's state holds them. */
  hosts: () => Promise<Readonly<Record<string, GgHostConfig>> | undefined>
}

export interface RunOptions {
  /** A config not saved yet, for its own check only: used instead of the saved one, and the token cache is left alone. */
  config?: GgHostConfig
  /** Hosts a request may reach without a token (the detection's probe). */
  probeHosts?: readonly string[]
}

/** The token of a Bitbucket host: from the keychain or the env var it names, read now and kept in memory only. */
export async function readTokenWith(io: RunnerIo, config: GgHostConfig | undefined): Promise<string | undefined> {
  const source = tokenReadOf(config)
  if (source === undefined) return undefined
  if (source.kind === 'env') {
    if (!isReadableTokenEnv(source.name)) return undefined
    const value = await io.env(source.name)

    return tokenFromEnv(source.name, () => value)
  }
  for (const argv of source.argvs) {
    if (!isAllowedArgv(argv)) continue
    const ran = await io.keychain(argv)
    if (ran?.exitCode === 0) return tokenFromKeychainOutput(ran.stdout)
  }

  return undefined
}

/** The saved host's token, from memory or read now; the first read is kept in memory for the next request. */
export async function savedTokenWith(io: RunnerIo, config: GgHostConfig | undefined): Promise<string | undefined> {
  const token = tokens.get(BITBUCKET_API_HOST) ?? (await readTokenWith(io, config))
  if (token !== undefined) tokens.set(BITBUCKET_API_HOST, token)

  return token
}

/** Runs one CLI request: the guard first, the executable that started last first, then the usual install folders. */
async function runCliWith(io: RunnerIo, req: Extract<Req, { kind: 'cli' }>): Promise<Outcome> {
  let outcome: RunOutcome = { exitCode: NOT_STARTED, stdout: '', stderr: `${req.tool} is not installed` }
  for (const executable of toolCandidates(req.tool)) {
    const argv = withExecutable(req.argv, executable)
    if (!isAllowedArgv(argv)) return outcomeOfRun(refusedRun(argv))
    await enter(ghGate)
    try {
      outcome = await io.cli(argv, cliEnvOf(req.env), req.timeoutMs ?? GH_TIMEOUT_MS)
    } finally {
      leave(ghGate)
    }
    if (outcome.exitCode !== NOT_STARTED) {
      rememberTool(req.tool, executable)

      return outcomeOfRun(outcome)
    }
  }
  rememberTool(req.tool, undefined)

  return outcomeOfRun(outcome)
}

/** Sends one GET: the guard first; the token is read and added to the header here, for the API host only. */
async function runHttpWith(io: RunnerIo, req: Extract<Req, { kind: 'http' }>, options: RunOptions): Promise<Outcome> {
  const config = req.needsToken ? (options.config ?? Object.values((await io.hosts()) ?? {}).find(host => host.provider === 'bitbucket')) : undefined
  if (req.needsToken && PR_LEVEL_DIFF.test(req.url)) return FORK_DIFF
  const isCached = options.config === undefined
  let token: string | undefined
  if (req.needsToken) {
    token = await (isCached ? savedTokenWith(io, config) : readTokenWith(io, config))
  }
  const plan = httpPlanOf(req, token, config?.email, options.probeHosts)
  if (plan === undefined) return req.needsToken && token === undefined ? NO_TOKEN : refusedRequest(req)
  try {
    const response = await io.fetch(plan.url, plan.headers)
    if (response.status === 401 && isCached) tokens.clear()

    return outcomeOfResponse(response)
  } catch (error) {
    return outcomeOfThrown(error, token === undefined ? [] : [token])
  }
}

/** Runs one request through its guard and the file's engine calls. */
export async function runReqWith(io: RunnerIo, req: Req, options: RunOptions = {}): Promise<Outcome> {
  if (req.kind === 'cli') return runCliWith(io, req)
  if (req.kind === 'git') return io.git(req.argv)

  return runHttpWith(io, req, options)
}

/** What a stepped operation gave back, and whether any command output it read was cut. */
export interface Stepped<T> {
  parsed: Parsed<T>
  isTruncated: boolean
}

/** Steps an adapter's operation: each request it yields runs through the guards, and its outcome goes back in. */
export async function runOpTracked<T>(io: RunnerIo, op: Op<T>, options: RunOptions = {}): Promise<Stepped<T>> {
  let isTruncated = false
  const run = async (req: Req): Promise<Outcome> => {
    const outcome = await runReqWith(io, req, options)
    if (outcome.isTruncated === true) isTruncated = true

    return outcome
  }
  try {
    let step = op.next()
    while (!step.done) {
      const { value } = step
      const outcome = 'kind' in value ? await run(value) : await Promise.all(value.map(run))
      step = op.next(outcome)
    }

    return { parsed: step.value, isTruncated }
  } catch (error) {
    return { parsed: { isOk: false, error: errorText(error) }, isTruncated }
  }
}

export async function runOpWith<T>(io: RunnerIo, op: Op<T>, options: RunOptions = {}): Promise<Parsed<T>> {
  return (await runOpTracked(io, op, options)).parsed
}
