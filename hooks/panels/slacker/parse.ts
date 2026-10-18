import type { McpToolResult } from 'claude-code'

import type { SlackerItem, SlackerKind, SlackerMessage } from '../../../types'
import { isPermissionDenial } from '../jira/servers'

// Pure parsers for what the claude.ai Slack connector answers: a JSON envelope around Markdown-ish text
// (`{ "results": "### Result 1 of 3\nChannel: …" }`). No `$` here.

const ERROR_MAX_CHARS = 160

/** The read-only tools the panel calls; `slack_send_message` runs only from a reply's Send. */
export const READ_TOOLS = ['slack_read_user_profile', 'slack_search_public_and_private', 'slack_read_thread', 'slack_read_channel'] as const

const EMOJI: Record<string, string> = {
  '+1': '👍',
  '-1': '👎',
  thumbsup: '👍',
  '100': '💯',
  bow: '🙇',
  clap: '👏',
  eyes: '👀',
  fire: '🔥',
  heart: '❤',
  joy: '😂',
  laughing: '😆',
  muscle: '💪',
  ok_hand: '👌',
  pray: '🙏',
  raised_hands: '🙌',
  rocket: '🚀',
  rolling_on_the_floor_laughing: '🤣',
  slightly_smiling_face: '🙂',
  smile: '😄',
  smiley: '😃',
  sob: '😭',
  sweat_smile: '😅',
  tada: '🎉',
  thinking_face: '🤔',
  wave: '👋',
  white_check_mark: '✅',
  x: '❌'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstText(result: McpToolResult): string | undefined {
  const blocks = Array.isArray(result.content) ? result.content : []

  return blocks.find(block => block.type === 'text' && typeof block.text === 'string')?.text
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * The text the connector wraps under `field` of its JSON answer, or the raw text when it is not JSON.
 * @example
 * // { content: [{ type: 'text', text: '{"results":"### Result 1 of 1…"}' }] }, 'results' → '### Result 1 of 1…'
 */
export function readField(result: McpToolResult, field: string): string {
  const raw = firstText(result) ?? ''
  const parsed = parseJson(raw)
  const value = isRecord(parsed) ? parsed[field] : undefined

  return typeof value === 'string' ? value : raw
}

/** One short line saying why an MCP call failed. */
export function mcpErrorText(result: McpToolResult): string {
  const raw = firstText(result) ?? ''
  const parsed = parseJson(raw)
  const message = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : raw
  const line = message.split('\n').find(part => part.trim() !== '')?.trim() ?? 'Slack returned an error'

  return line.length > ERROR_MAX_CHARS ? `${line.slice(0, ERROR_MAX_CHARS - 1)}…` : line
}

/**
 * A thrown error's message, without the engine's `plugin: $.noun.event(…)` lead.
 * @example
 * // 'claudedockula: $.mcp.call(claude_ai_Slack, slack_read_thread) refused: The …' → 'refused: The …'
 */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  return message.replace(/^[\w-]+: \$\.[\w.]+(?:\([^)]*\))?:? /, '')
}

const CAUSE_MAX_CHARS = 100

/** Whether Claude Code's permissions refused the call (a rule, or auto mode's classifier). */
export function isPermissionRefusal(message: string): boolean {
  return isPermissionDenial(message)
}

/** Why Claude Code refused, in a few words: auto mode, or the first sentence of its own reason. */
function refusalCause(reason: string): string {
  if (/auto mode/i.test(reason)) return 'auto mode could not review it'
  const first = (reason.replace(/^refused: /i, '').split(/(?<=\.)\s/)[0] ?? '').replace(/\.$/, '')

  return first.length > CAUSE_MAX_CHARS ? `${first.slice(0, CAUSE_MAX_CHARS - 1)}…` : first
}

/**
 * What to show when Claude Code refused a Slack call: why, and the rule to add in /permissions.
 * @example
 * // ('claude_ai_Slack', 'slack_read_thread', 'refused: The server-side auto mode classifier gave no verdict …')
 * // → 'Claude Code blocked slack_read_thread (auto mode could not review it).\nAllow it in /permissions: mcp__claude_ai_Slack__slack_read_thread'
 */
export function refusalText(server: string, tool: string, reason: string): string {
  return `Claude Code blocked ${tool} (${refusalCause(reason)}).\nAllow it in /permissions: mcp__${server}__${tool}`
}

/**
 * The request 🔓 Allow Slack puts in the prompt box: the read rules to add, and a question about the send rule.
 * @example
 * // 'claude_ai_Slack' → 'Add these allow rules … : mcp__claude_ai_Slack__slack_read_user_profile, … Then ask me whether …'
 */
export function allowRequestText(server: string): string {
  const rules = READ_TOOLS.map(tool => `mcp__${server}__${tool}`).join(', ')

  return [
    `Add these allow rules to my Claude Code user settings (permissions.allow) so ClaudeDockula's Slacker panel can read Slack: ${rules}.`,
    `Then ask me whether to also allow mcp__${server}__slack_send_message, which lets Claude post to Slack without asking.`
  ].join(' ')
}

/** Whether the session lists any tool of `server`: none means the connector is not connected. */
export function hasServerTools(toolNames: readonly string[], server: string): boolean {
  return toolNames.some(name => name.startsWith(`mcp__${server}__`))
}

/**
 * Slack's markup as plain text: mentions, channels, links, entities and the common emoji names.
 * @example
 * // '<@U1|Ada> see <#C1|dev-app> <https://x.io|the doc> :tada: &amp;' → '@Ada see #dev-app the doc 🎉 &'
 */
export function cleanSlackText(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<@([A-Z0-9]+)>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '$1')
    .replace(/<!subteam\^[A-Z0-9]+>/g, '@team')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<#[A-Z0-9]+>/g, '#channel')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/:([a-z0-9_+-]+):/g, (whole, name: string) => EMOJI[name] ?? whole)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

/**
 * The names in a DM's `Participants:` line, leaving out `meId`.
 * @example
 * // 'Grace Hopper (ID: U07), Ada Lovelace (ID: U08)', 'U08' → 'Grace Hopper'
 */
function otherParticipants(line: string, meId: string | undefined): string {
  const names = [...line.matchAll(/([^,]+?) \(ID: (\w+)\)/g)]
    .filter(match => match[2] !== meId)
    .map(match => (match[1] ?? '').trim())
    .filter(name => name !== '')

  return names.join(', ')
}

/** Where a message was posted: the channel, or for a DM the people in it other than you. */
function whereOf(label: string, participants: string | undefined, meId: string | undefined): string {
  if (label.startsWith('#') || !participants) return label

  return otherParticipants(participants, meId) || label
}

function lineValue(lines: readonly string[], pattern: RegExp): RegExpExecArray | undefined {
  for (const line of lines) {
    const match = pattern.exec(line)
    if (match) return match
  }

  return undefined
}

/** One `### Result n of m` block as an item; undefined when it lacks a channel, an author or a ts. */
function parseResultBlock(block: string, kind: SlackerKind, meId: string | undefined): SlackerItem | undefined {
  const textAt = block.indexOf('\nText:')
  const head = (textAt >= 0 ? block.slice(0, textAt) : block).split('\n')
  const body = textAt >= 0 ? block.slice(textAt + '\nText:'.length) : ''
  const channel = lineValue(head, /^Channel: (.+?) \(ID: (\w+)\)/)
  const from = lineValue(head, /^From: (.+?)(?: <[^>]*>)? \(ID: (\w+)\)/)
  const ts = lineValue(head, /^Message_ts: ([\d.]+)/)?.[1]
  if (!channel?.[1] || !channel[2] || !from?.[1] || !from[2] || !ts) return undefined
  const label = channel[1]
  const participants = lineValue(head, /^Participants: (.+)$/)?.[1]
  const permalink = lineValue(head, /^Permalink: \[link\]\((.+)\)/)?.[1] ?? ''
  const threadTs = /[?&]thread_ts=([\d.]+)/.exec(permalink)?.[1]
  const replyCount = Number(lineValue(head, /^Reply count: (\d+)/)?.[1] ?? 0)
  const text = cleanSlackText(body.replace(/\n-{3,}\s*$/, ''))

  return {
    id: `${channel[2]}:${ts}`,
    kind,
    channelId: channel[2],
    where: whereOf(label, participants, meId),
    isDm: !label.startsWith('#'),
    author: from[1].trim(),
    authorId: from[2],
    ts,
    ...(threadTs ? { threadTs } : {}),
    ...(replyCount > 0 ? { replyCount } : {}),
    text,
    permalink
  }
}

/**
 * The items of one `slack_search_*` answer, in the order Slack gave them.
 * @example
 * // '### Result 1 of 1\nChannel: #dev-app (ID: C1)\nFrom: Grace <c@x> (ID: U7)\nMessage_ts: 1792.1\nText: \nhi\n\n---'
 * // → [{ id: 'C1:1792.1', kind, channelId: 'C1', where: '#dev-app', author: 'Grace', text: 'hi', … }]
 */
export function parseSearchResults(text: string, kind: SlackerKind, meId: string | undefined): SlackerItem[] {
  return text
    .split(/^### Result \d+ of \d+\s*$/m)
    .slice(1)
    .map(block => parseResultBlock(block.trim(), kind, meId))
    .filter((item): item is SlackerItem => item !== undefined)
}

/** The text lines of a message, without the `Reactions:` and `Files:` lines the connector appends. */
function messageText(lines: readonly string[]): string {
  const kept = lines.filter(line => !/^(Reactions|Files): /.test(line))

  return cleanSlackText(kept.join('\n'))
}

/** One `From:` / `Time:` / `Message TS:` block of a thread read. */
function parseThreadMessage(block: string): SlackerMessage | undefined {
  const lines = block.trim().split('\n')
  const from = /^From: (.+?)(?: <[^>]*>)? \((\w+)\)/.exec(lines[0] ?? '')
  const tsIndex = lines.findIndex(line => line.startsWith('Message TS: '))
  const ts = tsIndex >= 0 ? (lines[tsIndex] ?? '').slice('Message TS: '.length).trim() : ''
  if (!from?.[1] || !from[2] || !ts) return undefined

  return { author: from[1].trim(), authorId: from[2], ts, text: messageText(lines.slice(tsIndex + 1)) }
}

/**
 * A `slack_read_thread` answer: its parent and its replies, oldest first.
 * @example
 * // '=== THREAD PARENT MESSAGE ===\nFrom: Gabe <g@x> (U1)\nTime: …\nMessage TS: 1.1\nhello\n\n=== THREAD REPLIES (1 total) ===\n\n--- Reply 1 of 1 ---\nFrom: …'
 * // → { parent: { author: 'Gabe', ts: '1.1', text: 'hello' }, replies: [{ … }] }
 */
export function parseThread(text: string): { parent?: SlackerMessage; replies: SlackerMessage[] } {
  const [parentPart = '', repliesPart = ''] = text.split(/^=== THREAD REPLIES.*===\s*$/m)
  const parent = parseThreadMessage(parentPart.replace(/^=== THREAD PARENT MESSAGE ===\s*$/m, ''))
  const replies = repliesPart
    .split(/^--- Reply \d+ of \d+ ---\s*$/m)
    .slice(1)
    .map(parseThreadMessage)
    .filter((message): message is SlackerMessage => message !== undefined)
    .sort((a, b) => Number(a.ts) - Number(b.ts))

  return parent ? { parent, replies } : { replies }
}

/**
 * A `slack_read_channel` answer (newest first from Slack) as messages, oldest first.
 * @example
 * // '=== Message from Grace <c@x> (U7) at 2026-10-14 13:52:29 JST === \nMessage TS: 1.2\nhi' → [{ author: 'Grace', ts: '1.2', text: 'hi' }]
 */
export function parseChannelMessages(text: string): SlackerMessage[] {
  const pattern = /^=== Message from (.+?)(?: <[^>]*>)? \((\w+)\) at .+?===\s*$/gm
  const heads = [...text.matchAll(pattern)]

  return heads
    .map((head, index) => {
      const start = (head.index ?? 0) + head[0].length
      const end = heads[index + 1]?.index ?? text.length
      const lines = text.slice(start, end).trim().split('\n')
      const ts = /^Message TS: ([\d.]+)/.exec(lines[0] ?? '')?.[1]
      if (!head[1] || !head[2] || !ts) return undefined

      return { author: head[1].trim(), authorId: head[2], ts, text: messageText(lines.slice(1)) }
    })
    .filter((message): message is SlackerMessage => message !== undefined)
    .sort((a, b) => Number(a.ts) - Number(b.ts))
}

/** Who you are, as the store kept it; undefined when it holds something else. */
export function readStoredMe(value: unknown): { id: string; name: string } | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return undefined

  return { id: value.id, name: value.name }
}

/** The watched words, as the store kept them; undefined when it holds something else. */
export function readStoredWords(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(word => typeof word === 'string') ? value.slice(0, 3) : undefined
}

/**
 * The signed-in person from `slack_read_user_profile`: their id and the name Slack shows.
 * @example
 * // 'User ID: U08\nUsername: octocat\nDisplay Name: Ada\nReal Name: Ada L' → { id: 'U08', name: 'Ada' }
 */
export function parseProfile(text: string): { id: string; name: string } | undefined {
  const id = /^User ID: (\w+)/m.exec(text)?.[1]
  if (!id) return undefined
  const display = /^Display Name: (.*)$/m.exec(text)?.[1]?.trim()
  const real = /^Real Name: (.*)$/m.exec(text)?.[1]?.trim()

  return { id, name: display || real || id }
}
