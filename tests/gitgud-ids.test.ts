import { expect, test } from 'claude-code/testing'

import {
  canonicalItemId,
  canonicalRepoKey,
  decodeItemId,
  decodeRepoName,
  encodeItemId,
  encodeRepoName,
  isSessionRepo,
  itemId,
  parseItemId,
  parseRepoKey,
  repoFolderOf
} from '../hooks/panels/gitgud/ids'
import { adapterOf } from '../hooks/panels/gitgud/providers'
import type { Outcome } from '../hooks/panels/gitgud/providers/types'

test('item ids round-trip through a Button key, with nested groups, and malformed input reads as none', () => {
  for (const id of ['github.com/o/r#1', 'gitlab.com/g/sub/proj#12', 'bitbucket.org/ws/repo#3', 'ghe.corp.io/o/my.repo_x#7']) {
    expect(decodeItemId(encodeItemId(id))).toBe(id)
  }
  expect(encodeItemId('gitlab.com/g/sub/proj#12')).toBe('gitlab.com~g~sub~proj~12')
  expect(['', 'a~1', 'a~b~x', '~b~1', 'a~b~%E0', 'a~~1'].map(decodeItemId)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined])
  expect(['a', 'a/b', 'a/b#', 'a/b#x', '/a/b#1', 'a//b#1'].map(parseItemId)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined])
  expect(decodeRepoName(encodeRepoName('gitlab.com/g/sub'))).toBe('gitlab.com/g/sub')
})

test('the old owner/name shape reads as github.com, in ids, keys and the session check', () => {
  expect(parseItemId('acme/web#12')).toEqual({ host: 'github.com', path: 'acme/web', repo: 'github.com/acme/web', number: 12 })
  expect(parseItemId('GitLab.com/g/sub/proj#2')).toMatchObject({ host: 'gitlab.com', path: 'g/sub/proj', number: 2 })
  expect(canonicalItemId('acme/web#12')).toBe('github.com/acme/web#12')
  expect(canonicalItemId('github.com/acme/web#12')).toBe('github.com/acme/web#12')
  expect(canonicalRepoKey('acme/web')).toBe('github.com/acme/web')
  expect(parseRepoKey('acme')).toBeUndefined()
  expect(decodeItemId('acme~web~12')).toBe('github.com/acme/web#12')
  expect(itemId('github.com/acme/web', 12)).toBe('github.com/acme/web#12')
  expect(isSessionRepo('github.com/Acme/Web', 'acme/web')).toBe(true)
  expect(isSessionRepo('gitlab.com/acme/web', 'acme/web')).toBe(false)
})

test('repoFolderOf names a folder per host and flattens the path', () => {
  expect(repoFolderOf('gitlab.com/g/sub/proj')).toBe('gitlab.com/g__sub__proj')
  expect(repoFolderOf('acme/web')).toBe('github.com/acme__web')
})

test('the GitHub adapter: github.com keeps gh as it was, an Enterprise host adds -R host/path and GH_HOST', () => {
  const github = adapterOf('github')
  if (github === undefined) throw new Error('no github adapter')
  const run = (repo: string, outcome: Outcome) => {
    const op = github.checks({ id: '', kind: 'pr', repo, number: 4, title: '', url: '', author: '', updatedAt: '', comments: 0 })
    const req = [op.next().value].flat()[0]

    return { req, done: op.next(outcome) }
  }
  const json = JSON.stringify([{ name: 'build', state: 'FAILURE', bucket: 'fail', link: 'https://github.com/o/r/actions/runs/5/job/6' }])
  const dotCom = run('github.com/o/r', { exitCode: 1, stdout: json, stderr: '' })
  const ghes = run('ghe.corp.io/o/r', { exitCode: 1, stdout: '', stderr: 'no checks reported' })

  expect(dotCom.req).toMatchObject({ kind: 'cli', tool: 'gh', argv: expect.arrayContaining(['--repo', 'o/r']) })
  expect(dotCom.done.value).toMatchObject({ isOk: true, value: [{ name: 'build', state: 'fail', runId: 5, jobId: 6 }] })
  expect(ghes.req).toMatchObject({ argv: expect.arrayContaining(['--repo', 'ghe.corp.io/o/r']), env: { GH_HOST: 'ghe.corp.io' } })
  expect(ghes.done.value).toEqual({ isOk: false, error: 'no checks reported' })
})
