import type { ProcessRunResult, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { isAllowedArgv } from '../hooks/panels/gitgud/guard'

const REPO = 'acme/webapp'

function ran(exitCode: number, stdout: string): ProcessRunResult {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function prList(entries: [number, string[]][]): string {
  return JSON.stringify(
    entries.map(([number, paths]) => ({
      number,
      title: `PR ${number}`,
      author: { login: 'linus' },
      headRefName: `ABC-${number}/work`,
      url: `https://github.com/${REPO}/pull/${number}`,
      changedFiles: paths.length,
      files: paths.map((path) => ({ path }))
    }))
  )
}

const paneProps: RenderPropsOf['Pane'] = { title: 'Dock', isFocused: true, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }
const bandProps: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 5 }, view: {} }

test('a new overlap raises one band notice; a seen one, checked again, does not', { timeoutMs: 30_000 }, async ($, on) => {
  mock.store(on)
  on('session.root', () => ({ value: '/repo' }))
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/repo' }))
  let prs = prList([[5, ['src/a.ts', 'docs/x.md']]])
  on('process.run', ($, e) => {
    const [command, , subcommand] = e.argv
    if (command === 'git' && subcommand === 'status') return { value: ran(0, ' M src/a.ts\0?? src/b.ts\0') }
    if (command === 'git' && subcommand === 'merge-base') return { value: ran(1, '') }
    if (command === 'git') return { value: ran(0, 'feat/x\n') }
    if (e.argv.includes('list')) return { value: ran(0, prs) }
    if (e.argv.includes('repo')) return { value: ran(0, JSON.stringify({ nameWithOwner: REPO, url: `https://github.com/${REPO}`, defaultBranchRef: { name: 'develop' } })) }
    if (e.argv.includes('auth')) return { value: ran(0, '') }

    return { value: ran(1, '') }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps })
  for (const key of ['dock-main-manage', 'dock-main-enable-1-gitgud', 'dock-main-manage']) await pane.press({ key })
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
  const noticesAbout = async (text: RegExp) => {
    await band.redraw(bandProps)

    return (await band.find({ text }))?.text
  }

  // The tick finds #5; the first sight of the overlaps is seeded silently.
  await clock.advance(60_000)
  expect(await noticesAbout(/touches/)).toBeUndefined()

  prs = prList([[5, ['src/a.ts']], [6, ['src/b.ts']]])
  await pane.press({ key: 'gitgud-refresh' })
  expect(await noticesAbout(/#6 \(linus\) touches 1 file/)).toBeDefined()

  // Once the notice has expired, a second check of the same overlap does not raise it again.
  await clock.advance(10_000)
  expect(await noticesAbout(/touches/)).toBeUndefined()
  await pane.press({ key: 'gitgud-refresh' })
  expect(await noticesAbout(/touches/)).toBeUndefined()
})

test("after a branch switch the check reads the branch again: the new branch's own PR is no overlap", { timeoutMs: 30_000 }, async ($, on) => {
  mock.store(on)
  on('session.root', () => ({ value: '/repo' }))
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/repo' }))
  let branch = 'feat/x'
  let prs = prList([[5, ['src/a.ts']]])
  const branches: (string | undefined)[] = []
  on('state.set', { key: 'gitgud' }, ($, e, next) => {
    if (e.key === 'gitgud') branches.push(e.value.branch)

    return next(e)
  })
  on('process.run', ($, e) => {
    const [command, , subcommand] = e.argv
    if (command === 'git' && subcommand === 'status') return { value: ran(0, ' M src/a.ts\0?? src/b.ts\0') }
    if (command === 'git' && subcommand === 'merge-base') return { value: ran(1, '') }
    if (command === 'git') return { value: ran(0, `${branch}\n`) }
    if (e.argv.includes('list')) return { value: ran(0, prs) }
    if (e.argv.includes('repo')) return { value: ran(0, JSON.stringify({ nameWithOwner: REPO, url: `https://github.com/${REPO}`, defaultBranchRef: { name: 'develop' } })) }
    if (e.argv.includes('auth')) return { value: ran(0, '') }

    return { value: ran(1, '') }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps })
  for (const key of ['dock-main-manage', 'dock-main-enable-1-gitgud', 'dock-main-manage']) await pane.press({ key })
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
  // The tick finds #5 on feat/x (seeded silently); the overlap row and its ↻ are drawn from then on.
  await clock.advance(60_000)

  // Bash switched to PR #6's branch; #6 and #7 now both touch src/b.ts. The panel's own poll has not run since.
  branch = 'ABC-6/work'
  prs = prList([[5, ['src/a.ts']], [6, ['src/b.ts']], [7, ['src/b.ts']]])
  await pane.press({ key: 'gitgud-overlap-refresh' })
  await band.redraw(bandProps)
  expect((await band.find({ text: /#7 \(linus\) touches/ }))?.text).toBeDefined()
  expect(await band.find({ text: /#6 \(linus\) touches/ })).toBeUndefined()
  expect(branches.at(-1)).toBe('ABC-6/work')
})

test('a shared file opens the inspector with both diffs; the row menu fills a conflict-resolution prompt', { timeoutMs: 30_000 }, async ($, on) => {
  mock.store(on)
  on('session.root', () => ({ value: '/repo' }))
  const clock = mock.clock(on)
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/repo' }))
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  const HEAD = 'a'.repeat(40)
  const MERGE_BASE = 'b'.repeat(40)
  const theirsPatch = '@@ -10,3 +10,3 @@\n one\n-two\n+deux\n three'
  const mineDiff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,3 +10,3 @@\n one\n-two\n+mine line\n three\n'
  const argvs: string[][] = []
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    argvs.push(argv)
    const [command, , subcommand] = argv
    if (command === 'git' && subcommand === 'status') return { value: ran(0, ' M src/a.ts\0') }
    if (command === 'git' && subcommand === 'merge-base') return { value: ran(0, `${MERGE_BASE}\n`) }
    if (command === 'git' && subcommand === 'diff' && argv.includes('--name-status')) return { value: ran(0, 'M\0src/a.ts\0') }
    if (command === 'git' && subcommand === 'diff') return { value: ran(0, mineDiff) }
    if (command === 'git' && argv.includes('--show-toplevel')) return { value: ran(0, '/repo\n') }
    if (command === 'git') return { value: ran(0, 'feat/x\n') }
    if (argv.includes('headRefOid')) return { value: ran(0, JSON.stringify({ headRefOid: HEAD })) }
    if (argv[1] === 'api' && argv[2]?.startsWith('repos/')) return { value: ran(0, JSON.stringify([{ filename: 'src/a.ts', patch: theirsPatch }])) }
    if (e.argv.includes('list')) return { value: ran(0, prList([[5, ['src/a.ts']]])) }
    if (e.argv.includes('repo')) return { value: ran(0, JSON.stringify({ nameWithOwner: REPO, url: `https://github.com/${REPO}`, defaultBranchRef: { name: 'develop' } })) }
    if (e.argv.includes('auth')) return { value: ran(0, '') }

    return { value: ran(1, '') }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps })
  for (const key of ['dock-main-manage', 'dock-main-enable-1-gitgud', 'dock-main-manage']) await pane.press({ key })
  await clock.advance(60_000)

  // ▸ shows the shared files; pressing one opens the inspector on the doc pane.
  await pane.press({ key: 'gitgud-overlap-toggle' })
  await pane.press({ key: `gitgud-overlap-file-5-${encodeURIComponent('src/a.ts')}` })
  await clock.settle()
  expect(opened).toContain('claudedockula-doc')
  const doc = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula-doc', props: { ...paneProps, bodyColumns: 100 } })
  expect(await doc.find({ type: 'Code', text: /\+mine line/ })).toBeDefined()
  expect(await doc.find({ type: 'Code', text: /\+deux/ })).toBeDefined()
  expect(await doc.find({ type: 'Text', text: /1 hunk overlaps · base line 11/ })).toBeDefined()
  expect(await doc.find({ type: 'Text', text: /also changed in #5/ })).toBeDefined()

  // The PR row's menu: 🧩 fills the prompt with both diffs as data and no git writes by the model.
  await pane.press({ key: 'gitgud-overlap-row-5' })
  expect(await pane.find({ key: 'gitgud-overlap-act-copy-5' })).toBeDefined()
  await pane.press({ key: 'gitgud-overlap-act-prompt-5' })
  await clock.settle()
  expect(filled).toHaveLength(1)
  expect(filled[0]).toContain('+mine line')
  expect(filled[0]).toContain('+deux')
  expect(filled[0]).toContain('with `!`')
  expect(await pane.find({ key: 'gitgud-overlap-act-copy-5' })).toBeUndefined()
  expect(argvs.filter((argv) => !isAllowedArgv(argv))).toEqual([])
  await doc.unmount()
  await pane.unmount()
})

test('an untracked symlink is not read through to its target; the inspector says so', { timeoutMs: 30_000 }, async ($, on) => {
  mock.store(on)
  on('session.root', () => ({ value: '/repo' }))
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 0, isLink: true } }))
  const reads: string[] = []
  on('fs.read', ($, e) => {
    reads.push(e.path)

    return { value: 'SECRET' }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    const [command, , subcommand] = argv
    if (command === 'git' && subcommand === 'status') return { value: ran(0, '?? src/a.ts\0') }
    if (command === 'git' && subcommand === 'merge-base') return { value: ran(0, `${'b'.repeat(40)}\n`) }
    if (command === 'git' && subcommand === 'diff' && argv.includes('--name-status')) return { value: ran(0, '') }
    if (command === 'git' && subcommand === 'diff') return { value: ran(0, '') }
    if (command === 'git' && argv.includes('--show-toplevel')) return { value: ran(0, '/repo\n') }
    if (command === 'git') return { value: ran(0, 'feat/x\n') }
    if (e.argv.includes('list')) return { value: ran(0, prList([[5, ['src/a.ts']]])) }
    if (e.argv.includes('repo')) return { value: ran(0, JSON.stringify({ nameWithOwner: REPO, url: `https://github.com/${REPO}`, defaultBranchRef: { name: 'develop' } })) }
    if (e.argv.includes('auth')) return { value: ran(0, '') }

    return { value: ran(1, '') }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps })
  for (const key of ['dock-main-manage', 'dock-main-enable-1-gitgud', 'dock-main-manage']) await pane.press({ key })
  await clock.advance(60_000)
  await pane.press({ key: 'gitgud-overlap-toggle' })
  await pane.press({ key: `gitgud-overlap-file-5-${encodeURIComponent('src/a.ts')}` })
  await clock.settle()
  const doc = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula-doc', props: { ...paneProps, bodyColumns: 100 } })
  expect(await doc.find({ type: 'Text', text: /Untracked symlink/ })).toBeDefined()
  expect(reads.filter((path) => path.endsWith('src/a.ts'))).toEqual([])
  await doc.unmount()
  await pane.unmount()
})

test('a cut PR file list says it is too large and is read again, never cached as complete', { timeoutMs: 30_000 }, async ($, on) => {
  mock.store(on)
  on('session.root', () => ({ value: '/repo' }))
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/repo' }))
  const HEAD = 'a'.repeat(40)
  let fileReads = 0
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    const [command, , subcommand] = argv
    if (command === 'git' && subcommand === 'status') return { value: ran(0, ' M src/a.ts\0') }
    if (command === 'git' && subcommand === 'merge-base') return { value: ran(0, `${'b'.repeat(40)}\n`) }
    if (command === 'git' && subcommand === 'diff' && argv.includes('--name-status')) return { value: ran(0, 'M\0src/a.ts\0') }
    if (command === 'git' && subcommand === 'diff') return { value: ran(0, '') }
    if (command === 'git' && argv.includes('--show-toplevel')) return { value: ran(0, '/repo\n') }
    if (command === 'git') return { value: ran(0, 'feat/x\n') }
    if (argv.includes('headRefOid')) return { value: ran(0, JSON.stringify({ headRefOid: HEAD })) }
    if (argv[1] === 'api' && argv[2]?.startsWith('repos/')) {
      fileReads += 1

      return { value: { ...ran(0, JSON.stringify([{ filename: 'src/other.ts', patch: '@@ -1 +1 @@\n-a\n+b' }])), isStdoutTruncated: true } }
    }
    if (e.argv.includes('list')) return { value: ran(0, prList([[5, ['src/a.ts']]])) }
    if (e.argv.includes('repo')) return { value: ran(0, JSON.stringify({ nameWithOwner: REPO, url: `https://github.com/${REPO}`, defaultBranchRef: { name: 'develop' } })) }
    if (e.argv.includes('auth')) return { value: ran(0, '') }

    return { value: ran(1, '') }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps })
  for (const key of ['dock-main-manage', 'dock-main-enable-1-gitgud', 'dock-main-manage']) await pane.press({ key })
  await clock.advance(60_000)
  await pane.press({ key: 'gitgud-overlap-toggle' })
  await pane.press({ key: `gitgud-overlap-file-5-${encodeURIComponent('src/a.ts')}` })
  await clock.settle()
  const doc = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula-doc', props: { ...paneProps, bodyColumns: 100 } })
  expect(await doc.find({ type: 'Text', text: /file list is too large to read here/ })).toBeDefined()
  expect(await doc.find({ type: 'Text', text: /no longer lists this file/ })).toBeUndefined()

  const before = fileReads
  await doc.press({ key: 'gitgud-diffpane-refresh' })
  await clock.settle()
  expect(fileReads).toBeGreaterThan(before)
  await doc.unmount()
  await pane.unmount()
})
