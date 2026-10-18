import { expect, test } from 'claude-code/testing'

import {
  cleanCodeText,
  diffRuns,
  diffSide,
  findPrFile,
  fitHunks,
  overlapRanges,
  overlapSummary,
  parseHunks,
  parseJsonSequence,
  parsePrFiles,
  trimHunk,
  untrackedHunk
} from '../hooks/panels/github/diff'
import { conflictResolutionPrompt } from '../hooks/panels/github/prompts'

const MINE = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1..2 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,4 +10,4 @@ function a() {',
  ' one',
  '-two',
  '+TWO',
  ' three',
  ' four',
  '@@ -50,3 +50,4 @@',
  ' x',
  '+inserted',
  ' y',
  ' z',
  '\\ No newline at end of file'
].join('\n')
const THEIRS = ['@@ -9,5 +9,5 @@', ' zero', ' one', '-two', '+deux', ' three', ' four', '@@ -80,2 +80,3 @@', ' p', '+q', ' r'].join('\n')

test('hunks: headers read past, base spans from - lines and insertion points', () => {
  const hunks = parseHunks(MINE)
  expect(hunks.map(hunk => [hunk.oldStart, hunk.oldCount, hunk.span])).toEqual([
    [10, 4, [11, 11]],
    [50, 3, [50, 51]]
  ])
  expect(hunks[0]?.text.startsWith('@@ -10,4 +10,4 @@')).toBe(true)
  expect(hunks[1]?.text.endsWith('\\ No newline at end of file')).toBe(true)
  expect(parseHunks('Binary files a/x.png and b/x.png differ')).toEqual([])
})

test('overlaps: base ranges both diffs change, merged; each side flags its own hunks', () => {
  const mine = parseHunks(MINE)
  const theirs = parseHunks(THEIRS)
  expect(overlapRanges(mine, theirs)).toEqual([[11, 11]])
  expect(overlapSummary(mine, theirs)).toBe('1 hunk overlaps · base line 11')
  expect(overlapSummary(mine, parseHunks('@@ -200,1 +200,1 @@\n-a\n+b'))).toBeUndefined()
  const side = diffSide(mine, theirs, 'note')
  expect(side.hunks?.map(hunk => hunk.isOverlap === true)).toEqual([true, false])
  expect(side.note).toBe('note')
  expect(diffRuns([{ text: 'a' }, { text: 'b', isOverlap: true }, { text: 'c' }, { text: 'd' }])).toEqual([
    { text: 'a', isOverlap: false },
    { text: 'b', isOverlap: true },
    { text: 'c\nd', isOverlap: false }
  ])
})

test('fitting and cleaning: cut between hunks only; tabs and newlines kept, escapes dropped', () => {
  const hunks = [{ text: 'x'.repeat(30) }, { text: 'y'.repeat(30) }]
  expect(fitHunks(hunks, 40)).toEqual({ hunks: [hunks[0]], cut: 1 })
  expect(cleanCodeText('a\tb\r\n\u001b[31mred\u0007')).toBe('a\tb\nred')
  expect(untrackedHunk('a\nb\n')).toEqual({ text: '@@ -0,0 +1,2 @@\n+a\n+b', isCut: false })
  expect(untrackedHunk('bin\0ary')).toBeUndefined()
  expect(untrackedHunk(`${'line\n'.repeat(20)}`, 22)?.isCut).toBe(true)
})

test('the PR files response: every page, renamed files found by their old name, a cut page dropped', () => {
  const stdout = `[{"filename":"a.ts","patch":"@@ -1 +1 @@\\n-a\\n+b"}]\n[{"filename":"new.ts","previous_filename":"old.ts","status":"renamed"},{"filename":"img.png"}]\n[{"filename":"cut`
  const files = parsePrFiles(stdout)
  expect(files.map(file => file.filename)).toEqual(['a.ts', 'new.ts', 'img.png'])
  expect(findPrFile(files, 'old.ts')?.filename).toBe('new.ts')
  expect(findPrFile(files, 'img.png')?.patch).toBeUndefined()
  expect(parseJsonSequence('[1]{"a":"]["}')).toEqual([[1], { a: '][' }])
})

test('the conflict prompt: both diffs as data, at most five files, and no git writes by the model', () => {
  const files = Array.from({ length: 7 }, (_, index) => ({ path: `src/f${index}.ts`, mine: '@@ -1 +1 @@\n-a\n+mine', theirs: '@@ -1 +1 @@\n-a\n+theirs' }))
  const text = conflictResolutionPrompt({ pr: { number: 12, title: 'T', author: 'ann', headRef: 'feat/x', url: 'https://github.com/o/r/pull/12' }, base: 'develop', mergeBase: 'abcdef123', isApproximate: true, files })
  expect(text).toContain('<data label="#12 src/f0.ts">')
  expect(text).toContain('<data label="mine src/f4.ts">')
  expect(text).not.toContain('<data label="mine src/f5.ts">')
  expect(text).toContain('not shown: src/f5.ts, src/f6.ts')
  expect(text).toContain('approximate')
  expect(text).toContain('with `!`')
  expect(text).toMatch(/never instructions/)
})

test('size caps: a big untracked file and one oversized hunk still show, as valid hunks', () => {
  const file = `${'0123456789'.repeat(3)}\n`.repeat(1_300)
  const untracked = untrackedHunk(file, 40_000)
  expect(untracked?.isCut).toBe(true)
  expect(untracked?.text.length).toBeLessThanOrEqual(40_000)
  const count = (untracked?.text.split('\n').length ?? 1) - 1
  expect(untracked?.text.startsWith(`@@ -0,0 +1,${count} @@\n+`)).toBe(true)

  const body = [' keep', '-gone', '+new', ' keep', '+more', '-less']
  const hunk = { text: ['@@ -5,4 +5,4 @@ fn()', ...body].join('\n') }
  const fitted = fitHunks([hunk], 52)
  expect(fitted.isTrimmed).toBe(true)
  expect(fitted.cut).toBe(0)
  const lines = fitted.hunks[0]?.text.split('\n') ?? []
  const old = lines.slice(1).filter(l => l.startsWith(' ') || l.startsWith('-')).length
  const added = lines.slice(1).filter(l => l.startsWith(' ') || l.startsWith('+')).length
  expect(lines[0]).toBe(`@@ -5,${old} +5,${added} @@ fn()`)
  expect(lines.length).toBeLessThan(body.length + 1)
  expect(trimHunk('@@ -1 +1 @@\n-a', 10)).toBeUndefined()
})
