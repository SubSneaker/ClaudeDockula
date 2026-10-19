import { expect, test } from 'claude-code/testing'

import type { GhReviewAsk } from '../types'
import { GIT_FILTER_DRIVERS, GIT_VERSION, gitArchive, gitHasCommit, removeReviewDir, tarExtract } from '../hooks/panels/gitgud/argv'
import { isAllowedArgv } from '../hooks/panels/gitgud/guard'
import { reviewTaskPrompt, reviewerSystemPrompt } from '../hooks/panels/gitgud/prompts'
import type { FullThread } from '../hooks/panels/gitgud/parse'
import {
  SECRET_DENY_RULES,
  askAnswerJson,
  askIdOf,
  askTimeOf,
  filterDriversOf,
  gitVersionOf,
  isGitNewEnough,
  borrowedRules,
  doneChoices,
  notifyChannelOf,
  parseAskFile,
  readStreamLine,
  relayPathOf,
  reviewDirTime,
  reviewLogMarkdown,
  reviewPaths,
  reviewSettingsOf,
  reviewerArgv,
  reviewerSettings,
  reviewsRootOf,
  splitLines,
  stepWords,
  withTimedOutAsks,
  type ReviewLog
} from '../hooks/panels/gitgud/review'

const SHA = 'abcdef1234567890abcdef1234567890abcdef12'
const ROOT = reviewsRootOf('/var/folders/x/T/', '/home/t') ?? ''
const DRIVERS = ['lfs', 'git-crypt']
const PLUGIN = '/plugins/claudedockula'
const GUARD = { reviewRoot: ROOT, pluginRoot: PLUGIN, readDirs: ['/home/t/.claude/skills'] }
const PATHS = reviewPaths(ROOT, 'o/r', 12, 1_700_000_000_000)
const SESSION = {
  permissions: {
    allow: ['Bash(ls)', 'WebFetch(domain:docs.python.org)', 'WebFetch(domain:*.mozilla.org)', 'WebFetch', 'WebSearch', 'WebSearch(react)', 'mcp__x__y'],
    deny: ['Read(./secrets/**)', 'Bash(rm:*)'],
    ask: ['WebFetch']
  },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'afplay x' }] }] },
  env: { CLAUDE_CODE_PLUGIN_DIRS: '/x' },
  enabledPlugins: { 'a@b': true }
}

function argvOf(overrides: { isWebOn?: boolean; model?: 'sonnet' | 'opus' } = {}): string[] {
  const isWebOn = overrides.isWebOn ?? true
  const settings = reviewerSettings(relayPathOf(PLUGIN), PATHS.asks, borrowedRules(SESSION, isWebOn))

  return reviewerArgv({ claude: 'claude', model: overrides.model ?? 'sonnet', isWebOn, settings, system: 'Review it.', addDirs: ['/home/t/.claude/skills'] })
}

/** The argv with one flag's value swapped. */
function withValue(argv: readonly string[], flag: string, value: string): string[] {
  const at = argv.indexOf(flag)

  return argv.map((token, index) => (index === at + 1 ? value : token))
}

test('the reviewer borrows only web allow rules and every deny rule; its settings hold the relay as the only hook', () => {
  expect(borrowedRules(SESSION, true)).toEqual({ allow: ['WebFetch(domain:docs.python.org)', 'WebFetch(domain:*.mozilla.org)'], deny: ['Read(./secrets/**)', 'Bash(rm:*)'] })
  // A bare WebFetch or WebSearch, any WebSearch rule and a malformed domain stay asks.
  const malformed = ['WebFetch(domain:*)', 'WebFetch(domain:)', 'WebFetch(domain:a b.com)', 'WebFetch(domain:*.*.com)', 'WebFetch(domain:docs.*.org)', 'WebFetch(domain:x .com)', 'WebFetch(https://x.com)', 'WebFetch(domain:x.com:443)']
  expect(borrowedRules({ permissions: { allow: ['WebFetch', 'WebSearch', ...malformed] } }, true).allow).toEqual([])
  expect(borrowedRules(SESSION, false).allow).toEqual([])
  expect(borrowedRules('nonsense', true)).toEqual({ allow: [], deny: [] })
  const settings = reviewerSettings(relayPathOf(PLUGIN), PATHS.asks, borrowedRules(SESSION, true))
  expect(Object.keys(settings).sort()).toEqual(['hooks', 'permissions'])
  expect(settings.permissions.deny).toEqual(expect.arrayContaining([...SECRET_DENY_RULES, 'Read(./secrets/**)']))
  expect(Object.keys(settings.hooks)).toEqual(['PermissionRequest'])
  expect(settings.hooks.PermissionRequest[0]?.hooks[0]).toEqual({ type: 'command', command: `sh '${PLUGIN}/hooks/panels/gitgud/ask-relay.sh' '${PATHS.asks}'`, timeout: 700 })
})

test('the reviews root is the person\'s own temp folder, never a relative one; a review folder\'s name says when it was made', () => {
  expect(ROOT).toBe('/var/folders/x/T/claudedockula-reviews')
  expect(reviewsRootOf(undefined, '/home/t')).toBe('/home/t/.cache/claudedockula-reviews')
  expect([reviewsRootOf('tmp', '/home/t'), reviewsRootOf('', '/home/t'), reviewsRootOf('/a/../b', '/home/t'), reviewsRootOf(undefined, 'home')]).toEqual([undefined, undefined, undefined, undefined])
  expect(reviewDirTime('o__r-12-1700000000000')).toBe(1_700_000_000_000)
  expect(reviewDirTime('notes')).toBeUndefined()
})

test('the reviewer argv: no setting sources, strict MCP, read tools (web ones while on), the model, no prompt argument', () => {
  const argv = argvOf()
  const after = (flag: string) => argv[argv.indexOf(flag) + 1]
  expect(after('--setting-sources')).toBe('')
  expect(after('--tools')).toBe('Read,Grep,Glob,WebFetch,WebSearch')
  expect(after('--permission-mode')).toBe('default')
  expect(after('--model')).toBe('sonnet')
  expect(argv).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'stream-json', '--include-hook-events']))
  expect(after('--add-dir')).toBe('/home/t/.claude/skills')
  const off = argvOf({ isWebOn: false, model: 'opus' })
  expect(off[off.indexOf('--tools') + 1]).toBe('Read,Grep,Glob')
  expect(off[off.indexOf('--model') + 1]).toBe('opus')
  expect(JSON.parse(off[off.indexOf('--settings') + 1] ?? '{}').permissions.allow).toEqual([])
  expect(isAllowedArgv(argv, GUARD)).toBe(true)
  expect(isAllowedArgv(off, GUARD)).toBe(true)
  expect(isAllowedArgv(['/home/t/.local/bin/claude', ...argv.slice(1)], GUARD)).toBe(true)
})

test('the guard refuses any other claude run', () => {
  const argv = argvOf()
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '{}')
  const hook = settings.hooks.PermissionRequest[0].hooks[0]
  const swapped = (change: object) => withValue(argv, '--settings', JSON.stringify({ ...settings, ...change }))
  const refused = [
    [...argv, 'review this'],
    [...argv, '--dangerously-skip-permissions'],
    [...argv, '--mcp-config', '/x.json'],
    [...argv, '--add-dir', 'relative'],
    [...argv, '--add-dir', '/a/../b'],
    [...argv, '--add-dir', '/'],
    [...argv, 'toString', 'review this'],
    [...argv, 'constructor', 'x'],
    [...argv, '--model', 'opus'],
    withValue(argv, '--permission-mode', 'bypassPermissions'),
    withValue(argv, '--setting-sources', 'user'),
    withValue(argv, '--model', 'haiku'),
    withValue(argv, '--tools', 'Read,Grep,Glob,Bash'),
    withValue(argv, '--tools', 'Grep,Glob'),
    withValue(argv, '--max-turns', '300'),
    argv.filter(token => token !== '--strict-mcp-config'),
    swapped({ env: { X: '1' } }),
    swapped({ permissions: { ...settings.permissions, allow: ['Bash(git push:*)'] } }),
    swapped({ permissions: { ...settings.permissions, deny: [] } }),
    swapped({ hooks: { ...settings.hooks, Stop: settings.hooks.PermissionRequest } }),
    swapped({ hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ ...hook, command: 'sh /tmp/evil.sh' }] }] } }),
    swapped({ hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ ...hook, command: `sh '${PLUGIN}/hooks/panels/gitgud/ask-relay.sh' '/elsewhere/asks'` }] }] } }),
    ['bash', '-c', 'claude -p']
  ]
  expect(refused.filter(one => isAllowedArgv(one, GUARD))).toEqual([])
  expect(isAllowedArgv(argv)).toBe(false)
})

test('the clean copy: cat-file, archive and tar into one review folder, rm of that folder; nothing broader', () => {
  const allowed = [GIT_VERSION, GIT_FILTER_DRIVERS, gitHasCommit(SHA), gitArchive(SHA, PATHS.tar, DRIVERS), gitArchive(SHA, PATHS.tar, []), tarExtract(PATHS.tar, PATHS.dir), removeReviewDir(PATHS.dir)]
  expect(allowed.filter(argv => !isAllowedArgv(argv, GUARD))).toEqual([])
  expect(gitArchive(SHA, PATHS.tar, ['lfs'])).toEqual([
    'git', '--no-optional-locks', '--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    '-c', 'filter.lfs.process=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false',
    'archive', '--format=tar', '--prefix=tree/', '-o', PATHS.tar, SHA
  ])
  expect(tarExtract(PATHS.tar, PATHS.dir)).toEqual(['tar', '-xf', PATHS.tar, '-C', PATHS.dir, '--exclude', '.claude', '--exclude', '.mcp.json', '--exclude', '.git', '--exclude', '.githooks', '--exclude', '.git-hooks'])
  const refused = [
    gitHasCommit('HEAD'),
    ['git', '--no-optional-locks', 'cat-file', '-p', SHA],
    gitArchive(SHA, '/repo/pr.tar', DRIVERS),
    gitArchive(SHA, `${ROOT}/pr.tar`, DRIVERS),
    gitArchive('HEAD', PATHS.tar, DRIVERS),
    gitArchive(SHA, PATHS.tar, ['x y']),
    [...gitArchive(SHA, PATHS.tar, DRIVERS), '--remote=x'],
    gitArchive(SHA, PATHS.tar, DRIVERS).filter(token => token !== 'filter.lfs.required=false' && token !== '-c'),
    gitArchive(SHA, PATHS.tar, DRIVERS).map(token => (token === 'filter.lfs.smudge=' ? 'filter.lfs.smudge=sh -c x' : token)),
    ['git', '--no-optional-locks', 'archive', '--format=tar', '--prefix=tree/', '-o', PATHS.tar, SHA],
    ['git', '--no-optional-locks', 'config', 'filter.lfs.smudge', 'x'],
    ['git', 'fetch', 'origin'],
    ['git', '--no-optional-locks', 'worktree', 'add', PATHS.tree],
    tarExtract(PATHS.tar, '/repo'),
    tarExtract('/repo/pr.tar', PATHS.dir),
    tarExtract(PATHS.tar, PATHS.dir).slice(0, 5),
    ['tar', '-xPf', PATHS.tar, '-C', PATHS.dir],
    ['/usr/bin/tar', ...tarExtract(PATHS.tar, PATHS.dir).slice(1)],
    removeReviewDir(ROOT),
    removeReviewDir(PATHS.tree),
    removeReviewDir(`${ROOT}/..`),
    removeReviewDir('/'),
    ['rm', '-rf', PATHS.dir, '/'],
    ['rm', '-r', PATHS.dir]
  ]
  expect(refused.filter(argv => isAllowedArgv(argv, GUARD))).toEqual([])
  expect(isAllowedArgv(removeReviewDir(PATHS.dir))).toBe(false)
})

const LINES = [
  '{"type":"system","subtype":"init","tools":["Read","Grep","Glob"],"skills":["x"],"plugins":[],"mcp_servers":[],"cwd":"/t"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Let me look."},{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/t/tree/src/a.ts"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","is_error":true,"content":"File does not exist."}]}}',
  '{"type":"system","subtype":"hook_started","hook_event":"PermissionRequest"}',
  '{"type":"system","subtype":"permission_denied","tool_name":"WebFetch","decision_reason":"No answer in time"}',
  '{"type":"result","subtype":"success","is_error":false,"result":"## Summary\\nFine.","num_turns":3,"total_cost_usd":0.042,"permission_denials":[{"tool_name":"WebFetch"}]}'
]

test('the stream: split into lines, read into events, each step in plain words', () => {
  expect(splitLines('{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], rest: '{"b"' })
  const events = LINES.flatMap(readStreamLine)
  expect(events.map(event => event.type)).toEqual(['init', 'text', 'tool', 'tool-result', 'hook', 'denied', 'result'])
  expect(events[3]).toEqual({ type: 'tool-result', id: 'tu1', isError: true, error: 'File does not exist.' })
  expect(events.at(-1)).toMatchObject({ subtype: 'success', text: '## Summary\nFine.', turns: 3, costUsd: 0.042 })
  expect(readStreamLine('not json')).toEqual([])
  const places = { tree: '/t/tree', home: '/home/t' }
  expect(stepWords('Read', { file_path: '/t/tree/src/a.ts' }, places)).toBe('reading src/a.ts')
  expect(stepWords('Read', { file_path: '/home/t/.claude/skills/pr-review/SKILL.md' }, places)).toBe('reading ~/.claude/skills/pr-review/SKILL.md')
  expect(stepWords('Grep', { pattern: 'useFoo', path: '/t/tree/src' }, places)).toBe('searching for useFoo in src')
  expect(stepWords('Glob', { pattern: '*/SKILL.md' }, places)).toBe('looking for */SKILL.md')
  expect(stepWords('WebFetch', { url: 'https://docs.python.org/3/library/json.html' }, places)).toBe('fetching docs.python.org')
  expect(stepWords('WebSearch', { query: 'react 19 useActionState' }, places)).toBe('searching the web for "react 19 useActionState"')
})

const WEB_ASK = JSON.stringify({
  hook_event_name: 'PermissionRequest',
  tool_name: 'WebFetch',
  tool_input: { url: 'https://docs.python.org/3/', prompt: 'x' },
  permission_suggestions: [{ type: 'addRules', destination: 'localSettings', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:docs.python.org' }], behavior: 'allow' }]
})

test('the copy needs a git with --attr-source, and switches off every filter driver the config names', () => {
  expect(gitVersionOf('git version 2.49.0\n')).toEqual([2, 49])
  expect([isGitNewEnough([2, 49]), isGitNewEnough([2, 41]), isGitNewEnough([2, 40]), isGitNewEnough([1, 99]), isGitNewEnough(undefined)]).toEqual([true, true, false, false, false])
  expect(filterDriversOf('filter.lfs.process\ngit-lfs filter-process\0filter.lfs.required\ntrue\0filter.git-crypt.smudge\n"git-crypt" smudge\0')).toEqual(DRIVERS)
  expect(filterDriversOf('')).toEqual([])
  expect(filterDriversOf('filter.my driver.smudge\nx\0')).toBeUndefined()
})

test('an ask file becomes an ask; each answer is the relay JSON exactly; 10 minutes on it shows as denied', () => {
  expect(askIdOf('ask-1792331803-42.json')).toBe('1792331803-42')
  // Its 10 minutes count from when the relay wrote it, never later than when the card saw it.
  expect(askTimeOf('1792331803-42', 1_792_331_810_000)).toBe(1_792_331_803_000)
  expect(askTimeOf('1792331803-42', 1_792_331_000_000)).toBe(1_792_331_000_000)
  expect(askIdOf('ask-1792331803-42.tmp')).toBeUndefined()
  const parsed = parseAskFile('1792331803-42', WEB_ASK, {})
  expect(parsed).toEqual({ id: '1792331803-42', tool: 'WebFetch', what: 'fetch https://docs.python.org/3/', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:docs.python.org' }], ruleLabel: 'docs.python.org' })
  expect(parseAskFile('1', 'garbage', {})).toBeUndefined()
  const ask: GhReviewAsk = { id: '1792331803-42', tool: 'WebFetch', what: 'fetch', ...parsed, askedAt: 1_000 }
  expect(askAnswerJson('once', ask)).toBe('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}')
  expect(askAnswerJson('review', ask)).toBe(
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"addRules","rules":[{"toolName":"WebFetch","ruleContent":"domain:docs.python.org"}],"behavior":"allow","destination":"session"}]}}}'
  )
  expect(askAnswerJson('deny', ask)).toBe(
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"The person denied this in the ClaudeDockula panel. Carry on without it."}}}'
  )
  expect(askAnswerJson('review', { rules: undefined })).toBe(askAnswerJson('once', {}))
  // The card stops taking answers 10 s before the relay gives up, so no answer lands after it denied.
  expect(withTimedOutAsks([ask], 590_999)).toEqual([ask])
  expect(withTimedOutAsks([ask], 591_000)).toEqual([{ ...ask, answer: 'timeout', answeredAt: 591_000 }])
})

test('when a review finishes: only what the notification channel offers; settings fall back to their defaults', () => {
  expect(doneChoices('terminal_bell').choices.map(choice => choice.label)).toEqual(['Notice only', 'Notice + terminal bell'])
  expect(doneChoices('iterm2').choices.map(choice => choice.value)).toEqual(['notice', 'notify'])
  expect(doneChoices('notifications_disabled')).toEqual({ choices: [{ value: 'notice', label: 'Notice only' }], note: 'Notifications are off in /config.' })
  expect(doneChoices(undefined).note).toContain('/config')
  expect(notifyChannelOf([{ key: 'theme', value: 'dark' }, { key: 'preferredNotifChannel', value: 'kitty' }])).toBe('kitty')
  expect(notifyChannelOf('x')).toBeUndefined()
  expect(reviewSettingsOf({ reviewModel: 'opus', isReviewWebOn: false, reviewDone: 'bell' })).toEqual({ model: 'opus', isWebOn: false, done: 'bell' })
  expect(reviewSettingsOf({ reviewModel: 'gpt', reviewDone: 'siren' })).toEqual({ model: 'sonnet', isWebOn: true, done: 'notice' })
})

const THREAD: FullThread = { kind: 'pr', repo: 'o/r', number: 12, title: 'Fix it', url: 'https://github.com/o/r/pull/12', author: 'a', body: 'Body', comments: [], reviews: [], threads: [] }

test("the reviewer's prompt and instructions say where the code is, what it may fetch, and where the skills are", () => {
  const item = { id: 'o/r#12', kind: 'pr' as const, repo: 'o/r', number: 12, title: 'Fix it', url: THREAD.url, author: 'a', updatedAt: '', comments: 0 }
  const copied = reviewTaskPrompt({ item, thread: THREAD, diff: '+x', copy: { kind: 'copy', sha: SHA } })
  expect(copied).toContain('head commit abcdef1')
  expect(copied).toContain('<data label="diff">\n+x\n</data>')
  expect(reviewTaskPrompt({ item, thread: THREAD, diff: '+x', copy: { kind: 'none', why: 'not here' } })).toContain('There is no copy of the code here')
  const system = reviewerSystemPrompt({ copy: { kind: 'none', why: 'its head commit abcdef1 is not on this machine' }, tree: '/t/tree', skillDirs: ['/home/t/.claude/skills'], isWebOn: true })
  expect(system).toContain('There is no copy of the code (its head commit abcdef1 is not on this machine)')
  expect(system).toContain('- /home/t/.claude/skills')
  expect(system).toContain('WebFetch and WebSearch')
  expect(reviewerSystemPrompt({ copy: { kind: 'copy', sha: SHA }, tree: '/t/tree', skillDirs: [], isWebOn: false })).toContain('You have no web access.')
})

test('the readable log: argv without the long values, what it could read, steps, asks, denials, the end', () => {
  const log: ReviewLog = {
    title: 'Fix it',
    number: 12,
    url: THREAD.url,
    logPath: '/d/review-12-x.log.md',
    streamPath: '/d/review-12-x.jsonl',
    env: { CLAUDE_CODE_PLUGIN_DIRS: '' },
    startedAt: Date.UTC(2026, 9, 16, 6, 30, 0),
    model: 'sonnet',
    isWebOn: true,
    copy: `a clean copy of the pull request at ${SHA}`,
    readable: ['/t/tree', '/home/t/.claude/skills'],
    argv: argvOf(),
    promptChars: 1234,
    steps: [{ id: 'tu1', at: Date.UTC(2026, 9, 16, 6, 30, 5), tool: 'Read', words: 'reading src/a.ts', status: 'error', error: 'File does not exist.' }],
    asks: [{ id: '1-2', at: Date.UTC(2026, 9, 16, 6, 31, 0), tool: 'WebFetch', what: 'fetch https://docs.python.org/3/', answer: 'review', answeredAt: Date.UTC(2026, 9, 16, 6, 31, 20) }],
    denials: [{ at: Date.UTC(2026, 9, 16, 6, 32, 0), tool: 'WebSearch', reason: 'denied' }],
    notes: [],
    stderr: '',
    end: { at: Date.UTC(2026, 9, 16, 6, 35, 0), status: 'review written', turns: 3, costUsd: 0.042, exit: '0' }
  }
  const text = reviewLogMarkdown(log)
  expect(text).toContain('Started 2026-10-16 06:30:00 UTC · Claude Sonnet · web lookups on')
  expect(text).toContain("CLAUDE_CODE_PLUGIN_DIRS='' claude -p --model sonnet")
  expect(text).toContain("--setting-sources '' --strict-mcp-config")
  expect(text).toContain('This log: /d/review-12-x.log.md')
  expect(text).toContain('Raw stream (every line the reviewer wrote): /d/review-12-x.jsonl')
  expect(text).toContain('--settings <settings below>')
  expect(text).toContain('"PermissionRequest"')
  expect(text).toContain('- /home/t/.claude/skills')
  expect(text).toContain('- 06:30:05 Read: reading src/a.ts — error: File does not exist.')
  expect(text).toContain('- 06:31:00 WebFetch: fetch https://docs.python.org/3/ — allowed for this review at 06:31:20')
  expect(text).toContain('- 06:32:00 WebSearch: denied')
  expect(text).toContain('3 turns · $0.0420 · exit 0')
  expect(text).toContain('The prompt (1234 characters')
})
