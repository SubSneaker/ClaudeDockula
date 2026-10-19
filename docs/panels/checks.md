# ✅ Checks

The Checks panel runs your repo's lint, type, test, format or build commands in the background and shows whether each one passed.

## Setting it up

The first time the panel sees a repo with no saved checks, the card shows its settings. `⚙` in the card's header opens them again later.

- `Checks` lists what to run in this repo. The panel reads the repo's `package.json` and offers each of these scripts it has: `lint`, `typecheck`, `types`, `tsc`, `test`, `format`, `format:check`, `build`. Each runs through your package manager, found from the lockfile: pnpm (`pnpm-lock.yaml`), yarn (`yarn.lock`), bun (`bun.lockb` or `bun.lock`), otherwise npm. An option reads like `lint · pnpm run lint`.
- With no `package.json` the list says `None yet.` Add your own commands under `Add a command`.
- Press an option to tick (☑) or untick (☐) it.
- `Add a command`: type `name: command`, for example `Types: pnpm exec tsc --noEmit`, and press `add`. Without a `name:` the command's first word names it. The new command is ticked.
- `Save` keeps the ticked commands, in the order listed.
- `Cancel` closes the form without changes. It shows only when the repo already has saved checks.

Commands run with no shell: the text is split at spaces. Pipes, `&&`, quotes and `$VARIABLES` do not work. Put such a command in a `package.json` script and add the script instead.

## The card

Each check has one row:

- Its name.
- Its state:
  - `· not run`, dim.
  - `◌ running  15s`, in yellow, with the time so far.
  - `✔ passed  42s`, in green, with how long it took.
  - `✘ <problem>`, in red. The problem is the count the tool printed when it printed one (`3 errors`, `2 tests failed`, `1 test file failed`, `4 files to format`), otherwise `exit code 1`. `did not finish` means the command could not run. `interrupted by a reload` means ClaudeDockula reloaded while it ran.
- `Run` runs that check. It is dim while the check runs.
- `▸ show details` under a failed check shows up to 6 lines of its output. `▾ hide details` hides them. Lines that name a file come first. Paths inside the session's folder are made relative, and long paths keep only their last two parts (`…/_components/Item.tsx`).

Under the rows:

- `Run all` runs every check, one after another. It reads `Running all…` while it goes. A check that is already running is skipped.
- `No checks yet: ⚙ above to add` shows when the repo has none saved.

## The band tab

The band is the row of tabs above the prompt. The tab's icon changes with the results: ⏳ while any check runs, ❌ once one failed, ✅ otherwise. The text after it:

- `4/4`: how many checks passed, of how many there are.
- `2`: how many failed.
- Nothing while a check runs.
- `set up`, dim, before this repo's checks are saved.
- `–` before any check ran.

## Notices

Notices are short lines the band shows above its tabs. Errors stay until you close them with ✕; the others clear after about 8 seconds. Click a row marked ▸ to read its full text. On VS Code and mobile, which have no band, notices show at the top of each right dock.

- A single run ends with one notice: `Lint passed in 42s`, which clears by itself, or `Types failed: 3 errors`, which stays until you close it. Its detail holds the output lines.
- `Run all` ends with one notice: `All 4 checks passed` or `2 of 4 checks failed: Types, Format`. Its detail has one line per failed check (`Types: 3 errors`). It replaces older notices about these checks.
- `Already running all checks` or `Lint is already running` when you press again during a run.

## What it runs and writes

- The commands you saved, run in the session's folder with colours off. Each run has a time limit, 10 minutes unless you change it in ⚙.
- They run as you typed them and may write files (a format script, a build). Know what a command does before you add it.
- To build the setup form it reads `package.json` and the file names in the repo's top folder, and runs `git rev-parse --show-toplevel` to find that folder.
- The panel itself writes only your saved list.

## Settings

- Checks are saved per repo, keyed by the repo's top folder, so a session started in a subfolder finds the same checks.
- They are kept in ClaudeDockula's store, under `plugins/store/` in your Claude folder (`$CLAUDE_CONFIG_DIR`, else `~/.claude`).
- Change them with `⚙` in the card's header. Ticking or adding a check saves at once for a repo that is already set up. Before that, `Done` saves, even with none ticked.
- `Time limit`: 5 or 10 min for one run. The default is 10. Claude Code does not let a command run longer than 10 minutes.
- `When one ends`: `Notice` or `Nothing`, for a single run. Run all always posts its tally. The default is `Notice`.
- The time limit and notice choice apply to every repo. They are kept in `checks:settings`.

## Limits

- The `Add a command` field needs a surface with text fields. Where there is none (mobile), the row says `From the terminal.`
- A reload of ClaudeDockula stops the checks that were running; they show `interrupted by a reload`.
