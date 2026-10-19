import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, On, RenderSurface, Timer } from 'claude-code'

import type { NoticeTone, SlackerDraft, SlackerItem, SlackerKind, SlackerState, SlackerThread } from '../../types'
import { DEFAULT_LAYOUT, bandPanelIds, readLayout } from '../dock/layout'
import { NO_NOTICES, pushNotice } from '../dock/notices'
import { TONE, drawActions, fitEnd, type DockElements } from '../dock/ui'
import type { DockPanel } from './contract'
import {
  LIST_STEP,
  conversationOf,
  countUnseen,
  dmSearchArgs,
  feedStartDate,
  findItem,
  keywordSearchArgs,
  mentionSearchArgs,
  mergeFeed,
  parseKeywords,
  polishRequest,
  promptTextFor,
  querySearchArgs,
  replyTarget,
  sendArgs,
  threadReadOf,
  threadSearchArgs
} from './slacker/feed'
import {
  allowRequestText,
  errorText,
  hasServerTools,
  isPermissionRefusal,
  mcpErrorText,
  parseChannelMessages,
  parseProfile,
  parseSearchResults,
  parseThread,
  readField,
  readStoredMe,
  readStoredWords,
  refusalText
} from './slacker/parse'
import {
  KEY_PREFIX,
  buildFeedProps,
  layoutSlacker,
  parseFeedMessage,
  parseSlackerKey,
  type FeedMessage,
  type FeedRow,
  type FeedSegment,
  type SlackerControl,
  type SlackerKey
} from './slacker/rows'

// 💬 Slacker: your @s, DMs from people, replies in your threads and watched words from Slack, with a search box, a
// right-click menu, + Prompt, and replies you review (and can have Haiku polish) before they are sent. The engine
// follows `$` only into functions declared in the same file, so every function that takes `$` lives here.

const PANEL_ID = 'slacker'
const SERVER = 'claude_ai_Slack'
const REFRESH_MS = 30_000
const POLISH_MODEL = 'haiku'
const POLISH_MAX_TOKENS = 800
const STORE_ME = 'slacker:me'
const STORE_SEEN = 'slacker:seenAt'
const STORE_WORDS = 'slacker:keywords'
/** The feed's `Client` key, the dock's id after it (`slacker-feed-main`): each dock showing it holds its own. */
const FEED_KEY = 'slacker-feed-'
const NOT_CONNECTED = "Slack isn't connected in this session."
const CONNECT_HINT = 'Connect claude.ai Slack in /mcp, then ↻ Refresh.'

const slackerState = atom({ plugin: 'claudedockula', key: 'slacker' } as const, {})
const layoutAtom = atom({ plugin: 'claudedockula', key: 'layout' } as const, DEFAULT_LAYOUT)
const noticesAtom = atom({ plugin: 'claudedockula', key: 'notices' } as const, NO_NOTICES)
let ticker: Timer | undefined
let isRefreshing = false
let isRefreshQueued = false

interface SlackFailure {
  error: string
  isRefused?: boolean
  /** The call threw rather than Slack answering with an error. */
  isThrown?: boolean
}

type SlackAnswer = { text: string } | SlackFailure
type Conversation = Omit<SlackerThread, 'itemId' | 'isLoading'>

async function notify($: EngineInterface, tone: NoticeTone, title: string, topic: string): Promise<void> {
  const at = await $.clock.now()
  await update($, noticesAtom, list => pushNotice(list, { tone, title, at, topic }))
}

/** One read-only Slack call: the text under `field` of its answer, or one line saying why it failed. */
async function callSlack($: EngineInterface, tool: string, args: Record<string, unknown>, field: string): Promise<SlackAnswer> {
  try {
    const result = await $.mcp.call(SERVER, tool, args)

    return result.isError ? { error: mcpErrorText(result) } : { text: readField(result, field) }
  } catch (error) {
    const message = errorText(error)
    if (isPermissionRefusal(message)) return { error: refusalText(SERVER, tool, message), isRefused: true, isThrown: true }

    return { error: message, isThrown: true }
  }
}

/** A call that threw (not one Claude Code refused) while the session lists none of Slack's tools: it is not connected. */
async function isDisconnectedBy($: EngineInterface, failures: readonly SlackFailure[]): Promise<boolean> {
  if (!failures.some(failure => failure.isThrown === true && failure.isRefused !== true)) return false
  const tools = await $.tool.list().catch(() => undefined)

  return Array.isArray(tools) && !hasServerTools(tools.map(tool => tool.name), SERVER)
}

/** Whether some dock's view holds the panel: it is opt-in, so until then it reads nothing. */
async function isPlaced($: EngineInterface): Promise<boolean> {
  return bandPanelIds(readLayout(await read($, layoutAtom))).includes(PANEL_ID)
}

/** You, from the state, the store, or Slack's profile of the signed-in person. */
async function loadMe($: EngineInterface): Promise<{ id: string; name: string } | SlackFailure> {
  const known = (await read($, slackerState)).me
  if (known) return known
  const answer = await callSlack($, 'slack_read_user_profile', { response_format: 'detailed' }, 'result')
  if ('error' in answer) return answer.isRefused ? answer : { ...answer, error: `profile: ${answer.error}` }
  const me = parseProfile(answer.text)
  if (!me) return { error: 'profile: Slack did not say who you are' }
  await $.store.set(STORE_ME, me)
  await update($, slackerState, state => ({ ...state, me }))

  return me
}

interface FeedSource {
  label: string
  kind: SlackerKind
  args: Record<string, unknown>
  keyword?: string
}

function feedSources(meId: string, after: string, keywords: readonly string[]): FeedSource[] {
  return [
    { label: 'mentions', kind: 'mention', args: mentionSearchArgs(meId, after) },
    { label: 'DMs', kind: 'dm', args: dmSearchArgs(after) },
    { label: 'threads', kind: 'thread', args: threadSearchArgs(meId, after) },
    ...keywords.map((keyword): FeedSource => ({ label: `“${keyword}”`, kind: 'keyword', args: keywordSearchArgs(keyword, after), keyword }))
  ]
}

/**
 * Reads every source of the feed (the last seven days) and merges them; a source that fails keeps its error
 * line, and when all fail the last feed stays. A refresh asked for while one runs (`isQueued`) runs after it.
 */
async function refreshFeed($: EngineInterface, isQueued = false): Promise<void> {
  if (isRefreshing) {
    isRefreshQueued = isRefreshQueued || isQueued

    return
  }
  isRefreshing = true
  try {
    await update($, slackerState, state => ({ ...state, isLoading: true }))
    const me = await loadMe($)
    const now = await $.clock.now()
    if ('error' in me) {
      const isDisconnected = await isDisconnectedBy($, [me])
      await update($, slackerState, state => ({
        ...state,
        isLoading: false,
        errors: isDisconnected ? [] : [me.error],
        isRefused: me.isRefused === true,
        isDisconnected,
        updatedAt: now
      }))

      return
    }
    const sources = feedSources(me.id, feedStartDate(now), (await read($, slackerState)).keywords ?? [])
    const answers = await Promise.all(sources.map(source => callSlack($, 'slack_search_public_and_private', source.args, 'results')))
    const batches = sources.map((source, index) => {
      const answer = answers[index]
      if (!answer || 'error' in answer) return []
      const items = parseSearchResults(answer.text, source.kind, me.id)

      return source.keyword ? items.map(item => ({ ...item, keyword: source.keyword })) : items
    })
    const failures = answers.flatMap(answer => ('error' in answer ? [answer] : []))
    const errors = sources.flatMap((source, index) => {
      const answer = answers[index]
      if (!answer || !('error' in answer)) return []

      return [answer.isRefused ? answer.error : `${source.label}: ${answer.error}`]
    })
    const isAllFailed = failures.length === sources.length
    const isDisconnected = isAllFailed && (await isDisconnectedBy($, failures))
    await update($, slackerState, state => ({
      ...state,
      ...(isAllFailed ? {} : { items: mergeFeed(batches, me.id) }),
      errors: isDisconnected ? [] : [...new Set(errors)],
      isRefused: failures.some(failure => failure.isRefused === true),
      isDisconnected,
      isLoading: false,
      updatedAt: now
    }))
  } finally {
    isRefreshing = false
    if (isRefreshQueued) {
      isRefreshQueued = false
      void refreshFeed($)
    }
  }
}

/** The 30 s refresh, while the panel is placed; it waits while Slack is refused, until ↻ Refresh or an open; a not-connected message keeps refreshing, as the tool list may miss deferred tools. */
async function tick($: EngineInterface): Promise<void> {
  const state = await read($, slackerState)
  if (!state.isRefused && (await isPlaced($))) await refreshFeed($)
}

/** A Slack-wide search from the search box; its results replace the feed until ✕ Feed. */
async function runSearch($: EngineInterface, query: string): Promise<void> {
  await update($, slackerState, state => ({ ...state, search: { query, isLoading: true }, openId: undefined, menuId: undefined, shown: LIST_STEP }))
  const answer = await callSlack($, 'slack_search_public_and_private', querySearchArgs(query), 'results')
  await update($, slackerState, state => {
    if (state.search?.query !== query) return state
    if ('error' in answer) return { ...state, search: { query, error: answer.error } }

    return { ...state, search: { query, items: parseSearchResults(answer.text, 'search', state.me?.id) } }
  })
}

/** The typed filter, kept; Enter with something typed searches all of Slack. */
async function submitSearch($: EngineInterface, query: string): Promise<void> {
  await update($, slackerState, state => ({ ...state, query }))
  if (query.trim() !== '') await runSearch($, query.trim())
}

/** The thread an item is in, or for a DM outside a thread its last few messages. */
async function readConversation($: EngineInterface, item: SlackerItem): Promise<Conversation> {
  const source = threadReadOf(item)
  const answer = await callSlack($, source.tool, source.args, 'messages')
  if ('error' in answer) return { error: answer.error }
  if (source.tool === 'slack_read_channel') return { replies: parseChannelMessages(answer.text) }

  return parseThread(answer.text)
}

async function showThread($: EngineInterface, id: string): Promise<void> {
  const item = findItem(await read($, slackerState), id)
  if (!item) return
  await update($, slackerState, state => ({ ...state, openId: id, menuId: undefined, thread: { itemId: id, isLoading: true } }))
  const conversation = await readConversation($, item)
  await update($, slackerState, state => (state.thread?.itemId === id ? { ...state, thread: { itemId: id, ...conversation } } : state))
}

async function toggleThread($: EngineInterface, id: string): Promise<void> {
  const state = await read($, slackerState)
  if (state.thread?.itemId === id) {
    await update($, slackerState, value => ({ ...value, thread: undefined }))

    return
  }
  void showThread($, id)
}

/** The item's message, or its whole thread when it is shown or asked for, appended to the prompt box. */
async function addToPrompt($: EngineInterface, id: string, withThread: boolean): Promise<void> {
  const state = await read($, slackerState)
  const item = findItem(state, id)
  if (!item) return
  const shown = state.thread?.itemId === id && !state.thread.isLoading && !state.thread.error ? conversationOf(state.thread) : undefined
  const conversation = shown ?? (withThread ? conversationOf(await readConversation($, item)) : [])
  const box = await $.prompt.read()
  const lead = box.text.trim() === '' ? '' : '\n\n'
  const filled = await $.prompt.fill({ text: `${lead}${promptTextFor(item, conversation)}`, mode: 'append' })
  const what = conversation.length > 0 ? 'Thread' : 'Message'
  if (filled.isFilled) await notify($, 'success', `${what} added to the prompt`, 'slacker-prompt')
  else await notify($, 'error', `The prompt box didn't take the ${what.toLowerCase()}`, 'slacker-prompt')
}

async function copyLink($: EngineInterface, id: string, surface: RenderSurface): Promise<void> {
  const item = findItem(await read($, slackerState), id)
  if (!item?.permalink) return
  const copied = await $.ui.copy({ text: item.permalink, surface }).catch(() => ({ isCopied: false }))
  if (copied.isCopied) await notify($, 'success', 'Link copied', 'slacker-link')
  else await notify($, 'error', "Couldn't copy the link", 'slacker-link')
}

/** 🔓 Allow Slack: a request for the read rules in an empty prompt box, for the person to send or not. */
async function fillAllowRequest($: EngineInterface): Promise<void> {
  const { text } = await $.prompt.read()
  if (text.trim() !== '') {
    await notify($, 'info', 'Clear the prompt box first', 'slacker-allow')

    return
  }
  const filled = await $.prompt.fill({ text: allowRequestText(SERVER), mode: 'insert' })
  if (filled.isFilled) await notify($, 'info', 'Review the request, then press Enter', 'slacker-allow')
  else await notify($, 'error', "The prompt box didn't take the request", 'slacker-allow')
}

/** Asks for the reply's text (or lets Haiku write it), then shows it under the item with Send. */
async function startReply($: EngineInterface, id: string): Promise<void> {
  const item = findItem(await read($, slackerState), id)
  if (!item) return
  const question = `${replyTarget(item).label}, to ${item.author}: what should it say?`
  const answer = await $.ui.ask(question, { header: 'Reply', options: ['Let AI draft it', 'Cancel'] }).catch(() => undefined)
  if (answer === undefined || answer === 'Cancel') return
  const isAiDraft = answer === 'Let AI draft it'
  await update($, slackerState, (state): SlackerState => {
    if (state.draft?.phase === 'sending') return state

    return { ...state, openId: id, menuId: undefined, draft: { itemId: id, text: isAiDraft ? '' : answer, phase: 'review' } }
  })
  if (isAiDraft) await polishDraft($, id)
}

async function editDraft($: EngineInterface, id: string): Promise<void> {
  const draft = (await read($, slackerState)).draft
  if (draft?.itemId !== id) return
  const now = draft.text.trim() === '' ? '' : `Now: “${fitEnd(draft.text.replace(/\s+/g, ' '), 120)}”. `
  const options = { header: 'Edit reply', options: ['Keep it', 'Cancel reply'] }
  const answer = await $.ui.ask(`${now}What should the reply say instead?`, options).catch(() => undefined)
  if (answer === undefined || answer === 'Keep it') return
  await update($, slackerState, (state): SlackerState => {
    if (state.draft?.itemId !== id || state.draft.phase === 'sending' || state.draft.phase === 'sent') return state
    if (answer === 'Cancel reply') return { ...state, draft: undefined }

    return { ...state, draft: { itemId: id, text: answer, phase: 'review', previous: state.draft.text || undefined } }
  })
}

/** Haiku rewrites the draft (or writes one when it is empty) with the thread as context; the person still sends it. */
async function polishDraft($: EngineInterface, id: string): Promise<void> {
  // Set only by the call that moved the draft to `polishing`, so a double click polishes once.
  const claim: { text?: string } = {}
  await update($, slackerState, (state): SlackerState => {
    claim.text = undefined
    if (state.draft?.itemId !== id || (state.draft.phase !== 'review' && state.draft.phase !== 'failed')) return state
    claim.text = state.draft.text

    return { ...state, draft: { ...state.draft, phase: 'polishing', error: undefined } }
  })
  const draftText = claim.text
  if (draftText === undefined) return
  const state = await read($, slackerState)
  const item = findItem(state, id)
  const shown = state.thread?.itemId === id && state.thread.replies ? conversationOf(state.thread) : undefined
  const conversation = item ? (shown ?? conversationOf(await readConversation($, item))) : []
  let polished = ''
  let failure = ''
  if (item) {
    const request = polishRequest(item, draftText, conversation, state.me?.name ?? 'Me')
    try {
      const result = await $.model.complete({ model: POLISH_MODEL, system: request.system, prompt: request.prompt, maxTokens: POLISH_MAX_TOKENS })
      if (result.isAnswered) polished = result.text.trim()
      else failure = result.reason
    } catch (error) {
      failure = errorText(error)
    }
  } else {
    failure = 'the message is no longer listed'
  }
  await update($, slackerState, (value): SlackerState => {
    if (value.draft?.itemId !== id || value.draft.phase !== 'polishing') return value
    if (polished === '') return { ...value, draft: { ...value.draft, phase: 'review', error: `Polish failed: ${failure || 'no text came back'}` } }

    return { ...value, draft: { itemId: id, text: polished, phase: 'review', previous: value.draft.text || undefined } }
  })
}

/** Posts the reviewed draft once: the one write this panel makes, only from its Send. */
async function sendDraft($: EngineInterface, id: string): Promise<void> {
  // Set only by the call that moved the draft to `sending`, so a double click sends once.
  const claim: { text?: string } = {}
  await update($, slackerState, (state): SlackerState => {
    claim.text = undefined
    const draft = state.draft
    if (draft?.itemId !== id || (draft.phase !== 'review' && draft.phase !== 'failed') || draft.text.trim() === '') return state
    claim.text = draft.text

    return { ...state, draft: { ...draft, phase: 'sending', error: undefined } }
  })
  const text = claim.text
  if (text === undefined) return
  const item = findItem(await read($, slackerState), id)
  let failure: string | undefined = item ? undefined : 'the message is no longer listed'
  let mayHaveSent = false
  if (item) {
    try {
      const result = await $.mcp.call(SERVER, 'slack_send_message', sendArgs(item, text))
      if (result.isError) failure = mcpErrorText(result)
    } catch (error) {
      const message = errorText(error)
      const isRefusal = isPermissionRefusal(message)
      failure = isRefusal ? refusalText(SERVER, 'slack_send_message', message) : message
      mayHaveSent = !isRefusal
    }
  }
  const after = await update($, slackerState, (state): SlackerState => {
    if (state.draft?.itemId !== id || state.draft.phase !== 'sending') return state
    if (mayHaveSent) return { ...state, draft: { ...state.draft, phase: 'failed', error: 'May have been sent: check Slack before trying again' } }
    if (failure !== undefined) return { ...state, draft: { ...state.draft, phase: 'failed', error: `Not sent: ${failure}` } }

    return { ...state, draft: { itemId: id, text: state.draft.text, phase: 'sent' } }
  })
  if (failure === undefined && after.thread?.itemId === id) void showThread($, id)
}

async function askSearch($: EngineInterface): Promise<void> {
  const options = { header: 'Search', options: ['Clear search', 'Cancel'] }
  const answer = await $.ui.ask('What should Slacker search Slack for?', options).catch(() => undefined)
  if (answer === undefined || answer === 'Cancel') return
  if (answer === 'Clear search') {
    await update($, slackerState, state => ({ ...state, search: undefined, query: '' }))

    return
  }
  await submitSearch($, answer)
}

async function askWatchWords($: EngineInterface): Promise<void> {
  const state = await read($, slackerState)
  const current = state.keywords ?? []
  const question =
    current.length > 0
      ? `Slacker watches for: ${current.join(', ')}. Which words should it watch instead (up to 3, comma-separated)?`
      : 'Which words should Slacker watch for (up to 3, comma-separated)?'
  const myName = state.me?.name
  const options = current.length > 0 ? ['Keep these', 'Clear watchlist'] : ['Cancel', ...(myName ? [`Watch “${myName}”`] : [])]
  const answer = await $.ui.ask(question, { header: 'Watchlist', options }).catch(() => undefined)
  if (answer === undefined || answer === 'Keep these' || answer === 'Cancel') return
  const keywords = answer === 'Clear watchlist' ? [] : parseKeywords(myName && answer === `Watch “${myName}”` ? myName : answer)
  if (answer !== 'Clear watchlist' && keywords.length === 0) return
  await $.store.set(STORE_WORDS, keywords)
  await update($, slackerState, (value): SlackerState => ({
    ...value,
    keywords,
    filter: keywords.length === 0 && value.filter === 'keyword' ? 'all' : value.filter
  }))
  void refreshFeed($, true)
}

/** The panel was opened from the band or its card: the dots show what came since the last look. */
async function markOpened($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, slackerState, state => ({ ...state, dotsSince: state.seenAt, seenAt: now }))
  await $.store.set(STORE_SEEN, now)
}

/** Anything the person does in the card means they are looking: the band's count goes back to 0. */
async function markLooking($: EngineInterface, clearsDots: boolean): Promise<void> {
  const now = await $.clock.now()
  await update($, slackerState, state => ({ ...state, seenAt: now, ...(clearsDots ? { dotsSince: now } : {}) }))
  await $.store.set(STORE_SEEN, now)
}

async function handleControl($: EngineInterface, name: SlackerControl): Promise<void> {
  if (name === 'search') {
    void askSearch($)
  } else if (name === 'refresh') {
    const { search } = await read($, slackerState)
    if (search) void runSearch($, search.query)
    await refreshFeed($, true)
  } else if (name === 'allow') {
    await fillAllowRequest($)
  } else if (name === 'watch') {
    void askWatchWords($)
  } else if (name === 'seen') {
    await markLooking($, true)
  } else {
    await update($, slackerState, (state): SlackerState => {
      if (name === 'clear-query') return { ...state, query: '' }
      if (name === 'clear-search') return { ...state, search: undefined, query: '', openId: undefined }
      if (name === 'more') return { ...state, shown: (state.shown ?? LIST_STEP) + LIST_STEP }

      return { ...state, shown: LIST_STEP }
    })
  }
}

async function handleAction($: EngineInterface, key: Extract<SlackerKey, { kind: 'action' }>, surface: RenderSurface): Promise<void> {
  const { action, id, scope } = key
  if (scope === 'menu') await update($, slackerState, state => ({ ...state, menuId: undefined }))
  if (action === 'add' || action === 'addthread') void addToPrompt($, id, action === 'addthread')
  else if (action === 'reply') void startReply($, id)
  else if (action === 'thread') await toggleThread($, id)
  else if (action === 'copy') void copyLink($, id, surface)
  else if (scope === 'act') await update($, slackerState, state => ({ ...state, openId: undefined, ...(state.thread?.itemId === id ? { thread: undefined } : {}) }))
}

async function handleDraft($: EngineInterface, key: Extract<SlackerKey, { kind: 'draft' }>): Promise<void> {
  const { action, id } = key
  if (action === 'send') void sendDraft($, id)
  else if (action === 'polish') void polishDraft($, id)
  else if (action === 'edit') void editDraft($, id)
  else {
    // A click drawn before the draft moved on (to sending, say) must not undo or drop it.
    await update($, slackerState, (state): SlackerState => {
      const draft = state.draft
      if (draft?.itemId !== id) return state
      const isEditable = draft.phase === 'review' || draft.phase === 'failed'
      if (action === 'undo' && isEditable && draft.previous !== undefined) return { ...state, draft: { itemId: id, text: draft.previous, phase: 'review' } }
      if (action === 'cancel' && (isEditable || draft.phase === 'polishing')) return { ...state, draft: undefined }
      if (action === 'dismiss' && draft.phase === 'sent') return { ...state, draft: undefined }

      return state
    })
  }
}

async function toggleMenu($: EngineInterface, id: string | undefined): Promise<void> {
  await update($, slackerState, state => ({ ...state, menuId: id !== undefined && state.menuId !== id ? id : undefined }))
}

/** A Button's press or a click in the `Client`, by what its key names; a click on nothing closes the menu. */
async function handleClick($: EngineInterface, key: SlackerKey | undefined, surface: RenderSurface): Promise<void> {
  if (key?.kind === 'control') await handleControl($, key.name)
  else if (key?.kind === 'filter') await update($, slackerState, state => ({ ...state, filter: key.filter, shown: LIST_STEP }))
  else if (key?.kind === 'item') await update($, slackerState, state => ({ ...state, openId: state.openId === key.id ? undefined : key.id, menuId: undefined }))
  else if (key?.kind === 'dots') await toggleMenu($, key.id)
  else if (key?.kind === 'action') await handleAction($, key, surface)
  else if (key?.kind === 'draft') await handleDraft($, key)
  else await toggleMenu($, undefined)
}

/** A right-click on an item, or anything under it, opens its menu (again: closes it); anywhere else closes it. */
async function handleContext($: EngineInterface, key: SlackerKey | undefined): Promise<void> {
  const id = key?.kind === 'item' || key?.kind === 'dots' || key?.kind === 'action' || key?.kind === 'draft' ? key.id : undefined
  await toggleMenu($, id)
}

/** A reload drops work in flight: a polish left marked would never end, and a send may or may not have gone. */
function draftAfterReload(draft: SlackerDraft | undefined): SlackerDraft | undefined {
  if (draft?.phase === 'polishing') return { ...draft, phase: 'review' }
  if (draft?.phase === 'sending') return { ...draft, phase: 'failed', error: 'Interrupted: check Slack before trying again' }

  return draft
}

async function handleMessage($: EngineInterface, message: FeedMessage, surface: RenderSurface): Promise<void> {
  await markLooking($, false)
  if (message.type === 'click') await handleClick($, parseSlackerKey(message.key), surface)
  else if (message.type === 'context') await handleContext($, parseSlackerKey(message.key))
  else if (message.type === 'query') await update($, slackerState, state => ({ ...state, query: message.query, shown: LIST_STEP }))
  else await submitSearch($, message.query)
}

export function registerSlackerHooks(on: On): void {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    ticker?.cancel()
    const [me, seenAt, words] = await Promise.all([
      $.store.get(STORE_ME).catch(() => undefined),
      $.store.get(STORE_SEEN).catch(() => undefined),
      $.store.get(STORE_WORDS).catch(() => undefined)
    ])
    const storedMe = readStoredMe(me)
    const storedWords = readStoredWords(words)
    await update($, slackerState, (state): SlackerState => ({
      ...state,
      isLoading: false,
      draft: draftAfterReload(state.draft),
      ...(storedMe && !state.me ? { me: storedMe } : {}),
      ...(typeof seenAt === 'number' && state.seenAt === undefined ? { seenAt, dotsSince: seenAt } : {}),
      ...(storedWords && state.keywords === undefined ? { keywords: storedWords } : {})
    }))
    ticker = $.clock.every(REFRESH_MS, () => void tick($))
    if (await isPlaced($)) void refreshFeed($)

    return started
  })

  // Opening the panel (its band tab, or its card's header toggle in any dock) marks it seen and reads Slack again.
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(tab|main-toggle|\d+-toggle)-slacker$/ }, async ($, e, next) => {
    const pressed = await next(e)
    await markOpened($)
    void refreshFeed($)

    return pressed
  })

  // Ticking the panel into a view in ⚙ Manage reads Slack at once rather than at the next 30 s tick.
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(main|\d+)-enable-\d+-slacker$/ }, async ($, e, next) => {
    const pressed = await next(e)
    if (await isPlaced($)) void refreshFeed($)

    return pressed
  })

  on('ui.press', { plugin: 'claudedockula', element: /^slacker-/ }, async ($, e) => {
    await markLooking($, false)
    await handleClick($, parseSlackerKey(e.element.slice(KEY_PREFIX.length)), e.surface)

    return { element: e.element }
  })

  on('ui.message', { element: /^slacker-feed-/ }, async ($, e) => {
    const message = parseFeedMessage(e.data)
    if (message) void handleMessage($, message, e.surface)

    return {}
  })
}

/** The band text after 💬: how many feed rows are new since you last looked; `…` loading, `!` failed, `–` nothing yet. */
export function summarizeSlacker(state: SlackerState): string {
  if (state.items === undefined) {
    if (state.isLoading) return '…'

    return (state.errors ?? []).length > 0 ? '!' : '–'
  }

  return String(countUnseen(state.items, state.seenAt))
}

interface PlainPart {
  key?: string
  segments: FeedSegment[]
  isRun: boolean
}

/**
 * A row as the plain card draws it: each keyed segment a part, each run of unkeyed ones a part, the row's key on
 * its first run.
 * @example
 * // { key: 'item:1', segments: [' ', 'Grace', ' 2h ', ⋯ 'dots:1'] } → [{ key: 'item:1', [' ', 'Grace', ' 2h '] }, { key: 'dots:1', [⋯] }]
 */
function plainParts(row: FeedRow): PlainPart[] {
  const parts: PlainPart[] = []
  for (const one of row.segments) {
    const last = parts[parts.length - 1]
    if (one.key !== undefined) {
      parts.push({ key: one.key, segments: [one], isRun: false })
    } else if (last?.isRun) {
      last.segments.push(one)
    } else {
      const isFirstRun = !parts.some(part => part.isRun)
      parts.push({ ...(row.key !== undefined && isFirstRun ? { key: row.key } : {}), segments: [one], isRun: true })
    }
  }

  return parts
}

function drawSegment(ui: DockElements, one: FeedSegment): JSX.Element {
  const { Text } = ui

  return (
    <Text color={one.color} dimColor={one.isDim} bold={one.isBold} inverse={one.isInverse}>
      {one.text}
    </Text>
  )
}

/** The feed with no `Client` (vscode, mobile): every key a Button, each drawn once (an item's second row is text). */
function drawPlainFeed(ui: DockElements, rows: readonly FeedRow[]): JSX.Element {
  const { Box, Button, Text } = ui
  const drawnKeys = new Set<string>()
  const drawPart = (part: PlainPart): JSX.Element => {
    const texts = part.segments.map(one => drawSegment(ui, one))
    if (part.key === undefined || drawnKeys.has(part.key)) return <Text>{texts}</Text>
    drawnKeys.add(part.key)

    return (
      <Button key={`${KEY_PREFIX}${part.key}`} plain onPress={() => undefined}>
        {texts}
      </Button>
    )
  }

  return (
    <Box flexDirection="column">
      {rows.map(row => (row.segments.length === 0 ? <Text> </Text> : <Box flexDirection="row">{plainParts(row).map(drawPart)}</Box>))}
    </Box>
  )
}

/** The feed: a `Client` on the terminal and desktop (vscode's table holds one it does not draw), Buttons elsewhere. */
function drawFeed(ui: Elements[RenderSurface], state: SlackerState, columns: number, surface: RenderSurface, dockId: string): JSX.Element {
  if ((surface === 'terminal' || surface === 'desktop') && 'Client' in ui) {
    const { Client } = ui

    return <Client key={`${FEED_KEY}${dockId}`} module="./slacker/SlackerFeed.tsx" props={buildFeedProps(state, columns)} width={columns} />
  }

  return drawPlainFeed(ui, layoutSlacker(state, columns, false))
}

/** What failed, drawn whole (a first read's in red, a later one's as a warning), or why Slack is out of reach. */
function drawStatus(ui: DockElements, state: SlackerState, hasFeed: boolean): JSX.Element | null {
  const { Box, Text } = ui
  if (state.isDisconnected) {
    return (
      <Box flexDirection="column" marginTop={hasFeed ? 1 : 0}>
        <Text wrap="wrap">{NOT_CONNECTED}</Text>
        <Text dimColor wrap="wrap">
          {CONNECT_HINT}
        </Text>
      </Box>
    )
  }
  const lines = (state.errors ?? []).flatMap(error => error.split('\n'))
  if (lines.length === 0) return null
  const isFirstRead = state.items === undefined

  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, index) => (
        <Text color={isFirstRead ? TONE.fail : TONE.run} wrap="wrap">
          {index === 0 && !isFirstRead ? `⚠ ${line}` : line}
        </Text>
      ))}
    </Box>
  )
}

/** ↻ Refresh, and 🔓 Allow Slack while Claude Code refuses the calls; Seen and the watchlist once Slack answers. */
function actionButtons(ui: DockElements, state: SlackerState): JSX.Element[] {
  const { Button } = ui
  const refresh = <Button key={`${KEY_PREFIX}refresh`} plain dimColor label="↻ Refresh" onPress={() => undefined} />
  if (state.isDisconnected) return [refresh]
  if (state.isRefused) return [<Button key={`${KEY_PREFIX}allow`} variant="primary" label="🔓 Allow Slack" onPress={() => undefined} />, refresh]
  const words = state.keywords ?? []

  return [
    refresh,
    <Button key={`${KEY_PREFIX}seen`} plain dimColor label="✓ Seen" onPress={() => undefined} />,
    <Button key={`${KEY_PREFIX}watch`} plain dimColor label={words.length > 0 ? `★ Watching ${words.length}` : '★ Watch'} onPress={() => undefined} />
  ]
}

/**
 * The card's body, from its stored state: the feed (a `Client` on the terminal and desktop, Buttons elsewhere),
 * what failed, then the Buttons. `surface` decides, not the table; `dockId` keys the feed per dock.
 */
export function drawSlacker(ui: Elements[RenderSurface], state: SlackerState, columns: number, surface: RenderSurface, dockId: string): JSX.Element {
  const { Box } = ui
  const hasFeed = !(state.isDisconnected === true && state.items === undefined && !state.search)

  return (
    <Box flexDirection="column" width={columns}>
      {hasFeed && drawFeed(ui, state, columns, surface, dockId)}
      {drawStatus(ui, state, hasFeed)}
      {drawActions(ui, actionButtons(ui, state))}
    </Box>
  )
}

export const slackerPanel: DockPanel = {
  id: PANEL_ID,
  title: 'Slacker',
  icon: '💬',
  description: 'Your Slack @s, DMs and thread replies: search, add to the prompt, reply',
  isBuiltIn: true,
  isOptIn: true,
  revision: 1
}
