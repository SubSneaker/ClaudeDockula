import type { On, ProcessRunResult, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PACKAGE_JSON = JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest' } })
const LINT = { id: 'lint', name: 'Lint', argv: ['pnpm', 'run', 'lint'] }

const SLOW = { timeoutMs: 30_000 }

function paneProps(): RenderPropsOf['Pane'] {
  return { title: 'Dock', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }
}

function bandProps(): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 11 }, view: {} }
}

function ran(exitCode: number): ProcessRunResult {
  return { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

/** A session in /repo with `saved` as the repo's checks (none: not set up yet); returns what was saved and the run limits seen. */
async function start($: Parameters<NonNullable<Parameters<typeof test>[2]>>[0], on: On, saved?: unknown) {
  const stored: Record<string, unknown> = {}
  const limits: Array<number | undefined> = []
  const clock = mock.clock(on)
  for (const key of ['settings:/repo', 'checks:settings']) {
    on('store.set', { key }, ($, e, next) => {
      stored[e.key] = e.value

      return next(e)
    })
  }
  mock.store(on, saved === undefined ? {} : { 'settings:/repo': { checks: saved } })
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.read', ($, e) => (e.path === '/repo/package.json' ? { value: PACKAGE_JSON } : { deny: 'ENOENT' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', ($, e) => {
    if (e.argv.includes('--show-toplevel')) return { value: { ...ran(0), stdout: '/repo\n' } }
    if (e.argv[0] === 'pnpm') limits.push(e.init?.timeoutMs)

    return { value: ran(0) }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps() })
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps() })

  return { ui, band, stored, limits, clock }
}

test('the header ⚙ opens the settings; the body has no ⚙; a change saves and takes effect', SLOW, async ($, on) => {
  const { ui, band, stored, limits, clock } = await start($, on, [LINT])
  expect(await ui.find({ key: 'checks-setup' })).toBeUndefined()
  expect(await ui.find({ key: 'checks-run-lint' })).toBeDefined()

  await ui.press({ key: 'dock-main-settings-checks' })
  expect(await ui.find({ type: 'Text', text: /⚙ Checks settings/ })).toBeDefined()
  expect(await ui.find({ key: 'checks-run-lint' })).toBeUndefined()

  // A tick saves at once for a repo that is set up.
  await ui.press({ key: 'checks-pick-test' })
  expect(stored['settings:/repo']).toEqual({ checks: [LINT, { id: 'test', name: 'Test', argv: ['npm', 'run', 'test'] }] })

  await ui.press({ key: 'checks-set-timeout-5' })
  await ui.press({ key: 'checks-set-notify-off' })
  expect(stored['checks:settings']).toEqual({ timeLimitSeconds: 300, isNoticeOnFinish: false })

  await ui.press({ key: 'checks-settings-done' })
  await ui.press({ key: 'checks-run-lint' })
  await clock.advance(10)
  await clock.settle()
  expect(limits).toEqual([300_000])
  expect(await band.find({ type: 'Text', text: /Lint passed/ })).toBeUndefined()

  // The default stands until the person chooses: a notice, a 10 minute limit.
  await ui.press({ key: 'dock-main-settings-checks' })
  await ui.press({ key: 'checks-set-notify-on' })
  await ui.press({ key: 'dock-main-settings-checks' })
  await ui.press({ key: 'checks-run-lint' })
  await clock.advance(10)
  await clock.settle()
  expect(await band.find({ type: 'Text', text: /Lint passed/ })).toBeDefined()
  await ui.unmount()
  await band.unmount()
})

test('a repo that is not set up opens the settings, keeps the header ⚙ open until Done, and Reset all asks again', SLOW, async ($, on) => {
  const { ui, stored } = await start($, on)
  expect(await ui.find({ type: 'Text', text: /⚙ Checks settings/ })).toBeDefined()
  await ui.press({ key: 'dock-main-settings-checks' })
  expect(await ui.find({ type: 'Text', text: /⚙ Checks settings/ })).toBeDefined()

  await ui.press({ key: 'checks-pick-lint' })
  expect(stored['settings:/repo']).toBeUndefined()
  await ui.press({ key: 'checks-settings-done' })
  expect(stored['settings:/repo']).toEqual({ checks: [{ ...LINT, argv: ['npm', 'run', 'lint'] }] })
  expect(await ui.find({ key: 'checks-run-lint' })).toBeDefined()

  await ui.press({ key: 'dock-main-manage' })
  await ui.press({ key: 'dock-main-reset-all' })
  await ui.press({ key: 'dock-main-reset-all-yes' })
  expect(await ui.find({ type: 'Text', text: /⚙ Checks settings/ })).toBeDefined()
  expect(await ui.find({ key: 'checks-run-lint' })).toBeUndefined()
  await ui.unmount()
})
