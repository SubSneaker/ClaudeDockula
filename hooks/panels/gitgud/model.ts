// The GitGud panel's shared constants, keys and id encoding: every gitgud/* module and the three wiring files
// (gitgud.tsx, gitgudWork.tsx, gitgudOverlap.tsx) code against these. Pure: no `$`.

import { decodeItemId, encodeItemId } from './ids'

export const GH_PANEL_ID = 'gitgud'
export const DOC_PANE_ID = 'claudedockula-doc'
export const STORE = {
  settings: 'gitgud:settings',
  alerted: 'gitgud:alerted',
  alertedOverlap: 'gitgud:alerted:overlap',
  oneLiners: 'gitgud:oneliners',
  ciWhy: 'gitgud:ciwhy',
  docs: 'gitgud:docs'
} as const
/** Per search. */
export const LIST_LIMIT = 30
export const DEFAULT_SHOWN = 8
/** The default poll while the card is shown; `settings.pollSeconds` overrides it. */
export const POLL_SHOWN_MS = 90_000
/** The poll while only the band shows the panel (summary and alerts). */
export const POLL_HIDDEN_MS = 300_000
export const MAX_BACKOFF_MS = 900_000
export const OVERLAP_POLL_MS = 300_000
export const LOCAL_CHECK_DEBOUNCE_MS = 10_000
/** An opened PR with pending checks reloads them this often. */
export const DETAIL_REFRESH_MS = 60_000
export const GH_CONCURRENCY = 3
export const HAIKU_CONCURRENCY = 2
export const MAX_BACKGROUND_REVIEWS = 2
export const MAX_JIRA_READS_PER_POLL = 8
export const JIRA_STATUS_TTL_MS = 900_000

/** Row actions. Which ones a row offers: `menuFor` in rows.ts. */
export type GhAction =
  | 'review-here'
  | 'review-bg'
  | 'fix-ci'
  | 'address'
  | 'add-link'
  | 'add-full'
  | 'copy-link'
  | 'copy-body'
  | 'copy-thread'
  | 'copy-diff'
  | 'open'
  | 'open-ticket'
  | 'checkout'

/** Every action, for guards and key parsing. */
export const GH_ACTIONS: readonly GhAction[] = [
  'review-here',
  'review-bg',
  'fix-ci',
  'address',
  'add-link',
  'add-full',
  'copy-link',
  'copy-body',
  'copy-thread',
  'copy-diff',
  'open',
  'open-ticket',
  'checkout'
]

/** The actions gitgudWork.tsx answers; gitgud.tsx answers the rest. */
export const WORK_ACTIONS: readonly GhAction[] = ['review-bg']

/** What the list Client posts (element `gitgud-list-<dockId>`). */
export type GhListMessage =
  /** Expand a row, or collapse with `null`. */
  | { type: 'open'; id: string | null }
  | { type: 'act'; action: GhAction; id: string }
  | { type: 'more' }

/** Button keys and prefixes: one source for draw.tsx and the hooks. */
export const KEY = {
  refresh: 'gitgud-refresh',
  settings: 'gitgud-settings',
  more: 'gitgud-more',
  /** + GhView */
  view: 'gitgud-view-',
  /** + GhScope */
  scope: 'gitgud-scope-',
  repoAdd: 'gitgud-repo-add',
  /** + `encodeRepoName(name)`: names the repo, so a redraw that changes the list cannot move the press onto another. */
  repoRemove: 'gitgud-repo-remove-',
  search: 'gitgud-search',
  /** + seconds (60 | 90 | 300) */
  poll: 'gitgud-poll-',
  haiku: 'gitgud-haiku-toggle',
  /** + GhReviewDone (notice | bell | notify) */
  reviewDone: 'gitgud-review-done-',
  /** + GhReviewModel (sonnet | opus) */
  reviewModel: 'gitgud-review-model-',
  /** + (on | off) */
  reviewWeb: 'gitgud-review-web-',
  /** Fills `! gh auth login` (or glab's). */
  login: 'gitgud-login',
  /** Fills `! brew install gh` (or glab); drawn only when Homebrew is installed. */
  install: 'gitgud-install',
  /** The setup card: pick the service, not now, copy the keychain command, check the token. */
  setupPick: 'gitgud-setup-pick',
  setupLater: 'gitgud-setup-later',
  setupCopy: 'gitgud-setup-copy',
  setupCheck: 'gitgud-setup-check',
  /** + a host: ⚙ Service row's Change. */
  serviceChange: 'gitgud-service-change-',
  /** + encoded id: the plain list's row toggle. */
  row: 'gitgud-row-',
  /** + encoded id: the plain list's ⋯. */
  menu: 'gitgud-menu-',
  /** + action + '-' + encoded id (`actKey`). */
  act: 'gitgud-act-',
  /** + dockId: the list `Client`. */
  listClient: 'gitgud-list-',
  // gitgudWork.tsx
  /** + action + '-' + encoded id (`actKey(action, id, KEY.work)`): a plain-list press of a WORK_ACTIONS action. */
  work: 'gitgud-work-',
  genPr: 'gitgud-gen-pr',
  genCommits: 'gitgud-gen-commits',
  /** + the file's `createdAt` (unique in `docs`) */
  docOpen: 'gitgud-doc-open-',
  docOs: 'gitgud-doc-os-',
  docCopy: 'gitgud-doc-copy-',
  docPrompt: 'gitgud-doc-prompt-',
  /** + encoded id: a background review row, toggles its menu. */
  reviewRow: 'gitgud-review-row-',
  /** + (open | log | raw | stop | retry | dismiss) + '-' + encoded id: a menu entry. */
  reviewAct: 'gitgud-review-act-',
  /** + (retry | log) + '-' + encoded id: the Buttons under a failed review. */
  reviewInline: 'gitgud-review-inline-',
  /** + (once | review | deny) + '-' + ask id + '-' + encoded id: the answers under a reviewer's ask (`askKey`). */
  reviewAsk: 'gitgud-review-ask-',
  docPaneClose: 'gitgud-docpane-close',
  docPaneOs: 'gitgud-docpane-os',
  docPaneCopy: 'gitgud-docpane-copy',
  docPanePrompt: 'gitgud-docpane-prompt',
  // gitgudOverlap.tsx
  overlapToggle: 'gitgud-overlap-toggle',
  overlapRefresh: 'gitgud-overlap-refresh',
  /** + PR number: toggles the overlap row's menu. */
  overlapRow: 'gitgud-overlap-row-',
  /** + (open | prompt | copy) + '-' + PR number. */
  overlapAct: 'gitgud-overlap-act-',
  /** + PR number + '-' + encodeURIComponent(path): opens the inspector. */
  overlapFile: 'gitgud-overlap-file-',
  diffPanePrompt: 'gitgud-diffpane-prompt',
  diffPaneCopy: 'gitgud-diffpane-copy',
  diffPaneOpen: 'gitgud-diffpane-open',
  diffPaneRefresh: 'gitgud-diffpane-refresh'
} as const

/** `gitgud-overlap-file-12-src%2Fa.ts` → `{ number: 12, path: 'src/a.ts' }`; undefined for anything else. */
export function parseOverlapFileKey(element: string): { number: number; path: string } | undefined {
  const [, number = '', encoded = ''] = /^gitgud-overlap-file-(\d+)-(.+)$/.exec(element) ?? []
  if (number === '') return undefined
  try {
    return { number: Number(number), path: decodeURIComponent(encoded) }
  } catch {
    return undefined
  }
}

export type AskAnswerKind = 'once' | 'review' | 'deny'

/** `askKey('deny', '1792331803-42', 'o/r#12')` → `gitgud-review-ask-deny-1792331803-42-o~r~12`. */
export function askKey(answer: AskAnswerKind, askId: string, itemId: string): string {
  return `${KEY.reviewAsk}${answer}-${askId}-${encodeItemId(itemId)}`
}

/** `askKey` read back; undefined for anything else. */
export function parseAskKey(element: string): { answer: AskAnswerKind; askId: string; itemId: string } | undefined {
  const [, answer, askId = '', encoded = ''] = /^gitgud-review-ask-(once|review|deny)-(\d+-\d+)-(.+)$/.exec(element) ?? []
  const itemId = decodeItemId(encoded)
  if (itemId === undefined || (answer !== 'once' && answer !== 'review' && answer !== 'deny')) return undefined

  return { answer, askId, itemId }
}

/** Longest first, so no action is read as the start of a longer one. */
const ACTIONS_BY_LENGTH = [...GH_ACTIONS].sort((a, b) => b.length - a.length)
export { decodeItemId, decodeRepoName, encodeItemId, encodeRepoName, isSessionRepo, itemId, repoFolderOf, repoKeyOfRepo } from './ids'

/** `actKey('copy-diff', 'o/r#12')` → `gitgud-act-copy-diff-o~r~12`; `prefix` KEY.work for gitgudWork's presses. */
export function actKey(action: GhAction, id: string, prefix: string = KEY.act): string {
  return `${prefix}${action}-${encodeItemId(id)}`
}

/** `gitgud-act-copy-diff-o~r~12` → `{ action: 'copy-diff', id: 'o/r#12' }`; `prefix` KEY.work reads gitgudWork's keys. */
export function parseActKey(element: string, prefix: string = KEY.act): { action: GhAction; id: string } | undefined {
  if (!element.startsWith(prefix)) return undefined
  const rest = element.slice(prefix.length)
  const action = ACTIONS_BY_LENGTH.find(one => rest.startsWith(`${one}-`))
  if (!action) return undefined
  const id = decodeItemId(rest.slice(action.length + 1))

  return id === undefined ? undefined : { action, id }
}

function isAction(value: unknown): value is GhAction {
  return GH_ACTIONS.some(action => action === value)
}

/** The list Client's post, checked; undefined for anything else. */
export function parseListMessage(data: unknown): GhListMessage | undefined {
  if (typeof data !== 'object' || data === null || !('type' in data)) return undefined
  if (data.type === 'more') return { type: 'more' }
  const id = 'id' in data ? data.id : undefined
  if (data.type === 'open' && (id === null || typeof id === 'string')) return { type: 'open', id }
  if (data.type === 'act' && typeof id === 'string' && 'action' in data && isAction(data.action)) {
    return { type: 'act', action: data.action, id }
  }

  return undefined
}

/**
 * Where the panel writes its files: the Claude config folder's `claudedockula/gitgud`, never inside a repo.
 * @example
 * // ('/Users/example/.claude/', undefined) → '/Users/example/.claude/claudedockula/gitgud'
 * // (undefined, '/Users/example')          → '/Users/example/.claude/claudedockula/gitgud'
 */
export function docDirOf(configDir: string | undefined, home: string | undefined): string | undefined {
  const base = configDir?.trim() ? configDir.trim() : home?.trim() ? `${home.trim().replace(/\/+$/, '')}/.claude` : undefined

  return base === undefined ? undefined : `${base.replace(/\/+$/, '')}/claudedockula/gitgud`
}

/** The folder the panel wrote to before it was renamed; files there stay openable. */
export function legacyDocDirOf(configDir: string | undefined, home: string | undefined): string | undefined {
  const dir = docDirOf(configDir, home)

  return dir === undefined ? undefined : `${dir.slice(0, -'gitgud'.length)}github`
}

/** Every folder the panel may open files from: the current one, then the legacy one. */
export function docDirsOf(configDir: string | undefined, home: string | undefined): string[] {
  const dirs = [docDirOf(configDir, home), legacyDocDirOf(configDir, home)]

  return dirs.filter((dir): dir is string => dir !== undefined)
}
