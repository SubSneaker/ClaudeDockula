import type { Elements, RenderSurface, ThemeKey } from 'claude-code'

import type { GgHostState, GhDocKind, GhOverlap, GhReviewAsk, GhReviewJob, GhReviewModel, GhView, GitgudState } from '../../../types'
import { SETTINGS_LABEL_CELLS, choiceButton, drawChoiceColumn, drawChoiceRow, drawSettingRow, radioLabel } from '../../dock/settingsView'
import { TONE, cellWidth, drawActions, drawHeading, drawMore, drawNote, fitEnd, fitStart, padCells, splitPath, type DockElements } from '../../dock/ui'
import { KEY, WORK_ACTIONS, actKey, askKey, encodeItemId, encodeRepoName, type GhAction } from './model'
import { repoKeyOfRepo } from './ids'
import { drawable } from './parse'
import { adapterOf } from './providers'
import { REVIEW_MODELS, askDeadline, doneChoices, isAskPending, modelName, wantsNotification } from './review'
import {
  SERVICE_NAMES,
  bitbucketEnvCard,
  bitbucketKeychainCard,
  serviceRowText,
  setupCardOf,
  type CardAction,
  type SetupCard
} from './setup'
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

/** The service the card reads, for a sentence. */
function serviceName(state: GitgudState): string {
  return SERVICE_NAMES[state.provider ?? 'github']
}

/** A repo key as the card shows it: github.com's by its path, any other host's whole. */
function repoLabel(key: string): string {
  return key.startsWith('github.com/') ? key.slice('github.com/'.length) : key
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** The asks of a running review still waiting for the person. */
export function waitingAsks(job: GhReviewJob, now: number): GhReviewAsk[] {
  return job.phase === 'running' ? (job.asks ?? []).filter(ask => isAskPending(ask, now)) : []
}

function hasWaitingAsk(state: GitgudState): boolean {
  const now = nowOf(state)

  return Object.values(state.reviews ?? {}).some(job => waitingAsks(job, now).length > 0)
}

/** The band tab's colour: it blinks in the warning colour while a reviewer's ask waits for the person. */
export function gitgudTabTone(state: GitgudState): ThemeKey | undefined {
  return state.blink === true && hasWaitingAsk(state) ? TONE.run : undefined
}

/**
 * `1 to review · 3 mine ❌1 ⚠1 🤖`: counts first, then my PRs failing CI, overlapping PRs and a running review
 * (`🤖❓` while it asks for something).
 */
export function summarizeGitgud(state: GitgudState): string {
  if (state.health === undefined) return state.error ? '–' : state.detect === undefined || state.detect.kind === 'ready' ? '…' : 'set up'
  if (state.health === 'missing') return state.provider === 'gitlab' ? 'needs glab' : 'needs gh'
  if (state.health === 'logged-out') return state.provider === 'bitbucket' ? 'set up' : 'sign in'
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

function tabCount(state: GitgudState, view: GhView): number | undefined {
  if (view === 'search') return state.search?.items?.length

  return (view === 'review' ? state.review : view === 'mine' ? state.mine : state.issues)?.length
}

/** `👀 To review 1  🙋 Mine 3  📌 Issues 2  🔍 Search`, or with no room `👀 1  🙋 3  📌 2  🔍`. */
function drawTabs(ui: Ui, state: GitgudState, columns: number): JSX.Element {
  const { Box } = ui
  const view = viewOf(state)
  const hasIssues = adapterOf(state.provider ?? 'github')?.caps.issues !== false
  const tabs = TABS.filter(tab => tab.view !== 'issues' || hasIssues)
  const labelOf = (tab: (typeof TABS)[number], isCompact: boolean): string => {
    const count = tabCount(state, tab.view)

    return [tab.icon, isCompact ? '' : tab.word, count === undefined ? '' : String(count)].filter(part => part !== '').join(' ')
  }
  const fullCells = tabs.reduce((sum, tab) => sum + cellWidth(labelOf(tab, false)), 0) + TAB_GAP * (tabs.length - 1)
  const isCompact = fullCells > columns

  return (
    <Box flexDirection="row" columnGap={TAB_GAP}>
      {tabs.map(tab => choiceButton(ui, `${KEY.view}${tab.view}`, labelOf(tab, isCompact), tab.view === view))}
    </Box>
  )
}

/** `acme/webapp +1`. */
function reposText(state: GitgudState): string {
  const repos = [state.currentRepo ? repoKeyOfRepo(state.currentRepo) : undefined, ...(state.settings?.extraRepos ?? [])].filter(repo => repo !== undefined)
  const [first] = repos
  if (first === undefined) return state.currentRepo === undefined ? '…' : 'none added'

  return repos.length > 1 ? `${repoLabel(first)} +${repos.length - 1}` : repoLabel(first)
}

/** `Repos  acme/webapp +1     This · All  ➕`. */
function drawScope(ui: Ui, state: GitgudState): JSX.Element {
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
      {state.currentRepo === null && drawNote(ui, `This folder isn't a ${serviceName(state)} repo: showing All repos.`)}
    </Box>
  )
}

/** The Search tab's query row, or how to start one. */
function drawSearchBar(ui: Ui, state: GitgudState): JSX.Element {
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

/** The Button key of a menu action: gitgudWork answers its own actions under their own prefix. */
function menuKey(action: GhAction, id: string): string {
  return WORK_ACTIONS.includes(action) ? actKey(action, id, KEY.work) : actKey(action, id)
}

/** The list on a surface with no `Client` (vscode, mobile): a Button per row, a `⋯` Button for its menu, the menu as Buttons. */
function drawPlainList(ui: Ui, state: GitgudState, props: ListProps): JSX.Element {
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
function drawList(ui: Ui, state: GitgudState, columns: number, surface: RenderSurface, dockId: string): JSX.Element | null {
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

    return <Client key={`${KEY.listClient}${dockId}`} module="./GitgudList.tsx" props={props} width={columns} />
  }

  return drawPlainList(ui, state, props)
}

/** What went wrong with the last poll, drawn whole, and why polling waits. */
function drawProblems(ui: Ui, state: GitgudState): JSX.Element | null {
  const { Box, Text } = ui
  const isRateLow = state.rateRemaining !== undefined && state.rateRemaining < RATE_LOW
  if (!state.error && !isRateLow) return null

  return (
    <Box flexDirection="column">
      {state.error !== undefined && (
        <Text dimColor wrap="wrap">
          {`Couldn't load ${serviceName(state)}: ${drawable(state.error)}${(state.failures ?? 0) > 1 ? ' (trying again less often)' : ''}`}
        </Text>
      )}
      {isRateLow && drawNote(ui, `${serviceName(state)}'s rate limit is low (${state.rateRemaining} left): paused until it resets.`)}
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
function drawOverlap(ui: Ui, overlap: GhOverlap, isOpen: boolean, isMenuOpen: boolean, columns: number, state: GitgudState): JSX.Element {
  const { Box, Button, Text } = ui
  const sigil = adapterOf(state.provider ?? 'github')?.caps.vocab.sigil ?? '#'
  const count = plural(overlap.files.length, 'file')
  const hidden = overlap.files.length - MAX_FILES_SHOWN

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2}>
        <Box flexShrink={1}>
          <Button key={`${KEY.overlapRow}${overlap.number}`} plain onPress={() => undefined}>
            <Text bold color="suggestion">{`${sigil}${overlap.number}`}</Text>
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
          {overlap.isPartial === true && drawNote(ui, state.provider === undefined || state.provider === 'github' ? 'GitHub listed only its first 100 files.' : `${serviceName(state)} listed only some of its files.`)}
        </Box>
      )}
    </Box>
  )
}

/** Other open PRs touching files changed here; nothing when none do. */
function drawOverlaps(ui: Ui, state: GitgudState, columns: number): JSX.Element | null {
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
      {overlaps.slice(0, MAX_SHOWN).map(overlap => drawOverlap(ui, overlap, isOpen, state.ui?.overlapMenu === overlap.number, columns, state))}
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
function drawReviews(ui: Ui, state: GitgudState, columns: number): JSX.Element | null {
  const { Box, Button, Text } = ui
  const jobs = Object.values(state.reviews ?? {}).sort((a, b) => b.startedAt - a.startedAt)
  if (jobs.length === 0) return null
  const now = nowOf(state)
  const menuId = state.ui?.reviewMenu

  return (
    <Box flexDirection="column">
      {drawHeading(ui, '🤖 Background reviews')}
      {jobs.slice(0, MAX_SHOWN).map(job => {
        const number = `${adapterOf(state.provider ?? 'github')?.caps.vocab.sigil ?? '#'}${job.itemId.slice(job.itemId.lastIndexOf('#') + 1)}`
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
function drawBranch(ui: Ui, state: GitgudState): JSX.Element | null {
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
function drawDocs(ui: Ui, state: GitgudState): JSX.Element | null {
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

/**
 * The background reviews' settings: what tells you one finished (only what this client's notification channel
 * offers), the model, and whether it may look things up on the web.
 */
function drawReviewSettings(ui: Ui, state: GitgudState): JSX.Element {
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
        drawChoiceRow(
          ui,
          REVIEW_MODELS.map(one => ({ key: `${KEY.reviewModel}${one}`, label: modelName(one), isOn: model === one }))
        )
      )}
      {drawSettingRow(
        ui,
        'Web lookups',
        drawChoiceRow(ui, [
          { key: `${KEY.reviewWeb}on`, label: 'On', isOn: isWebOn },
          { key: `${KEY.reviewWeb}off`, label: 'Off', isOn: !isWebOn }
        ])
      )}
    </Box>
  )
}

/** The hosts the card knows a service for: the saved ones, the session's and the ones read this session. */
function serviceHostsOf(state: GitgudState): Array<[string, NonNullable<GitgudState['provider']>]> {
  const hosts = new Map<string, NonNullable<GitgudState['provider']>>()
  const entries: Array<[string, GgHostState | { provider: NonNullable<GitgudState['provider']> }]> = [
    ...Object.entries(state.hosts ?? {}),
    ...Object.entries(state.settings?.hosts ?? {})
  ]
  if (state.host !== undefined && state.provider !== undefined) entries.push([state.host, { provider: state.provider }])
  for (const [host, config] of entries) hosts.set(host, config.provider)

  return [...hosts.entries()]
}

/**
 * ⚙: the repos added with ➕ (✕ removes one), how often to refresh, Haiku on or off, and the background reviews'
 * settings. Saved for every session.
 */
function drawSettings(ui: Ui, state: GitgudState, columns: number): JSX.Element {
  const { Box, Button, Text } = ui
  const settings = state.settings ?? {}
  const repos = settings.extraRepos ?? []
  const poll = settings.pollSeconds ?? 90
  const isHaikuOn = settings.isHaikuOn !== false
  const repoCells = Math.max(8, columns - SETTINGS_LABEL_CELLS - 3)

  return (
    <Box flexDirection="column" width={columns}>
      {drawHeading(ui, '⚙ GitGud settings', 'for every session')}
      <Box flexDirection="column" marginTop={1}>
        {repos.map((repo, index) =>
          drawSettingRow(
            ui,
            index === 0 ? 'Added repos' : '',
            <Box flexDirection="row" columnGap={1}>
              <Text bold>{fitEnd(repoLabel(repo), repoCells)}</Text>
              <Button key={`${KEY.repoRemove}${encodeRepoName(repo)}`} plain dimColor label="✕" onPress={() => undefined} />
            </Box>
          )
        )}
        {drawSettingRow(
          ui,
          repos.length === 0 ? 'Added repos' : '',
          <Button key={KEY.repoAdd} plain dimColor label="➕ Add a repo" onPress={() => undefined} />
        )}
        {serviceHostsOf(state).map(([host, provider], index) =>
          drawSettingRow(
            ui,
            index === 0 ? 'Service' : '',
            <Box flexDirection="row" columnGap={1}>
              <Text bold>{fitEnd(serviceRowText(host, provider), repoCells)}</Text>
              <Button key={`${KEY.serviceChange}${host}`} plain dimColor label="Change" onPress={() => undefined} />
            </Box>
          )
        )}
        {drawSettingRow(
          ui,
          'Refresh',
          drawChoiceRow(
            ui,
            POLL_CHOICES.map(choice => ({ key: `${KEY.poll}${choice.seconds}`, label: choice.label, isOn: poll === choice.seconds }))
          )
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

const CARD_KEY: Readonly<Record<CardAction['id'], string>> = {
  pick: KEY.setupPick,
  later: KEY.setupLater,
  signin: KEY.login,
  install: KEY.install,
  copy: KEY.setupCopy,
  check: KEY.setupCheck,
  refresh: KEY.refresh
}

/** Bitbucket's token card while its setup is open, with a way out. */
function tokenCardOf(state: GitgudState): SetupCard | undefined {
  const { setup } = state
  if (setup?.provider !== 'bitbucket' || setup.email === undefined || setup.tokenFrom === undefined) return undefined
  const card = setup.tokenFrom.kind === 'env' ? bitbucketEnvCard(setup.tokenFrom.name) : bitbucketKeychainCard(setup.email, setup.platform ?? 'darwin')

  return { text: setup.note === undefined ? card.text : `${card.text}\n${setup.note}`, actions: [...card.actions, { id: 'later', label: 'Cancel' }] }
}

/** The card a setup step shows: Bitbucket's token steps, or what detection concluded about the service. */
function setupCardFor(state: GitgudState): SetupCard | undefined {
  const tokenCard = tokenCardOf(state)
  if (tokenCard !== undefined) return tokenCard
  const { detect } = state
  if (detect === undefined || detect.kind === 'ready') return undefined
  const { host, provider } = state
  const isCliDown = state.health === 'missing' || state.health === 'logged-out'
  if (detect.kind === 'no-remote' && host !== undefined && provider !== undefined && isCliDown) {
    if (provider === 'github' && host === 'github.com') return undefined

    return setupCardOf({ kind: 'needs-setup', host, provider, why: state.health === 'missing' ? 'cli-missing' : 'signed-out' }, { canInstallGlab: state.hasBrew === true })
  }
  // GitHub on github.com keeps the card's own words below.
  const isPlainGithub = detect.kind === 'needs-setup' && detect.provider === 'github' && detect.host === 'github.com'
  if (isPlainGithub || (detect.kind === 'no-remote' && state.health === 'missing')) return undefined

  return setupCardOf(detect, { canInstallGlab: state.hasBrew === true })
}

function cardButton(ui: Ui, action: CardAction): JSX.Element {
  const { Button } = ui
  const isPrimary = action.id === 'pick' || action.id === 'signin' || action.id === 'install' || action.id === 'check'
  const label = action.id === 'refresh' ? '↻ Refresh' : action.label

  return isPrimary ? <Button key={CARD_KEY[action.id]} variant="primary" label={label} onPress={() => undefined} /> : <Button key={CARD_KEY[action.id]} plain dimColor label={label} onPress={() => undefined} />
}

/** Before the service can be used: picking it, setting it up, checking, unreachable (it tries again by itself), not installed, or signed out. */
function drawSetupState(ui: Ui, state: GitgudState): JSX.Element {
  const { Box, Button, Text } = ui
  const card = setupCardFor(state)
  if (card !== undefined && state.ui?.isSetupDismissed === true && card.actions.some(action => action.id === 'later')) {
    return (
      <Box flexDirection="column">
        {drawNote(ui, 'GitGud needs to know which service this is: ⚙ Settings, then Change next to Service.')}
        {drawActions(ui, [<Button key={KEY.refresh} plain dimColor label="↻ Refresh" onPress={() => undefined} />])}
      </Box>
    )
  }
  if (card !== undefined) {
    return (
      <Box flexDirection="column">
        {drawNote(ui, card.text)}
        {drawActions(ui, card.actions.map(action => cardButton(ui, action)))}
      </Box>
    )
  }
  const refresh = <Button key={KEY.refresh} plain dimColor label="↻ Refresh" onPress={() => undefined} />
  const service = serviceName(state)
  const tool = state.provider === 'gitlab' ? 'glab' : 'gh'
  const isUnreachable = state.health === undefined && state.error !== undefined
  let note = `Checking ${tool}…`
  let actions = [refresh]
  if (state.health === 'missing') {
    note = 'Needs the GitHub CLI: install gh (cli.github.com), then ↻ Refresh.'
    if (state.hasBrew === true) actions = [<Button key={KEY.install} variant="primary" label="Install" onPress={() => undefined} />, refresh]
  } else if (state.health === 'logged-out') {
    note = 'Sign in to GitHub: press Sign in (fills gh auth login), then ↻ Refresh.'
    actions = [<Button key={KEY.login} variant="primary" label="Sign in" onPress={() => undefined} />, refresh]
  } else if (isUnreachable) {
    note = `Couldn't reach ${service}: trying again${(state.failures ?? 0) > 1 ? ' less often' : ' shortly'}.`
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
export function drawGitgud(ui: Ui, state: GitgudState, columns: number, surface: RenderSurface, dockId: string): JSX.Element {
  const { Box } = ui
  const body = drawGitgudBody(ui, state, columns, surface, dockId)
  const isCardAlone = state.health !== 'ok' && state.ui?.isSettingsOpen !== true
  const card = isCardAlone ? undefined : tokenCardOf(state)
  if (card === undefined) return body

  return (
    <Box flexDirection="column" width={columns}>
      {drawNote(ui, card.text)}
      {drawActions(ui, card.actions.map(action => cardButton(ui, action)))}
      <Box flexDirection="column" marginTop={1}>
        {body}
      </Box>
    </Box>
  )
}

function drawGitgudBody(ui: Ui, state: GitgudState, columns: number, surface: RenderSurface, dockId: string): JSX.Element {
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
