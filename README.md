# ClaudeDockula

A Claude Code plugin that puts a band of emoji tabs above the prompt and opens docks of live panel cards, either as right-side panes or as one bottom dock above the prompt. Built-in panels: [Branch](docs/panels/branch.md), [Checks](docs/panels/checks.md), [Activity](docs/panels/activity.md), [Jira](docs/panels/jira.md), [GitGud](docs/panels/gitgud.md) (your pull requests and reviews on GitHub, GitLab or Bitbucket) and [Slacker](docs/panels/slacker.md) (your Slack @s, DMs and thread replies). GitGud and Slacker are opt-in: add them from ⚙ Manage. Each link is that panel's user guide. Each panel is a collapsible section: a line, then its header (click it to open or close the panel), then its content. Each dock can have several views (tabs), panels lay out as Column or Row, and the bottom dock is drag-resizable with a scrollbar. The `/dock right|bottom|add|manage` command controls docks.

ClaudeDockula is a "mod", built on Claude Code's early-access plugin hooks API, which may change between releases without notice. Docked panes need the fullscreen TUI (`"tui": "fullscreen"`).

- Plugin id: `claudedockula` (ids starting `claude-` are reserved)
- Marketplace name: `dockula`, defined in `.claude-plugin/marketplace.json` with `"source": "./"`
- Version: lives only in `.claude-plugin/plugin.json`
- Contract for writing panels: `PANEL_GUIDE.md`

## Install

The repo must be reachable by you. While it is private, only people invited to it can install.

Inside a Claude Code session (v2.1.275 or later):

```
/plugin install claudedockula --marketplace SubSneaker/ClaudeDockula
```

Or in your shell, in two steps:

```
claude plugin marketplace add SubSneaker/ClaudeDockula
claude plugin install claudedockula@dockula
```

From the shell, one command also works on Claude Code v2.1.292 or later:

```
claude plugin install claudedockula --marketplace SubSneaker/ClaudeDockula
```

## Update

```
claude plugin update claudedockula@dockula
```

Then restart Claude Code or run `/reload-plugins`.

Auto-update is off by default for this marketplace. To turn it on, see [Turn on auto-update](https://code.claude.com/docs/en/plugins/host-marketplace#turn-on-auto-update).

## Develop

For development only. Load the repo as a dev copy. Either start Claude Code with:

```
claude --plugin-dir /path/to/ClaudeDockula
```

or set `CLAUDE_CODE_PLUGIN_DIRS` to the repo path in the `env` block of `~/.claude/settings.json`. It only works in user settings; a project's settings can't set it.

A dev copy overrides an installed copy and hot-reloads when you save files. The plugin's saved settings and layout are kept per source, so a dev copy and an installed copy have separate settings.

## Check

Before a release:

```
npx -y -p typescript@5 tsc -p .
claude plugin validate .
claude plugin test .
```

- Any TypeScript 5+ `tsc` works; `npx -y -p typescript@5 tsc` is the one the panel prompts name. `tsconfig.json` extends `./.claude-plugin/types/tsconfig.json`, which the engine generates (gitignored) the first time it loads the plugin from a folder you own. Load the plugin once (see Develop) before running `tsc`.
- `claude plugin validate .` also validates the marketplace file. Add `--strict` to treat warnings as errors.
- `claude plugin test .` runs every `*.test.ts` and `*.test.tsx` file in the folder.

## Settings

Settings are personal. Each panel asks for what it needs the first time, inside its card, and saves it with the plugin's own store under `plugins/store/` in your Claude folder (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). The gear button changes them later.

- Check commands are per repo.
- Jira server, site and search, and branch naming, are global.
- GitGud: the repos you added, the scope, the service of each host, the refresh interval, the Haiku switch and the background review settings are global. For Bitbucket it keeps your email and where the token lives, never the token.
- A card that has settings shows ⚙ in its header, before ↑ ↓ (GitGud's: repos, services, refresh, Haiku, and what a background review uses and how it tells you it finished).
- Slacker keeps your watched words, when you last opened it, and your Slack user id and name.
- When an update adds or changes a built-in panel, the band shows a notice once; it stays until you close it. Opt-in panels such as Slacker are added from ⚙ Manage.
- Nothing personal is committed in this repo.

## Your own panels

Press ➕ on the band, describe the panel, and press Send to Claude. The first time, ClaudeDockula sets up your own panels plugin, `dockula-panels`, in `skills/dockula-panels/` under your Claude folder (`$CLAUDE_CONFIG_DIR`, else `~/.claude`), and puts a prompt in the prompt box asking Claude to build the panel there by `PANEL_GUIDE.md` ("Your own panels").

- The first time, Claude asks you to run `/reload-plugins` before its checks: loading the new plugin lays the types it type-checks against. After that, Claude Code loads it every session and reloads it on save.
- Your panels show as cards in the docks and as tabs on the band like the built-ins. They can be dragged, right-clicked and typed into on the terminal and desktop; on VS Code and mobile their targets are buttons.
- The folder is yours: updating ClaudeDockula never touches it. Back it up yourself, for example with `git init` there.
- Its `"dependencies": ["claudedockula"]` is met by an installed copy or by a `--plugin-dir` / `CLAUDE_CODE_PLUGIN_DIRS` copy (the engine checks the plugin by name).
- To remove a panel, press Remove on its row in ⚙ Manage: Claude deletes its code. A panel whose plugin does not list it keeps its place (it may only be loading) and shows in Manage as `(not loaded)`; Remove there forgets it.

## The GitGud panel

🐙 GitGud (formerly the GitHub panel) lists the pull requests waiting for your review, your own, and your issues, with CI and review state on each row. It is off until you tick it in ⚙ Manage. Its rows, actions, overlap warning, PR description and commit summary, settings and what it reads and writes are in [docs/panels/gitgud.md](docs/panels/gitgud.md).

It reads GitHub and GitHub Enterprise through the [GitHub CLI](https://cli.github.com) (`gh`, signed in), GitLab through the [GitLab CLI](https://gitlab.com/gitlab-org/cli) (`glab`, signed in), and Bitbucket Cloud with an API token from your keychain or an environment variable. It finds the service from the repo's git remote, and asks when it can't tell. GitLab and Bitbucket support has not been tested against real accounts yet.

- **Review in background**: a separate, locked-down `claude -p` session reviews a clean copy of the PR (its committed files at its head commit, never your checkout) and drafts a review. It posts nothing. Its permission asks show in the card (Allow once, Allow for this review, Deny), never in your conversation. Its progress shows on its row, and everything it does is logged beside the review. While one runs, the band tab shows 🤖 (`🤖❓` when it waits for you).

## Safety

What the plugin runs or writes by itself:

- Read-only git: `git --no-optional-locks status` and `rev-parse`; GitGud adds `merge-base`, `diff`, `log`, `symbolic-ref`, `config --get-regexp` (remote URLs) and `ls-remote --get-url` (no network call).
- Read-only `gh`: `auth status`, `repo view`, `search repos`, `pr list|view|checks|diff`, `run view`, GraphQL queries (never a mutation) and one REST read, a PR's file list (`gh api repos/<owner>/<repo>/pulls/<n>/files`).
- Read-only `glab`: `auth status` and `glab api` GETs on a listed set of read paths.
- Bitbucket Cloud: GET requests to `api.bitbucket.org` on a listed set of read paths, with your API token, which is read from the keychain (`security find-generic-password` or `secret-tool lookup`) or from `BITBUCKET_TOKEN`, `BITBUCKET_API_TOKEN` or `ATLASSIAN_API_TOKEN`. The token is kept in memory only and sent only to `api.bitbucket.org`.
- For a repo on an unknown host, a few GET requests to that host with no credentials, only to guess its service.
- Every `gh`, `glab`, `git` and keychain command and every web request goes through an allowlist guard that refuses anything else, so a bug cannot merge, comment, push or check out. Other installed plugins can see this plugin's commands and requests, as with any plugin.
- The check commands you picked for a repo, when you press Run. They run as you typed them and may write files (a format script, a build).
- A link you open from a panel, with `open` (macOS), `xdg-open` (Linux) or `cmd /c start` (Windows).
- The first ➕ New panel writes the panels plugin's starter files under `skills/dockula-panels/` in your Claude folder, never over an existing file.
- The only Jira write is moving a ticket, always after you confirm.
- Slacker reads Slack through the claude.ai Slack connector (read-only tools) every 30 s and when opened, only while it is in a dock view.
- ✦ Polish and "Let AI draft it" send the message's thread text to Claude Haiku.
- The only Slack write is a Slacker reply, posted once when you press Send under it.
- GitGud writes only its own Markdown files and review logs, under `claudedockula/gitgud/` in your Claude folder (files from the GitHub panel stay in `claudedockula/github/` and still open). A background review copies the PR's committed files into a temporary folder (`git archive`, `tar`, removed after) and runs `claude -p` there with none of your settings, plugins or MCP servers and read-only tools. Of your allow rules it borrows only `WebFetch(domain:…)` ones (your deny rules all apply); only you answer its other permission asks, in the card.

Everything else it only puts in the prompt box for you to send: "New branch" fills `! git switch -c …`, "Check out" fills `! gh pr checkout …` (or `! glab mr checkout …`, or a `git fetch` and `git switch` for Bitbucket), Sign in fills `! gh auth login` or `! glab auth login`, the Bitbucket keychain command is only copied for you to run, actions that change something fill a prompt. Atlassian and Slack MCP calls may need allow rules in `/permissions` under auto mode; Slacker's 🔓 Allow Slack button puts a ready request for them in the prompt box.
