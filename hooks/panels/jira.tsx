import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, On, RenderSurface, Timer } from 'claude-code'

import type {
  JiraBoard,
  JiraBoardView,
  JiraIssue,
  JiraMove,
  JiraServerInfo,
  JiraSettings,
  JiraSetup,
  JiraSite,
  JiraState,
  JiraTicket,
  NoticeTone,
  Settings
} from '../../types'
import { DEFAULT_LAYOUT, hiddenPaneIds, isShownIn } from '../dock/layout'
import { NO_NOTICES, pushNotice } from '../dock/notices'
import { cellWidth, drawActions, drawFieldRows, drawNote, fitEnd } from '../dock/ui'
import {
  DEFAULT_BRANCH_TEMPLATE,
  DEFAULT_JQL,
  DEFAULT_TICKET_PATTERN,
  SETTINGS_KEY,
  SET_UP_SUMMARY,
  detectJiraServers,
  openCommands,
  parseSettings
} from '../settings'
import type { DockPanel } from './contract'
import { prBadgesByKey, type PrBadge } from './gitgud/jiraLink'
import {
  boardOptions,
  boardProjectFor,
  buildBoardProps,
  buildLanes,
  chosenBoard,
  confirmMoveKey,
  confirmQuestion,
  isCardOpen,
  isLaneCollapsed,
  laneTitle,
  menuItemsFor,
  laneToggleKey,
  laneViews,
  moveTargetKey,
  parseBoardChoices,
  parseBoardConfig,
  parseBoardList,
  parseBoardMessage,
  parseConfirmPress,
  parseLaneToggle,
  parseMoveTarget,
  parseTransitions,
  pickBoard,
  pickTransition,
  toggleIn,
  withBoardLookup,
  type BoardLane,
  type BoardListParse,
  type BoardLookup,
  type CardView,
  type JiraTransition,
  type LaneView,
  type TicketAction
} from './jira/lanes'
import { mcpErrorText, parseAtlassianSites, parseJiraIssue, ticketKeyFromBranch } from './jira/parse'
import {
  NO_SERVER_ANSWERED,
  PERMISSION_HINT,
  assignedSearchArgs,
  boardConfigCall,
  boardListCall,
  errorText,
  fullTicketArgs,
  isPermissionDenial,
  jiraIssueArgs,
  joinServerErrors,
  transitionCall,
  transitionsCall,
  withPermissionHint
} from './jira/servers'
import {
  buildJiraSetup,
  settingsFromSetup,
  siteLabel,
  withChosenServer,
  withChosenSite,
  withFreshLoad,
  withSetupField,
  withSites,
  type JiraSetupField
} from './jira/setup'
import {
  buildBranchCommand,
  buildFullTicketMarkdown,
  buildTicketLink,
  parseFullTicket,
  parseTicketSearch,
  type FullTicket
} from './jira/ticket'

// The engine follows `$` only into functions declared in the same file, so every
// function that takes `$` lives here; the drawing below takes no `$`.

const REFRESH_KEY = 'jira-refresh'
const OPEN_KEY = 'jira-open'
const SETUP_KEY = 'jira-setup'
const SETUP_SERVER_KEY = 'jira-setup-server-'
const SETUP_SITE_KEY = 'jira-setup-site-'
const SETUP_FIELD_KEY = 'jira-setup-field-'
const SAVE_KEY = 'jira-save'
const CANCEL_KEY = 'jira-cancel'
/** The board's `Client` key, the dock's id after it (`jira-board-main`): two docks showing the board hold two instances. */
const BOARD_KEY = 'jira-board-'
const PICK_KEY = 'jira-pick'
const PICK_MENU_KEY = 'jira-pick-menu'
const PICK_BOARD_KEY = 'jira-pick-'
const CARD_KEY = 'jira-card-'
const MENU_KEY = 'jira-menu-'
const ACT_KEY = 'jira-act-'
const ACT_PRESS = /^jira-act-(move|branch|open|pr|link|full)-(.+)$/
const CONFIRM_KEY = 'jira-confirm-'
const BRANCH_CHECK_MS = 60_000
const LIST_REFRESH_MS = 120_000
const MAX_BOARDS = 5
const BOARD_STORE_KEY = 'jiraBoardChoices'
const GIT_BRANCH = ['git', '--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD']

const jiraState = atom({ plugin: 'claudedockula', key: 'jira' } as const, {})
const gitgudState = atom({ plugin: 'claudedockula', key: 'gitgud' } as const, {})
const layoutAtom = atom({ plugin: 'claudedockula', key: 'layout' } as const, DEFAULT_LAYOUT)
const noticesAtom = atom({ plugin: 'claudedockula', key: 'notices' } as const, NO_NOTICES)

let latestRequest = 0
let latestListRequest = 0
let latestPreview = 0
/** The last board lookup or pick: an older one that ends later writes nothing. */
let latestBoardRequest = 0
/** The board the person picked while its columns load, and the board request carrying it; stale once a newer one starts. */
let pendingPick: { project: string; boardId: number; request: number } | undefined
/** The ticket whose move is running, taken before any await so a second press or post cannot start a second write. */
let movingKey: string | undefined
let branchTicker: Timer | undefined
let listTicker: Timer | undefined

interface JiraFetchOutcome {
  issue?: JiraIssue
  error?: string
}

interface TicketsOutcome {
  tickets?: JiraTicket[]
  error?: string
}

interface FullTicketOutcome {
  ticket?: FullTicket
  error?: string
}

interface BoardConfigOutcome {
  board?: JiraBoard
  error?: string
}

interface TransitionsOutcome {
  transitions?: JiraTransition[]
  error?: string
}

interface MoveOutcome {
  /** The status the ticket landed in. */
  moved?: string
  error?: string
  /** The write went out, whatever came back: the board reloads to show where Jira has the ticket. */
  isWriteSent?: boolean
}

interface NoticeOptions {
  detail?: string
  topic?: string
}

/** Tells the person something in the band above the prompt: errors stay until dismissed, the rest clear by themselves. */
async function notify($: EngineInterface, tone: NoticeTone, title: string, options: NoticeOptions = {}): Promise<void> {
  const at = await $.clock.now()
  await update($, noticesAtom, list => pushNotice(list, { tone, title, at, ...options }))
}

/** The ticket key in the current branch's name, or undefined (no key, detached HEAD, not a repo). */
async function readBranchTicketKey($: EngineInterface, ticketPattern?: string): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(GIT_BRANCH, { timeoutMs: 10_000 })

    return exitCode === 0 ? ticketKeyFromBranch(stdout.trim(), ticketPattern) : undefined
  } catch {
    return undefined
  }
}

/** The saved settings, read from the store once. */
async function loadSettings($: EngineInterface): Promise<Settings> {
  const state = await read($, jiraState)
  if (state.isSettingsLoaded && state.settings) return state.settings
  const settings = parseSettings(await $.store.get(SETTINGS_KEY).catch(() => undefined))
  await update($, jiraState, value => ({ ...value, isSettingsLoaded: true, settings }))

  return settings
}

/** The connected MCP servers that expose Jira tools. */
async function readJiraServers($: EngineInterface): Promise<JiraServerInfo[]> {
  const tools = await $.tool.list().catch(() => [])

  return detectJiraServers(tools.map(tool => tool.name))
}

interface SitesOutcome {
  sites: JiraSite[]
  error?: string
}

/** The Jira sites the server's account reaches, read-only. */
async function listSites($: EngineInterface, server: string): Promise<SitesOutcome> {
  try {
    const result = await $.mcp.call(server, 'getAccessibleAtlassianResources', {})
    const sites = parseAtlassianSites(result)

    return sites.length > 0 || !result.isError ? { sites } : { sites, error: `${server}: ${mcpErrorText(result)}` }
  } catch (error) {
    return { sites: [], error: `${server}: ${errorText(error)}` }
  }
}

/** Reads one issue, read-only, through the configured server. */
async function fetchJiraIssue($: EngineInterface, jira: JiraSettings, key: string): Promise<JiraFetchOutcome> {
  try {
    const result = await $.mcp.call(jira.server, 'getJiraIssue', jiraIssueArgs(jira.flavour, jira.site.cloudId, key))
    const parsed = parseJiraIssue(result, jira.site.url)

    return parsed.isOk ? { issue: parsed.issue } : { error: `${jira.server}: ${parsed.error}` }
  } catch (error) {
    return { error: `${jira.server}: ${errorText(error)}` }
  }
}

/** The person's tickets, read-only, through the configured server. */
async function searchAssigned($: EngineInterface, jira: JiraSettings): Promise<TicketsOutcome> {
  try {
    const args = assignedSearchArgs(jira.flavour, jira.site.cloudId, jira.jql ?? DEFAULT_JQL)
    const result = await $.mcp.call(jira.server, 'searchJiraIssuesUsingJql', args)
    const parsed = parseTicketSearch(result, jira.site.url)

    return parsed.isOk ? { tickets: parsed.tickets } : { error: `${jira.server}: ${parsed.error}` }
  } catch (error) {
    return { error: `${jira.server}: ${errorText(error)}` }
  }
}

/** One whole ticket for the prompt, read-only. */
async function fetchFullTicket($: EngineInterface, jira: JiraSettings, key: string): Promise<FullTicketOutcome> {
  try {
    const result = await $.mcp.call(jira.server, 'getJiraIssue', fullTicketArgs(jira.flavour, jira.site.cloudId, key))
    const parsed = parseFullTicket(result, jira.site.url)

    return parsed.isOk ? { ticket: parsed.ticket } : { error: `${jira.server}: ${parsed.error}` }
  } catch (error) {
    return { error: `${jira.server}: ${errorText(error)}` }
  }
}

/** One board's columns, read-only, from the server that has boards. */
async function fetchBoardConfig($: EngineInterface, jira: JiraSettings, boardServer: string, project: string, boardId: number): Promise<BoardConfigOutcome> {
  try {
    const call = boardConfigCall(jira.site.cloudId, boardId)
    const result = await $.mcp.call(boardServer, call.tool, call.args)
    const board = parseBoardConfig(result, project)
    if (board) return { board }

    return { error: `${boardServer}: ${result.isError ? mcpErrorText(result) : 'Jira answered without the board’s columns'}` }
  } catch (error) {
    return { error: `${boardServer}: ${errorText(error)}` }
  }
}

/** The project's boards, read-only. */
async function listBoards($: EngineInterface, jira: JiraSettings, boardServer: string, project: string): Promise<BoardListParse> {
  try {
    const call = boardListCall(jira.site.cloudId, project)

    return parseBoardList(await $.mcp.call(boardServer, call.tool, call.args))
  } catch (error) {
    return { isOk: false, error: errorText(error) }
  }
}

/** The project's boards and the one the lanes follow: the person's pick, else the one with the most columns. */
async function lookUpBoard($: EngineInterface, jira: JiraSettings, boardServer: string, project: string, choice?: number): Promise<BoardLookup> {
  const listed = await listBoards($, jira, boardServer, project)
  if (!listed.isOk) return { error: `${boardServer}: ${listed.error}` }
  const { boards } = listed
  const picked = chosenBoard(boards, choice)
  if (picked) return { boards, ...(await fetchBoardConfig($, jira, boardServer, project, picked.id)) }
  const configs = await Promise.all(boards.slice(0, MAX_BOARDS).map(board => fetchBoardConfig($, jira, boardServer, project, board.id)))
  const board = pickBoard(configs.flatMap(config => config.board ?? []))
  if (board || boards.length === 0) return { boards, ...(board ? { board } : {}) }

  return { boards, error: joinServerErrors(configs.flatMap(config => config.error ?? [])) }
}

/** Looks for the project's board until a lookup succeeds, or again with `isForced` (the Refresh button). */
async function ensureBoard($: EngineInterface, isForced: boolean): Promise<void> {
  const state = await read($, jiraState)
  const jira = state.settings?.jira
  const boardServer = jira?.boardServer
  const project = boardProjectFor(state)
  const isDone = state.boardProject === project && state.boards !== undefined
  const loading = pendingPick?.request === latestBoardRequest ? pendingPick : undefined
  // A timer's lookup waits while a pick loads; Refresh looks again, keeping the pick as its choice.
  if (!project || !jira || !boardServer || (!isForced && (isDone || loading))) return
  const pick = loading?.project === project ? loading : undefined
  const request = ++latestBoardRequest
  if (pick) pendingPick = { ...pick, request }
  const lookup = await lookUpBoard($, jira, boardServer, project, pick?.boardId ?? state.boardChoices?.[project])
  // A pick made meanwhile wins: its board is the one the person asked for.
  if (request !== latestBoardRequest) return
  if (pick) pendingPick = undefined

  await update($, jiraState, value => ({ ...withBoardLookup(value, project, lookup), isBoardLoading: false }))
  if (pick && lookup.board?.id === pick.boardId) await rememberBoard($, project, pick.boardId)
}

/** Remembers the person's board for the project, in the state and in the store for the next session. */
async function rememberBoard($: EngineInterface, project: string, boardId: number): Promise<void> {
  await update($, jiraState, value => ({ ...value, boardChoices: { ...value.boardChoices, [project]: boardId } }))
  const stored = parseBoardChoices(await $.store.get(BOARD_STORE_KEY).catch(() => undefined))
  await $.store.set(BOARD_STORE_KEY, { ...stored, [project]: boardId }).catch(() => undefined)
}

/** The person picked a board: its columns become the lanes, and once they load it is remembered for the project. */
async function chooseBoard($: EngineInterface, boardId: number): Promise<void> {
  const state = await read($, jiraState)
  const project = state.boardsProject ?? state.boardProject ?? boardProjectFor(state)
  const picked = chosenBoard(state.boards ?? [], boardId)
  const jira = state.settings?.jira
  const boardServer = jira?.boardServer
  if (!project || !jira || !boardServer || !picked) return
  const request = ++latestBoardRequest
  const isCurrent = state.board?.id === boardId
  if (!isCurrent) pendingPick = { project, boardId, request }
  await changeView($, view => ({ ...view, isBoardMenuOpen: false }))
  if (isCurrent) {
    await update($, jiraState, value => ({ ...value, isBoardLoading: false }))
    await rememberBoard($, project, boardId)

    return
  }
  await update($, jiraState, value => ({ ...value, isBoardLoading: true }))
  const outcome = await fetchBoardConfig($, jira, boardServer, project, boardId)
  if (request !== latestBoardRequest) return
  pendingPick = undefined
  const { board } = outcome
  await update($, jiraState, value => {
    const { isBoardLoading: _loading, boardNote: _note, boardError: _error, ...rest } = value
    if (board) return { ...rest, board }

    return { ...value, isBoardLoading: false, ...(outcome.error ? { boardError: outcome.error } : {}) }
  })
  if (board) await rememberBoard($, project, boardId)
  else await notify($, 'error', `Couldn't load ${picked.name}`, { detail: withPermissionHint(outcome.error ?? NO_SERVER_ANSWERED) })
}

/** The board's view without a confirm about a ticket that is no longer in the list. */
function withoutGoneConfirm(view: JiraBoardView | undefined, tickets: readonly JiraTicket[]): JiraBoardView | undefined {
  const key = view?.confirm?.key
  if (!view || key === undefined || tickets.some(ticket => ticket.key === key)) return view

  return { ...view, confirm: undefined }
}

async function loadTickets($: EngineInterface, isBoardForced = false): Promise<void> {
  const jira = (await read($, jiraState)).settings?.jira
  if (!jira) return
  const request = ++latestListRequest
  await update($, jiraState, value => ({ ...value, isListLoading: true }))
  try {
    const outcome = await searchAssigned($, jira)
    if (request !== latestListRequest) return
    const listedAt = await $.clock.now()

    await update($, jiraState, value => ({
      ...value,
      isListLoading: false,
      ...(outcome.tickets
        ? { tickets: outcome.tickets, listedAt, listError: undefined, view: withoutGoneConfirm(value.view, outcome.tickets) }
        : { listError: outcome.error })
    }))
  } finally {
    if (request === latestListRequest) await update($, jiraState, value => ({ ...value, isListLoading: false }))
  }
  await ensureBoard($, isBoardForced)
}

/** The slow refresh: skipped while the panel is hidden and while the last search is still running. */
async function refreshWhileShown($: EngineInterface): Promise<void> {
  if ((await read($, jiraState)).isListLoading) return
  const hiddenPanes = hiddenPaneIds(await $.ui.panes().catch(() => []))
  if (isShownIn(await read($, layoutAtom), 'jira', hiddenPanes)) await loadTickets($)
}

async function loadIssue($: EngineInterface, key: string): Promise<void> {
  const jira = (await read($, jiraState)).settings?.jira
  if (!jira) return
  const request = ++latestRequest
  await update($, jiraState, value => ({ ...value, isLoading: true, error: undefined }))
  const outcome = await fetchJiraIssue($, jira, key)
  if (request !== latestRequest) return

  await update($, jiraState, value => {
    if (value.ticketKey !== key) return { ...value, isLoading: false }
    const kept = value.issue?.key === key ? value.issue : undefined

    return {
      ...value,
      isLoading: false,
      issue: outcome.issue ?? kept,
      error: outcome.error
    }
  })
}

/** Reads the branch's ticket key and loads its issue when the key changed, or always with `force`. */
async function syncJira($: EngineInterface, { force }: { force: boolean }): Promise<void> {
  const settings = await loadSettings($)
  if (!settings.jira) return
  const key = await readBranchTicketKey($, settings.ticketPattern)
  const previous = await read($, jiraState)
  const hasChanged = !previous.hasCheckedBranch || previous.ticketKey !== key
  if (hasChanged) {
    await update($, jiraState, value => ({
      ...value,
      hasCheckedBranch: true,
      ticketKey: key,
      issue: value.issue?.key === key ? value.issue : undefined,
      error: undefined,
      isLoading: false
    }))
  }
  // A load in flight when the mod reloaded never finished: load again.
  if (key && (force || hasChanged || previous.isLoading)) await loadIssue($, key)
  if (hasChanged) await ensureBoard($, false)
}

/** Reads the saved settings and, until a server and site are chosen, finds out what the person must pick. */
async function ensureConfigured($: EngineInterface): Promise<JiraSettings | undefined> {
  const settings = await loadSettings($)
  if (settings.jira) return settings.jira
  if ((await read($, jiraState)).setup) return undefined
  const servers = await readJiraServers($)
  const [only] = servers
  if (!only) {
    await update($, jiraState, value => ({ ...value, hasNoServer: true }))

    return undefined
  }
  await update($, jiraState, value => ({ ...value, hasNoServer: undefined }))
  if (servers.length === 1) {
    const { sites } = await listSites($, only.name)
    const outcome = settingsFromSetup(withSites(withChosenServer(buildJiraSetup(servers, settings), only.name), sites), settings)
    if (outcome) {
      await saveSettings($, outcome.settings)

      return outcome.settings.jira
    }
    await update($, jiraState, value => ({ ...value, setup: withSites(withChosenServer(buildJiraSetup(servers, settings), only.name), sites) }))

    return undefined
  }
  await update($, jiraState, value => ({ ...value, setup: buildJiraSetup(servers, settings) }))

  return undefined
}

/** Saves the settings to the store and the state; what was read from a changed server or site is dropped. */
async function saveSettings($: EngineInterface, settings: Settings): Promise<void> {
  await $.store.set(SETTINGS_KEY, settings).catch(() => undefined)
  latestRequest += 1
  latestListRequest += 1
  latestBoardRequest += 1
  await update($, jiraState, value => {
    const { setup: _setup, hasNoServer: _hasNoServer, ...rest } = withFreshLoad(value)

    return { ...rest, isSettingsLoaded: true, settings }
  })
}

async function syncAll($: EngineInterface, isForced: boolean): Promise<void> {
  if (!(await ensureConfigured($))) return
  startTickers($)
  await syncJira($, { force: isForced })
  await loadTickets($, isForced)
}

/** The two timers, started once the panel is set up: with no server or no choice yet nothing polls. */
function startTickers($: EngineInterface): void {
  branchTicker ??= $.clock.every(BRANCH_CHECK_MS, () => void syncJira($, { force: false }))
  listTicker ??= $.clock.every(LIST_REFRESH_MS, () => void refreshWhileShown($))
}

/** Opens the link with the first command the machine has: `open` (macOS), `xdg-open` (Linux), `start` (Windows). */
async function openUrl($: EngineInterface, url: string): Promise<void> {
  const failures: string[] = []
  for (const argv of openCommands(url)) {
    try {
      const { exitCode, stderr } = await $.process.run(argv, { timeoutMs: 10_000 })
      if (exitCode === 0) return
      failures.push(stderr.trim() || `${argv[0]} exited with code ${exitCode}`)
    } catch (error) {
      failures.push(errorText(error))
    }
  }
  await notify($, 'error', 'Could not open the browser', { detail: failures.join('\n') })
}

/** The transitions the ticket can take now, read-only. */
async function readTransitions($: EngineInterface, jira: JiraSettings, key: string): Promise<TransitionsOutcome> {
  try {
    const call = transitionsCall(jira.flavour, jira.site.cloudId, key)
    const listed = parseTransitions(await $.mcp.call(jira.server, call.tool, call.args))

    return listed.isOk ? { transitions: listed.transitions } : { error: `${jira.server}: ${listed.error}` }
  } catch (error) {
    return { error: `${jira.server}: ${errorText(error)}` }
  }
}

/** The transition into `lane`; the write is made once, whatever comes back. */
async function transitionTo($: EngineInterface, jira: JiraSettings, ticket: JiraTicket, lane: BoardLane): Promise<MoveOutcome> {
  const { transitions, error } = await readTransitions($, jira, ticket.key)
  if (!transitions) return { error: `Couldn't read its transitions: ${error ?? NO_SERVER_ANSWERED}` }
  const transition = pickTransition(transitions, lane)
  if (!transition) return { error: `Jira offers no move from ${ticket.status ?? 'its status'} to ${laneTitle(lane.name)}` }
  try {
    const call = transitionCall(jira.flavour, jira.site.cloudId, ticket.key, transition.id)
    const result = await $.mcp.call(jira.server, call.tool, call.args)

    return result.isError
      ? { error: `${jira.server}: ${mcpErrorText(result)}`, isWriteSent: true }
      : { moved: transition.toName, isWriteSent: true }
  } catch (caught) {
    return { error: `${jira.server}: ${errorText(caught)}`, isWriteSent: true }
  }
}

/** Reads, read-only, the status a dropped ticket would land in, so the confirm can name it. */
async function previewMove($: EngineInterface, key: string, laneName: string): Promise<void> {
  const request = ++latestPreview
  await update($, jiraState, value => ({ ...value, movePreview: { key, lane: laneName } }))
  const state = await read($, jiraState)
  const lane = buildLanes(state).find(one => one.name === laneName && !one.isOther)
  const jira = state.settings?.jira
  if (!lane || !jira) return
  const { transitions } = await readTransitions($, jira, key)
  const status = transitions ? pickTransition(transitions, lane)?.toName : undefined
  if (request !== latestPreview || !status) return

  await update($, jiraState, value => {
    const isSameDrop = value.movePreview?.key === key && value.movePreview.lane === laneName

    return isSameDrop ? { ...value, movePreview: { key, lane: laneName, status } } : value
  })
}

/** A plain board's confirm about `key` no longer applies once the ticket has been moved, however it was. */
async function dropConfirmFor($: EngineInterface, key: string): Promise<void> {
  await changeView($, view => (view.confirm?.key === key ? { ...view, confirm: undefined } : view))
}

/** Moves the ticket, showing it as moving until the board has reloaded, so it never sits in its old lane looking unmoved. */
async function runMove($: EngineInterface, key: string, laneName: string): Promise<void> {
  await dropConfirmFor($, key)
  const state = await read($, jiraState)
  const lanes = buildLanes(state)
  const lane = lanes.find(one => one.name === laneName && !one.isOther)
  const ticket = lanes.flatMap(one => one.tickets).find(one => one.key === key)
  const failure = `Couldn't move ${key} → ${laneTitle(laneName)}`
  const topic = `move-${key}`
  const jira = state.settings?.jira
  if (!lane || !ticket || !jira) {
    await notify($, 'error', failure, { detail: 'The board changed: refresh and try again', topic })

    return
  }
  if (lane.tickets.some(one => one.key === key)) {
    await notify($, 'info', `${key} is already in ${laneTitle(laneName)}`, { topic })

    return
  }

  await update($, jiraState, value => ({ ...value, pendingMove: { key, lane: laneName }, movePreview: undefined }))
  try {
    const outcome = await transitionTo($, jira, ticket, lane)
    if (outcome.moved) await notify($, 'success', `${key} → ${outcome.moved}`, { topic })
    else await notify($, 'error', failure, { detail: withPermissionHint(outcome.error ?? NO_SERVER_ANSWERED), topic })
    if (!outcome.isWriteSent) return
    await loadTickets($)
    if (key === state.ticketKey) await loadIssue($, key)
  } finally {
    await update($, jiraState, value => ({ ...value, pendingMove: undefined }))
    await dropConfirmFor($, key)
  }
}

/** The one Jira write, after the person confirmed the drop or the lane picked from the menu. One at a time. */
async function moveTicket($: EngineInterface, key: string, laneName: string): Promise<void> {
  if (movingKey !== undefined) {
    await notify($, 'info', `Still moving ${movingKey}`)

    return
  }
  movingKey = key
  try {
    await runMove($, key, laneName)
  } finally {
    movingKey = undefined
  }
}

/** New branch: `! git switch -c <template with the key>` in an empty prompt box, for the person to name and send. */
async function fillBranchCommand($: EngineInterface, key: string): Promise<void> {
  const { text } = await $.prompt.read()
  if (text.trim() !== '') {
    await notify($, 'info', 'Clear the prompt box first')

    return
  }
  // Insert, not replace: a box that read empty but was not keeps the person's draft.
  const { settings } = await read($, jiraState)
  const filled = await $.prompt.fill({ text: buildBranchCommand(key, settings?.branchTemplate), mode: 'insert' })
  if (filled.isFilled) await notify($, 'info', 'Name the branch, then press Enter')
  else await notify($, 'error', "The prompt box didn't take the command")
}

async function insertFullTicket($: EngineInterface, jira: JiraSettings, key: string): Promise<void> {
  const topic = `full-${key}`
  await notify($, 'info', `Reading ${key}…`, { topic })
  const outcome = await fetchFullTicket($, jira, key)
  if (!outcome.ticket) {
    await notify($, 'error', `Couldn't read ${key}`, { detail: withPermissionHint(outcome.error ?? NO_SERVER_ANSWERED), topic })

    return
  }
  const filled = await $.prompt.fill({ text: buildFullTicketMarkdown(outcome.ticket), mode: 'insert' })
  if (filled.isFilled) await notify($, 'success', `${key} added to the prompt`, { topic })
  else await notify($, 'error', "The prompt box didn't take the ticket", { topic })
}

async function runTicketAction($: EngineInterface, action: TicketAction, key: string): Promise<void> {
  const state = await read($, jiraState)
  const ticket = buildLanes(state)
    .flatMap(lane => lane.tickets)
    .find(one => one.key === key)
  if (!ticket) {
    await notify($, 'info', `${key} is no longer on the board`)

    return
  }
  if (action === 'open') {
    await openUrl($, ticket.url)
  } else if (action === 'pr') {
    const badge = prBadgesByKey(await read($, gitgudState))[key]
    if (badge) await openUrl($, badge.url)
    else await notify($, 'info', `No open pull request carries ${key}`)
  } else if (action === 'branch') {
    await fillBranchCommand($, key)
  } else if (action === 'link') {
    const filled = await $.prompt.fill({ text: buildTicketLink(ticket), mode: 'insert' })
    if (!filled.isFilled) await notify($, 'error', "The prompt box didn't take the link")
  } else if (state.settings?.jira) {
    await insertFullTicket($, state.settings.jira, key)
  } else {
    await notify($, 'error', `Couldn't read ${key}`, { detail: 'Jira is not set up yet: press Refresh' })
  }
}

async function changeView($: EngineInterface, change: (view: JiraBoardView, state: JiraState) => JiraBoardView): Promise<void> {
  await update($, jiraState, value => ({ ...value, view: change(value.view ?? {}, value) }))
}

async function changeSetup($: EngineInterface, change: (setup: JiraSetup) => JiraSetup): Promise<void> {
  await update($, jiraState, value => (value.setup ? { ...value, setup: change(value.setup) } : value))
}

/** Reads the chosen server's sites into the form; a failed read keeps the sites the form has. */
async function loadSetupSites($: EngineInterface, server: string): Promise<void> {
  const { sites, error } = await listSites($, server)
  await update($, jiraState, value => {
    if (value.setup?.server !== server) return value
    if (!error) return { ...value, setup: withSites(value.setup, sites) }
    const { isLoadingSites: _loading, ...rest } = value.setup

    return { ...value, setup: { ...rest, note: error } }
  })
}

/** Opens the form filled with what is saved, to change it. */
async function openJiraSetup($: EngineInterface): Promise<void> {
  const settings = await loadSettings($)
  const servers = await readJiraServers($)
  if (servers.length === 0 && !settings.jira) {
    await update($, jiraState, value => ({ ...value, hasNoServer: true }))

    return
  }
  const setup = buildJiraSetup(servers, settings)
  await update($, jiraState, value => ({ ...value, hasNoServer: undefined, setup }))
  if (setup.server) await loadSetupSites($, setup.server)
}

async function chooseSetupServer($: EngineInterface, index: number): Promise<void> {
  const info = (await read($, jiraState)).setup?.servers[index]
  if (!info) return
  await changeSetup($, setup => withChosenServer(setup, info.name))
  await loadSetupSites($, info.name)
}

async function chooseSetupSite($: EngineInterface, index: number): Promise<void> {
  const site = (await read($, jiraState)).setup?.sites[index]
  if (site) await changeSetup($, setup => withChosenSite(setup, site.cloudId))
}

async function saveSetup($: EngineInterface): Promise<void> {
  const { setup } = await read($, jiraState)
  if (!setup) return
  const outcome = settingsFromSetup(setup, await loadSettings($))
  if (!outcome) {
    await changeSetup($, current => ({ ...current, note: 'Pick a server and a site first.' }))

    return
  }
  await saveSettings($, outcome.settings)
  if (outcome.note) await update($, jiraState, value => ({ ...value, setup: { ...setup, note: outcome.note } }))
  await syncAll($, true)
}

/** The panel's hooks: the branch ticket and the assigned list, the board's posts and the plain board's buttons. */
export function registerJiraHooks(on: On): void {
  // A matcher keeps this beside the dock's own session.start hook; the dock is interactive only.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    const boardChoices = parseBoardChoices(await $.store.get(BOARD_STORE_KEY).catch(() => undefined))
    // A reload drops work in flight: a move or a load it left marked would never clear, nor a move left to confirm.
    await update($, jiraState, value => ({
      ...value,
      boardChoices: { ...value.boardChoices, ...boardChoices },
      view: { ...value.view, confirm: undefined },
      pendingMove: undefined,
      movePreview: undefined,
      isListLoading: false,
      isBoardLoading: false
    }))
    await loadSettings($)
    void syncAll($, false)

    return started
  })

  on('ui.press', { plugin: 'claudedockula', element: REFRESH_KEY }, async ($, e) => {
    await syncAll($, true)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: OPEN_KEY }, async ($, e) => {
    const { issue } = await read($, jiraState)
    if (issue) await openUrl($, issue.url)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: SETUP_KEY }, async ($, e) => {
    await openJiraSetup($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^jira-setup-server-\d+$/ }, async ($, e) => {
    await chooseSetupServer($, Number(e.element.slice(SETUP_SERVER_KEY.length)))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^jira-setup-site-\d+$/ }, async ($, e) => {
    await chooseSetupSite($, Number(e.element.slice(SETUP_SITE_KEY.length)))

    return { element: e.element }
  })

  on('ui.input', { plugin: 'claudedockula', element: /^jira-setup-field-(jql|branchTemplate|ticketPattern)$/, kind: 'change' }, async ($, e) => {
    const field = e.element.slice(SETUP_FIELD_KEY.length)
    if (field === 'jql' || field === 'branchTemplate' || field === 'ticketPattern') {
      await changeSetup($, setup => withSetupField(setup, field, e.value))
    }

    return { element: e.element, value: e.value }
  })

  on('ui.press', { plugin: 'claudedockula', element: SAVE_KEY }, async ($, e) => {
    await saveSetup($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: CANCEL_KEY }, async ($, e) => {
    await update($, jiraState, value => {
      const { setup: _setup, ...rest } = value

      return rest
    })

    return { element: e.element }
  })

  // Opening the panel loads the list again when it is older than the slow refresh.
  on('ui.press', { plugin: 'claudedockula', element: /^dock-(tab|main-toggle|\d+-toggle)-jira$/ }, async ($, e, next) => {
    const pressed = await next(e)
    const { listedAt, isListLoading, settings } = await read($, jiraState)
    const now = await $.clock.now()
    if (!settings?.jira) void syncAll($, false)
    else if (!isListLoading && (listedAt === undefined || now - listedAt > LIST_REFRESH_MS)) void loadTickets($)

    return pressed
  })

  on('ui.message', { element: /^jira-board-/ }, async ($, e) => {
    const message = parseBoardMessage(e.data)
    if (message?.type === 'view') {
      await changeView($, view => ({ ...view, toggled: message.toggled, toggledLanes: message.toggledLanes }))
    } else if (message?.type === 'move') {
      void moveTicket($, message.key, message.lane)
    } else if (message?.type === 'preview') {
      void previewMove($, message.key, message.lane)
    } else if (message?.type === 'act') {
      void runTicketAction($, message.action, message.key)
    } else if (message?.type === 'board') {
      void chooseBoard($, message.id)
    }

    return {}
  })

  on('ui.select', { plugin: 'claudedockula', element: PICK_KEY }, async ($, e) => {
    const id = Number(e.value)
    if (Number.isInteger(id)) await chooseBoard($, id)

    return { element: e.element, value: e.value }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^jira-pick-/ }, async ($, e) => {
    if (e.element === PICK_MENU_KEY) {
      await changeView($, view => ({ ...view, isBoardMenuOpen: !view.isBoardMenuOpen }))
    } else {
      const id = Number(e.element.slice(PICK_BOARD_KEY.length))
      if (Number.isInteger(id)) await chooseBoard($, id)
    }

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^jira-lane-/ }, async ($, e) => {
    const name = parseLaneToggle(e.element)
    if (name !== undefined) await changeView($, view => ({ ...view, toggledLanes: toggleIn(view.toggledLanes ?? [], name) }))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^jira-card-/ }, async ($, e) => {
    const key = e.element.slice(CARD_KEY.length)
    await changeView($, view => ({ ...view, toggled: toggleIn(view.toggled ?? [], key) }))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^jira-menu-/ }, async ($, e) => {
    const key = e.element.slice(MENU_KEY.length)
    await changeView($, view => ({ ...view, menuKey: view.menuKey === key ? undefined : key, isMoveMenuOpen: false, confirm: undefined }))

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^jira-act-/ }, async ($, e) => {
    const [, action, key] = ACT_PRESS.exec(e.element) ?? []
    if (action === 'move') {
      await changeView($, view => ({ ...view, isMoveMenuOpen: !view.isMoveMenuOpen }))
    } else if (key && (action === 'branch' || action === 'open' || action === 'pr' || action === 'link' || action === 'full')) {
      await changeView($, view => ({ ...view, menuKey: undefined, isMoveMenuOpen: false }))
      void runTicketAction($, action, key)
    }

    return { element: e.element }
  })

  // A lane picked from the menu asks first, as a drop does: Move or Cancel under the ticket.
  on('ui.press', { plugin: 'claudedockula', element: /^jira-to-/ }, async ($, e) => {
    const target = parseMoveTarget(e.element)
    await changeView($, view => ({ ...view, menuKey: undefined, isMoveMenuOpen: false, ...(target ? { confirm: target } : {}) }))
    if (target) void previewMove($, target.key, target.lane)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claudedockula', element: /^jira-confirm-/ }, async ($, e) => {
    const press = parseConfirmPress(e.element)
    const { confirm } = (await read($, jiraState)).view ?? {}
    const isCurrent = press !== undefined && confirm?.key === press.key && (press.answer === 'cancel' || confirm.lane === press.lane)
    if (!isCurrent) return { element: e.element }
    await changeView($, view => ({ ...view, confirm: undefined }))
    if (press.answer === 'move') void moveTicket($, confirm.key, confirm.lane)

    return { element: e.element }
  })
}

const BAND_STATUS_CELLS = 12

/** `IN REVIEW` → `In Review`; a status already in mixed case, or not in Latin letters, stays as written. */
function shortStatus(status: string): string {
  const isShouting = status === status.toUpperCase() && /[A-Z]/.test(status)
  const cased = isShouting ? status.toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase()) : status

  return fitEnd(cased, BAND_STATUS_CELLS)
}

/** What the band shows for the ticket: its status, `…` while it loads, `–` with none, `set up` before a server and site are chosen. */
export function summarizeJira(state: JiraState): string {
  if (state.isSettingsLoaded && !state.settings?.jira) return state.hasNoServer ? '–' : SET_UP_SUMMARY
  if (!state.hasCheckedBranch) return '…'
  if (!state.ticketKey) return '–'
  const issue = state.issue?.key === state.ticketKey ? state.issue : undefined
  if (issue?.status) return shortStatus(issue.status)

  return state.isLoading ? '…' : '–'
}

/** One line under the board: a dim note, or an error drawn whole (every server's) with the permissions hint under it. */
interface BoardNote {
  text: string
  isError: boolean
}

/**
 * The lines under the board: loading, what failed, and why the lanes are not a board's.
 * @example
 * // before: { tickets: [], ticketKey: 'ABC-9', error: 'atlassian: Not found', boardNote: 'No ABC board reachable: …' }
 * // after:  [{ text: 'Nothing assigned to you.' }, { text: "Couldn't load ABC-9: atlassian: Not found", isError: true }]
 */
function boardNotes(state: JiraState, hasCards: boolean): BoardNote[] {
  const { tickets, isListLoading, listError, ticketKey, isLoading, error, boardNote, boardError, isBoardLoading } = state
  const note = (text: string): BoardNote => ({ text, isError: false })
  const failure = (text: string): BoardNote => ({ text, isError: true })
  const notes: BoardNote[] = []
  if (!tickets && isListLoading) notes.push(note('Loading your tickets…'))
  if (listError) notes.push(failure(`Couldn't load your tickets: ${listError}`))
  if (tickets && !hasCards && !listError) notes.push(note('Nothing assigned to you.'))
  if (ticketKey && isLoading && !hasCards) notes.push(note(`Loading ${ticketKey}…`))
  if (ticketKey && error) notes.push(failure(`Couldn't load ${ticketKey}: ${error}`))
  if (hasCards && isBoardLoading) notes.push(note('Loading the board…'))
  if (hasCards && boardNote) notes.push(note(boardNote))
  if (hasCards && boardError) notes.push(failure(`Couldn't read the board: ${boardError}`))

  return notes
}

function drawBoardNotes(ui: Elements[RenderSurface], notes: readonly BoardNote[]): JSX.Element[] {
  const { Text } = ui

  return notes.flatMap(note => {
    if (!note.isError) return [drawNote(ui, note.text)]
    const line = (
      <Text dimColor wrap="wrap">
        {note.text}
      </Text>
    )

    return isPermissionDenial(note.text) ? [line, drawNote(ui, PERMISSION_HINT)] : [line]
  })
}

/** `▸ ABC-1 ★  Summary cut…`: a ticket's row as a plain Button's label. */
function cardLabel(card: CardView, isOpen: boolean, columns: number): string {
  const head = `${isOpen ? '▾' : '▸'} ${card.key}${card.isBranch ? ' ★' : ''}  `
  const tail = card.pr ? `  ${card.pr}` : ''

  return `${head}${fitEnd(card.summary, Math.max(1, columns - cellWidth(head) - cellWidth(tail)))}${tail}`
}

/**
 * The board picker with no `Client`: a Select where the surface draws one (vscode), Buttons where it has none
 * (mobile). `surface` decides, not the table, which may list elements the surface does not draw.
 */
function drawPlainPicker(ui: Elements[RenderSurface], state: JiraState, columns: number, surface: RenderSurface): JSX.Element | null {
  const options = boardOptions(state)
  if (options.length === 0) return null
  const current = options.find(option => option.id === state.board?.id)
  if (surface !== 'mobile' && 'Select' in ui) {
    const { Select } = ui

    return (
      <Select
        key={PICK_KEY}
        label="Board "
        options={options.map(option => ({ value: String(option.id), label: option.label }))}
        {...(current ? { value: String(current.id) } : {})}
        onSelect={() => undefined}
      />
    )
  }
  const { Box, Button } = ui
  const isOpen = state.view?.isBoardMenuOpen === true && options.length > 1
  const head = fitEnd(`Board  ${current?.label ?? 'Choose a board'}`, Math.max(1, columns - 3))
  let arrow = ''
  if (options.length > 1) arrow = isOpen ? ' ▴' : ' ▾'

  return (
    <Box flexDirection="column">
      <Button key={PICK_MENU_KEY} plain label={`${head}${arrow}`} onPress={() => undefined} />
      {isOpen && (
        <Box flexDirection="column" paddingLeft={4}>
          {options.map(option => (
            <Button
              key={`${PICK_BOARD_KEY}${option.id}`}
              plain
              label={`${option.id === current?.id ? '●' : '○'} ${option.label}`}
              onPress={() => undefined}
            />
          ))}
        </Box>
      )}
    </Box>
  )
}

function drawPlainMenu(ui: Elements[RenderSurface], card: CardView, lanes: readonly LaneView[], view: JiraBoardView): JSX.Element {
  const { Box, Button } = ui
  const noop = () => undefined
  const current = lanes.find(lane => lane.cards.some(one => one.key === card.key))?.name
  const buttons = view.isMoveMenuOpen
    ? [
        <Button key={`${ACT_KEY}move-${card.key}`} plain dimColor label="‹ Back" onPress={noop} />,
        ...lanes.flatMap(lane =>
          !lane.isMoveTarget || lane.name === current
            ? []
            : [<Button key={moveTargetKey(card.key, lane.name)} plain label={`→ ${laneTitle(lane.name)}`} onPress={noop} />]
        )
      ]
    : menuItemsFor(card).map(item => <Button key={`${ACT_KEY}${item.action}-${card.key}`} plain label={item.label} onPress={noop} />)

  return (
    <Box flexDirection="column" paddingLeft={4}>
      {buttons}
    </Box>
  )
}

/** `Move to DONE (COMPLETE)?  [Move] [Cancel]` under the ticket whose lane was picked from the menu. */
function drawPlainConfirm(ui: Elements[RenderSurface], move: JiraMove, state: JiraState): JSX.Element {
  const { Box, Button, Text } = ui

  return (
    <Box flexDirection="row" columnGap={2} paddingLeft={4}>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">{confirmQuestion(move.lane, state.movePreview)}</Text>
      </Box>
      <Box flexDirection="row" columnGap={1} flexShrink={0}>
        <Button key={confirmMoveKey(move)} variant="primary" label="Move" onPress={() => undefined} />
        <Button key={`${CONFIRM_KEY}cancel-${move.key}`} plain dimColor label="Cancel" onPress={() => undefined} />
      </Box>
    </Box>
  )
}

function drawPlainCard(ui: Elements[RenderSurface], card: CardView, lanes: readonly LaneView[], state: JiraState, columns: number) {
  const { Box, Button } = ui
  const view = state.view ?? {}
  const isOpen = isCardOpen(card, view.toggled ?? [])
  const pending = state.pendingMove?.key === card.key ? state.pendingMove : undefined
  const confirm = !pending && view.confirm?.key === card.key ? view.confirm : undefined

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Button key={`${CARD_KEY}${card.key}`} plain label={cardLabel(card, isOpen, columns - 3)} onPress={() => undefined} />
        <Button key={`${MENU_KEY}${card.key}`} plain dimColor label="⋯" onPress={() => undefined} />
      </Box>
      {pending && <Box paddingLeft={4}>{drawNote(ui, `Moving to ${laneTitle(pending.lane)}…`)}</Box>}
      {confirm && drawPlainConfirm(ui, confirm, state)}
      {view.menuKey === card.key && drawPlainMenu(ui, card, lanes, view)}
      {isOpen && (
        <Box flexDirection="column" paddingLeft={4}>
          {drawFieldRows(ui, card.fields)}
          {card.excerpt.map(line => drawNote(ui, line))}
        </Box>
      )}
    </Box>
  )
}

/** The board on a surface with no `Client` (vscode, mobile): the picker, then Buttons to open tickets and lanes and reach the menu. */
function drawPlainBoard(ui: Elements[RenderSurface], state: JiraState, lanes: readonly LaneView[], columns: number, surface: RenderSurface) {
  const { Box, Button } = ui
  const toggledLanes = state.view?.toggledLanes ?? []
  const isShowingCards = (lane: LaneView | undefined) =>
    lane !== undefined && lane.cards.length > 0 && !isLaneCollapsed(lane, toggledLanes)
  const picker = drawPlainPicker(ui, state, columns, surface)

  return (
    <Box flexDirection="column">
      {picker && <Box marginBottom={1}>{picker}</Box>}
      {lanes.map((lane, index) => {
        const isCollapsed = isLaneCollapsed(lane, toggledLanes)
        const label = `${laneTitle(lane.name)}  (${lane.cards.length})${isCollapsed ? '  ▸' : ''}`

        return (
          <Box flexDirection="column" marginTop={isShowingCards(lanes[index - 1]) ? 1 : 0}>
            <Button key={laneToggleKey(lane.name)} plain label={label} onPress={() => undefined} />
            {!isCollapsed && lane.cards.map(card => drawPlainCard(ui, card, lanes, state, columns))}
          </Box>
        )
      })}
    </Box>
  )
}

/** `● name` for the picked entry, `○ name` for the others. */
function choiceLabel(isPicked: boolean, text: string, columns: number): string {
  return fitEnd(`${isPicked ? '●' : '○'} ${text}`, columns)
}

/**
 * The setup form: which server and site when there is a choice, and, once the panel is set up, the ticket query
 * and the branch fields; Input where the surface has one.
 */
function drawSetup(ui: Elements[RenderSurface], state: JiraState, setup: JiraSetup, columns: number): JSX.Element {
  const { Box, Button } = ui
  const isSaved = state.settings?.jira !== undefined
  const hasSites = setup.sites.length > 1
  const hasServers = setup.servers.length > 1
  const intro = hasServers ? 'Pick the Atlassian MCP server to read Jira through.' : 'Pick the Jira site to use.'
  const drawInput = (field: JiraSetupField, label: string, placeholder: string, value: string): JSX.Element | null => {
    if (!('Input' in ui)) return null
    const { Input } = ui

    return (
      <Box flexDirection="column" marginTop={1}>
        {drawNote(ui, label)}
        <Input key={`${SETUP_FIELD_KEY}${field}`} placeholder={placeholder} value={value} submitLabel="done" onSubmit={() => undefined} />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={columns}>
      {(hasServers || hasSites) && drawNote(ui, intro)}
      {hasServers && (
        <Box flexDirection="column" marginTop={1}>
          {setup.servers.map((server, index) => (
            <Button
              key={`${SETUP_SERVER_KEY}${index}`}
              plain
              label={choiceLabel(server.name === setup.server, server.name, columns)}
              onPress={() => undefined}
            />
          ))}
        </Box>
      )}
      {setup.isLoadingSites && <Box marginTop={1}>{drawNote(ui, 'Looking for sites…')}</Box>}
      {hasSites && (
        <Box flexDirection="column" marginTop={1}>
          {drawNote(ui, 'Which site?')}
          {setup.sites.map((site, index) => (
            <Button
              key={`${SETUP_SITE_KEY}${index}`}
              plain
              label={choiceLabel(site.cloudId === setup.siteId, siteLabel(site), columns)}
              onPress={() => undefined}
            />
          ))}
        </Box>
      )}
      {setup.isEditing && drawInput('jql', 'Tickets to list (JQL)', DEFAULT_JQL, setup.jql)}
      {setup.isEditing && drawInput('branchTemplate', 'New branch name ({key} is the ticket)', DEFAULT_BRANCH_TEMPLATE, setup.branchTemplate)}
      {setup.isEditing && drawInput('ticketPattern', 'Ticket pattern in a branch name', DEFAULT_TICKET_PATTERN, setup.ticketPattern)}
      {setup.isEditing && !('Input' in ui) && <Box marginTop={1}>{drawNote(ui, 'Edit the query and branch names from the terminal.')}</Box>}
      {setup.note !== undefined && <Box marginTop={1}>{drawNote(ui, setup.note)}</Box>}
      {drawActions(ui, [
        <Button key={SAVE_KEY} variant="primary" label="Save" onPress={() => undefined} />,
        ...(isSaved ? [<Button key={CANCEL_KEY} plain dimColor label="Cancel" onPress={() => undefined} />] : [])
      ])}
    </Box>
  )
}

/** What the card says before the panel is set up: reading settings, no server, or looking for one. */
function drawNotConfigured(ui: Elements[RenderSurface], state: JiraState): JSX.Element {
  const { Box, Button } = ui
  let note = 'Looking for an Atlassian MCP server…'
  if (!state.isSettingsLoaded) note = 'Reading settings…'
  else if (state.hasNoServer) note = 'Connect an Atlassian MCP server to use this panel'

  return (
    <Box flexDirection="column">
      {drawNote(ui, note)}
      {drawActions(ui, [<Button key={REFRESH_KEY} plain dimColor label="↻ Refresh" onPress={() => undefined} />])}
    </Box>
  )
}

/**
 * The card's body, from its stored state: the board picker and the lanes (a draggable `Client` on the terminal
 * and desktop, a Select and Buttons elsewhere), the notes and errors, then Refresh, Open for the branch's
 * ticket and ⚙ for the settings. Before the panel is set up the card asks instead. `surface` decides, not the
 * table: vscode's table carries a `Client` it does not draw. `dockId` keys the board per dock.
 */
export function drawJira(
  ui: Elements[RenderSurface],
  state: JiraState,
  columns: number,
  surface: RenderSurface,
  dockId: string,
  prBadges: Record<string, PrBadge> = {}
): JSX.Element {
  const { Box, Button } = ui
  if (state.setup) return drawSetup(ui, state, state.setup, columns)
  if (!state.settings?.jira) return drawNotConfigured(ui, state)
  const lanes = laneViews(state, prBadges)
  const hasCards = lanes.some(lane => lane.cards.length > 0)
  const notes = boardNotes(state, hasCards)
  const branchIssue = state.issue?.key === state.ticketKey ? state.issue : undefined
  const drawsClient = surface === 'terminal' || surface === 'desktop'
  let board: JSX.Element | null = null
  if (hasCards && drawsClient && 'Client' in ui) {
    const { Client } = ui
    board = <Client key={`${BOARD_KEY}${dockId}`} module="./jira/JiraBoard.tsx" props={buildBoardProps(state, columns, prBadges)} width={columns} />
  } else if (hasCards) {
    board = drawPlainBoard(ui, state, lanes, columns, surface)
  }

  return (
    <Box flexDirection="column">
      {board}
      {notes.length > 0 && (
        <Box flexDirection="column" marginTop={board ? 1 : 0}>
          {drawBoardNotes(ui, notes)}
        </Box>
      )}
      {drawActions(ui, [
        <Button key={REFRESH_KEY} plain dimColor label="↻ Refresh" onPress={() => undefined} />,
        ...(branchIssue
          ? [<Button key={OPEN_KEY} plain dimColor label={`↗ Open ${branchIssue.key}`} onPress={() => undefined} />]
          : []),
        <Button key={SETUP_KEY} plain dimColor label="⚙" onPress={() => undefined} />
      ])}
    </Box>
  )
}

export const jiraPanel: DockPanel = {
  id: 'jira',
  title: 'Jira · assigned to me',
  icon: '🎫',
  description: 'Your Jira tickets in the board’s lanes: drag to move, right-click or ⋯ for more',
  isBuiltIn: true,
  revision: 2,
  whatsNew: 'Cards show their pull request’s CI and review state'
}
