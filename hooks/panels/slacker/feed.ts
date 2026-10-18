import type { SlackerFilter, SlackerItem, SlackerMessage, SlackerState } from '../../../types'

// Pure feed logic: merging the searches, what counts as unseen, and the arguments the panel's MCP calls and
// model call take. No `$` here.

export const FEED_DAYS = 7
export const LIST_STEP = 5
export const MAX_KEYWORDS = 3
const KEYWORD_MAX_CHARS = 40
const DAY_MS = 86_400_000
const SEARCH_LIMIT = 20
const SEARCH_MODIFIER = /^-?(in|from|to|with|has|hasmy|is|before|after|on|during|creator):\S/

function tsMs(ts: string): number {
  return Number(ts) * 1000
}

function byNewest(a: SlackerItem, b: SlackerItem): number {
  return Number(b.ts) - Number(a.ts)
}

/** The conversation a DM message or a thread reply folds into; mentions and watched words stay one row each. */
function conversationKey(item: SlackerItem): string | undefined {
  if (item.kind === 'dm') return `dm:${item.channelId}`
  if (item.kind === 'thread') return `thread:${item.channelId}:${item.threadTs ?? item.ts}`

  return undefined
}

/**
 * Newest first, each DM and each thread folded into its newest message with a count.
 * @example
 * // [dm C1 @3, dm C1 @2, mention C2 @1] → [{ dm C1 @3, count: 2 }, mention C2 @1]
 */
function foldConversations(newestFirst: readonly SlackerItem[]): SlackerItem[] {
  const kept: SlackerItem[] = []
  const indexByKey = new Map<string, number>()
  for (const item of newestFirst) {
    const key = conversationKey(item)
    const at = key === undefined ? undefined : indexByKey.get(key)
    if (at === undefined) {
      if (key !== undefined) indexByKey.set(key, kept.length)
      kept.push(item)
      continue
    }
    const head = kept[at]
    if (head) kept[at] = { ...head, count: (head.count ?? 1) + 1 }
  }

  return kept
}

/**
 * The feed from each search's items, given @s first, then DMs, thread replies and watched words: your own
 * messages dropped, a message found twice kept under its first search, newest first, DMs and threads folded.
 * @example
 * // [[mention C1:2], [dm C1:2, dm D1:1]], 'U8' → [mention C1:2, dm D1:1]
 */
export function mergeFeed(batches: readonly (readonly SlackerItem[])[], meId: string | undefined): SlackerItem[] {
  const byId = new Map<string, SlackerItem>()
  for (const batch of batches) {
    for (const item of batch) {
      if (item.authorId !== meId && !byId.has(item.id)) byId.set(item.id, item)
    }
  }

  return foldConversations([...byId.values()].sort(byNewest))
}

export function isUnseen(item: SlackerItem, since: number | undefined): boolean {
  return tsMs(item.ts) > (since ?? 0)
}

export function countUnseen(items: readonly SlackerItem[], since: number | undefined): number {
  return items.filter(item => isUnseen(item, since)).length
}

/** How many feed rows each chip stands for. */
export function filterCounts(items: readonly SlackerItem[]): Record<SlackerFilter, number> {
  const counts: Record<SlackerFilter, number> = { all: items.length, mention: 0, dm: 0, thread: 0, keyword: 0 }
  for (const item of items) {
    if (item.kind !== 'search') counts[item.kind] += 1
  }

  return counts
}

/** True when every word of `query` is in the item's author, place, text or watched word, ignoring case. */
export function matchesQuery(item: SlackerItem, query: string): boolean {
  const haystack = `${item.author} ${item.where} ${item.text} ${item.keyword ?? ''}`.toLowerCase()

  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word !== '')
    .every(word => haystack.includes(word))
}

/** The rows the list shows: a Slack-wide search's results, else the feed under its chip and the typed filter. */
export function visibleItems(state: SlackerState): SlackerItem[] {
  if (state.search) return state.search.items ?? []
  const filter = state.filter ?? 'all'
  const query = (state.query ?? '').trim()

  return (state.items ?? []).filter(item => (filter === 'all' || item.kind === filter) && (query === '' || matchesQuery(item, query)))
}

/** The item a key names, in the feed or in the search results. */
export function findItem(state: SlackerState, id: string): SlackerItem | undefined {
  return state.items?.find(item => item.id === id) ?? state.search?.items?.find(item => item.id === id)
}

/**
 * How long ago a message was, in a few cells.
 * @example
 * // ('1000.0', 1_000_000 + 7_200_000) → '2h'
 */
export function formatAge(ts: string, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - tsMs(ts)) / 1000))
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`

  return `${Math.floor(seconds / (7 * 86_400))}w`
}

/**
 * The day the feed starts, as Slack's `after:` filter takes it.
 * @example
 * // (Date.UTC(2026, 9, 15), 7) → '2026-10-08'
 */
export function feedStartDate(nowMs: number, days = FEED_DAYS): string {
  return new Date(nowMs - days * DAY_MS).toISOString().slice(0, 10)
}

const SEARCH_BASE = { sort: 'timestamp', limit: SEARCH_LIMIT, include_context: false, response_format: 'detailed' } as const

export function mentionSearchArgs(meId: string, after: string): Record<string, unknown> {
  return { ...SEARCH_BASE, keywords: [`<@${meId}>`], filters: `after:${after}` }
}

export function dmSearchArgs(after: string): Record<string, unknown> {
  return { ...SEARCH_BASE, filters: `after:${after}`, channel_types: 'im,mpim', include_bots: false }
}

export function threadSearchArgs(meId: string, after: string): Record<string, unknown> {
  return { ...SEARCH_BASE, filters: `is:thread with:<@${meId}> after:${after}` }
}

export function keywordSearchArgs(keyword: string, after: string): Record<string, unknown> {
  const term = /\s/.test(keyword) ? `"${keyword.replace(/"/g, '')}"` : keyword

  return { ...SEARCH_BASE, keywords: [term], filters: `after:${after}` }
}

/**
 * A typed query as Slack's search takes it: modifiers (`from:@grace`, `in:#dev`) as filters, the rest as words.
 * @example
 * // 'release notes from:@grace' → { keywords: ['release', 'notes'], filters: 'from:@grace', natural_language_query: 'release notes' }
 */
export function querySearchArgs(query: string): Record<string, unknown> {
  const tokens = query.match(/"[^"]+"|\S+/g) ?? []
  const filters = tokens.filter(token => SEARCH_MODIFIER.test(token))
  const keywords = tokens.filter(token => !SEARCH_MODIFIER.test(token))

  return {
    ...SEARCH_BASE,
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(filters.length > 0 ? { filters: filters.join(' ') } : {}),
    natural_language_query: keywords.join(' ').replace(/"/g, '')
  }
}

/**
 * The watched words from what the person typed: comma-separated, trimmed, no repeats, three at most.
 * @example
 * // ' ABC-1, release notes ,abc-1, x, y' → ['ABC-1', 'release notes', 'x']
 */
export function parseKeywords(answer: string): string[] {
  const words: string[] = []
  for (const part of answer.split(',')) {
    const word = part.trim().slice(0, KEYWORD_MAX_CHARS)
    if (word !== '' && !words.some(kept => kept.toLowerCase() === word.toLowerCase())) words.push(word)
  }

  return words.slice(0, MAX_KEYWORDS)
}

/**
 * The search box after one key: a character typed, Backspace, Ctrl+U clearing it, Enter submitting it;
 * undefined for a key that does not type (the arrows).
 * @example
 * // ('ab', 'c') → { query: 'abc' }; ('abc', 'backspace') → { query: 'ab' }; ('abc', 'return') → { query: 'abc', isSubmit: true }
 */
export function typeIntoQuery(query: string, name: string, isCtrl = false): { query: string; isSubmit?: true } | undefined {
  if (name === 'return' || name === 'enter') return { query, isSubmit: true }
  if (name === 'backspace' || name === 'delete') return { query: Array.from(query).slice(0, -1).join('') }
  if (isCtrl) return name === 'u' ? { query: '' } : undefined
  if (name === 'space') return { query: `${query} ` }
  const chars = Array.from(name)

  return chars.length === 1 && name >= ' ' ? { query: `${query}${name}` } : undefined
}

/** Where a reply goes: the item's thread, the DM itself for a DM outside a thread, else a new thread on it. */
export function replyTarget(item: SlackerItem): { channelId: string; threadTs?: string; label: string } {
  if (item.threadTs) return { channelId: item.channelId, threadTs: item.threadTs, label: `Reply in thread · ${item.where}` }
  if (item.isDm) return { channelId: item.channelId, label: `Message to ${item.where}` }

  return { channelId: item.channelId, threadTs: item.ts, label: `Reply in thread · ${item.where}` }
}

/** The `slack_send_message` arguments that post `text` where `replyTarget` says. */
export function sendArgs(item: SlackerItem, text: string): Record<string, unknown> {
  const target = replyTarget(item)

  return { channel_id: target.channelId, message: text, ...(target.threadTs ? { thread_ts: target.threadTs } : {}) }
}

/** The thread (or DM conversation) read that opens under an item. */
export function threadReadOf(item: SlackerItem): { tool: string; args: Record<string, unknown> } {
  if (item.isDm && !item.threadTs) return { tool: 'slack_read_channel', args: { channel_id: item.channelId, limit: 8, response_format: 'detailed' } }

  return {
    tool: 'slack_read_thread',
    args: { channel_id: item.channelId, message_ts: item.threadTs ?? item.ts, limit: 50, response_format: 'detailed' }
  }
}

function quote(author: string, text: string): string {
  const lines = text.split('\n')

  return lines.map((line, index) => (index === 0 ? `> **${author}:** ${line}` : `> ${line}`)).join('\n')
}

/**
 * What + Prompt puts in the prompt box: where the message is, its link, and the message (or the whole thread) quoted.
 * @example
 * // (Grace in #dev-app 'hi') → 'Slack message in #dev-app (https://…):\n> **Grace:** hi'
 */
export function promptTextFor(item: SlackerItem, conversation?: readonly SlackerMessage[]): string {
  if (conversation && conversation.length > 0) {
    const kind = item.isDm && !item.threadTs ? 'conversation' : 'thread'

    return [`Slack ${kind} in ${item.where} (${item.permalink}):`, ...conversation.map(message => quote(message.author, message.text))].join('\n')
  }

  return `Slack message in ${item.where} (${item.permalink}):\n${quote(item.author, item.text)}`
}

/** The thread's messages, the parent first, as the prompt and the polish read them. */
export function conversationOf(thread: { parent?: SlackerMessage; replies?: SlackerMessage[] } | undefined): SlackerMessage[] {
  if (!thread) return []

  return [...(thread.parent ? [thread.parent] : []), ...(thread.replies ?? [])]
}

const POLISH_SYSTEM = [
  'You help someone write Slack replies.',
  'Rewrite their draft so it is clear, friendly and concise, in the same language and voice. Keep every fact, name and link.',
  'When the draft is empty, write a short reply to the latest message for them.',
  'Answer with the reply text only: no preamble, no quotes, no sign-off.'
].join(' ')

/** The model request that polishes a draft, with the conversation as context (its last 12 messages). */
export function polishRequest(
  item: SlackerItem,
  draft: string,
  conversation: readonly SlackerMessage[],
  me: string
): { system: string; prompt: string } {
  const context = conversation.slice(-12).map(message => `${message.author}: ${message.text}`)
  const answered = `${item.author} in ${item.where}: ${item.text}`
  const sections = [
    ...(context.length > 0 ? [`Conversation, oldest first:\n${context.join('\n')}`] : []),
    `Message being answered:\n${answered}`,
    `${me}'s draft reply:\n${draft.trim() === '' ? '(empty: write one)' : draft}`
  ]

  return { system: POLISH_SYSTEM, prompt: sections.join('\n\n') }
}
