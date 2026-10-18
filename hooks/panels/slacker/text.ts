import { cellWidth, fitEnd } from '../../dock/ui'

// Pure text wrapping by terminal cells (emoji and CJK take two). No `$` here.

/** One paragraph wrapped at word breaks to `width` cells; a word wider than a line is split. */
function wrapParagraph(paragraph: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of paragraph.split(/\s+/).filter(part => part !== '')) {
    const joined = line === '' ? word : `${line} ${word}`
    if (cellWidth(joined) <= width) {
      line = joined
      continue
    }
    if (line !== '') lines.push(line)
    line = ''
    for (const char of word) {
      if (cellWidth(line + char) > width) {
        lines.push(line)
        line = ''
      }
      line += char
    }
  }
  if (line !== '') lines.push(line)

  return lines
}

/**
 * `value` wrapped to `width` cells, its own line breaks kept, at most `maxLines` (the last ending in `…`).
 * @example
 * // ('one two three four', 9, 2) → ['one two', 'three fo…']
 */
export function wrapText(value: string, width: number, maxLines: number): string[] {
  const safeWidth = Math.max(4, width)
  const lines = value.split('\n').flatMap(paragraph => (paragraph.trim() === '' ? [] : wrapParagraph(paragraph, safeWidth)))
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  const last = kept[maxLines - 1] ?? ''

  return [...kept.slice(0, -1), fitEnd(`${last} …`, safeWidth)]
}
