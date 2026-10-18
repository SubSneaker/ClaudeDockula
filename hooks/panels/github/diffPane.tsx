// The overlap inspector, drawn in the doc pane: one file both the working tree and another open PR change, with
// both diffs stacked and the hunks that collide flagged. Pure: no `$`.
import type { Elements, RenderSurface } from 'claude-code'

import type { GhDiffInspect, GhDiffSide } from '../../../types'
import { TONE, drawHeading, drawNote, fitStart } from '../../dock/ui'
import { diffRuns, sideText } from './diff'
import { KEY } from './model'
import { drawable } from './parse'

type Ui = Elements[RenderSurface]

/** The pane's tab title: `🔀 layout.tsx · #2096`. */
export function diffPaneTitle(path: string, number: number): string {
  const name = path.split('/').pop() ?? path

  return `🔀 ${drawable(name)} · #${number}`
}

/**
 * Both diffs as Markdown for the clipboard: the file, the PR, then each side in a `diff` fence (or its note).
 * @example
 * // after: '# src/a.ts\n\n#12 by @ann (feat/x): https://…\n\n## Your changes (working tree vs origin/main)\n```diff\n@@ …\n```\n\n## #12\'s changes\n…'
 */
export function inspectorCopyText(diff: GhDiffInspect): string {
  const base = diff.base === undefined ? 'its base' : `origin/${diff.base}`
  const block = (side: GhDiffSide | undefined) => {
    const text = sideText(side)
    const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), run => run[0].length))
    const fence = '`'.repeat(longest + 1)
    const notes = [side?.note, side?.cut ? `${side.cut} more hunks left out` : undefined].filter(note => note !== undefined)

    return [text === '' ? '' : `${fence}diff\n${text}\n${fence}`, ...notes.map(note => `_${note}_`)].filter(part => part !== '').join('\n')
  }

  return [
    `# ${diff.path}`,
    `#${diff.number} by @${diff.author} (${diff.headRef}): ${diff.url}`,
    `## Your changes (working tree vs ${base})`,
    block(diff.mine) || '_No changes._',
    `## #${diff.number}'s changes`,
    block(diff.theirs) || '_No changes._'
  ].join('\n\n')
}

function drawSide(ui: Ui, side: GhDiffSide | undefined, path: string, flag: string, isLoading: boolean): JSX.Element {
  const { Box, Code, Text } = ui
  if (side === undefined) return drawNote(ui, isLoading ? 'Reading…' : 'Nothing to show.')
  const runs = diffRuns(side.hunks ?? [])

  return (
    <Box flexDirection="column">
      {side.note !== undefined && drawNote(ui, drawable(side.note))}
      {runs.map(run => (
        <Box flexDirection="column">
          {run.isOverlap && (
            <Text dimColor color={TONE.run}>
              {flag}
            </Text>
          )}
          <Code source={run.text} path={drawable(path)} format="diff" />
        </Box>
      ))}
      {side.cut !== undefined && drawNote(ui, `${side.cut} more ${side.cut === 1 ? 'hunk' : 'hunks'} not shown here (📋 Copy and ➕ hold what is shown).`)}
    </Box>
  )
}

/**
 * The header (path, the PR, what "yours" means, the overlap), the actions, then "Your changes" and "#N's changes".
 */
export function drawDiffPane(ui: Ui, diff: GhDiffInspect, columns: number): JSX.Element {
  const { Box, Button, Text } = ui
  const base = diff.base === undefined ? 'its base' : `origin/${diff.base}`
  const isLoading = diff.isLoading === true

  return (
    <Box flexDirection="column" width={columns}>
      <Text bold wrap="truncate-end">
        {fitStart(drawable(diff.path), columns)}
      </Text>
      <Text wrap="truncate-end">
        <Text bold color="suggestion">{`#${diff.number}`}</Text>
        <Text dimColor>{` ${drawable(diff.author)}`}</Text>
        {`  ${drawable(diff.headRef)}`}
      </Text>
      <Text dimColor wrap="wrap">
        {`Yours: the working tree vs ${base} at the merge-base${diff.mergeBase ? ` ${diff.mergeBase.slice(0, 7)}` : ''}, uncommitted and untracked changes included.`}
      </Text>
      {!isLoading && (
        <Text color={diff.overlap === undefined ? undefined : TONE.run} dimColor={diff.overlap === undefined} wrap="wrap">
          {diff.overlap ?? 'No hunks overlap: the two change different lines.'}
        </Text>
      )}
      {diff.isApproximate === true && drawNote(ui, `#${diff.number} branched from another commit, so its line numbers are approximate.`)}
      {diff.isBaseUnknown === true && diff.isApproximate !== true && drawNote(ui, `Can't confirm #${diff.number}'s base here (its head isn't fetched), so line numbers may be approximate.`)}
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        <Button key={KEY.diffPanePrompt} plain dimColor={isLoading} label="➕ Add to prompt" onPress={() => undefined} />
        <Button key={KEY.diffPaneCopy} plain dimColor label="📋 Copy" onPress={() => undefined} />
        <Button key={KEY.diffPaneOpen} plain dimColor label="↗ Open on GitHub" onPress={() => undefined} />
        <Button key={KEY.diffPaneRefresh} plain dimColor label={isLoading ? '↻ Reading…' : '↻'} onPress={() => undefined} />
        <Button key={KEY.docPaneClose} plain dimColor label="✕ Close" onPress={() => undefined} />
      </Box>
      {diff.error !== undefined && (
        <Text color={TONE.fail} wrap="wrap">
          {`Couldn't read the diffs: ${drawable(diff.error)}`}
        </Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        {drawHeading(ui, 'Your changes')}
        {drawSide(ui, diff.mine, diff.path, `⚠ also changed in #${diff.number}`, isLoading)}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {drawHeading(ui, `#${diff.number}'s changes`)}
        {drawSide(ui, diff.theirs, diff.path, '⚠ also changed by you', isLoading)}
      </Box>
    </Box>
  )
}
