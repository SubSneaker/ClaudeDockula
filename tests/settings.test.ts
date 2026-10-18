import { expect, test } from 'claude-code/testing'

import {
  addSetupCheck,
  buildChecksSetup,
  detectPackageManager,
  parseCheckCommand,
  pickedChecks,
  slugCheckId,
  suggestChecks,
  toggleSetupCheck
} from '../hooks/panels/checks/setup'
import { buildJiraSetup, settingsFromSetup, withChosenServer, withSites } from '../hooks/panels/jira/setup'
import {
  compileTicketPattern,
  detectJiraServers,
  fillBranchTemplate,
  findTicketKey,
  openCommands,
  parseRepoSettings,
  parseSettings,
  pickBoardServer,
  repoSettingsKey
} from '../hooks/settings'

const SITE = { cloudId: 'abc', url: 'https://acme.atlassian.net' }
const STANDARD = { name: 'atlassian', flavour: 'standard' } as const
const GATEWAY = { name: 'claude_ai_Atlassian_MCP', flavour: 'gateway' } as const

test('settings read from the store: a malformed value counts as not set, never throws', () => {
  const jira = { server: 'a', flavour: 'standard', site: SITE, jql: 'project = X' }

  expect(parseSettings({ jira, branchTemplate: 'feat/{key}-', ticketPattern: '[A-Z]+-\\d+' })).toEqual({
    jira,
    branchTemplate: 'feat/{key}-',
    ticketPattern: '[A-Z]+-\\d+'
  })
  expect(parseSettings({ jira: { server: 'a' }, branchTemplate: '  ', ticketPattern: 7 })).toEqual({})
  expect([parseSettings(undefined), parseSettings('x'), parseSettings([])]).toEqual([{}, {}, {}])

  const good = { id: 'lint', name: 'Lint', argv: ['pnpm', 'run', 'lint'] }
  expect(parseRepoSettings({ checks: [good, good, { id: 'Bad Id', name: 'x', argv: ['x'] }, { id: 'a', name: 'a', argv: [] }, 3] })).toEqual({ checks: [good] })
  expect(parseRepoSettings({ checks: [] })).toEqual({ checks: [] })
  expect([parseRepoSettings(null), parseRepoSettings({ checks: 'no' })]).toEqual([{}, {}])
  expect(repoSettingsKey('/work/app')).toBe('settings:/work/app')
})

test('the ticket pattern is one helper with a default; an unusable one falls back to it', () => {
  expect(findTicketKey('ABC-101/add-export-button')).toBe('ABC-101')
  expect(findTicketKey('develop')).toBeUndefined()
  expect(findTicketKey('feature/ab-12-x', '[a-z]{2}-\\d+')).toBe('ab-12')
  expect(compileTicketPattern('([').isValid).toBe(false)
  expect(findTicketKey('ABC-1/x', '([')).toBe('ABC-1')
  expect(compileTicketPattern('x*').isValid).toBe(false)
  expect(compileTicketPattern('  ').isValid).toBe(true)
})

test('the branch template: {key} is filled, a missing template is the default', () => {
  expect(fillBranchTemplate('ABC-1')).toBe('! git switch -c ABC-1/')
  expect(fillBranchTemplate('ABC-1', 'feature/{key}-')).toBe('! git switch -c feature/ABC-1-')
  expect(fillBranchTemplate('ABC-1', '{key}/{key}')).toBe('! git switch -c ABC-1/ABC-1')
})

test('Jira servers are found by their tools, and the flavour by executeRead', () => {
  const tools = [
    'Read',
    'mcp__atlassian__getJiraIssue',
    'mcp__atlassian__searchJiraIssuesUsingJql',
    'mcp__claude_ai_Atlassian_MCP__getJiraIssue',
    'mcp__claude_ai_Atlassian_MCP__searchJiraIssuesUsingJql',
    'mcp__claude_ai_Atlassian_MCP__executeRead',
    'mcp__github__get_me'
  ]

  expect(detectJiraServers(tools)).toEqual([STANDARD, GATEWAY])
  expect(detectJiraServers(['mcp__github__get_me', 'mcp__x__getJiraIssue'])).toEqual([])
  expect(pickBoardServer([STANDARD, GATEWAY], 'atlassian')).toBe(GATEWAY.name)
  expect(pickBoardServer([STANDARD, GATEWAY], GATEWAY.name)).toBe(GATEWAY.name)
  expect(pickBoardServer([STANDARD], 'atlassian')).toBeUndefined()
  expect(openCommands('u').map(argv => argv[0])).toEqual(['open', 'xdg-open', 'cmd'])
})

test('the Jira form saves a picked server and site; blank fields stay unsaved and a bad pattern is left out', () => {
  const opened = buildJiraSetup([STANDARD, GATEWAY], {})
  expect(settingsFromSetup(opened, {})).toBeUndefined()

  const picked = withSites(withChosenServer(opened, 'atlassian'), [SITE])
  expect(picked.siteId).toBe('abc')
  expect(settingsFromSetup(picked, {})).toEqual({
    settings: { jira: { server: 'atlassian', flavour: 'standard', boardServer: GATEWAY.name, site: SITE } }
  })

  const typed = { ...picked, jql: ' project = X ', branchTemplate: 'feat/{key}-', ticketPattern: '([' }
  expect(settingsFromSetup(typed, { ticketPattern: 'old' })?.settings).toEqual({
    jira: { server: 'atlassian', flavour: 'standard', boardServer: GATEWAY.name, site: SITE, jql: 'project = X' },
    branchTemplate: 'feat/{key}-'
  })
  expect(settingsFromSetup(typed, {})?.note).toContain('not valid')

  const two = withSites(withChosenServer(opened, 'atlassian'), [SITE, { cloudId: 'def', url: 'https://other.atlassian.net' }])
  expect(two.siteId).toBeUndefined()
})

test('the Checks form: scripts from package.json through the lockfile\'s manager, a typed command, the ticked ones saved', () => {
  const packageJson = JSON.stringify({ scripts: { dev: 'next', lint: 'eslint .', 'format:check': 'prettier -c .', test: 'vitest' } })
  const manager = detectPackageManager(['package.json', 'yarn.lock'])
  const suggestions = suggestChecks(packageJson, manager)

  expect([manager, detectPackageManager(['bun.lock']), detectPackageManager(['pnpm-lock.yaml']), detectPackageManager([])]).toEqual(['yarn', 'bun', 'pnpm', 'npm'])
  expect(suggestions.map(check => check.argv.join(' '))).toEqual(['yarn run lint', 'yarn run test', 'yarn run format:check'])
  expect(suggestChecks('not json', 'npm')).toEqual([])
  expect(parseCheckCommand('Smoke: make smoke --fast')).toEqual({ name: 'Smoke', argv: ['make', 'smoke', '--fast'] })
  expect(parseCheckCommand('pnpm run format:check')).toEqual({ name: 'pnpm', argv: ['pnpm', 'run', 'format:check'] })
  expect(parseCheckCommand('  ')).toBeUndefined()
  expect(slugCheckId('Unit tests', ['unit-tests'])).toBe('unit-tests-2')
  expect(slugCheckId('All', [])).toBe('all-check')

  let setup = buildChecksSetup(undefined, suggestions, manager)
  setup = toggleSetupCheck(setup, 'test')
  setup = addSetupCheck(setup, 'Smoke: make smoke')
  expect(addSetupCheck(setup, '  ')).toBe(setup)
  expect(pickedChecks(setup).map(check => check.id)).toEqual(['test', 'smoke'])

  const reopened = buildChecksSetup(pickedChecks(setup), suggestions, manager)
  expect(reopened.options.map(option => option.id)).toEqual(['test', 'smoke', 'lint', 'format-check'])
  expect(reopened.picked).toEqual(['test', 'smoke'])
})
