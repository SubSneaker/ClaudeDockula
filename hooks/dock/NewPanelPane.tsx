import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderInput } from 'claude-code'

import type { AddPanelDraft, NoticeTone } from '../../types'
import { COMPANION_FILES, COMPANION_MANIFEST, companionRoot, templatePath } from './companion'
import { NEW_PANEL_PANE, messageOf } from './layout'
import { NO_NOTICES, pushNotice } from './notices'
import {
  EMPTY_DRAFT,
  EMPTY_FORM,
  NO_CONNECTOR,
  REFRESH_OPTIONS,
  buildNewPanelPrompt,
  connectorOptions,
  isDockRefresh,
} from './prompts'
import { drawCard, drawNote } from './ui'

// Every function that touches `$` lives in this file: the engine follows `$` no further.

const INTRO =
  'Describe the panel, then press Send to Claude. It is built in your own panels plugin ' +
  '(skills/dockula-panels in your Claude folder, set up the first time), which updates of ClaudeDockula ' +
  'never touch. A prompt asking Claude to build it goes in your prompt box: review it and press Enter.'
const READY_NOTICE = 'Prompt ready — review and press Enter'

const draftAtom = atom({ plugin: 'claudedockula', key: 'addDraft' } as const, EMPTY_DRAFT)
const formAtom = atom({ plugin: 'claudedockula', key: 'addForm' } as const, EMPTY_FORM)
const noticesAtom = atom({ plugin: 'claudedockula', key: 'notices' } as const, NO_NOTICES)

type TextField = 'name' | 'icon' | 'shows' | 'actions' | 'notes'

interface TextFieldSpec {
  field: TextField
  label: string
  /** Dim, after the label: `required`, `one emoji`. */
  hint: string
  placeholder: string
  next: string
}

/** Element keys of the form, prefixed so no panel's `ui.press` matcher can catch them. */
function formKey(field: string): string {
  return `dock-new-${field}`
}

const LEADING_FIELDS: readonly TextFieldSpec[] = [
  { field: 'name', label: 'Name', hint: 'required', placeholder: 'Deploys', next: formKey('icon') },
  { field: 'icon', label: 'Icon', hint: 'one emoji', placeholder: '🚀', next: formKey('shows') },
  {
    field: 'shows',
    label: 'What it shows',
    hint: 'required',
    placeholder: 'the last 5 deploys and their status',
    next: formKey('actions'),
  },
  { field: 'actions', label: 'Buttons', hint: 'optional', placeholder: 'Open in browser, Re-run', next: formKey('connector') },
]

const NOTES_FIELD: TextFieldSpec = {
  field: 'notes',
  label: 'Notes',
  hint: 'optional',
  placeholder: 'anything else Claude should know',
  next: formKey('send'),
}

function patchFor(field: TextField, value: string): AddPanelDraft {
  return { [field]: value }
}

function missingField(draft: AddPanelDraft): TextField | undefined {
  if (!draft.name?.trim()) {
    return 'name'
  }
  if (!draft.shows?.trim()) {
    return 'shows'
  }

  return undefined
}

interface Companion {
  root: string
  /** Set up just now: Claude Code has not loaded it yet. */
  isNew: boolean
}

async function notify($: EngineInterface, tone: NoticeTone, title: string, detail?: string): Promise<void> {
  const at = await $.clock.now()
  await update($, noticesAtom, list => pushNotice(list, { tone, title, at, ...(detail ? { detail } : {}) }))
}

/**
 * The person's own panels plugin, set up from the template the first time: every file it lacks is written,
 * none is overwritten. Undefined, after a notice saying where and why, when it cannot be.
 */
async function ensureCompanion($: EngineInterface): Promise<Companion | undefined> {
  const root = companionRoot(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'))
  if (root === undefined) {
    await notify($, 'error', "Couldn't set up your panels plugin", 'Neither CLAUDE_CONFIG_DIR nor HOME is set.')

    return undefined
  }
  if (await $.fs.exists(`${root}/${COMPANION_MANIFEST}`).catch(() => false)) return { root, isNew: false }
  for (const file of COMPANION_FILES) {
    const path = `${root}/${file}`
    try {
      if (await $.fs.exists(path)) continue
      await $.fs.write(path, await $.fs.read(templatePath($.plugin.root, file)))
    } catch (error) {
      await notify($, 'error', "Couldn't set up your panels plugin", `${path}: ${messageOf(error)}`)

      return undefined
    }
  }

  return { root, isNew: true }
}

async function saveDraft($: EngineInterface, patch: AddPanelDraft): Promise<void> {
  await update($, draftAtom, draft => ({ ...draft, ...patch }))
}

/** Moves the form's focus ring on; refused when the pane does not hold the keys, which is fine. */
async function focusField($: EngineInterface, key: string): Promise<void> {
  await $.ui.focus({ requestId: NEW_PANEL_PANE, key }).catch(() => undefined)
}

/** Closes the form; the dock's `ui.close` hook gives an open right dock its width back, which the form's open had set. */
async function closeForm($: EngineInterface): Promise<void> {
  await $.ui.close({ id: NEW_PANEL_PANE })
}

/** "Send to Claude": closes the form, then fills the prompt box; the draft is kept until the box took it. */
async function sendDraft($: EngineInterface): Promise<void> {
  const draft = await read($, draftAtom)
  const missing = missingField(draft)
  if (missing !== undefined) {
    await notify($, 'info', 'Give the panel a name and say what it should show.')
    await focusField($, formKey(missing))

    return
  }
  const companion = await ensureCompanion($)
  if (companion === undefined) return
  const paths = { guidePath: `${$.plugin.root}/PANEL_GUIDE.md`, companionRoot: companion.root, isNew: companion.isNew }
  const text = buildNewPanelPrompt(draft, paths)
  await closeForm($)
  const filled = await $.prompt.fill({ text })
  if (!filled.isFilled) {
    await notify($, 'error', 'The prompt box did not take the prompt. Your answers are kept: /dock add')

    return
  }
  await update($, draftAtom, () => EMPTY_DRAFT)
  await notify($, 'success', READY_NOTICE)
}

async function cancelDraft($: EngineInterface): Promise<void> {
  await update($, draftAtom, () => EMPTY_DRAFT)
  await closeForm($)
}

/**
 * The "New panel" pane: an intro card, then the form whose answers become Claude's prompt. It draws
 * from the seed its opener wrote (hooks/dock/DockPane.tsx), so typing never redraws it and a field
 * keeps what was typed.
 */
async function renderNewPanel($: EngineInterface, e: RenderInput<'Pane'>): Promise<JSX.Element> {
  if (e.surface === 'mobile') {
    const { Text } = $.ui.resolve(e)

    return <Text>Open /dock add in a terminal or the desktop app to describe a panel.</Text>
  }
  const ui = $.ui.resolve(e)
  const { Box, Button, Input, Select, Text } = ui
  const { seed, servers } = await read($, formAtom)
  const connectors = connectorOptions(servers)
  const isConnectorListed = connectors.some(option => option.value === seed.connector)
  const connector = isConnectorListed && seed.connector ? seed.connector : NO_CONNECTOR

  const drawLabel = (label: string, hint: string) => (
    <Text bold>
      {label}
      <Text dimColor>{`  ${hint}`}</Text>
    </Text>
  )

  const drawTextField = (spec: TextFieldSpec, isFirst: boolean) => (
    <Box flexDirection="column">
      {drawLabel(spec.label, spec.hint)}
      <Input
        key={formKey(spec.field)}
        placeholder={spec.placeholder}
        value={seed[spec.field] ?? ''}
        {...(isFirst ? { autoFocus: true } : {})}
        onInput={value => saveDraft($, patchFor(spec.field, value))}
        onSubmit={async value => {
          await saveDraft($, patchFor(spec.field, value))
          await focusField($, spec.next)
        }}
      />
    </Box>
  )

  return (
    <Box flexDirection="column" width={Math.max(1, e.props.bodyColumns)} rowGap={1}>
      {drawCard(ui, {
        key: formKey('intro'),
        cells: Math.max(1, e.props.bodyColumns),
        title: '✨ New panel',
        body: (
          <Box flexDirection="column">
            <Text wrap="wrap">{INTRO}</Text>
            {drawNote(ui, 'Enter moves to the next field.')}
          </Box>
        ),
      })}
      {LEADING_FIELDS.map((spec, index) => drawTextField(spec, index === 0))}
      <Box flexDirection="column">
        {drawLabel('Data source', 'where the panel reads from')}
        <Select
          key={formKey('connector')}
          options={connectors}
          value={connector}
          onSelect={value => saveDraft($, { connector: value })}
        />
      </Box>
      <Box flexDirection="column">
        {drawLabel('Refresh', 'how often it reloads')}
        <Select
          key={formKey('refresh')}
          options={REFRESH_OPTIONS}
          value={seed.refresh ?? 'manual'}
          onSelect={value => (isDockRefresh(value) ? saveDraft($, { refresh: value }) : undefined)}
        />
      </Box>
      {drawTextField(NOTES_FIELD, false)}
      <Box flexDirection="row" columnGap={2} marginTop={1}>
        <Button key={formKey('send')} variant="primary" label="Send to Claude" onPress={() => sendDraft($)} />
        <Button key={formKey('cancel')} label="Cancel" onPress={() => cancelDraft($)} />
      </Box>
    </Box>
  )
}

export function registerNewPanelHooks(on: On): void {
  on('ui.render', { component: 'Pane', requestId: 'claudedockula-new' }, ($, e) => renderNewPanel($, e))
}
