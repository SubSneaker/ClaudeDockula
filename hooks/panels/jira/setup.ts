import type { JiraServerInfo, JiraSetup, JiraSettings, JiraSite, JiraState, Settings } from '../../../types'
import { compileTicketPattern, pickBoardServer } from '../../settings'

export type JiraSetupField = 'jql' | 'branchTemplate' | 'ticketPattern'

export const INVALID_PATTERN_NOTE = 'That ticket pattern is not valid: the default is used.'

/** `https://acme.atlassian.net` → `acme.atlassian.net`: how a site reads in the picker. */
export function siteLabel(site: JiraSite): string {
  return site.name ?? site.url.replace(/^https?:\/\//, '')
}

/**
 * The setup form as it opens: the saved choices filled in, the saved server listed even when it is not
 * connected right now.
 * @example
 * // before: servers [{ name: 'a', flavour: 'gateway' }], saved { jira: { server: 'a', site: S, jql: 'project = X' } }
 * // after:  { servers: [a], server: 'a', sites: [S], siteId: S.cloudId, jql: 'project = X', branchTemplate: '',
 * //           ticketPattern: '', isEditing: true }
 */
export function buildJiraSetup(servers: readonly JiraServerInfo[], settings: Settings): JiraSetup {
  const saved = settings.jira
  const listed = saved && !servers.some(server => server.name === saved.server) ? [{ name: saved.server, flavour: saved.flavour }] : []
  const ticketPattern = settings.ticketPattern ?? ''
  const isInvalid = ticketPattern !== '' && !compileTicketPattern(ticketPattern).isValid

  return {
    servers: [...listed, ...servers],
    sites: saved ? [saved.site] : [],
    jql: saved?.jql ?? '',
    branchTemplate: settings.branchTemplate ?? '',
    ticketPattern,
    ...(saved ? { server: saved.server, siteId: saved.site.cloudId, isEditing: true } : {}),
    ...(isInvalid ? { note: INVALID_PATTERN_NOTE } : {})
  }
}

/** A server was picked: its sites are not known yet. */
export function withChosenServer(setup: JiraSetup, server: string): JiraSetup {
  if (setup.server === server) return setup
  const { siteId: _siteId, note: _note, ...rest } = setup

  return { ...rest, server, sites: [], isLoadingSites: true }
}

/**
 * The sites the chosen server listed: a single one is taken, the saved one stays picked.
 * @example
 * // before: setup with siteId 'a', [{ cloudId: 'a', … }, { cloudId: 'b', … }]
 * // after:  setup with siteId 'a' and both sites listed
 */
export function withSites(setup: JiraSetup, sites: readonly JiraSite[]): JiraSetup {
  const only = sites.length === 1 ? sites[0] : undefined
  const kept = sites.find(site => site.cloudId === setup.siteId)
  const siteId = only?.cloudId ?? kept?.cloudId
  const { isLoadingSites: _loading, note: _note, siteId: _siteId, ...rest } = setup

  return {
    ...rest,
    sites: [...sites],
    ...(siteId ? { siteId } : {}),
    ...(sites.length === 0 ? { note: 'No Jira site found for that server.' } : {})
  }
}

export function withChosenSite(setup: JiraSetup, cloudId: string): JiraSetup {
  return setup.sites.some(site => site.cloudId === cloudId) ? { ...setup, siteId: cloudId } : setup
}

export function withSetupField(setup: JiraSetup, field: JiraSetupField, value: string): JiraSetup {
  return { ...setup, [field]: value }
}

export interface SetupOutcome {
  settings: Settings
  /** A dim line for the form: what was left out. */
  note?: string
}

/**
 * The settings a filled form saves; nothing until a server and a site are picked. A blank field is not saved, so
 * its default stands, and an invalid ticket pattern is left out.
 * @example
 * // before: setup { server: 'b', siteId: 'x', jql: '', branchTemplate: 'feat/{key}-', ticketPattern: '([' }, previous {}
 * // after:  { settings: { jira: { server: 'b', flavour: 'gateway', boardServer: 'b', site }, branchTemplate: 'feat/{key}-' },
 * //           note: 'That ticket pattern is not valid: the default is used.' }
 */
export function settingsFromSetup(setup: JiraSetup, previous: Settings): SetupOutcome | undefined {
  const info = setup.servers.find(server => server.name === setup.server)
  const site = setup.sites.find(one => one.cloudId === setup.siteId)
  if (!info || !site) return undefined
  const boardServer = pickBoardServer(setup.servers, info.name)
  const jql = setup.jql.trim()
  const jira: JiraSettings = {
    server: info.name,
    flavour: info.flavour,
    site,
    ...(boardServer ? { boardServer } : {}),
    ...(jql ? { jql } : {})
  }
  const { jira: _jira, branchTemplate: _template, ticketPattern: _pattern, ...kept } = previous
  const template = setup.branchTemplate.trim()
  const pattern = setup.ticketPattern.trim()
  const isPatternValid = pattern === '' || compileTicketPattern(pattern).isValid

  return {
    settings: {
      ...kept,
      jira,
      ...(template ? { branchTemplate: template } : {}),
      ...(pattern && isPatternValid ? { ticketPattern: pattern } : {})
    },
    ...(isPatternValid ? {} : { note: INVALID_PATTERN_NOTE })
  }
}

/** The state with what was read from the old server and site dropped, so a changed choice loads afresh. */
export function withFreshLoad(state: JiraState): JiraState {
  const {
    tickets: _tickets,
    listError: _listError,
    listedAt: _listedAt,
    board: _board,
    boards: _boards,
    boardProject: _boardProject,
    boardsProject: _boardsProject,
    boardNote: _boardNote,
    boardError: _boardError,
    issue: _issue,
    error: _error,
    hasCheckedBranch: _hasCheckedBranch,
    ticketKey: _ticketKey,
    ...rest
  } = state

  return rest
}
