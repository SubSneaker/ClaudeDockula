import type { ClientKeyEvent, ClientPointerEvent, RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { cellWidth } from '../hooks/dock/ui'
import { drawGitgud, summarizeGitgud } from '../hooks/panels/gitgud/draw'
import GitgudList from '../hooks/panels/gitgud/GitgudList'
import { buildListProps, menuFor } from '../hooks/panels/gitgud/rows'
import type { GhItem, GitgudState } from '../types'

const REPO = 'acme/webapp'
const NOW = Date.parse('2026-10-16T12:00:00Z')
const PANE: RenderPropsOf['Pane'] = { title: 'GitGud', isFocused: true, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'children' in node) return textOf(node.children)

  return ''
}

/** The list's rows as shown: the pointer's `y` is the index. */
function rowsOf(tree: unknown): string[] {
  const children = typeof tree === 'object' && tree !== null && 'children' in tree ? tree.children : []

  return Array.isArray(children) ? children.map(textOf) : []
}

function pr(number: number, fields: Partial<GhItem> = {}): GhItem {
  return {
    id: `${REPO}#${number}`,
    kind: 'pr',
    repo: REPO,
    number,
    title: `ABC-${number} / Change number ${number}, with a long enough title to be cut`,
    url: `https://github.com/${REPO}/pull/${number}`,
    author: 'grace',
    updatedAt: '2026-10-14T09:37:43Z',
    comments: 0,
    ci: 'pass',
    review: 'none',
    ...fields
  }
}

const REVIEW = pr(2086, { review: 'required', comments: 1, ticket: 'ABC-2086', isTeamRequest: true })
const MINE = pr(2068, { author: 'octocat', ci: 'fail', review: 'changes', headRef: 'ABC-964/csv-export', baseRef: 'develop' })
const DRAFT = pr(2071, { author: 'octocat', isDraft: true, ci: 'pending' })
const OTHER_REPO = pr(7, { id: 'acme/api#7', repo: 'acme/api', ci: 'fail', author: 'octocat' })
const ISSUE: GhItem = { ...pr(12), kind: 'issue', title: '日本語のタイトル: an issue with wide characters', ci: undefined, review: undefined }
const STATE: GitgudState = {
  health: 'ok',
  login: 'octocat',
  currentRepo: { nameWithOwner: REPO, url: `https://github.com/${REPO}`, defaultBranch: 'develop' },
  branch: 'ABC-964/csv-export',
  review: [REVIEW],
  mine: [MINE, DRAFT],
  issues: [ISSUE],
  updatedAt: NOW,
  oneLiners: { [REVIEW.id]: 'Swaps the export toggle for the new switch.' },
  jiraStatus: { 'ABC-2086': 'In Review' },
  details: {
    [MINE.id]: {
      checks: [
        { name: 'Lint & Build', state: 'fail', why: ['src/a.ts(3,1): error TS2322'], whyLine: 'A type error in ExportButton.tsx' },
        { name: 'Test codes', state: 'pass' },
        { name: 'format', state: 'pending' }
      ]
    }
  },
  overlaps: [
    { prId: `${REPO}#2096`, number: 2096, repo: REPO, title: 'Fix sidebar overflow', author: 'linus', url: '', headRef: 'ABC-924/sidebar', files: ['src/app/layout.tsx'] }
  ],
  localChangeCount: 4,
  reviews: { [REVIEW.id]: { itemId: REVIEW.id, title: REVIEW.title, phase: 'running', startedAt: NOW - 134_000, activity: 'reading src/a.ts', steps: 3 } },
  docs: [{ kind: 'pr-description', title: 'PR description', path: '/tmp/pr.md', createdAt: NOW - 180_000 }]
}

test('the band summary: loading, needs gh, sign in, nothing, then counts and flags', () => {
  const cases: Array<[GitgudState, string]> = [
    [{}, '…'],
    [{ health: 'logged-out' }, 'sign in'],
    [{ health: 'missing' }, 'needs gh'],
    [{ health: 'ok' }, '…'],
    [{ health: 'ok', review: [], mine: [], issues: [] }, '–'],
    [{ health: 'ok', review: [], mine: [], issues: [ISSUE] }, '1 issue'],
    [{ health: 'ok', review: [REVIEW], mine: [MINE, DRAFT] }, '1 to review · 2 mine ❌1'],
    [STATE, '1 to review · 2 mine ❌1 ⚠1 🤖']
  ]

  expect(cases.map(([state]) => summarizeGitgud(state))).toEqual(cases.map(([, text]) => text))
})

test('row menus follow the row; labels fill the width exactly, emoji and CJK measured', () => {
  const actionsOf = (item: GhItem, hasReviewJob = false) =>
    menuFor(item, { login: 'octocat', currentRepo: REPO, hasReviewJob }).map(entry => entry.action)

  expect(actionsOf(ISSUE)).toEqual(['add-link', 'add-full', 'copy-link', 'copy-body', 'copy-thread', 'open'])
  expect(actionsOf(MINE)).toEqual(expect.arrayContaining(['review-bg', 'fix-ci', 'address', 'checkout', 'copy-diff']))
  expect(actionsOf(REVIEW, true)).not.toEqual(expect.arrayContaining(['review-bg']))
  expect(actionsOf(REVIEW).filter(action => ['fix-ci', 'address'].includes(action))).toEqual([])
  expect(actionsOf(OTHER_REPO)).not.toContain('checkout')

  for (const view of ['review', 'mine', 'issues'] as const) {
    const props = buildListProps({ ...STATE, ui: { view, openId: MINE.id } }, 56)
    expect(props.rows.map(row => cellWidth(row.label))).toEqual(props.rows.map(() => 53))
  }
  const mine = buildListProps({ ...STATE, ui: { view: 'mine', openId: MINE.id, shown: 1 } }, 56)
  expect(mine).toMatchObject({ openId: MINE.id, hidden: 1 })
  expect(mine.rows[0]?.label).toMatch(/^❌ #2068 ABC-2068 .*… {2}✋ {2}2d$/)
  expect(mine.rows[0]?.details).toEqual(
    expect.arrayContaining([
      { label: 'CI', text: '❌ Lint & Build', tone: 'error' },
      { label: '', text: '💡 A type error in ExportButton.tsx' },
      { label: 'Branch', text: 'ABC-964/csv-export → develop' }
    ])
  )
})

type ListSurface = Parameters<typeof GitgudList>[1]

interface Listeners {
  pointer?: (event: ClientPointerEvent) => void
  key?: (event: ClientKeyEvent) => void
}

/**
 * The list module drawn in a test Pane through a stand-in for its surface: what the engine's `Client` does
 * (local state, listeners, posts), minus the engine. The dock's own mount needs the core wiring's data.
 */
function standInSurface(elements: ListSurface['elements'], posts: unknown[]): { surface: ListSurface; listeners: Listeners } {
  const listeners: Listeners = {}
  let state: ListSurface['state']
  const surface: ListSurface = {
    elements,
    get state() {
      return state
    },
    setState: next => {
      state = next
    },
    columns: 56,
    rows: 0,
    every: () => () => undefined,
    onPointer: fn => {
      listeners.pointer = fn

      return () => undefined
    },
    onKey: fn => {
      listeners.key = fn

      return () => undefined
    },
    post: data => {
      posts.push(data)
    }
  }

  return { surface, listeners }
}

test('the list: right-click opens the menu, Copy ▸ Link posts the action; Buttons where there is no Client', async ($, on) => {
  const posts: unknown[] = []
  const props = buildListProps({ ...STATE, ui: { view: 'mine', openId: MINE.id } }, 56)
  let stand: ReturnType<typeof standInSurface> | undefined
  on('ui.render', { component: 'Pane', requestId: 'gitgud-list-test' }, ($, e) => {
    const ui = $.ui.resolve({ ...e, surface: 'terminal' as const })
    stand ??= standInSurface(ui, posts)

    return GitgudList(props, stand.surface)
  })
  const plainState: GitgudState = { ...STATE, ui: { view: 'mine', menuId: MINE.id, openId: MINE.id } }
  on('ui.render', { component: 'Pane', requestId: 'gitgud-plain-test' }, ($, e) => drawGitgud($.ui.resolve(e), plainState, 56, e.surface, 'test'))
  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'gitgud-list-test', props: PANE })
  const act = async (event: { pointer?: ClientPointerEvent; key?: string }): Promise<string[]> => {
    if (event.pointer) stand?.listeners.pointer?.(event.pointer)
    if (event.key) stand?.listeners.key?.({ key: event.key })
    await ui.redraw()

    return rowsOf(await ui.drawn())
  }
  const rows = rowsOf(await ui.drawn())
  expect(rows[0]).toMatch(/^ ❌ #2068 .*✋ {2}2d ⋯$/)
  expect(rows.slice(1, 6)).toEqual(['    CI      ❌ Lint & Build', '            💡 A type error in ExportButton.tsx', '            src/a.ts(3,1): error TS2322', '            🟡 format', '            ✅ 1 passed'])

  const menu = await act({ pointer: { type: 'down', x: 10, y: 0, button: 'right' } })
  const firstAt = menu.indexOf('    🧐 Review here')
  const copyAt = menu.indexOf('    📋 Copy ▸')
  expect(menu).toContain('    🔧 Fix failing CI')
  expect(firstAt === 1 && copyAt > firstAt).toBe(true)

  // Enter on Copy ▸ lists what to copy, Link highlighted, after a way back; Enter posts the action once and closes the menu.
  for (let step = firstAt; step < copyAt; step += 1) await act({ key: 'down' })
  expect((await act({ key: 'return' })).slice(1, 3)).toEqual(['    ‹ Back', '    📋 Link'])
  const closed = await act({ key: 'return' })
  expect(posts).toEqual([{ type: 'act', action: 'copy-link', id: MINE.id }])
  expect(closed.some(row => row.includes('‹ Back'))).toBe(false)

  // A click on a row opens or closes it through the hooks; on its right end it opens the menu instead.
  await act({ pointer: { type: 'down', x: 10, y: 0, button: 'left' } })
  await act({ pointer: { type: 'up', x: 10, y: 0, button: 'left' } })
  await act({ pointer: { type: 'down', x: 55, y: 0, button: 'left' } })
  expect(await act({ pointer: { type: 'up', x: 55, y: 0, button: 'left' } })).toContain('    🧐 Review here')
  expect(posts.slice(1)).toEqual([{ type: 'open', id: null }])
  await ui.unmount()

  // vscode and mobile: Buttons, with gitgudWork's own prefix on the background review.
  for (const surface of ['vscode', 'mobile'] as const) {
    const plain = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'Pane', requestId: 'gitgud-plain-test', props: PANE })
    expect(await plain.find({ key: 'gitgud-act-copy-link-acme~webapp~2068' })).toBeDefined()
    expect(await plain.find({ key: 'gitgud-work-review-bg-acme~webapp~2068' })).toBeDefined()
    expect(await plain.find({ key: 'gitgud-menu-acme~webapp~2071' })).toBeDefined()
    expect(await plain.find({ type: 'Text', text: /Lint & Build/ })).toBeDefined()
    await plain.unmount()
  }
})
