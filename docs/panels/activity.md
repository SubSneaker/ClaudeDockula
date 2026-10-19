# 🕘 Activity

The Activity panel shows what Claude did in this session: the files it edited and its latest tool calls.

## The card

**Files edited · N**

- Each file Claude changed with Edit, Write or NotebookEdit, the most recently edited first, with `×N` for how many edits it got. Only edits that went through count.
- Paths inside the session's folder are shown relative to it: the file name first, then its folder, dim.
- Up to 5 files (10 or 20 if you set that in ⚙), then `+N more`. `None yet.` when Claude has edited nothing.

**Recent calls · N**

- The 5 newest tool calls (10 or 20 if you set that in ⚙), each with a mark:
  - `⋯` yellow: still running.
  - `✓` green: done.
  - `✗` red: refused, or the tool reported an error.
  - `-` dim: stopped, because the turn was interrupted or failed.
- Then the tool's name. For a tool from an MCP server (a connector that adds tools, such as Slack or Jira), the server's name.
- Then, dim, a short summary of the call: its description, file path, search pattern, query, URL, skill or command, whichever it has first. For an MCP tool, the tool's name.
- Calls made by other agents (subagents, teammates and workflow agents) are listed too, unless you hide them in ⚙.

`Clear` empties both lists. Calls still running stay, so you still see how they end.

Before the first call the card says `No activity yet: tool calls and edited files show here.`

## The band tab

The band is the row of tabs above the prompt. This tab shows how many tool calls the list holds, for example `🕘 12`, and `50+` once it is full. `Clear` brings it back down.

## When it updates

As Claude works: each call shows when it starts and gets its mark when it ends.

## What it reads and writes

- It watches Claude's tool calls. It never changes or blocks a call.
- It writes only its settings (see below).

## Settings

The ⚙ in the card's header opens the settings. Each change saves at once, and Done closes the view.

- Rows shown: 5 (default), 10 or 20.
- Calls by other agents: Show (default) or Hide. The log still keeps hidden calls, so turning this back on shows them again.

The choices are saved under `activity:settings`. Reset all settings in ⚙ Manage clears them.

## Notices

None.

## Limits

- It keeps the last 50 calls and the last 100 edited files.
