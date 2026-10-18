import type { DockulaEvent, DockulaLine, DockulaPanelInfo, DockulaSpan } from '../../types'

// What panel packs (other plugins) answer is read as untrusted data: these keep only what the dock can draw.

const PANEL_ID = /^[a-z0-9-]+$/
const RESERVED_IDS: readonly string[] = ['add', 'layout']
const FALLBACK_ICON = '🧩'
const MAX_KEY_LENGTH = 200
export const MAX_ROWS = 200
/** Well under the 100,000 characters a Client's props may hold, leaving room for the rest of its props. */
export const MAX_ROW_CHARS = 60_000
const WEIGHTS: readonly NonNullable<DockulaSpan['weight']>[] = ['regular', 'medium', 'semibold', 'bold']
const CUT_NOTE: DockulaLine = [{ text: '…cut', dim: true }]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export interface PackPanels {
  panels: DockulaPanelInfo[]
  /** One line per entry left out, saying why. */
  dropped: string[]
}

/**
 * The panels the packs listed, each with a usable id once: not a built-in's or a reserved one, letters, digits
 * and `-` only; a missing title or icon falls back.
 * @example
 * // ([{ id: 'deploys', title: '' }, { id: 'jira' }, { id: 'Bad Id' }, 7], ['jira'])
 * // → panels [{ id: 'deploys', title: 'deploys', icon: '🧩', description: '' }], dropped: 3 lines
 */
export function readPackPanels(raw: unknown, builtInIds: readonly string[]): PackPanels {
  const panels: DockulaPanelInfo[] = []
  const dropped: string[] = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    const id = isRecord(entry) ? entry.id : undefined
    const shown = typeof id === 'string' ? `"${id.slice(0, 40)}"` : 'an entry with no id'
    if (typeof id !== 'string' || !PANEL_ID.test(id) || RESERVED_IDS.includes(id)) {
      dropped.push(`${shown}: an id is lowercase letters, digits and -`)
    } else if (builtInIds.includes(id)) {
      dropped.push(`${shown}: a built-in panel has that id`)
    } else if (panels.some(panel => panel.id === id)) {
      dropped.push(`${shown}: listed twice`)
    } else if (isRecord(entry)) {
      const description = nonBlank(entry.description)
      panels.push({ id, title: nonBlank(entry.title) ?? id, icon: nonBlank(entry.icon) ?? FALLBACK_ICON, description: description ?? '' })
    }
  }

  return { panels, dropped }
}

function readSpan(value: unknown): DockulaSpan | undefined {
  if (!isRecord(value) || typeof value.text !== 'string') return undefined
  const { key, color, weight } = value
  const span: DockulaSpan = { text: value.text }
  if (typeof key === 'string' && key !== '' && key.length <= MAX_KEY_LENGTH) span.key = key
  if (typeof color === 'string' && color !== '') span.color = color
  const known = WEIGHTS.find(one => one === weight)
  if (known) span.weight = known
  if (value.dim === true) span.dim = true
  if (value.inverse === true) span.inverse = true
  if (value.drag === true) span.drag = true
  if (value.drop === true) span.drop = true

  return span
}

/**
 * A pack's card rows, kept to arrays of spans with string text and to the dock's bounds; rows past them give
 * way to one dim `…cut` line. Not an array at all reads as nothing drawn.
 * @example
 * // ([[{ text: 'a', key: 'k', onPress: 1 }], 'x', [{ text: 2 }]]) → [[{ text: 'a', key: 'k' }], []]
 */
export function readPackLines(raw: unknown, maxRows = MAX_ROWS, maxChars = MAX_ROW_CHARS): DockulaLine[] | null {
  if (!Array.isArray(raw)) return null
  const lines: DockulaLine[] = []
  let chars = 0
  for (const row of raw) {
    if (!Array.isArray(row)) continue
    const line = row.flatMap(value => readSpan(value) ?? [])
    chars += JSON.stringify(line).length
    if (lines.length >= maxRows || chars > maxChars) return [...lines, CUT_NOTE]
    lines.push(line)
  }

  return lines
}

/** The band text a pack gave, or `–`: one line, a few cells. */
export function readPackSummary(raw: unknown): string {
  const text = nonBlank(raw)

  return text === undefined ? '–' : text.replace(/\s+/g, ' ').slice(0, 24)
}

const EVENT_TYPES: readonly DockulaEvent['type'][] = ['click', 'drop', 'context', 'key']
const BUTTONS: readonly NonNullable<DockulaEvent['button']>[] = ['left', 'middle', 'right']

/** The canvas's post as an event, its known fields only: the data came from code. */
export function readCanvasEvent(data: unknown): DockulaEvent | undefined {
  if (!isRecord(data)) return undefined
  const type = EVENT_TYPES.find(one => one === data.type)
  const { x, y, key, from, name } = data
  if (!type || typeof x !== 'number' || typeof y !== 'number') return undefined
  const button = BUTTONS.find(one => one === data.button)

  return {
    type,
    x,
    y,
    ...(typeof key === 'string' ? { key } : {}),
    ...(typeof from === 'string' ? { from } : {}),
    ...(typeof name === 'string' ? { name } : {}),
    ...(button ? { button } : {}),
    ...(data.shift === true ? { shift: true } : {}),
    ...(data.alt === true ? { alt: true } : {}),
    ...(data.ctrl === true ? { ctrl: true } : {}),
  }
}
