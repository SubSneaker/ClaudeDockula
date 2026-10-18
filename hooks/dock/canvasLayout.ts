import type { DockulaLine, DockulaSpan } from '../../types'
import { cellWidth } from './ui'

/** What the user-panel canvas (hooks/dock/Canvas.tsx) gets as props: the pack's rows, cut to the card. */
export interface CanvasProps {
  panel: string
  dockId: string
  lines: DockulaLine[]
  columns: number
}

/**
 * The keyed span under a cell, by the same layout the canvas draws: one row per line, spans left to right
 * at their cell widths.
 * @example
 * // lines [[{ text: 'a ' }, { text: 'Card', key: 'c1' }]], x 3, y 0 → { text: 'Card', key: 'c1' }
 */
export function spanAt(lines: readonly DockulaLine[], x: number, y: number): DockulaSpan | undefined {
  const line = lines[y]
  if (!line || x < 0) return undefined
  let start = 0
  for (const span of line) {
    const end = start + cellWidth(span.text)
    if (x >= start && x < end) return span.key === undefined ? undefined : span
    start = end
  }

  return undefined
}

/** The panel and dock a canvas instance belongs to, from its Client key `u~<panel>~<dockId>`. */
export function parseCanvasKey(element: string): { panel: string; dockId: string } | undefined {
  const match = /^u~([a-z0-9-]+)~(main|\d+)$/.exec(element)

  return match?.[1] && match[2] ? { panel: match[1], dockId: match[2] } : undefined
}

export function canvasKey(panel: string, dockId: string): string {
  return `u~${panel}~${dockId}`
}
