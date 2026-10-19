import { expect, test } from 'claude-code/testing'

import { GIT_REMOTE_URLS, GIT_UPSTREAM, PROBE_PATHS, gitGetUrl, probeUrl } from '../hooks/panels/gitgud/detect'
import { GIT_FILTER_DRIVERS, GIT_VERSION, gitArchive, gitHasCommit, removeReviewDir, tarExtract } from '../hooks/panels/gitgud/argv'
import { isAllowedArgv, isAllowedRequest } from '../hooks/panels/gitgud/guard'
import { SECRET_DENY_RULES } from '../hooks/panels/gitgud/review'

const API = 'api.bitbucket.org'
const HOSTS = { apiHosts: [API], probeHosts: ['git.acme.dev'] }
const enc = encodeURIComponent('g/sub/proj')

const glabApi = (path: string, ...rest: string[]) => ['glab', 'api', path, '--hostname', 'gitlab.com', ...rest]
const bb = (path: string, headers: Record<string, string> = { Authorization: 'Basic x' }) => ({ method: 'GET', url: `https://${API}${path}`, headers })

test('glab reads are allowed exactly as built', () => {
  expect(isAllowedArgv(['glab', 'auth', 'status', '--hostname', 'gitlab.example.com:8443'])).toBe(true)
  expect(isAllowedArgv(glabApi('user'))).toBe(true)
  expect(isAllowedArgv(glabApi(`projects/${enc}/merge_requests?state=opened&per_page=20`, '--paginate'))).toBe(true)
  expect(isAllowedArgv(glabApi(`projects/${enc}/merge_requests/12/discussions?per_page=100`))).toBe(true)
  expect(isAllowedArgv(['/opt/homebrew/bin/glab', 'api', 'user', '--hostname', 'gitlab.com'])).toBe(true)
})

test('glab writes and other commands are refused', () => {
  const merge = `projects/${enc}/merge_requests/12`
  expect(isAllowedArgv(['glab', 'api', '-X', 'POST', merge, '--hostname', 'gitlab.com'])).toBe(false)
  expect(isAllowedArgv(glabApi(merge, '--method', 'PUT'))).toBe(false)
  expect(isAllowedArgv(glabApi(merge, '-f', 'state_event=close'))).toBe(false)
  expect(isAllowedArgv(glabApi(merge, '-F', 'title=x'))).toBe(false)
  expect(isAllowedArgv(glabApi(merge, '-H', 'X: y'))).toBe(false)
  expect(isAllowedArgv(glabApi(merge, '--input', 'body.json'))).toBe(false)
  expect(isAllowedArgv(['glab', 'mr', 'merge', '12'])).toBe(false)
  expect(isAllowedArgv(['glab', 'auth', 'login', '--hostname', 'gitlab.com'])).toBe(false)
  expect(isAllowedArgv(['glab', 'auth', 'status', '--hostname', 'gitlab.com', '--show-token'])).toBe(false)
  expect(isAllowedArgv(['glab', 'auth', 'status', '--hostname', 'gitlab.com', '-t'])).toBe(false)
  expect(isAllowedArgv(['glab', 'config', 'set', 'x', 'y'])).toBe(false)
  expect(isAllowedArgv(glabApi('unknown/path'))).toBe(false)
  expect(isAllowedArgv(glabApi(`projects/${enc}/../../users`))).toBe(false)
  expect(isAllowedArgv(glabApi('projects/%2e%2e/merge_requests'))).toBe(false)
  expect(isAllowedArgv(['glab', 'api', 'user', '--hostname', 'evil host'])).toBe(false)
})

test('detection git is allowed, ls-remote only with --get-url', () => {
  expect(isAllowedArgv(GIT_REMOTE_URLS)).toBe(true)
  expect(isAllowedArgv(GIT_UPSTREAM)).toBe(true)
  expect(isAllowedArgv(gitGetUrl('origin'))).toBe(true)
  expect(isAllowedArgv(['git', '--no-optional-locks', 'ls-remote', 'origin'])).toBe(false)
  expect(isAllowedArgv(['git', '--no-optional-locks', 'ls-remote', '--heads', 'origin'])).toBe(false)
  expect(isAllowedArgv(['git', '--no-optional-locks', 'ls-remote', '--get-url', '--upload-pack=x'])).toBe(false)
  expect(isAllowedArgv(['git', '--no-optional-locks', 'config', 'user.name', 'x'])).toBe(false)
  expect(isAllowedArgv(['git', 'remote', 'add', 'x', 'y'])).toBe(false)
})

test('the existing gh reads stay allowed, with a GHES host on the REST read', () => {
  expect(isAllowedArgv(['gh', 'auth', 'status', '--hostname', 'ghe.acme.dev'])).toBe(true)
  expect(isAllowedArgv(['gh', 'api', 'repos/a/b/pulls/3/files?per_page=100', '--hostname', 'ghe.acme.dev', '--paginate'])).toBe(true)
  expect(isAllowedArgv(['gh', 'api', 'repos/a/b/pulls/3/files', '-X', 'POST'])).toBe(false)
  expect(isAllowedArgv(['gh', 'pr', 'merge', '3'])).toBe(false)
})

test('an Enterprise host adds exactly --hostname and --repo host/owner/name; anything looser is refused', () => {
  const query = 'query=query { viewer { login } }'
  expect(isAllowedArgv(['gh', 'api', 'graphql', '-f', query, '--hostname', 'ghe.acme.dev'])).toBe(true)
  expect(isAllowedArgv(['gh', 'pr', 'checks', '4', '--repo', 'ghe.acme.dev/o/r', '--json', 'name'])).toBe(true)
  expect(isAllowedArgv(['gh', 'pr', 'checks', '4', '--repo', 'o/r', '--json', 'name'])).toBe(true)
  expect(isAllowedArgv(['gh', 'api', 'graphql', '-f', query, '--hostname', 'evil host'])).toBe(false)
  expect(isAllowedArgv(['gh', 'api', 'graphql', '-f', query, '--hostname', 'a.dev', '--hostname', 'b.dev'])).toBe(false)
  expect(isAllowedArgv(['gh', 'pr', 'checks', '4', '--repo', 'https://x.dev/o/r', '--json', 'name'])).toBe(false)
  expect(isAllowedArgv(['gh', 'pr', 'diff', '4', '--repo', '../r'])).toBe(false)
  expect(isAllowedArgv(['gh', 'api', 'graphql', '-f', query, '--hostname', 'ghe.acme.dev', '--method', 'POST'])).toBe(false)
})

test('keychain lookups read, never write', () => {
  expect(isAllowedArgv(['security', 'find-generic-password', '-s', 'gitgud-bitbucket', '-a', 'ada@acme.com', '-w'])).toBe(true)
  expect(isAllowedArgv(['secret-tool', 'lookup', 'service', 'gitgud-bitbucket', 'account', 'ada@acme.com'])).toBe(true)
  expect(isAllowedArgv(['security', 'find-generic-password', '-s', 'other-service', '-a', 'ada@acme.com', '-w'])).toBe(false)
  expect(isAllowedArgv(['security', 'delete-generic-password', '-s', 'gitgud-bitbucket', '-a', 'ada@acme.com'])).toBe(false)
  expect(isAllowedArgv(['security', 'add-generic-password', '-a', 'ada@acme.com', '-s', 'gitgud-bitbucket', '-w', 'tok'])).toBe(false)
  expect(isAllowedArgv(['secret-tool', 'store', '--label=x', 'service', 'gitgud-bitbucket', 'account', 'ada@acme.com'])).toBe(false)
  expect(isAllowedArgv(['secret-tool', 'clear', 'service', 'gitgud-bitbucket', 'account', 'ada@acme.com'])).toBe(false)
  expect(isAllowedArgv(['security', 'find-generic-password', '-s', 'gitgud-bitbucket', '-a', '-w', '-w'])).toBe(false)
  expect(isAllowedArgv(['security', 'find-generic-password', '-s', 'gitgud-bitbucket', '-a', 'a b', '-w'])).toBe(false)
})

test('Bitbucket reads are allowed with the token on the API host only', () => {
  expect(isAllowedRequest(bb('/2.0/user'), HOSTS)).toBe(true)
  expect(isAllowedRequest(bb('/2.0/repositories/ws/repo/pullrequests?state=OPEN&pagelen=50'), HOSTS)).toBe(true)
  expect(isAllowedRequest(bb('/2.0/repositories/ws/repo/pullrequests/4/comments?pagelen=100'), HOSTS)).toBe(true)
  expect(isAllowedRequest(bb('/2.0/repositories/ws/repo/diffstat/abc1234..def5678?topic=true'), HOSTS)).toBe(true)
})

test('requests that write, wander or leak are refused', () => {
  expect(isAllowedRequest({ ...bb('/2.0/user'), method: 'POST' }, HOSTS)).toBe(false)
  expect(isAllowedRequest({ ...bb('/2.0/user'), method: 'DELETE' }, HOSTS)).toBe(false)
  expect(isAllowedRequest({ ...bb('/2.0/user'), body: '{}' }, HOSTS)).toBe(false)
  expect(isAllowedRequest({ method: 'GET', url: 'https://evil.example.com/2.0/user', headers: { Authorization: 'Basic x' } }, HOSTS)).toBe(false)
  expect(isAllowedRequest({ method: 'GET', url: `http://${API}/2.0/user` }, HOSTS)).toBe(false)
  expect(isAllowedRequest(bb('/2.0/repositories/ws/../other/repo'), HOSTS)).toBe(false)
  expect(isAllowedRequest(bb('/2.0/repositories/ws/%2e%2e/repo'), HOSTS)).toBe(false)
  expect(isAllowedRequest(bb('/2.0/snippets'), HOSTS)).toBe(false)
  expect(isAllowedRequest(bb('/2.0/user', { Authorization: 'Basic x', 'X-Other': '1' }), HOSTS)).toBe(false)
  expect(isAllowedRequest({ method: 'GET', url: probeUrl('git.acme.dev', '/api/v4/version'), headers: { Authorization: 'Basic x' } }, HOSTS)).toBe(false)
  expect(isAllowedRequest({ method: 'GET', url: probeUrl('git.acme.dev', '/api/v4/version'), needsToken: true }, HOSTS)).toBe(false)
})

test('probes go to the probed host with no headers and a listed path', () => {
  for (const path of PROBE_PATHS) expect(isAllowedRequest({ method: 'GET', url: probeUrl('git.acme.dev', path) }, HOSTS)).toBe(true)
  expect(isAllowedRequest({ method: 'GET', url: probeUrl('git.acme.dev', '/admin') }, HOSTS)).toBe(false)
  expect(isAllowedRequest({ method: 'GET', url: probeUrl('other.example.com', '/api/v4/version') }, HOSTS)).toBe(false)
})

test('gh auth status never prints the token', () => {
  expect(isAllowedArgv(['gh', 'auth', 'status', '--hostname', 'github.com'])).toBe(true)
  expect(isAllowedArgv(['gh', 'auth', 'status', '--show-token'])).toBe(false)
  expect(isAllowedArgv(['gh', 'auth', 'status', '-t'])).toBe(false)
  expect(isAllowedArgv(['gh', 'auth', 'status', '-at'])).toBe(false)
})

test('the review copy commands the guard allows are exactly the ones argv.ts and detect.ts build', () => {
  const options = { reviewRoot: '/tmp/gg' }
  const dir = '/tmp/gg/rev-1'
  const sha = 'c'.repeat(40)

  expect(isAllowedArgv(GIT_VERSION, options)).toBe(true)
  expect(isAllowedArgv(GIT_FILTER_DRIVERS, options)).toBe(true)
  expect(isAllowedArgv(GIT_REMOTE_URLS, options)).toBe(true)
  expect(isAllowedArgv(gitHasCommit(sha), options)).toBe(true)
  expect(isAllowedArgv(gitArchive(sha, `${dir}/pr.tar`, ['crypt', 'lfs']), options)).toBe(true)
  expect(isAllowedArgv(tarExtract(`${dir}/pr.tar`, dir), options)).toBe(true)
  expect(isAllowedArgv(removeReviewDir(dir), options)).toBe(true)
})

test('the reviewer is denied the glab token files as well as gh', () => {
  expect(SECRET_DENY_RULES).toContain('Read(~/.config/glab-cli/**)')
  expect(SECRET_DENY_RULES).toContain('Read(~/Library/Application Support/glab-cli/**)')
})
