import type { On, ProcessRunResult, RenderPropsOf } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import { PANELS } from '../hooks/panels'
import { basicAuthHeader } from '../hooks/panels/gitgud/credentials'

// One happy path per service, then the setup flow, with `process.run` and `http.fetch` stubbed: nothing here touches
// the network, a keychain or a model.

const NOW = Date.parse('2026-10-19T12:00:00Z')
const SLOW = { timeoutMs: 30_000 }
const LIST = { in: 'gitgud-list-main' }
const TOKEN = 's3cr3t-token-value'
const EMAIL = 'ada@acme.com'

interface World {
  remote: string
  /** `glab api` or `gh api graphql` answers, by the argv's text. */
  cli: (argv: readonly string[]) => ProcessRunResult | undefined
  http: (url: string) => { status: number; body: string } | undefined
  keychain?: string
  answers: Record<string, string>
  fetched: Array<{ url: string; headers: Record<string, string> }>
  argvs: string[][]
  stored: string[]
  asked: string[]
  /** Every request hangs, as a host that never answers. */
  isHung?: boolean
}

function ran(exitCode: number, stdout: string, stderr = ''): ProcessRunResult {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

function paneProps(): RenderPropsOf['Pane'] {
  return { title: 'Dock', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }
}

function bandProps(): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 7 }, view: {} }
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('\n')
  if (typeof node === 'object' && node !== null && 'children' in node) return textOf(node.children)

  return ''
}

function gitRun(world: World, argv: readonly string[]): ProcessRunResult {
  if (argv.includes('--get-regexp')) return ran(0, `remote.origin.url\n${world.remote}\0`)
  if (argv.includes('@{upstream}')) return ran(128, '', 'no upstream')
  if (argv.includes('--get-url')) return ran(0, `${world.remote}\n`)
  if (argv.includes('--show-toplevel')) return ran(0, '/repo\n')
  if (argv.includes('HEAD')) return ran(0, 'main\n')

  return ran(1, '', 'unexpected git')
}

/** Every command and request answered from the world; the seeded store records what the panel writes. */
function mockWorld(on: On, world: World, seed: Record<string, unknown> = {}): void {
  const seen = Object.fromEntries(PANELS.map(panel => [panel.id, panel.revision ?? 1]))
  for (const key of ['gitgud:settings', 'gitgud:docs', 'gitgud:alerted', 'gitgud:alerted:overlap', 'gitgud:oneliners', 'gitgud:ciwhy']) {
    on('store.set', { key }, ($, e, next) => {
      world.stored.push(JSON.stringify([e.key, e.value]))

      return next(e)
    })
  }
  mock.store(on, { 'panels:seen': seen, 'gitgud:settings': { isHaikuOn: false }, ...seed })
  on('process.run', ($, e) => {
    world.argvs.push([...e.argv])
    const [command = ''] = e.argv
    if (command === 'git') return { value: gitRun(world, e.argv) }
    if (command === 'security') return { value: world.keychain === undefined ? ran(44, '', 'not found') : ran(0, `${world.keychain}\n`) }

    return { value: world.cli(e.argv) ?? ran(1, '', 'unexpected command') }
  })
  on('http.fetch', async ($, e) => {
    world.fetched.push({ url: e.url, headers: { ...e.init?.headers } })
    if (world.isHung === true) await new Promise<never>(() => undefined)
    const answer = world.http(e.url) ?? { status: 404, body: '' }

    return { value: { status: answer.status, ok: answer.status < 300, headers: {}, text: answer.body } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.tool === 'AskUserQuestion' ? (e.questions[0]?.question ?? '') : ''
    world.asked.push(question)
    const key = Object.keys(world.answers).find(part => question.includes(part))

    return { result: { questions: [], answers: { [question]: key === undefined ? 'Cancel' : (world.answers[key] ?? 'Cancel') } } }
  })
  on('command.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
}

function worldOf(remote: string, parts: Partial<World> = {}): World {
  return { remote, cli: () => undefined, http: () => undefined, answers: {}, fetched: [], argvs: [], stored: [], asked: [], ...parts }
}

async function tickIn(pane: { press: (args: { key: string }) => Promise<unknown> }): Promise<void> {
  for (const key of ['dock-main-manage', 'dock-main-enable-1-gitgud', 'dock-main-manage']) await pane.press({ key })
}

async function open($: Engine, on: On, world: World, seed: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: NOW })
  mockWorld(on, world, seed)
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps() })
  await tickIn(pane)
  await clock.settle()

  return { pane, clock }
}

const MR = {
  iid: 12, title: 'ABC-7 Fix login', web_url: 'https://gitlab.com/g/sub/proj/-/merge_requests/12', updated_at: '2026-10-19T10:00:00Z',
  author: { username: 'bob' }, user_notes_count: 3, labels: [], draft: false, source_branch: 'fix-login', target_branch: 'main',
  sha: 'a'.repeat(40), references: { full: 'g/sub/proj!12' }, description: 'Fixes the login', detailed_merge_status: 'not_approved'
}
const PROJECT = '{"path_with_namespace":"g/sub/proj","web_url":"https://gitlab.com/g/sub/proj","default_branch":"main"}'

function gitlabCli(argv: readonly string[]): ProcessRunResult | undefined {
  const [command, group, path = ''] = argv
  if (command !== 'glab') return undefined
  if (group === 'auth') return ran(0, '', 'Logged in to gitlab.com as ann')
  if (path === 'user') return ran(0, '{"username":"ann","id":1}')
  if (path === 'projects/g%2Fsub%2Fproj') return ran(0, PROJECT)
  if (path.includes('/merge_requests?') && path.includes('reviewer_username')) return ran(0, JSON.stringify([MR]))
  if (path.endsWith('/merge_requests/12')) return ran(0, JSON.stringify({ iid: 12, head_pipeline: { id: 9, status: 'failed' }, detailed_merge_status: 'not_approved', diff_refs: { base_sha: 'b', head_sha: 'a' } }))
  if (path.endsWith('/approvals')) return ran(0, '{"approved":false,"approved_by":[]}')

  return ran(0, '[]')
}

test('GitLab: the remote names the service, glab reads the lists, a merge request reads !12', SLOW, async ($, on) => {
  const world = worldOf('git@gitlab.com:g/sub/proj.git', { cli: gitlabCli })
  const { pane } = await open($, on, world)
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps() })

  expect(textOf(await pane.drawn(LIST))).toContain('!12')
  expect((await band.find({ key: 'dock-tab-gitgud' }))?.text).toBe('🐙 1 to review')
  expect(await pane.find({ key: 'gitgud-view-issues' })).toBeDefined()
  expect(world.argvs.filter(argv => argv[0] === 'glab').every(argv => argv[1] === 'auth' || (argv[1] === 'api' && argv.includes('--hostname')))).toBe(true)
  await band.unmount()
  await pane.unmount()
})

const GHES_NODE = {
  number: 5, title: 'Fix it', url: 'https://ghe.corp.io/o/r/pull/5', updatedAt: '2026-10-19T09:00:00Z', isDraft: false, reviewDecision: null, headRefName: 'fix', baseRefName: 'main',
  headRefOid: 'c'.repeat(40), bodyText: '', author: { login: 'bob' }, repository: { nameWithOwner: 'o/r' }, comments: { totalCount: 0 }, labels: { nodes: [] },
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'octocat' } }] }, commits: { nodes: [] }
}

test('GitHub Enterprise: an unknown host a signed-in gh knows is GitHub; the calls name the host', SLOW, async ($, on) => {
  const lists = JSON.stringify({ data: { viewer: { login: 'octocat' }, rateLimit: { cost: 1, remaining: 4000, resetAt: '2026-10-19T13:00:00Z' }, review: { issueCount: 1, nodes: [GHES_NODE] }, mine: { nodes: [] }, issues: { nodes: [] } } })
  const world = worldOf('git@ghe.corp.io:o/r.git', {
    cli: argv => {
      if (argv[0] !== 'gh') return undefined
      if (argv[1] === 'auth') return ran(0, '', 'Logged in to ghe.corp.io account octocat')
      if (argv[1] === 'repo') return ran(0, '{"nameWithOwner":"o/r","url":"https://ghe.corp.io/o/r","defaultBranchRef":{"name":"main"}}')

      return ran(0, lists)
    }
  })
  const { pane } = await open($, on, world)
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps() })

  expect(textOf(await pane.drawn(LIST))).toContain('#5')
  expect((await band.find({ key: 'dock-tab-gitgud' }))?.text).toBe('🐙 1 to review')
  expect(world.argvs.some(argv => argv[0] === 'gh' && argv[1] === 'api' && argv.includes('--hostname') && argv.includes('ghe.corp.io'))).toBe(true)
  expect(world.stored.some(line => line.includes('"ghe.corp.io"') && line.includes('"provider":"github"'))).toBe(true)
  await band.unmount()
  await pane.unmount()
})

const BB_PR = {
  id: 7, title: 'ABC-12 add export', summary: { raw: 'Adds the export.' }, draft: false, comment_count: 2, updated_on: '2026-10-19T10:00:00Z',
  author: { uuid: '{bob}', display_name: 'Bob B', nickname: 'bob' }, links: { html: { href: 'https://bitbucket.org/ws/web/pull-requests/7' } },
  source: { branch: { name: 'feat/export' }, commit: { hash: 'a1b2c3d4e5f6' }, repository: { full_name: 'ws/web' } },
  destination: { branch: { name: 'main' }, commit: { hash: '0f9e8d7c6b5a' }, repository: { full_name: 'ws/web' } },
  participants: [{ role: 'REVIEWER', approved: false, state: null, user: { uuid: '{me}', nickname: 'me' } }]
}
const BB_HOST = { provider: 'bitbucket', email: EMAIL, tokenFrom: { kind: 'keychain', service: 'gitgud-bitbucket', account: EMAIL }, decidedBy: 'person', at: 1 }

function bitbucketHttp(url: string): { status: number; body: string } | undefined {
  if (!url.startsWith('https://api.bitbucket.org/2.0/')) return undefined
  const path = url.slice('https://api.bitbucket.org/2.0'.length)
  const body = (value: unknown) => ({ status: 200, body: JSON.stringify(value) })
  if (path === '/user') return body({ uuid: '{me}', nickname: 'me', display_name: 'Ada' })
  if (path.startsWith('/user/workspaces')) return body({ values: [{ workspace: { slug: 'ws' } }] })
  if (path.startsWith('/repositories/ws/web/pullrequests?')) return body({ values: [BB_PR] })
  if (path.startsWith('/repositories/ws/web/pullrequests/7')) return body(path.includes('/statuses') ? { values: [] } : BB_PR)
  if (path.startsWith('/repositories/ws/web')) return body({ full_name: 'ws/web', links: { html: { href: 'https://bitbucket.org/ws/web' } }, mainbranch: { name: 'main' } })

  return body({ values: [] })
}

test('Bitbucket: the token header goes to the API host only, To review reads followed repos, and no token is kept', SLOW, async ($, on) => {
  const world = worldOf('git@bitbucket.org:ws/web.git', { http: bitbucketHttp, keychain: TOKEN })
  const { pane } = await open($, on, world, { 'gitgud:settings': { isHaikuOn: false, hosts: { 'bitbucket.org': BB_HOST } } })
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps() })
  const shown = `${textOf(await pane.drawn(LIST))}\n${textOf(await pane.find({ type: 'Text' }))}\n${textOf(await band.findAll({ type: 'Text' }))}`

  expect(shown).toContain('#7')
  expect((await band.find({ key: 'dock-tab-gitgud' }))?.text).toBe('🐙 1 to review')
  expect(await pane.find({ key: 'gitgud-view-issues' })).toBeUndefined()
  const api = world.fetched.filter(call => call.url.startsWith('https://api.bitbucket.org/'))
  expect(api.length).toBeGreaterThan(2)
  expect(api.every(call => call.headers.authorization === basicAuthHeader(EMAIL, TOKEN))).toBe(true)
  expect(world.fetched.every(call => call.url.startsWith('https://api.bitbucket.org/2.0/'))).toBe(true)
  expect(world.fetched.some(call => call.url.includes('/repositories/ws/web/pullrequests?'))).toBe(true)
  expect(world.stored.join('\n')).not.toContain(TOKEN)
  expect(shown).not.toContain(TOKEN)
  expect(world.argvs.filter(argv => argv[0] === 'security')).toEqual([['security', 'find-generic-password', '-s', 'gitgud-bitbucket', '-a', EMAIL, '-w']])
  await band.unmount()
  await pane.unmount()
})

test('an unknown host asks which service; picking Bitbucket saves the host once the token checks, never the token', SLOW, async ($, on) => {
  const world = worldOf('git@git.acme.dev:team/app.git', {
    cli: argv => (argv[1] === 'auth' ? ran(1, '', 'You are not logged in') : undefined),
    http: bitbucketHttp,
    answers: {
      'Which service hosts git.acme.dev': 'Bitbucket Cloud',
      'web address': 'https://git.acme.dev',
      'Where should GitGud read': 'Keychain (recommended)',
      'Which email': EMAIL
    }
  })
  const { pane, clock } = await open($, on, world)

  expect(await pane.find({ type: 'Text', text: /Couldn't tell which service hosts git\.acme\.dev/ })).toBeDefined()
  expect(world.fetched.every(call => call.headers.authorization === undefined)).toBe(true)
  await pane.press({ key: 'gitgud-setup-pick' })
  await clock.settle()
  expect(await pane.find({ type: 'Text', text: /security add-generic-password -a ada@acme\.com -s gitgud-bitbucket -w/ })).toBeDefined()
  expect(world.stored.some(line => line.includes('"hosts"'))).toBe(false)

  world.keychain = TOKEN
  await pane.press({ key: 'gitgud-setup-check' })
  await clock.settle()
  const saved = world.stored.filter(line => line.startsWith('["gitgud:settings"') && line.includes('"git.acme.dev"'))
  expect(saved.at(-1)).toContain('"provider":"bitbucket"')
  expect(saved.at(-1)).toContain(`"email":"${EMAIL}"`)
  expect(world.stored.join('\n')).not.toContain(TOKEN)
  expect(world.fetched.some(call => call.url === 'https://api.bitbucket.org/2.0/user' && call.headers.authorization === basicAuthHeader(EMAIL, TOKEN))).toBe(true)
  expect(world.argvs.every(argv => !['add-generic-password', 'store', 'login'].some(word => argv.includes(word)))).toBe(true)
  await pane.unmount()
})

test('➕ Add repo on GitLab lists host-keyed repos and saves gitlab.com/group/sub/proj', SLOW, async ($, on) => {
  const other = '{"path_with_namespace":"g/other/proj","web_url":"https://gitlab.com/g/other/proj","default_branch":"main"}'
  const world = worldOf('git@gitlab.com:g/sub/proj.git', {
    answers: { 'Which repo should the GitGud panel follow': 'g/other/proj' },
    cli: argv => {
      const path = argv[2] ?? ''
      if (argv[0] === 'glab' && path.startsWith('projects?')) return ran(0, `[${other}]`)
      if (argv[0] === 'glab' && path === 'projects/g%2Fother%2Fproj') return ran(0, other)

      return gitlabCli(argv)
    }
  })
  const { pane, clock } = await open($, on, world)
  await pane.press({ key: 'dock-main-settings-gitgud' })
  await pane.press({ key: 'gitgud-repo-add' })
  await clock.settle()

  const saved = world.stored.filter(line => line.startsWith('["gitgud:settings"'))
  expect(saved.at(-1)).toContain('"extraRepos":["gitlab.com/g/other/proj"]')
  await pane.unmount()
})

test('a known Bitbucket host that needs a token goes straight to its setup, never the which-service question', SLOW, async ($, on) => {
  const world = worldOf('git@bitbucket.org:ws/web.git', { http: bitbucketHttp, answers: { 'Where should GitGud read': 'Keychain (recommended)', 'Which email': EMAIL } })
  const { pane, clock } = await open($, on, world)
  expect(await pane.find({ type: 'Text', text: /needs a Bitbucket API token/ })).toBeDefined()
  await pane.press({ key: 'gitgud-setup-pick' })
  await clock.settle()

  expect(world.asked.some(question => /Which service|web address/.test(question))).toBe(false)
  expect(await pane.find({ type: 'Text', text: /security add-generic-password/ })).toBeDefined()
  await pane.unmount()
})

test('the Bitbucket token card shows beside a healthy GitHub card, and a missing token says where it looked', SLOW, async ($, on) => {
  const world = worldOf('git@gitlab.com:g/sub/proj.git', {
    cli: gitlabCli,
    http: bitbucketHttp,
    answers: { 'Which service hosts': 'Bitbucket Cloud', 'Where should GitGud read': 'Keychain (recommended)', 'Which email': EMAIL }
  })
  const { pane, clock } = await open($, on, world, { 'gitgud:settings': { isHaikuOn: false, hosts: { 'bitbucket.org': BB_HOST } } })
  await pane.press({ key: 'dock-main-settings-gitgud' })
  await pane.press({ key: 'gitgud-service-change-bitbucket.org' })
  await clock.settle()

  expect(await pane.find({ key: 'gitgud-setup-check' })).toBeDefined()
  expect(await pane.find({ key: 'gitgud-setup-copy' })).toBeDefined()
  await pane.press({ key: 'gitgud-setup-check' })
  await clock.settle()
  expect(await pane.find({ type: 'Text', text: /No token found in the keychain \(service gitgud-bitbucket, account ada@acme\.com\)/ })).toBeDefined()
  expect(world.fetched.length).toBe(0)
  await pane.unmount()
})

test('a host that never answers its probes still shows the pick card after the probe times out', SLOW, async ($, on) => {
  const world = worldOf('git@git.acme.dev:team/app.git', { isHung: true, cli: argv => (argv[1] === 'auth' ? ran(1, '', 'You are not logged in') : undefined) })
  const { pane, clock } = await open($, on, world)
  await clock.advance(6_000)

  expect(await pane.find({ type: 'Text', text: /Couldn't tell which service hosts git\.acme\.dev/ })).toBeDefined()
  await pane.unmount()
})

test('with no git remote, a signed-out gh gets its Sign in card, not the Pick a service card', SLOW, async ($, on) => {
  const signedOut = worldOf('', { cli: argv => (argv[0] === 'gh' ? ran(1, '', 'You are not logged in to any GitHub hosts. To log in, run: gh auth login') : undefined) })
  const first = await open($, on, signedOut)

  expect(await first.pane.find({ key: 'gitgud-login' })).toBeDefined()
  expect(await first.pane.find({ key: 'gitgud-setup-pick' })).toBeUndefined()
  await first.pane.unmount()
})

test('with no git remote and GitLab as the default host, a missing glab says glab, not gh', SLOW, async ($, on) => {
  const world = worldOf('', { cli: argv => (argv[0]?.endsWith('glab') ? ran(-2, '', 'glab: not found') : undefined) })
  const { pane } = await open($, on, world, { 'gitgud:settings': { isHaikuOn: false, defaultHost: 'gitlab.com', hosts: { 'gitlab.com': { provider: 'gitlab', decidedBy: 'person', at: 1 } } } })

  expect(await pane.find({ type: 'Text', text: /Needs the GitLab CLI/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Needs the GitHub CLI/ })).toBeUndefined()
  await pane.unmount()
})

test('Cancel on the Bitbucket token card closes it and leaves the unknown-host Pick card as it was', SLOW, async ($, on) => {
  const world = worldOf('git@git.acme.dev:team/app.git', {
    cli: argv => (argv[1] === 'auth' ? ran(1, '', 'You are not logged in') : undefined),
    http: bitbucketHttp,
    answers: { 'Which service hosts git.acme.dev': 'Bitbucket Cloud', 'web address': 'https://git.acme.dev', 'Where should GitGud read': 'Keychain (recommended)', 'Which email': EMAIL }
  })
  const { pane, clock } = await open($, on, world)
  await pane.press({ key: 'gitgud-setup-pick' })
  await clock.settle()
  expect(await pane.find({ key: 'gitgud-setup-check' })).toBeDefined()

  await pane.press({ key: 'gitgud-setup-later' })
  await clock.settle()
  expect(await pane.find({ key: 'gitgud-setup-check' })).toBeUndefined()
  expect(await pane.find({ key: 'gitgud-setup-pick' })).toBeDefined()
  await pane.unmount()
})
