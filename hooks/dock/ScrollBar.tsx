import type { ClientKeyEvent, ClientPointerEvent, ClientSurface, RenderElement } from 'claude-code'

import { isScrollable, scrollBarDragTarget, scrollBarGlyphs, scrollBarKeyMove, scrollBarPress, type ScrollBarProps, type ScrollMove } from './layout'

// The bottom dock's scrollbar: a one-column surface module beside the clipped cards. The engine sends no wheel
// or keys to a band that fits, so the cards scroll by this bar: it posts the move to the hooks module, which
// holds the scroll.

interface BarLocal {
  isHover?: boolean
  /** The row the thumb was grabbed at, and the cards' row then, while the button is held. */
  pressY?: number
  dragRow?: number
  /** The row the drag last asked for. */
  target?: number
}

function post(surface: ClientSurface<BarLocal>, props: ScrollBarProps, move: ScrollMove): void {
  surface.post({ type: 'scroll', ...move, max: props.max })
}

function handlePointer(event: ClientPointerEvent, props: ScrollBarProps, surface: ClientSurface<BarLocal>): void {
  const local = surface.state ?? {}
  if (event.type === 'move' && event.button === undefined && local.pressY !== undefined) {
    surface.setState({ isHover: true })

    return
  }
  if (event.type === 'enter' || event.type === 'leave' || (event.type === 'move' && event.button === undefined)) {
    const isHover = event.type !== 'leave'
    if (local.isHover !== isHover) surface.setState({ ...local, isHover })

    return
  }
  if (event.type === 'down' && event.button === 'left') {
    const press = scrollBarPress(props, event.y)
    if (press && 'by' in press) post(surface, props, press)
    else if (press) surface.setState({ ...local, pressY: event.y, dragRow: props.scrollRow, target: props.scrollRow })

    return
  }
  if (local.pressY === undefined || local.dragRow === undefined || event.button !== 'left') return
  if (event.type === 'move') {
    const target = scrollBarDragTarget(props, local.dragRow, event.y - local.pressY)
    if (target === local.target) return
    surface.setState({ ...local, target })
    post(surface, props, { to: target })
  } else if (event.type === 'up') {
    surface.setState({ isHover: local.isHover === true })
  }
}

function handleKey(event: ClientKeyEvent, props: ScrollBarProps, surface: ClientSurface<BarLocal>): void {
  if (event.ctrl || event.meta) return
  const move = scrollBarKeyMove(props, event.key)
  if (move) post(surface, props, move)
}

/** The bar: dim at rest, lit under the pointer and while the thumb is held. */
export default function ScrollBar(props: ScrollBarProps, surface: ClientSurface<BarLocal>): RenderElement {
  surface.onPointer(event => handlePointer(event, props, surface))
  const clearKey = surface.onKey(event => handleKey(event, props, surface))
  if (!isScrollable(props)) clearKey()
  const { Box, Text } = surface.elements
  const local = surface.state ?? {}
  const isLit = local.isHover === true || local.pressY !== undefined

  return (
    <Box flexDirection="column">
      {scrollBarGlyphs(props).map((glyph, row) => (
        <Text key={`row-${row}`} wrap="truncate-end" dimColor={!isLit} color={isLit ? 'suggestion' : undefined}>
          {glyph}
        </Text>
      ))}
    </Box>
  )
}
