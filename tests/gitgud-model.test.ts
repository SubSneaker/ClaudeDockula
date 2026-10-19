import type { RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { PANELS } from '../hooks/panels'
import { KEY, actKey, decodeItemId, docDirOf, encodeItemId, itemId, parseActKey, parseListMessage } from '../hooks/panels/gitgud/model'

test('item ids round-trip through a Button key; anything else reads as none', () => {
  const id = itemId('github.com/acme/webapp', 2086)

  expect(id).toBe('github.com/acme/webapp#2086')
  expect(encodeItemId(id)).toBe('github.com~acme~webapp~2086')
  expect(decodeItemId(encodeItemId(id))).toBe(id)
  expect(decodeItemId(encodeItemId('github.com/o/my.repo_x#1'))).toBe('github.com/o/my.repo_x#1')
  expect(decodeItemId('acme~webapp~2086')).toBe(id)
  expect(['o~r', 'o~r~x', 'o~r~1~x', '~r~1', 'o~r~%E0'].map(decodeItemId)).toEqual([undefined, undefined, undefined, undefined, undefined])
})

test('act keys: the longest action wins, a work prefix reads the same way, a bad id is none', () => {
  expect(actKey('copy-diff', 'github.com/o/r#12')).toBe('gitgud-act-copy-diff-github.com~o~r~12')
  expect(parseActKey('gitgud-act-copy-diff-o~r~12')).toEqual({ action: 'copy-diff', id: 'github.com/o/r#12' })
  expect(parseActKey('gitgud-act-review-here-my-org~a-b~3')).toEqual({ action: 'review-here', id: 'github.com/my-org/a-b#3' })
  expect(parseActKey(actKey('review-bg', 'gitlab.com/g/sub/p#4', KEY.work), KEY.work)).toEqual({ action: 'review-bg', id: 'gitlab.com/g/sub/p#4' })
  expect(parseActKey('gitgud-act-merge-o~r~12')).toBeUndefined()
  expect(parseActKey('gitgud-act-open-o~r')).toBeUndefined()
  expect(parseActKey('jira-act-open-o~r~1')).toBeUndefined()
})

test('list messages are checked before they are trusted', () => {
  expect(parseListMessage({ type: 'open', id: 'o/r#1' })).toEqual({ type: 'open', id: 'o/r#1' })
  expect(parseListMessage({ type: 'open', id: null })).toEqual({ type: 'open', id: null })
  expect(parseListMessage({ type: 'more' })).toEqual({ type: 'more' })
  expect(parseListMessage({ type: 'act', action: 'open', id: 'o/r#1' })).toEqual({ type: 'act', action: 'open', id: 'o/r#1' })
  expect([{ type: 'act', action: 'merge', id: 'o/r#1' }, { type: 'open' }, 'open', null].map(parseListMessage)).toEqual([undefined, undefined, undefined, undefined])
})

test('files go under the Claude folder; the panel is a built-in that waits to be ticked in', () => {
  expect(docDirOf('/Users/example/.claude/', undefined)).toBe('/Users/example/.claude/claudedockula/gitgud')
  expect(docDirOf(undefined, '/Users/example')).toBe('/Users/example/.claude/claudedockula/gitgud')
  expect(docDirOf(' ', undefined)).toBeUndefined()
  expect(PANELS.find(panel => panel.id === 'gitgud')).toMatchObject({ icon: '🐙', isBuiltIn: true })
})

test('ticked in from ⚙ Manage, the card and its band tab draw on terminal and desktop', { timeoutMs: 20_000 }, async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal', isStdoutTruncated: false, isStderrTruncated: false } }))
  const paneProps: RenderPropsOf['Pane'] = { title: 'Dock', isFocused: true, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }
  const bandProps: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 5 }, view: {} }
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps })
  await pane.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'AbovePrompt', props: bandProps })
    expect((await band.find({ key: 'dock-tab-gitgud' }))?.text).toStartWith('🐙')
    await band.unmount()
    const ui = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'Pane', requestId: 'claudedockula', props: paneProps })
    await expect(ui.drawn()).resolves.toBeDefined()
    expect(await ui.find({ type: 'Text', text: /GitHub failed/ })).toBeUndefined()
    await ui.unmount()
  }
})
