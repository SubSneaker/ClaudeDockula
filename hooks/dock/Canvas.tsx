import type { ClientKeyEvent, ClientPointerEvent, ClientSurface, RenderElement } from 'claude-code'

import type { DockulaEvent, DockulaSpan } from '../../types'
import { spanAt, type CanvasProps } from './canvasLayout'

// The dock's generic canvas for a user panel: it draws the pack's rows (plain data in props), keeps a drag
// locally (the source and the target under the pointer are highlighted with no round trip) and posts only
// what the pack answers: a click, a drop, a right-click, a key. Moves are not posted.

interface Local {
  press?: { key?: string; x: number; y: number; canDrag: boolean }
  /** The span the held pointer is over while dragging, when it takes drops. */
  over?: string
  isDragging?: boolean
  /** The span last clicked: keys go to it. */
  focus?: string
}

function modifiers(event: ClientPointerEvent): Pick<DockulaEvent, 'shift' | 'alt' | 'ctrl'> {
  return { ...(event.shift ? { shift: true } : {}), ...(event.alt ? { alt: true } : {}), ...(event.ctrl ? { ctrl: true } : {}) }
}

function handlePointer(event: ClientPointerEvent, props: CanvasProps, surface: ClientSurface<Local>): void {
  const local = surface.state ?? {}
  const span = spanAt(props.lines, event.x, event.y)
  const at = { x: event.x, y: event.y, ...modifiers(event) }
  if (event.type === 'down' && event.button === 'right') {
    surface.post({ type: 'context', ...(span?.key ? { key: span.key } : {}), button: 'right', ...at })

    return
  }
  if (event.type === 'down' && event.button === 'left') {
    surface.setState({ ...local, press: { ...(span?.key ? { key: span.key } : {}), x: event.x, y: event.y, canDrag: span?.drag === true } })

    return
  }
  const press = local.press
  if (!press || event.button !== 'left') return
  if (event.type === 'move') {
    const isDragging = press.canDrag && (local.isDragging === true || event.x !== press.x || event.y !== press.y)
    const over = span?.drop && span.key !== press.key ? span.key : undefined
    if (isDragging !== local.isDragging || over !== local.over) surface.setState({ press, isDragging, ...(over ? { over } : {}), ...(local.focus ? { focus: local.focus } : {}) })

    return
  }
  if (event.type !== 'up') return
  const focus = press.key ?? local.focus
  surface.setState(focus ? { focus } : {})
  if (local.isDragging && press.key) {
    if (local.over) surface.post({ type: 'drop', from: press.key, key: local.over, button: 'left', ...at })

    return
  }
  if (press.key && span?.key === press.key) surface.post({ type: 'click', key: press.key, button: 'left', ...at })
}

function handleKey(event: ClientKeyEvent, surface: ClientSurface<Local>): void {
  const focus = surface.state?.focus
  surface.post({
    type: 'key',
    name: event.key,
    ...(focus ? { key: focus } : {}),
    x: 0,
    y: 0,
    ...(event.shift ? { shift: true } : {}),
    ...(event.ctrl ? { ctrl: true } : {}),
  })
}

function spanLook(span: DockulaSpan): Pick<DockulaSpan, 'color' | 'weight'> {
  return { ...(span.color ? { color: span.color } : {}), ...(span.weight ? { weight: span.weight } : {}) }
}

export default function Canvas(props: CanvasProps, surface: ClientSurface<Local>): RenderElement {
  surface.onPointer(event => handlePointer(event, props, surface))
  surface.onKey(event => handleKey(event, surface))
  const { Box, Text } = surface.elements
  const local = surface.state ?? {}
  const source = local.isDragging ? local.press?.key : undefined

  return (
    <Box flexDirection="column" width={props.columns}>
      {props.lines.map(line => (
        <Text wrap="truncate-end">
          {line.length === 0
            ? ' '
            : line.map(span => (
                <Text
                  {...spanLook(span)}
                  dimColor={span.dim === true || (source !== undefined && span.key === source)}
                  inverse={span.inverse === true || (span.key !== undefined && span.key === local.over)}
                >
                  {span.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  )
}
