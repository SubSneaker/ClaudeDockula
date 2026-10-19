import type { McpToolResult, On, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// Slacker's ⚙ settings with Slack stubbed: sources, refresh, look back and watched words, each saved at once.

const NOW = Date.UTC(2026, 9, 15, 9, 0, 0)
const ME = 'U08ME'
const SLOW = { timeoutMs: 60_000 }
const MENTION_TS = ((NOW - 60 * 60_000) / 1000).toFixed(6)
const DM_TS = ((NOW - 10 * 60_000) / 1000).toFixed(6)

function block(index: number, fields: { channel: string; channelId: string; from: string; fromId: string; ts: string; text: string; participants?: string }): string {
  const link = `https://acme.slack.com/archives/${fields.channelId}/p${fields.ts.replace('.', '')}`

  return [
    `### Result ${index} of 1`,
    `Channel: ${fields.channel} (ID: ${fields.channelId})`,
    ...(fields.participants ? [`Participants: ${fields.participants}`] : []),
    `From: ${fields.from} <someone@acme.io> (ID: ${fields.fromId}) `,
    'Time: 2026-10-15 15:04:50 JST',
    `Message_ts: ${fields.ts}`,
    `Permalink: [link](${link})`,
    'Text: ',
    fields.text,
    '',
    '---',
    ''
  ].join('\n')
}

const MENTION = block(1, { channel: '#dev-app', channelId: 'C1', from: 'Grace Hopper', fromId: 'U07', ts: MENTION_TS, text: `<@${ME}|Ada> look at this` })
const DM = block(1, { channel: 'DM', channelId: 'D1', participants: `Grace Hopper (ID: U07), Ada (ID: ${ME})`, from: 'Grace Hopper', fromId: 'U07', ts: DM_TS, text: 'a private hello' })

function searchText(blocks: readonly string[]): string {
  return `# Search Results for: \n\n## Messages (${blocks.length} results)\n${blocks.join('\n')}`
}

function answer(field: string, text: string): { value: McpToolResult } {
  return { value: { content: [{ type: 'text', text: JSON.stringify({ [field]: text }) }], isError: false } }
}

/** Slack as the connector answers it: you, one @ and one DM; every search is kept. */
function mockSlack(on: On): Record<string, unknown>[] {
  const searched: Record<string, unknown>[] = []
  on('mcp.call', ($, e) => {
    if (e.tool === 'slack_read_user_profile') return answer('result', `User ID: ${ME}\nDisplay Name: Ada\n`)
    if (e.tool !== 'slack_search_public_and_private') return answer('messages', '')
    searched.push(e.args)
    if (e.args.channel_types === 'im,mpim') return answer('results', searchText([DM]))
    if (Array.isArray(e.args.keywords) && e.args.keywords.includes(`<@${ME}>`)) return answer('results', searchText([MENTION]))

    return answer('results', searchText([]))
  })

  return searched
}

const PANE: RenderPropsOf['Pane'] = { title: 'Dock', isFocused: true, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }

test('⚙ opens Slacker settings: sources hide DMs and their chip, refresh and look back save, words edit, ★ Watch is gone', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const stored = new Map<string, unknown>()
  on('store.set', { key: 'slacker:settings' }, ($, e, next) => {
    stored.set(e.key, e.value)

    return next(e)
  })
  on('store.set', { key: 'slacker:keywords' }, ($, e, next) => {
    stored.set(e.key, e.value)

    return next(e)
  })
  mock.store(on)
  const searched = mockSlack(on)
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.tool === 'AskUserQuestion' ? (e.questions[0]?.question ?? '') : ''

    return { result: { questions: [], answers: { [question]: 'deploy' } } }
  })
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'mobile', component: 'Pane', requestId: 'claudedockula', props: PANE })
  for (const key of ['dock-main-manage', 'dock-main-enable-1-slacker', 'dock-main-manage']) await pane.press({ key })
  await clock.advance(10)
  expect(await pane.find({ key: 'slacker-watch' })).toBeUndefined()
  expect(await pane.find({ key: 'slacker-filter:dm' })).toBeDefined()
  expect(await pane.find({ key: `slacker-item:D1:${DM_TS}` })).toBeDefined()

  await pane.press({ key: 'dock-main-settings-slacker' })
  expect(await pane.find({ key: 'slacker-settings-done' })).toBeDefined()
  expect(await pane.find({ key: 'slacker-set-source-dm' })).toBeDefined()
  await pane.press({ key: 'slacker-set-source-dm' })
  expect(stored.get('slacker:settings')).toEqual({ sources: ['mention', 'thread'] })
  await clock.advance(10)
  await pane.press({ key: 'slacker-settings-done' })
  expect(await pane.find({ key: 'slacker-filter:dm' })).toBeUndefined()
  expect(await pane.find({ key: `slacker-item:D1:${DM_TS}` })).toBeUndefined()
  expect(await pane.find({ key: `slacker-item:C1:${MENTION_TS}` })).toBeDefined()
  expect(searched.at(-1)?.channel_types).toBeUndefined()

  await pane.press({ key: 'dock-main-settings-slacker' })
  await pane.press({ key: 'slacker-set-days-3' })
  await clock.advance(10)
  expect(stored.get('slacker:settings')).toEqual({ sources: ['mention', 'thread'], days: 3 })
  expect(searched.at(-1)?.filters).toContain('after:2026-10-12')
  await pane.press({ key: 'slacker-set-refresh-300' })
  expect(stored.get('slacker:settings')).toEqual({ sources: ['mention', 'thread'], days: 3, refreshSeconds: 300 })
  await clock.advance(10)
  const reads = searched.length
  await clock.advance(65_000)
  expect(searched).toHaveLength(reads)
  await clock.advance(300_000)
  expect(searched.length).toBeGreaterThan(reads)

  await pane.press({ key: 'slacker-set-word-add' })
  await clock.advance(10)
  expect(stored.get('slacker:keywords')).toEqual(['deploy'])
  await pane.press({ key: 'slacker-set-word-remove-0' })
  expect(stored.get('slacker:keywords')).toEqual([])
  await pane.unmount()
})
