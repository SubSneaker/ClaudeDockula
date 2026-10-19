import type { On, RenderPropsOf } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { readCanvasEvent, readPackLines, readPackPanels, readPackSummary } from '../hooks/dock/packs'

// A panel pack is another plugin: here an inline one, `dockula-panels`, with one panel `demo` holding two
// lanes of cards. It only hooks `$.dockula.*`; the dock draws its rows in the dock's own canvas Client and
// relays the canvas's drops, right-clicks, clicks and keys back to it.

function paneProps(bodyColumns: number): RenderPropsOf['Pane'] {
  return { title: 'Dock', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }
}

function bandProps(bodyColumns: number): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns, scroll: { offset: 0, bodyRows: 11 }, view: {} }
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'children' in node) return textOf(node.children)

  return ''
}

function rowsOf(tree: unknown): string[] {
  const children = typeof tree === 'object' && tree !== null && 'children' in tree ? tree.children : []

  return Array.isArray(children) ? children.map(textOf) : []
}

const pack = {
  name: 'dockula-panels',
  register(on: On) {
    const lanes: Record<string, string[]> = { todo: ['Write spike', 'Read d.ts'], done: [] }
    let menu = ''
    let lastKey = ''
    const laneOf = (card: string) => Object.keys(lanes).find(lane => lanes[lane]?.includes(card))

    on('dockula.panels', async ($, e, next) => {
      const below = await next(e)

      return 'value' in below ? { value: [...(below.value ?? []), { id: 'demo', title: 'Demo', icon: '🧪', description: 'A drag demo' }] } : below
    })
    on('dockula.summary', { panel: 'demo' }, async () => ({ value: `${lanes.done?.length ?? 0} done` }))
    on('dockula.draw', { panel: 'demo' }, async () => {
      const lines = Object.entries(lanes).flatMap(([lane, cards]) => [
        [{ text: ` ${lane.toUpperCase()} (${cards.length})`, key: `lane:${lane}`, weight: 'semibold', drop: true }],
        ...cards.map(card => [{ text: '   ' }, { text: card, key: `card:${card}`, drag: true }]),
      ])
      const extra = [menu ? [{ text: ` menu: ${menu}` }] : [], lastKey ? [{ text: ` key: ${lastKey}` }] : []].filter(line => line.length > 0)

      return { value: [...lines, ...extra] }
    })
    on('dockula.input', { panel: 'demo' }, async ($, e) => {
      const { event } = e
      await $.prompt.fill({ text: `${event.type} ${event.from ?? ''}→${event.key ?? ''} @${event.x},${event.y} ${event.button ?? event.name ?? ''}` })
      if (event.type === 'drop' && event.from?.startsWith('card:') && event.key?.startsWith('lane:')) {
        const card = event.from.slice(5)
        const from = laneOf(card)
        const to = event.key.slice(5)
        if (from && lanes[to] && from !== to) {
          lanes[from] = (lanes[from] ?? []).filter(one => one !== card)
          lanes[to] = [...(lanes[to] ?? []), card]
        }
      } else if (event.type === 'context') {
        menu = event.key ?? '(nothing)'
      } else if (event.type === 'key' && event.name === 'n') {
        // Work that lands later (a fetch, a timer): the pack asks the dock to redraw itself.
        $.clock.after(100, () => {
          lanes.todo = [...(lanes.todo ?? []), 'Late card']
          void $.dockula.changed()
        })
      } else if (event.type === 'key') {
        lastKey = `${event.name ?? ''} on ${event.key ?? '-'}`
      }

      return { value: { handled: true } }
    })
  },
} as const

test('a pack panel in the dock: drag a card across lanes, right-click, keys; Buttons where there is no Client', { plugins: [pack] }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  // The session starts: the dock reads the packs' panels (a hook of another plugin on its noun) and the new one
  // joins the active view.
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(80) })
  expect((await band.find({ key: 'dock-tab-demo' }))?.text).toBe('🧪 0 done')
  await band.unmount()

  const ui = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  const canvas = { in: 'u~demo~main' }
  const rows = rowsOf(await ui.drawn(canvas))
  expect(rows).toEqual([' TODO (2)', '   Write spike', '   Read d.ts', ' DONE (0)'])

  // Drag "Write spike" onto the DONE lane: moves are kept in the canvas (the target lights up), one drop is posted.
  const from = rows.indexOf('   Write spike')
  const done = rows.indexOf(' DONE (0)')
  await ui.pointer({ ...canvas, type: 'down', x: 5, y: from, button: 'left' })
  await ui.pointer({ ...canvas, type: 'move', x: 5, y: from + 1, button: 'left' })
  await ui.pointer({ ...canvas, type: 'move', x: 3, y: done, button: 'left' })
  expect(filled).toHaveLength(0)
  const held = await ui.findAll({ in: 'u~demo~main', type: 'Text', text: ' DONE (0)' })
  expect(held.some(found => found.props.inverse === true)).toBe(true)
  await ui.pointer({ ...canvas, type: 'up', x: 3, y: done, button: 'left' })
  expect(filled).toEqual([`drop card:Write spike→lane:done @3,${done} left`])
  expect(rowsOf(await ui.drawn(canvas))).toEqual([' TODO (1)', '   Read d.ts', ' DONE (1)', '   Write spike'])

  // A right-click names the span under it; a key goes to the span last clicked.
  await ui.pointer({ ...canvas, type: 'down', x: 4, y: 1, button: 'right' })
  expect(rowsOf(await ui.drawn(canvas))).toContain(' menu: card:Read d.ts')
  await ui.pointer({ ...canvas, type: 'down', x: 4, y: 1, button: 'left' })
  await ui.pointer({ ...canvas, type: 'up', x: 4, y: 1, button: 'left' })
  await ui.key({ ...canvas, key: 'delete' })
  expect(rowsOf(await ui.drawn(canvas))).toContain(' key: delete on card:Read d.ts')
  expect(filled.slice(1)).toEqual([
    'context →card:Read d.ts @4,1 right',
    'click →card:Read d.ts @4,1 left',
    'key →card:Read d.ts @0,0 delete',
  ])

  // A change the pack makes later, outside any canvas event, redraws through `$.dockula.changed()`.
  await ui.key({ ...canvas, key: 'n' })
  expect(rowsOf(await ui.drawn(canvas))).not.toContain('   Late card')
  await clock.advance(100)
  expect(rowsOf(await ui.drawn(canvas))).toContain('   Late card')
  await ui.unmount()

  // The band's summary follows the pack's state.
  const after = await $.ui.mount({ plugin: 'claudedockula', surface: 'desktop', component: 'AbovePrompt', props: bandProps(80) })
  expect((await after.find({ key: 'dock-tab-demo' }))?.text).toBe('🧪 1 done')
  await after.unmount()

  // No Client on vscode or mobile: the keyed spans are Buttons, a press reaches the pack as a click.
  for (const surface of ['vscode', 'mobile'] as const) {
    const plain = await $.ui.mount({ plugin: 'claudedockula', surface, component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
    await expect(plain.drawn()).resolves.toBeDefined()
    await plain.press({ key: 'uk~demo~main~card:Read d.ts' })
    expect(filled.at(-1)).toBe('click →card:Read d.ts @0,0 ')
    await plain.unmount()
  }
})

/** A pack whose one panel is listed only while the test says so, as a plugin that is not loaded yet is not. */
const flickering = {
  name: 'dockula-panels',
  register(on: On) {
    on('dockula.panels', async ($, e, next) => {
      const below = await next(e)
      if ((await $.env.get('DEMO_PANEL')) !== 'on') return below

      return 'value' in below ? { value: [...(below.value ?? []), { id: 'demo', title: 'Demo', icon: '🧪', description: 'A demo' }] } : below
    })
    on('dockula.draw', { panel: 'demo' }, async () => ({ value: [[{ text: 'hello' }]] }))
  },
} as const

test('a pack panel missing at session start keeps its place, comes back to it, and only Remove forgets it', { plugins: [flickering] }, async ($, on) => {
  mock.clock(on)
  mock.store(on)
  let demo = 'on'
  on('env.get', ($, e) => ({ value: e.name === 'DEMO_PANEL' ? demo : undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal', isStdoutTruncated: false, isStderrTruncated: false } }))
  const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
  // The main dock's cards in order, each with its header toggle: `▸` while minimized.
  const placement = async () => {
    const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
    const toggles = (await pane.findAll({ type: 'Button' })).filter(found => found.key?.startsWith('dock-main-toggle-'))
    await pane.unmount()

    return toggles.map(found => `${found.key ?? ''} ${found.text?.trimEnd()}`)
  }

  await $.session.start(start)
  const pane = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await pane.press({ key: 'dock-main-up-1-demo' })
  await pane.press({ key: 'dock-main-toggle-demo' })
  await pane.unmount()
  const placed = await placement()
  expect(placed.slice(-2)).toEqual(['dock-main-toggle-demo ▸ 🧪 Demo', 'dock-main-toggle-jira ▾ 🎫 Jira · assigned to me'])

  // The pack does not list it: no card, no tab, a dim row in Manage.
  demo = 'off'
  await $.session.start(start)
  expect(await placement()).toEqual(placed.filter(row => !row.includes('-demo')))
  const missing = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await missing.press({ key: 'dock-main-manage' })
  expect(await missing.find({ type: 'Text', text: 'demo (not loaded)' })).toBeDefined()
  await missing.press({ key: 'dock-main-manage' })
  await missing.unmount()
  const band = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'AbovePrompt', props: bandProps(80) })
  expect(await band.find({ key: 'dock-tab-demo' })).toBeUndefined()
  await band.unmount()

  // Back: the same place, still minimized.
  demo = 'on'
  await $.session.start(start)
  expect(await placement()).toEqual(placed)

  // Missing again, Remove forgets it: back once more, it joins as a new panel would, last and open.
  demo = 'off'
  await $.session.start(start)
  const manage = await $.ui.mount({ plugin: 'claudedockula', surface: 'terminal', component: 'Pane', requestId: 'claudedockula', props: paneProps(56) })
  await manage.press({ key: 'dock-main-manage' })
  await manage.press({ key: 'dock-main-drop-demo' })
  expect(await manage.find({ type: 'Text', text: 'demo (not loaded)' })).toBeUndefined()
  await manage.press({ key: 'dock-main-manage' })
  await manage.unmount()
  demo = 'on'
  await $.session.start(start)
  expect((await placement()).at(-1)).toBe('dock-main-toggle-demo ▾ 🧪 Demo')
})

describe('what packs answer is read as untrusted data', () => {
  test('panels: a usable id once, never a built-in\'s; fallbacks for title and icon', () => {
    const raw = [{ id: 'deploys', title: ' ' }, { id: 'jira', title: 'Mine' }, { id: 'Bad Id' }, { id: 'deploys' }, 7, { id: 'add' }]
    const read = readPackPanels(raw, ['jira'])
    expect(read.panels).toEqual([{ id: 'deploys', title: 'deploys', icon: '🧩', description: '' }])
    expect(read.dropped).toEqual([
      '"jira": a built-in panel has that id',
      '"Bad Id": an id is lowercase letters, digits and -',
      '"deploys": listed twice',
      'an entry with no id: an id is lowercase letters, digits and -',
      '"add": an id is lowercase letters, digits and -',
    ])
    expect(readPackPanels('nope', []).panels).toEqual([])
  })

  test('rows: arrays of spans with string text, known fields only, cut with a note past the bounds', () => {
    const raw = [[{ text: 'a', key: 'k', weight: 'semibold', onPress: 1, drag: 'yes' }, { text: 2 }], 'x', []]
    expect(readPackLines(raw)).toEqual([[{ text: 'a', key: 'k', weight: 'semibold' }], []])
    expect(readPackLines({ rows: [] })).toBeNull()
    const many = Array.from({ length: 5 }, (_, index) => [{ text: `row ${index}` }])
    expect(readPackLines(many, 3)).toEqual([...many.slice(0, 3), [{ text: '…cut', dim: true }]])
    expect(readPackLines([[{ text: 'x'.repeat(50) }]], 200, 40)).toEqual([[{ text: '…cut', dim: true }]])
  })

  test('summary and canvas events keep only what the dock draws or sends on', () => {
    expect(readPackSummary(undefined)).toBe('–')
    expect(readPackSummary('  3\n done ')).toBe('3 done')
    expect(readCanvasEvent({ type: 'drop', from: 'a', key: 'b', x: 1, y: 2, button: 'left', extra: true })).toEqual({
      type: 'drop',
      from: 'a',
      key: 'b',
      x: 1,
      y: 2,
      button: 'left',
    })
    expect(readCanvasEvent({ type: 'pointer', x: 1, y: 2 })).toBeUndefined()
  })
})
