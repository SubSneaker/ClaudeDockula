import type { ProcessRunResult, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const GIT_STATUS = [
  '# branch.oid a1b2c3d4e5f0000000000000000000000000000',
  '# branch.head ABC-101/add-export-button',
  '# branch.upstream origin/ABC-101/add-export-button',
  '# branch.ab +2 -1',
  '1 MM N... 100644 100644 100644 a1b2c3d e4f5a6b src/a.ts',
  '? notes.md',
  ''
].join('\n')

const SITES = JSON.stringify([{ id: 'abc', url: 'https://acme.atlassian.net' }])
const ISSUE = JSON.stringify({
  key: 'ABC-101',
  fields: { summary: 'Add export button', status: { name: 'IN REVIEW' }, description: '### Acceptance criteria\n\n* A\n* B' }
})

function ran(exitCode: number, stdout: string): ProcessRunResult {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function paneProps(bodyColumns: number): RenderPropsOf['Pane'] {
  return {
    title: 'Dock',
    isFocused: true,
    bodyColumns,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {}
  }
}

function bandProps(bodyColumns: number): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns, scroll: { offset: 0, bodyRows: 5 }, view: {} }
}

test('every panel draws a valid card and band tab once it holds data', async ($, on) => {
  mock.store(on, {
    settings: { jira: { server: 'atlassian', flavour: 'standard', site: { cloudId: 'abc', url: 'https://acme.atlassian.net' } } },
    'settings:/repo': { checks: [{ id: 'types', name: 'Types', argv: ['pnpm', 'exec', 'tsc', '--noEmit'] }] }
  })
  on('session.root', () => ({ value: '/repo' }))
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', ($, e) => {
    const [command, , subcommand] = e.argv
    if (command === 'git' && subcommand === 'status') return { value: ran(0, GIT_STATUS) }
    if (e.argv.includes('--show-toplevel')) return { value: ran(0, '/repo\n') }
    if (command === 'git') return { value: ran(0, 'ABC-101/add-export-button\n') }

    return { value: ran(2, "src/a.ts(3,1): error TS2322: Type 'x' is wrong.\n") }
  })
  on('mcp.call', ($, e) => {
    const text = e.tool === 'getAccessibleAtlassianResources' ? SITES : ISSUE

    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: { ok: true } }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.tsx', old_string: 'a', new_string: 'b' })

  const first = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await first.press({ key: 'branch-refresh' })
  await first.press({ key: 'jira-refresh' })
  await first.press({ key: 'checks-run-types' })
  await clock.advance(10)
  await first.press({ key: 'checks-toggle-types' })
  await first.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'AbovePrompt', props: bandProps(80) })
    await expect(band.drawn()).resolves.toBeDefined()
    expect((await band.find({ key: 'dock-tab-branch' }))?.text).toBe('🌿 ABC-101 ·2')
    expect((await band.find({ key: 'dock-tab-checks' }))?.text).toBe('❌ 1')
    expect((await band.find({ key: 'dock-tab-activity' }))?.text).toBe('🕘 1')
    expect((await band.find({ key: 'dock-tab-jira' }))?.text).toBe('🎫 In Review')
    await band.unmount()

    const ui = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
    await expect(ui.drawn()).resolves.toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ABC-101\/add-export-button/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↑2 ahead · ↓1 behind origin/ })).toBeDefined()
    expect(await ui.find({ key: 'jira-open' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /error TS2322/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /a\.tsx/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/repo/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /failed:/ })).toBeUndefined()
    await ui.press({ key: 'dock-main-manage' })
    expect(await ui.find({ key: 'dock-main-enable-1-jira' })).toBeDefined()
    await ui.press({ key: 'dock-main-manage' })
    await ui.unmount()
  }
})
