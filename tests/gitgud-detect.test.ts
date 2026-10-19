import { expect, test } from 'claude-code/testing'

import {
  cliStateOf,
  detectVerdict,
  gitGetUrl,
  interpretProbes,
  parseRemote,
  parseRemoteEntries,
  pickRemote,
  upstreamRemoteOf
} from '../hooks/panels/gitgud/detect'
import { bitbucketCheckMessage, parseServiceAnswer, serviceQuestion, setupCardOf } from '../hooks/panels/gitgud/setup'

const parsed = (url: string) => {
  const remote = parseRemote(url)

  return remote === undefined ? undefined : { host: remote.hostKey, path: remote.path, scheme: remote.scheme }
}

test('remote URLs parse to host, path and scheme', () => {
  expect(parsed('https://github.com/acme/web.git')).toEqual({ host: 'github.com', path: 'acme/web', scheme: 'https' })
  expect(parsed('https://user@github.com/acme/web/')).toEqual({ host: 'github.com', path: 'acme/web', scheme: 'https' })
  expect(parsed('git@github.com:acme/web.git')).toEqual({ host: 'github.com', path: 'acme/web', scheme: 'ssh' })
  expect(parsed('ssh://git@gitlab.example.com:2222/g/sub/proj.git')).toEqual({ host: 'gitlab.example.com', path: 'g/sub/proj', scheme: 'ssh' })
  expect(parsed('https://git.acme.dev:8443/g/sub/deep/proj.git')).toEqual({ host: 'git.acme.dev:8443', path: 'g/sub/deep/proj', scheme: 'https' })
  expect(parsed('git://github.com/acme/web.git')).toEqual({ host: 'github.com', path: 'acme/web', scheme: 'git' })
  expect(parsed('https://Bitbucket.org/ws/repo.git')).toEqual({ host: 'bitbucket.org', path: 'ws/repo', scheme: 'https' })
})

test('SSH aliases resolve to the web host', () => {
  expect(parsed('ssh://git@ssh.github.com:443/acme/web.git')?.host).toBe('github.com')
  expect(parsed('git@altssh.gitlab.com:g/p.git')?.host).toBe('gitlab.com')
  expect(parsed('ssh://git@altssh.bitbucket.org:443/ws/repo.git')?.host).toBe('bitbucket.org')
})

test('local paths and empty text are not remotes', () => {
  expect(parseRemote('/Users/me/repo')).toBeUndefined()
  expect(parseRemote('../sibling')).toBeUndefined()
  expect(parseRemote('file:///srv/repo.git')).toBeUndefined()
  expect(parseRemote('')).toBeUndefined()
  expect(parseRemote('https://github.com')).toBeUndefined()
})

test('git config output becomes remote entries and the preferred remote', () => {
  const output = 'remote.upstream.url\nhttps://github.com/up/web.git\0remote.origin.url\ngit@github.com:me/web.git\0'
  const remotes = parseRemoteEntries(output)

  expect(remotes).toEqual([
    { name: 'upstream', url: 'https://github.com/up/web.git' },
    { name: 'origin', url: 'git@github.com:me/web.git' }
  ])
  expect(pickRemote(remotes)?.name).toBe('origin')
  expect(pickRemote(remotes, 'upstream')?.name).toBe('upstream')
  expect(pickRemote(remotes.slice(0, 1))?.name).toBe('upstream')
  expect(upstreamRemoteOf('upstream/main\n', remotes)).toBe('upstream')
  expect(gitGetUrl('origin')).toEqual(['git', '--no-optional-locks', 'ls-remote', '--get-url', 'origin'])
})

test('the verdict table', () => {
  const verdict = (url: string | undefined, evidence = {}) => detectVerdict(url === undefined ? undefined : parseRemote(url), url, evidence)

  expect(verdict(undefined)).toEqual({ kind: 'no-remote' })
  expect(verdict('https://github.com/a/b.git')).toEqual({ kind: 'ready', host: 'github.com', provider: 'github' })
  expect(verdict('https://gitlab.com/a/b.git', { health: 'signed-out' })).toEqual({ kind: 'needs-setup', host: 'gitlab.com', provider: 'gitlab', why: 'signed-out' })
  expect(verdict('https://gitlab.com/a/b.git', { health: 'cli-missing' })).toMatchObject({ kind: 'needs-setup', why: 'cli-missing' })
  expect(verdict('https://bitbucket.org/ws/r.git', { health: 'none' })).toMatchObject({ kind: 'needs-setup', provider: 'bitbucket', why: 'no-token' })
  expect(verdict('https://bitbucket.org/ws/r.git', { health: 'refused' })).toMatchObject({ why: 'token-refused' })
  expect(verdict('git@work:acme/web.git')).toEqual({ kind: 'unknown-host', host: 'work', remote: 'git@work:acme/web.git' })
  expect(verdict('https://git.acme.dev/g/p.git', { saved: 'gitlab' })).toEqual({ kind: 'ready', host: 'git.acme.dev', provider: 'gitlab' })
  expect(verdict('https://git.acme.dev/g/p.git', { cli: { gh: 'signed-in' } })).toMatchObject({ kind: 'ready', provider: 'github' })
  expect(verdict('https://git.acme.dev/g/p.git', { cli: { gh: 'signed-out', glab: 'cli-missing' } })).toMatchObject({ kind: 'unknown-host' })
  expect(verdict('https://git.acme.dev/g/p.git', { probe: { provider: 'gitlab' } })).toMatchObject({ kind: 'unknown-host', guess: 'gitlab' })
  expect(verdict('https://dev.azure.com/org/proj/_git/r')).toEqual({ kind: 'unsupported', host: 'dev.azure.com', provider: 'azure' })
  expect(verdict('ssh://git@bitbucket.acme.dev:7999/scm/proj/repo.git')).toMatchObject({ kind: 'unsupported', provider: 'bitbucket-dc' })
  expect(verdict('https://git.acme.dev/g/p.git', { probe: { unsupported: 'gitea' } })).toMatchObject({ kind: 'unsupported', provider: 'gitea' })
})

test('CLI status maps to a state', () => {
  expect(cliStateOf({ exitCode: 0 })).toBe('signed-in')
  expect(cliStateOf({ exitCode: 1, stderr: 'You are not logged into any GitLab hosts.' })).toBe('signed-out')
  expect(cliStateOf({ exitCode: 127, stderr: 'glab: command not found' })).toBe('cli-missing')
})

test('probes preselect a service and never invent one', () => {
  const meta = { path: '/api/v3/meta', status: 200, body: '{"installed_version":"3.12.0"}' }
  const v4 = { path: '/api/v4/version', status: 401, body: '{"message":"401 Unauthorized"}' }
  const signIn = { path: '/users/sign_in', status: 200, body: '<title>Sign in · GitLab</title>' }

  expect(interpretProbes([meta])).toEqual({ provider: 'github' })
  expect(interpretProbes([v4, signIn])).toEqual({ provider: 'gitlab' })
  expect(interpretProbes([v4])).toEqual({})
  expect(interpretProbes([{ path: '/api/v3/meta', status: 200, body: '<html>proxy</html>' }])).toEqual({})
  expect(interpretProbes([{ path: '/rest/api/1.0/application-properties', status: 200, body: '{"displayName":"Bitbucket"}' }])).toEqual({ unsupported: 'bitbucket-dc' })
  expect(interpretProbes([{ path: '/api/v1/version', status: 200, body: '{"version":"1.22.0"}' }])).toEqual({ unsupported: 'gitea' })
})

test('the setup copy and answers', () => {
  expect(serviceQuestion('git.acme.dev', 'gitlab').options).toEqual(['GitLab (looks like it)', 'GitHub or GitHub Enterprise', 'Bitbucket Cloud', 'Not now'])
  expect(parseServiceAnswer('GitLab (looks like it)')).toEqual({ kind: 'provider', provider: 'gitlab' })
  expect(parseServiceAnswer('Bitbucket Server')).toMatchObject({ kind: 'unsupported', notice: "GitGud doesn't read Bitbucket Server yet." })
  expect(parseServiceAnswer('Not now')).toEqual({ kind: 'cancel' })
  expect(setupCardOf({ kind: 'unknown-host', host: 'git.acme.dev', remote: 'x' })?.text).toBe("Couldn't tell which service hosts git.acme.dev.")
  expect(setupCardOf({ kind: 'needs-setup', host: 'gitlab.com', provider: 'gitlab', why: 'cli-missing' }, { canInstallGlab: true })?.actions.map(action => action.id)).toEqual(['install', 'refresh'])
  expect(bitbucketCheckMessage(403).text).toContain('read:pullrequest')
})
