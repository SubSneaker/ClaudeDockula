// The background reviewer: a locked-down headless Claude Code session the panel starts itself. Its folders, its argv
// and `--settings`, the stream it writes, the permission asks it relays through files, and its readable log.
// Pure: no `$`; gitgudWork.tsx runs it.
import type { GhAskRule, GhReviewAsk, GhReviewDone, GhReviewModel } from '../../../types'
import { isRecord, textAt } from '../jira/parse'
import { parseRepoKey } from './ids'
import type { AskAnswerKind } from './model'
import { drawable } from './parse'

export const REVIEW_MAX_TURNS = 30
/** The relay denies an ask nobody answered after this long. */
export const ASK_TIMEOUT_MS = 600_000
/** The card stops offering answers this long before the relay gives up, so no answer lands after it denied. */
const ASK_MARGIN_MS = 10_000
/** A review still running after this long is stopped: an ask or a stalled call could hold it for good. */
export const REVIEW_LIMIT_MS = 1_800_000
/** A review folder older than this belongs to no running review: a session that quit mid-review left it. */
export const STALE_REVIEW_MS = 7_200_000
/** The PermissionRequest hook's script, relative to the plugin's root. */
export const ASK_RELAY = 'hooks/panels/gitgud/ask-relay.sh'
/** Seconds Claude Code waits for the relay: past its own 10 minutes. */
const RELAY_TIMEOUT_S = 700
export const REVIEW_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob']
export const WEB_TOOLS: readonly string[] = ['WebFetch', 'WebSearch']
export const REVIEW_MODELS: readonly GhReviewModel[] = ['sonnet', 'opus']
export const REVIEW_DONE: readonly GhReviewDone[] = ['notice', 'bell', 'notify']
/** Files no review needs: keys, credentials, the person's cloud, GitHub and GitLab logins. */
export const SECRET_DENY_RULES: readonly string[] = [
  'Read(**/.env*)',
  'Read(**/*.pem)',
  'Read(**/*.key)',
  'Read(**/id_rsa*)',
  'Read(**/id_ed25519*)',
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.config/gh/**)',
  'Read(~/.config/glab-cli/**)',
  'Read(~/Library/Application Support/glab-cli/**)',
  'Read(~/.netrc)',
  'Read(**/.npmrc)'
]
/** What the copy leaves out, at any depth: Claude Code's project config and git hook folders. */
export const COPY_EXCLUDES: readonly string[] = ['.claude', '.mcp.json', '.git', '.githooks', '.git-hooks']
/** Where `claude` may be when it is not on PATH, after `~/`: the native installer's and the old local install's. */
const CLAUDE_HOME_PATHS: readonly string[] = ['.local/bin/claude', '.claude/local/claude']
const CLAUDE_SYSTEM_PATHS: readonly string[] = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']
/** A review folder's own name under the reviews root. */
export const REVIEW_DIR_NAME = /^[A-Za-z0-9._-]+$/
/** `WebFetch(domain:docs.python.org)` or `WebFetch(domain:*.python.org)`: a host of plain labels, a `*.` lead at most. */
const BORROWED_ALLOW = /^WebFetch\(domain:(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\)$/
const ASK_FILE = /^ask-(\d+-\d+)\.json$/
const MAX_BORROWED = 200
const MAX_WORDS_CHARS = 160
const MODEL_NAME: Record<GhReviewModel, string> = { sonnet: 'Sonnet', opus: 'Opus' }

export function modelName(model: GhReviewModel | undefined): string {
  return MODEL_NAME[model ?? 'sonnet']
}

/** The background reviews' settings as saved for every session, checked; anything unusable falls back to its default. */
export interface ReviewSettings {
  model: GhReviewModel
  isWebOn: boolean
  done: GhReviewDone
}

export function reviewSettingsOf(raw: unknown): ReviewSettings {
  const model = isRecord(raw) ? REVIEW_MODELS.find(one => one === raw.reviewModel) : undefined
  const done = isRecord(raw) ? REVIEW_DONE.find(one => one === raw.reviewDone) : undefined

  return { model: model ?? 'sonnet', isWebOn: !(isRecord(raw) && raw.isReviewWebOn === false), done: done ?? 'notice' }
}

/** `review-2086-20261016-153012`: the review file, its log and its stream share it, with `.md`, `.log.md`, `.jsonl`. */
export function reviewBaseName(number: number, at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`

  return `review-${number}-${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * One temporary folder name per repo: github.com's by its path, any other host's with the host first.
 * @example
 * // 'github.com/acme/webapp' → 'acme__webapp'
 * // 'gitlab.com/g/sub/proj'  → 'gitlab.com__g__sub__proj'
 */
export function repoFolder(repo: string): string {
  const parsed = parseRepoKey(repo)
  const flat = parsed === undefined ? repo : parsed.host === 'github.com' ? parsed.path : `${parsed.host}/${parsed.path}`

  return flat.replace(/\//g, '__').replace(/[^A-Za-z0-9._-]+/g, '-')
}

/**
 * The folder every review's temporary folder goes in: the person's own temp folder, never a repo; without `TMPDIR`,
 * under their home rather than a `/tmp` other users share. Undefined when neither is an absolute folder: a relative
 * one would put the copy under the session's working directory.
 */
export function reviewsRootOf(tmpDir: string | undefined, home: string | undefined): string | undefined {
  const isAbsolute = (dir: string) => dir.startsWith('/') && !dir.split('/').includes('..')
  if (tmpDir !== undefined) return isAbsolute(tmpDir.trim()) ? `${tmpDir.trim().replace(/\/+$/, '')}/claudedockula-reviews` : undefined

  return home !== undefined && isAbsolute(home.trim()) ? `${home.trim().replace(/\/+$/, '')}/.cache/claudedockula-reviews` : undefined
}

/** Why there is no reviews root, for the card. */
export function noReviewsRootText(tmpDir: string | undefined): string {
  return tmpDir === undefined
    ? 'HOME is not an absolute folder, so there is nowhere safe for the review\'s copy'
    : `TMPDIR ("${drawable(tmpDir)}") is not an absolute folder, so there is nowhere safe for the review's copy`
}

/** git's empty tree: attributes read from it are none. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** The first git that has `--attr-source`, which the clean copy uses. */
export const MIN_GIT: readonly [number, number] = [2, 41]

/** `git version 2.49.0` → `[2, 49]`; undefined for anything else. */
export function gitVersionOf(text: string): [number, number] | undefined {
  const [, major, minor] = /git version (\d+)\.(\d+)/.exec(text) ?? []

  return major === undefined || minor === undefined ? undefined : [Number(major), Number(minor)]
}

export function isGitNewEnough(version: readonly [number, number] | undefined): boolean {
  return version !== undefined && (version[0] > MIN_GIT[0] || (version[0] === MIN_GIT[0] && version[1] >= MIN_GIT[1]))
}

/** A filter driver name the copy can switch off by name. */
export const FILTER_NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/

/**
 * The filter drivers the person's git config defines (`git config --null --get-regexp ^filter\.`: each entry its key, a
 * line break, its value, then NUL), each once; undefined when a name could not be switched off safely.
 * @example
 * // before: 'filter.lfs.process\ngit-lfs filter-process\0filter.lfs.required\ntrue\0filter.git-crypt.smudge\n"git-crypt" smudge\0'
 * // after:  ['lfs', 'git-crypt']
 */
export function filterDriversOf(stdout: string): string[] | undefined {
  const names: string[] = []
  for (const entry of stdout.split('\0')) {
    const key = entry.split('\n')[0]?.trim() ?? ''
    if (key === '') continue
    const name = /^filter\.(.+)\.[^.]+$/.exec(key)?.[1]
    if (name === undefined || !FILTER_NAME.test(name)) return undefined
    if (!names.includes(name)) names.push(name)
  }

  return names
}

/** When a review folder was made, from its name (`…-2086-1792132200000`); undefined for a folder no review made. */
export function reviewDirTime(name: string): number | undefined {
  const at = REVIEW_DIR_NAME.test(name) ? /-\d+-(\d{13})$/.exec(name)?.[1] : undefined

  return at === undefined ? undefined : Number(at)
}

export interface ReviewPaths {
  /** The review's own folder: the copy and the asks; deleted when the review ends. */
  dir: string
  /** The reviewer's working directory: the PR's files, or an empty folder when there is no copy. */
  tree: string
  /** What `git archive` writes, beside the tree. */
  tar: string
  /** Where the relay leaves asks and reads answers. */
  asks: string
}

/** One review's folders: `<root>/<owner>__<repo>-<number>-<ms>`. */
export function reviewPaths(root: string, repo: string, number: number, at: number): ReviewPaths {
  const dir = `${root}/${repoFolder(repo)}-${number}-${at}`

  return { dir, tree: `${dir}/tree`, tar: `${dir}/pr.tar`, asks: `${dir}/asks` }
}

/** `claude` on PATH first, then where its installers put it. */
export function claudeCandidates(home: string | undefined): string[] {
  const base = home?.trim() ? home.trim().replace(/\/+$/, '') : undefined

  return ['claude', ...(base === undefined ? [] : CLAUDE_HOME_PATHS.map(path => `${base}/${path}`)), ...CLAUDE_SYSTEM_PATHS]
}

/** A 40 or 64 character commit id. */
export function isCommitSha(value: string | undefined): value is string {
  return value !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
}

/** `'it'\''s'`: one word for `sh`, whatever it holds. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** The relay script inside the plugin's folder. */
export function relayPathOf(pluginRoot: string): string {
  return `${pluginRoot.replace(/\/+$/, '')}/${ASK_RELAY}`
}

export function relayCommand(relay: string, asks: string): string {
  return `sh ${shellQuote(relay)} ${shellQuote(asks)}`
}

/**
 * An allow rule the reviewer may borrow from the session: a WebFetch rule for one domain (or its subdomains) only. A
 * bare WebFetch, any WebSearch rule (it has no domain form) and anything else stay the session's: those calls ask.
 */
export function isBorrowableAllow(rule: string): boolean {
  return BORROWED_ALLOW.test(rule)
}

export interface BorrowedRules {
  allow: string[]
  deny: string[]
}

function stringsAt(value: unknown, key: string): string[] {
  const list = isRecord(value) ? value[key] : undefined

  return Array.isArray(list) ? list.filter((rule): rule is string => typeof rule === 'string' && rule.trim() !== '').map(rule => rule.trim()) : []
}

/**
 * What the reviewer borrows from the session's settings: its WebFetch rules for one domain (none with web lookups
 * off) and every deny rule. Nothing else crosses: no hooks, env, plugins or other allow rules.
 * @example
 * // before: { permissions: { allow: ['Bash(ls)', 'WebFetch', 'WebSearch', 'WebFetch(domain:docs.python.org)'], deny: ['Read(./.env)'] }, hooks: {…} }
 * // after:  { allow: ['WebFetch(domain:docs.python.org)'], deny: ['Read(./.env)'] }
 */
export function borrowedRules(settings: unknown, isWebOn: boolean): BorrowedRules {
  const permissions = isRecord(settings) ? settings.permissions : undefined
  const allow = isWebOn ? stringsAt(permissions, 'allow').filter(isBorrowableAllow) : []

  return { allow: [...new Set(allow)].slice(0, MAX_BORROWED), deny: [...new Set(stringsAt(permissions, 'deny'))] }
}

/** The tools the reviewer has: Read, Grep and Glob, and the web ones when web lookups are on. */
export function reviewerTools(isWebOn: boolean): string[] {
  return isWebOn ? [...REVIEW_TOOLS, ...WEB_TOOLS] : [...REVIEW_TOOLS]
}

export interface ReviewerSettings {
  permissions: { allow: string[]; deny: string[] }
  hooks: { PermissionRequest: Array<{ matcher: string; hooks: Array<{ type: 'command'; command: string; timeout: number }> }> }
}

/** The reviewer's `--settings`: the borrowed rules, the secret-file denies, and the relay as its only hook. */
export function reviewerSettings(relay: string, asks: string, borrowed: BorrowedRules): ReviewerSettings {
  return {
    permissions: { allow: [...borrowed.allow], deny: [...new Set([...SECRET_DENY_RULES, ...borrowed.deny])] },
    hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: relayCommand(relay, asks), timeout: RELAY_TIMEOUT_S }] }] }
  }
}

export interface ReviewerLaunch {
  claude: string
  model: GhReviewModel
  isWebOn: boolean
  settings: ReviewerSettings
  system: string
  /** Folders it may read besides its working directory: the person's skill folders. */
  addDirs: readonly string[]
}

/**
 * `claude -p` with none of the person's settings, plugins or MCP servers, read-only tools, asks that go to the relay
 * hook, and no session kept. The prompt goes on stdin.
 */
export function reviewerArgv(launch: ReviewerLaunch): string[] {
  return [
    launch.claude,
    '-p',
    '--model',
    launch.model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    '--tools',
    reviewerTools(launch.isWebOn).join(','),
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--permission-mode',
    'default',
    '--max-turns',
    String(REVIEW_MAX_TURNS),
    '--settings',
    JSON.stringify(launch.settings),
    '--append-system-prompt',
    launch.system,
    ...launch.addDirs.flatMap(dir => ['--add-dir', dir])
  ]
}

// --- the stream ---

/**
 * The complete lines of what has arrived, and the start of the next one.
 * @example
 * // before: '{"a":1}\n{"b"'
 * // after:  { lines: ['{"a":1}'], rest: '{"b"' }
 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const cut = buffer.lastIndexOf('\n')
  if (cut < 0) return { lines: [], rest: buffer }

  return { lines: buffer.slice(0, cut).split('\n').filter(line => line.trim() !== ''), rest: buffer.slice(cut + 1) }
}

export interface StreamDenial {
  tool: string
  reason: string
}

/** What one stream-json line says, as far as the card and the log care. */
export type StreamEvent =
  | { type: 'init'; tools: string[]; skills: string[] }
  | { type: 'tool'; id: string; name: string; input: unknown }
  | { type: 'text' }
  | { type: 'tool-result'; id: string; isError: boolean; error?: string }
  | { type: 'hook'; event: string; isStarted: boolean }
  | { type: 'denied'; denial: StreamDenial }
  | { type: 'result'; subtype: string; isError: boolean; text: string; turns?: number; costUsd?: number; denials: StreamDenial[] }

function namesAt(value: unknown, key: string): string[] {
  const list = isRecord(value) ? value[key] : undefined
  if (!Array.isArray(list)) return []

  return list.flatMap(entry => (typeof entry === 'string' ? [entry] : (textAt(entry, 'name') ?? [])))
}

function numberAt(value: unknown, key: string): number | undefined {
  const found = isRecord(value) ? value[key] : undefined

  return typeof found === 'number' && Number.isFinite(found) ? found : undefined
}

function contentOf(line: unknown): unknown[] {
  const content = isRecord(line) && isRecord(line.message) ? line.message.content : undefined

  return Array.isArray(content) ? content : []
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content.map(part => textAt(part, 'text') ?? '').join(' ')
}

function denialOf(entry: unknown): StreamDenial {
  return { tool: drawable(textAt(entry, 'tool_name') ?? 'a tool'), reason: drawable(textAt(entry, 'decision_reason') ?? textAt(entry, 'reason') ?? 'denied') }
}

function systemEvent(line: Record<string, unknown>): StreamEvent[] {
  const subtype = textAt(line, 'subtype')
  if (subtype === 'init') return [{ type: 'init', tools: namesAt(line, 'tools'), skills: namesAt(line, 'skills') }]
  if (subtype === 'hook_started' || subtype === 'hook_response') {
    return [{ type: 'hook', event: textAt(line, 'hook_event') ?? textAt(line, 'hook_event_name') ?? '', isStarted: subtype === 'hook_started' }]
  }
  if (subtype === 'permission_denied') return [{ type: 'denied', denial: denialOf(line) }]

  return []
}

function resultEvent(line: Record<string, unknown>): StreamEvent {
  const denials = Array.isArray(line.permission_denials) ? line.permission_denials.map(denialOf) : []
  const turns = numberAt(line, 'num_turns')
  const costUsd = numberAt(line, 'total_cost_usd')

  return {
    type: 'result',
    subtype: textAt(line, 'subtype') ?? 'unknown',
    isError: line.is_error === true,
    text: typeof line.result === 'string' ? line.result : '',
    ...(turns === undefined ? {} : { turns }),
    ...(costUsd === undefined ? {} : { costUsd }),
    denials
  }
}

/** One stream-json line read: a line that is not JSON, or says nothing the panel uses, is no event. */
export function readStreamLine(text: string): StreamEvent[] {
  let line: unknown
  try {
    line = JSON.parse(text)
  } catch {
    return []
  }
  if (!isRecord(line)) return []
  if (line.type === 'system') return systemEvent(line)
  if (line.type === 'result') return [resultEvent(line)]
  if (line.type === 'assistant') {
    return contentOf(line).flatMap((block): StreamEvent[] => {
      if (textAt(block, 'type') === 'tool_use') return [{ type: 'tool', id: textAt(block, 'id') ?? '', name: textAt(block, 'name') ?? 'a tool', input: isRecord(block) ? block.input : undefined }]

      return textAt(block, 'type') === 'text' ? [{ type: 'text' }] : []
    })
  }
  if (line.type === 'user') {
    return contentOf(line).flatMap((block): StreamEvent[] => {
      if (textAt(block, 'type') !== 'tool_result' || !isRecord(block)) return []
      const isError = block.is_error === true

      return [{ type: 'tool-result', id: textAt(block, 'tool_use_id') ?? '', isError, ...(isError ? { error: drawable(resultText(block.content)).slice(0, MAX_WORDS_CHARS) } : {}) }]
    })
  }

  return []
}

/** The reviewer's working directory and the person's home, which step words name paths from. */
export interface StepPlaces {
  tree?: string
  home?: string
}

function shortPathOf(path: string, places: StepPlaces): string {
  if (places.tree !== undefined && path.startsWith(`${places.tree}/`)) return path.slice(places.tree.length + 1)
  if (places.home !== undefined && path.startsWith(`${places.home}/`)) return `~/${path.slice(places.home.length + 1)}`

  return path
}

function hostOf(url: string): string {
  return /^[a-z]+:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url
}

function words(text: string): string {
  const clean = drawable(text).trim()

  return clean.length <= MAX_WORDS_CHARS ? clean : `${clean.slice(0, MAX_WORDS_CHARS - 1)}…`
}

/** What a tool call does, in plain words: `reading src/a.ts`, `searching for useFoo`, `fetching docs.python.org`. */
export function stepWords(tool: string, input: unknown, places: StepPlaces): string {
  const path = textAt(input, 'file_path') ?? textAt(input, 'path')
  const where = path === undefined ? '' : ` in ${shortPathOf(path, places)}`
  switch (tool) {
    case 'Read':
      return words(`reading ${path === undefined ? 'a file' : shortPathOf(path, places)}`)
    case 'Grep':
      return words(`searching for ${textAt(input, 'pattern') ?? 'text'}${where}`)
    case 'Glob':
      return words(`looking for ${textAt(input, 'pattern') ?? 'files'}${where}`)
    case 'WebFetch':
      return words(`fetching ${hostOf(textAt(input, 'url') ?? 'a page')}`)
    case 'WebSearch':
      return words(`searching the web for "${textAt(input, 'query') ?? ''}"`)
    default:
      return words(`using ${tool}`)
  }
}

// --- the asks ---

/** `ask-1792331803-94632.json` → `1792331803-94632`; undefined for anything else (a file still being written). */
export function askIdOf(fileName: string): string | undefined {
  return ASK_FILE.exec(fileName)?.[1]
}

/**
 * When the relay wrote the ask, from its id's epoch seconds, which its 10 minutes count from; never later than `now`,
 * when the panel saw it.
 * @example
 * // ('1792331803-94632', 1792331810000) → 1792331803000
 */
export function askTimeOf(id: string, now: number): number {
  const seconds = Number(id.split('-')[0])

  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, now) : now
}

/** The file or folder a Read, Grep or Glob ask names, as the reviewer spelled it. */
export function askPathOf(text: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(text)
    const input = isRecord(raw) ? raw.tool_input : undefined

    return textAt(input, 'file_path') ?? textAt(input, 'path')
  } catch {
    return undefined
  }
}

/** What an ask wants, in plain words: `fetch https://docs.python.org/3/`, `read ~/notes.md`. */
function askWords(tool: string, input: unknown, places: StepPlaces): string {
  const path = textAt(input, 'file_path') ?? textAt(input, 'path')
  if (tool === 'WebFetch') return words(`fetch ${textAt(input, 'url') ?? 'a page'}`)
  if (tool === 'WebSearch') return words(`search the web for "${textAt(input, 'query') ?? ''}"`)
  if (tool === 'Read') return words(`read ${path === undefined ? 'a file' : shortPathOf(path, places)}`)
  if (path !== undefined) return words(`search ${shortPathOf(path, places)}`)

  return words(`use ${tool}`)
}

/** The first rule set Claude Code offered to allow for the rest of the session: what Allow … for this review adds. */
function offeredRules(suggestions: unknown): GhAskRule[] {
  if (!Array.isArray(suggestions)) return []
  for (const suggestion of suggestions) {
    if (!isRecord(suggestion) || suggestion.type !== 'addRules' || !Array.isArray(suggestion.rules)) continue
    const rules = suggestion.rules.flatMap((rule): GhAskRule[] => {
      const toolName = textAt(rule, 'toolName')
      const ruleContent = textAt(rule, 'ruleContent')

      return toolName === undefined ? [] : [{ toolName, ...(ruleContent === undefined ? {} : { ruleContent }) }]
    })
    if (rules.length > 0) return rules
  }

  return []
}

/** `docs.python.org` for a WebFetch domain rule, else the rule as written: `Read(//Users/t/notes/**)`. */
export function ruleLabel(rules: readonly GhAskRule[]): string {
  const [first] = rules
  if (first === undefined) return ''
  const domain = first.toolName === 'WebFetch' ? /^domain:(.+)$/.exec(first.ruleContent ?? '')?.[1] : undefined
  const label = domain ?? (first.ruleContent === undefined ? first.toolName : `${first.toolName}(${first.ruleContent})`)

  return words(rules.length > 1 ? `${label} +${rules.length - 1}` : label)
}

/** An ask file the relay wrote, read; undefined when it is not one. `askedAt` is the panel's to set. */
export function parseAskFile(id: string, text: string, places: StepPlaces): Omit<GhReviewAsk, 'askedAt'> | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  const tool = drawable(textAt(raw, 'tool_name') ?? 'a tool')
  const rules = offeredRules(raw.permission_suggestions)

  return { id, tool, what: askWords(tool, raw.tool_input, places), ...(rules.length > 0 ? { rules, ruleLabel: ruleLabel(rules) } : {}) }
}

export const DENIED_MESSAGE = 'The person denied this in the ClaudeDockula panel. Carry on without it.'

/**
 * The relay's answer file: allow once, allow the offered rules for this review only (destination `session`, never a
 * settings file), or deny.
 */
export function askAnswerJson(answer: AskAnswerKind, ask: Pick<GhReviewAsk, 'rules'>): string {
  const rules = ask.rules ?? []
  let decision: Record<string, unknown> = { behavior: 'allow' }
  if (answer === 'deny') decision = { behavior: 'deny', message: DENIED_MESSAGE }
  else if (answer === 'review' && rules.length > 0) decision = { behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules, behavior: 'allow', destination: 'session' }] }

  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })
}

/** When the card stops taking an answer to an ask: just before the relay denies it. */
export function askDeadline(askedAt: number): number {
  return askedAt + ASK_TIMEOUT_MS - ASK_MARGIN_MS
}

/** An ask still waiting for the person: not answered, and the relay is not about to deny it for lack of an answer. */
export function isAskPending(ask: GhReviewAsk, now: number): boolean {
  return ask.answer === undefined && now < askDeadline(ask.askedAt)
}

/** The asks with the ones past their 10 minutes marked as denied for lack of an answer; the same list when none is. */
export function withTimedOutAsks(asks: readonly GhReviewAsk[], now: number): GhReviewAsk[] {
  const isLate = (ask: GhReviewAsk) => ask.answer === undefined && now >= askDeadline(ask.askedAt)

  return asks.some(isLate) ? asks.map(ask => (isLate(ask) ? { ...ask, answer: 'timeout', answeredAt: askDeadline(ask.askedAt) } : ask)) : [...asks]
}

// --- when a review finishes ---

/** The person's notification channel, from the `/config` rows; undefined when no row names it. */
export function notifyChannelOf(rows: unknown): string | undefined {
  if (!Array.isArray(rows)) return undefined
  const row = rows.find(one => textAt(one, 'key') === 'preferredNotifChannel') ?? rows.find(one => isRecord(one) && Array.isArray(one.options) && one.options.includes('terminal_bell'))
  const value = isRecord(row) ? row.value : undefined

  return typeof value === 'string' ? value : undefined
}

export interface DoneChoices {
  choices: Array<{ value: GhReviewDone; label: string }>
  /** Why a choice is missing, or what the one offered does. */
  note?: string
}

/**
 * What "When it finishes" offers on this client: a notice always, and what `$.ui.notify` does through the person's own
 * notification channel (/config): the terminal bell, a system notification, or nothing when they turned them off.
 */
export function doneChoices(channel: string | undefined): DoneChoices {
  const notice = { value: 'notice' as const, label: 'Notice only' }
  if (channel === 'notifications_disabled') return { choices: [notice], note: 'Notifications are off in /config.' }
  if (channel === 'terminal_bell') return { choices: [notice, { value: 'bell', label: 'Notice + terminal bell' }] }
  if (channel === 'iterm2' || channel === 'iterm2_with_bell' || channel === 'kitty' || channel === 'ghostty') {
    return { choices: [notice, { value: 'notify', label: 'Notice + system notification' }] }
  }

  return { choices: [notice, { value: 'notify', label: 'Notice + notification' }], note: "The bell or a system notification, as /config's notifications pick." }
}

/** Whether the setting asks for more than the notice; a choice this client no longer offers still notifies. */
export function wantsNotification(done: GhReviewDone | undefined): boolean {
  return done === 'bell' || done === 'notify'
}

// --- the log ---

export type StepStatus = 'running' | 'ok' | 'error'

export interface LogStep {
  id: string
  at: number
  tool: string
  words: string
  status: StepStatus
  error?: string
}

export interface LogAsk {
  id: string
  at: number
  tool: string
  what: string
  /** `ended`: still waiting when the review ended. */
  answer?: GhReviewAsk['answer'] | 'ended'
  answeredAt?: number
}

export interface ReviewLog {
  title: string
  number: number
  url: string
  /** This log and the raw stream beside it. */
  logPath: string
  streamPath: string
  /** What the reviewer's environment sets over the session's. */
  env: Record<string, string>
  startedAt: number
  model: GhReviewModel
  isWebOn: boolean
  /** Where the reviewer worked: the copy at a commit, or why there was none. */
  copy: string
  /** Every folder it could read. */
  readable: string[]
  argv: string[]
  promptChars: number
  steps: LogStep[]
  asks: LogAsk[]
  denials: Array<StreamDenial & { at: number }>
  notes: string[]
  stderr: string
  end?: { at: number; status: string; turns?: number; costUsd?: number; exit: string }
}

function clockOf(at: number): string {
  return new Date(at).toISOString().slice(11, 19)
}

function stampOf(at: number): string {
  return `${new Date(at).toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

const ANSWER_WORDS: Record<NonNullable<LogAsk['answer']>, string> = {
  once: 'allowed once',
  review: 'allowed for this review',
  deny: 'denied',
  timeout: 'no answer in 10 minutes: denied',
  ended: 'still waiting when the review ended'
}

function shellWord(token: string): string {
  return token === '' || /[\s"'$`\\]/.test(token) ? shellQuote(token) : token
}

/** The command as the log shows it: the environment set over the session's, then the argv, the long values named. */
function shownCommand(env: Readonly<Record<string, string>>, argv: readonly string[]): string {
  const shown = argv.map((token, index) => {
    const flag = argv[index - 1]
    if (flag === '--settings') return '<settings below>'
    if (flag === '--append-system-prompt') return '<instructions below>'

    return shellWord(token)
  })

  return [...Object.entries(env).map(([name, value]) => `${name}=${shellWord(value)}`), ...shown].join(' ')
}

function fenceOf(text: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), run => run[0].length))

  return '`'.repeat(longest + 1)
}

function block(text: string, info = ''): string {
  const fence = fenceOf(text)

  return `${fence}${info}\n${text}\n${fence}`
}

function stepOutcome(step: LogStep): string {
  if (step.status === 'error') return `error: ${step.error ?? 'failed'}`

  return step.status === 'ok' ? 'ok' : 'no result'
}

/** The readable log: what ran, what it could read, each step, each ask and its answer, every denial, how it ended. */
export function reviewLogMarkdown(log: ReviewLog): string {
  const valueAfter = (flag: string) => log.argv[log.argv.indexOf(flag) + 1] ?? ''
  const settings = valueAfter('--settings')
  let prettySettings = settings
  try {
    prettySettings = JSON.stringify(JSON.parse(settings), null, 2)
  } catch {
    // shown as it was passed
  }
  const steps = log.steps.map(step => `- ${clockOf(step.at)} ${step.tool}: ${step.words} — ${stepOutcome(step)}`)
  const asks = log.asks.map(ask => {
    const answered = ask.answer === undefined ? 'waiting' : `${ANSWER_WORDS[ask.answer]}${ask.answeredAt === undefined ? '' : ` at ${clockOf(ask.answeredAt)}`}`

    return `- ${clockOf(ask.at)} ${ask.tool}: ${ask.what} — ${answered}`
  })
  const denials = log.denials.map(denial => `- ${clockOf(denial.at)} ${denial.tool}: ${denial.reason}`)
  const end = log.end
  const endLines = end === undefined ? ['Still running.'] : [
    `${stampOf(end.at)}: ${end.status}`,
    [end.turns === undefined ? '' : `${end.turns} turns`, end.costUsd === undefined ? '' : `$${end.costUsd.toFixed(4)}`, `exit ${end.exit}`].filter(part => part !== '').join(' · ')
  ]

  return [
    `# Review log: ${drawable(log.title)} (#${log.number})`,
    '',
    log.url,
    '',
    `Started ${stampOf(log.startedAt)} · Claude ${modelName(log.model)} · web lookups ${log.isWebOn ? 'on' : 'off'}`,
    '',
    `Code: ${log.copy}`,
    '',
    `This log: ${log.logPath}`,
    `Raw stream (every line the reviewer wrote): ${log.streamPath}`,
    '',
    '## Could read',
    '',
    ...log.readable.map(dir => `- ${dir}`),
    '',
    '## Command',
    '',
    block(shownCommand(log.env, log.argv), 'sh'),
    '',
    `The prompt (${log.promptChars} characters: the pull request's discussion and diff) went on stdin.`,
    '',
    '### Settings',
    '',
    block(prettySettings, 'json'),
    '',
    '### Instructions',
    '',
    block(valueAfter('--append-system-prompt')),
    '',
    `## Steps (${log.steps.length})`,
    '',
    ...(steps.length > 0 ? steps : ['None.']),
    '',
    `## Asks (${log.asks.length})`,
    '',
    ...(asks.length > 0 ? asks : ['None.']),
    '',
    `## Permission denials (${log.denials.length})`,
    '',
    ...(denials.length > 0 ? denials : ['None.']),
    ...(log.notes.length > 0 ? ['', '## Notes', '', ...log.notes.map(note => `- ${note}`)] : []),
    '',
    '## End',
    '',
    ...endLines,
    ...(log.stderr.trim() === '' ? [] : ['', '### stderr', '', block(log.stderr.trim())]),
    ''
  ].join('\n')
}
