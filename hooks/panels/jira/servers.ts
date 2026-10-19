import type { JiraFlavour } from '../../../types'

const ISSUE_FIELDS = ['summary', 'status', 'assignee', 'priority', 'issuetype', 'description']
const TICKET_FIELDS = ['summary', 'status', 'priority', 'issuetype', 'updated', 'description']
const FULL_TICKET_FIELDS = [
  'summary',
  'description',
  'status',
  'priority',
  'issuetype',
  'labels',
  'components',
  'comment',
  'attachment',
  'issuelinks',
  'subtasks',
  'parent'
]
const MAX_TICKETS = 50

/** One MCP tool call: which tool, with what arguments. */
export interface JiraCall {
  tool: string
  args: Record<string, unknown>
}

/** `getJiraIssue` arguments; only a standard server takes standard field keys in `fields`. */
export function jiraIssueArgs(flavour: JiraFlavour, cloudId: string, key: string): Record<string, unknown> {
  if (flavour === 'standard') {
    return { cloudId, issueIdOrKey: key, fields: ISSUE_FIELDS, responseContentFormat: 'markdown' }
  }

  return { cloudId, issueIdOrKey: key, responseContentFormat: 'markdown' }
}

/** The read-only search for the person's tickets. */
export function assignedSearchArgs(flavour: JiraFlavour, cloudId: string, jql: string): Record<string, unknown> {
  const base = { cloudId, jql, maxResults: MAX_TICKETS, responseContentFormat: 'markdown' }

  return flavour === 'standard' ? { ...base, fields: TICKET_FIELDS } : base
}

/** A whole ticket for the prompt: comments, attachments, links, subtasks and parent included. */
export function fullTicketArgs(flavour: JiraFlavour, cloudId: string, key: string): Record<string, unknown> {
  if (flavour === 'standard') {
    return { cloudId, issueIdOrKey: key, fields: FULL_TICKET_FIELDS, responseContentFormat: 'markdown' }
  }

  return { cloudId, issueIdOrKey: key, responseContentFormat: 'markdown', view: 'full' }
}

/** The read-only list of transitions the ticket can take now. */
export function transitionsCall(flavour: JiraFlavour, cloudId: string, key: string): JiraCall {
  if (flavour === 'standard') {
    return { tool: 'getTransitionsForJiraIssue', args: { cloudId, issueIdOrKey: key } }
  }

  return { tool: 'executeRead', args: { cloudId, name: 'listJiraIssueTransitions', inputs: { issueIdOrKey: key } } }
}

/** The one write the panel makes: moves the ticket through `transitionId`, as each flavour spells it. */
export function transitionCall(flavour: JiraFlavour, cloudId: string, key: string, transitionId: string): JiraCall {
  if (flavour === 'standard') {
    return { tool: 'transitionJiraIssue', args: { cloudId, issueIdOrKey: key, transition: { id: transitionId } } }
  }

  return { tool: 'transitionJiraIssue', args: { cloudId, issueIdOrKey: key, transitionId } }
}

export function boardListCall(cloudId: string, projectKey: string): JiraCall {
  return { tool: 'executeRead', args: { cloudId, name: 'listJiraBoards', inputs: { projectKeyOrId: projectKey } } }
}

export function boardConfigCall(cloudId: string, boardId: number): JiraCall {
  return { tool: 'executeRead', args: { cloudId, name: 'getJiraBoardConfig', inputs: { boardId } } }
}

/** A rejected call's message without the engine's `claudedockula: $.mcp.call: ` prefix. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  return message.replace(/^[\w-]+: \$\.[\w.]+: /, '')
}

export const NO_SERVER_ANSWERED = 'No Atlassian MCP server answered'
export const PERMISSION_HINT = 'Allow it in /permissions'
/** How Claude Code words a call its permissions refused (a rule, auto mode's classifier), not a service's own `Access denied`. */
const PERMISSION_DENIAL = /^refused: |auto mode|classifier|permission to use\b.*\bdenied|\bdenied by (?:the )?(?:user|permission|auto mode|hook|rule)|permission rule|\/permissions\b/i

/** Every server's error on one line, each once: `first: … · second: …`. */
export function joinServerErrors(errors: readonly string[]): string {
  return errors.length > 0 ? [...new Set(errors)].join(' · ') : NO_SERVER_ANSWERED
}

/** Whether the session's permissions refused the call, as opposed to the service answering with an error. Shared by the Slack, Jira and GitGud panels. */
export function isPermissionDenial(text: string): boolean {
  return PERMISSION_DENIAL.test(text)
}

/** The error, with a line saying where to allow the call when the session's permissions refused it. */
export function withPermissionHint(text: string): string {
  return isPermissionDenial(text) ? `${text}\n${PERMISSION_HINT}` : text
}
