import { describe, expect, test } from 'claude-code/testing'

import { checksIcon, summarizeChecks } from '../hooks/panels/checks'
import { describeFinish, describeRunAll, toggleExpanded, withRunsInterrupted } from '../hooks/panels/checks/run'
import { formatDuration, summarizeCheckOutput } from '../hooks/panels/checks/summary'

const CWD = '/Users/me/repo'
const PNPM_WARNING = '[WARN] Unsupported engine: wanted: {"node":">=24.14 <25"}'

describe('summarizeCheckOutput', () => {
  test('a zero exit passes with no lines', () => {
    expect(summarizeCheckOutput({ exitCode: 0, stdout: PNPM_WARNING, stderr: '' })).toEqual({
      isPassed: true,
      lines: []
    })
  })

  test('tsc: counts errors, keeps file lines, drops continuations and pnpm noise', () => {
    const typeError = "src/app/[lang]/(authenticated)/assets/_components/Item.test.tsx(37,9): error TS2741: Property 'x' is missing."
    const stdout = [
      PNPM_WARNING,
      typeError,
      '  Types of property actionConfig are incompatible.',
      'src/utils/config.test.ts(486,51): error TS2345: Argument of type {} is not assignable.'
    ].join('\n')
    const summary = summarizeCheckOutput({ exitCode: 2, stdout, stderr: '' }, CWD)

    expect(summary.problem).toBe('2 errors')
    expect(summary.lines).toEqual([
      "…/_components/Item.test.tsx(37,9): error TS2741: Property 'x' is missing.",
      'src/utils/config.test.ts(486,51): error TS2345: Argument of type {} is not assignable.'
    ])
  })

  test('eslint: strips colors and puts the file on each problem', () => {
    const stdout = [
      '\u001b[4m/Users/me/repo/src/components/Foo.tsx\u001b[24m',
      "  \u001b[2m12:5\u001b[22m  \u001b[31merror\u001b[39m  'x' is unused  no-unused-vars",
      '',
      '\u001b[31m✖ 1 problem (1 error, 0 warnings)\u001b[39m'
    ].join('\n')
    const summary = summarizeCheckOutput({ exitCode: 1, stdout, stderr: '' }, CWD)

    expect(summary.problem).toBe('1 error')
    expect(summary.lines).toEqual(["src/components/Foo.tsx:12:5 'x' is unused  no-unused-vars"])
  })

  test('prettier: lists the unformatted files', () => {
    const stderr = '[warn] .claude/settings.local.json\n[warn] Code style issues found in the above file. Run Prettier with --write to fix.'
    const summary = summarizeCheckOutput({ exitCode: 1, stdout: 'Checking formatting...', stderr }, CWD)

    expect(summary.problem).toBe('1 file to format')
    expect(summary.lines).toEqual(['.claude/settings.local.json'])
  })

  test('vitest: counts failed tests', () => {
    const stdout = [
      ' FAIL  src/utils/sum.test.ts > sum > adds',
      'AssertionError: expected 3 to be 4',
      ' Test Files  1 failed | 10 passed (11)',
      '      Tests  1 failed | 50 passed (51)'
    ].join('\n')
    const summary = summarizeCheckOutput({ exitCode: 1, stdout, stderr: '' }, CWD)

    expect(summary.problem).toBe('1 test failed')
    expect(summary.lines[0]).toBe('FAIL  src/utils/sum.test.ts > sum > adds')
  })

  test('output with no count or file falls back to the exit code and error lines', () => {
    const summary = summarizeCheckOutput({ exitCode: 127, stdout: '', stderr: 'boot\nError: command not found' })

    expect(summary.problem).toBe('exit code 127')
    expect(summary.lines).toEqual(['Error: command not found'])
  })
})

describe('formatting', () => {
  test('durations', () => {
    expect(formatDuration(400)).toBe('<1s')
    expect(formatDuration(42_000)).toBe('42s')
    expect(formatDuration(65_000)).toBe('1m 05s')
  })

  test('finish toasts', () => {
    expect(describeFinish('Types', { isPassed: false, problem: '3 errors', lines: [] }, 9000)).toBe(
      'Types failed: 3 errors'
    )
    expect(describeFinish('Lint', { isPassed: true, lines: [] }, 42_000)).toBe('Lint passed in 42s')
    expect(describeRunAll([{ name: 'Lint', isPassed: true }, { name: 'Types', isPassed: false }])).toBe(
      '1 of 2 checks failed: Types'
    )
  })

  test('the details toggle', () => {
    expect(toggleExpanded(toggleExpanded({}, 'types'), 'lint').expanded).toEqual(['types', 'lint'])
    expect(toggleExpanded({ expanded: ['types'] }, 'types').expanded).toEqual([])
  })

  test('a reload turns runs left running into interrupted failures', () => {
    const state = { isRunningAll: true, runs: { lint: { status: 'running', startedAt: 1 }, types: { status: 'passed', durationMs: 9 } } } as const
    const after = withRunsInterrupted(state)

    expect(after.isRunningAll).toBe(false)
    expect(after.runs?.lint).toEqual({ status: 'failed', problem: 'interrupted by a reload' })
    expect(after.runs?.types).toEqual({ status: 'passed', durationMs: 9 })
  })
})

test('the band summary: passed out of all, failures, running, never run, not set up', () => {
  const passed = { status: 'passed', durationMs: 1 } as const
  const checks = ['lint', 'types', 'tests', 'format'].map(id => ({ id, name: id, argv: ['run', id] }))
  const base = { isLoaded: true, checks }

  expect([checksIcon(base), summarizeChecks(base)]).toEqual(['✅', '–'])
  expect(summarizeChecks({ ...base, runs: { lint: passed, types: passed } })).toBe('2/4')
  expect([checksIcon({ ...base, runs: { lint: passed, types: { status: 'failed' } } }), summarizeChecks({ ...base, runs: { types: { status: 'failed' } } })]).toEqual(['❌', '1'])
  expect([checksIcon({ ...base, runs: { lint: { status: 'running' } } }), summarizeChecks({ ...base, runs: { lint: { status: 'running' } } })]).toEqual(['⏳', ''])
  expect(summarizeChecks({ isLoaded: true })).toBe('set up')
  expect(summarizeChecks({ isLoaded: true, checks: [] })).toBe('–')
})
