import { expect, test } from 'claude-code/testing'

import { ENV_TOKEN_NAMES } from '../hooks/panels/gitgud/credentials'
import type { Op, Req } from '../hooks/panels/gitgud/providers/types'
import { FORK_DIFF_TEXT, isNoToken, runOpTracked, runReqWith, type RunnerIo } from '../hooks/panels/gitgud/runner'
import { bitbucketNoTokenMessage, parseHostSettings, emailQuestion, envNameFromAnswer, envQuestion } from '../hooks/panels/gitgud/setup'

const HOST = { provider: 'bitbucket', email: 'ada@acme.com', tokenFrom: { kind: 'env', name: 'BITBUCKET_TOKEN' }, decidedBy: 'person', at: 1 } as const

function ioWith(parts: Partial<RunnerIo> = {}, fetched: string[] = []): RunnerIo {
  return {
    cli: async () => ({ exitCode: 0, stdout: 'cut', stderr: '', isStdoutTruncated: true }),
    git: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    keychain: async () => undefined,
    env: async name => (name === 'BITBUCKET_TOKEN' ? 'tok-123' : undefined),
    fetch: async url => {
      fetched.push(url)

      return { status: 200, ok: true, headers: {}, text: '{}' }
    },
    hosts: async () => ({ 'bitbucket.org': HOST }),
    ...parts
  }
}

test('a command whose stdout was cut reaches the adapter as isTruncated, and the stepped op reports it', async () => {
  function* op(): Op<string> {
    const out = yield { kind: 'cli', tool: 'gh', argv: ['gh', 'api', 'repos/o/r/pulls/1/files'], env: {} } satisfies Req

    return { isOk: true, value: !Array.isArray(out) && out.isTruncated === true ? 'cut' : 'whole' }
  }
  const stepped = await runOpTracked(ioWith(), op())

  expect(stepped.parsed).toEqual({ isOk: true, value: 'cut' })
  expect(stepped.isTruncated).toBe(true)
})

test('a request with no token reads as no token, not a refused one; the token goes to the API host only', async () => {
  const fetched: string[] = []
  const get = (url: string): Req => ({ kind: 'http', method: 'GET', url, needsToken: true })
  const none = await runReqWith(ioWith({ env: async () => undefined }, fetched), get('https://api.bitbucket.org/2.0/user'))
  expect(isNoToken(none)).toBe(true)
  expect(fetched).toEqual([])

  const sent = await runReqWith(ioWith({}, fetched), get('https://api.bitbucket.org/2.0/user'))
  expect(sent.status).toBe(200)
  expect(await runReqWith(ioWith({}, fetched), get('https://evil.example/2.0/user'))).toMatchObject({ exitCode: -1 })
  expect(fetched).toEqual(['https://api.bitbucket.org/2.0/user'])
})

test("a PR-level diff, which Bitbucket answers with a redirect the engine hides, is never sent with the token", async () => {
  const fetched: string[] = []
  const diff: Req = { kind: 'http', method: 'GET', url: 'https://api.bitbucket.org/2.0/repositories/ws/web/pullrequests/7/diff', needsToken: true }
  const out = await runReqWith(ioWith({}, fetched), diff)

  expect(out.stderr).toBe(FORK_DIFF_TEXT)
  expect(fetched).toEqual([])
})

test('the setup questions never pad: an email has two options at least, the variable is one of the three readable names', () => {
  expect(emailQuestion().options.length).toBeGreaterThanOrEqual(2)
  expect(emailQuestion('ada@acme.com').options[0]).toBe('ada@acme.com')
  expect(envQuestion(ENV_TOKEN_NAMES).options).toEqual([...ENV_TOKEN_NAMES, 'Cancel'])
  expect(envNameFromAnswer('MY_TOKEN', ENV_TOKEN_NAMES)).toBeUndefined()
  expect(envNameFromAnswer('ATLASSIAN_API_TOKEN', ENV_TOKEN_NAMES)).toBe('ATLASSIAN_API_TOKEN')
  expect(bitbucketNoTokenMessage({ kind: 'env', name: 'BITBUCKET_TOKEN' })).toBe('No token in $BITBUCKET_TOKEN')
  expect(bitbucketNoTokenMessage({ kind: 'keychain', service: 'gitgud-bitbucket', account: 'a@b.c' })).toBe('No token found in the keychain (service gitgud-bitbucket, account a@b.c)')
})

test('saved hosts parse by lowercase host from the raw store value, dropping what is unusable and never holding a token', () => {
  const raw = { hosts: { 'Bitbucket.org': { provider: 'bitbucket', email: 'a@b.c', tokenFrom: { kind: 'env', name: 'BITBUCKET_TOKEN', token: 'x' }, decidedBy: 'person', at: 2 }, 'bad.host': { provider: 'svn' } } }
  const hosts = parseHostSettings(raw)

  expect(Object.keys(hosts ?? {})).toEqual(['bitbucket.org'])
  expect(hosts?.['bitbucket.org']?.tokenFrom).toEqual({ kind: 'env', name: 'BITBUCKET_TOKEN' })
  expect(parseHostSettings({ hosts: {} })).toBeUndefined()
  expect(parseHostSettings(undefined)).toBeUndefined()
})
