import type { SelectOption, ToolInfo } from 'claude-code'

import type { AddPanelDraft, AddPanelForm, DockRefresh } from '../../types'
import type { DockPanel } from '../panels/contract'

const NOT_GIVEN = '(not given: choose something sensible)'
export const NO_CONNECTOR = 'none'
export const EMPTY_DRAFT: AddPanelDraft = {}
export const EMPTY_FORM: AddPanelForm = { seed: {}, servers: [] }

export const REFRESH_OPTIONS: readonly SelectOption[] = [
  { value: 'manual', label: 'Manual' },
  { value: '30s', label: 'Every 30 s' },
  { value: '5m', label: 'Every 5 min' },
]

const REFRESH_TEXT: Record<DockRefresh, string> = {
  manual: 'manual: one load at session start, plus a Refresh button',
  '30s': 'every 30 s (its band summary shows at all times), and when it is opened',
  '5m': 'every 5 min (its band summary shows at all times), and when it is opened',
}

export function isDockRefresh(value: string): value is DockRefresh {
  return Object.hasOwn(REFRESH_TEXT, value)
}

/**
 * The MCP servers the model can reach, from tool names `mcp__<server>__<tool>`.
 * @example
 * // before: ['Read', 'mcp__github__get_me', 'mcp__claude_ai_Slack__send', 'mcp__github__list_issues']
 * // after:  ['claude_ai_Slack', 'github']
 */
export function listMcpServerNames(tools: readonly ToolInfo[]): string[] {
  const servers = tools.flatMap(tool => {
    const match = /^mcp__(.+?)__/.exec(tool.name)

    return match?.[1] ? [match[1]] : []
  })

  return [...new Set(servers)].sort((a, b) => a.localeCompare(b))
}

export function connectorOptions(servers: readonly string[]): SelectOption[] {
  const mcp = servers.map(server => ({ value: `mcp:${server}`, label: `MCP: ${server}` }))

  return [
    { value: NO_CONNECTOR, label: 'Not sure' },
    ...mcp,
    { value: 'shell', label: 'Shell command' },
    { value: 'skill', label: 'Skill' },
    { value: 'other', label: 'Other' },
  ]
}

function describeConnector(connector: string | undefined): string {
  if (connector === undefined || connector === NO_CONNECTOR) {
    return NOT_GIVEN
  }
  if (connector.startsWith('mcp:')) {
    return `the MCP server \`${connector.slice(4)}\`, through $.mcp.call (read-only tools only)`
  }
  if (connector === 'shell') {
    return 'a shell command, through $.process.run (read-only commands only)'
  }
  if (connector === 'skill') {
    return 'a skill: the panel puts a prompt that runs it in the prompt box ($.prompt.fill)'
  }

  return 'other: see the notes'
}

/** `My Deploys!` -> `my-deploys`; the id names the panel's file, its hooks' matchers and its state key. */
export function panelIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function answer(value: string | undefined): string {
  const trimmed = value?.trim() ?? ''

  return trimmed === '' ? NOT_GIVEN : trimmed
}

/** Where Claude reads the contract and where it may write: the person's own panels plugin, never the dock's. */
export interface PanelPaths {
  guidePath: string
  companionRoot: string
  /** ➕ just set the folder up: the engine has not loaded it, so its types are not laid yet. */
  isNew?: boolean
}

/** The TypeScript compiler the checks run, the same in this prompt and in PANEL_GUIDE.md. */
export const TSC_COMMAND = 'npx -y -p typescript@5 tsc -p'

function checksFor(paths: PanelPaths): string[] {
  const { companionRoot } = paths

  return [
    `Write and edit files with the Write and Edit tools only (no shell cp, mkdir or sed), and only under ${companionRoot}.`,
    'Never change the ClaudeDockula plugin itself.',
    ...(paths.isNew
      ? [
          'This folder was just set up and Claude Code has not loaded it yet. Before the checks, ask me to run',
          '/reload-plugins and wait for me: loading it lays .claude-plugin/types, which tsc needs.',
        ]
      : []),
    'When done, run these and fix until they pass:',
    `  ${TSC_COMMAND} ${companionRoot}`,
    `  claude plugin validate ${companionRoot}`,
    `  claude plugin test ${companionRoot}`,
  ]
}

/** The prompt "Send to Claude" puts in the prompt box: build the panel the form describes, by the guide. */
export function buildNewPanelPrompt(draft: AddPanelDraft, paths: PanelPaths): string {
  const name = answer(draft.name)
  const id = panelIdFromName(draft.name ?? '')
  const refresh = REFRESH_TEXT[draft.refresh ?? 'manual']

  return [
    `Build a new panel for my ClaudeDockula dock in my own panels plugin at ${paths.companionRoot}.`,
    `Read "Your own panels" in ${paths.guidePath} first and follow it exactly.`,
    '',
    `- Name: ${name}`,
    `- Panel id: ${id === '' ? NOT_GIVEN : `\`${id}\``}`,
    `- Icon (one emoji): ${answer(draft.icon)}`,
    `- What it shows: ${answer(draft.shows)}`,
    `- Actions / buttons: ${answer(draft.actions)}`,
    `- Data source: ${describeConnector(draft.connector)}`,
    `- Refresh: ${refresh}`,
    `- Notes: ${answer(draft.notes)}`,
    '',
    ...checksFor(paths),
    "Then ask me to confirm the panel's tab shows on the band above the prompt.",
    '',
    'Ask me before you guess at anything the answers leave open that changes what the panel does.',
  ].join('\n')
}

/** The prompt the Manage view's Remove puts in the prompt box: delete one of the person's panels, by the guide. */
export function buildRemovePanelPrompt(panel: Pick<DockPanel, 'id' | 'title'>, paths: PanelPaths): string {
  return [
    `Remove the panel "${panel.title}" (id \`${panel.id}\`) from my own panels plugin at ${paths.companionRoot}.`,
    `Follow "Removing one of your panels" in ${paths.guidePath}.`,
    '',
    ...checksFor(paths),
  ].join('\n')
}
