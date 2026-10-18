import type { ClientSurface, RenderElement } from 'claude-code'

import { shouldPostMeasure, type MeasureProps } from './layout'

// A blank column beside the bottom dock's cards, stretched to their full height under the clip: its region's rows
// are the cards' height, which the hooks module bounds the scroll by. Called again on every resize, it posts only
// when the dock holds another height, so a post never leads to another.

export default function Measure(props: MeasureProps, surface: ClientSurface): RenderElement {
  const rows = surface.rows
  if (shouldPostMeasure(props, rows)) surface.post({ type: 'measure', dockId: props.dockId, rows })
  const { Text } = surface.elements

  return <Text> </Text>
}
