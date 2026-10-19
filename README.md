# ClaudeDockula

A Claude Code plugin that puts a band of emoji tabs above the prompt and opens docks of live panel cards, either as right-side panes or as one bottom dock above the prompt. Built-in panels: [Branch](docs/panels/branch.md), [Checks](docs/panels/checks.md), [Activity](docs/panels/activity.md), [Jira](docs/panels/jira.md), [GitGud](docs/panels/gitgud.md) (your pull requests and reviews on GitHub, GitLab or Bitbucket) and [Slacker](docs/panels/slacker.md) (your Slack @s, DMs and thread replies). GitGud and Slacker are opt-in. Each link is that panel's user guide. You can also describe a panel of your own and have Claude build it.

**How to use: [docs/usage.md](docs/usage.md).** It covers opening docks, picking and ordering panels, views, side-by-side layouts, the bottom dock, `/dock`, your own panels, where settings live, and troubleshooting.

ClaudeDockula is a "mod", built on Claude Code's early-access plugin hooks API, which may change between releases without notice. Docked panes need the fullscreen TUI (`"tui": "fullscreen"`).

- Plugin id: `claudedockula` (ids starting `claude-` are reserved)
- Marketplace name: `dockula`, defined in `.claude-plugin/marketplace.json` with `"source": "./"`
- Version: lives only in `.claude-plugin/plugin.json`
- Contract for writing panels: `PANEL_GUIDE.md`

## Install

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

Settings are personal. Each panel asks for what it needs the first time, inside its card, and saves it in the plugin's store under `plugins/store/` in your Claude folder (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). Nothing personal is committed in this repo. What is kept, how to change it and how to reset it are in [Where your settings and files live](docs/usage.md#where-your-settings-and-files-live).

## Your own panels

Press ➕ on the band, describe the panel, and press Send to Claude. Claude builds it in your own panels plugin, `dockula-panels`, in `skills/dockula-panels/` under your Claude folder, which updates of ClaudeDockula never touch. The steps are in [Add your own panel](docs/usage.md#add-your-own-panel); the contract Claude follows is `PANEL_GUIDE.md` ("Your own panels").

- Its `"dependencies": ["claudedockula"]` is met by an installed copy or by a `--plugin-dir` / `CLAUDE_CODE_PLUGIN_DIRS` copy (the engine checks the plugin by name).

## The GitGud panel

🐙 GitGud (formerly the GitHub panel) lists the pull requests waiting for your review, your own, and your issues, on GitHub and GitHub Enterprise (through `gh`), GitLab (through `glab`) and Bitbucket Cloud (with an API token). It can also review a pull request in the background, in a separate, locked-down `claude -p` session that posts nothing. GitLab and Bitbucket support has not been tested against real accounts yet. Everything else is in [docs/panels/gitgud.md](docs/panels/gitgud.md).

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

## License

MIT. See [LICENSE](LICENSE).
