import type { McpToolResult, On, ProcessRunResult, RenderPropsOf } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { cellWidth } from '../hooks/dock/ui'
import { summarizeSlacker } from '../hooks/panels/slacker'
import { mergeFeed, querySearchArgs, sendArgs, typeIntoQuery, visibleItems } from '../hooks/panels/slacker/feed'
import {
  allowRequestText,
  cleanSlackText,
  errorText,
  hasServerTools,
  isPermissionRefusal,
  parseChannelMessages,
  parseSearchResults,
  parseThread,
  refusalText
} from '../hooks/panels/slacker/parse'
import { keyAt, layoutSlacker, parseFeedMessage, parseSlackerKey } from '../hooks/panels/slacker/rows'

const NOW = Date.UTC(2026, 9, 15, 9, 0, 0)
const ME = 'U08ME'
const DENIED = 'Permission to use this MCP tool has been denied.'
/** The dock tests mount several panes; a busy machine takes them past the default 5 s. */
const SLOW = { timeoutMs: 20_000 }

function tsAgo(minutes: number): string {
  return (NOW / 1000 - minutes * 60).toFixed(6)
}

interface Block {
  channel: string
  channelId: string
  from: string
  fromId: string
  ts: string
  text: string
  threadTs?: string
  participants?: string
}

/** One `### Result` block as the claude.ai Slack connector writes it. */
function resultBlock(block: Block, index: number, total: number): string {
  const thread = block.threadTs ? `?thread_ts=${block.threadTs}&cid=${block.channelId}` : ''
  const link = `https://acme.slack.com/archives/${block.channelId}/p${block.ts.replace('.', '')}${thread}`

  return [
    `### Result ${index + 1} of ${total}`,
    `Channel: ${block.channel} (ID: ${block.channelId})`,
    ...(block.participants ? [`Participants: ${block.participants}`] : []),
    `From: ${block.from} <someone@acme.io> (ID: ${block.fromId}) `,
    'Time: 2026-10-15 15:04:50 JST',
    `Message_ts: ${block.ts}`,
    `Permalink: [link](${link})`,
    'Text: ',
    block.text,
    '',
    '---',
    ''
  ].join('\n')
}

function searchText(blocks: readonly Block[]): string {
  const results = blocks.map((block, index) => resultBlock(block, index, blocks.length)).join('\n')

  return `# Search Results for: \n\n## Messages (${blocks.length} results)\n${results}`
}

const MENTION: Block = {
  channel: '#dev-app',
  channelId: 'C1',
  from: 'Grace Hopper',
  fromId: 'U07',
  ts: tsAgo(60),
  text: '<@U08ME|Ada> can you look at <https://acme.atlassian.net/browse/ABC-439|ABC-439>? :sweat_smile:'
}
const DM_OLD: Block = {
  channel: 'DM',
  channelId: 'D1',
  participants: `Grace Hopper (ID: U07), Ada (ID: ${ME})`,
  from: 'Grace Hopper',
  fromId: 'U07',
  ts: tsAgo(300),
  text: 'first'
}
const DM_NEW: Block = { ...DM_OLD, ts: tsAgo(10), text: 'second &amp; newer' }
const DM_MINE: Block = { ...DM_OLD, from: 'Ada', fromId: ME, ts: tsAgo(5), text: 'my own' }
const THREAD_REPLY: Block = {
  channel: '#dev-app',
  channelId: 'C1',
  from: 'Gabriel Rossi',
  fromId: 'U09',
  ts: tsAgo(30),
  threadTs: tsAgo(600),
  text: 'Open a draft PR'
}

describe('slacker: parsing what Slack answers', () => {
  test('a search result block becomes an item: place, author, thread, clean text', () => {
    const [mention] = parseSearchResults(searchText([MENTION]), 'mention', ME)
    expect(mention).toMatchObject({ id: `C1:${MENTION.ts}`, kind: 'mention', where: '#dev-app', isDm: false, author: 'Grace Hopper', authorId: 'U07' })
    expect(mention?.text).toBe('@Ada can you look at ABC-439? 😅')
    const [reply] = parseSearchResults(searchText([THREAD_REPLY]), 'thread', ME)
    expect(reply?.threadTs).toBe(THREAD_REPLY.threadTs)
    const [dm] = parseSearchResults(searchText([DM_OLD]), 'dm', ME)
    expect(dm).toMatchObject({ where: 'Grace Hopper', isDm: true })
    expect(cleanSlackText('<!subteam^S1> <!here> see <#C2|general> <https://x.io> &lt;b&gt;')).toBe('@team @here see #general https://x.io <b>')
  })

  test('a thread read and a DM read become messages, oldest first', () => {
    const thread = parseThread(
      [
        '=== THREAD PARENT MESSAGE ===',
        'From: Gabriel Rossi <g@acme.io> (U09)',
        'Time: 2026-10-15 09:52:53 JST',
        'Message TS: 100.1',
        'Btw I have been looking',
        'Reactions: 100 (5)',
        '',
        '=== THREAD REPLIES (2 total) ===',
        '',
        '--- Reply 1 of 2 ---',
        'From: Gabriel Rossi <g@acme.io> (U09)',
        'Time: 2026-10-15 17:25:57 JST',
        'Message TS: 300.1',
        'Later one',
        '',
        '--- Reply 2 of 2 ---',
        'From: Michael <m@acme.io> (U0A)',
        'Time: 2026-10-15 15:08:15 JST',
        'Message TS: 200.1',
        'Earlier one'
      ].join('\n')
    )
    expect(thread.parent).toMatchObject({ author: 'Gabriel Rossi', ts: '100.1', text: 'Btw I have been looking' })
    expect(thread.replies.map(reply => reply.text)).toEqual(['Earlier one', 'Later one'])
    const chat = parseChannelMessages(
      'Channel: DM (D1)\n\n=== Message from Ada <t@acme.io> (U08ME) at 2026-10-14 15:26:03 JST === \nMessage TS: 20.1\nAh OK\n\n=== Message from Grace <c@acme.io> (U07) at 2026-10-14 13:52:29 JST === \nMessage TS: 10.1\nI think'
    )
    expect(chat.map(message => `${message.author}: ${message.text}`)).toEqual(['Grace: I think', 'Ada: Ah OK'])
  })

  test('a refused call names the rule to allow; 🔓 Allow Slack asks for the read rules only', () => {
    const refused = errorText(
      new Error('claudedockula: $.mcp.call(claude_ai_Slack, slack_read_user_profile) refused: The server-side auto mode classifier gave no verdict')
    )
    expect(refused).toBe('refused: The server-side auto mode classifier gave no verdict')
    expect(isPermissionRefusal(refused)).toBe(true)
    expect(isPermissionRefusal(DENIED)).toBe(true)
    expect(isPermissionRefusal('Access denied by workspace admin')).toBe(false)
    expect(refusalText('claude_ai_Slack', 'slack_read_user_profile', refused)).toBe(
      'Claude Code blocked slack_read_user_profile (auto mode could not review it).\nAllow it in /permissions: mcp__claude_ai_Slack__slack_read_user_profile'
    )
    const request = allowRequestText('claude_ai_Slack')
    expect(request).toContain('mcp__claude_ai_Slack__slack_read_user_profile, mcp__claude_ai_Slack__slack_search_public_and_private,')
    expect(request).toContain('Then ask me whether to also allow mcp__claude_ai_Slack__slack_send_message')
    expect(hasServerTools(['Read', 'mcp__claude_ai_Slack__slack_read_thread'], 'claude_ai_Slack')).toBe(true)
    expect(hasServerTools(['Read', 'mcp__claude_ai_Slackish__x'], 'claude_ai_Slack')).toBe(false)
  })
})

describe('slacker: the feed', () => {
  const mentions = parseSearchResults(searchText([MENTION]), 'mention', ME)
  const dms = parseSearchResults(searchText([DM_MINE, DM_NEW, DM_OLD]), 'dm', ME)
  const threads = parseSearchResults(searchText([THREAD_REPLY, MENTION]), 'thread', ME)
  const feed = mergeFeed([mentions, dms, threads], ME)

  test('your own messages drop, a message found twice stays an @, a DM folds into its newest message', () => {
    expect(feed.map(item => `${item.kind}:${item.text}`)).toEqual(['dm:second & newer', 'thread:Open a draft PR', 'mention:@Ada can you look at ABC-439? 😅'])
    expect(feed[0]?.count).toBe(2)
  })

  test('the band counts what is newer than your last look; … loading, ! failed, – nothing yet', () => {
    expect(summarizeSlacker({ isLoading: true })).toBe('…')
    expect(summarizeSlacker({ errors: ['mentions: rate limited'] })).toBe('!')
    expect(summarizeSlacker({ isDisconnected: true })).toBe('–')
    expect(summarizeSlacker({ items: feed })).toBe('3')
    expect(summarizeSlacker({ items: feed, seenAt: NOW - 45 * 60_000 })).toBe('2')
  })

  test('the chips and the typed filter narrow the list; the box types, clears and submits', () => {
    expect(visibleItems({ items: feed, filter: 'dm' }).map(item => item.kind)).toEqual(['dm'])
    expect(visibleItems({ items: feed, query: 'draft gabriel' }).map(item => item.author)).toEqual(['Gabriel Rossi'])
    expect(typeIntoQuery('ab', 'c')).toEqual({ query: 'abc' })
    expect(typeIntoQuery('abc', 'backspace')).toEqual({ query: 'ab' })
    expect(typeIntoQuery('abc', 'u', true)).toEqual({ query: '' })
    expect(typeIntoQuery('abc', 'return')).toEqual({ query: 'abc', isSubmit: true })
    expect(typeIntoQuery('abc', 'up')).toBeUndefined()
    expect(querySearchArgs('release notes from:@grace')).toMatchObject({ keywords: ['release', 'notes'], filters: 'from:@grace' })
  })

  test('a reply goes to the thread, to the DM itself, or starts a thread on a channel message', () => {
    const [reply] = threads
    const dm = dms.find(item => item.authorId !== ME)
    const [mention] = mentions
    expect(reply && sendArgs(reply, 'hi')).toEqual({ channel_id: 'C1', message: 'hi', thread_ts: THREAD_REPLY.threadTs })
    expect(dm && sendArgs(dm, 'hi')).toEqual({ channel_id: 'D1', message: 'hi' })
    expect(mention && sendArgs(mention, 'hi')).toEqual({ channel_id: 'C1', message: 'hi', thread_ts: MENTION.ts })
  })

  test('the rows fit their width, keys read back, and a click lands on the key under it', () => {
    const firstId = feed[0]?.id ?? ''
    const state = {
      items: feed,
      updatedAt: NOW,
      openId: firstId,
      menuId: firstId,
      errors: ['threads: rate limited'],
      draft: { itemId: firstId, text: 'Sounds good, let us unblock it in the UI with a hint.', phase: 'review' as const }
    }
    for (const columns of [32, 48, 120]) {
      for (const isCanvas of [true, false]) {
        for (const row of layoutSlacker(state, columns, isCanvas)) expect(cellWidth(row.segments.map(one => one.text).join(''))).toBeLessThanOrEqual(columns)
      }
    }
    const rows = layoutSlacker(state, 48, true)
    const keys = rows.flatMap(row => row.segments.flatMap(one => (one.key === undefined ? [] : [one.key])))
    expect(keys).toContain(`draft:send:${firstId}`)
    const head = rows.find(row => row.key === `item:${firstId}`)
    const text = head?.segments.map(one => one.text).join('') ?? ''
    expect(keyAt(head, 3)).toBe(`item:${firstId}`)
    expect(keyAt(head, text.indexOf('⋯'))).toBe(`dots:${firstId}`)
    expect(parseSlackerKey(`draft:send:${firstId}`)).toEqual({ kind: 'draft', action: 'send', id: firstId })
    expect(parseSlackerKey(`dots:${firstId}`)).toEqual({ kind: 'dots', id: firstId })
    expect(parseSlackerKey('allow')).toEqual({ kind: 'control', name: 'allow' })
    expect(parseFeedMessage({ type: 'click', key: 'refresh' })).toEqual({ type: 'click', key: 'refresh' })
    expect(parseFeedMessage({ type: 'search', query: 3 })).toBeUndefined()
  })
})

function paneProps(bodyColumns: number): RenderPropsOf['Pane'] {
  return { title: 'Dock', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }
}

function bandProps(bodyColumns: number): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns, scroll: { offset: 0, bodyRows: 5 }, view: {} }
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'children' in node) return textOf(node.children)

  return ''
}

/** The feed's rows as drawn: the pointer's `y` is the index. */
function rowsOf(tree: unknown): string[] {
  const children = typeof tree === 'object' && tree !== null && 'children' in tree ? tree.children : []

  return Array.isArray(children) ? children.map(textOf) : []
}

function answer(field: string, text: string): { value: McpToolResult } {
  return { value: { content: [{ type: 'text', text: JSON.stringify({ [field]: text }) }], isError: false } }
}

function ran(exitCode: number, stdout: string): ProcessRunResult {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

interface SlackMock {
  searched: Record<string, unknown>[]
  sent: unknown[]
  filled: string[]
}

/** Slack as the connector answers it: you, an @, a DM conversation, threads rate limited, and a search for `gab`. */
function mockSlack(on: On): SlackMock {
  const slack: SlackMock = { searched: [], sent: [], filled: [] }
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    slack.filled.push(e.text)

    return { isFilled: true }
  })
  on('mcp.call', ($, e) => {
    if (e.tool === 'slack_read_user_profile') return answer('result', `User ID: ${ME}\nDisplay Name: Ada\n`)
    if (e.tool === 'slack_send_message') {
      slack.sent.push(e.args)

      return answer('result', 'sent')
    }
    if (e.tool !== 'slack_search_public_and_private') return answer('messages', '')
    slack.searched.push(e.args)
    const { keywords, channel_types: channelTypes, filters } = e.args
    if (Array.isArray(keywords) && keywords.includes(`<@${ME}>`)) return answer('results', searchText([MENTION]))
    if (Array.isArray(keywords) && keywords.includes('gab')) return answer('results', searchText([THREAD_REPLY]))
    if (channelTypes === 'im,mpim') return answer('results', searchText([DM_NEW, DM_OLD]))
    if (typeof filters === 'string' && filters.includes('is:thread')) return { value: { content: [{ type: 'text', text: 'rate limited' }], isError: true } }

    return answer('results', searchText([]))
  })

  return slack
}

/** Ticks Slacker into the main dock's view in ⚙ Manage: it is opt-in, so no view shows it before. */
async function enableSlacker(pane: { press: (args: { key: string }) => Promise<unknown> }): Promise<void> {
  await pane.press({ key: 'dock-main-manage' })
  await pane.press({ key: 'dock-main-enable-1-slacker' })
  await pane.press({ key: 'dock-main-manage' })
}

test('ticked into a view, Slacker reads Slack and draws on every surface; typing filters, Enter searches Slack', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const slack = mockSlack(on)
  const feed = { in: 'slacker-feed-main' }

  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  expect(await pane.find({ key: 'slacker-refresh' })).toBeUndefined()
  await enableSlacker(pane)
  await clock.advance(10)
  expect(slack.searched).toHaveLength(3)
  await pane.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'AbovePrompt', props: bandProps(80) })
    await expect(band.drawn()).resolves.toBeDefined()
    expect((await band.find({ key: 'dock-tab-slacker' }))?.text).toBe('💬 2')
    await band.unmount()
    const ui = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
    await expect(ui.drawn()).resolves.toBeDefined()
    expect(rowsOf(await ui.drawn(feed)).join('\n')).toContain('Grace Hopper')
    expect(await ui.find({ type: 'Text', text: '⚠ threads: rate limited' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /failed:/ })).toBeUndefined()
    await ui.unmount()
  }

  // No Client on vscode or mobile: the same feed as Buttons, each key once.
  for (const surface of ['vscode', 'mobile'] as const) {
    const plain = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
    await expect(plain.drawn()).resolves.toBeDefined()
    expect(await plain.find({ key: `slacker-item:D1:${DM_NEW.ts}` })).toBeDefined()
    expect(await plain.find({ key: `slacker-dots:D1:${DM_NEW.ts}` })).toBeDefined()
    await plain.unmount()
  }

  // A click gives the box the keys; typing filters the loaded feed, Enter searches all of Slack.
  const terminal = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await terminal.pointer({ ...feed, type: 'down', x: 3, y: 0, button: 'left' })
  await terminal.pointer({ ...feed, type: 'up', x: 3, y: 0, button: 'left' })
  for (const key of ['g', 'a', 'b']) await terminal.key({ ...feed, key })
  const filtered = rowsOf(await terminal.drawn(feed))
  expect(filtered[0]).toContain('🔍 gab▏')
  expect(filtered.join('\n')).toContain('No matches for “gab”.')
  await terminal.key({ ...feed, key: 'return' })
  const found = rowsOf(await terminal.drawn(feed))
  expect(found[1]).toMatch(/^⌕ “gab” 1 +✕ Feed$/)
  expect(found.join('\n')).toContain('Gabriel Rossi')
  expect(slack.searched.at(-1)).toMatchObject({ keywords: ['gab'] })
  await terminal.unmount()
})

test('a reply asked for in the feed is posted once, however often Send is clicked', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const slack = mockSlack(on)
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.tool === 'AskUserQuestion' ? (e.questions[0]?.question ?? '') : ''

    return { result: { questions: [], answers: { [question]: 'On it, thanks!' } } }
  })
  const feed = { in: 'slacker-feed-main' }
  const id = `D1:${DM_NEW.ts}`
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await enableSlacker(pane)
  await clock.advance(10)
  const click = async (y: number, x: number) => {
    await pane.pointer({ ...feed, type: 'down', x, y, button: 'left' })
    await pane.pointer({ ...feed, type: 'up', x, y, button: 'left' })
  }

  const rows = rowsOf(await pane.drawn(feed))
  await click(rows.findIndex(row => row.includes('DM Grace')), 4)
  const opened = rowsOf(await pane.drawn(feed))
  const actions = opened.findIndex(row => row.includes('↩ Reply'))
  await click(actions, (opened[actions] ?? '').indexOf('↩ Reply') + 1)
  const drafted = rowsOf(await pane.drawn(feed))
  expect(drafted.join('\n')).toContain('On it, thanks!')
  const sendRow = drafted.findIndex(row => row.includes(' Send '))
  await click(sendRow, (drafted[sendRow] ?? '').indexOf(' Send ') + 2)
  const sendClick = { type: 'click', key: `draft:send:${id}` }
  await Promise.all([pane.post(sendClick, feed), pane.post(sendClick, feed), pane.post({ type: 'click', key: `draft:undo:${id}` }, feed)])

  expect(slack.sent).toEqual([{ channel_id: 'D1', message: 'On it, thanks!' }])
  expect(rowsOf(await pane.drawn(feed)).join('\n')).toContain('✓ Sent')
  await pane.unmount()
})

test('refused calls show the rule and 🔓 Allow Slack; a missing connector points to /mcp; neither retries every 30 s', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const filled: string[] = []
  const calls: string[] = []
  let isGone = false
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('process.run', () => ({ value: ran(1, '') }))
  on('tool.list', () => ({ value: [] }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('mcp.call', ($, e) => {
    calls.push(e.tool)
    if (isGone) throw new Error('No MCP server named claude_ai_Slack')

    return { deny: DENIED }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await enableSlacker(pane)
  await clock.advance(10)
  expect(await pane.find({ type: 'Text', text: /^Claude Code blocked slack_read_user_profile \(Permission to use/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Allow it in /permissions: mcp__claude_ai_Slack__slack_read_user_profile' })).toBeDefined()
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(80) })
  expect((await band.find({ key: 'dock-tab-slacker' }))?.text).toBe('💬 !')
  await band.unmount()

  const refusedCalls = calls.length
  await clock.advance(65_000)
  expect(calls).toHaveLength(refusedCalls)
  await pane.press({ key: 'slacker-allow' })
  expect(filled).toEqual([allowRequestText('claude_ai_Slack')])

  isGone = true
  await pane.press({ key: 'slacker-refresh' })
  expect(await pane.find({ type: 'Text', text: "Slack isn't connected in this session." })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /in \/mcp/ })).toBeDefined()
  expect(await pane.find({ key: 'slacker-allow' })).toBeUndefined()
  const goneCalls = calls.length
  await clock.advance(65_000)
  expect(calls.length).toBeGreaterThan(goneCalls)
  expect(await pane.find({ type: 'Text', text: "Slack isn't connected in this session." })).toBeDefined()
  await pane.unmount()
})
