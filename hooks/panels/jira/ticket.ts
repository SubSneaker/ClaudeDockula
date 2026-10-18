import type { McpToolResult } from 'claude-code'

import type { JiraIssue, JiraTicket } from '../../../types'
import { fillBranchTemplate } from '../../settings'
import { dropControlChars, htmlToMarkdown, looksLikeHtml } from './html'
import { isRecord, mcpErrorText, readMcpJson, textAt, valueAt } from './parse'

const EXCERPT_LINES = 2
const EXCERPT_LINE_CHARS = 200
const CUSTOM_TAG = /<\/?custom\b[^>]*>/g
const BLOB_IMAGE = /!\[[^\]]*\]\(blob:[^)]*\)/g
const MARKDOWN_LINK = /\[([^\]]+)\]\([^)]+\)/g
const EMPHASIS = /(\*\*|__|`)/g
const HEADING = /^\s{0,3}#{1,6}\s/
const LIST_MARKER = /^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|heic)$/i

export type TicketSearchParse = { isOk: true; tickets: JiraTicket[] } | { isOk: false; error: string }

export interface LinkedTicket {
  key: string
  summary?: string
  status?: string
}

export interface IssueLink extends LinkedTicket {
  /** How this ticket relates to the linked one, as Jira words it: `implements`, `is blocked by`. */
  relation: string
}

export interface TicketAttachment {
  filename: string
  url: string
  isImage: boolean
}

export interface TicketComment {
  author: string
  /** `2026-07-28`. */
  date?: string
  body: string
}

/** Everything the prompt gets for one ticket. */
export interface FullTicket {
  key: string
  summary: string
  url: string
  status?: string
  priority?: string
  type?: string
  labels: string[]
  components: string[]
  description?: string
  parent?: LinkedTicket
  subtasks: LinkedTicket[]
  links: IssueLink[]
  attachments: TicketAttachment[]
  comments: TicketComment[]
  /** How many comments the ticket has, when Jira said and it is more than `comments` holds. */
  commentTotal?: number
}

export type FullTicketParse = { isOk: true; ticket: FullTicket } | { isOk: false; error: string }

function listAt(value: unknown, ...path: string[]): unknown[] {
  const found = valueAt(value, path)

  return Array.isArray(found) ? found : []
}

/**
 * Jira's markdown without its smart-link and mention tags or control characters, and with pasted blob images
 * (unreadable) named; a body the connector sent as HTML is turned into markdown first.
 */
function cleanJiraMarkdown(text: string, isHtml = false): string {
  const markdown = isHtml || looksLikeHtml(text) ? htmlToMarkdown(text) : text

  return dropControlChars(markdown).replace(CUSTOM_TAG, '').replace(BLOB_IMAGE, '[image]').trim()
}

/**
 * The description's first lines of prose for an open card: headings skipped, markdown marks dropped.
 * @example
 * // before: '## Background\n\nDuring demos, loading a **file** takes too long.\n\n## Goal\n\n* Pick [a table](https://x).'
 * // after:  ['During demos, loading a file takes too long.', '• Pick a table.']
 */
export function excerptLines(description: string): string[] {
  return cleanJiraMarkdown(description)
    .split('\n')
    .filter(line => line.trim() !== '' && !HEADING.test(line))
    .slice(0, EXCERPT_LINES)
    .map(line => {
      const plain = line.replace(LIST_MARKER, '• ').replace(MARKDOWN_LINK, '$1').replace(EMPHASIS, '').trim()

      return plain.length > EXCERPT_LINE_CHARS ? `${plain.slice(0, EXCERPT_LINE_CHARS - 1)}…` : plain
    })
}

function parseTicket(issue: unknown, siteUrl: string): JiraTicket | undefined {
  const key = textAt(issue, 'key')
  const fields = valueAt(issue, ['fields'])
  if (!key || !isRecord(fields)) return undefined
  const description = fields.description
  const excerpt = typeof description === 'string' ? excerptLines(description) : []

  return {
    key,
    summary: textAt(fields, 'summary') ?? '(no summary)',
    status: textAt(fields, 'status', 'name'),
    statusId: textAt(fields, 'status', 'id'),
    statusCategory: textAt(fields, 'status', 'statusCategory', 'key'),
    priority: textAt(fields, 'priority', 'name'),
    type: textAt(fields, 'issuetype', 'name'),
    updated: textAt(fields, 'updated'),
    ...(excerpt.length > 0 ? { excerpt } : {}),
    url: `${siteUrl}/browse/${key}`
  }
}

/**
 * Reads a `searchJiraIssuesUsingJql` result (either server's shape) into the board's tickets.
 * @example
 * // before: { issues: [{ key: 'ABC-102', fields: { summary: 'Pick a table', status: { name: 'To Do', id: '10001',
 * //           statusCategory: { key: 'new' } }, priority: { name: 'Medium' }, updated: '2026-10-13T18:23:47.837+0900' } }] }
 * // after:  { isOk: true, tickets: [{ key: 'ABC-102', summary: 'Pick a table', status: 'To Do', statusId: '10001',
 * //           statusCategory: 'new', priority: 'Medium', updated: '2026-10-13T18:23:47.837+0900', url: '…/browse/ABC-102' }] }
 */
export function parseTicketSearch(result: McpToolResult, siteUrl: string): TicketSearchParse {
  if (result.isError) return { isOk: false, error: mcpErrorText(result) }
  const json = readMcpJson(result)
  const issues = valueAt(json, ['issues'])
  if (!Array.isArray(issues)) return { isOk: false, error: 'Jira answered without a list of issues' }

  return { isOk: true, tickets: issues.flatMap(issue => parseTicket(issue, siteUrl) ?? []) }
}

/** The branch's ticket as a board ticket, for when it is not among the person's own. */
export function ticketFromIssue(issue: JiraIssue): JiraTicket {
  return {
    key: issue.key,
    summary: issue.summary,
    ...(issue.status ? { status: issue.status } : {}),
    ...(issue.priority ? { priority: issue.priority } : {}),
    ...(issue.type ? { type: issue.type } : {}),
    url: issue.url
  }
}

/** What "New branch" leaves in the prompt box, for the person to finish the name and press Enter. */
export function buildBranchCommand(key: string, template?: string): string {
  return fillBranchTemplate(key, template)
}

/** Brackets a markdown link text can hold: balanced ones as written, otherwise escaped. */
function linkText(text: string): string {
  const opened = text.split('[').length
  const closed = text.split(']').length

  return opened === closed ? text : text.replace(/[[\]]/g, '\\$&')
}

/** `[ABC-123: Summary](url) `, the space after so typing goes on. */
export function buildTicketLink(ticket: Pick<JiraTicket, 'key' | 'summary' | 'url'>): string {
  return `[${linkText(`${ticket.key}: ${ticket.summary}`)}](${ticket.url}) `
}

function parseLinked(value: unknown): LinkedTicket | undefined {
  const key = textAt(value, 'key')
  if (!key) return undefined
  const summary = textAt(value, 'fields', 'summary')
  const status = textAt(value, 'fields', 'status', 'name')

  return { key, ...(summary ? { summary } : {}), ...(status ? { status } : {}) }
}

/**
 * One `issuelinks` entry from this ticket's side: the outward words with the outward issue, else the inward.
 * @example
 * // before: { type: { inward: 'is implemented by', outward: 'implements' }, outwardIssue: { key: 'OTH-9', fields: { summary: 'View' } } }
 * // after:  { relation: 'implements', key: 'OTH-9', summary: 'View' }
 */
function parseIssueLink(link: unknown): IssueLink | undefined {
  const outward = parseLinked(valueAt(link, ['outwardIssue']))
  if (outward) return { relation: textAt(link, 'type', 'outward') ?? 'relates to', ...outward }
  const inward = parseLinked(valueAt(link, ['inwardIssue']))

  return inward ? { relation: textAt(link, 'type', 'inward') ?? 'relates to', ...inward } : undefined
}

function parseAttachment(attachment: unknown, siteUrl: string): TicketAttachment | undefined {
  const filename = textAt(attachment, 'filename')
  if (!filename) return undefined
  const id = textAt(attachment, 'id')
  const url = id ? `${siteUrl}/secure/attachment/${id}/${encodeURIComponent(filename)}` : textAt(attachment, 'content')
  const mimeType = textAt(attachment, 'mimeType') ?? ''

  return url ? { filename, url, isImage: mimeType.startsWith('image/') || IMAGE_FILE.test(filename) } : undefined
}

function parseComment(comment: unknown, isHtml: boolean): TicketComment | undefined {
  const body = textAt(comment, 'body')
  if (!body) return undefined
  const created = textAt(comment, 'created')

  return {
    author: textAt(comment, 'author', 'displayName') ?? 'Someone',
    ...(created ? { date: created.slice(0, 10) } : {}),
    body: cleanJiraMarkdown(body, isHtml)
  }
}

function namesAt(fields: Record<string, unknown>, key: string): string[] {
  return listAt(fields, key).flatMap(item => (typeof item === 'string' ? [item] : (textAt(item, 'name') ?? [])))
}

/**
 * Reads a whole `getJiraIssue` result into what the prompt gets; comments come from `fields.comment`
 * (the atlassian server also repeats them at the top level).
 * @example
 * // before: { key: 'ABC-409', fields: { summary: 'Batching', labels: ['Frontend'], comment: { comments: [{ body: 'Done',
 * //           created: '2026-07-28T22:36:41.714+0900', author: { displayName: 'Sam' } }] }, attachment: [{ id: '15769',
 * //           filename: 'shot.png', mimeType: 'image/png' }] } }
 * // after:  { isOk: true, ticket: { key: 'ABC-409', summary: 'Batching', labels: ['Frontend'], comments: [{ author: 'Sam',
 * //           date: '2026-07-28', body: 'Done' }], attachments: [{ filename: 'shot.png', isImage: true,
 * //           url: '…/secure/attachment/15769/shot.png' }], … } }
 */
export function parseFullTicket(result: McpToolResult, siteUrl: string): FullTicketParse {
  if (result.isError) return { isOk: false, error: mcpErrorText(result) }
  const json = readMcpJson(result)
  const key = textAt(json, 'key')
  const fields = valueAt(json, ['fields'])
  if (!key || !isRecord(fields)) return { isOk: false, error: 'Jira answered without an issue' }
  const isHtml = textAt(json, 'appliedContentFormat') === 'html'
  const description = textAt(fields, 'description')
  const parent = parseLinked(fields.parent)
  const listed = listAt(fields, 'comment', 'comments')
  const comments = (listed.length > 0 ? listed : listAt(json, 'comments')).flatMap(item => parseComment(item, isHtml) ?? [])
  const total = valueAt(fields, ['comment', 'total'])
  const commentTotal = typeof total === 'number' && total > comments.length ? total : undefined

  return {
    isOk: true,
    ticket: {
      key,
      summary: textAt(fields, 'summary') ?? '(no summary)',
      url: `${siteUrl}/browse/${key}`,
      status: textAt(fields, 'status', 'name'),
      priority: textAt(fields, 'priority', 'name'),
      type: textAt(fields, 'issuetype', 'name'),
      labels: namesAt(fields, 'labels'),
      components: namesAt(fields, 'components'),
      ...(description ? { description: cleanJiraMarkdown(description, isHtml) } : {}),
      ...(parent ? { parent } : {}),
      subtasks: listAt(fields, 'subtasks').flatMap(item => parseLinked(item) ?? []),
      links: listAt(fields, 'issuelinks').flatMap(item => parseIssueLink(item) ?? []),
      attachments: listAt(fields, 'attachment').flatMap(item => parseAttachment(item, siteUrl) ?? []),
      comments,
      ...(commentTotal ? { commentTotal } : {})
    }
  }
}

function linkedLine(ticket: LinkedTicket): string {
  const summary = ticket.summary ? `: ${ticket.summary}` : ''
  const status = ticket.status ? ` (${ticket.status})` : ''

  return `${ticket.key}${summary}${status}`
}

/** `_Only 2 of 5 comments here: the rest are on the ticket's page._` */
function commentsMissingLine(shown: number, total: number): string {
  return `_Only ${shown} of ${total} comments here: the rest are on the ticket's page._`
}

function quoted(text: string): string {
  return text
    .split('\n')
    .map(line => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n')
}

/** `## Comments` and the like: a heading and its body, or nothing when the body is empty. */
function section(title: string, body: string[]): string[] {
  return body.length > 0 ? [`### ${title}`, '', ...body, ''] : []
}

/**
 * One markdown block holding the whole ticket, for the prompt: the facts as a list, then the description,
 * the linked work, attachments (images marked) and every comment with its author and date.
 * @example
 * // before: { key: 'ABC-1', summary: 'Encoding', url: 'https://x/browse/ABC-1', status: 'IN REVIEW', labels: [],
 * //           components: [], subtasks: [], links: [], attachments: [{ filename: 'a.png', url: 'u', isImage: true }],
 * //           comments: [{ author: 'Alex', date: '2026-10-13', body: 'LGTM' }] }
 * // after:  '## ABC-1: Encoding\n\nhttps://x/browse/ABC-1\n\n- Status: IN REVIEW\n\n### Attachments\n\n- a.png (image): u\n\n
 * //          ### Comments\n\n**Alex** · 2026-10-13\n\n> LGTM\n'
 */
export function buildFullTicketMarkdown(ticket: FullTicket): string {
  const facts = [
    ticket.status && `- Status: ${ticket.status}`,
    ticket.priority && `- Priority: ${ticket.priority}`,
    ticket.type && `- Type: ${ticket.type}`,
    ticket.labels.length > 0 && `- Labels: ${ticket.labels.join(', ')}`,
    ticket.components.length > 0 && `- Components: ${ticket.components.join(', ')}`,
    ticket.parent && `- Parent: ${linkedLine(ticket.parent)}`
  ].filter((line): line is string => typeof line === 'string')
  const comments = ticket.comments.flatMap(comment => [
    `**${comment.author}**${comment.date ? ` · ${comment.date}` : ''}`,
    '',
    quoted(comment.body),
    ''
  ])
  const missing = ticket.commentTotal === undefined ? [] : [commentsMissingLine(ticket.comments.length, ticket.commentTotal), '']
  const lines = [
    `## ${ticket.key}: ${ticket.summary}`,
    '',
    ticket.url,
    '',
    ...(facts.length > 0 ? [...facts, ''] : []),
    ...section('Description', ticket.description ? [ticket.description] : []),
    ...section('Linked issues', ticket.links.map(link => `- ${link.relation} ${linkedLine(link)}`)),
    ...section('Subtasks', ticket.subtasks.map(subtask => `- ${linkedLine(subtask)}`)),
    ...section(
      'Attachments',
      ticket.attachments.map(file => `- ${file.filename}${file.isImage ? ' (image)' : ''}: ${file.url}`)
    ),
    ...section('Comments', [...missing, ...comments].slice(0, -1))
  ]

  return `${lines.join('\n').trimEnd()}\n`
}
