// --- dock (core) ---
/** Where a dock sits: a pane of its own on the right, or inside the band above the prompt (one dock at most). */
export type DockPosition = 'right' | 'bottom'

/** How a view lays its cards out: stacked full width, or side by side wrapping to the next row. */
export type DockDirection = 'column' | 'row'

/** A card's width in a row view: sharing the row, or a fraction of the dock's width. */
export type CardWidth = 'auto' | 'third' | 'half' | 'full'

/** One tab of a dock: a set of panels and how they are laid out. A panel may show in several views and docks. */
export interface DockViewTab {
  /** `1`, `2`…, unique within its dock. */
  id: string
  /** Set once the person renamed it; absent, the name comes from its one panel or its place (`View 2`). */
  name?: string
  /** The panel ids this view shows, in order. */
  panels: string[]
  minimized: string[]
  direction: DockDirection
  /** By panel id; a panel missing here is `auto`. Used in a row view only. */
  widths: Record<string, CardWidth>
}

/**
 * One dock: tabs of views of the shared panels, which may show in several docks at once. A panel's state is its
 * own, never the dock's.
 */
export interface DockView {
  /** `main` for the first dock, then `2`, `3`…; a right dock's pane is `claudedockula` (main) or `claudedockula-<id>`. */
  id: string
  name: string
  position: DockPosition
  /** One at least. */
  views: DockViewTab[]
  activeViewId: string
  /** A right dock: its pane is open. The bottom dock: it shows in the band. */
  isOpen: boolean
  /** The active view's cards, or its Manage card. */
  view: 'panels' | 'manage'
  /** The panel a band tab last brought into view here: pressing that tab again closes the dock. */
  focused?: string
  /** The ➕ menu (a new dock on the right or at the bottom) is open on the dock's top row. */
  isMenuOpen?: boolean
  /** The ▤ Layout menu of the active view is open. */
  isLayoutOpen?: boolean
  /** The bottom dock's height in rows, as the person dragged it; absent, 12 (held to what the band leaves). */
  rows?: number
  /** The id the dock's next new view takes: it only grows, so no id comes back once its view is removed. */
  nextViewId?: number
  /** Higher for a dock used more recently: a band tab opens its panel in the most recent open dock holding it. */
  usedAt: number
}

/** Every dock; persisted across sessions. */
export interface DockLayout {
  docks: DockView[]
  /** The dock `/dock` toggles, and where a band tab shows a panel no open dock holds. */
  lastDockId: string
  /** Every panel id the layout has placed: a panel missing here is new and joins the last used dock once. */
  known: string[]
}

export type DockRefresh = 'manual' | '30s' | '5m'

/** The "New panel" form as typed so far. `connector` is `mcp:<server>`, `shell`, `skill` or `other`. */
export interface AddPanelDraft {
  name?: string
  icon?: string
  shows?: string
  actions?: string
  connector?: string
  refresh?: DockRefresh
  notes?: string
}

export type NoticeTone = 'error' | 'info' | 'success'

/** One notice above the band's tabs: a row the person expands with a click and closes with ✕. */
export interface DockNotice {
  id: number
  tone: NoticeTone
  /** The row's text: `Couldn't move ABC-101 → IN REVIEW`. */
  title: string
  /** What the row expands to, one line per `\n`. */
  detail?: string
  /** What it is about (`check-types`): a newer notice on the same topic replaces it. */
  topic?: string
  /** When an info or success notice clears itself; an error has none and stays until dismissed. */
  expiresAt?: number
  isExpanded?: boolean
  /** A Button on the row, answered by the writer's own `ui.press` hook on `key`. */
  action?: DockNoticeAction
}

/** A notice's one action: `{ key: 'github-review-act-open-o~r~12', label: 'Open' }`. */
export interface DockNoticeAction {
  key: string
  label: string
}

/** The New panel pane's form, set each time the pane opens. */
export interface AddPanelForm {
  /** The draft as the pane opened: the fields start from it and keep the person's typing after. */
  seed: AddPanelDraft
  /** The MCP servers the model can reach, read once as the pane opens. */
  servers: string[]
}

// --- branch panel ---
export interface BranchFile {
  /** Two columns as `git status -s` prints them: staged, then working tree; `??` untracked. */
  code: string
  path: string
}

export interface BranchStatus {
  /** Undefined while HEAD is detached. */
  branch?: string
  /** Short id of the commit HEAD points at; undefined before the first commit. */
  commit?: string
  /** The ticket key in the branch name: `ABC-101/add-export-button` → `ABC-101`. */
  ticket?: string
  upstream?: string
  /** Commits ahead of and behind the upstream; undefined without one or when it is gone. */
  ahead?: number
  behind?: number
  staged: number
  modified: number
  untracked: number
  conflicted: number
  /** Changed paths in git's order; the stored status keeps only the first few. */
  files: BranchFile[]
  /** How many paths changed in all. */
  fileCount: number
}

export interface BranchState {
  status?: BranchStatus
  /** One line saying why there is no status: not a git repository, or git failed. */
  error?: string
  isRefreshing?: boolean
}

// --- settings (saved by the plugin in `$.store`, asked for when a panel needs them) ---
/** One command the Checks panel runs, saved per repo. `argv` runs with no shell. */
export interface CheckSetting {
  /** Lowercase letters, digits and `-`; it names the Run button (`checks-run-<id>`). */
  id: string
  name: string
  argv: string[]
}

/** Saved under `settings:<repo root>`. */
export interface RepoSettings {
  /** Absent: not set up yet. An empty list: set up with no checks. */
  checks?: CheckSetting[]
}

/**
 * How a Jira MCP server is spoken to. `standard` takes field lists on its search and read tools and has its own
 * transition tools; `gateway` (it exposes `executeRead`) reads boards and transitions through `executeRead`.
 */
export type JiraFlavour = 'standard' | 'gateway'

/** A connected MCP server that exposes Jira tools. */
export interface JiraServerInfo {
  /** As `$.mcp.call` takes it: the tool-name spelling (`claude_ai_Atlassian_MCP`). */
  name: string
  flavour: JiraFlavour
}

export interface JiraSettings {
  server: string
  flavour: JiraFlavour
  /** The `gateway` server the boards are read from; absent, the lanes are the statuses. */
  boardServer?: string
  site: JiraSite
  /** What the person typed; absent, the default query. */
  jql?: string
}

/** Saved under `settings`. */
export interface Settings {
  jira?: JiraSettings
  /** What follows `git switch -c`; `{key}` stands for the ticket. */
  branchTemplate?: string
  /** A regular expression source finding the ticket key in a branch name. */
  ticketPattern?: string
}

// --- checks panel ---
export type CheckStatus = 'running' | 'passed' | 'failed'

/** The last run of one check; a check never run has none. */
export interface CheckRun {
  status: CheckStatus
  startedAt?: number
  durationMs?: number
  /** "197 errors", "2 tests failed", "exit code 1". */
  problem?: string
  /** The first meaningful lines of a failed run. */
  lines?: string[]
}

/** The Checks card's setup form: the commands on offer and which are ticked. */
export interface ChecksSetup {
  options: CheckSetting[]
  /** Ids of the ticked options. */
  picked: string[]
  /** The package manager the suggestions run through, when a package.json was read. */
  manager?: string
}

/** Every field optional, so the dock's atom starts from `{}`. */
export interface ChecksState {
  /** The repo's settings were read. */
  isLoaded?: boolean
  /** The repo the settings belong to. */
  repo?: string
  /** The saved checks; absent until the person sets them up. */
  checks?: CheckSetting[]
  /** The setup form, while it is open. */
  setup?: ChecksSetup
  /** By check id. */
  runs?: Record<string, CheckRun>
  /** Ids of failed checks whose lines are shown. */
  expanded?: string[]
  /** The clock's last tick while a check runs, for the elapsed time. */
  now?: number
  isRunningAll?: boolean
}

// --- activity panel ---
export type ActivityCallStatus = 'running' | 'done' | 'error' | 'stopped'

export interface ActivityCall {
  /** The call's tool_use_id. */
  id: string
  /** The tool's name, or the MCP server's for an MCP tool. */
  name: string
  summary: string
  status: ActivityCallStatus
  /** The subagent loop the call ran in; absent on the main loop. */
  agentId?: string
}

export interface ActivityFile {
  /** Absolute, as the tool received it. */
  path: string
  edits: number
}

/** Newest first in every list. */
export interface ActivityState {
  calls: ActivityCall[]
  files: ActivityFile[]
  /** The session's cwd at the last call, which paths are shown relative to. */
  cwd?: string
}

// --- jira panel ---
export interface JiraIssue {
  key: string
  summary: string
  status?: string
  assignee?: string
  priority?: string
  type?: string
  /** Markdown: the acceptance criteria when the description has them, else the description. */
  excerpt?: string
  isAcceptanceCriteria: boolean
  /** The issue's page on the Jira site. */
  url: string
}

export interface JiraSite {
  cloudId: string
  url: string
  name?: string
}

/** One ticket of the assigned list, as its lane row and its details show it. */
export interface JiraTicket {
  key: string
  summary: string
  status?: string
  statusId?: string
  /** Jira's status category: `new`, `indeterminate` or `done`. */
  statusCategory?: string
  priority?: string
  type?: string
  /** ISO time of the ticket's last update. */
  updated?: string
  /** The description's first lines of prose, markdown dropped. */
  excerpt?: string[]
  url: string
}

export interface JiraBoardStatus {
  id?: string
  name: string
  category?: string
}

/** One column of a Jira board and the statuses it holds, in the board's order. */
export interface JiraBoardColumn {
  name: string
  statuses: JiraBoardStatus[]
}

export interface JiraBoard {
  id: number
  name: string
  projectKey: string
  columns: JiraBoardColumn[]
}

/** One of a project's boards, as the board picker lists it. */
export interface JiraBoardSummary {
  id: number
  name: string
  /** `kanban` or `scrum`. */
  type?: string
}

/** View choices the board keeps across redraws and reloads, on every surface. */
export interface JiraBoardView {
  /** Tickets opened or closed against their default: the branch's ticket starts open, the rest closed. */
  toggled?: string[]
  /** Lanes opened or collapsed against their default: the last lane starts collapsed. */
  toggledLanes?: string[]
  /** The ticket whose menu is open, on a surface with no `Client` (vscode, mobile). */
  menuKey?: string
  isMoveMenuOpen?: boolean
  /** The lane picked from the menu, waiting for Move or Cancel, on a surface with no `Client`. */
  confirm?: JiraMove
  /** The board picker's list, on a surface with neither `Client` nor `Select` (mobile). */
  isBoardMenuOpen?: boolean
}

/** A ticket on its way to a lane: the transition is in flight. */
export interface JiraMove {
  key: string
  lane: string
}

/** The status a dropped ticket would land in, read from its transitions before the person confirms. */
export interface JiraMovePreview extends JiraMove {
  status?: string
}

/** The Jira card's setup form: what the person picks and types before Save. */
export interface JiraSetup {
  /** The connected servers that expose Jira tools. */
  servers: JiraServerInfo[]
  server?: string
  /** The sites the chosen server lists. */
  sites: JiraSite[]
  siteId?: string
  isLoadingSites?: boolean
  /** The three fields below are the typed text; empty means the default. */
  jql: string
  branchTemplate: string
  ticketPattern: string
  /** Opened with ⚙ on a set up panel: the query and branch fields show. */
  isEditing?: boolean
  /** A dim line under the form. */
  note?: string
}

export interface JiraState {
  /** The saved settings were read. */
  isSettingsLoaded?: boolean
  settings?: Settings
  /** No connected MCP server exposes Jira tools. */
  hasNoServer?: boolean
  setup?: JiraSetup
  hasCheckedBranch?: boolean
  /** The ticket key in the current branch's name; absent when it has none. */
  ticketKey?: string
  /** The branch's ticket, read on its own: the band shows its status. */
  issue?: JiraIssue
  isLoading?: boolean
  error?: string
  /** The tickets assigned to the person, newest update first. */
  tickets?: JiraTicket[]
  isListLoading?: boolean
  listError?: string
  /** When the list last loaded, in ms; "updated 3h ago" counts from it. */
  listedAt?: number
  /** The board whose columns are the lanes; absent, the lanes are the statuses present. */
  board?: JiraBoard
  /** The project whose boards were last listed; left unset by a failed lookup, so the next refresh tries again. */
  boardProject?: string
  /** The project's boards, for the picker. */
  boards?: JiraBoardSummary[]
  /** The project `boards` were listed for: a pick is remembered under it, whatever the branch is now. */
  boardsProject?: string
  /** The board the person picked, by project key; also kept in the store across sessions. */
  boardChoices?: Record<string, number>
  isBoardLoading?: boolean
  /** Why the lanes are not a board's columns: one dim line. */
  boardNote?: string
  /** What failed while looking for the board, every server's error. */
  boardError?: string
  view?: JiraBoardView
  pendingMove?: JiraMove
  movePreview?: JiraMovePreview
}

// --- slacker panel ---
/** Why a message is in the feed: it @s you, a DM, a reply in a thread you are in, a watched word, a search hit. */
export type SlackerKind = 'mention' | 'dm' | 'thread' | 'keyword' | 'search'

/** The feed's filter chips. */
export type SlackerFilter = 'all' | 'mention' | 'dm' | 'thread' | 'keyword'

/** One Slack message as the feed lists it. */
export interface SlackerItem {
  /** `<channelId>:<ts>`. */
  id: string
  kind: SlackerKind
  channelId: string
  /** `#dev-app`, or the other people of a DM. */
  where: string
  isDm: boolean
  author: string
  authorId: string
  /** Slack's message ts: seconds since the epoch with a fraction, as text. */
  ts: string
  /** The thread's parent ts, when the message is in a thread. */
  threadTs?: string
  replyCount?: number
  text: string
  permalink: string
  /** How many messages a DM or a thread folded into this one stands for. */
  count?: number
  /** The watched word that found it. */
  keyword?: string
}

/** One message of a thread or a DM conversation. */
export interface SlackerMessage {
  author: string
  authorId: string
  ts: string
  text: string
}

/** The thread (or, for a DM, the recent conversation) shown under an item. */
export interface SlackerThread {
  itemId: string
  isLoading?: boolean
  error?: string
  /** The thread's first message; none for a DM conversation. */
  parent?: SlackerMessage
  /** Oldest first. */
  replies?: SlackerMessage[]
}

export type SlackerDraftPhase = 'review' | 'polishing' | 'sending' | 'sent' | 'failed'

/** A reply waiting for its Send, under the item it answers. */
export interface SlackerDraft {
  itemId: string
  text: string
  phase: SlackerDraftPhase
  error?: string
  /** The text before the last polish or edit, for Undo. */
  previous?: string
}

/** A Slack-wide search the person ran from the search box. */
export interface SlackerSearch {
  query: string
  items?: SlackerItem[]
  isLoading?: boolean
  error?: string
}

export interface SlackerState {
  me?: { id: string; name: string }
  items?: SlackerItem[]
  isLoading?: boolean
  /** One line per source that failed at the last refresh (`mentions: …`). */
  errors?: string[]
  /** Claude Code refused a call at the last refresh, so the 30 s refresh waits for ↻ Refresh or an open. */
  isRefused?: boolean
  /** The claude.ai Slack connector is not in this session (see /mcp), so the 30 s refresh waits too. */
  isDisconnected?: boolean
  /** When the feed was last read, ms. */
  updatedAt?: number
  /** ms: messages newer than this count on the band. */
  seenAt?: number
  /** ms: messages newer than this carry the unseen dot (the seen time before the panel was last opened). */
  dotsSince?: number
  keywords?: string[]
  filter?: SlackerFilter
  /** What is typed in the search box: it filters the feed. */
  query?: string
  search?: SlackerSearch
  /** The expanded item. */
  openId?: string
  /** The item whose menu is open. */
  menuId?: string
  thread?: SlackerThread
  draft?: SlackerDraft
  /** How many items the list shows. */
  shown?: number
}

// --- github panel ---
/** A PR's combined CI: GitHub's rollup, folded. */
export type GhCiState = 'pass' | 'fail' | 'pending' | 'none'
/** A PR's review decision, folded; `none` when GitHub has no decision. */
export type GhReviewState = 'approved' | 'changes' | 'required' | 'none'
export type GhView = 'review' | 'mine' | 'issues' | 'search'
/** `repos`: the session's repo plus the added ones; `all`: every repo the account reaches. */
export type GhScope = 'repos' | 'all'
/** Whether `gh` can be used: `missing` (not installed), `logged-out` (`gh auth status` failed). */
export type GhHealth = 'ok' | 'missing' | 'logged-out'

export interface GhRepo {
  /** `owner/name`. */
  nameWithOwner: string
  url: string
  defaultBranch?: string
}

/** One PR or issue as a list row shows it. */
export interface GhItem {
  /** `owner/name#123`: unique across repos. */
  id: string
  kind: 'pr' | 'issue'
  repo: string
  number: number
  title: string
  url: string
  author: string
  /** ISO. */
  updatedAt: string
  comments: number
  /** The body's first ~600 characters, plain text: the one-liner's input. */
  excerpt?: string
  labels?: string[]
  isDraft?: boolean
  headRef?: string
  baseRef?: string
  headSha?: string
  ci?: GhCiState
  review?: GhReviewState
  /** The latest approving review's node id: the approved alert keys on it, so a push does not raise it again. */
  approvalId?: string
  /** The latest change-requesting review's node id: the changes-requested alert keys on it, so another reviewer's approval does not raise it again. */
  changeRequestId?: string
  /** The review request reached the person only through a team. */
  isTeamRequest?: boolean
  /** The Jira key in the title or branch. */
  ticket?: string
}

export type GhCheckState = 'pass' | 'fail' | 'pending' | 'skipped' | 'cancelled'

export interface GhCheck {
  name: string
  workflow?: string
  state: GhCheckState
  link?: string
  /** From an Actions job link; absent for an outside check. */
  runId?: number
  jobId?: number
  description?: string
  /** A failed job: the log lines that say why, cleaned. */
  why?: string[]
  /** A failed job: Haiku's one line on why. */
  whyLine?: string
  isLogLoading?: boolean
}

/** What an opened PR row loads. */
export interface GhDetail {
  checks?: GhCheck[]
  isLoading?: boolean
  error?: string
  loadedAt?: number
}

/** Another open PR touching files the person changed locally. */
export interface GhOverlap {
  /** The other PR's item id. */
  prId: string
  number: number
  repo: string
  title: string
  author: string
  url: string
  headRef: string
  /** The shared paths, sorted. */
  files: string[]
  /** GitHub listed only the PR's first 100 files. */
  isPartial?: boolean
}

/** `queued`: reading the PR and making its copy; `running`: the reviewer session works. */
export type GhJobPhase = 'queued' | 'running' | 'done' | 'failed'

/** The model the background reviewer runs on. */
export type GhReviewModel = 'sonnet' | 'opus'

/** What tells the person a background review finished: its notice, plus the bell or a system notification. */
export type GhReviewDone = 'notice' | 'bell' | 'notify'

/** A permission rule Claude Code offered with an ask, as its PermissionRequest hook received it. */
export interface GhAskRule {
  toolName: string
  ruleContent?: string
}

/** One permission ask the reviewer relayed to the panel: it waits for Allow once, Allow for this review or Deny. */
export interface GhReviewAsk {
  /** `<epoch seconds>-<pid>`, from the relay's file name. */
  id: string
  tool: string
  /** What it wants, in plain words: `fetch https://docs.python.org/3/`. */
  what: string
  /** When the panel first saw it: the relay denies it 10 minutes on. */
  askedAt: number
  /** What Allow … for this review adds for the rest of the review, when Claude Code offered a rule. */
  rules?: GhAskRule[]
  /** `docs.python.org`: what that button names. */
  ruleLabel?: string
  /** `timeout`: nobody answered in 10 minutes and the relay denied it. */
  answer?: 'once' | 'review' | 'deny' | 'timeout'
  answeredAt?: number
}

/** A background review of one PR, run by a headless Claude Code session the panel starts. */
export interface GhReviewJob {
  itemId: string
  title: string
  phase: GhJobPhase
  startedAt: number
  endedAt?: number
  /** The written review, once done. */
  path?: string
  error?: string
  /** The review's temporary folder (the copy and the asks); deleted when the review ends. */
  workDir?: string
  /** The readable log, beside the review file. */
  logPath?: string
  /** The raw stream-json lines, beside the review file. */
  streamPath?: string
  /** The reviewer read a clean copy of the PR at this commit. */
  copySha?: string
  /** Why it had no copy and reviewed from the diff and the discussion only. */
  noCopy?: string
  model?: GhReviewModel
  /** What the reviewer does now, in plain words: `reading src/a.ts`, `fetching docs.python.org`. */
  activity?: string
  /** How many tool calls it made. */
  steps?: number
  /** The permission asks it relayed, oldest first. */
  asks?: GhReviewAsk[]
}

/** `review-log`: a background review's readable log, opened from the review's row. */
export type GhDocKind = 'review' | 'pr-description' | 'commit-summary' | 'review-log'

/** A file the panel wrote, linked from the card. */
export interface GhDocLink {
  kind: GhDocKind
  title: string
  /** Absolute. */
  path: string
  createdAt: number
  itemId?: string
}

export interface GhGenJob {
  phase: 'running' | 'done' | 'failed'
  startedAt: number
  error?: string
}

/** Saved globally in the store under `github:settings`. */
export interface GhSettings {
  /** `owner/name` of repos added with ➕, shown in every session. */
  extraRepos?: string[]
  scope?: GhScope
  /** The poll while the card is shown, in seconds; absent, 90. */
  pollSeconds?: number
  /** Haiku one-liners and CI "why" lines; absent, on. */
  isHaikuOn?: boolean
  /** What tells the person a background review finished; absent, its notice only. */
  reviewDone?: GhReviewDone
  /** The background reviewer's model; absent, Sonnet. */
  reviewModel?: GhReviewModel
  /** The background reviewer may use WebFetch and WebSearch; absent, on. */
  isReviewWebOn?: boolean
}

export interface GhSearch {
  query: string
  items?: GhItem[]
  isLoading?: boolean
  error?: string
}

/** View choices kept across redraws and reloads. */
export interface GhViewState {
  view?: GhView
  /** The expanded row's item id. */
  openId?: string
  /** The row whose ⋯ menu is open, on a surface with no `Client`. */
  menuId?: string
  /** Rows shown per list; absent, 8. */
  shown?: number
  isSettingsOpen?: boolean
  isOverlapOpen?: boolean
  /** The background review whose action menu is open, by item id. */
  reviewMenu?: string
  /** The overlap PR whose action menu is open, by number. */
  overlapMenu?: number
}

export interface GithubState {
  health?: GhHealth
  /** Why `gh` failed, one line. */
  healthError?: string
  /** Homebrew is at one of its usual paths: the missing-gh card offers `brew install gh`. */
  hasBrew?: boolean
  login?: string
  isSettingsLoaded?: boolean
  settings?: GhSettings
  /** The session's repo; null when its folder is not a GitHub repo. */
  currentRepo?: GhRepo | null
  /** The checked-out branch, for "this branch" actions and excluding its own PR. */
  branch?: string
  review?: GhItem[]
  mine?: GhItem[]
  issues?: GhItem[]
  search?: GhSearch
  isLoading?: boolean
  error?: string
  updatedAt?: number
  /** Consecutive failed polls, for the backoff. */
  failures?: number
  /** ms epoch: no poll before this (rate limit or backoff). */
  pausedUntil?: number
  rateRemaining?: number
  /** By item id. */
  details?: Record<string, GhDetail>
  /** Haiku one-liners by item id, for the rows drawn. */
  oneLiners?: Record<string, string>
  /** Jira status by ticket key. */
  jiraStatus?: Record<string, string>
  isJiraRefused?: boolean
  /** The slash command "Review here" fills (`pr-review`, `anthropic-skills:pr-review`); null: none found. */
  reviewCommand?: string | null
  /** Other optional commands found: `pr-summary`, `commit-summary`. */
  commands?: string[]
  overlaps?: GhOverlap[]
  overlapCheckedAt?: number
  overlapError?: string
  /** The base branch the local changes were compared with (`develop` for `origin/develop`). */
  overlapBase?: string
  /** How many paths the person changed locally (uncommitted + committed since base). */
  localChangeCount?: number
  /** By item id. */
  reviews?: Record<string, GhReviewJob>
  /** Newest first, at most 8 shown. */
  docs?: GhDocLink[]
  gen?: Partial<Record<'pr-description' | 'commit-summary', GhGenJob>>
  ui?: GhViewState
  /** The clock's last tick while a background job runs, for elapsed times. */
  now?: number
  /** Flips every second while a review's ask waits for the person: its warning and the band tab alternate. */
  blink?: boolean
  /** The person's notification channel (`/config`), read as ⚙ opens: what "When it finishes" can offer. */
  notifyChannel?: string
}

/** One hunk of a diff the inspector draws, cleaned for `Code`. */
export interface GhDiffHunk {
  text: string
  /** It changes base lines the other side also changes. */
  isOverlap?: boolean
}

/** One side of the overlap inspector: the hunks that fit, how many were cut, or why there are none. */
export interface GhDiffSide {
  hunks?: GhDiffHunk[]
  /** Hunks left out to fit. */
  cut?: number
  /** Why there is no diff, or what it is (untracked, binary, cut). */
  note?: string
}

/** The overlap inspector: one file both the working tree and another open PR change. */
export interface GhDiffInspect {
  /** When it was opened: a load that lands after another file opened (or the pane closed) is dropped. */
  openedAt: number
  number: number
  repo: string
  title: string
  author: string
  headRef: string
  url: string
  path: string
  /** `develop` for `origin/develop`. */
  base?: string
  /** The local merge-base, short. */
  mergeBase?: string
  mine?: GhDiffSide
  theirs?: GhDiffSide
  /** `2 hunks overlap · base lines 120–140`. */
  overlap?: string
  /** The file differs between the PR's merge-base and the local one, so line numbers are approximate. */
  isApproximate?: boolean
  /** The PR's base could not be compared with the local one (its head isn't fetched). */
  isBaseUnknown?: boolean
  isLoading?: boolean
  error?: string
}

/** The doc pane (`claudedockula-doc`): one generated file shown whole, or the overlap inspector (`diff`). */
export interface GithubDocState {
  diff?: GhDiffInspect
  path?: string
  title?: string
  text?: string
  isLoading?: boolean
  error?: string
  /** The text was cut to fit; the file is whole. */
  isTruncated?: boolean
}

// --- user panels (the dockula noun) ---
/** A user panel as a panel pack lists it in `dockula.panels`. */
export interface DockulaPanelInfo {
  id: string
  title: string
  icon: string
  description: string
}

/** One run of text on a canvas row; a `key` makes it a target the canvas hit-tests. */
export interface DockulaSpan {
  text: string
  key?: string
  color?: string
  weight?: 'regular' | 'medium' | 'semibold' | 'bold'
  dim?: boolean
  inverse?: boolean
  /** The span can be picked up and dragged. */
  drag?: boolean
  /** The span takes drops. */
  drop?: boolean
}

/** One terminal row of a user panel's canvas. */
export type DockulaLine = DockulaSpan[]

export interface DockulaDrawArgs {
  panel: string
  surface: string
  columns: number
  dockId: string
}

/**
 * What the canvas saw, already hit-tested: a click, a drop, a right-click or a key. `key` is the span under the
 * pointer (or the focused span for a key), `from` the span a drag started on, `name` the key pressed.
 */
export interface DockulaEvent {
  type: 'click' | 'drop' | 'context' | 'key'
  key?: string
  from?: string
  x: number
  y: number
  button?: 'left' | 'middle' | 'right'
  name?: string
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
}

export interface DockulaInput {
  panel: string
  dockId: string
  surface: string
  event: DockulaEvent
}

/** `$.dockula`: the dock's extension point. Every method is an event a panel pack hooks with `{ panel: '<id>' }`. */
export interface Dockula {
  /** A fold: each pack appends its panels to what `next(e)` answered. */
  panels: () => Promise<DockulaPanelInfo[]>
  /** The panel's rows at the card's inner width; null draws a dim line. */
  draw: (args: DockulaDrawArgs) => Promise<DockulaLine[] | null>
  /** The band text after the emoji. */
  summary: (args: { panel: string }) => Promise<string>
  /** One canvas event; the dock redraws the panel when the hooks answered. */
  input: (args: DockulaInput) => Promise<{ handled: boolean }>
  /** Asks the dock to read the packs' panels again and redraw them, once this call has returned. */
  changed: () => Promise<{ isQueued: boolean }>
}

declare module 'claude-code' {
  interface EngineInterface {
    dockula: Dockula
  }
  interface PluginState {
    'claudedockula': {
      layout: DockLayout
      addDraft: AddPanelDraft
      addForm: AddPanelForm
      notices: DockNotice[]
      /** How many rows each dock's cards are scrolled under the bottom dock's height, by dock id; absent, at the top. */
      dockScroll: Record<string, number>
      /** The bottom dock's cards' height as the probe beside them measured it, by `<surface>:<dockId>`. */
      dockMeasure: Record<string, number>
      branch: BranchState
      checks: ChecksState
      activity: ActivityState
      jira: JiraState
      slacker: SlackerState
      github: GithubState
      githubDoc: GithubDocState
      /** The panels the packs listed at the last `dockula.panels` read. */
      userPanels: DockulaPanelInfo[]
      /** Bumped when a pack's panel changed: every dock that draws a user panel reads it. */
      userRevision: number
    }
  }
}
