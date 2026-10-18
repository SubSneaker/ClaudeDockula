# 💬 Slacker

Slacker shows what needs you in Slack: messages that @mention you, direct messages, replies in threads you are in, and messages with words you watch. You can search Slack, add a message or a thread to the prompt, and reply.

## Turning it on

Slacker is off until you add it. Open ⚙ Manage on a dock (or run `/dock manage`) and tick `💬 Slacker`. Until it is in a dock view it reads nothing. When ClaudeDockula first offers it, the band shows the notice `New panel: 💬 Slacker`.

## What it needs

The claude.ai Slack connector, connected in `/mcp`. A connector (MCP server) gives Claude extra tools; Slacker uses this one's tools to read Slack and, when you send a reply, to post it.

When the connector is not connected, the card says `Slack isn't connected in this session.` and `Connect claude.ai Slack in /mcp, then ↻ Refresh.`

## The feed

The feed covers the last 7 days:

- Messages that @mention you.
- Direct messages from people (bots are left out), in one-to-one and group DMs.
- Replies in threads you are part of.
- Messages with one of your watched words (see **★ Watch** below).

Your own messages are left out. A DM conversation or a thread shows as one row, its newest message, with `×N` for how many messages it holds. Each search returns at most 20 messages.

### The search box and the chips

- The top row is the search box, `🔍 Search Slack…`. See **Searching**.
- Under it, the chips filter the feed: `All`, `@` (mentions), `DM`, `🧵` (threads) and `★` (watched words, shown when you watch words), each with its count. The chosen chip is highlighted; a chip with nothing in it is dim. Click a chip to choose it.
- `● 3 new` at the right end counts the rows that came since you last looked.

### A row

`● @  Grace  #dev-app ×2   pick a table for the…   2h ⋯`

- `●` marks a row that came since you last looked; `▾` marks the open row.
- A badge for why it is listed: `@` mention, `DM`, `🧵` thread reply, `★` watched word, `⌕` search result.
- The author in bold, then where it was posted (a channel, or the people in a DM), dim, and `×N` for a folded conversation.
- The message, dim once you have seen it.
- How long ago: `now`, `5m`, `3h`, `2d`, `1w`.
- `⋯` opens the row's menu.

On a wide card each row takes one line. On a narrow one the message goes on a second line.

The feed shows 5 rows at first. `+N more` shows 5 more, and `Show less` goes back.

### An open row

Click a row to open it. It shows the whole message (up to 8 lines), then a row of actions:

- `+ Prompt`: add the message to the prompt box. When its thread is shown, this reads `+ Thread to prompt` and adds the whole thread.
- `↩ Reply`: write a reply (see **Replying**).
- `🧵 Thread`: show or hide the thread under the message. For a direct message outside a thread it reads `💬 Chat` and shows the last messages of the conversation. `▴` marks it while shown.
- `🔗 Link`: copy the message's link.
- `✕`: close the row.

A shown thread reads `┄ Thread · 3 replies ┄` (or `┄ Recent messages ┄` for a DM), then the message that started the thread (when the row is a reply), `+N earlier` when there are more than 4 replies, and the last 4 replies. Your own name is highlighted. `Reading the thread…` shows while it loads, `No replies yet.` when there are none.

### The menu

Right-click a row, or click its `⋯`, for its menu:

- `+ Add message to prompt`
- `+ Add thread to prompt`: reads the thread and adds it.
- `↩ Reply…`
- `🧵 Show thread` or `🧵 Hide thread`
- `🔗 Copy link`
- `✕ Close menu`

### What goes in the prompt

Adding puts the text at the end of the prompt box, on a new paragraph when the box has text:

```
Slack message in #dev-app (<link>):
> **Grace:** pick a table for the export
```

A thread is added the same way, every message quoted with its author. Nothing is sent until you send it.

## Searching

On the terminal and the desktop app:

- Click the search box and type. Typing filters the feed: it keeps rows whose author, place, text or watched word has every word you typed. `No matches for “…”.` when nothing matches.
- Press Enter to search all of Slack instead. Slack's search words work, such as `from:@grace` or `in:#dev`.
- Backspace deletes a character, Ctrl+U clears the box, and ✕ at its right end clears it too. ↑ or ↓ leaves the box.

Search results (up to 20) replace the feed. The header shows `⌕ “your words”` and how many were found; `✕ Feed` goes back to the feed. `Searching Slack…` shows while it runs, `Slack found nothing for that.` when nothing matched.

On VS Code and mobile, the search box is a button. It asks `What should Slacker search Slack for?`; type your words, or pick `Clear search` or `Cancel`.

## Replying

1. Press `↩ Reply` (or `↩ Reply…` in the menu). A question asks `Reply in thread · #dev-app, to Grace: what should it say?` (for a DM outside a thread, `Message to <name>`). Type the reply, or pick `Let AI draft it` or `Cancel`.
2. The draft shows under the message, with where it will go: `┄ Reply in thread · #dev-app ┄`. It is not sent yet.
3. Choose:
   - **Send** posts it. This is the only thing Slacker ever posts, and only when you press it.
   - **✦ Polish** has Claude Haiku (a small, fast Claude model) rewrite the draft to be clear and short, in the same language and voice, or write one when the draft is empty. It shows `✦ Polishing…` meanwhile. Nothing is sent.
   - **✎ Edit** asks `What should the reply say instead?` (with the current text) and offers `Keep it` and `Cancel reply`.
   - **↶ Undo** goes back to the text before the last polish or edit.
   - **✕ Cancel** drops the draft.
4. After sending: `Sending…`, then `✓ Sent`; its `✕` clears the line. The thread, when shown, is read again.

Where a reply goes: into the message's thread when it is in one; into the conversation for a direct message outside a thread; otherwise it starts a thread on the message.

Polish and `Let AI draft it` send the draft, the message you answer and up to 12 messages of its conversation to Claude Haiku.

When sending fails, the draft stays with **↻ Try again** and the reason:

- `Not sent: <why>`
- `May have been sent: check Slack before trying again`: the call failed in a way that does not tell whether Slack posted it.
- `Interrupted: check Slack before trying again`: ClaudeDockula reloaded while it was sending.

A failed polish shows `Polish failed: <why>`.

## Buttons under the feed

- **↻ Refresh**: read Slack again now. It also runs an open search again.
- **✓ Seen**: mark everything as seen. The `●` marks and the band count clear.
- **★ Watch** (or **★ Watching 2**): set up to 3 words to watch, separated by commas. The question offers `Watch “<your name>”` when you watch nothing yet, and `Keep these` or `Clear watchlist` when you do.
- **🔓 Allow Slack**: shown when Claude Code refused Slacker's calls. See **Permissions**.

## The band tab

The band is the row of tabs above the prompt. This tab shows how many feed rows came since you last looked, for example `💬 3`. `…` while the first read runs, `!` when it failed, `–` before anything was read.

What counts as looking:

- Opening the panel (its band tab, or its card's ▸ / ▾) sets the count to 0. The `●` marks then show what came since your previous look.
- Anything you do in the card also sets the count to 0, but keeps the `●` marks.
- **✓ Seen** clears both.

## When it refreshes

- Every 30 seconds while the panel is in a dock view.
- When you open the panel, when you tick it in ⚙ Manage, when you press **↻ Refresh**, and after you change your watched words.

While Claude Code refuses its calls, the 30-second refresh waits until you press **↻ Refresh** or open the panel.

## What it reads and writes

It reads through the claude.ai Slack connector:

- `slack_read_user_profile`: who you are, once.
- `slack_search_public_and_private`: the feed and your searches.
- `slack_read_thread` and `slack_read_channel`: a thread, or a DM's last messages.

It writes one thing: your reply, through `slack_send_message`, once, when you press **Send**.

Copying a link uses the clipboard of the device you pressed on.

## Settings

Slacker keeps, in ClaudeDockula's store (`plugins/store/` in your Claude folder, `$CLAUDE_CONFIG_DIR` or else `~/.claude`):

- your watched words (change them with **★ Watch**),
- when you last looked,
- your Slack user id and name.

## Permissions

Slack calls go through Claude Code's permissions, and auto mode may refuse them. The card then shows, for each refused call, a line like:

```
Claude Code blocked slack_search_public_and_private (auto mode could not review it).
Allow it in /permissions: mcp__claude_ai_Slack__slack_search_public_and_private
```

**🔓 Allow Slack** puts a request in the empty prompt box, for you to read and send: it asks Claude to add allow rules for the four reading tools above to your user settings, and then to ask you whether to also allow `slack_send_message`. It does not send anything by itself. If the prompt box has text, the notice `Clear the prompt box first` shows instead.

## Messages on the card

- `Reading your Slack…`, `Not read yet.`
- `Nothing for you in the last 7 days.`, `Nothing under this chip.`
- Errors from the first read show in red. Errors from a later read show in yellow with `⚠`, and the last feed stays.
- `Too much to draw here: show less` when the open rows are too long to draw.

## Notices

Notices are short lines the band shows above its tabs. Errors stay until you close them with ✕; the others clear after about 8 seconds. On VS Code and mobile, which have no band, notices show at the top of each right dock.

- `Message added to the prompt`, `Thread added to the prompt`, and `The prompt box didn't take the message` (or `the thread`).
- `Link copied`, `Couldn't copy the link`.
- `Review the request, then press Enter`, `Clear the prompt box first`, `The prompt box didn't take the request`.

## Limits

- Clicking, right-clicking, typing in the search box and the keys work on the terminal and the desktop app. On VS Code and mobile every clickable part is a button, and search asks with a question.
- Keys, when the feed has the keyboard focus: ↑ ↓ move between rows and menu entries (`›` marks where you are), Enter opens the row or picks the entry, m opens the row's menu.
- Each dock that shows the panel has its own feed.
