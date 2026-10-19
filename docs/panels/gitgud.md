# 🐙 GitGud

The GitGud panel lists the pull requests waiting for your review, your own pull requests, and the issues assigned to you, with CI and review state on each row. It reads GitHub (including GitHub Enterprise Server), GitLab (gitlab.com and self-managed) and Bitbucket Cloud. It can put a pull request or its review comments in the prompt, write a PR description for your branch, and warn you when another open pull request changes the same files as you.

CI ("continuous integration") means the checks the service runs on a pull request, such as tests and lint. GitLab calls a pull request a merge request (MR) and numbers it with `!`, as in `!42`; the panel uses GitLab's words on GitLab rows.

GitGud was called the GitHub panel before. Your settings, added repos and file list move over by themselves.

GitLab and Bitbucket support was built from their documentation and has not been tested against real accounts yet. If something looks wrong on either, please report it.

## Where it is

GitGud is in the main dock from the start. It reads nothing until its service answers. Open ⚙ Manage on a dock (or run `/dock manage`; see [Show or hide panels](../usage.md#show-or-hide-panels)) to move or hide it. If you had the GitHub panel on, it stays where it was under its new name, and the band shows `Updated: 🐙 GitGud` once.

## What it needs

One of these, for the service that hosts your repo:

- `GitHub`: the [GitHub CLI](https://cli.github.com), `gh`, signed in to github.com, or to your GitHub Enterprise host with `gh auth login --hostname <host>`.
- `GitLab`: the [GitLab CLI](https://gitlab.com/gitlab-org/cli), `glab`, signed in to gitlab.com or to your own GitLab host. GitGud reads GitLab only through `glab`.
- `Bitbucket Cloud`: a Bitbucket API token, kept in your OS keychain or in an environment variable. There is no CLI to install. See Setting up Bitbucket.

The panel looks for `gh` and `glab` on your PATH, then in `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin`. Until the CLI works, the card says what is missing:

- `Checking gh…` (or `Checking glab…`)
- `Needs the GitHub CLI: install gh (cli.github.com), then ↻ Refresh.` When Homebrew is installed, `Install` puts `! brew install gh` in the prompt box for you to send.
- `Needs the GitLab CLI: install glab (gitlab.com/gitlab-org/cli), then ↻ Refresh.` When Homebrew is installed, `Install` puts `! brew install glab` in the prompt box.
- `Sign in to GitHub: press Sign in (fills gh auth login), then ↻ Refresh.` On another host: `Sign in to <host>: press Sign in (fills gh auth login --hostname <host>), then ↻ Refresh.`, or the same with `glab auth login --hostname <host>` for GitLab. `Sign in` puts that command in the prompt box for you to send.
- `Couldn't reach GitHub: trying again shortly.` (or GitLab, Bitbucket; `trying again less often` from the second failed try), with the error under it. This happens when you are offline or the service does not answer. It is not treated as signed out, and the panel tries again by itself.

`Install` and `Sign in` need an empty prompt box. Press `↻ Refresh` after the command finished.

## How it finds the service

GitGud reads the git remote of the session's folder: the remote your branch tracks, else `origin`, else `upstream`, else the first one. It applies your git `insteadOf` rewrites first (`git ls-remote --get-url`, which makes no network call). Then it takes the first of these that names the service:

1. The host is github.com, gitlab.com or bitbucket.org. `ssh.github.com`, `altssh.gitlab.com` and `altssh.bitbucket.org` count as those.
2. You picked a service for this host before.
3. `gh auth status --hostname <host>` or `glab auth status --hostname <host>` says you are signed in to that host.
4. Otherwise it asks you (see The setup card). Before asking, it takes a quick look at the host: a few GET requests to fixed paths, with no credentials. A match only puts its guess first in the question; it never decides alone.

A remote on Azure DevOps or Bitbucket Server, or a host that looks like Bitbucket Server or Gitea, gets `GitGud doesn't read Azure DevOps yet.` (or `Bitbucket Server`, `Gitea`).

When the folder has no remote, or is not a git repo, GitGud reads github.com, or the service you picked for such folders, and shows All repos.

### The setup card

When it can't tell the service:

- `Couldn't tell which service hosts git.acme.dev.` with `Pick the service` and `Not now`. After `Not now` the card says `GitGud needs to know which service this is: ⚙ Settings, then Change next to Service.`
- With no remote, GitGud reads the default host (github.com unless you picked another). When that host's CLI is missing or signed out, the card is its install or sign-in card, as for any host. Only when the service itself is unknown does it say `This folder has no git remote. Pick a service to see your pull requests anywhere, or ➕ add a repo.` with `Pick a service`; that asks for the service's web address (`https://github.com` is offered; type another), then which service it is.

The questions:

1. `Which service hosts <host>?` with `GitHub or GitHub Enterprise`, `GitLab`, `Bitbucket Cloud` and `Not now`. The guess from the quick look comes first, marked `(looks like it)`. If you type Bitbucket Server, Gitea or Azure DevOps, the notice says `GitGud doesn't read <name> yet.`
2. For a host other than github.com, gitlab.com and bitbucket.org: `What's the web address of that service? Pick it or type one.` `https://<host>` is offered. Type another address when the remote's host is an SSH alias or the service's web address differs.
3. Then that service's own setup: the install or sign-in card for GitHub and GitLab, or Setting up Bitbucket.

A GitHub or GitLab host is saved once its CLI answers. A Bitbucket setup is saved only once Bitbucket accepts the token. `⚙ → Service → Change` asks question 1 again for that host.

### Setting up Bitbucket

Bitbucket Cloud is read with an API token sent with your Atlassian account email. GitGud never asks you to type the token into Claude Code, and never stores it.

1. Create an API token with the scopes `read:pullrequest`, `read:repository`, `read:user` and `read:workspace` (`read:pipeline` is optional): id.atlassian.com → Security → API tokens.
2. On the card, press `Set up`, which goes straight to these questions (or `⚙ → Service → Change` on the bitbucket.org row) and answer:
   - `Where should GitGud read your Bitbucket API token from?` `Keychain (recommended)` or `An environment variable`. Keychain is offered when the machine has `/usr/bin/security` (macOS) or `/usr/bin/secret-tool` (Linux).
   - `Which email is your Atlassian account under? It's sent with the token.` A saved email is offered first; otherwise type it under Other.
   - For an environment variable: `Which environment variable holds it?` The three are offered as choices. Claude Code only lets a plugin read variables whose names are written in its code, so other names can't be read; the notice says `GitGud can read BITBUCKET_TOKEN, BITBUCKET_API_TOKEN, ATLASSIAN_API_TOKEN: pick one of those`.
3. Put the token where you said:
   - Keychain: the card shows the command to run in your own terminal, and `Copy command` copies it. It asks for the token, so paste it there. GitGud never runs it for you.
     - macOS: `security add-generic-password -a you@example.com -s gitgud-bitbucket -w`
     - Linux: `secret-tool store --label=GitGud service gitgud-bitbucket account you@example.com`
   - Environment variable: `Set BITBUCKET_TOKEN before starting Claude Code (or in settings.json "env"), then Check.`
4. Press `Check`. GitGud asks Bitbucket who you are:
   - `Signed in to Bitbucket as Ada Lovelace.` The setup is saved.
   - `Bitbucket refused the token. Check the email and that it isn't expired.`
   - `No token found in the keychain (service gitgud-bitbucket, account <email>)` or `No token in $NAME`, when there is nothing to send. `Cancel` closes the card.
   - `The token lacks a scope: it needs read:pullrequest and read:user.`

GitGud reads the token again from the keychain or the variable when a session starts, and after Bitbucket refuses it. It uses one Bitbucket account at a time.

## What each service offers

| | GitHub | GitLab | Bitbucket Cloud |
| --- | --- | --- | --- |
| Tabs | To review, Mine, Issues, Search | To review, Mine, Issues, Search | To review, Mine, Search (no Issues) |
| To review | everywhere you can reach | everywhere you can reach | only the followed repos: the session's repo and the ones you added with ➕ |
| Search | This or All | This or All | the followed repos only, by title |
| CI on rows | yes | yes, read for the rows shown | yes (the commit statuses any CI posts), read for the rows shown |
| Failed-job log and its `💡` line | yes | yes | no: open the pipeline on Bitbucket |
| Review state | yes, with the `team` marker | yes, no `team` marker | yes, no `team` marker |
| Labels | yes | yes | none (Bitbucket has no PR labels) |
| Overlaps | up to 50 open PRs | up to 20 open MRs | up to 20 open PRs, most recently updated |
| Comparing a file | yes | yes | yes |
| Background review | yes | yes | yes |
| PR template | `.github/…` (see **This branch**) | `.gitlab/merge_request_templates/` | none |
| Check out fills | `! gh pr checkout <n>` | `! glab mr checkout <n>` | `! git fetch origin <branch> && git switch <branch>` |
| Rate limit | pauses when fewer than 100 calls are left | waits longer after each refusal | pauses 5 minutes when Bitbucket says it is near its limit |

## The card

From top to bottom: the tabs, the repos row, the list, what went wrong with the last load (if anything), then the sections that have something to show (overlaps, background reviews, this branch, files), then `↻ Refresh` (`↻ Refreshing…` while it loads). `⚙` is in the card's header, before ↑ ↓.

### Tabs

`👀 To review 1  🙋 Mine 3  📌 Issues 2  🔍 Search`

- `To review`: open pull requests that ask for your review, yourself or (on GitHub) through a team, in repos that are not archived.
- `Mine`: your open pull requests.
- `Issues`: open issues assigned to you. Not shown on Bitbucket.
- `Search`: see Searching.

The number is how many each holds, up to 30. The chosen tab is bold and underlined. On a narrow card only the icons and numbers show.

### The repos row

`Repos  acme/webapp +1     This · All  ➕`

- `This`: the repo of the session's folder, plus the repos you added. `All`: every repo your account can reach. Your choice is saved. On Bitbucket, All covers your own pull requests in all your workspaces; To review and Search stay on the followed repos.
- `➕` adds a repo. A question offers up to 3 of your repos with the most recent activity; you can also type the repo's path (`owner/name`, or `group/sub/project` on GitLab), a link to it, or words to search for. Words bring a second question listing up to 3 matches. When there is no recent repo to offer, the question offers `Show all repos`, which switches to All. A link to a repo on another host adds it, once that host is set up.
- When the session's folder is not a repo GitGud can read and you added none, the panel shows All and says so.

### A row

`✅ #2086 Add CSV export option on label es…  👀  2d ⋯`

- CI state of the pull request's latest commit: `✅` passed, `❌` failed, `🟡` running, `⚪` none. An issue shows `📌` instead.
- The number, in bold (`!42` on GitLab), and the title.
- Review state: `👍` approved, `✋` changes requested, `👀` review required. Blank when none of these.
- How long since it was last updated: `5m`, `3h`, `2d`, `6w`, `2y`.
- `⋯` opens the row's menu.
- Draft pull requests are dim.

Under it, dim:

- Who opened it (left out on your own), `💬 3` comments, `🎫 In Review` (the Jira status of the ticket in its title or branch, or the ticket key when the status is not known), `team` (your review was asked of a team, not of you; GitHub only), `draft`.
- A one-line summary written by Claude Haiku, a small, fast Claude model. See Claude Haiku.

The card shows 8 rows. `+N more` shows 8 more.

An empty list says `No review requests for you.`, `No open pull requests of yours.` or `No open issues assigned to you.` Before the first load: `Loading your pull requests and issues…`.

### An opened row

Click a row to open it. A pull request shows:

- `CI`: each failed job (up to 3) as `❌ <job>`, then `💡` and Haiku's one line on why it failed, then up to 2 lines from the job's log (`Reading the log…` while it is read), or the service's own description. Bitbucket shows no log lines. Then `+N more failed`, the jobs still running (`🟡 <names>`), `✅ N passed` and `⚪ N skipped`. `No checks` when it has none, `Loading the checks…` and `Couldn't load the checks: <why>` otherwise.
- `Review`: `👍 Approved`, `✋ Changes requested`, `👀 Review required` or `No review yet`, with `· asked of a team` when it was asked of a team.
- `Branch`: its branch and the branch it goes into, `feature/x → develop`.

Pull requests and issues both show:

- `Jira`: the ticket key and its status.
- `Labels`
- `About`: the start of its description, when there is no Haiku summary.

While an opened pull request has checks still running, they are read again every minute while the card is shown.

## Row actions

Right-click a row, click its `⋯`, or press Enter or m on it for its menu.

| Entry | Shown for | What it does |
| --- | --- | --- |
| `🧐 Review here` | pull requests | With a `pr-review` command or skill (yours, a plugin's or the repo's), puts that command and the link, such as `/pr-review <link>`, in the empty prompt box; press Enter to run it. Without one, it inserts a request for Claude to review the pull request and draft comments for you to post, posting nothing itself. |
| `🤖 Review in background` | pull requests | See **Background review**. |
| `🔧 Fix failing CI` | pull requests with failing CI | Reads the failed jobs and their logs (where the service gives them), then inserts a prompt asking Claude to find and fix the cause. When the pull request's branch is not checked out here, the prompt asks Claude to have you run the check-out command first. For a pull request of another repo, it asks Claude to stop and tell you. |
| `💬 Address review comments` | your own pull requests | Inserts a prompt with each unresolved review thread (file and line, the last lines of the diff, every comment), asking Claude to make the changes and to tell you about any comment it disagrees with. |
| `➕ Add link to prompt` | all | Inserts `[#2086 title](link)`. |
| `➕ Add full thread to prompt` | all | Inserts the description, comments, reviews and review threads, marked as material to read and not instructions to follow. |
| `📋 Copy ▸` | all | Opens the copy entries: `📋 Link`, `📋 Title + body`, `📋 Full thread`, and `📋 Diff` for pull requests. `‹ Back` goes back. |
| `🌐 Open in browser` | all | Opens it on its service. |
| `🎫 Open ABC-101` | rows whose title or branch holds a ticket key | Opens the Jira ticket in your browser. Needs the [Jira panel](jira.md) set up. |
| `🌿 Check out` | pull requests of this folder's repo | Puts the service's check-out command (see **What each service offers**) in the empty prompt box for you to send. |

"Puts in the empty prompt box" means: when the box already has text, nothing changes and the notice `Clear the prompt box first` shows. "Inserts" means the text goes in at the cursor. Either way, nothing is sent until you send it.

Copies go to the clipboard of the device you pressed on. A copy over 64,000 characters, or one the clipboard refuses, is saved to a file instead, and the notice gives its path: `<Claude folder>/claudedockula/gitgud/clip-<number>-<date>-<time>.md`.

### Keys

When the list has the keyboard focus, `›` marks where you are.

| Key | In the list | In a menu |
| --- | --- | --- |
| ↑ ↓ | Move between rows and `+N more`. | Move the highlight. |
| → | Open the row. | Open `📋 Copy ▸`. |
| ← | Close the row. | Go back, or close the menu. |
| Enter | Open the row's menu, or show more on `+N more`. | Pick the entry. |
| m | Open the row's menu. | Close the menu. |
| Backspace | | Go back, or close the menu. |

## Searching

The Search tab searches open pull requests (and, on GitHub and GitLab, issues) in the repos the scope covers (This or All). On Bitbucket it searches the titles of open pull requests in the followed repos. Press `🔍 Search…`, type your words and confirm. GitHub's and GitLab's search words work. Up to 20 results show like the other lists.

- `Search  <your words>` and `🔍 New search` show above the results. The question also offers `Clear search`.
- `Searching…`, `Nothing found.` and `Couldn't search: <why>` say how it went.

## This branch

When the session's folder is on a branch other than the repo's default branch, the card shows `🌿 This branch · <branch>` with two buttons. Each asks Claude Haiku to write a Markdown file from what the branch changed since it left its base branch: the commits, the list of changed files and the diff (lock files left out). The base is the branch its pull request goes into, else the repo's default branch, compared with `origin/<base>` as you last fetched it.

- `📝 PR description`: follows the repo's pull request template when it has one. On GitHub: `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `docs/pull_request_template.md`, `pull_request_template.md`, or the first `.md` file in `.github/PULL_REQUEST_TEMPLATE/`. On GitLab: `.gitlab/merge_request_templates/Default.md`, or the first `.md` file in that folder. Bitbucket keeps its template in the repo's settings, so none is read. Without one it writes `## Summary`, `## Changes` and `## Testing`.
- `🧾 Commit summary`: one line per changed file, `- MODIFIED src/a.ts — reason` (or `ADDED`, `DELETED`, `RENAMED`). When Haiku gives no reasons, every file is still listed, with `—`.

The button reads `Writing…` meanwhile. The file is saved under `<Claude folder>/claudedockula/gitgud/<host>/<repo>/`, never inside your repo, and listed under `Files`. `<repo>` is the repo's path with `/` turned into `__`, as in `gitgud/github.com/acme__webapp/` or `gitgud/gitlab.com/group__sub__project/`. The notice `PR description ready` (or `Commit summary ready`) gives its path. On failure a line under the buttons says why, for example `Couldn't write the PR description: no changes since origin/main`.

## Files

`📄 Files · N` lists the files the panel wrote, newest first: `🧐` a background review, `📝` a PR description, `🧾` a commit summary, each with its age. A review's logs are opened from its row instead (see `Background review`). Up to 5 show, then `+N more`. The list keeps up to 30 files across sessions; a file you deleted drops off.

Files written by the GitHub panel stay where they were, under `<Claude folder>/claudedockula/github/<owner>__<repo>/`. They are still listed and still open.

Each row has:

- `Open`: shows the file in a pane on the right.
- `↗`: opens the file in your default app for Markdown.
- `📋`: copies its text (up to 64,000 characters).
- `➕`: inserts `@<path>` in the prompt, so Claude reads the file when you send.

The file pane shows the title, the path, then `↗ Open file`, `📋 Copy`, `➕ Add to prompt` and `✕ Close` (Esc closes it too), then the file as Markdown. A very long file is cut, with `Cut to fit here; ↗ Open file shows it whole.` When the pane closes, the docks take back their width.

## Overlaps

When you have changes in the session's repo, the card lists the other open pull requests that change the same files, under `⚠️ Overlaps · N PRs`.

- Your changes are your uncommitted and untracked files, plus what your branch committed since it left `origin/<base>`.
- They are compared with the files of the session repo's open pull requests: up to 50 on GitHub, read in one call; up to 20 on GitLab and Bitbucket, read one by one and kept until their head commit changes. Your branch's own pull request is left out.
- A line under the list says what was compared: `3 files changed here, compared with origin/develop as last fetched.` The panel never runs `git fetch`.

Each row reads `#2096 linus  ABC-924/fix-sidebar…  3 files`.

- Press a row for its menu:
  - `🌐 Open in browser`
  - `🧩 Add to prompt (conflict resolution)`: reads both sides' changes to the shared files (up to 5 files, up to 40,000 characters in all) and inserts a prompt. It asks Claude to show where the changes collide and how to reconcile them, and to give you any git commands to run yourself rather than run them.
  - `📋 Copy link`
- `▸` shows the shared files under each row (up to 5, then `+N more`); `▾` hides them. `GitHub listed only its first 100 files.` (or `<service> listed only some of its files.`) shows when a pull request has more.
- `↻` next to the heading checks again now.

### Comparing a file

Press a shared file to compare it in a pane on the right, titled `🔀 <file> · #<n>`:

- The file's path, the pull request, and what "yours" means: `Yours: the working tree vs origin/<base> at the merge-base <commit>, uncommitted and untracked changes included.` The merge-base is the commit where your branch left the base.
- Whether the changes touch the same lines: `2 hunks overlap · base lines 120–140, 300–310`, or `No hunks overlap: the two change different lines.` A hunk is one block of changed lines.
- `Your changes`, then `#<n>'s changes`. Hunks that collide are flagged `⚠ also changed in #<n>` and `⚠ also changed by you`.
- When the pull request branched from another commit, line numbers are approximate, and a note says so. When its base can't be checked here because its head commit isn't fetched, the note says `Can't confirm #<n>'s base here (its head isn't fetched), so line numbers may be approximate.`
- Buttons: `➕ Add to prompt` (the conflict-resolution prompt for this file), `📋 Copy` (both diffs as Markdown), `↗ Open on GitHub` (the pull request's files on its service), `↻` (read again), `✕ Close`. Esc closes the pane too.

## Background review

`🤖 Review in background` asks Claude to draft a review of a pull request while you keep working. The draft is saved as a file. Nothing is posted to the service.

### How it runs

The panel starts a separate Claude Code session for the review, in the background, with `claude -p`. That session is locked down:

- None of your settings load: no hooks, no plugins (ClaudeDockula included), no MCP servers. Nothing from the pull request's own `.claude` folder or `.mcp.json` loads either.
- Its tools are Read, Grep and Glob, plus WebFetch and WebSearch while `Web lookups` is on. It cannot run commands, edit files or post anything.
- It may read its copy of the pull request and your skill folders. Anything else needs your answer (see `Asks`).
- Its settings deny reading these: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*` and `.npmrc` files anywhere in its copy (these patterns do not reach your skill folders), and `~/.ssh`, `~/.aws`, `~/.config/gh` and `~/.netrc`. Your own deny rules apply too.
- It may fetch from a domain your allow rules name as `WebFetch(domain:<host>)` (or `WebFetch(domain:*.<host>)`) without asking. A bare `WebFetch` or `WebSearch` allow rule, and every WebSearch rule, is not borrowed: those calls ask you in the card. No other allow rule of yours is used.
- It stops after 30 turns or 30 minutes, and keeps no session history.

It uses your Claude account and plan like any other session, so a review counts toward your usage. The model is Claude Sonnet unless you pick Opus in `⚙`.

Up to 2 reviews run at once.

### The clean copy

The reviewer works in a temporary folder that holds only the pull request's committed files at its head commit, never your checkout. When that commit is already on this machine (in the session's repo), the panel copies its files there with `git archive`, leaving out `.claude` and `.mcp.json` at any depth and `.git`, `.githooks` and `.git-hooks` folders. The panel never fetches, checks out or changes your repo.

The copy holds the files as they are stored in git. Every filter driver your git config defines (such as git-lfs or git-crypt) is switched off for the copy, so nothing is decrypted or downloaded: an encrypted file stays encrypted, and a git-lfs file is its pointer. This needs git 2.41 or later; with an older git the reviewer gets no copy, and the card says why.

The temporary folder is under your own temp folder (`$TMPDIR`, else `~/.cache`). When `TMPDIR` is not an absolute folder, the review does not start and the card says why: nothing is made under the session's folder.

When there is no copy, the reviewer works from the diff and the discussion only. This happens when the head commit is not on this machine (run `git fetch` yourself to get it), or the pull request is in another repo. On GitLab, other people's merge requests are often in this case, since their heads are not fetched by default. Bitbucket gives a short commit hash, which the panel looks up in your repo. The row says `reviewing, diff only`, the review file's header says why, and so does the log.

The temporary folder is deleted when the review ends. One left behind by a session that quit mid-review is deleted at a later session start, once it is 2 hours old.

### Skills

The reviewer looks for a skill that fits reviewing code in your skill folders: `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`), and this folder's repo's `.claude/skills` and `.agents/skills`. It reads their `SKILL.md` names and descriptions, follows the one that fits, and says which on the first line of the review (`No review skill` when none fits). It skips any step of a skill that posts, writes files, runs commands or asks you something. Skills that come with plugins are not offered: Claude Code does not tell the panel where they are.

### Asks

When the reviewer wants something no rule allows (a web page, a file outside its folders), it waits for your answer in the card. It never asks in the conversation and never opens a dialog.

The review's row shows a warning in yellow that blinks, and so does the band tab (`🐙 … 🤖❓`):

```
⚠ Wants to fetch https://docs.python.org/3/
  Allow once   Deny   denied in 9 min if unanswered
  Allow docs.python.org for this review
```

- `Allow once`: this call only.
- `Allow docs.python.org for this review`: that domain (or whatever rule Claude Code offers) until this review ends. It is shown only when Claude Code offers a rule. It is never saved to your settings.
- `Deny`: the reviewer carries on without it.

An ask nobody answers is denied after 10 minutes. The row then says `1 ask went unanswered for 10 min and was denied`.

A file in the copy that is a link pointing out of it says so: `⚠ Wants to read docs/plan.md, a link out of the copy to /Users/you/notes/plan.md`.

### Progress

While it runs, the row reads `🤖 #2086 Add CSV export option…   reviewing · 2m 14s`, and under it what the reviewer does now and how many steps it took: `reading src/a.ts · 12 steps`, `searching for useFoo`, `fetching docs.python.org`, `waiting for your answer`. Before it starts, `⏳ … preparing` says what the panel does: `reading the pull request…`, `making a clean copy of the pull request…`.

Press the row for its menu: `📄 Open review` (once done), `📜 Log`, `↗ Raw stream (.jsonl)`, `⏹ Stop` (while it runs), `↻ Retry` (after a failure), `✕ Dismiss`. A failed review shows why, with `↻ Retry` and `📜 Log`. Reloading ClaudeDockula stops a running review; it then shows `interrupted by a reload — Retry`.

`⏹ Stop` denies every ask still waiting, then ends the review in the card at once: it fails as `stopped` and its temporary folder is deleted. The reviewer process itself ends at its next output, which usually comes within seconds of the denied asks. A review still running after 30 minutes is stopped the same way.

### When it finishes

The review is saved as `review-<number>-<date>-<time>.md` under `<Claude folder>/claudedockula/gitgud/<host>/<repo>/` and listed under `Files`. A notice says `Review of #2086 ready` with `Open` (or `Review of #2086 failed` with `Log`). `⚙ → When it finishes` can add the terminal bell or a system notification.

### Logs

Everything the reviewer does is logged beside the review file:

- `review-<number>-<date>-<time>.log.md`, readable: when it started, the model, the command (its settings and instructions written out under it), the folders it could read, each step with its time and whether it worked, each ask with your answer and when, every permission denial, and how it ended (turns, cost, exit).
- `review-<number>-<date>-<time>.jsonl`: every line the reviewer wrote, as it wrote it. `↗ Raw stream (.jsonl)` opens it in your default app.

The readable log names both files, and shows the command with the environment it set (`CLAUDE_CODE_PLUGIN_DIRS=''`).

`📜 Log` opens the readable log in the file pane, also while the review runs.

## The band tab

The band is the row of tabs above the prompt. This tab reads like `🐙 1 to review · 2 mine ❌1 ⚠1 🤖`:

- How many pull requests wait for your review, and how many of yours are open. When both are zero, the number of issues.
- `❌1`: your pull requests whose CI failed.
- `⚠1`: open pull requests that overlap your changes.
- `🤖`: a background review is running. `🤖❓`: it waits for your answer, and the tab blinks in yellow.
- `needs gh` or `needs glab` until the CLI is installed, `sign in` until it is signed in, `set up` while the service is unknown or Bitbucket has no working token, `…` while loading, `–` when the service could not be read or there is nothing to count.

## When it refreshes

Only while the panel is in a dock view:

- Every 90 seconds while the card is shown. ⚙ sets 1 minute, 90 seconds or 5 minutes.
- While only the band tab shows it: every 5 minutes, or three times your setting when that is longer.
- After a failure the card shows `Couldn't load <service>: <why>` (with `(trying again less often)` from the second one), and the wait doubles each time, up to 15 minutes.
- When the service says its rate limit is nearly used up, the panel pauses until it resets, and the card says `<service>'s rate limit is low (N left): paused until it resets.` See the table in `What each service offers`.
- Opening the card (its band tab, or its ▸ / ▾) reads data older than 30 seconds again.
- `↻ Refresh` checks the service, the CLI or token, the repo and the branch again, forgets the backoff, reads the lists, the opened row and the overlaps again.
- Overlaps: your changes are checked every minute and 10 seconds after Claude's Edit, Write, NotebookEdit or Bash calls; the open pull requests' files are read again every 5 minutes (15 minutes on Bitbucket, because of its hourly rate limit).

## Notices

Notices are short lines the band shows above its tabs. Errors stay until you close them with ✕; the others clear after about 8 seconds. Click a row marked ▸ to read its full text. On VS Code and mobile, which have no band, notices show at the top of each right dock.

News about your lists, each raised once:

- `👀 Review requested: #2086 <title>`
- `❌ CI failed on #2086` (again after a new push that fails)
- `👍 #2086 approved`
- `✋ Changes requested on #2086`
- More than 3 of these at once come as one notice, `🐙 5 GitGud updates`, listing them.
- `⚠ #2096 (linus) touches 3 files you changed`, when a pull request starts to overlap your changes, and again when the files it shares with you change.

A notice is raised once for all your sessions: ClaudeDockula records it in its store. The first time a repo is followed (or All is chosen), what is already there is recorded without notices.

Background reviews: `Review of #2086 ready` (`Open`), `Review of #2086 failed` (`Log`), `A review of #2086 is already running`, `2 reviews are already running`.

Problems: `Couldn't load <service>` (once, when loading first fails; it goes away when a later load works), `Couldn't open the browser`, `Couldn't find <repo>`, `No repo matches “…”`, `Couldn't read #2086`, `Couldn't read the diff of #2086`, `Couldn't copy the link`, `Couldn't open the file`.

Actions also confirm what they did, for example `Press Enter to review #2086 here`, `Fixing CI of #2086: added to the prompt`, `Link copied`, `Added <repo>`, `<repo> is already listed`, `#2086 is not in this folder's repo`, `Set up the Jira panel to open ABC-101`, `Command copied: run it in your own terminal`.

## Claude Haiku

The panel asks Claude Haiku for:

- The one-line summary of each row drawn while the card is shown. It sends the title, the labels and the start of the description. Each summary is kept until the item changes.
- One line on why a failed CI job failed, for up to 3 failed jobs of an opened pull request. It sends the job's log lines. Not on Bitbucket, which gives no logs.
- The PR description and the commit summary, when you press their buttons.

`⚙ → Haiku summaries → Off` stops the row summaries and the CI lines. The PR description and commit summary buttons still use Haiku.

## Jira

The panel finds a ticket key in each title, then in each branch name, with the ticket pattern set in the [Jira panel's](jira.md) ⚙. The status comes from the Jira panel when it already has it. Otherwise the panel reads up to 8 tickets per refresh through the Jira panel's server, and reads a ticket again after 15 minutes at the earliest. The Jira panel's board shows each ticket's pull request in return.

## Settings

`⚙` in the card's header shows `⚙ GitGud settings · for every session` (it opens the card first when it is minimized):

- `Added repos`: the repos you added, each with `✕` to remove it, and `➕ Add a repo`.
- `Service`: one line per host GitGud knows, such as `git.acme.dev: GitLab`, with `Change` to pick the service again (and set up Bitbucket again).
- `Refresh`: `1 min`, `90 s` or `5 min` (● marks the choice).
- `Haiku summaries`: `On` or `Off`.
- `🤖 Background reviews`:
  - `When it finishes`: `Notice only` (the default), or the notice plus what your notification setting in `/config` does: `Notice + terminal bell` or `Notice + system notification`. When notifications are off in `/config`, only `Notice only` is offered.
  - `Model`: `Sonnet` (the default) or `Opus`.
  - `Web lookups`: `On` (the default) or `Off`. Off, the reviewer has no WebFetch or WebSearch.
- `Done` closes it.

`Reset all settings` in ⚙ Manage clears these settings and the Haiku lines, and GitGud reads again and asks for a service when it needs one. Background reviews that are running keep going, and the alert list refills without raising alerts. Nothing in your keychain, your environment variables or your files is touched.

These settings and the This / All choice apply to every session. They are kept in ClaudeDockula's store, under `plugins/store/` in your Claude folder. For each host the store keeps its service and, for Bitbucket, your email and where the token lives (the keychain entry or the variable's name). It never keeps the token.

## Privacy and safety

- `Read only.` Every command and request passes a guard that allows only reads and refuses everything else, so the panel cannot merge, comment, approve, push or check out on any service.
- `The Bitbucket token` is read from your keychain or environment variable when needed and kept in memory only. It is never written to the store, a file, a log or a notice, and it is sent only to `api.bitbucket.org`.
- `The quick look at an unknown host` sends a few GET requests to that host, with no credentials. It gives up after 5 seconds and treats a silent host as no guess.
- `Bitbucket PR diffs from a fork` are not available: Bitbucket answers that read with a redirect Claude Code gives a plugin no way to see, so GitGud does not send the token with it and says `fork PR diffs aren't available`. A Bitbucket fork PR also drops out of Overlaps without a message, because its changed files can't be read the same way.
- `Other plugins.` Like any plugin's, this plugin's commands and requests, their headers included, can be seen by other plugins you have installed. Install only plugins you trust.

## What it runs and writes

- `gh`: `auth status`, `repo view`, `search repos`, `pr list`, `pr view`, `pr checks`, `pr diff`, `run view` (a failed job's log), GraphQL queries (never a change), and one REST read, a pull request's file list.
- `glab`: `auth status --hostname <host>`, and `api <path> --hostname <host>` for a listed set of read paths. `glab api` sends a GET unless told otherwise, and the guard refuses any other method or flag.
- Bitbucket: GET requests over HTTPS to `api.bitbucket.org`, on a listed set of `/2.0/` read paths. To read the token: `security find-generic-password -s gitgud-bitbucket -a <email> -w` (macOS) or `secret-tool lookup service gitgud-bitbucket account <email>` (Linux).
- Detection: `git config --get-regexp` for the remote URLs, `git rev-parse` for the branch's upstream, `git ls-remote --get-url` (no network call), `gh auth status` and `glab auth status` for the host, and for an unknown host the quick look: GETs to `/api/v3/meta`, `/api/v4/version`, `/users/sign_in`, `/rest/api/1.0/application-properties` and `/api/v1/version`, with no credentials.
- `git`: `rev-parse`, `status`, `merge-base`, `diff`, `log` and `symbolic-ref`, all with `--no-optional-locks`. For a background review's copy: `--version`, `config --null --get-regexp ^filter\.` (the filter drivers to switch off), `cat-file -e <commit>`, and `archive` into the review's temporary folder.
- For a background review: `tar -xf` into the review's temporary folder, the reviewer (`claude -p` with exactly the flags above), and `rm -rf` of that folder when it ends. The temporary folder is in `claudedockula-reviews/` under your own temp folder (`$TMPDIR`, else `~/.cache`).
- Links and files open with `open` (macOS), `xdg-open` (Linux) or `cmd /c start` (Windows).
- It writes only its own Markdown files and review logs, under `<Claude folder>/claudedockula/gitgud/`, and a review's temporary folder. `<Claude folder>` is `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
- It never posts to any service. `Check out`, `Install` and `Sign in` only fill the prompt box, and `Copy command` only copies the keychain command for you to run.

## Permissions

Jira statuses are read through the Jira panel's server, which goes through Claude Code's permissions. When a read is refused, the panel stops reading Jira statuses until `↻ Refresh`, and the rows show only the ticket key.

## Limits

- Clicking, right-clicking and the keys in the list work on the terminal and the desktop app. On VS Code and mobile each row is a button that opens it, with a `⋯` button for its menu. There the copy entries are listed one by one (`📋 Copy link`, `📋 Copy title + body`, `📋 Copy full thread`, `📋 Copy diff`).
- `Check out` is offered only for pull requests of the session folder's repo.
- The lists hold up to 30 items each, a search up to 20, and the overlap check looks at up to 50 open pull requests (20 on GitLab and Bitbucket).
- Bitbucket: To review and Search cover only the followed repos, there is no Issues tab, and failed jobs show no log lines. One Bitbucket account is used at a time.
- Not read yet: Bitbucket Server and Data Center, Gitea and Forgejo, Azure DevOps.
- The file pane and the compare pane open on the right when there is room. Otherwise a notice says `The file opens once there is room` or `The diff opens once there is room`; `↗` opens a file in your editor instead.
- Each dock that shows the panel has its own list.
