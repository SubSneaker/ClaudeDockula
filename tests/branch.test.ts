import { describe, expect, test } from 'claude-code/testing'

import { summarizeBranch } from '../hooks/panels/branch'
import { describeCounts, describeUpstream } from '../hooks/panels/branch/format'
import { describeGitFailure, parseGitStatus, unquoteGitPath } from '../hooks/panels/branch/parse'

const ON_A_TICKET_BRANCH = [
  '# branch.oid a1b2c3d4e5f0c3f9e1b2',
  '# branch.head ABC-101/add-export-button',
  '# branch.upstream origin/ABC-101/add-export-button',
  '# branch.ab +2 -1',
  '1 MM N... 100644 100644 100644 a1b2c3d e4f5a6b src/with space.ts',
  '1 .M N... 100644 100644 100644 a1b2c3d a1b2c3d src/b.ts',
  '2 R. N... 100644 100644 100644 a1b2c3d a1b2c3d R100 src/new.ts\tsrc/old.ts',
  'u UU N... 100644 100644 100644 100644 a1b2c3d e4f5a6b c7d8e9f src/conflict.ts',
  '? notes.md',
  '! ignored.log',
  ''
].join('\n')

describe('parseGitStatus', () => {
  test('reads the branch, its upstream and every changed path', () => {
    expect(parseGitStatus(ON_A_TICKET_BRANCH)).toEqual({
      branch: 'ABC-101/add-export-button',
      commit: 'a1b2c3d',
      ticket: 'ABC-101',
      upstream: 'origin/ABC-101/add-export-button',
      ahead: 2,
      behind: 1,
      staged: 2,
      modified: 2,
      untracked: 1,
      conflicted: 1,
      fileCount: 5,
      files: [
        { code: 'MM', path: 'src/with space.ts' },
        { code: ' M', path: 'src/b.ts' },
        { code: 'R ', path: 'src/new.ts' },
        { code: 'UU', path: 'src/conflict.ts' },
        { code: '??', path: 'notes.md' }
      ]
    })
  })

  test('a detached HEAD before any upstream has no branch, ticket or sync', () => {
    const status = parseGitStatus('# branch.oid (initial)\n# branch.head (detached)\n')

    expect(status).toEqual({ staged: 0, modified: 0, untracked: 0, conflicted: 0, files: [], fileCount: 0 })
    expect(describeUpstream(status)).toBe('No upstream branch')
    expect(describeCounts(status)).toBe('Working tree clean')
  })
})

test('unquoteGitPath decodes octal UTF-8 bytes and escapes', () => {
  expect(unquoteGitPath('"docs/\\346\\227\\245 \\"a\\".md"')).toBe('docs/日 "a".md')
  expect(unquoteGitPath('plain/path.ts')).toBe('plain/path.ts')
})

test('formatters', () => {
  const status = parseGitStatus(ON_A_TICKET_BRANCH)

  expect(describeCounts(status)).toBe('1 conflicted · 2 staged · 2 modified · 1 untracked')
  expect(describeGitFailure('fatal: not a git repository (or any of the parent directories): .git\n')).toBe(
    'Not a git repository.'
  )
})

test('the band summary: ticket key, else the short branch name, and the changed count', () => {
  const status = parseGitStatus(ON_A_TICKET_BRANCH)
  const clean = { ...status, ticket: undefined, branch: 'feature/a-very-long-branch-name', files: [], fileCount: 0 }

  expect(summarizeBranch({ status })).toBe('ABC-101 ·5')
  expect(summarizeBranch({ status: clean })).toBe('a-very-long-bra…')
  expect(summarizeBranch({})).toBe('…')
  expect(summarizeBranch({ error: 'Not a git repository.' })).toBe('–')
  expect(describeUpstream(status)).toBe('↑2 ahead · ↓1 behind origin')
  expect(describeUpstream({ ...status, behind: 0 })).toBe('↑2 ahead of origin')
})
