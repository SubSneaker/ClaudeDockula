import type { ClientElements, ClientKeyEvent, ClientPointerEvent, ClientSurface, RenderElement } from 'claude-code'

import { typeIntoQuery } from './feed'
import { CURSOR, GUTTER, keyAt, searchRow, type FeedMessage, type FeedProps, type FeedRow } from './rows'

// The feed's surface module: it draws the rows the hooks module (hooks/panels/slacker.tsx) laid out, keeps the
// search box's keys and the arrow-key cursor locally, and posts a click, a right-click, the typed filter or
// Enter's search for the hooks module to act on.

interface FeedLocal {
  /** The search box has the keys. */
  isTyping: boolean
  /** What is typed while it has them; each change is posted whole, so a post replaced in a frame loses nothing. */
  query: string
  /** The key of the row the arrow keys are on (an item, a menu entry), by what it names. */
  cursor?: string
  press?: { y: number; key?: string }
}

function readLocal(surface: ClientSurface<FeedLocal>, props: FeedProps): FeedLocal {
  return surface.state ?? { isTyping: false, query: props.query }
}

function post(surface: ClientSurface<FeedLocal>, message: FeedMessage): void {
  surface.post(message)
}

/** The rows as drawn: the search box from what is typed here while it has the keys. */
function rowsOf(props: FeedProps, local: FeedLocal): FeedRow[] {
  if (!local.isTyping) return props.rows
  const typing = searchRow(local.query, true, props.isBusy, props.columns)

  return props.rows.map(row => (row.key === 'search' ? typing : row))
}

function stopsOf(rows: readonly FeedRow[]): string[] {
  return rows.flatMap(row => (row.isStop && row.key !== undefined ? [row.key] : []))
}

/** A press and release on one key: the search box takes the keys here, anything else goes to the hooks module. */
function click(surface: ClientSurface<FeedLocal>, local: FeedLocal, props: FeedProps, key: string | undefined): void {
  if (key === 'search') {
    surface.setState({ ...local, isTyping: true, query: local.isTyping ? local.query : props.query })

    return
  }
  const isStop = stopsOf(props.rows).includes(key ?? '')
  surface.setState({ ...local, isTyping: false, ...(key === 'clear-query' ? { query: '' } : {}), ...(isStop ? { cursor: key } : {}) })
  post(surface, { type: 'click', ...(key === undefined ? {} : { key }) })
}

/** Left: a click is a press and release on the same key of the same row. Right: the item's menu at once. */
function handlePointer(event: ClientPointerEvent, props: FeedProps, surface: ClientSurface<FeedLocal>): void {
  const local = readLocal(surface, props)
  const key = keyAt(rowsOf(props, local)[event.y], event.x)
  if (event.button === 'right') {
    if (event.type !== 'down') return
    surface.setState({ ...local, isTyping: false, press: undefined })
    post(surface, { type: 'context', ...(key === undefined ? {} : { key }) })

    return
  }
  if (event.button !== 'left') return
  if (event.type === 'down') {
    surface.setState({ ...local, press: { y: event.y, ...(key === undefined ? {} : { key }) } })
  } else if (event.type === 'up') {
    const { press } = local
    const settled = { ...local, press: undefined }
    if (press && press.y === event.y && press.key === key) click(surface, settled, props, key)
    else surface.setState(settled)
  }
}

/** Where ↓ (`step` 1) or ↑ (-1) takes the cursor: from nowhere to the first or last stop, else one on, held to the ends. */
function nextStop(at: number, step: number, count: number): number {
  if (at === -1) return step === 1 ? 0 : count - 1

  return Math.min(count - 1, Math.max(0, at + step))
}

/** ↑ ↓ through the items and menu entries, Enter opens one, m (or ⋯) its menu. */
function keyOnList(event: ClientKeyEvent, local: FeedLocal, props: FeedProps, surface: ClientSurface<FeedLocal>): void {
  const stops = stopsOf(props.rows)
  const at = local.cursor === undefined ? -1 : stops.indexOf(local.cursor)
  if (event.key === 'down' || event.key === 'up') {
    const cursor = stops[nextStop(at, event.key === 'down' ? 1 : -1, stops.length)]
    if (cursor !== undefined) surface.setState({ ...local, isTyping: false, cursor })

    return
  }
  const cursor = at === -1 ? undefined : stops[at]
  if (cursor === undefined) return
  if (event.key === 'return') post(surface, { type: 'click', key: cursor })
  else if (event.key === 'm') post(surface, { type: 'context', key: cursor })
}

/** While the box has the keys, typing filters the feed and Enter searches all of Slack; the arrows leave it. */
function handleKey(event: ClientKeyEvent, props: FeedProps, surface: ClientSurface<FeedLocal>): void {
  const local = readLocal(surface, props)
  if (!local.isTyping) {
    keyOnList(event, local, props, surface)

    return
  }
  const typed = typeIntoQuery(local.query, event.key, event.ctrl === true)
  if (typed) {
    surface.setState({ ...local, query: typed.query, isTyping: typed.isSubmit !== true })
    post(surface, { type: typed.isSubmit ? 'search' : 'query', query: typed.query })
  } else if (event.key === 'down' || event.key === 'up') {
    keyOnList(event, { ...local, isTyping: false }, props, surface)
  }
}

function drawRow(ui: ClientElements, row: FeedRow, local: FeedLocal): JSX.Element {
  const { Text } = ui
  if (row.segments.length === 0) return <Text> </Text>
  const hasCursor = row.isStop === true && row.key !== undefined && row.key === local.cursor

  return (
    <Text wrap="truncate-end">
      {row.segments.map((one, index) => (
        <Text color={one.color} dimColor={one.isDim} bold={one.isBold} inverse={one.isInverse}>
          {hasCursor && index === 0 && one.text === GUTTER ? CURSOR : one.text}
        </Text>
      ))}
    </Text>
  )
}

/** The feed as the person clicks, right-clicks, types into and steers it with the keys. */
export default function SlackerFeed(props: FeedProps, surface: ClientSurface<FeedLocal>): RenderElement {
  surface.onPointer(event => handlePointer(event, props, surface))
  surface.onKey(event => handleKey(event, props, surface))
  const { Box } = surface.elements
  const local = readLocal(surface, props)

  return (
    <Box flexDirection="column" width={props.columns}>
      {rowsOf(props, local).map(row => drawRow(surface.elements, row, local))}
    </Box>
  )
}
