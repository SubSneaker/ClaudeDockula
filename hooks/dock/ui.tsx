import type { Elements, RenderSurface, ThemeKey } from 'claude-code'

// Pure drawing helpers shared by the dock and its panels: they take the element table, never `$`.

/** The elements every dock drawing uses: what `$.ui.resolve(e)` returns, on any surface. */
export type DockElements = Pick<Elements[RenderSurface], 'Box' | 'Text' | 'Button'>

/** Status colours: green passed, red failed, yellow running. */
export const TONE = { pass: 'success', fail: 'error', run: 'warning' } as const satisfies Record<string, ThemeKey>

/** Code points drawn two cells wide: CJK, fullwidth forms and emoji. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff],
  [0x20000, 0x3fffd],
]

const ZERO_WIDTH_JOINER = 0x200d
const EMOJI_PRESENTATION = 0xfe0f

function isZeroWidth(point: number): boolean {
  return (
    (point >= 0x300 && point <= 0x36f) ||
    (point >= 0x200b && point <= 0x200f) ||
    (point >= 0xfe00 && point <= 0xfe0f) ||
    (point >= 0x1f3fb && point <= 0x1f3ff)
  )
}

function pointCells(point: number): number {
  if (isZeroWidth(point)) {
    return 0
  }

  return WIDE_RANGES.some(([from, to]) => point >= from && point <= to) ? 2 : 1
}

/**
 * The cells each drawn character of `text` takes, a joined emoji sequence counted once.
 * @example
 * // before: '🌿 ABC-101'
 * // after:  [['🌿', 2], [' ', 1], ['P', 1], …]
 */
function measureChars(text: string): Array<[string, number]> {
  const measured: Array<[string, number]> = []
  let isJoined = false
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0
    const last = measured[measured.length - 1]
    if (isJoined && last) {
      last[0] += char
      isJoined = false
    } else if (point === ZERO_WIDTH_JOINER && last) {
      last[0] += char
      isJoined = true
    } else if (point === EMOJI_PRESENTATION && last) {
      last[0] += char
      last[1] = 2
    } else {
      measured.push([char, pointCells(point)])
    }
  }

  return measured
}

/** How many terminal cells `text` takes: emoji and CJK count two. */
export function cellWidth(text: string): number {
  return measureChars(text).reduce((sum, [, cells]) => sum + cells, 0)
}

/** Keeps the start of `text` within `cells`, marking a cut with `…`: `table-download-…`. */
export function fitEnd(text: string, cells: number): string {
  if (cellWidth(text) <= cells) {
    return text
  }
  let kept = ''
  let used = 0
  for (const [char, width] of measureChars(text)) {
    if (used + width > cells - 1) {
      break
    }
    kept += char
    used += width
  }

  return cells < 1 ? '' : `${kept}…`
}

/** Keeps the end of `text` within `cells`, marking a cut with `…`: `…_components/Item.tsx`. */
export function fitStart(text: string, cells: number): string {
  if (cellWidth(text) <= cells) {
    return text
  }
  let kept = ''
  let used = 0
  for (const [char, width] of measureChars(text).reverse()) {
    if (used + width > cells - 1) {
      break
    }
    kept = char + kept
    used += width
  }

  return cells < 1 ? '' : `…${kept}`
}

/** `text` cut to `cells` and padded with spaces to exactly that width, for a column. */
export function padCells(text: string, cells: number): string {
  const fitted = fitEnd(text, cells)

  return fitted + ' '.repeat(Math.max(0, cells - cellWidth(fitted)))
}

export interface PathParts {
  name: string
  dir: string
}

/** `src/app/Item.tsx` → `{ name: 'Item.tsx', dir: 'src/app' }`; a bare name has no dir. */
export function splitPath(path: string): PathParts {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')

  return cut < 0 ? { name: trimmed, dir: '' } : { name: trimmed.slice(cut + 1), dir: trimmed.slice(0, cut) }
}

export interface CardParts {
  /** The card's address, which `$.ui.scroll` brings into view. */
  key: string
  /** Cells the section is drawn across, so its rule is exactly as wide and never wraps. */
  cells: number
  /** Bold text for a plain title, or the header element (a toggle) drawn in its place. */
  title: string | JSX.Element
  /** Header controls drawn at the right end: settings, reorder. */
  controls?: JSX.Element[]
  body?: JSX.Element | null
}

/** An accordion section: a dim rule as wide as the section, the header row, then the body directly under it. */
export function drawCard(ui: DockElements, card: CardParts): JSX.Element {
  const { Box, Text } = ui
  const title =
    typeof card.title === 'string' ? (
      <Text bold wrap="truncate-end">
        {card.title}
      </Text>
    ) : (
      card.title
    )

  return (
    <Box key={card.key} flexDirection="column">
      <Box height={1} overflow="hidden">
        <Text dimColor mono wrap="wrap">
          {'─'.repeat(Math.max(1, card.cells))}
        </Text>
      </Box>
      <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Box flexShrink={1}>{title}</Box>
        {card.controls !== undefined && (
          <Box flexDirection="row" columnGap={1} flexShrink={0}>
            {card.controls}
          </Box>
        )}
      </Box>
      {card.body && <Box flexDirection="column">{card.body}</Box>}
    </Box>
  )
}

/** A group's title, bold, with a dim detail after it: `Files edited · 12`. */
export function drawHeading(ui: DockElements, title: string, detail?: string, tone?: ThemeKey): JSX.Element {
  const { Text } = ui

  return (
    <Text bold color={tone} wrap="truncate-end">
      {title}
      {detail !== undefined && <Text dimColor>{` · ${detail}`}</Text>}
    </Text>
  )
}

/** One dim line: an empty state, a loading note, why something is missing. */
export function drawNote(ui: DockElements, text: string): JSX.Element {
  const { Text } = ui

  return (
    <Text dimColor wrap="truncate-end">
      {text}
    </Text>
  )
}

/** `+N more` under a list that shows only its first rows; nothing when every row shows. */
export function drawMore(ui: DockElements, hidden: number): JSX.Element | null {
  return hidden > 0 ? drawNote(ui, `+${hidden} more`) : null
}

/** A row of buttons under a card's groups, a blank row above it. */
export function drawActions(ui: DockElements, buttons: JSX.Element[]): JSX.Element {
  const { Box } = ui

  return (
    <Box flexDirection="row" columnGap={2} marginTop={1}>
      {buttons}
    </Box>
  )
}

export interface FieldRow {
  label: string
  value: string
  tone?: ThemeKey
}

/** Label and value rows with the values in one column: `Status    In Review`. */
export function drawFieldRows(ui: DockElements, rows: FieldRow[]): JSX.Element {
  const { Box, Text } = ui
  const labelCells = Math.max(0, ...rows.map(row => cellWidth(row.label))) + 2

  return (
    <Box flexDirection="column">
      {rows.map(row => (
        <Box flexDirection="row">
          <Box width={labelCells} flexShrink={0}>
            <Text dimColor>{row.label}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text bold color={row.tone} wrap="truncate-end">
              {row.value}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

export interface FileRow {
  path: string
  /** What stands before the name (a git status code), and the cells it takes. */
  lead?: JSX.Element
  leadCells?: number
  /** A dim note at the row's right end: `×3`. */
  trail?: string
}

/**
 * The file's name first, then its folder dim, cut from the start so the nearest folders stay:
 * `M  ExportButton.tsx  …/documents/_components`.
 */
export function drawFileRow(ui: DockElements, row: FileRow, columns: number): JSX.Element {
  const { Box, Text } = ui
  const { name, dir } = splitPath(row.path)
  const trailCells = row.trail === undefined ? 0 : cellWidth(row.trail) + 2
  const room = Math.max(1, columns - (row.leadCells ?? 0) - trailCells)
  const shownName = fitStart(name, room)
  const dirRoom = room - cellWidth(shownName) - 2
  const shownDir = dir !== '' && dirRoom >= 6 ? fitStart(dir, dirRoom) : ''

  return (
    <Box flexDirection="row">
      {row.lead}
      <Text>{shownName}</Text>
      {shownDir !== '' && <Text dimColor>{`  ${shownDir}`}</Text>}
      <Box flexGrow={1} />
      {row.trail !== undefined && <Text dimColor>{`  ${row.trail}`}</Text>}
    </Box>
  )
}
