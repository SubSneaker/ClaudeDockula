import type { McpToolResult } from 'claude-code'

import type { JiraIssue, JiraSite } from '../../../types'
import { findTicketKey } from '../../settings'
import { htmlToMarkdown, looksLikeHtml } from './html'

const SMART_LINK_TAG = /<\/?custom\b[^>]*>/g
const MARKDOWN_HEADING = /^\s{0,3}#{1,6}\s/
const BOLD_LINE = /^\s*\*\*[^*]+\*\*:?\s*$/
const ACCEPTANCE_HEADING = /^\s{0,3}(?:#{1,6}\s+|\*\*|__)?\s*acceptance criteria\b/i
const EXCERPT_MAX_CHARS = 3000
const ERROR_MAX_CHARS = 160

export type JiraIssueParse = { isOk: true; issue: JiraIssue } | { isOk: false; error: string }

export interface DescriptionExcerpt {
  text: string
  isAcceptanceCriteria: boolean
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function valueAt(value: unknown, path: readonly string[]): unknown {
  let at = value
  for (const step of path) {
    if (!isRecord(at)) return undefined
    at = at[step]
  }
  return at
}

export function textAt(value: unknown, ...path: string[]): string | undefined {
  const found = valueAt(value, path)
  return typeof found === 'string' && found.trim() !== '' ? found.trim() : undefined
}

/** The ticket key in a branch name: `ABC-101/add-export-button` → `ABC-101`. */
export function ticketKeyFromBranch(branch: string, ticketPattern?: string): string | undefined {
  return findTicketKey(branch, ticketPattern)
}

function firstText(result: McpToolResult): string | undefined {
  const blocks = Array.isArray(result.content) ? result.content : []

  return blocks.find(block => block.type === 'text' && typeof block.text === 'string')?.text
}

function parseJsonText(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The JSON an MCP result carries, unwrapped from the `{ data }` envelope the claude.ai connector adds. */
export function readMcpJson(result: McpToolResult): unknown {
  const parsed = parseJsonText(firstText(result)) ?? result.structuredContent

  return isRecord(parsed) && 'data' in parsed ? parsed.data : parsed
}

/** One short line saying why an MCP call failed. */
export function mcpErrorText(result: McpToolResult): string {
  const text = firstText(result) ?? ''
  const parsed = parseJsonText(text)
  const listed = valueAt(parsed, ['errorMessages'])
  const firstListed = Array.isArray(listed) ? listed.find((item): item is string => typeof item === 'string') : undefined
  const message = firstListed ?? textAt(parsed, 'message') ?? textAt(parsed, 'error') ?? text
  const line = message.split('\n').find(part => part.trim() !== '')?.trim() ?? 'Jira returned an error'

  return line.length > ERROR_MAX_CHARS ? `${line.slice(0, ERROR_MAX_CHARS - 1)}…` : line
}

/**
 * The Jira sites an Atlassian `getAccessibleAtlassianResources` result lists, in the order given.
 * @example
 * // before (standard): [{ id: '0f7b…', url: 'https://acme.atlassian.net', name: 'acme', scopes: […] }]
 * // before (gateway):  { data: { resources: [{ cloudId: '0f7b…', url: 'https://acme.atlassian.net', products: […] }] } }
 * // after:             [{ cloudId: '0f7b…', url: 'https://acme.atlassian.net', name: 'acme' }]
 */
export function parseAtlassianSites(result: McpToolResult): JiraSite[] {
  if (result.isError) return []
  const json = readMcpJson(result)
  const listed = Array.isArray(json) ? json : valueAt(json, ['resources'])
  const resources: unknown[] = Array.isArray(listed) ? listed : []
  const sites: JiraSite[] = []
  for (const resource of resources) {
    const cloudId = textAt(resource, 'cloudId') ?? textAt(resource, 'id')
    const url = textAt(resource, 'url')
    const name = textAt(resource, 'name')
    if (cloudId && url) sites.push({ cloudId, url: url.replace(/\/+$/, ''), ...(name ? { name } : {}) })
  }

  return sites
}

function stripMarkup(description: string): string {
  const withoutSmartLinks = description.replace(SMART_LINK_TAG, '')

  return looksLikeHtml(withoutSmartLinks) ? htmlToMarkdown(withoutSmartLinks) : withoutSmartLinks
}

function trimBlankLines(lines: string[]): string {
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The lines under an "Acceptance criteria" heading, up to the next heading. */
function acceptanceCriteriaLines(lines: string[]): string[] {
  const start = lines.findIndex(line => ACCEPTANCE_HEADING.test(line))
  if (start === -1) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => MARKDOWN_HEADING.test(line) || BOLD_LINE.test(line))

  return end === -1 ? rest : rest.slice(0, end)
}

/**
 * What the panel shows of a markdown description: its acceptance criteria when it has them, else all of it.
 * Smart-link tags are dropped; the text is capped so the state stays small.
 * @example
 * // before: 'Context.\n\n### Acceptance criteria\n\n* A\n* B\n\n### References\n* <custom data-type="smartlink">https://x</custom>'
 * // after:  { text: '* A\n* B', isAcceptanceCriteria: true }
 */
export function pickDescriptionExcerpt(description: string): DescriptionExcerpt | undefined {
  const lines = stripMarkup(description).split('\n')
  const criteria = trimBlankLines(acceptanceCriteriaLines(lines))
  const isAcceptanceCriteria = criteria !== ''
  const text = isAcceptanceCriteria ? criteria : trimBlankLines(lines)
  if (text === '') return undefined

  return {
    text: text.length > EXCERPT_MAX_CHARS ? `${text.slice(0, EXCERPT_MAX_CHARS - 1)}…` : text,
    isAcceptanceCriteria
  }
}

/**
 * Reads a `getJiraIssue` MCP result (either Atlassian server's shape) into what the panel shows.
 * @example
 * // before: { content: [{ type: 'text', text: '{"key":"ABC-101","fields":{"summary":"Add export button",
 * //           "status":{"name":"IN REVIEW"},"assignee":{"displayName":"Alex"},"priority":{"name":"Medium"},
 * //           "issuetype":{"name":"Task"},"description":"After ABC-100…"}}' }], isError: false }
 * // after:  { isOk: true, issue: { key: 'ABC-101', summary: 'Add export button', status: 'IN REVIEW', assignee: 'Alex',
 * //           priority: 'Medium', type: 'Task', excerpt: 'After ABC-100…', isAcceptanceCriteria: false,
 * //           url: 'https://acme.atlassian.net/browse/ABC-101' } }
 */
export function parseJiraIssue(result: McpToolResult, siteUrl: string): JiraIssueParse {
  if (result.isError) return { isOk: false, error: mcpErrorText(result) }
  const json = readMcpJson(result)
  const key = textAt(json, 'key')
  const fields = valueAt(json, ['fields'])
  if (!key || !isRecord(fields)) return { isOk: false, error: 'Jira answered without an issue' }
  const description = fields.description
  const excerpt = typeof description === 'string' ? pickDescriptionExcerpt(description) : undefined

  return {
    isOk: true,
    issue: {
      key,
      summary: textAt(fields, 'summary') ?? '(no summary)',
      status: textAt(fields, 'status', 'name'),
      assignee: textAt(fields, 'assignee', 'displayName'),
      priority: textAt(fields, 'priority', 'name'),
      type: textAt(fields, 'issuetype', 'name'),
      excerpt: excerpt?.text,
      isAcceptanceCriteria: excerpt?.isAcceptanceCriteria ?? false,
      url: `${siteUrl}/browse/${key}`
    }
  }
}

/**
 * Cuts markdown to the rows a narrow column has, estimating each line's wrapped height.
 * @example
 * // before: fitMarkdown('* one\n* two\n* three\n* four', 40, 3)
 * // after:  '* one\n* two\n…'
 */
export function fitMarkdown(text: string, columns: number, maxRows: number): string {
  const width = Math.max(1, columns)
  const lines = text.split('\n')
  const rowsOf = (line: string): number => Math.max(1, Math.ceil(line.length / width))
  const total = lines.reduce((sum, line) => sum + rowsOf(line), 0)
  if (total <= maxRows) return text

  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    if (used + rowsOf(line) > maxRows - 1) break
    kept.push(line)
    used += rowsOf(line)
  }
  if (kept.length === 0) {
    const room = Math.max(1, (maxRows - 1) * width - 1)

    return `${(lines[0] ?? '').slice(0, room)}…`
  }

  return `${trimBlankLines(kept)}\n…`
}
