# 🌿 Branch

The Branch panel shows the git branch of the folder Claude Code runs in, how it compares with its remote branch, and which files have changes.

## The card

- **Branch name**, in bold. When no branch is checked out (a "detached HEAD"), it says `Detached at <commit>` in yellow.
- **Upstream line**, dim. The upstream is the remote branch your branch tracks.
  - `↑2 ahead of origin`: you have 2 commits the remote does not have.
  - `↓1 behind origin`: the remote has 1 commit you do not have.
  - `↑2 ahead · ↓1 behind origin`: both.
  - `Up to date with origin`
  - `No upstream branch`: the branch tracks no remote branch yet.
  - `origin/<name> is gone`: the remote branch was deleted.
- **Changed files**:
  - `✔ Working tree clean`, in green, when nothing changed.
  - Otherwise a heading with the counts that are not zero: `1 conflicted · 2 staged · 3 modified · 4 untracked`.
  - Up to 5 files (10 if you set that in ⚙). Each starts with the two-letter code `git status -s` prints: the first letter (the staged change) in green, the second (the change not staged yet) in red. Untracked files show `??`, dim. Then the file name, then its folder, dim.
  - `+N more` when more files changed.
- **Worktrees**, when the repo has more than one worktree and the setting is on. Each line has the worktree's branch (or `detached`) and its path, cut from the start when it is long. The worktree you are in is marked with `●`.
- `↻ Refresh` reads git status now. It shows `↻ Refreshing…` while it runs.

## The band tab

The band is the row of tabs above the prompt. This panel's tab reads like `🌿 ABC-101 ·3`:

- First, the ticket key in the branch name: `ABC-101/add-export` gives `ABC-101`. The key is found with the ticket pattern set in this panel's ⚙, by default `[A-Z][A-Z0-9]+-\d+`.
- With no key in the name: the last part of the branch name, cut to 16 characters. With no branch: the short commit id, or `detached`.
- `·3`: how many files have changes. Nothing when the tree is clean.
- `…` before the first read. `–` when git status failed.

## When it refreshes

- When the session starts.
- Every 20 seconds, or as often as you set in ⚙.
- 1.5 seconds after Claude's Edit, Write, NotebookEdit or Bash calls. A burst of calls refreshes once, after it goes quiet.
- When you press ↻ Refresh.

## What it reads and writes

- It runs two commands in the session's folder: `git --no-optional-locks status --porcelain=v2 --branch` and `git --no-optional-locks worktree list --porcelain`. Both only read, and the panel refuses to run any other git command.
- It never fetches, so ahead and behind count against the remote as you last fetched it.
- It writes only its settings (see below).

## Settings

The ⚙ in the card's header opens the settings. Each change saves at once, and Done closes the view.

- Ticket pattern: the expression that finds the ticket key in a branch name. Type it and press Enter. Leave it blank for the default, `[A-Z][A-Z0-9]+-\d+`. It is shared with the [Jira](jira.md) and [GitGud](gitgud.md) panels.
- Refresh: 20 s (default), 1 min or 5 min.
- Files shown: 5 (default) or 10.
- Untracked files: Show (default) or Hide. Hidden files are not listed or counted.
- Worktrees: Show (default) or Hide.

The choices are saved under `branch:settings`. The ticket pattern stays in the shared `settings` key. Reset all settings in ⚙ Manage clears them.

## Messages on the card

- `Reading git status…`: before the first read.
- `Not a git repository.`: the session's folder is not in a git repo.
- `git status failed: <git's first error line>`
- `Could not run git.`

The panel raises no notices.
