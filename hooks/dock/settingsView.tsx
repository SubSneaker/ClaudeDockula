import { drawActions, drawHeading, type DockElements } from './ui'

// A panel's ⚙ view, pure: label column, choices, toggles, heading and footer. Each panel owns its keys and its Done.

/** Cells the label column takes, so every row's value starts in the same column. */
export const SETTINGS_LABEL_CELLS = 17

/** `● 90 s`, `○ 5 min`. */
export function radioLabel(isPicked: boolean, text: string): string {
  return `${isPicked ? '●' : '○'} ${text}`
}

/** `☑ Untracked`, `☐ Untracked`. */
export function checkLabel(isOn: boolean, text: string): string {
  return `${isOn ? '☑' : '☐'} ${text}`
}

/** A plain Button showing a choice: bold and underlined while on, dim while off (the dock's own tab look). */
export function choiceButton(ui: DockElements, key: string, label: string, isOn: boolean): JSX.Element {
  const { Button, Text } = ui

  return (
    <Button key={key} plain onPress={() => undefined}>
      <Text bold={isOn} underline={isOn} dimColor={!isOn}>
        {label}
      </Text>
    </Button>
  )
}

/** One settings row: the label dim in its column, then what it holds. */
export function drawSettingRow(ui: DockElements, label: string, value: JSX.Element): JSX.Element {
  const { Box, Text } = ui

  return (
    <Box flexDirection="row">
      <Box width={SETTINGS_LABEL_CELLS} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexDirection="row" columnGap={2} flexShrink={1}>
        {value}
      </Box>
    </Box>
  )
}

/** One choice of a setting; `key` is the Button's key, owned by the calling panel. */
export interface SettingChoice {
  key: string
  label: string
  isOn: boolean
}

/** A setting's choices side by side as `●`/`○` radios: `● 1 min  ○ 5 min`. */
export function drawChoiceRow(ui: DockElements, choices: readonly SettingChoice[]): JSX.Element {
  const { Box } = ui

  return (
    <Box flexDirection="row" columnGap={2}>
      {choices.map(choice => choiceButton(ui, choice.key, radioLabel(choice.isOn, choice.label), choice.isOn))}
    </Box>
  )
}

/** A setting's choices, one per line: `● Notice only`, `○ Notice + terminal bell`. */
export function drawChoiceColumn(ui: DockElements, choices: readonly SettingChoice[]): JSX.Element {
  const { Box } = ui

  return <Box flexDirection="column">{choices.map(choice => choiceButton(ui, choice.key, radioLabel(choice.isOn, choice.label), choice.isOn))}</Box>
}

/** An on/off setting as one `☑`/`☐` Button. */
export function drawToggle(ui: DockElements, key: string, label: string, isOn: boolean): JSX.Element {
  return choiceButton(ui, key, checkLabel(isOn, label), isOn)
}

export interface SettingsViewProps {
  title: string
  detail?: string
  /** `drawSettingRow` results (or any rows). */
  rows: JSX.Element[]
  /** The footer Buttons: Done, or Save and Cancel. */
  footer: JSX.Element[]
  columns: number
}

/** The heading, a blank row, the rows, then the footer. */
export function drawSettingsView(ui: DockElements, view: SettingsViewProps): JSX.Element {
  const { Box } = ui

  return (
    <Box flexDirection="column" width={view.columns}>
      {drawHeading(ui, view.title, view.detail)}
      <Box flexDirection="column" marginTop={1}>
        {view.rows}
      </Box>
      {drawActions(ui, view.footer)}
    </Box>
  )
}
