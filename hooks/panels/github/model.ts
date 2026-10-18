// The GitHub panel's shared constants, keys and id encoding: every github/* module and the three wiring files
// (github.tsx, githubWork.tsx, githubOverlap.tsx) code against these. Pure: no `$`.

export const GH_PANEL_ID = 'github'
export const DOC_PANE_ID = 'claudedockula-doc'
export const STORE = {
  settings: 'github:settings',
  alerted: 'github:alerted',
  alertedOverlap: 'github:alerted:overlap',
  oneLiners: 'github:oneliners',
  ciWhy: 'github:ciwhy',
  docs: 'github:docs'
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

/** The actions githubWork.tsx answers; github.tsx answers the rest. */
export const WORK_ACTIONS: readonly GhAction[] = ['review-bg']

/** What the list Client posts (element `github-list-<dockId>`). */
export type GhListMessage =
  /** Expand a row, or collapse with `null`. */
  | { type: 'open'; id: string | null }
  | { type: 'act'; action: GhAction; id: string }
  | { type: 'more' }

/** Button keys and prefixes: one source for draw.tsx and the hooks. */
export const KEY = {
  refresh: 'github-refresh',
  settings: 'github-settings',
  more: 'github-more',
  /** + GhView */
  view: 'github-view-',
  /** + GhScope */
  scope: 'github-scope-',
  repoAdd: 'github-repo-add',
  /** + `encodeRepoName(name)`: names the repo, so a redraw that changes the list cannot move the press onto another. */
  repoRemove: 'github-repo-remove-',
  search: 'github-search',
  /** + seconds (60 | 90 | 300) */
  poll: 'github-poll-',
  haiku: 'github-haiku-toggle',
  /** + GhReviewDone (notice | bell | notify) */
  reviewDone: 'github-review-done-',
  /** + GhReviewModel (sonnet | opus) */
  reviewModel: 'github-review-model-',
  /** + (on | off) */
  reviewWeb: 'github-review-web-',
  /** Fills `! gh auth login`. */
  login: 'github-login',
  /** Fills `! brew install gh`; drawn only when Homebrew is installed. */
  install: 'github-install',
  /** + encoded id: the plain list's row toggle. */
  row: 'github-row-',
  /** + encoded id: the plain list's ⋯. */
  menu: 'github-menu-',
  /** + action + '-' + encoded id (`actKey`). */
  act: 'github-act-',
  /** + dockId: the list `Client`. */
  listClient: 'github-list-',
  // githubWork.tsx
  /** + action + '-' + encoded id (`actKey(action, id, KEY.work)`): a plain-list press of a WORK_ACTIONS action. */
  work: 'github-work-',
  genPr: 'github-gen-pr',
  genCommits: 'github-gen-commits',
  /** + the file's `createdAt` (unique in `docs`) */
  docOpen: 'github-doc-open-',
  docOs: 'github-doc-os-',
  docCopy: 'github-doc-copy-',
  docPrompt: 'github-doc-prompt-',
  /** + encoded id: a background review row, toggles its menu. */
  reviewRow: 'github-review-row-',
  /** + (open | log | raw | stop | retry | dismiss) + '-' + encoded id: a menu entry. */
  reviewAct: 'github-review-act-',
  /** + (retry | log) + '-' + encoded id: the Buttons under a failed review. */
  reviewInline: 'github-review-inline-',
  /** + (once | review | deny) + '-' + ask id + '-' + encoded id: the answers under a reviewer's ask (`askKey`). */
  reviewAsk: 'github-review-ask-',
  docPaneClose: 'github-docpane-close',
  docPaneOs: 'github-docpane-os',
  docPaneCopy: 'github-docpane-copy',
  docPanePrompt: 'github-docpane-prompt',
  // githubOverlap.tsx
  overlapToggle: 'github-overlap-toggle',
  overlapRefresh: 'github-overlap-refresh',
  /** + PR number: toggles the overlap row's menu. */
  overlapRow: 'github-overlap-row-',
  /** + (open | prompt | copy) + '-' + PR number. */
  overlapAct: 'github-overlap-act-',
  /** + PR number + '-' + encodeURIComponent(path): opens the inspector. */
  overlapFile: 'github-overlap-file-',
  diffPanePrompt: 'github-diffpane-prompt',
  diffPaneCopy: 'github-diffpane-copy',
  diffPaneOpen: 'github-diffpane-open',
  diffPaneRefresh: 'github-diffpane-refresh'
} as const

/** `github-overlap-file-12-src%2Fa.ts` → `{ number: 12, path: 'src/a.ts' }`; undefined for anything else. */
export function parseOverlapFileKey(element: string): { number: number; path: string } | undefined {
  const [, number = '', encoded = ''] = /^github-overlap-file-(\d+)-(.+)$/.exec(element) ?? []
  if (number === '') return undefined
  try {
    return { number: Number(number), path: decodeURIComponent(encoded) }
  } catch {
    return undefined
  }
}

export type AskAnswerKind = 'once' | 'review' | 'deny'

/** `askKey('deny', '1792331803-42', 'o/r#12')` → `github-review-ask-deny-1792331803-42-o~r~12`. */
export function askKey(answer: AskAnswerKind, askId: string, itemId: string): string {
  return `${KEY.reviewAsk}${answer}-${askId}-${encodeItemId(itemId)}`
}

/** `askKey` read back; undefined for anything else. */
export function parseAskKey(element: string): { answer: AskAnswerKind; askId: string; itemId: string } | undefined {
  const [, answer, askId = '', encoded = ''] = /^github-review-ask-(once|review|deny)-(\d+-\d+)-(.+)$/.exec(element) ?? []
  const itemId = decodeItemId(encoded)
  if (itemId === undefined || (answer !== 'once' && answer !== 'review' && answer !== 'deny')) return undefined

  return { answer, askId, itemId }
}

/** Longest first, so no action is read as the start of a longer one. */
const ACTIONS_BY_LENGTH = [...GH_ACTIONS].sort((a, b) => b.length - a.length)
const ITEM_ID = /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/
const TILDE = /[~]/g

export function itemId(repo: string, number: number): string {
  return `${repo}#${number}`
}

/** Whether `repo` is the session folder's repo; GitHub names are case-insensitive. */
export function isSessionRepo(repo: string, currentRepo: string | undefined): boolean {
  return currentRepo !== undefined && repo.toLowerCase() === currentRepo.toLowerCase()
}

function encodePart(part: string): string {
  return encodeURIComponent(part).replace(TILDE, '%7E')
}

/**
 * An item id made safe inside a Button key: `/` and `#` become `~`.
 * @example
 * // before: 'acme/webapp#2086'
 * // after:  'acme~webapp~2086'
 */
export function encodeItemId(id: string): string {
  const [, owner = '', name = '', number = ''] = ITEM_ID.exec(id) ?? []

  return owner ? [owner, name, number].map(encodePart).join('~') : encodePart(id)
}

/** `encodeItemId` read back; undefined when it is not one. */
export function decodeItemId(encoded: string): string | undefined {
  const parts = encoded.split('~')
  if (parts.length !== 3) return undefined
  try {
    const [owner = '', name = '', number = ''] = parts.map(part => decodeURIComponent(part))
    const id = itemId(`${owner}/${name}`, Number(number))

    return /^\d+$/.test(number) && ITEM_ID.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

/** `acme/webapp` → `acme~webapp`, safe inside a Button key. */
export function encodeRepoName(name: string): string {
  return name.split('/').map(encodePart).join('~')
}

/** `encodeRepoName` read back; undefined when it is not one. */
export function decodeRepoName(encoded: string): string | undefined {
  const parts = encoded.split('~')
  if (parts.length !== 2) return undefined
  try {
    const name = parts.map(part => decodeURIComponent(part)).join('/')

    return /^[\w.-]+\/[\w.-]+$/.test(name) ? name : undefined
  } catch {
    return undefined
  }
}

/** `actKey('copy-diff', 'o/r#12')` → `github-act-copy-diff-o~r~12`; `prefix` KEY.work for githubWork's presses. */
export function actKey(action: GhAction, id: string, prefix: string = KEY.act): string {
  return `${prefix}${action}-${encodeItemId(id)}`
}

/** `github-act-copy-diff-o~r~12` → `{ action: 'copy-diff', id: 'o/r#12' }`; `prefix` KEY.work reads githubWork's keys. */
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
 * Where the panel writes its files: the Claude config folder's `claudedockula/github`, never inside a repo.
 * @example
 * // ('/Users/example/.claude/', undefined) → '/Users/example/.claude/claudedockula/github'
 * // (undefined, '/Users/example')          → '/Users/example/.claude/claudedockula/github'
 */
export function docDirOf(configDir: string | undefined, home: string | undefined): string | undefined {
  const base = configDir?.trim() ? configDir.trim() : home?.trim() ? `${home.trim().replace(/\/+$/, '')}/.claude` : undefined

  return base === undefined ? undefined : `${base.replace(/\/+$/, '')}/claudedockula/github`
}
