// The doc pane (`claudedockula-doc`): one file the GitHub panel wrote, drawn whole as Markdown. Pure: no `$`.
import type { Elements, RenderSurface } from 'claude-code'

import type { GhDocKind, GithubDocState } from '../../../types'
import { TONE, drawNote, fitStart } from '../../dock/ui'
import { drawDiffPane } from './diffPane'
import { KEY } from './model'
import { drawable } from './parse'

/** Markdown draws at most 100 000 characters per drawing; the header takes a few. */
export const DOC_TEXT_CAP = 90_000

const DOC_KIND_ICON: Record<GhDocKind, string> = { review: '🧐', 'pr-description': '📝', 'commit-summary': '🧾', 'review-log': '📜' }

/** The pane's tab title: `🧐 Review #2086 · Add CSV export option…`. */
export function docPaneTitle(kind: GhDocKind, title: string): string {
  return `${DOC_KIND_ICON[kind]} ${drawable(title)}`
}

/**
 * A file's text as the pane may draw it: each line cleared of escape sequences and control characters (a review
 * holds the model's words, which may quote a PR's), tabs as two spaces so code keeps its indent.
 * @example
 * // before: 'a\tb\n\u001b[31mred\u001b[0m'
 * // after:  'a  b\nred'
 */
export function cleanDocText(text: string): string {
  return text
    .split(/\r?\n/)
    .map(line => drawable(line.replace(/\t/g, '  ')))
    .join('\n')
}

/**
 * Cuts a file's text to what one drawing holds, at a line break when one is near.
 * @example
 * // before: 'a\n'.repeat(60_000) (120 000 characters)
 * // after:  { text: 'a\n…a' (under 90 000 characters, ending before a line break), isTruncated: true }
 */
export function fitDocText(text: string, cap: number = DOC_TEXT_CAP): { text: string; isTruncated: boolean } {
  if (text.length <= cap) return { text, isTruncated: false }
  const cut = text.slice(0, cap)
  const lineEnd = cut.lastIndexOf('\n')

  return { text: lineEnd > cap * 0.9 ? cut.slice(0, lineEnd) : cut, isTruncated: true }
}

/**
 * The file's title and path, then `↗ Open file  📋 Copy  ➕ Add to prompt  ✕ Close`, then the file as Markdown.
 * While it loads, or when it could not be read, one line says so. The overlap inspector (`doc.diff`) draws instead.
 */
export function drawDocPane(ui: Elements[RenderSurface], doc: GithubDocState, columns: number): JSX.Element {
  const { Box, Button, Markdown, Text } = ui
  if (doc.diff !== undefined) return drawDiffPane(ui, doc.diff, columns)
  if (doc.path === undefined) {
    return (
      <Box flexDirection="column" width={columns}>
        {drawNote(ui, 'No file open: open one from the GitHub card’s Files list.')}
      </Box>
    )
  }
  const text = doc.error === undefined ? doc.text : undefined

  return (
    <Box flexDirection="column" width={columns}>
      <Text bold wrap="truncate-end">
        {drawable(doc.title ?? 'File')}
      </Text>
      <Text dimColor wrap="truncate-end">
        {fitStart(doc.path, columns)}
      </Text>
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        <Button key={KEY.docPaneOs} plain label="↗ Open file" onPress={() => undefined} />
        <Button key={KEY.docPaneCopy} plain dimColor label="📋 Copy" onPress={() => undefined} />
        <Button key={KEY.docPanePrompt} plain dimColor label="➕ Add to prompt" onPress={() => undefined} />
        <Button key={KEY.docPaneClose} plain dimColor label="✕ Close" onPress={() => undefined} />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {doc.isLoading === true && drawNote(ui, 'Reading the file…')}
        {doc.error !== undefined && (
          <Text color={TONE.fail} wrap="wrap">
            {`Couldn't read the file: ${drawable(doc.error)}`}
          </Text>
        )}
        {text !== undefined && <Markdown text={text.trim() === '' ? '_The file is empty._' : text} />}
        {text !== undefined && doc.isTruncated === true && drawNote(ui, 'Cut to fit here; ↗ Open file shows it whole.')}
      </Box>
    </Box>
  )
}
