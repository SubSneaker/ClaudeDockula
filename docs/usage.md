# Using ClaudeDockula

This guide shows how to use ClaudeDockula once it is installed: where things appear, and how to arrange them.

A few words used throughout:

- **Band**: the row of emoji tabs just above the prompt. Each tab is one panel, with a short live summary after its emoji, such as `🌿 ABC-123 ·3`.
- **Dock**: a place that holds panel cards. A dock sits either on the right, in its own pane, or at the bottom, above the band. You can have several right docks and one bottom dock.
- **Panel** (or card): one section inside a dock, such as Branch or Jira. Each panel has its own guide under [docs/panels](panels/).
- **View**: a tab inside a dock. Each view holds its own set of panels, in its own order and layout.

## Install and update

See [Install](../README.md#install) and [Update](../README.md#update) in the README.

Right docks need Claude Code's fullscreen interface (`"tui": "fullscreen"` in your settings). Without it, the band still shows, but a right dock has no pane to open in.

## First run

When the plugin loads, the band appears above the prompt, aligned to the right:

```
                    🌿 ABC-123 ·3   ✅ 4/4   🕘 12   🎫 In Review   ➕
```

- There is one tab for each panel that some dock shows. At first that is Branch, Checks, Activity and Jira, all in one right dock called `Dock`, which starts closed.
- A tab whose panel is waiting for its first setup reads `set up`, dim. Open the panel to finish it (see [Troubleshooting](#a-panel-says-set-up)).
- ➕ at the end builds a new panel of your own (see [Add your own panel](#add-your-own-panel)).
- The band also shows two notices, `New panel: 💬 Slacker` and `New panel: 🐙 GitGud`. These two panels are off until you tick them in ⚙ Manage (see [Show or hide panels](#show-or-hide-panels)).

When the band runs out of room, the tabs drop their summaries and keep only their emoji.

## Open and close a dock

- **Click a tab on the band.** The dock that holds the panel opens, the panel's card opens, and the dock scrolls to it. The tab turns bold and underlined.
- **Click the same tab again** to close that dock.
- **✕ Close** in a dock closes it. Closing a dock keeps its panels and layout.
- **`/dock`** opens the dock you used last, or closes it when it is open.

When no open dock holds the panel, the tab opens the dock you used last. If that dock does not have the panel yet, the panel is added to its current view.

A new session starts with every right dock closed. The bottom dock stays open or closed as you left it.

A right dock looks like this (the controls drop their words when the pane is narrow):

```
       ⇄ Bottom  ▤ Layout  ⚙ Manage  ➕ Dock  ✕ Close

View 1  ➕ View
──────────────────────────────────────────────────────
▾ 🌿 Branch                                          ↓
ABC-123/add-export
↑2 ahead of origin
...
──────────────────────────────────────────────────────
▸ ✅ Checks                                        ↑ ↓
──────────────────────────────────────────────────────
▾ 🕘 Activity                                      ↑ ↓
...
```

From left to right, the controls on top are:

- **⇄ Bottom** (or **⇄ Right** on the bottom dock): move the dock to the other side.
- **▤ Layout**: stack the cards, or put them side by side.
- **⚙ Manage**: pick the panels, rename, remove. It reads **✓ Done** while open.
- **➕ Dock**: add another dock.
- **✕ Close**: close the dock.

## Show or hide panels

1. In the dock, press **⚙ Manage**. A `⚙ Manage · <view name>` card replaces the panels.
2. Each panel has a row with a checkbox: `[x] 🌿 Branch` is shown, `[ ] 💬 Slacker` is not. Press a row to tick or untick it. Its description is under it.
3. Press **✓ Done** to go back to the panels.

Ticking applies to the view you are on. The same panel can be ticked in several views or docks. Each of those shows the panel separately: for example, each dock that shows Jira has its own board.

**➕ Add panel** at the bottom of Manage does not add an existing panel. It starts a new panel of your own, the same as ➕ on the band.

## Reorder panels

Each card's header has **↑** and **↓** at its right end. Press them to move the card up or down in the view. The first card has no ↑, and the last has no ↓.

The same ↑ ↓ are on each ticked row in ⚙ Manage.

## Collapse a panel

Click the card's header line, the one with `▾` and the panel's name. The card closes to that one line and the `▾` turns into `▸`. Click it again to open it.

Each view remembers which of its cards are closed. Clicking a panel's band tab always opens its card.

Some panels read less often, or not at all, while their card is closed. Each panel's guide says when it refreshes.

## Make a second view

1. Press **➕ View** at the end of the dock's tab row. A new, empty view opens, with ⚙ Manage open on it.
2. Tick the panels it should show and press **✓ Done**.
3. Click a view's tab to switch to it. The tab of the view you are on is bold and underlined.

A view is named after its panel when it holds exactly one (`🎫 Jira`), and `View 2`, `View 3` and so on otherwise. When there are more tabs than room, `…+2` stands for the hidden ones; click it to go to the next one.

To rename a view or a dock, open ⚙ Manage. The `Dock` and `View` fields at the top hold their names: type a new one and press Enter. An empty view name gives the view its automatic name back.

To remove the view you are on, press **Remove view** in ⚙ Manage. A dock always keeps at least one view. Panels that no other view shows move to the view next to it.

## Put panels side by side

1. Press **▤ Layout**. A `▤ Layout · <view name>` card opens above the panels.
2. Next to `Direction`, pick **[Row (wraps)]**. **[Column]** stacks the cards again.
3. In a row, each panel gets a line of widths: `[Auto] [⅓] [½] [Full]`. The current one is bold and underlined.
4. Press **▤ Layout** again to close the card.

Cards fill each line from left to right, and start a new line when the next one does not fit. **Auto** cards are at least 36 columns wide and share whatever room the line has left. ⅓ and ½ take that share of the dock's width, and Full takes a whole line. A thin line separates cards that sit side by side.

When the dock is narrow, the choices shorten to `Col` `Row` and `A` `⅓` `½` `F`. The layout applies to the view you are on. A new view on the right starts as Column, and a new view at the bottom starts as Row.

## Move a dock to the bottom and resize it

Press **⇄ Bottom** in a right dock. The dock moves to the bottom, above the band, and its pane closes. If there was a bottom dock already, it moves to the right in its place.

The dock keeps its views and layout. There is one bottom dock. It has the same controls, as glyphs only, on its header line (here its view is set to Row, see [Put panels side by side](#put-panels-side-by-side)):

```
╶─────────────────── ⠿ drag to resize ───────────────────╴
── 🧭 Dock ─────────────────────────────────── ⇄ ▤ ⚙ ➕ ✕
View 1  ➕ View
──────────────────────────┬──────────────────────────── ▲
▾ 🌿 Branch             ↓ │▾ ✅ Checks              ↑ ↓ ┃
ABC-123/add-export        │Lint     ✔ passed  42s       │
...                                                     ▼
                  🌿 ABC-123 ·3   ✅ 4/4   🕘 12   ➕
```

- **Resize**: drag the top line, `⠿ drag to resize`, up to make the dock taller or down to make it shorter. While you drag it shows the new height, such as `↕ 14 rows`, with `· max` or `· min` at the limits. The height is kept.
- The dock starts at 12 rows. It is at least 5 rows tall, and at most what the band has room for: Claude Code keeps the band, prompt included, to about half the terminal.
- **Scroll**: when the cards are taller than the dock, use the scrollbar at the right edge. Click `▲` or `▼` to move one row, click the track above or below the thumb to move a page, or drag the thumb. When the bar has the keyboard focus, the arrow keys, Page Up, Page Down, Home and End also scroll. The bar is blank when everything fits.
- An open ▤ Layout card or ➕ Dock menu takes rows from the cards. If too few are left, the cards hide until you close it or drag the dock taller.
- **⇄** moves the bottom dock back to the right.

The grip and the scrollbar work on the terminal and the desktop app.

## Add a second right dock

1. Press **➕ Dock** in any dock. A small menu opens under the controls.
2. Press **New dock on the right**. (Use **New dock at the bottom** when there is no bottom dock yet. When there is one, the menu says which dock is in it, and that ⇄ swaps.)
3. The new dock, `Dock 2`, opens empty on ⚙ Manage. Tick its panels and press **✓ Done**.

Each right dock is its own pane, titled with its name, such as `🧭 Dock 2`. When several panes are open, Claude Code may show them as tabs.

To remove a dock, open its ⚙ Manage and press **Remove dock**. The last dock can't be removed. Panels that no other dock shows move to the dock you used last.

## Change a panel's settings

Panels ask for what they need the first time, inside their card. To change it later:

- **GitGud** has **⚙** in its card's header, before ↑ ↓. Press it to open its settings inside the card. If the card was closed, it opens.
- **Checks** and **Jira** have a **⚙** button inside the card, under their rows.
- **Slacker** keeps your watched words, set with **★ Watch** under its feed.
- **Branch** and **Activity** have no settings.

Each panel's guide lists its settings in full.

## Read notices

Notices are short messages the band shows above its tabs, newest first. On VS Code and mobile, which have no band, they show at the top of each right dock.

- `ℹ` is information, `✓` success and `⚠` an error.
- A row that ends in `▸` has more to read. Click it to open the full text (`▾`). An opened notice stays until you close it.
- **✕** closes a notice.
- Information and success notices clear after about 8 seconds. Errors stay until you close them.
- At most 3 show at once; `+N more` counts the rest.

When an update adds a built-in panel or changes one in a way you should know about, the band shows `New panel: <panel>` or `Updated: <panel>` once. These stay until you close them; click one to read what changed.

## Use /dock

| Command | What it does |
| --- | --- |
| `/dock` | Opens the dock you used last, or closes it when it is open. |
| `/dock right` | Opens the right dock you used last. With none, adds one, empty and on ⚙ Manage. |
| `/dock bottom` | Opens the bottom dock. With none, adds one, empty and on ⚙ Manage. |
| `/dock add` | Opens the New panel form (see below). |
| `/dock manage` | Opens the dock you used last on ⚙ Manage. |

## Add your own panel

You describe a panel, and Claude writes it for you in a plugin of your own.

1. Press **➕** on the band, **➕ Add panel** in ⚙ Manage, or run `/dock add`. The `✨ New panel` pane opens.
2. Fill in the form. Enter moves to the next field.
   - **Name** (required), for example `Deploys`.
   - **Icon**: one emoji, for example `🚀`.
   - **What it shows** (required), for example `the last 5 deploys and their status`.
   - **Buttons** (optional), for example `Open in browser, Re-run`.
   - **Data source**: `Not sure`, one of your connected MCP servers, `Shell command`, `Skill` or `Other`.
   - **Refresh**: `Manual`, `Every 30 s` or `Every 5 min`.
   - **Notes** (optional): anything else Claude should know.
3. Press **Send to Claude**. The form closes and a prompt asking Claude to build the panel goes into your prompt box. Read it and press Enter.
4. The first time, ClaudeDockula sets up your panels plugin, `dockula-panels`, and Claude asks you to run `/reload-plugins` before it checks its work. After that, Claude Code loads it every session.

Your panels appear on the band and in ⚙ Manage like the built-in ones. **Cancel** clears the form. If the prompt box does not take the prompt, your answers are kept for the next `/dock add`.

To remove one of your panels, press **Remove** on its row in ⚙ Manage. This puts a prompt in the prompt box asking Claude to delete its code. A panel that shows as `(not loaded)` in Manage is one whose plugin does not list it right now; **Remove** there just forgets it.

On mobile, the form asks you to use a terminal or the desktop app. How your panels are built is in [PANEL_GUIDE.md](../PANEL_GUIDE.md).

## The built-in panels

**🌿 Branch** shows the git branch of the folder Claude Code runs in: whether it is ahead of or behind its remote branch, and which files have changes. Its band tab shows the ticket key in the branch name and how many files changed, like `🌿 ABC-123 ·3`. It only reads git and refreshes every 20 seconds and after Claude edits files. [Branch guide](panels/branch.md).

**✅ Checks** runs your repo's lint, type, test, format or build commands in the background and shows whether each passed. The first time it sees a repo, its card asks which commands to run and saves them for that repo. Press **Run** on one check or **Run all**. Its band tab shows `4/4` when they passed, or the number that failed. [Checks guide](panels/checks.md).

**🕘 Activity** lists what Claude did in this session: the files it edited and its latest tool calls, each marked as running, done, refused or stopped. **Clear** empties both lists. It needs no setup and writes nothing. [Activity guide](panels/activity.md).

**🎫 Jira** shows your Jira tickets as a board, in the lanes of your team's board, with the ticket of your current branch marked `★`. You can drag a ticket to another lane (you confirm each move), start a branch for it, or add it to the prompt. It needs an Atlassian MCP server, connected in `/mcp`. [Jira guide](panels/jira.md).

**🐙 GitGud** (opt-in) lists the pull requests waiting for your review, your own pull requests and your issues, with CI and review state on each row. It reads GitHub, GitLab and Bitbucket Cloud. It can put a pull request in the prompt, write a PR description, warn you when another pull request changes the same files, and run a review in the background. It needs `gh` or `glab` signed in, or a Bitbucket token. [GitGud guide](panels/gitgud.md).

**💬 Slacker** (opt-in) shows what needs you in Slack: @mentions, direct messages, thread replies and words you watch. You can search Slack, add a message or thread to the prompt, and reply; a reply is posted only when you press **Send**. It needs the claude.ai Slack connector, connected in `/mcp`. [Slacker guide](panels/slacker.md).

## Where your settings and files live

Everything below is in your Claude folder: `$CLAUDE_CONFIG_DIR` when it is set, else `~/.claude`.

- **`plugins/store/`** holds ClaudeDockula's store: one JSON file per copy of the plugin, named like `claudedockula_<source>-<id>.json`. An installed copy and a dev copy (loaded with `--plugin-dir`) have separate files. The store keeps:
  - your docks, views and layout, including the bottom dock's height;
  - each panel's settings, such as your saved checks per repo, your Jira server, query and branch naming, GitGud's repos and services, and Slacker's watched words;
  - which panel updates you have already been told about.
- **`claudedockula/gitgud/`** holds the files GitGud writes: PR descriptions, commit summaries and background review logs.
- **`skills/dockula-panels/`** is your own panels plugin, set up by your first ➕ New panel. It is yours: updating ClaudeDockula never touches it, so back it up yourself, for example with `git init` there.

No passwords or tokens are kept in the store. For Bitbucket, GitGud keeps only your email and where the token lives.

### Reset

There is no reset button. To start over:

1. Quit every Claude Code session. A running session writes its layout back when it changes.
2. Delete the `claudedockula_…json` file in `plugins/store/`, or move it somewhere else to keep a copy.
3. Start Claude Code. You get the first-run layout, and each panel asks for its setup again.

To reset only the docks and keep the panels' settings, remove just the `"layout"` entry from that file while Claude Code is closed.

Your own panels are not affected by a reset. To remove them all, delete `skills/dockula-panels/`.

## Troubleshooting

### A panel says "set up"

The panel is waiting for its first setup. Click its band tab to open its card, which shows what it needs:

- **Checks**: pick the commands to run in this repo and press **Save**. Checks are saved per repo, so each new repo asks once.
- **Jira**: connect an Atlassian MCP server in `/mcp`, press **↻ Refresh**, then pick the server and site when the card asks.
- **GitGud**: tell it which service hosts your repo (see [GitGud can't tell the service](#gitgud-cant-tell-which-service-hosts-the-repo)), or finish the Bitbucket token setup.

### Auto mode refuses MCP calls

Jira and Slacker read through MCP servers (connectors that give Claude extra tools). Their calls go through Claude Code's permissions, and auto mode may refuse them.

- **Jira**: the card shows the error with `Allow it in /permissions` under it.
- **Slacker**: the card shows a line per refused call, such as `Claude Code blocked slack_search_public_and_private`, with the rule to add. **🔓 Allow Slack** puts a ready request for those rules in the prompt box, for you to read and send.
- **GitGud** stops reading Jira statuses until you press **↻ Refresh**; its rows then show only the ticket key.

To fix it, add allow rules in `/permissions` in the form `mcp__<server>__<tool>`, for example `mcp__claude_ai_Slack__slack_search_public_and_private`. Each panel's guide lists the tools it uses. Then press **↻ Refresh** in the card.

### gh or glab is not signed in

GitGud's band tab reads `needs gh` or `needs glab` when the CLI is missing, and `sign in` when it is not signed in. The card says the same.

1. Make sure the prompt box is empty.
2. Press **Install** (when Homebrew is installed) or **Sign in** in the card. This puts the command, such as `! gh auth login`, in the prompt box.
3. Send it and finish signing in.
4. Press **↻ Refresh** in the card.

For a GitHub Enterprise or self-managed GitLab host, the command includes `--hostname <host>`.

### GitGud can't tell which service hosts the repo

GitGud recognizes github.com, gitlab.com and bitbucket.org by name, and other hosts you are signed in to with `gh` or `glab`. For any other host, such as `git.acme.dev`, the card says `Couldn't tell which service hosts git.acme.dev.`

1. Press **Pick the service**.
2. Choose `GitHub or GitHub Enterprise`, `GitLab` or `Bitbucket Cloud`. The likeliest one is first, marked `(looks like it)`.
3. Confirm the service's web address, or type it if it differs from the remote's host.
4. Finish that service's sign-in or token setup.

If you pressed **Not now**, pick it later from GitGud's **⚙**, then **Change** next to `Service`. Bitbucket Server, Gitea and Azure DevOps are not supported yet.

### A right dock does not open

Right docks need the fullscreen interface (`"tui": "fullscreen"`). On VS Code and mobile there is no band, so the bottom dock does not show there; open right docks with `/dock` or `/dock right`.

### A panel shows "(not loaded)" in ⚙ Manage

Its plugin, usually your `dockula-panels`, did not list it. Run `/reload-plugins`. If you deleted the panel on purpose, press **Remove** on its row.
