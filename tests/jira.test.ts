import type { McpToolResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { JiraBoardColumn, JiraTicket } from '../types'
import { type PrBadge, prBadgeLabel } from '../hooks/panels/gitgud/jiraLink'
import { summarizeJira } from '../hooks/panels/jira'
import { htmlToMarkdown } from '../hooks/panels/jira/html'
import {
  boardLabel,
  chosenBoard,
  confirmMoveKey,
  confirmQuestion,
  formatAge,
  groupTicketsByStatus,
  groupTicketsIntoLanes,
  laneViews,
  laneToggleKey,
  parseBoardChoices,
  parseBoardConfig,
  parseBoardList,
  parseBoardMessage,
  parseConfirmPress,
  parseLaneToggle,
  parseTransitions,
  pickBoard,
  pickTransition,
  withBoardLookup
} from '../hooks/panels/jira/lanes'
import {
  fitMarkdown,
  parseAtlassianSites,
  parseJiraIssue,
  pickDescriptionExcerpt,
  ticketKeyFromBranch
} from '../hooks/panels/jira/parse'
import { joinServerErrors, withPermissionHint } from '../hooks/panels/jira/servers'
import {
  buildBranchCommand,
  buildFullTicketMarkdown,
  buildTicketLink,
  parseFullTicket,
  parseTicketSearch
} from '../hooks/panels/jira/ticket'

const SITE_URL = 'https://acme.atlassian.net'

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError }
}

/** `atlassian` server, getJiraIssue ABC-101 (fields + markdown), ids and avatars trimmed. */
const ATLASSIAN_ISSUE = textResult(
  JSON.stringify({
    id: '24351',
    key: 'ABC-101',
    fields: {
      summary: '[UI] Add export button table download selection for download',
      issuetype: { id: '10033', name: 'Task', subtask: false },
      description:
        'After <custom data-type="smartlink" data-id="id-0">https://acme.atlassian.net/browse/ABC-100</custom> is complete, we need to add the option for the user to be able to select the encoding option for downloading a table.',
      assignee: { displayName: 'Alex Doe', active: true },
      priority: { name: 'Medium', id: '3' },
      status: { name: 'IN REVIEW', id: '10003', statusCategory: { key: 'done', name: 'Done' } }
    }
  })
)

/** `claude.ai Atlassian MCP` server, getJiraIssue ABC-101 (default compact view). */
const CLAUDE_AI_ISSUE = textResult(
  JSON.stringify({
    data: {
      appliedContentFormat: 'markdown',
      id: '24351',
      key: 'ABC-101',
      fields: {
        summary: '[UI] Add export button table download selection for download',
        description: 'After https://acme.atlassian.net/browse/ABC-100 is complete, we need to add the option.',
        status: { name: 'IN REVIEW' },
        assignee: { displayName: 'Alex Doe' },
        priority: { name: 'Medium' }
      }
    }
  })
)

/** A trimmed real description with an acceptance-criteria section (ABC-1168). */
const DESCRIPTION_WITH_CRITERIA = [
  'This ticket loads one table-editing settings value in `main`.',
  '',
  '### Sites to convert',
  '',
  '* the 11 commands that build the escape hatch;',
  '',
  'Source: PR review, <custom data-type="smartlink" data-id="id-0">https://github.com/org/repo/pull/353</custom>',
  '',
  '### Acceptance criteria',
  '',
  '* The server and the job runner each load the settings one time at startup.',
  '* Build, unit tests and lint are clean.',
  '',
  '### References',
  '',
  '* TS 7 release'
].join('\n')

test('reads the ticket key from the branch name', () => {
  expect(ticketKeyFromBranch('ABC-101/add-export-button')).toBe('ABC-101')
  expect(ticketKeyFromBranch('feature/XYZ-3723-fix')).toBe('XYZ-3723')
  expect(ticketKeyFromBranch('develop')).toBe(undefined)
})

test('parses the sites from either server', () => {
  const atlassian = textResult(
    JSON.stringify([{ id: '0f7b0a4f', url: `${SITE_URL}/`, name: 'acme', scopes: ['read:jira-work'] }])
  )
  const claudeAi = textResult(
    JSON.stringify({ data: { resources: [{ cloudId: '0f7b0a4f', url: SITE_URL, products: [{ id: 'jira' }] }] } })
  )

  expect(parseAtlassianSites(atlassian)).toEqual([{ cloudId: '0f7b0a4f', url: SITE_URL, name: 'acme' }])
  expect(parseAtlassianSites(claudeAi)).toEqual([{ cloudId: '0f7b0a4f', url: SITE_URL }])
  expect(parseAtlassianSites(textResult('Unauthorized', true))).toEqual([])
})

test('parses an issue from the atlassian server', () => {
  const parsed = parseJiraIssue(ATLASSIAN_ISSUE, SITE_URL)

  expect(parsed).toEqual({
    isOk: true,
    issue: {
      key: 'ABC-101',
      summary: '[UI] Add export button table download selection for download',
      status: 'IN REVIEW',
      assignee: 'Alex Doe',
      priority: 'Medium',
      type: 'Task',
      excerpt:
        'After https://acme.atlassian.net/browse/ABC-100 is complete, we need to add the option for the user to be able to select the encoding option for downloading a table.',
      isAcceptanceCriteria: false,
      url: `${SITE_URL}/browse/ABC-101`
    }
  })
})

test('parses an issue from the claude.ai connector, which omits the type', () => {
  const parsed = parseJiraIssue(CLAUDE_AI_ISSUE, SITE_URL)

  expect(parsed.isOk).toBe(true)
  if (!parsed.isOk) return
  expect(parsed.issue.key).toBe('ABC-101')
  expect(parsed.issue.status).toBe('IN REVIEW')
  expect(parsed.issue.type).toBe(undefined)
})

test('turns an error result into one line', () => {
  const failed = textResult(
    JSON.stringify({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }),
    true
  )

  expect(parseJiraIssue(failed, SITE_URL)).toEqual({
    isOk: false,
    error: 'Issue does not exist or you do not have permission to see it.'
  })
})

test('prefers the acceptance criteria over the description', () => {
  expect(pickDescriptionExcerpt(DESCRIPTION_WITH_CRITERIA)).toEqual({
    text: '* The server and the job runner each load the settings one time at startup.\n* Build, unit tests and lint are clean.',
    isAcceptanceCriteria: true
  })
})

test('cuts markdown to the rows it has', () => {
  expect(fitMarkdown('* one\n* two\n* three\n* four', 40, 3)).toBe('* one\n* two\n…')
  expect(fitMarkdown('short', 40, 3)).toBe('short')
  expect(fitMarkdown('x'.repeat(100), 10, 3)).toBe(`${'x'.repeat(19)}…`)
})

test('the band summary: the status, short; … while loading; – with no ticket', () => {
  const issue = { key: 'ABC-101', summary: 'Encoding', status: 'IN REVIEW', isAcceptanceCriteria: false, url: '' }

  expect(summarizeJira({})).toBe('…')
  expect(summarizeJira({ hasCheckedBranch: true })).toBe('–')
  expect(summarizeJira({ hasCheckedBranch: true, ticketKey: 'ABC-101', isLoading: true })).toBe('…')
  expect(summarizeJira({ hasCheckedBranch: true, ticketKey: 'ABC-101', issue })).toBe('In Review')
  expect(summarizeJira({ hasCheckedBranch: true, ticketKey: 'ABC-101', issue: { ...issue, status: 'Waiting for review' } })).toBe('Waiting for…')
})

function ticket(key: string, status: string, statusId?: string, statusCategory?: string): JiraTicket {
  return { key, summary: key, status, statusId, statusCategory, url: `${SITE_URL}/browse/${key}` }
}

/** The Team Board's columns (getJiraBoardConfig 357), trimmed to four. */
const RELEASE_COLUMNS: JiraBoardColumn[] = [
  { name: 'Backlog', statuses: [{ id: '10001', name: 'To Do', category: 'new' }] },
  { name: 'In Progress', statuses: [{ id: '10002', name: 'In Progress', category: 'indeterminate' }] },
  { name: 'IN REVIEW', statuses: [{ id: '10003', name: 'IN REVIEW', category: 'done' }] },
  {
    name: 'Done',
    statuses: [
      { id: '10004', name: 'COMPLETE', category: 'done' },
      { id: '11162', name: 'DUPLICATE', category: 'done' }
    ]
  }
]

test('reads the assigned search into tickets, the description cut to its first lines of prose', () => {
  const search = textResult(
    JSON.stringify({
      issues: [
        {
          key: 'ABC-102',
          fields: {
            summary: 'Pick a table',
            status: { name: 'To Do', id: '10001', statusCategory: { key: 'new' } },
            priority: { name: 'Medium' },
            issuetype: { name: 'Story' },
            updated: '2026-10-13T18:23:47.837+0900',
            description: '## Background\n\nLoading a **file** takes [too long](https://x).\n\n## Goal\n\n* Pick a table.'
          }
        },
        { key: 'XYZ-1960', fields: { summary: 'Translation', status: { name: 'TO DO' }, description: null } }
      ],
      isLast: true
    })
  )

  expect(parseTicketSearch(search, SITE_URL)).toEqual({
    isOk: true,
    tickets: [
      {
        key: 'ABC-102',
        summary: 'Pick a table',
        status: 'To Do',
        statusId: '10001',
        statusCategory: 'new',
        priority: 'Medium',
        type: 'Story',
        updated: '2026-10-13T18:23:47.837+0900',
        excerpt: ['Loading a file takes too long.', '• Pick a table.'],
        url: `${SITE_URL}/browse/ABC-102`
      },
      expect.objectContaining({ key: 'XYZ-1960', status: 'TO DO' })
    ]
  })
})

test('lanes: a board column by status id, then name; a status the board lacks goes to Other', () => {
  const lanes = groupTicketsIntoLanes(
    [
      ticket('ABC-1', 'To Do', '10001', 'new'),
      ticket('XYZ-2', 'TO DO', '10000', 'new'),
      ticket('ABC-3', 'IN REVIEW', '10003', 'done'),
      ticket('XYZ-4', 'NOT REPRODUCIBLE', '10500', 'done'),
      ticket('X-5', 'Parked')
    ],
    RELEASE_COLUMNS
  )

  expect(lanes.map(lane => [lane.name, lane.tickets.map(one => one.key)])).toEqual([
    ['Backlog', ['ABC-1', 'XYZ-2']],
    ['In Progress', []],
    ['IN REVIEW', ['ABC-3']],
    ['Done', []],
    ['Other', ['XYZ-4', 'X-5']]
  ])
  expect(groupTicketsIntoLanes([ticket('ABC-1', 'To Do', '10001')], RELEASE_COLUMNS).map(lane => lane.name)).not.toContain('Other')
})

test('the board picker: boards listed, the pick kept per project, a failed lookup tried again', () => {
  const listed = parseBoardList(
    textResult(
      JSON.stringify({
        data: { values: [{ id: 357, name: 'Team Board', type: 'kanban' }, { id: 356, name: 'Sprint Board', type: 'scrum' }, { id: 'x' }] }
      })
    )
  )
  if (!listed.isOk) throw new Error(listed.error)
  const [release, avalanche] = listed.boards
  const board = { id: 356, name: 'Sprint Board', projectKey: 'ABC', columns: RELEASE_COLUMNS }

  expect(listed.boards).toHaveLength(2)
  expect(release && boardLabel(release)).toBe('Team Board · kanban')
  expect(chosenBoard(listed.boards, 356)).toEqual(avalanche)
  expect(chosenBoard(listed.boards, 999)).toBe(undefined)
  expect(parseBoardChoices({ ABC: 356, XYZ: '12', X: null })).toEqual({ ABC: 356 })
  expect(parseBoardChoices('nope')).toEqual({})

  const failed = withBoardLookup({ boardProject: 'XYZ' }, 'ABC', { error: 'claude.ai Atlassian MCP: denied' })
  expect(failed.boardProject).toBe(undefined)
  expect(failed.boardError).toBe('claude.ai Atlassian MCP: denied')
  expect(failed.boardNote).toBe('No ABC board reachable: the lanes are the statuses')
  const found = withBoardLookup(failed, 'ABC', { boards: listed.boards, board })
  expect([found.boardProject, found.board?.id, found.boardNote, found.boardError]).toEqual(['ABC', 356, undefined, undefined])
  const kept = withBoardLookup(found, 'ABC', { boards: listed.boards, error: 'claude.ai Atlassian MCP: timeout' })
  expect([kept.boardProject, kept.boardsProject, kept.board?.id]).toEqual([undefined, 'ABC', 356])
})

test('the confirm names the status the move lands in when it is not the lane', () => {
  expect(confirmQuestion('Done', { key: 'ABC-1', lane: 'Done', status: 'COMPLETE' })).toBe('Move to DONE (COMPLETE)?')
  expect(confirmQuestion('IN REVIEW', { key: 'ABC-1', lane: 'IN REVIEW', status: 'IN REVIEW' })).toBe('Move to IN REVIEW?')
  expect(confirmQuestion('Done', { key: 'ABC-1', lane: 'IN REVIEW', status: 'IN REVIEW' })).toBe('Move to DONE?')
  expect(parseLaneToggle(laneToggleKey('In Progress'))).toBe('In Progress')
})

test('every server keeps its error, and a permissions refusal says where to allow it', () => {
  const denied = 'Permission to use mcp__atlassian__getJiraIssue has been denied.'
  const joined = joinServerErrors([`atlassian: ${denied}`, 'claude.ai Atlassian MCP: Unauthorized'])

  expect(joined).toBe(`atlassian: ${denied} · claude.ai Atlassian MCP: Unauthorized`)
  expect(withPermissionHint(joined)).toBe(`${joined}\nAllow it in /permissions`)
  expect(withPermissionHint('atlassian: Issue does not exist or you do not have permission to see it.')).not.toContain('/permissions')
  expect(withPermissionHint('claude.ai Atlassian MCP: Access denied')).not.toContain('/permissions')
  expect(joinServerErrors([])).toBe('No Atlassian MCP server answered')
})

test('with no board the lanes are the statuses present, to do first and done last', () => {
  const lanes = groupTicketsByStatus([
    ticket('A', 'IN REVIEW', undefined, 'done'),
    ticket('B', 'To Do', undefined, 'new'),
    ticket('C', 'In Progress', undefined, 'indeterminate'),
    ticket('D', 'to do', undefined, 'new')
  ])

  expect(lanes.map(lane => [lane.name, lane.tickets.map(one => one.key)])).toEqual([
    ['To Do', ['B', 'D']],
    ['In Progress', ['C']],
    ['IN REVIEW', ['A']]
  ])
})

test('reads a board config and picks the board with the most columns', () => {
  const config = (id: number, columns: number) =>
    parseBoardConfig(
      textResult(
        JSON.stringify({
          data: { id, name: `Board ${id}`, columnConfig: { columns: RELEASE_COLUMNS.slice(0, columns) } }
        })
      ),
      'ABC'
    )
  const scrum = config(356, 2)
  const release = config(357, 4)

  expect(release).toEqual({ id: 357, name: 'Board 357', projectKey: 'ABC', columns: RELEASE_COLUMNS })
  expect(pickBoard([scrum, release].flatMap(board => board ?? []))?.id).toBe(357)
  expect(pickBoard([])).toBe(undefined)
})

test('picks the transition into the lane: its first reachable status by id, else by name', () => {
  const atlassian = parseTransitions(
    textResult(
      JSON.stringify({
        transitions: [
          { id: '131', name: 'DUPLICATE', to: { id: '11162', name: 'DUPLICATE' } },
          { id: '61', name: 'COMPLETE', to: { id: '10004', name: 'COMPLETE' } },
          { id: '91', name: 'IN REVIEW', to: { id: '10003', name: 'IN REVIEW' } }
        ]
      })
    )
  )
  const claudeAi = parseTransitions(
    textResult(JSON.stringify({ data: { transitions: [{ id: '21', name: 'In Progress', to: { name: 'IN PROGRESS' } }] } }))
  )
  const done = RELEASE_COLUMNS[3]
  const inProgress = RELEASE_COLUMNS[1]
  if (!atlassian.isOk || !claudeAi.isOk || !done || !inProgress) throw new Error('fixtures did not parse')

  expect(pickTransition(atlassian.transitions, done)?.id).toBe('61')
  expect(pickTransition(claudeAi.transitions, inProgress)?.id).toBe('21')
  expect(pickTransition(atlassian.transitions, inProgress)).toBe(undefined)
})

test('the prompt texts: a branch command to finish, a link, and the board posts checked', () => {
  expect(buildBranchCommand('ABC-123')).toBe('! git switch -c ABC-123/')
  expect(buildTicketLink({ key: 'ABC-1', summary: '[UI] Pick', url: 'u' })).toBe('[ABC-1: [UI] Pick](u) ')
  expect(buildTicketLink({ key: 'ABC-1', summary: 'Half [open', url: 'u' })).toBe('[ABC-1: Half \\[open](u) ')
  expect(parseBoardMessage({ type: 'move', key: 'ABC-1', lane: 'IN REVIEW' })).toEqual({ type: 'move', key: 'ABC-1', lane: 'IN REVIEW' })
  expect(parseBoardMessage({ type: 'act', action: 'rm -rf', key: 'ABC-1' })).toBe(undefined)
  expect(parseBoardMessage({ type: 'board', id: 356 })).toEqual({ type: 'board', id: 356 })
  expect(parseBoardMessage({ type: 'preview', key: 'ABC-1', lane: 'Done' })).toEqual({ type: 'preview', key: 'ABC-1', lane: 'Done' })
})

test('the full ticket as one markdown block: facts, description, links, attachments and comments', () => {
  const issue = textResult(
    JSON.stringify({
      key: 'ABC-409',
      fields: {
        summary: 'Batching controls',
        status: { name: 'COMPLETE' },
        priority: { name: 'High' },
        issuetype: { name: 'Task' },
        labels: ['Frontend'],
        components: [],
        description: '## Acceptance criteria\n\n- [ ] Batches work',
        parent: { key: 'ABC-442', fields: { summary: 'Parent Epic', status: { name: 'IN STG' } } },
        subtasks: [],
        issuelinks: [
          {
            type: { inward: 'is implemented by', outward: 'implements' },
            outwardIssue: { key: 'OTH-9', fields: { summary: 'Source view', status: { name: 'Done' } } }
          }
        ],
        attachment: [
          { id: '15769', filename: 'demo.mp4', mimeType: 'video/mp4' },
          { id: '15770', filename: 'shot.png', mimeType: 'image/png' }
        ],
        comment: {
          comments: [
            {
              body: '<custom data-type="mention" data-id="id-0">@Alex Doe</custom> Looks right.\n\n![](blob:https://media/x)',
              created: '2026-07-28T22:36:41.714+0900',
              author: { displayName: 'Sam Lee' }
            }
          ]
        }
      }
    })
  )
  const parsed = parseFullTicket(issue, SITE_URL)
  if (!parsed.isOk) throw new Error(parsed.error)

  expect(buildFullTicketMarkdown(parsed.ticket)).toBe(
    [
      '## ABC-409: Batching controls',
      '',
      `${SITE_URL}/browse/ABC-409`,
      '',
      '- Status: COMPLETE',
      '- Priority: High',
      '- Type: Task',
      '- Labels: Frontend',
      '- Parent: ABC-442: Parent Epic (IN STG)',
      '',
      '### Description',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] Batches work',
      '',
      '### Linked issues',
      '',
      '- implements OTH-9: Source view (Done)',
      '',
      '### Attachments',
      '',
      `- demo.mp4: ${SITE_URL}/secure/attachment/15769/demo.mp4`,
      `- shot.png (image): ${SITE_URL}/secure/attachment/15770/shot.png`,
      '',
      '### Comments',
      '',
      '**Sam Lee** · 2026-07-28',
      '',
      '> @Alex Doe Looks right.',
      '>',
      '> [image]',
      ''
    ].join('\n')
  )
})

test('the connector\'s HTML bodies become markdown, and a cut comment list says so', () => {
  const issue = textResult(
    JSON.stringify({
      data: {
        key: 'ABC-409',
        fields: {
          summary: 'Batching',
          description: '<p>Add <code>window_rows</code>.</p><p><a href="https://x/140">https://x/140</a></p>',
          comment: {
            comments: [
              {
                body: '<p><span data-type="mention">@Alex</span> Done:</p><ul><li><p>A &amp; B</p></li><li><p>C</p></li></ul><figure><div data-type="media" data-alt="demo.mp4"></div></figure>',
                author: { displayName: 'Sam' }
              }
            ],
            total: 3
          }
        },
        appliedContentFormat: 'html'
      }
    })
  )
  const parsed = parseFullTicket(issue, SITE_URL)
  if (!parsed.isOk) throw new Error(parsed.error)

  expect(parsed.ticket.description).toBe('Add `window_rows`.\n\nhttps://x/140')
  expect(parsed.ticket.comments[0]?.body).toBe('@Alex Done:\n\n- A & B\n- C\n\n[media: demo.mp4]')
  expect(buildFullTicketMarkdown(parsed.ticket)).toContain(
    "### Comments\n\n_Only 1 of 3 comments here: the rest are on the ticket's page._\n\n**Sam**"
  )
  expect(htmlToMarkdown('<pre><code>a &lt; b</code></pre><p>&#99999999; &#x41;</p>')).toBe('```\na < b\n```\n\n&#99999999; A')
})

test('HTML to markdown: nested lists keep their markers, quotes and images read, control characters never pass', () => {
  expect(htmlToMarkdown('<ul><li></li><li>Two</li></ul>')).not.toContain('- -')
  expect(htmlToMarkdown('<ol><li>Step one<ul><li>sub a</li></ul></li><li>Step two</li></ol>')).toBe('1. Step one\n- sub a\n2. Step two')
  expect(htmlToMarkdown('<blockquote><p>It&rsquo;s fine&hellip;</p><p>&ldquo;Ship&rdquo; &mdash; Alex</p></blockquote><p><img src="x.png" alt="graph"></p>')).toBe(
    '> It’s fine…\n>\n> “Ship” — Alex\n\n[image: graph]'
  )
  expect(htmlToMarkdown('<p>a&#27;[31mb&#0;&#7;&#xD800;c\u0007d&#10;e</p>')).toBe('a[31mbcd\ne')

  const ticket = textResult(JSON.stringify({ key: 'ABC-1', fields: { summary: 'S', description: 'Raw\u001b[2J body\u0000\twith tab' } }))
  const parsed = parseFullTicket(ticket, SITE_URL)
  if (!parsed.isOk) throw new Error(parsed.error)
  expect(parsed.ticket.description).toBe('Raw[2J body\twith tab')
})

test('ages read from Jira times with a +0900 offset', () => {
  const now = Date.parse('2026-10-13T12:00:00Z')

  expect(formatAge('2026-10-13T18:00:00.000+0900', now)).toBe('3h ago')
  expect(formatAge('2026-10-10T21:00:00.000+0900', now)).toBe('3d ago')
  expect(formatAge(undefined, now)).toBe(undefined)
})

test('a confirm\'s Move key names its lane, so a press for another lane reads as another move', () => {
  const key = confirmMoveKey({ key: 'ABC-1', lane: 'IN REVIEW' })

  expect(key).toBe('jira-confirm-move-ABC-1~IN%20REVIEW')
  expect(parseConfirmPress(key)).toEqual({ answer: 'move', key: 'ABC-1', lane: 'IN REVIEW' })
  expect(parseConfirmPress('jira-confirm-cancel-ABC-1')).toEqual({ answer: 'cancel', key: 'ABC-1' })
  expect(parseConfirmPress('jira-confirm-move-ABC-1')).toBe(undefined)
})

test('a card whose key matches a pull request carries its badge, the others none', () => {
  const state = {
    tickets: [
      { key: 'ABC-1', summary: 'With a PR', status: 'To Do', url: 'https://acme.atlassian.net/browse/ABC-1' },
      { key: 'ABC-2', summary: 'Without', status: 'To Do', url: 'https://acme.atlassian.net/browse/ABC-2' }
    ]
  }
  const badge: PrBadge = { number: 2086, url: 'https://github.com/o/r/pull/2086', ci: 'pass', review: 'approved', isMine: true, count: 1 }
  const cards = laneViews(state, { 'ABC-1': badge }).flatMap(lane => lane.cards)
  const withPr = cards.find(card => card.key === 'ABC-1')
  const without = cards.find(card => card.key === 'ABC-2')

  expect(withPr?.pr).toBe(prBadgeLabel(badge))
  expect(withPr?.fields.at(-1)).toEqual({ label: 'PR', value: prBadgeLabel(badge) })
  expect(without && 'pr' in without).toBe(false)
  expect(without?.fields.some(field => field.label === 'PR')).toBe(false)
})
