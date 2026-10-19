# 🎫 Jira

The Jira panel (card title `Jira · assigned to me`) shows your Jira tickets as a board, in the lanes of your team's board, with the ticket of your current branch marked. You can move tickets between lanes, start a branch for one, or add one to the prompt.

Jira is off by default. Add it in ⚙ Manage.

## What it needs

An MCP server with Jira tools. An MCP server is a connector that gives Claude extra tools; you connect them in `/mcp`. The panel uses any connected server that offers both `getJiraIssue` and `searchJiraIssuesUsingJql`, such as the claude.ai Atlassian connector.

The board's columns come from a server that also offers `executeRead`. Without one, the lanes are the tickets' statuses.

## Setting it up

When the session starts, the panel looks for such servers:

- None: the card says `Connect an Atlassian MCP server to use this panel`. Connect one in `/mcp`, then press `↻ Refresh`.
- One server whose account reaches one Jira site: the panel saves it at once. There is nothing to pick.
- Otherwise the card shows a form. `Pick the Atlassian MCP server to read Jira through.` lists the servers when there are several, and `Which site?` lists the sites when there are several. Press one (● marks your choice), then `Save`.

Notes the card may show meanwhile: `Reading settings…`, `Looking for an Atlassian MCP server…`, `Looking for sites…`, `No Jira site found for that server.`, `Pick a server and a site first.`

## The board

### Which tickets

- The tickets your JQL query finds, up to 50. JQL is Jira's query language. The default query lists tickets assigned to you that are still open or were resolved in the last 14 days, most recently updated first.
- The ticket of the current branch: the panel finds the key in the branch name (`ABC-101/add-export` gives `ABC-101`). It is added even when the query does not find it, marked `★`, and open until you close it.

### Which board

- The project is the branch ticket's project, else the project most of your tickets are in.
- The board is the one you picked for that project. Until you pick one, it is the board with the most columns among the project's first 5.
- The picker row on top reads `Board  Team Board · kanban  ▾`. When the project has more than one board, press it to list them, then press one. Your pick is kept for that project in later sessions. `…` shows while a board loads.

### Lanes

- One lane per column of the board, its name in capitals, then how many tickets it holds: `IN REVIEW  (2)`.
- Tickets whose status no column holds go into an `OTHER` lane at the end. Nothing can be moved into it.
- The last column (usually the Done one) starts closed, marked `▸`. Press a lane's name to open or close it.
- With no board, there is one lane per status, ordered to do, in progress, done, and a note says why: `ABC has no board: the lanes are the statuses`, or `No ABC board reachable: the lanes are the statuses`.

### A ticket row

`▸ ABC-101 ★  Add export button  #2086 ✅ 👍 ⋯`

- `▸` when closed, `▾` when open. Then the key, `★` for the branch's ticket, and the summary.
- A pull request badge, when the [GitGud panel](gitgud.md) is on and one of your open pull requests or review requests has the key in its title or branch:
  - `#2086`, the pull request's number.
  - CI (the checks the service runs): `✅` passed, `❌` failed, `🟡` running, `⚪` none.
  - Review: `👍` approved, `✋` changes requested, `👀` review required.
  - `📝` for a draft, and `+1` when more pull requests carry the key. Your own pull request is shown before a review request.
- `⋯` opens the ticket's menu.

An open ticket shows, under its row:

- `Status`
- `Prio`: the priority and the ticket type.
- `Updated`: `just now`, `5m ago`, `3h ago`, `2d ago`, `2mo ago`.
- `PR`: the badge, when there is one.
- The first two lines of the description.

## Actions

### Clicking

- Click a ticket to open or close it.
- Click a lane's name to open or close the lane.
- Right-click a ticket, or click its `⋯`, for its menu.

### The ticket menu

| Entry | What it does |
| --- | --- |
| `Move to ▸` | Lists the lanes the ticket can move to (`→ IN REVIEW`) and `‹ Back`. Picking a lane asks you to confirm (see below). |
| `New branch` | Puts `! git switch -c ABC-101/` in the prompt box. Finish the name, then press Enter to run it. The prompt box must be empty first. |
| `Open in browser` | Opens the ticket in your browser. |
| `Open PR #2086` | Opens the pull request. Shown only when the ticket has a badge. |
| `Add link to prompt` | Inserts `[ABC-101: Summary](link)` at the cursor. |
| `Add full ticket to prompt` | Reads the whole ticket and inserts it as Markdown: its facts, description, linked issues, subtasks, attachments (images marked) and every comment with its author and date. |

### Moving a ticket

1. Drag the ticket onto another lane. The lane is highlighted and shows `← drop here`. Or pick a lane from `Move to ▸`.
2. A question appears under the ticket: `Move to DONE (COMPLETE)?  [Move]  [Cancel]`. The status in brackets is the one Jira will set, when its name differs from the lane's.
3. `Move` makes the change. The panel asks Jira which moves (transitions) the ticket can make now and takes the one into that lane. `Moving to DONE…` shows under the ticket until the board reloads.

One move runs at a time.

### Buttons under the board

- `↻ Refresh`: read the tickets, the branch's ticket and the board again now. Before setup it looks for a server again.
- `↗ Open ABC-101`: open the branch's ticket in your browser. Shown when the branch has a ticket.
- The settings are in `⚙` in the card's header, not under the board.

### Keys

When the board has the keyboard focus, `›` marks where you are.

On the board:

| Key | What it does |
| --- | --- |
| ↑ ↓ | Move between the board picker, the lanes and the tickets. |
| → ← | Open or close the ticket or lane. |
| Enter | On a ticket, open its menu. On a lane, open or close it. On the picker, list the boards. |
| m | Open the ticket's menu. |

In a ticket menu: ↑ ↓ move, Enter picks, → opens `Move to ▸`, ← or Backspace goes back or closes, m closes. An arrow never moves a ticket by itself.

In the move question: ← → or Tab switch between Move and Cancel, Enter answers, Backspace cancels.

In the board list: ↑ ↓ move, Enter or → picks, ← or Backspace closes.

## The band tab

The band is the row of tabs above the prompt. This tab shows the status of the branch's ticket, for example `🎫 In Review`. A status written in capitals is shown in normal case (`IN REVIEW` becomes `In Review`).

- `…` while the ticket loads.
- `–` when the branch name has no ticket key, or no Atlassian MCP server is connected.
- `set up`, dim, before a server and a site are chosen.

## When it refreshes

- The branch's ticket key is checked every minute. When it changes, that ticket is read.
- The ticket list is read again every 2 minutes while the card is shown, and when you open the panel (its band tab, or its card's ▸ / ▾) and the list is older than 2 minutes.
- Everything is read again after a move, after you save the settings, and when you press `↻ Refresh`.

## What it reads and writes

It reads, through the server you chose:

- `getAccessibleAtlassianResources`: your Jira sites, during setup.
- `getJiraIssue` and `searchJiraIssuesUsingJql`: the tickets.
- The moves a ticket can make: `getTransitionsForJiraIssue`, or `executeRead` on a server that has it.
- The boards and their columns: `executeRead`.

It also runs `git --no-optional-locks rev-parse --abbrev-ref HEAD` to read the branch name.

It writes one thing: moving a ticket (`transitionJiraIssue`). It does this only after you press `Move` in the question under the ticket.

`New branch` never runs git itself. It fills the prompt box, and you decide whether to send it.

## Settings

`⚙` in the card's header opens `⚙ Jira settings` with what is saved. Press it again to close the form once the panel is set up.

- `Server` and `Site`, when there is a choice.
- `Tickets (JQL)`: your own query. Leave it empty for the default.
- `Branch name`: for example `feature/{key}-` gives `! git switch -c feature/ABC-101-`. The default is `{key}/`.
- `List refresh`: how often the list reloads, 1, 2 or 5 min. The default is 2 min. Saving restarts the timer.
- A line `Ticket pattern: set in 🌿 Branch ⚙`. The pattern is edited in [Branch](branch.md)'s settings, and Jira reads it from there.
- `Save` and `Cancel`. Changing the server or site resets the board, so nothing is saved until you press `Save`. Save keeps a ticket pattern that Branch saved in the meantime.

These settings apply to every repo and session. The [Branch](branch.md) and [GitGud](gitgud.md) panels use the same ticket pattern. The refresh choice is kept in `jira:settings`. The board you pick is kept per project. All of it is in ClaudeDockula's store, under `plugins/store/` in your Claude folder (`$CLAUDE_CONFIG_DIR`, else `~/.claude`).

## Permissions

Calls to the Jira server go through Claude Code's permissions, and auto mode may refuse them. The card then shows the error with `Allow it in /permissions` under it. Add allow rules for the server's tools in `/permissions`, in the form `mcp__<server>__<tool>`, using the tool names listed above.

## Messages on the card

- `Loading your tickets…`, `Nothing assigned to you.`, `Couldn't load your tickets: <why>`
- `Loading ABC-101…`, `Couldn't load ABC-101: <why>`
- `Loading the board…`, `Couldn't read the board: <why>`

## Notices

Notices are short lines the band shows above its tabs. Errors stay until you close them with ✕; the others clear after about 8 seconds. Click a row marked ▸ to read its full text. On VS Code and mobile, which have no band, notices show at the top of each right dock.

- Moves: `ABC-101 → In Review`, `ABC-101 is already in DONE`, `Still moving ABC-102`, and `Couldn't move ABC-101 → DONE` with the reason, such as `Jira offers no move from To Do to DONE` or `The board changed: refresh and try again`.
- Boards: `Couldn't load <board name>`.
- New branch: `Name the branch, then press Enter`, `Clear the prompt box first`, `The prompt box didn't take the command`.
- Full ticket: `Reading ABC-101…`, `ABC-101 added to the prompt`, `Couldn't read ABC-101`.
- Others: `Could not open the browser`, `No open pull request carries ABC-101`, `ABC-101 is no longer on the board`, `The prompt box didn't take the link`.

## Limits

- Drag, right-click and the keys work on the terminal and the desktop app. On VS Code and mobile the board is drawn with buttons: a button per lane opens or closes it, each ticket has a button that opens it and a `⋯` button for its menu, and `Move to ▸` and the question's `Move` and `Cancel` are buttons too. There is no drag.
- The board picker is a drop-down on VS Code and a list of buttons on mobile.
- On a surface with no text fields, such as mobile, the settings form says `Edit the query and branch names from the terminal.`
- The list holds at most 50 tickets.
- Each dock that shows the panel has its own board.
