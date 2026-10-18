import type { Elements, RenderSurface, ThemeKey } from 'claude-code'

import type { GhDocKind, GhOverlap, GhReviewAsk, GhReviewJob, GhReviewModel, GhView, GithubState } from '../../../types'
import { TONE, cellWidth, drawActions, drawHeading, drawMore, drawNote, fitEnd, fitStart, padCells, splitPath, type DockElements } from '../../dock/ui'
import { KEY, WORK_ACTIONS, actKey, askKey, encodeItemId, encodeRepoName, type GhAction } from './model'
import { drawable } from './parse'
import { REVIEW_MODELS, askDeadline, doneChoices, isAskPending, modelName, wantsNotification } from './review'
import {
  DETAIL_INDENT,
  DETAIL_LABEL_CELLS,
  ageSince,
  buildListProps,
  isReviewRunning,
  listItemsOf,
  nowOf,
  scopeOf,
  viewOf,
  type DetailLine,
  type ListProps
} from './rows'

// The card, pure: everything comes from the state; every Button answers in the wiring files' `ui.press` hooks.

type Ui = Elements[RenderSurface]

const MAX_SHOWN = 5
const MAX_FILES_SHOWN = 5
const SETTINGS_LABEL_CELLS = 17
const POLL_CHOICES: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 60, label: '1 min' },
  { seconds: 90, label: '90 s' },
  { seconds: 300, label: '5 min' }
]
const TABS: ReadonlyArray<{ view: GhView; icon: string; word: string }> = [
  { view: 'review', icon: '👀', word: 'To review' },
  { view: 'mine', icon: '🙋', word: 'Mine' },
  { view: 'issues', icon: '📌', word: 'Issues' },
  { view: 'search', icon: '🔍', word: 'Search' }
]
const TAB_GAP = 2
const EMPTY: Record<GhView, string> = {
  review: 'No review requests for you.',
  mine: 'No open pull requests of yours.',
  issues: 'No open issues assigned to you.',
  search: 'Nothing found.'
}
const DOC_ICON: Record<GhDocKind, string> = { review: '🧐', 'pr-description': '📝', 'commit-summary': '🧾', 'review-log': '📜' }
const JOB_GLYPH: Record<GhReviewJob['phase'], string> = { queued: '⏳', running: '🤖', done: '✅', failed: '❌' }
const RATE_LOW = 100

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** The asks of a running review still waiting for the person. */
export function waitingAsks(job: GhReviewJob, now: number): GhReviewAsk[] {
  return job.phase === 'running' ? (job.asks ?? []).filter(ask => isAskPending(ask, now)) : []
}

function hasWaitingAsk(state: GithubState): boolean {
  const now = nowOf(state)

  return Object.values(state.reviews ?? {}).some(job => waitingAsks(job, now).length > 0)
}

/** The band tab's colour: it blinks in the warning colour while a reviewer's ask waits for the person. */
export function githubTabTone(state: GithubState): ThemeKey | undefined {
  return state.blink === true && hasWaitingAsk(state) ? TONE.run : undefined
}

/**
 * `1 to review · 3 mine ❌1 ⚠1 🤖`: counts first, then my PRs failing CI, overlapping PRs and a running review
 * (`🤖❓` while it asks for something).
 */
export function summarizeGithub(state: GithubState): string {
  if (state.health === undefined) return state.error ? '–' : '…'
  if (state.health === 'missing') return 'needs gh'
  if (state.health === 'logged-out') return 'sign in'
  const { review, mine, issues } = state
  if (!review && !mine && !issues) return state.error ? '–' : '…'
  const counts = [review?.length ? `${review.length} to review` : '', mine?.length ? `${mine.length} mine` : ''].filter(part => part !== '')
  if (counts.length === 0 && issues?.length) counts.push(plural(issues.length, 'issue'))
  const failing = (mine ?? []).filter(item => item.ci === 'fail').length
  const overlaps = state.overlaps?.length ?? 0
  const isReviewing = Object.keys(state.reviews ?? {}).some(id => isReviewRunning(state, id))
  const reviewFlag = hasWaitingAsk(state) ? '🤖❓' : isReviewing ? '🤖' : ''
  const flags = [failing > 0 ? `❌${failing}` : '', overlaps > 0 ? `⚠${overlaps}` : '', reviewFlag]
  const text = [counts.join(' · '), ...flags].filter(part => part !== '').join(' ')

  return text === '' ? '–' : text
}

/** A plain Button showing a choice: bold and underlined while on, dim while off (the dock's own tab look). */
function choiceButton(ui: DockElements, key: string, label: string, isOn: boolean): JSX.Element {
  const { Button, Text } = ui

  return (
    <Button key={key} plain onPress={() => undefined}>
      <Text bold={isOn} underline={isOn} dimColor={!isOn}>
        {label}
      </Text>
    </Button>
  )
}

/** `● 90 s`, `○ 5 min`. */
function radioLabel(isPicked: boolean, text: string): string {
  return `${isPicked ? '●' : '○'} ${text}`
}

function tabCount(state: GithubState, view: GhView): number | undefined {
  if (view === 'search') return state.search?.items?.length

  return (view === 'review' ? state.review : view === 'mine' ? state.mine : state.issues)?.length
}

/** `👀 To review 1  🙋 Mine 3  📌 Issues 2  🔍 Search`, or with no room `👀 1  🙋 3  📌 2  🔍`. */
function drawTabs(ui: Ui, state: GithubState, columns: number): JSX.Element {
  const { Box } = ui
  const view = viewOf(state)
  const labelOf = (tab: (typeof TABS)[number], isCompact: boolean): string => {
    const count = tabCount(state, tab.view)

    return [tab.icon, isCompact ? '' : tab.word, count === undefined ? '' : String(count)].filter(part => part !== '').join(' ')
  }
  const fullCells = TABS.reduce((sum, tab) => sum + cellWidth(labelOf(tab, false)), 0) + TAB_GAP * (TABS.length - 1)
  const isCompact = fullCells > columns

  return (
    <Box flexDirection="row" columnGap={TAB_GAP}>
      {TABS.map(tab => choiceButton(ui, `${KEY.view}${tab.view}`, labelOf(tab, isCompact), tab.view === view))}
    </Box>
  )
}

/** `acme/webapp +1`. */
function reposText(state: GithubState): string {
  const repos = [state.currentRepo?.nameWithOwner, ...(state.settings?.extraRepos ?? [])].filter(repo => repo !== undefined)
  const [first] = repos
  if (first === undefined) return state.currentRepo === undefined ? '…' : 'none added'

  return repos.length > 1 ? `${first} +${repos.length - 1}` : first
}

/** `Repos  acme/webapp +1     This · All  ➕`. */
function drawScope(ui: Ui, state: GithubState): JSX.Element {
  const { Box, Button, Text } = ui
  const scope = scopeOf(state)
  const canScopeRepos = Boolean(state.currentRepo) || (state.settings?.extraRepos?.length ?? 0) > 0

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text dimColor>{'Repos  '}</Text>
            <Text bold>{scope === 'all' ? 'All repos' : reposText(state)}</Text>
          </Text>
        </Box>
        <Box flexDirection="row" columnGap={1} flexShrink={0}>
          {canScopeRepos && choiceButton(ui, `${KEY.scope}repos`, 'This', scope === 'repos')}
          {canScopeRepos && <Text dimColor>·</Text>}
          {choiceButton(ui, `${KEY.scope}all`, 'All', scope === 'all')}
          <Button key={KEY.repoAdd} plain dimColor label="➕" onPress={() => undefined} />
        </Box>
      </Box>
      {state.currentRepo === null && drawNote(ui, "This folder isn't a GitHub repo: showing All repos.")}
    </Box>
  )
}

/** The Search tab's query row, or how to start one. */
function drawSearchBar(ui: Ui, state: GithubState): JSX.Element {
  const { Box, Button, Text } = ui
  const { search } = state
  if (!search) {
    return (
      <Box flexDirection="column">
        {drawNote(ui, 'Search open pull requests and issues in these repos.')}
        <Box marginTop={1}>
          <Button key={KEY.search} variant="primary" label="🔍 Search…" onPress={() => undefined} />
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text dimColor>{'Search  '}</Text>
            <Text bold>{drawable(search.query)}</Text>
          </Text>
        </Box>
        <Button key={KEY.search} plain dimColor label="🔍 New search" onPress={() => undefined} />
      </Box>
      {search.isLoading && drawNote(ui, 'Searching…')}
      {search.error !== undefined && (
        <Text dimColor wrap="wrap">
          {`Couldn't search: ${drawable(search.error)}`}
        </Text>
      )}
    </Box>
  )
}

/** A line under a row on a surface with no `Client`, laid out as the Client lays it. */
function drawPlainDetail(ui: Ui, line: DetailLine): JSX.Element {
  const { Text } = ui
  if (line.label === undefined) {
    return (
      <Text wrap="truncate-end" color={line.tone} dimColor={line.isDim === true}>
        {line.text === '' ? ' ' : line.text}
      </Text>
    )
  }

  return (
    <Text wrap="truncate-end">
      <Text dimColor>{padCells(line.label, DETAIL_LABEL_CELLS)}</Text>
      <Text color={line.tone} dimColor={line.isDim === true} bold={line.isDim !== true}>
        {line.text}
      </Text>
    </Text>
  )
}

/** The Button key of a menu action: githubWork answers its own actions under their own prefix. */
function menuKey(action: GhAction, id: string): string {
  return WORK_ACTIONS.includes(action) ? actKey(action, id, KEY.work) : actKey(action, id)
}

/** The list on a surface with no `Client` (vscode, mobile): a Button per row, a `⋯` Button for its menu, the menu as Buttons. */
function drawPlainList(ui: Ui, state: GithubState, props: ListProps): JSX.Element {
  const { Box, Button, Text } = ui
  const menuId = state.ui?.menuId

  return (
    <Box flexDirection="column">
      {props.rows.map(row => (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Button key={`${KEY.row}${encodeItemId(row.id)}`} plain onPress={() => undefined}>
              <Text bold={props.openId === row.id} color={row.tone}>
                {row.label}
              </Text>
            </Button>
            <Button key={`${KEY.menu}${encodeItemId(row.id)}`} plain dimColor={menuId !== row.id} label="⋯" onPress={() => undefined} />
          </Box>
          {menuId === row.id && (
            <Box flexDirection="column" paddingLeft={DETAIL_INDENT - 1}>
              {row.menu.map(entry => (
                <Button key={menuKey(entry.action, row.id)} plain label={entry.label} onPress={() => undefined} />
              ))}
            </Box>
          )}
          {row.details.length > 0 && (
            <Box flexDirection="column" paddingLeft={DETAIL_INDENT - 1}>
              {row.details.map(line => drawPlainDetail(ui, line))}
            </Box>
          )}
        </Box>
      ))}
      {props.hidden > 0 && <Button key={KEY.more} plain dimColor label={`+${props.hidden} more`} onPress={() => undefined} />}
    </Box>
  )
}

/** The rows of the tab shown: a `Client` on the terminal and desktop, Buttons elsewhere; a note when there are none. */
function drawList(ui: Ui, state: GithubState, columns: number, surface: RenderSurface, dockId: string): JSX.Element | null {
  const view = viewOf(state)
  if (listItemsOf(state).length === 0) {
    if (view === 'search') return state.search?.items ? drawNote(ui, EMPTY.search) : null
    const isLoaded = (view === 'review' ? state.review : view === 'mine' ? state.mine : state.issues) !== undefined
    if (isLoaded) return drawNote(ui, EMPTY[view])

    return state.error ? null : drawNote(ui, 'Loading your pull requests and issues…')
  }
  const props = buildListProps(state, columns)
  if ((surface === 'terminal' || surface === 'desktop') && 'Client' in ui) {
    const { Client } = ui

    return <Client key={`${KEY.listClient}${dockId}`} module="./GithubList.tsx" props={props} width={columns} />
  }

  return drawPlainList(ui, state, props)
}

/** What went wrong with the last poll, drawn whole, and why polling waits. */
function drawProblems(ui: Ui, state: GithubState): JSX.Element | null {
  const { Box, Text } = ui
  const isRateLow = state.rateRemaining !== undefined && state.rateRemaining < RATE_LOW
  if (!state.error && !isRateLow) return null

  return (
    <Box flexDirection="column">
      {state.error !== undefined && (
        <Text dimColor wrap="wrap">
          {`Couldn't load GitHub: ${drawable(state.error)}${(state.failures ?? 0) > 1 ? ' (trying again less often)' : ''}`}
        </Text>
      )}
      {isRateLow && drawNote(ui, `GitHub's rate limit is low (${state.rateRemaining} left): paused until it resets.`)}
    </Box>
  )
}

const OVERLAP_MENU: ReadonlyArray<{ action: 'open' | 'prompt' | 'copy'; label: string }> = [
  { action: 'open', label: '🌐 Open in browser' },
  { action: 'prompt', label: '🧩 Add to prompt (conflict resolution)' },
  { action: 'copy', label: '📋 Copy link' }
]

/** A shared file as a Button that opens the inspector: the name, then its folder dim and cut from the start. */
function drawOverlapFile(ui: Ui, number: number, path: string, columns: number): JSX.Element {
  const { Button, Text } = ui
  const { name, dir } = splitPath(drawable(path))
  const shownName = fitStart(name, Math.max(1, columns))
  const dirRoom = columns - cellWidth(shownName) - 2
  const shownDir = dir !== '' && dirRoom >= 6 ? fitStart(dir, dirRoom) : ''

  return (
    <Button key={`${KEY.overlapFile}${number}-${encodeURIComponent(path)}`} plain onPress={() => undefined}>
      <Text>{shownName}</Text>
      {shownDir !== '' && <Text dimColor>{`  ${shownDir}`}</Text>}
    </Button>
  )
}

/**
 * `#2096 linus  ABC-924/fix-sidebar…  3 files`, a Button whose press opens its menu under it; while the
 * section is open, the shared files, each opening the diff inspector.
 */
function drawOverlap(ui: Ui, overlap: GhOverlap, isOpen: boolean, isMenuOpen: boolean, columns: number): JSX.Element {
  const { Box, Button, Text } = ui
  const count = plural(overlap.files.length, 'file')
  const hidden = overlap.files.length - MAX_FILES_SHOWN

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2}>
        <Box flexShrink={1}>
          <Button key={`${KEY.overlapRow}${overlap.number}`} plain onPress={() => undefined}>
            <Text bold color="suggestion">{`#${overlap.number}`}</Text>
            <Text dimColor>{` ${drawable(overlap.author)}`}</Text>
            <Text bold={isMenuOpen}>{`  ${fitEnd(drawable(overlap.headRef), Math.max(4, columns - 24))}`}</Text>
          </Button>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{count}</Text>
        </Box>
      </Box>
      {isMenuOpen && (
        <Box flexDirection="column" paddingLeft={DETAIL_INDENT - 1}>
          {OVERLAP_MENU.map(entry => (
            <Button key={`${KEY.overlapAct}${entry.action}-${overlap.number}`} plain label={entry.label} onPress={() => undefined} />
          ))}
        </Box>
      )}
      {isOpen && (
        <Box flexDirection="column" paddingLeft={2}>
          {overlap.files.slice(0, MAX_FILES_SHOWN).map(path => drawOverlapFile(ui, overlap.number, path, columns - 2))}
          {drawMore(ui, hidden)}
          {overlap.isPartial === true && drawNote(ui, 'GitHub listed only its first 100 files.')}
        </Box>
      )}
    </Box>
  )
}

/** Other open PRs touching files changed here; nothing when none do. */
function drawOverlaps(ui: Ui, state: GithubState, columns: number): JSX.Element | null {
  const { Box, Button } = ui
  const overlaps = state.overlaps ?? []
  if (overlaps.length === 0 && state.overlapError === undefined) return null
  const isOpen = state.ui?.isOverlapOpen === true
  const changed = state.localChangeCount

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Box flexShrink={1}>{drawHeading(ui, '⚠️ Overlaps', overlaps.length > 0 ? plural(overlaps.length, 'PR') : undefined, TONE.run)}</Box>
        <Box flexDirection="row" columnGap={1} flexShrink={0}>
          <Button key={KEY.overlapRefresh} plain dimColor label="↻" onPress={() => undefined} />
          <Button key={KEY.overlapToggle} plain dimColor label={isOpen ? '▾' : '▸'} onPress={() => undefined} />
        </Box>
      </Box>
      {overlaps.slice(0, MAX_SHOWN).map(overlap => drawOverlap(ui, overlap, isOpen, state.ui?.overlapMenu === overlap.number, columns))}
      {drawMore(ui, overlaps.length - MAX_SHOWN)}
      {state.overlapError !== undefined && drawNote(ui, `Couldn't check for overlaps: ${drawable(state.overlapError)}`)}
      {overlaps.length > 0 &&
        drawNote(ui, `${changed === undefined ? 'Files' : plural(changed, 'file')} changed here, compared with origin${state.overlapBase === undefined ? '' : `/${state.overlapBase}`} as last fetched. Press a PR for actions${isOpen ? ', a file to compare the diffs' : ''}.`)}
    </Box>
  )
}

/** `2m 14s`, `45s`, `1h 3m`. */
function elapsedOf(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function jobStatus(job: GhReviewJob, now: number): string {
  const elapsed = elapsedOf((job.endedAt ?? now) - job.startedAt)
  const diffOnly = job.noCopy === undefined ? '' : ', diff only'
  switch (job.phase) {
    case 'queued':
      return `preparing · ${elapsed}`
    case 'running':
      return `reviewing${diffOnly} · ${elapsed}`
    case 'done':
      return `done${diffOnly} · ${elapsed}`
    default:
      return 'failed'
  }
}

/**
 * The line under a review: what a running reviewer does now (`reading src/a.ts · 12 steps`, `waiting for your
 * answer` while it asks), what a preparing one does, why one failed; undefined for a finished one.
 */
function jobActivity(job: GhReviewJob, now: number): string | undefined {
  if (job.phase === 'queued') return drawable(job.activity ?? 'starting…')
  if (job.phase === 'failed') return drawable(job.error ?? 'stopped')
  if (job.phase !== 'running') return undefined
  const step = waitingAsks(job, now).length > 0 ? 'waiting for your answer' : job.activity
  const steps = job.steps ?? 0
  const parts = [step === undefined ? '' : drawable(step), steps > 0 ? plural(steps, 'step') : ''].filter(part => part !== '')

  return parts.length > 0 ? parts.join(' · ') : undefined
}

type ReviewAction = 'open' | 'log' | 'raw' | 'stop' | 'retry' | 'dismiss'

/**
 * What a review row's menu offers, by phase: Open (done), Log and the raw stream (once it has them), Stop (running),
 * Retry (failed), Dismiss.
 */
function reviewMenuOf(job: GhReviewJob): Array<{ action: ReviewAction; label: string }> {
  const entries: Array<{ action: ReviewAction; label: string; isOffered: boolean }> = [
    { action: 'open', label: '📄 Open review', isOffered: job.phase === 'done' && job.path !== undefined },
    { action: 'log', label: '📜 Log', isOffered: job.logPath !== undefined },
    { action: 'raw', label: '↗ Raw stream (.jsonl)', isOffered: job.streamPath !== undefined },
    { action: 'stop', label: '⏹ Stop', isOffered: job.phase === 'running' },
    { action: 'retry', label: '↻ Retry', isOffered: job.phase === 'failed' },
    { action: 'dismiss', label: '✕ Dismiss', isOffered: job.phase === 'done' || job.phase === 'failed' }
  ]

  return entries.filter(entry => entry.isOffered).map(({ action, label }) => ({ action, label }))
}

function reviewMenuKey(action: ReviewAction, id: string): string {
  return `${KEY.reviewAct}${action}-${encodeItemId(id)}`
}

/**
 * One ask waiting for the person, in the warning colour while `isLit` (it blinks as the state flips): what it wants,
 * Allow once, Allow <rule> for this review (when Claude Code offered a rule), Deny, and when it denies itself.
 */
function drawAsk(ui: Ui, itemId: string, ask: GhReviewAsk, now: number, isLit: boolean, columns: number): JSX.Element {
  const { Box, Button, Text } = ui
  const minutes = Math.max(1, Math.ceil((askDeadline(ask.askedAt) - now) / 60_000))
  const rule = ask.rules !== undefined && ask.ruleLabel !== undefined ? fitEnd(`Allow ${ask.ruleLabel} for this review`, Math.max(8, columns - 3)) : undefined

  return (
    <Box flexDirection="column" paddingLeft={3}>
      <Text bold color={isLit ? TONE.run : undefined} wrap="truncate-end">
        {`⚠ Wants to ${drawable(ask.what)}`}
      </Text>
      <Box flexDirection="row" columnGap={2} paddingLeft={2}>
        <Button key={askKey('once', ask.id, itemId)} plain label="Allow once" onPress={() => undefined} />
        <Button key={askKey('deny', ask.id, itemId)} plain label="Deny" onPress={() => undefined} />
        <Box flexShrink={1}>
          <Text dimColor wrap="truncate-end">{`denied in ${minutes} min if unanswered`}</Text>
        </Box>
      </Box>
      {rule !== undefined && (
        <Box paddingLeft={2}>
          <Button key={askKey('review', ask.id, itemId)} plain label={rule} onPress={() => undefined} />
        </Box>
      )}
    </Box>
  )
}

/**
 * `🤖 #2086 Add CSV export option…   reviewing · 2m 14s`, then what it does now (or why it failed, with Retry and Log), the
 * asks waiting for an answer, and the row's menu once pressed. Newest first; a finished review's file is also
 * under Files.
 */
function drawReviews(ui: Ui, state: GithubState, columns: number): JSX.Element | null {
  const { Box, Button, Text } = ui
  const jobs = Object.values(state.reviews ?? {}).sort((a, b) => b.startedAt - a.startedAt)
  if (jobs.length === 0) return null
  const now = nowOf(state)
  const menuId = state.ui?.reviewMenu

  return (
    <Box flexDirection="column">
      {drawHeading(ui, '🤖 Background reviews')}
      {jobs.slice(0, MAX_SHOWN).map(job => {
        const number = job.itemId.slice(job.itemId.lastIndexOf('#'))
        const activity = jobActivity(job, now)
        const encoded = encodeItemId(job.itemId)
        const isFailed = job.phase === 'failed'
        const timedOut = job.phase === 'running' ? (job.asks ?? []).filter(ask => ask.answer === 'timeout').length : 0

        return (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={2}>
              <Box flexShrink={1} flexGrow={1}>
                <Button key={`${KEY.reviewRow}${encoded}`} plain onPress={() => undefined}>
                  <Text>{`${JOB_GLYPH[job.phase]} `}</Text>
                  <Text bold color="suggestion">
                    {number}
                  </Text>
                  <Text bold={menuId === job.itemId}>{` ${drawable(job.title)}`}</Text>
                </Button>
              </Box>
              <Box flexShrink={0}>
                <Text dimColor color={isFailed ? TONE.fail : undefined}>
                  {fitEnd(jobStatus(job, now), 40)}
                </Text>
              </Box>
            </Box>
            {activity !== undefined && (
              <Box flexDirection="row" columnGap={2} paddingLeft={3}>
                <Box flexShrink={1}>
                  <Text dimColor color={isFailed ? TONE.fail : undefined} wrap="truncate-end">
                    {activity}
                  </Text>
                </Box>
                {isFailed && <Button key={`${KEY.reviewInline}retry-${encoded}`} plain label="↻ Retry" onPress={() => undefined} />}
                {isFailed && job.logPath !== undefined && <Button key={`${KEY.reviewInline}log-${encoded}`} plain dimColor label="📜 Log" onPress={() => undefined} />}
              </Box>
            )}
            {waitingAsks(job, now).map(ask => drawAsk(ui, job.itemId, ask, now, state.blink === true, columns))}
            {timedOut > 0 && (
              <Box paddingLeft={3}>
                {drawNote(ui, `${plural(timedOut, 'ask')} went unanswered for 10 min and ${timedOut === 1 ? 'was' : 'were'} denied`)}
              </Box>
            )}
            {menuId === job.itemId && (
              <Box flexDirection="column" paddingLeft={DETAIL_INDENT - 1}>
                {reviewMenuOf(job).map(entry => (
                  <Button key={reviewMenuKey(entry.action, job.itemId)} plain label={entry.label} onPress={() => undefined} />
                ))}
              </Box>
            )}
          </Box>
        )
      })}
      {drawMore(ui, jobs.length - MAX_SHOWN)}
    </Box>
  )
}

/** The session's branch when it is not the default one: write a PR description or a commit summary for it. */
function drawBranch(ui: Ui, state: GithubState): JSX.Element | null {
  const { Box, Button } = ui
  const { currentRepo, branch } = state
  if (!currentRepo || !branch || branch === 'HEAD' || branch === currentRepo.defaultBranch) return null
  const pr = state.gen?.['pr-description']
  const commits = state.gen?.['commit-summary']
  const failures = [
    pr?.phase === 'failed' ? `Couldn't write the PR description${pr.error ? `: ${drawable(pr.error)}` : ''}` : '',
    commits?.phase === 'failed' ? `Couldn't write the commit summary${commits.error ? `: ${drawable(commits.error)}` : ''}` : ''
  ].filter(text => text !== '')

  return (
    <Box flexDirection="column">
      {drawHeading(ui, '🌿 This branch', drawable(branch))}
      <Box flexDirection="row" columnGap={2}>
        <Button
          key={KEY.genPr}
          plain
          dimColor={pr?.phase === 'running'}
          label={pr?.phase === 'running' ? '📝 Writing…' : '📝 PR description'}
          onPress={() => undefined}
        />
        <Button
          key={KEY.genCommits}
          plain
          dimColor={commits?.phase === 'running'}
          label={commits?.phase === 'running' ? '🧾 Writing…' : '🧾 Commit summary'}
          onPress={() => undefined}
        />
      </Box>
      {failures.map(text => drawNote(ui, text))}
    </Box>
  )
}

/**
 * The files the panel wrote, newest first: `🧐 Review #2086 · 3m   Open  ↗  📋  ➕`. Each Button names its file
 * by `createdAt` (unique per file), so a press still acts on that file after a new one moved the list down.
 */
function drawDocs(ui: Ui, state: GithubState): JSX.Element | null {
  const { Box, Button, Text } = ui
  const docs = state.docs ?? []
  if (docs.length === 0) return null
  const now = nowOf(state)

  return (
    <Box flexDirection="column">
      {drawHeading(ui, '📄 Files', String(docs.length))}
      {docs.slice(0, MAX_SHOWN).map(doc => {
        const age = ageSince(doc.createdAt, now)
        const id = String(doc.createdAt)

        return (
          <Box flexDirection="row" columnGap={1}>
            <Box flexShrink={1} flexGrow={1}>
              <Text wrap="truncate-end">
                {`${DOC_ICON[doc.kind]} ${doc.title}`}
                {age !== '' && <Text dimColor>{` · ${age}`}</Text>}
              </Text>
            </Box>
            <Box flexDirection="row" columnGap={1} flexShrink={0}>
              <Button key={`${KEY.docOpen}${id}`} plain label="Open" onPress={() => undefined} />
              <Button key={`${KEY.docOs}${id}`} plain dimColor label="↗" onPress={() => undefined} />
              <Button key={`${KEY.docCopy}${id}`} plain dimColor label="📋" onPress={() => undefined} />
              <Button key={`${KEY.docPrompt}${id}`} plain dimColor label="➕" onPress={() => undefined} />
            </Box>
          </Box>
        )
      })}
      {drawMore(ui, docs.length - MAX_SHOWN)}
    </Box>
  )
}

/** One settings row: the label dim in its column, then what it holds. */
function drawSettingRow(ui: Ui, label: string, value: JSX.Element): JSX.Element {
  const { Box, Text } = ui

  return (
    <Box flexDirection="row">
      <Box width={SETTINGS_LABEL_CELLS} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexDirection="row" columnGap={2} flexShrink={1}>
        {value}
      </Box>
    </Box>
  )
}

/** A setting's choices, one per line: `● Notice only`, `○ Notice + terminal bell`. */
function drawChoiceColumn(ui: Ui, choices: ReadonlyArray<{ key: string; label: string; isOn: boolean }>): JSX.Element {
  const { Box } = ui

  return <Box flexDirection="column">{choices.map(choice => choiceButton(ui, choice.key, radioLabel(choice.isOn, choice.label), choice.isOn))}</Box>
}

/**
 * The background reviews' settings: what tells you one finished (only what this client's notification channel
 * offers), the model, and whether it may look things up on the web.
 */
function drawReviewSettings(ui: Ui, state: GithubState): JSX.Element {
  const { Box } = ui
  const settings = state.settings ?? {}
  const done = doneChoices(state.notifyChannel)
  const second = done.choices.find(choice => choice.value !== 'notice')?.value
  const shownDone = wantsNotification(settings.reviewDone) && second !== undefined ? second : 'notice'
  const model: GhReviewModel = settings.reviewModel ?? 'sonnet'
  const isWebOn = settings.isReviewWebOn !== false

  return (
    <Box flexDirection="column" marginTop={1}>
      {drawHeading(ui, '🤖 Background reviews')}
      {drawSettingRow(
        ui,
        'When it finishes',
        drawChoiceColumn(
          ui,
          done.choices.map(choice => ({ key: `${KEY.reviewDone}${choice.value}`, label: choice.label, isOn: choice.value === shownDone }))
        )
      )}
      {done.note !== undefined && drawSettingRow(ui, '', drawNote(ui, done.note))}
      {drawSettingRow(
        ui,
        'Model',
        <Box flexDirection="row" columnGap={2}>
          {REVIEW_MODELS.map(one => choiceButton(ui, `${KEY.reviewModel}${one}`, radioLabel(model === one, modelName(one)), model === one))}
        </Box>
      )}
      {drawSettingRow(
        ui,
        'Web lookups',
        <Box flexDirection="row" columnGap={2}>
          {choiceButton(ui, `${KEY.reviewWeb}on`, radioLabel(isWebOn, 'On'), isWebOn)}
          {choiceButton(ui, `${KEY.reviewWeb}off`, radioLabel(!isWebOn, 'Off'), !isWebOn)}
        </Box>
      )}
    </Box>
  )
}

/**
 * ⚙: the repos added with ➕ (✕ removes one), how often to refresh, Haiku on or off, and the background reviews'
 * settings. Saved for every session.
 */
function drawSettings(ui: Ui, state: GithubState, columns: number): JSX.Element {
  const { Box, Button, Text } = ui
  const settings = state.settings ?? {}
  const repos = settings.extraRepos ?? []
  const poll = settings.pollSeconds ?? 90
  const isHaikuOn = settings.isHaikuOn !== false
  const repoCells = Math.max(8, columns - SETTINGS_LABEL_CELLS - 3)

  return (
    <Box flexDirection="column" width={columns}>
      {drawHeading(ui, '⚙ GitHub settings', 'for every session')}
      <Box flexDirection="column" marginTop={1}>
        {repos.map((repo, index) =>
          drawSettingRow(
            ui,
            index === 0 ? 'Added repos' : '',
            <Box flexDirection="row" columnGap={1}>
              <Text bold>{fitEnd(repo, repoCells)}</Text>
              <Button key={`${KEY.repoRemove}${encodeRepoName(repo)}`} plain dimColor label="✕" onPress={() => undefined} />
            </Box>
          )
        )}
        {drawSettingRow(
          ui,
          repos.length === 0 ? 'Added repos' : '',
          <Button key={KEY.repoAdd} plain dimColor label="➕ Add a repo" onPress={() => undefined} />
        )}
        {drawSettingRow(
          ui,
          'Refresh',
          <Box flexDirection="row" columnGap={2}>
            {POLL_CHOICES.map(choice => choiceButton(ui, `${KEY.poll}${choice.seconds}`, radioLabel(poll === choice.seconds, choice.label), poll === choice.seconds))}
          </Box>
        )}
        {drawSettingRow(
          ui,
          'Haiku summaries',
          <Button key={KEY.haiku} plain onPress={() => undefined}>
            <Text>
              <Text bold={isHaikuOn} dimColor={!isHaikuOn}>
                {radioLabel(isHaikuOn, 'On')}
              </Text>
              {'  '}
              <Text bold={!isHaikuOn} dimColor={isHaikuOn}>
                {radioLabel(!isHaikuOn, 'Off')}
              </Text>
            </Text>
          </Button>
        )}
      </Box>
      {drawReviewSettings(ui, state)}
      {drawActions(ui, [<Button key={KEY.settings} variant="primary" label="Done" onPress={() => undefined} />])}
    </Box>
  )
}

/** Before `gh` can be used: checking, GitHub unreachable (it tries again by itself), not installed, or signed out. */
function drawSetupState(ui: Ui, state: GithubState): JSX.Element {
  const { Box, Button, Text } = ui
  const refresh = <Button key={KEY.refresh} plain dimColor label="↻ Refresh" onPress={() => undefined} />
  const isUnreachable = state.health === undefined && state.error !== undefined
  let note = 'Checking gh…'
  let actions = [refresh]
  if (state.health === 'missing') {
    note = 'Needs the GitHub CLI: install gh (cli.github.com), then ↻ Refresh.'
    if (state.hasBrew === true) actions = [<Button key={KEY.install} variant="primary" label="Install" onPress={() => undefined} />, refresh]
  } else if (state.health === 'logged-out') {
    note = 'Sign in to GitHub: press Sign in (fills gh auth login), then ↻ Refresh.'
    actions = [<Button key={KEY.login} variant="primary" label="Sign in" onPress={() => undefined} />, refresh]
  } else if (isUnreachable) {
    note = `Couldn't reach GitHub: trying again${(state.failures ?? 0) > 1 ? ' less often' : ' shortly'}.`
  }

  return (
    <Box flexDirection="column">
      {drawNote(ui, note)}
      {isUnreachable && state.error !== undefined && (
        <Text dimColor wrap="wrap">
          {drawable(state.error)}
        </Text>
      )}
      {drawActions(ui, actions)}
    </Box>
  )
}

/**
 * The card's body from its state: the tabs and repos, the list (a `Client` on the terminal and desktop keyed per
 * dock, Buttons elsewhere), what failed, overlaps, background reviews, this branch, the files written, then ↻.
 * Before `gh` works it says why; the header's ⚙ swaps the body for the settings.
 */
export function drawGithub(ui: Ui, state: GithubState, columns: number, surface: RenderSurface, dockId: string): JSX.Element {
  const { Box, Button } = ui
  if (state.ui?.isSettingsOpen === true) return drawSettings(ui, state, columns)
  if (state.health !== 'ok') return drawSetupState(ui, state)
  const list = drawList(ui, state, columns, surface, dockId)
  const groups = [
    viewOf(state) === 'search' ? drawSearchBar(ui, state) : null,
    list,
    drawProblems(ui, state),
    drawOverlaps(ui, state, columns),
    drawReviews(ui, state, columns),
    drawBranch(ui, state),
    drawDocs(ui, state)
  ].filter(group => group !== null)
  const refreshLabel = state.isLoading === true ? '↻ Refreshing…' : '↻ Refresh'

  return (
    <Box flexDirection="column" width={columns}>
      {drawTabs(ui, state, columns)}
      {drawScope(ui, state)}
      {groups.map(group => (
        <Box flexDirection="column" marginTop={1}>
          {group}
        </Box>
      ))}
      {drawActions(ui, [<Button key={KEY.refresh} plain dimColor label={refreshLabel} onPress={() => undefined} />])}
    </Box>
  )
}
