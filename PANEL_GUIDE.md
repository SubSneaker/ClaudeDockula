# Building a ClaudeDockula panel

Instructions for Claude. There are two kinds of panel:

- **The person's own panels** ("Your own panels", next): what the ➕ New panel form asks for. They live in
  the person's own panels plugin, never in ClaudeDockula, so an update of ClaudeDockula (which replaces
  its whole folder) never touches them.
- **Built-in panels** ("Built-in panels (ClaudeDockula's own code only)", further down): branch, checks,
  activity, Jira, Slacker and GitHub (the last two opt-in), part of ClaudeDockula itself. Only someone working on ClaudeDockula
  changes those.

The engine's API is `.claude-plugin/types/claude-code/index.d.ts` in the plugin you are working in: grep
it for the noun you need (`mcp: {`, `process: {`, `clock: {`) before you use it.

## Your own panels

### Where they live

The person's panels plugin is `dockula-panels`, in `skills/dockula-panels/` under their Claude folder
(`$CLAUDE_CONFIG_DIR`, else `~/.claude`): the prompt that sent you here names the exact folder. ➕ set it
up from ClaudeDockula's template the first time. The engine loads it every session and reloads it when a
file is saved. A folder ➕ has just made is not loaded yet: before the checks, ask the person to run
`/reload-plugins` and wait, since loading it lays `.claude-plugin/types`, which `tsc` needs. Its
`.claude-plugin/plugin.json` lists `"dependencies": ["claudedockula"]`, so the engine lays ClaudeDockula's
contract (the `$.dockula` noun) at `.claude-plugin/types/claudedockula/index.d.ts` and types it.

Write only in that folder, with the Write and Edit tools (no shell `cp`, `mkdir` or `sed`). Never change
ClaudeDockula's own files: an update would undo it, and it would break the dock for everyone.

```
dockula-panels/
  .claude-plugin/plugin.json   name, version, dependencies, types
  hooks/hooks.json             { "modules": ["./register.tsx"] }
  hooks/register.tsx           registerPanels(on); on a reload, $.dockula.changed()
  hooks/panels/index.ts        PANELS, and the one dockula.panels hook
  hooks/panels/<id>.tsx        one panel: its hooks (and its draw)
  hooks/panels/<id>/*.ts       its pure helpers: parsers, formatters, row builders
  hooks/kit/spans.ts           span helpers (a copy of ClaudeDockula's; edit freely)
  types/index.d.ts             the panels' $.state values under 'dockula-panels'
  tests/                       panels.test.ts (a stub dock), <id>.test.ts
```

### How the dock shows them

The dock asks this plugin through `$.dockula`, a noun ClaudeDockula adds to `$`. Every method is an event
this plugin hooks; each panel's hooks name it with a literal matcher, `{ panel: '<id>' }`:

| Event | Hooked as | `e` | Answer |
| --- | --- | --- | --- |
| `dockula.panels` | once, in `hooks/panels/index.ts` (no matcher: it has no argument) | none | `{ value: [...below.value, ...PANELS] }`, `below` being `await next(e)` |
| `dockula.draw` | `{ panel: '<id>' }` | `{ panel, surface, columns, dockId }` | `{ value: lines }`: the card body as rows of spans |
| `dockula.summary` | `{ panel: '<id>' }` | `{ panel }` | `{ value: '3' }`: the band text after the emoji |
| `dockula.input` | `{ panel: '<id>' }` | `{ panel, dockId, surface, event }` | `{ value: { handled: true } }`: the dock redraws the panel |

and one method this plugin calls: `await $.dockula.changed()` after its state changed outside an `input`
answer (a timer, a fetch that finished, a reload), so the dock redraws. Inside an `input` answer it is not
needed (`handled: true` redraws) and does not run: no hook runs under its own call.

A panel's entry in `PANELS` is `{ id, title, icon, description }`: `id` lowercase letters, digits and
`-` (not `add` or `layout`, and no built-in's: `branch`, `checks`, `activity`, `jira`, `slacker`); `icon` one emoji.

### Drawing: rows of spans

A card body is a list of lines, one terminal row each; a line is a list of spans laid left to right:

- `text`: what is drawn. Measure with `cellWidth` (emoji and CJK take two cells), never `.length`, and cut
  each line to `e.columns` with `fitLine`.
- `key`: makes the span a target. Clicks, right-clicks, drops and keys come back naming it.
- `drag: true`: the span can be picked up. `drop: true`: it takes drops.
- the look: `color` (a theme key such as `success`, `error`, `warning`, or a colour), `weight`
  (`'semibold'` for a title), `dim`, `inverse`.

`hooks/kit/spans.ts` builds them: `text`, `target`, `draggable`, `dropZone`, `heading`, `note`, `fitLine`,
`cellWidth`, `TONE`. The draw hook reads the panel's state (`read($, atom)`), builds the lines with pure
helpers and answers; it never writes state. Keep the built-ins' look: a heading line, then rows, a blank
line (`[]`) between groups, five rows at most then `+7 more`, one dim `note` line for empty, loading and
error states, actions last (`↻ Refresh`, `↗ Open` as targets).

### Clicks, drags, right-clicks and keys

On the terminal and the desktop the dock draws the rows in its own canvas (a `Client`) and reports what
the person did, already matched to a span, as `e.event`:

- `click`: `key`, `x`, `y`: a press and release on the same target.
- `drop`: `from` (the `drag: true` span picked up) and `key` (the `drop: true` span let go on). While the
  button is held the canvas dims the source and inverts the target under the pointer itself: no message
  reaches the plugin until the drop.
- `context`: `key` (or none) under a right-click. Draw a menu as rows of targets under the span until the
  next click; give every menu action a click path too.
- `key`: `name` (`up`, `down`, `return`, `delete`, a letter) and `key`, the span last clicked. Keys reach
  the canvas only once a click gave it the focus; Escape never arrives (it hands the focus back).
- `x`, `y` (cells in the card), `button`, and `shift`, `alt`, `ctrl` when held.

Answer `{ value: { handled: true } }` once the state is updated. Start slow work with `void` and answer
at once; when it lands, update the state and call `$.dockula.changed()`.

vscode and mobile draw no `Client`: there every keyed span is a Button, and a press arrives as `click`.
Nothing drags, right-clicks or types there, so every drop, menu and key action needs a click path
(a `Move ▸` target that lists the lanes as targets, a `⋯` that opens the menu rows).

### State, settings and data

- State is this plugin's own: atoms declared in the panel's file,
  `const deploysState = atom({ plugin: 'dockula-panels', key: 'deploys' } as const, {})`, each key typed in
  `types/index.d.ts` under `'dockula-panels'` (optional fields, so `{}` is a valid initial value). Keep a
  choice that must outlive the session in this plugin's `$.store` too, and read it back in the panel's
  `session.start` hook.
- Ask for settings when the panel first needs them, as the built-in panels do: while a server, a
  project or a command is missing, `summary` answers `set up` (the band dims it) and the card draws one
  line and a `Set up ▸` target. Its click starts (with `void`) a function that asks with
  `$.ui.ask(question, options)` (two to four choices, plus free text under "Other"), saves the answer in
  `$.store` (keyed by the repo's root, `settings:<root>`, when it is per repo), updates the state and calls
  `$.dockula.changed()`. Never declare `userConfig` for it.
- Data comes as for the built-ins ("Getting data" below): read-only MCP tools, read-only commands, HTTP,
  timers started in the panel's own `session.start` hook. A change made elsewhere goes in the prompt box
  with `$.prompt.fill` for the person to send.
- The dock's notices are the dock's own: say what happened in the panel's rows (an error line that stays
  until the next refresh or a `✕` target), never with `$.ui.toast`.
- The engine's rules ("Rules the engine enforces", under the built-in panels) hold here too, with
  `'dockula-panels'` in every atom.

### Limits

- Rows of spans only: no boxes, borders, `Markdown`, `Input` or `Select`, and no `Client` of the panel's
  own. Drag feedback is the dock's (dim source, inverted target).
- Each click, drop, right-click or key is one round trip: the canvas posts, the plugin answers, the dock
  redraws. A drag's moves cost nothing.
- Nothing is imported from ClaudeDockula: copy a pure helper you need into this plugin.

### A panel, end to end

```tsx
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { draggable, dropZone, fitLine, note, type Line } from '../kit/spans'
import { countCards, moveCardTo } from './board/lanes'

const boardState = atom({ plugin: 'dockula-panels', key: 'board' } as const, { lanes: {} })

async function moveCard($: EngineInterface, card: string, lane: string): Promise<void> {
  await update($, boardState, state => moveCardTo(state, card, lane))
}

export function registerBoardHooks(on: On): void {
  on('dockula.draw', { panel: 'board' }, async ($, e) => {
    const state = await read($, boardState)
    const lines: Line[] = Object.entries(state.lanes).flatMap(([lane, cards]) => [
      [dropZone(`lane:${lane}`, lane, { weight: 'semibold' })],
      ...cards.map(card => [{ text: '  ' }, draggable(`card:${card}`, card)]),
    ])

    return { value: (lines.length > 0 ? lines : [note('No cards.')]).map(line => fitLine(line, e.columns)) }
  })
  on('dockula.summary', { panel: 'board' }, async $ => ({ value: String(countCards(await read($, boardState))) }))
  on('dockula.input', { panel: 'board' }, async ($, e) => {
    const { event } = e
    if (event.type === 'drop' && event.from?.startsWith('card:') && event.key?.startsWith('lane:')) {
      await moveCard($, event.from.slice(5), event.key.slice(5))
    }

    return { value: { handled: true } }
  })
}
```

with `{ id: 'board', title: 'Board', icon: '🗂️', description: 'Cards in lanes' }` appended to `PANELS`,
`registerBoardHooks(on)` called in `registerPanels`, and `board: BoardState` under `'dockula-panels'`.

### Checks (run all; fix until green)

```sh
npx -y -p typescript@5 tsc -p <panels folder>
claude plugin validate <panels folder>
claude plugin test <panels folder>
```

Tests go in `tests/<id>.test.ts`: the pure helpers (row builders, parsers, the summary) and, as
`tests/panels.test.ts` shows, the panel's hooks against a stub dock loaded beside this plugin
(`test(name, { plugins: [stubDock] }, ...)`, the stub's `session.start` calling `$.dockula.draw` or
`$.dockula.input` and handing the answer to the test through `prompt.fill`). You cannot see the band: ask
the person to confirm the panel's tab shows above the prompt (a new panel joins the last used dock's active
view).

### Removing one of your panels

Delete `hooks/panels/<id>.tsx`, `hooks/panels/<id>/` if it exists, and `tests/<id>.test.ts`. Remove its
entry from `PANELS` and its `register<Pascal>Hooks(on)` call from `hooks/panels/index.ts`, and its key from
`types/index.d.ts`. Run the checks. The dock keeps a panel's place while its plugin does not list it (it
may only be loading), so tell the person to press Remove on its `(not loaded)` row in ⚙ Manage.

## Built-in panels (ClaudeDockula's own code only)

Everything below is for working on ClaudeDockula itself. Never use it for the person's own panels: an
update of ClaudeDockula would undo it. The mod root is the folder holding this file; paths below are
relative to it.

### What a panel is

The panels are one shared set, each with one state; docks show them, and the same panel can show in
several docks and views at once (`hooks/dock/DockPane.tsx` draws them all, `hooks/dock/layout.ts` is
their model). A dock is `{ id, name, position, views, activeViewId, isOpen, rows?, … }` (`DockView` in
`types/index.d.ts`): `position: 'right'` is a pane of its own (`claudedockula` for the `main` dock,
`claudedockula-<id>` for the others; several open become tabs), `'bottom'` (one dock at most) is drawn
inside the band above the prompt. A dock holds one or more views (`DockViewTab`: `{ id, name?, panels,
minimized, direction, widths }`) and shows one at a time. From the top, every dock draws:

1. Its settings row: `⇄` (move it to the other side), `▤` Layout (the active view's direction,
   Column or Row (wraps), and in a row view each card's width: Auto, ⅓, ½ or Full), `⚙` Manage (tick
   the panels the active view shows, order them, rename the view or the dock, remove either), `➕` (a new
   dock on the right or at the bottom) and `✕`.
2. Its view tabs, then `➕ View`. A view with one panel and no name of its own is named after that
   panel (`🎫 Jira`), else `View <n>`.
3. The active view's cards.

The bottom dock also has a grip on its top edge (`hooks/dock/ResizeGrip.tsx`): dragged, it sets the
dock's height in rows, held under what the band leaves (the engine caps the band at half the terminal,
the prompt included). The bottom dock always has a height: 12 rows until the person drags it, held to the
cap, and a drag starts from the height the dock is drawn at, so it is exact. The cards are clipped to it, less
the rows an open ➕ menu or Layout card takes; when those leave fewer than two rows, no cards are drawn. The
cards scroll by a one-column bar to their right (`hooks/dock/ScrollBar.tsx`, terminal and desktop): drag
the thumb, click an arrow (a row) or the track (a page), or click the bar and use ↑ ↓ PgUp PgDn Home End;
Esc lets go. The bar is blank while the cards fit. The engine sends no wheel or keys to a band that fits, so
the wheel cannot scroll them. The bar posts its moves (`ui.message` from `dock-<dockId>-scrollbar`) to
`hooks/dock/DockPane.tsx`.

The scroll stops where the last card row reaches the bottom. A blank one-column `Client` beside the cards
(`hooks/dock/Measure.tsx`, terminal and desktop, so the cards are laid out two columns narrower with the bar's) is stretched
to their whole height under the clip and posts that height whenever it changes (`ui.message` from
`dock-<dockId>-measure`); until it has, the scroll stops at a fixed bound. The scroll and the measured heights
are atoms of their own, `dockScroll` (by dock id) and `dockMeasure` (by `<surface>:<dockId>`), which only the
band reads and which are written with `update` alone, never to the store and only when the value changes: a
scroll neither redraws the right docks nor makes the bottom dock the last used. A band tab, a view switch,
➕ View and Remove view bring the cards back to the top; a drag of the grip leaves the scroll as it is; it is held to the cards' end when drawn.

Every control of one view carries its view id, so a press that arrives after the view changed or went acts
on the view it was drawn for, and one for a view that is gone does nothing (a new view never takes a removed
one's id: the dock's `nextViewId` only grows): `dock-<dockId>-remove-view-<v>`,
`dir-column-<v>`, `dir-row-<v>`, the view's rename field `dock-<dockId>-view-name-<v>`, and a card's
`up`, `down`, `enable` and `width-*` as `dock-<dockId>-<action>-<v>-<panelId>`. The minimize toggle
(`dock-<dockId>-toggle-<panelId>`) and Remove panel (`drop`) name no view. When the tabs do not fit the row,
the dock shows as many as fit, the active one always, and a `…+n` button that switches to the next hidden
view; in a narrow pane the Layout card uses compact labels.

The band above the prompt is always there: the bottom dock while it is open, the newest notices (see
"Telling the person something"), then one row of tabs, one per panel some dock shows (its emoji and a
short live summary, `🎫 In Review`), then ➕. Pressing a tab shows that panel in the most recently used
open dock with a view holding it, switched to that view, else in the last used dock, whose active view
takes it in; pressing it again closes that dock. Each dock draws one rounded card per panel of its
active view, stacked or side by side: the dock draws the frame and the header (emoji, bold title, `⚙` for a panel with settings, `▾`
`↑` `↓`) and calls the panel's pure draw function for the body at the card's inner width, which
differs from card to card in a row view. A panel never needs to know which dock or view it is in,
except a panel that draws a `Client` (see "Interactive panels"). A panel is four exports from one file:

1. `<camel>Panel: DockPanel`: metadata only: `{ id, title, icon, description, isBuiltIn: true }`
   (`hooks/panels/contract.ts`). `icon` is one emoji (two cells wide), shown on the band tab and the
   card header.
2. `register<Pascal>Hooks(on: On): void`: everything that fetches, refreshes and answers buttons.
   It writes the panel's state with `update($, atom, fn)`.
3. `draw<Pascal>(ui, state, columns): JSX.Element`: pure. It takes the resolved element table, the
   panel's state and the card's inner width. It takes no `$` and never writes anything.
4. `summarize<Pascal>(state): string`: pure. The band text after the emoji, a few cells at most:
   a count (`12`), a status (`In Review`), `…` while loading, `–` when there is nothing to say. The band
   drops every summary and shows the emoji alone when they do not fit, so the summary is a glance,
   never the only place something is said.

The id is lowercase letters, digits and `-`. It names the file, the state key and the Button key
prefix. It must not be `add` (the ➕ tab's key is `dock-tab-add`), `layout` or an id that is already
in `PANELS`.

### Settings in the card's header

`hasSettings: true` on the panel (`hooks/panels/contract.ts`) draws `⚙` in its card's header, before `▾`, keyed
`dock-<dockId>-settings-<id>`. The dock expands a minimized card; the panel hooks that press as it hooks its minimize
toggle (`ui.press { plugin: 'claudedockula', element: /^dock-(main|\d+)-settings-<id>$/ }`, `next(e)` first) and opens
or closes its settings in its own body, with a Done Button there. The GitHub panel is the example.

### Opt-in panels and telling people about changes

- `isOptIn: true` on the panel (`hooks/panels/contract.ts`) when it should not join anyone's dock by itself:
  anything that needs setup or an account, or is niche. It is listed unticked in ⚙ Manage and the person
  ticks it in; a panel without it is added to the last used dock's active view the first time it is seen.
- A change its users should hear about (a new button, a different behaviour) bumps `revision` (1 when
  omitted) and writes `whatsNew`, one short line saying what changed; `whatsNew` is required once
  `revision` is above 1, and a test fails without it.
- At each interactive session start the dock compares the built-in panels with what it last told the person
  (`panels:seen` in `$.store`, `hooks/dock/panelNews.ts`) and posts one notice per new panel or higher
  revision, once. Nothing to do beyond the two fields.

### Rules the engine enforces

`claude plugin validate` refuses a module that breaks these. Write to them from the start:

- `$` is only ever spelled `$.noun.event(...)`, or passed to a function declared in the same file.
  Never pass it to an imported function, put it in an object, return it or store it. So every
  function that touches `$` lives in the panel's own file, and imported helpers are pure.
- `read`, `update` and `atom` only take atoms declared in the calling file:
  `const myState = atom({ plugin: 'claudedockula', key: '<id>' } as const, {})`. Declare the same ref
  again in any other file that needs it.
- `on` is only ever `on('<event>', matcher, hook)`, or passed to a named function. Never call it
  through a property.
- Give every hook a matcher, written as literals: a module may hook an event without a matcher only
  once, and every hook in this mod has one so that no panel takes that slot (`{ tool: /./ }`
  matches every tool). Examples:
  `session.start` `{ isInteractive: true }`, `tool.call` `{ tool: ['Bash'] }`, `ui.press`
  `{ plugin: 'claudedockula', element: '<id>-refresh' }`.
- A matcher is read as written: a literal string or regex, or a same-file `const X = '…'` string. An imported
  constant (`KEY.refresh`) or an object property validates but shows as `element=?`, so validate cannot
  check it. Write `element: 'github-refresh'` in the hook; use shared key constants only to build and
  parse Button keys.
- Hooks in different files of this mod may match the same `ui.message` or `ui.press`. Each answers the
  messages it owns and returns `next(e)` for the rest, so the other file's hook still runs (the GitHub
  list and its background reviews share `element: /^github-list-/` this way).
- A hook returns `next(e)` (or its awaited result) unless it answers for itself. A `tool.call` hook
  gets `.catch(($, e, next) => next(e))` so a failure never blocks the tool.
- No `import()`, DOM or Node. Relative static imports of `.ts`/`.tsx` files work.

### Files to touch

1. `hooks/panels/<id>.tsx`: the four exports. Put pure helpers (parsers, formatters) in
   `hooks/panels/<id>/*.ts`.
2. `hooks/panels/index.ts`: import them, append the panel to `PANELS` and call
   `register<Pascal>Hooks(on)` in `registerPanelHooks`.
3. `hooks/dock/DockPane.tsx`: import `draw<Pascal>` and `summarize<Pascal>`, declare its atom next
   to the others (`const <camel>Atom = atom({ plugin: 'claudedockula', key: '<id>' } as const, {})`) and
   add two cases: `case '<id>': return draw<Pascal>(ui, await read($, <camel>Atom), columns)` in
   `drawPanelBody`, and `case '<id>': return bandTab(panel, summarize<Pascal>(await read($, <camel>Atom)))`
   in `readBandTab`.
4. `types/index.d.ts`: add a `// --- <id> panel ---` block with `export interface <Pascal>State`
   (optional fields, so `{}` is a valid initial value) and add `'<id>': <Pascal>State` to the
   `'claudedockula'` map in `declare module 'claude-code'`. Keep the file self-contained: no imports.
   Value types the module needs are imported from `'../../types'`.

### Skeleton

```tsx
import { atom, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'

import type { DeploysState } from '../../types'
import { drawActions, drawNote, type DockElements } from '../dock/ui'
import type { DockPanel } from './contract'

const REFRESH_KEY = 'deploys-refresh'
const deploysState = atom({ plugin: 'claudedockula', key: 'deploys' } as const, {})
let ticker: Timer | undefined

async function refreshDeploys($: EngineInterface): Promise<void> {
  // fetch, parse with a pure helper, then write the state
  const updatedAt = await $.clock.now()
  await update($, deploysState, value => ({ ...value, updatedAt }))
}

export function registerDeploysHooks(on: On): void {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    ticker?.cancel()
    ticker = $.clock.every(30_000, () => void refreshDeploys($))
    void refreshDeploys($)

    return started
  })

  on('ui.press', { plugin: 'claudedockula', element: REFRESH_KEY }, async ($, e) => {
    await refreshDeploys($)

    return { element: e.element }
  })
}

/** The band text after the emoji: how many deploys failed, `–` before the first load. */
export function summarizeDeploys(state: DeploysState): string {
  return state.updatedAt === undefined ? '–' : '0'
}

export function drawDeploys(ui: DockElements, state: DeploysState, columns: number): JSX.Element {
  const { Box, Button } = ui

  return (
    <Box flexDirection="column" width={columns}>
      {drawNote(ui, 'No deploys yet.')}
      {drawActions(ui, [<Button key={REFRESH_KEY} plain dimColor label="↻ Refresh" onPress={() => undefined} />])}
    </Box>
  )
}

export const deploysPanel: DockPanel = {
  id: 'deploys',
  title: 'Deploys',
  icon: '🚀',
  description: 'The last five deploys and their status',
  isBuiltIn: true,
}
```

### Getting data

- **MCP server**: `await $.mcp.call(server, tool, args)` returns `{ content, isError, structuredContent? }`.
  `server` is the name /mcp lists, or the tool-name spelling (`claude_ai_Atlassian_MCP`). There is
  no permission prompt, so call read-only tools only (get, list, search). An action that changes
  something (create, edit, transition, send) is a Button whose `ui.press` hook puts a prompt in the
  prompt box with `$.prompt.fill({ text })` for the person to send. Parse the `text` blocks in a pure
  helper. A type assertion is acceptable only there, on the parsed response.
- **A write the panel makes itself**: only one the person explicitly asked the panel for (the Jira
  board's ticket transition and Slacker's reply are the two so far). It runs only after an inline confirm, whatever led
  to it: the Jira board asks `Move to IN REVIEW? [Move] [Cancel]` under the ticket both after a drop and
  after a lane picked from its menu's `Move to ▸` list, on the `Client` board and on the plain one
  (`view.confirm`, answered by `jira-confirm-move-<key>~<encoded lane>`, which moves only while the confirm still names that lane). Read what the write needs first (the transitions),
  make the write once (never again on a fallback server after it was sent), post a notice saying what
  happened, and reload. While developing, call only the read-only tools to learn the shapes; test the write with a
  mocked `mcp.call`, never against the real server.
- **Every server's error**: when a read falls back from one server to the next and all fail, keep each
  server's error and show them together (`atlassian: … · claude.ai Atlassian MCP: …`, `joinServerErrors`
  in `hooks/panels/jira/servers.ts`), never only the last. When the session's permissions refused the
  call, add a line `Allow it in /permissions` (`withPermissionHint`). Draw an error line whole
  (`wrap="wrap"`), not cut to one row.
- **Shell command**: `await $.process.run(argv, { cwd?, timeoutMs? })` returns
  `{ exitCode, stdout, stderr }`. It runs with no shell, in the session's cwd by default, with a
  30 s default timeout. Run read-only commands only. Git runs only as
  `git --no-optional-locks <read-only subcommand>` (`status`, `rev-parse`, `log`, `diff --stat`).
  Never anything that writes: no add, commit, checkout, stash, reset, fetch, pull or push.
- **Skill**: never run it unasked. A Button's `ui.press` hook puts `/skill-name …` in the prompt
  box with `$.prompt.fill({ text })` for the person to send.
- **HTTP**: `await $.http.fetch(url, init?)`.
- **A choice to remember**: keep it in the panel's state and in `$.store` (state survives a reload,
  the store a new session), read the store back in the panel's `session.start` hook. The Jira board
  picker keeps the board picked per project this way (`jiraBoardChoices`).
- **Refresh**: `$.clock.every(ms, fn)` and `$.clock.after(ms, fn)` return `{ cancel }`. Start the
  timer from the panel's own `session.start` hook, using that hook's `$`. Keep it in a module
  variable and cancel it before starting again: a reload drops timers and module variables
  together. "Manual" means a Refresh Button plus one load at session start.
- To skip work while the panel is hidden, declare the layout atom in the panel's file
  (`atom({ plugin: 'claudedockula', key: 'layout' } as const, DEFAULT_LAYOUT)`; `DEFAULT_LAYOUT` and
  `isShownIn` come from `hooks/dock/layout`). Then check `isShownIn(await read($, layoutAtom), '<id>')`:
  true while any open dock's active view shows the panel's card expanded. The band shows the panel's
  summary at all times, so skip only work the summary does not need.
- To refresh when the person opens the panel, hook the dock's own presses: its band tab and, in any
  dock, its card's minimize toggle (`dock-<dockId>-toggle-<id>`). A view's tab (`dock-<dockId>-view-<n>`)
  can bring it into view too; a timer that checks `isShownIn` covers that:
  `ui.press { plugin: 'claudedockula', element: /^dock-(tab|main-toggle|\d+-toggle)-<id>$/ }`. Await
  `next(e)` first (that runs the dock), then `void refresh($)`, then return what `next` gave.

#### Running a CLI: the argv guard

For a tool that can write (`gh`, `git`), run it only through a local wrapper that first asks a pure
`isAllowedArgv(argv)` (`hooks/panels/github/argv.ts`) and refuses anything not on its list: allowed
subcommands only, refused words and flags (`checkout`, `merge`, `--web`, `-X`), GraphQL only when it is a
query, git only as `git --no-optional-locks <read-only subcommand>`. The GitHub panel's background review adds
exactly its own commands, each matched whole: `git cat-file -e` and `git archive` into one review folder under its
temp root, `tar -xf` there, `rm -rf` of that folder, and `claude -p` with the reviewer's flags (`github/review.ts`).
Declare the wrapper in each file that runs the tool (`$` cannot cross files) and test the guard with the argvs a
test run collects. Parse stdout whatever the exit code: `gh pr checks` exits 8 when checks are pending and 1 when
one failed, with valid JSON. A tool call by a background agent carries `e.agentId`: hook `tool.call { tool: /./ }`, then check
`e.agentId` inside, since a regex matcher also matches an absent value.

### Telling the person something: notices

Never call `$.ui.toast`: a toast vanishes on a click. Post a notice; the dock draws the newest three in
the band above the tabs (in every right dock's pane on vscode and mobile, which have no band), one row
each: `⚠ Couldn't move ABC-101 → IN REVIEW   ▸  ✕`. A click on a row with `▸` opens the whole text under
it, ✕ dismisses it.
An `error` stays until dismissed; `info` and `success` clear after about 8 s (the dock's one timer
does it; a notice the person opened stays).

```ts
import { NO_NOTICES, pushNotice } from '../dock/notices'

const noticesAtom = atom({ plugin: 'claudedockula', key: 'notices' } as const, NO_NOTICES)

async function notify($: EngineInterface, tone: NoticeTone, title: string, detail?: string): Promise<void> {
  const at = await $.clock.now()
  await update($, noticesAtom, list => pushNotice(list, { tone, title, at, ...(detail ? { detail } : {}) }))
}
```

- `title` is the one row: short, it says what happened (`Couldn't read ABC-1`). `detail` is what the
  row opens to, one line per `\n`: every server's error, the permissions hint.
- `topic` (`check-types`, `move-ABC-1`) makes a newer notice on the same subject replace the older,
  so a re-run or a retry never stacks. `dropTopics` clears topics a summary replaces.
- Declare the atom in each file that posts, as above: `$` and atoms never cross files.

### Drawing

- Draw is pure: it gets everything from `state`. Never call `$` or write state while drawing.
- Size everything to `columns`, the card's inner width. Use `wrap="truncate-end"` on lines that can
  run long. Emoji and CJK take two cells: measure with `cellWidth`, never `.length`.
- Use only `Box`, `Text`, `Button`, `Markdown`, `Link` and `Code`. The dock hands over the table of
  every surface, and mobile has no `Input` or `Select`. A picker draws a `Select` only behind
  `'Select' in ui` (its `ui.select` hook does the work, like a Button's `ui.press`) and Buttons
  otherwise: the Jira board picker (`drawPlainPicker`). `DockElements` names only `Box`, `Text` and
  `Button`; a panel that draws `Markdown`, `Link` or `Code` types `ui` as
  `Pick<Elements[RenderSurface], 'Box' | 'Text' | 'Button' | 'Markdown'>`, or takes the whole
  `Elements[RenderSurface]` as `hooks/panels/jira.tsx` does. A panel that needs drag, right-click or
  keys draws a `Client` on top of that: see "Interactive panels" below.
- Every Button needs a `key` prefixed with the panel id (`<id>-open`, `<id>-run-<n>`) and
  `onPress={() => undefined}`. The work happens in the panel's matching `ui.press` hook, which
  answers `{ element: e.element }`. Never use the `dock-` prefix. Give no Button a `hotkey`. A panel
  shown in two docks draws its Buttons in both; a press comes from one of them, so its hook runs once.
- A draw that throws costs one dim line. A tree that does not validate makes the engine drop the
  whole pane or band, so test the draw.

#### The visual language

Every card reads the same way, so match the built-in panels (`hooks/panels/branch.tsx` is the
simplest). The pure helpers in `hooks/dock/ui.tsx` draw it; import them, never `$`:

- Groups of rows with a blank row between them: the second group's `Box` gets `marginTop={1}`.
- A group starts with `drawHeading(ui, 'Files edited', '12')`: the title bold, a dim detail after.
- Label and value rows: `drawFieldRows(ui, [{ label: 'Status', value: 'In Review', tone? }])`, labels
  dim, values bold, the values in one column.
- Paths: `drawFileRow(ui, { path, lead?, leadCells?, trail? }, columns)`: the file name first, its
  folder dim and cut from the start, a dim `trail` (`×3`) at the right end.
- Short lists: five rows at most, then `drawMore(ui, hidden)` (`+7 more`).
- Empty, loading and error states: `drawNote(ui, text)`, one dim line.
- Buttons go last, in `drawActions(ui, [...])` (a row with a blank row above it). The main action
  is `variant="primary"`; a secondary one is `plain dimColor` with a glyph: `↻ Refresh`, `↗ Open`.
- Status colours: `TONE.pass` (green), `TONE.fail` (red), `TONE.run` (yellow) as `color`.
- Text helpers: `cellWidth`, `fitEnd`, `fitStart`, `padCells` (a column of fixed width), `splitPath`.

#### Interactive panels: a `Client`

`hooks/panels/jira.tsx` and its surface module `hooks/panels/jira/JiraBoard.tsx` are the example: a
board picker row on top (a click or Enter lists the project's boards, a pick posts `{ type: 'board' }`),
then the lanes.

- The panel's draw writes `<Client key={`<id>-board-${dockId}`} module="./<id>/Board.tsx" props={…} width={columns} />`.
  `module` is a string literal relative to the file holding the element. Only the terminal and the
  desktop draw a `Client`, and vscode's table still holds one it does not draw, so decide on the
  surface: the dock passes `e.surface` and the dock's id as the draw's fourth and fifth arguments
  (`drawJira(ui, state, columns, e.surface, dockId)` in `drawPanelBody`). The dock id in the key gives
  each dock showing the panel its own instance, with its own local state (a drag, an open confirm),
  so one confirm makes one write. Draw a plain version with Buttons for vscode and mobile.
- `props` is plain data only: no functions and no key left `undefined` (spread optional keys in).
  Build it with a pure, tested helper (`buildBoardProps`).
- The surface module has no `$`. Its default export `(props, surface)` draws with
  `surface.elements` (it may import pure helpers such as `hooks/dock/ui`), registers
  `surface.onPointer` and `surface.onKey` on every call, reads `surface.state` fresh inside the
  listeners and calls `surface.setState` only there, never while drawing.
- It reaches the hooks module only through `surface.post(data)`, answered in the panel's file by
  `on('ui.message', { element: /^<id>-board-/ }, …)` (every dock's instance), which checks `e.data` with a type guard and
  returns `{}`. Post at most once per event: a second post in the same frame replaces the first.
  Kick long work off with `void` so the hook answers at once.
- Draw one terminal row per element (a `Text` with `wrap="truncate-end"`, cut to the width with
  `fitEnd`/`padCells`), so the pointer's `y` is the index of a row list the module lays out once
  and uses for both drawing and hit tests. A drag is `down`, `move` events with the button held
  (they keep coming past the edges), then `up`; right-click is `button: 'right'`. VS Code's terminal
  may keep right-clicks, so offer every right-click action on a visible `⋯` and on a key too.
  Escape never reaches `onKey`: it hands the focus back. Keep a highlight by what it points at (a lane's
  name, a board's id), never by its place in a list a redraw can reorder. An inline confirm answers
  only Enter, the arrows and clicks: no letter keys, which typing could hit by accident.
- A drag that leaves the region keeps reaching the module until the button comes up, with `y`
  negative above it: the dock's grip (`hooks/dock/ResizeGrip.tsx`) shows the height it would set while
  held and posts it once, on release.
- Test it with the kit: mount the Pane on `terminal`, read rows with `ui.drawn({ in: '<id>-board-main' })`,
  drive `ui.pointer({ in, type, x, y, button })` and `ui.key({ in, key })`, and assert what the hooks
  did through mocked `mcp.call` and `prompt.fill` (`tests/jira-board.test.tsx`).

### Checks (run all; fix until green)

```sh
npx -y -p typescript@5 tsc -p <mod root>
claude plugin validate <mod root>
claude plugin test <mod root>
```

`tsc -p` reads the `tsconfig.json` the engine keeps beside the mod. Tests go in
`tests/<id>.test.ts(x)`: pure helpers (parsers, formatters, `summarize<Pascal>`), plus one test that
gives the panel data and checks the dock still draws (see `tests/dock-populated.test.tsx`: mock the
data source with `on('process.run' | 'mcp.call', ...)`, press the panel's Refresh, then mount the
main dock's pane (`claudedockula`) and the band on `terminal` and `desktop`, `await expect(ui.drawn()).resolves.toBeDefined()`
on each and read the tab: `(await band.find({ key: 'dock-tab-<id>' }))?.text`). Keep them lean. Then
tell the person their panel's tab is on the band above the prompt (or `/dock` opens the last used
dock). A new panel joins the last used dock's active view, last in its order (an opt-in panel, `isOptIn: true`, does not: it is ticked in from ⚙ Manage); `/dock manage` reorders
it, and any other view or dock shows it once ticked in its ⚙ Manage.

### Removing a built-in panel

Delete `hooks/panels/<id>.tsx`, and `hooks/panels/<id>/` if it exists. Remove the
panel's import, its `PANELS` entry and its `register<Pascal>Hooks(on)` call from
`hooks/panels/index.ts`. Remove the imports, the atom and both `case`s (`drawPanelBody`,
`readBandTab`) from `hooks/dock/DockPane.tsx`.
Remove its block and its `'<id>'` key from `types/index.d.ts`, and its test file. Then run the
checks. The stored layout forgets the id on its own.

## Releasing

- Bump `version` in `.claude-plugin/plugin.json` on every release. Users only get an update when it changes.
- When a panel changes, bump its `revision` and set `whatsNew`. The dock shows that notice after an update.
- Run `claude plugin validate --strict` before pushing.
