import type { CheckSetting, JiraFlavour, JiraServerInfo, JiraSettings, JiraSite, RepoSettings, Settings } from '../types'

// Pure helpers for what the plugin asks the person once and saves in `$.store`; they take no `$`.

export const SETTINGS_KEY = 'settings'
/** The band text of a panel waiting for its first setup. */
export const SET_UP_SUMMARY = 'set up'
export const DEFAULT_TICKET_PATTERN = '[A-Z][A-Z0-9]+-\\d+'
export const DEFAULT_BRANCH_TEMPLATE = '{key}/'
/** Tickets assigned to the person that are still open or closed in the last two weeks. */
export const DEFAULT_JQL = 'assignee = currentUser() AND (resolution = Unresolved OR resolved >= -14d) ORDER BY updated DESC'

const CHECK_ID = /^[a-z0-9-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Where one repo's settings live in the store. */
export function repoSettingsKey(root: string): string {
  return `${SETTINGS_KEY}:${root}`
}

function parseSite(value: unknown): JiraSite | undefined {
  if (!isRecord(value)) return undefined
  const cloudId = nonBlank(value.cloudId)
  const url = nonBlank(value.url)
  if (!cloudId || !url) return undefined
  const name = nonBlank(value.name)

  return { cloudId, url, ...(name ? { name } : {}) }
}

function parseJiraSettings(value: unknown): JiraSettings | undefined {
  if (!isRecord(value)) return undefined
  const server = nonBlank(value.server)
  const site = parseSite(value.site)
  const flavour: JiraFlavour | undefined = value.flavour === 'standard' || value.flavour === 'gateway' ? value.flavour : undefined
  if (!server || !site || !flavour) return undefined
  const boardServer = nonBlank(value.boardServer)
  const jql = nonBlank(value.jql)

  return { server, flavour, site, ...(boardServer ? { boardServer } : {}), ...(jql ? { jql } : {}) }
}

/**
 * The global settings out of whatever the store holds; a value that is not usable counts as not set.
 * @example
 * // before: { jira: { server: 'x' }, branchTemplate: 'feat/{key}-', ticketPattern: 7 }
 * // after:  { branchTemplate: 'feat/{key}-' }
 */
export function parseSettings(raw: unknown): Settings {
  if (!isRecord(raw)) return {}
  const jira = parseJiraSettings(raw.jira)
  const branchTemplate = nonBlank(raw.branchTemplate)
  const ticketPattern = nonBlank(raw.ticketPattern)

  return {
    ...(jira ? { jira } : {}),
    ...(branchTemplate ? { branchTemplate } : {}),
    ...(ticketPattern ? { ticketPattern } : {})
  }
}

function parseCheck(value: unknown): CheckSetting | undefined {
  if (!isRecord(value)) return undefined
  const id = nonBlank(value.id)
  const name = nonBlank(value.name)
  const argv = Array.isArray(value.argv) ? value.argv.filter((part): part is string => typeof part === 'string' && part !== '') : []
  if (!id || !CHECK_ID.test(id) || !name || argv.length === 0) return undefined

  return { id, name, argv }
}

/**
 * One repo's settings out of the store. `checks` stays absent unless a list was saved, so "not set up" and
 * "set up with none" differ.
 * @example
 * // before: { checks: [{ id: 'lint', name: 'Lint', argv: ['pnpm', 'run', 'lint'] }, { id: 'Bad Id' }] }
 * // after:  { checks: [{ id: 'lint', name: 'Lint', argv: ['pnpm', 'run', 'lint'] }] }
 */
export function parseRepoSettings(raw: unknown): RepoSettings {
  if (!isRecord(raw) || !Array.isArray(raw.checks)) return {}
  const seen = new Set<string>()
  const checks: CheckSetting[] = []
  for (const entry of raw.checks) {
    const check = parseCheck(entry)
    if (!check || seen.has(check.id)) continue
    seen.add(check.id)
    checks.push(check)
  }

  return { checks }
}

export interface TicketPattern {
  regex: RegExp
  /** False when the saved pattern could not be used and the default stands in. */
  isValid: boolean
}

/**
 * The expression that finds a ticket key; a missing pattern is the default, an unusable one falls back to it.
 * @example
 * // before: '[A-Z]{2,4}-\\d+'  /  '(['
 * // after:  { regex: /[A-Z]{2,4}-\d+/, isValid: true }  /  { regex: /[A-Z][A-Z0-9]+-\d+/, isValid: false }
 */
export function compileTicketPattern(pattern?: string): TicketPattern {
  const fallback = { regex: new RegExp(DEFAULT_TICKET_PATTERN), isValid: true }
  const source = pattern?.trim()
  if (!source) return fallback
  try {
    const regex = new RegExp(source)

    return regex.test('') ? { ...fallback, isValid: false } : { regex, isValid: true }
  } catch {
    return { ...fallback, isValid: false }
  }
}

/**
 * The ticket key in a branch name.
 * @example
 * // before: 'ABC-101/add-export-button'
 * // after:  'ABC-101'
 */
export function findTicketKey(branch: string, pattern?: string): string | undefined {
  const found = compileTicketPattern(pattern).regex.exec(branch)?.[0]

  return found === undefined || found === '' ? undefined : found
}

/**
 * The command "New branch" puts in the prompt box.
 * @example
 * // before: 'ABC-123', 'feature/{key}-'
 * // after:  '! git switch -c feature/ABC-123-'
 */
export function fillBranchTemplate(key: string, template?: string): string {
  const base = template?.trim() || DEFAULT_BRANCH_TEMPLATE

  return `! git switch -c ${base.split('{key}').join(key)}`
}

const MCP_TOOL = /^mcp__(.+?)__(.+)$/

/**
 * The connected servers that expose Jira tools, and how each is spoken to: a server with `executeRead` is a
 * gateway, any other is standard.
 * @example
 * // before: ['Read', 'mcp__a__getJiraIssue', 'mcp__a__searchJiraIssuesUsingJql', 'mcp__b__getJiraIssue',
 * //          'mcp__b__searchJiraIssuesUsingJql', 'mcp__b__executeRead', 'mcp__c__send']
 * // after:  [{ name: 'a', flavour: 'standard' }, { name: 'b', flavour: 'gateway' }]
 */
export function detectJiraServers(toolNames: readonly string[]): JiraServerInfo[] {
  const byServer = new Map<string, Set<string>>()
  for (const toolName of toolNames) {
    const match = MCP_TOOL.exec(toolName)
    const server = match?.[1]
    const tool = match?.[2]
    if (!server || !tool) continue
    byServer.set(server, (byServer.get(server) ?? new Set()).add(tool))
  }

  return [...byServer.entries()]
    .filter(([, tools]) => tools.has('getJiraIssue') && tools.has('searchJiraIssuesUsingJql'))
    .map(([name, tools]): JiraServerInfo => ({ name, flavour: tools.has('executeRead') ? 'gateway' : 'standard' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The server the boards are read from: the chosen one when it is a gateway, else the first other gateway.
 * @example
 * // before: [{ name: 'a', flavour: 'standard' }, { name: 'b', flavour: 'gateway' }], 'a'
 * // after:  'b'
 */
export function pickBoardServer(servers: readonly JiraServerInfo[], chosen: string): string | undefined {
  const own = servers.find(server => server.name === chosen)
  if (own?.flavour === 'gateway') return own.name

  return servers.find(server => server.flavour === 'gateway')?.name
}

/** The commands that open a link, tried in order: macOS, Linux, Windows. */
export function openCommands(url: string): string[][] {
  return [
    ['open', url],
    ['xdg-open', url],
    ['cmd', '/c', 'start', '', url]
  ]
}
