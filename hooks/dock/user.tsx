import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderInput } from 'claude-code'

import type { DockulaLine, DockulaPanelInfo, DockulaSpan } from '../../types'
import { PANELS } from '../panels'
import type { DockPanel } from '../panels/contract'
import { canvasKey, parseCanvasKey } from './canvasLayout'
import { NO_NOTICES, pushNotice } from './notices'
import { readCanvasEvent, readPackLines, readPackPanels, readPackSummary } from './packs'
import { drawNote } from './ui'

// User panels: the `$.dockula` noun panel packs (other plugins) hook. The dock draws a pack's rows in its own
// canvas Client (hooks/dock/Canvas.tsx) where the surface has one, and relays the canvas's events back through
// `dockula.input`; elsewhere the keyed spans become Buttons.

type DockSite = RenderInput<'Pane'> | RenderInput<'AbovePrompt'>

const userPanelsAtom = atom({ plugin: 'claudedockula', key: 'userPanels' } as const, [])
const revisionAtom = atom({ plugin: 'claudedockula', key: 'userRevision' } as const, 0)
const noticesAtom = atom({ plugin: 'claudedockula', key: 'notices' } as const, NO_NOTICES)
const BUILT_IN_IDS = PANELS.map(panel => panel.id)
const BUTTON_PREFIX = 'uk~'
const BUTTON_KEY = /^uk~([a-z0-9-]+)~(main|\d+)~(.+)$/

interface PlainTarget {
  panel: string
  dockId: string
}

function lookOf(span: DockulaSpan): Pick<DockulaSpan, 'color' | 'weight'> {
  return { ...(span.color ? { color: span.color } : {}), ...(span.weight ? { weight: span.weight } : {}) }
}

export function userPanelsOf(list: readonly DockulaPanelInfo[]): DockPanel[] {
  return list.map(info => ({ ...info, isBuiltIn: false }))
}

/** The band text a pack gives its panel; `–` when it says nothing or fails. */
export async function summarizeUserPanel($: EngineInterface, panel: string): Promise<string> {
  await read($, revisionAtom)

  return readPackSummary(await $.dockula.summary({ panel }).catch(() => undefined))
}

function drawPlainLines($: EngineInterface, e: DockSite, target: PlainTarget, lines: readonly DockulaLine[], columns: number) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const keyOf = (spanKey: string) => `${BUTTON_PREFIX}${target.panel}~${target.dockId}~${spanKey}`

  return (
    <Box flexDirection="column" width={columns}>
      {lines.map(line => (
        <Box flexDirection="row">
          {line.length === 0
            ? ' '
            : line.map(span =>
                span.key === undefined ? (
                  <Text {...lookOf(span)} dimColor={span.dim === true} inverse={span.inverse === true} wrap="truncate-end">
                    {span.text}
                  </Text>
                ) : (
                  <Button key={keyOf(span.key)} plain label={span.text} onPress={() => undefined} />
                ),
              )}
        </Box>
      ))}
    </Box>
  )
}

/** A user panel's card body: the pack's rows in the canvas on the terminal and desktop, Buttons elsewhere. */
export async function drawUserPanel($: EngineInterface, e: DockSite, panel: string, columns: number, dockId: string) {
  await read($, revisionAtom)
  const ui = $.ui.resolve(e)
  const lines = readPackLines(await $.dockula.draw({ panel, surface: e.surface, columns, dockId }).catch(() => null))
  if (lines === null) return drawNote(ui, 'This panel drew nothing.')
  if ((e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in ui) {
    const { Client } = $.ui.resolve(e)

    return <Client key={canvasKey(panel, dockId)} module="./Canvas.tsx" props={{ panel, dockId, lines, columns }} width={columns} />
  }

  return drawPlainLines($, e, { panel, dockId }, lines, columns)
}

async function readPanels($: EngineInterface): Promise<void> {
  const { panels, dropped } = readPackPanels(await $.dockula.panels().catch(() => []), BUILT_IN_IDS)
  await update($, userPanelsAtom, () => panels)
  if (dropped.length === 0) return
  const at = await $.clock.now()
  const notice = { tone: 'error', title: "Some of your panels weren't loaded", detail: dropped.join('\n'), topic: 'pack-panels', at } as const
  await update($, noticesAtom, list => pushNotice(list, notice))
}

async function bump($: EngineInterface): Promise<void> {
  await update($, revisionAtom, revision => revision + 1)
}

export function registerUserPanelHooks(on: On): void {
  // The noun's bottom: what `$.dockula.*` answers when no pack hooks the call.
  on('engine.create', async (_$, e, next) => {
    const built = await next(e)

    return {
      ...built,
      dockula: {
        panels: async () => [],
        draw: async () => null,
        summary: async () => '–',
        input: async () => ({ handled: false }),
        changed: async () => ({ isQueued: false }),
      },
    }
  })

  // Answered at once, the work done after: while the pack's call is pending its hooks are skipped for anything
  // raised beneath it, so a redraw or a `panels()` read then would get the bottom answers.
  on('dockula.changed', async $ => {
    $.clock.after(0, () => void readPanels($).then(() => bump($)))

    return { value: { isQueued: true } }
  })

  on('ui.message', { element: /^u~/ }, async ($, e) => {
    const target = parseCanvasKey(e.element)
    const event = readCanvasEvent(e.data)
    if (!target || !event) return {}
    const answer = await $.dockula.input({ ...target, surface: e.surface, event }).catch(() => ({ handled: false }))
    if (answer.handled === true) await bump($)

    return {}
  })

  on('ui.press', { plugin: 'claudedockula', element: /^uk~/ }, async ($, e) => {
    const [, panel, dockId, key] = BUTTON_KEY.exec(e.element) ?? []
    if (panel && dockId && key) {
      const answer = await $.dockula
        .input({ panel, dockId, surface: e.surface, event: { type: 'click', key, x: 0, y: 0 } })
        .catch(() => ({ handled: false }))
      if (answer.handled === true) await bump($)
    }

    return { element: e.element }
  })
}
