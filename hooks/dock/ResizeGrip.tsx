import type { ClientPointerEvent, ClientSurface, RenderElement } from 'claude-code'

import { resizeTarget, type GripProps } from './layout'
import { cellWidth } from './ui'

// The bottom dock's top edge: a one-row surface module the person drags up (taller) or down (shorter). It
// holds the drag locally, shows the height it would set, and posts it to the hooks module on release.

interface GripLocal {
  isHover?: boolean
  /** The row the press went down on, while the button is held. */
  pressY?: number
  /** The height the drag would set now. */
  target?: number
}

/** `╶──── ⠿ drag to resize ────╴`: the label centred on a rule `columns` wide. */
export function gripLine(label: string, columns: number): string {
  const room = Math.max(0, columns - 2)
  const text = ` ${label} `
  const fill = Math.max(0, room - cellWidth(text))
  const left = Math.floor(fill / 2)

  return room < cellWidth(text) ? label : `╶${'─'.repeat(left)}${text}${'─'.repeat(fill - left)}╴`
}

function gripLabel(props: GripProps, target: number | undefined): string {
  if (target === undefined) return '⠿ drag to resize'
  let limit = ''
  if (target >= props.max) limit = ' · max'
  else if (target <= props.min) limit = ' · min'

  return `↕ ${target} rows${limit}`
}

function handlePointer(event: ClientPointerEvent, props: GripProps, surface: ClientSurface<GripLocal>): void {
  const local = surface.state ?? {}
  if (event.type === 'enter' || event.type === 'leave' || (event.type === 'move' && event.button === undefined)) {
    const isHover = event.type !== 'leave'
    if (local.isHover !== isHover) surface.setState({ ...local, isHover })

    return
  }
  if (event.type === 'down' && event.button === 'left') {
    surface.setState({ ...local, pressY: event.y, target: props.base })

    return
  }
  if (local.pressY === undefined || event.button !== 'left') return
  const target = resizeTarget(props.base, event.y - local.pressY, props.min, props.max)
  if (event.type === 'move') {
    if (target !== local.target) surface.setState({ ...local, target })
  } else if (event.type === 'up') {
    surface.setState({ isHover: local.isHover === true })
    if (target !== props.base) surface.post({ type: 'resize', rows: target, max: props.max })
  }
}

/** The grip: dim at rest, lit under the pointer and while held, the height it would set shown during a drag. */
export default function ResizeGrip(props: GripProps, surface: ClientSurface<GripLocal>): RenderElement {
  surface.onPointer(event => handlePointer(event, props, surface))
  const { Text } = surface.elements
  const local = surface.state ?? {}
  const isLit = local.isHover === true || local.pressY !== undefined
  const columns = Math.max(1, surface.columns > 0 ? surface.columns : props.columns)

  return (
    <Text wrap="truncate-end" dimColor={!isLit} color={isLit ? 'suggestion' : undefined}>
      {gripLine(gripLabel(props, local.target), columns)}
    </Text>
  )
}
