import type { On, ProcessRunResult, RenderPropsOf } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import { GIT_WORKTREES, isAllowedBranchArgv } from '../hooks/panels/branch/guard'
import { parseWorktrees } from '../hooks/panels/branch/settings'

const STATUS = [
  '# branch.oid a1b2c3d4e5f0000000000000000000000000000',
  '# branch.head ABC-101/add-export',
  '1 .M N... 100644 100644 100644 a1b2c3d a1b2c3d src/a.ts',
  '? notes.md',
  ''
].join('\n')
const TWO_WORKTREES = 'worktree /repo\nHEAD abc\nbranch refs/heads/develop\n\nworktree /repo-wt\nHEAD def\nbranch refs/heads/ABC-101/add-export\n'
const ONE_WORKTREE = 'worktree /repo\nHEAD abc\nbranch refs/heads/develop\n'
const SLOW = { timeoutMs: 60_000 }

function ran(stdout: string): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function paneProps(): RenderPropsOf['Pane'] {
  return { title: 'Dock', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
}

/** What the panel wrote to the store, by key. */
type Written = Record<string, unknown>

async function startBranch($: Engine, on: On, worktrees: string, saved: Record<string, unknown> = {}) {
  const written: Written = {}
  for (const key of ['branch:settings', 'settings']) {
    on('store.set', { key }, ($, e, next) => {
      written[e.key] = e.value

      return next(e)
    })
  }
  mock.store(on, saved)
  mock.clock(on)
  on('session.start', () => ({ cwd: '/repo-wt' }))
  on('session.cwd', () => ({ value: '/repo-wt' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const argvs: string[][] = []
  on('process.run', ($, e) => {
    argvs.push([...e.argv])

    if (e.argv.includes('--show-toplevel')) return { value: ran('/repo\n') }

    return { value: ran(e.argv.includes('worktree') ? worktrees : STATUS) }
  })
  await $.session.start({ cwd: '/repo-wt', surface: 'terminal', isInteractive: true })

  return { argvs, written, ui: await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps() }) }
}

test('⚙ opens the settings; a choice is saved and takes effect; Done closes', SLOW, async ($, on) => {
  const { ui, written } = await startBranch($, on, ONE_WORKTREE)
  expect(await ui.find({ type: 'Text', text: /notes\.md/ })).toBeDefined()

  await ui.press({ key: 'dock-main-settings-branch' })
  expect(await ui.find({ type: 'Text', text: '⚙ Branch settings' })).toBeDefined()
  await ui.press({ key: 'branch-set-refresh-60' })
  await ui.press({ key: 'branch-set-untracked-hide' })
  expect(written['branch:settings']).toEqual({ refreshSeconds: 60, isUntrackedShown: false })

  await ui.press({ key: 'branch-settings-done' })
  expect(await ui.find({ type: 'Text', text: /notes\.md/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /src\/a\.ts|a\.ts/ })).toBeDefined()
  await ui.unmount()
})

test('the Worktrees section draws with two worktrees, is hidden with one, and by the setting', SLOW, async ($, on) => {
  const two = await startBranch($, on, TWO_WORKTREES)
  expect(await two.ui.find({ type: 'Text', text: 'Worktrees' })).toBeDefined()
  expect(await two.ui.find({ type: 'Text', text: /\/repo-wt/ })).toBeDefined()
  expect(two.argvs).toContainEqual([...GIT_WORKTREES])

  await two.ui.press({ key: 'dock-main-settings-branch' })
  await two.ui.press({ key: 'branch-set-worktrees-hide' })
  await two.ui.press({ key: 'branch-settings-done' })
  expect(await two.ui.find({ type: 'Text', text: 'Worktrees' })).toBeUndefined()
  await two.ui.unmount()
})

test('with one worktree there is no section', SLOW, async ($, on) => {
  const one = await startBranch($, on, ONE_WORKTREE)
  expect(await one.ui.find({ type: 'Text', text: 'Worktrees' })).toBeUndefined()
  await one.ui.unmount()
})

test('the guard allows the worktree list and the status read, and refuses anything that writes', () => {
  expect(isAllowedBranchArgv(['git', '--no-optional-locks', 'worktree', 'list', '--porcelain'])).toBe(true)
  expect(isAllowedBranchArgv(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'])).toBe(true)
  expect(isAllowedBranchArgv(['git', '--no-optional-locks', 'worktree', 'add', '../x'])).toBe(false)
  expect(isAllowedBranchArgv(['git', '--no-optional-locks', 'worktree', 'list', '--porcelain', '-z'])).toBe(false)
  expect(isAllowedBranchArgv(['git', 'worktree', 'prune'])).toBe(false)
})

test('parseWorktrees marks the deepest worktree holding the cwd', () => {
  const [main, linked] = parseWorktrees(TWO_WORKTREES, '/repo-wt/src')

  expect(main).toEqual({ path: '/repo', branch: 'develop', isCurrent: false })
  expect(linked).toEqual({ path: '/repo-wt', branch: 'ABC-101/add-export', isCurrent: true })
})

test('the ticket pattern is edited in the shared settings and keeps its other fields', SLOW, async ($, on) => {
  const { ui, written } = await startBranch($, on, ONE_WORKTREE, { settings: { branchTemplate: 'feat/{key}-', ticketPattern: 'OLD-\\d+' } })

  await ui.press({ key: 'dock-main-settings-branch' })
  await ui.input({ key: 'branch-set-ticket-pattern', text: '[A-Z]{2,4}-\\d+', kind: 'submit' })
  expect(written.settings).toEqual({ branchTemplate: 'feat/{key}-', ticketPattern: '[A-Z]{2,4}-\\d+' })
  expect(written['branch:settings']).toBeUndefined()

  await ui.input({ key: 'branch-set-ticket-pattern', text: '  ', kind: 'submit' })
  expect(written.settings).toEqual({ branchTemplate: 'feat/{key}-' })
  await ui.unmount()
})

test('an invalid ticket pattern is not saved and the view says so', SLOW, async ($, on) => {
  const { ui, written } = await startBranch($, on, ONE_WORKTREE, { settings: { ticketPattern: 'OLD-\\d+' } })

  await ui.press({ key: 'dock-main-settings-branch' })
  await ui.input({ key: 'branch-set-ticket-pattern', text: '([', kind: 'submit' })
  expect(written.settings).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'That ticket pattern is not valid. It was not saved.' })).toBeDefined()

  await ui.input({ key: 'branch-set-ticket-pattern', text: 'NEW-\\d+', kind: 'submit' })
  expect(written.settings).toEqual({ ticketPattern: 'NEW-\\d+' })
  expect(await ui.find({ type: 'Text', text: 'That ticket pattern is not valid. It was not saved.' })).toBeUndefined()
  await ui.unmount()
})
