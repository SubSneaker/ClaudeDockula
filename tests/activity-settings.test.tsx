import type { RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SLOW = { timeoutMs: 60_000 }

function paneProps(): RenderPropsOf['Pane'] {
  return { title: 'Dock', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }
}

test('⚙ opens the settings; rows shown and subagent calls are saved, and rows shown changes the card', SLOW, async ($, on) => {
  const written: unknown[] = []
  on('store.set', { key: 'activity:settings' }, ($, e, next) => {
    written.push(e.value)

    return next(e)
  })
  mock.store(on)
  mock.clock(on)
  on('session.start', () => ({ cwd: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'not a repo', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { ok: true } }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  for (let n = 1; n <= 7; n += 1) await $.tool.call({ tool: 'Read', file_path: `/repo/main-${n}.ts` })

  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps() })
  expect(await ui.find({ type: 'Text', text: 'main-7.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'main-2.ts' })).toBeUndefined()

  await ui.press({ key: 'dock-main-settings-activity' })
  expect(await ui.find({ type: 'Text', text: '⚙ Activity settings' })).toBeDefined()
  await ui.press({ key: 'activity-set-rows-10' })
  await ui.press({ key: 'activity-set-subagents-hide' })
  expect(written.at(-1)).toEqual({ rowsShown: 10, isSubagentShown: false })

  await ui.press({ key: 'activity-settings-done' })
  expect(await ui.find({ type: 'Text', text: 'main-2.ts' })).toBeDefined()
  await ui.unmount()
})

test('hiding calls by other agents drops the calls that carry an agentId and keeps the main loop’s', SLOW, async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('session.start', () => ({ cwd: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'not a repo', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { ok: true } }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Read', file_path: '/repo/main-call.ts' })
  // Held in a variable: the call carries an agentId, which the helper's literal type does not list.
  const otherAgentCall = { tool: 'Read', file_path: '/repo/other-agent-call.ts', agentId: 'sub-1' } as const
  await $.tool.call(otherAgentCall)

  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps() })
  expect(await ui.find({ type: 'Text', text: 'other-agent-call.ts' })).toBeDefined()

  await ui.press({ key: 'dock-main-settings-activity' })
  await ui.press({ key: 'activity-set-subagents-hide' })
  await ui.press({ key: 'activity-settings-done' })
  expect(await ui.find({ type: 'Text', text: 'main-call.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'other-agent-call.ts' })).toBeUndefined()
  await ui.unmount()
})
