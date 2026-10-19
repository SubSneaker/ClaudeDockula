import type { DockPanel } from '../panels/contract'
import type { NewNotice } from './notices'

/** What the person was last told about the built-in panels: each id with the revision they have heard of. */
export type SeenPanels = Record<string, number>

export type PanelNotice = Omit<NewNotice, 'at'>

export interface PanelNews {
  notices: PanelNotice[]
  /** What to store as seen once the notices are posted. */
  record: SeenPanels
}

export const SEEN_STORE_KEY = 'panels:seen'

export function revisionOf(panel: Pick<DockPanel, 'revision'>): number {
  return panel.revision ?? 1
}

/** The stored record when it is a map of ids to whole revisions, else undefined (a missing or damaged one counts as none). */
export function readSeen(raw: unknown): SeenPanels | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const entries = Object.entries(raw).filter(([, value]) => typeof value === 'number' && Number.isInteger(value) && value > 0)

  return Object.fromEntries(entries)
}

/** The record with renamed panels under their new ids, keeping the newest revision heard; undefined stays undefined. */
export function renameSeen(seen: SeenPanels | undefined, renames: readonly (readonly [string, string])[]): SeenPanels | undefined {
  if (seen === undefined) return undefined

  return renames.reduce((current, [from, to]) => {
    const { [from]: old, ...rest } = current

    return old === undefined ? current : { ...rest, [to]: Math.max(old, rest[to] ?? 0) }
  }, seen)
}

function noticeOf(panel: DockPanel, isNew: boolean): PanelNotice {
  return { ...announce(panel, isNew), stays: true }
}

function announce(panel: DockPanel, isNew: boolean): PanelNotice {
  const name = `${panel.icon} ${panel.title}`
  const topic = `panel-news-${panel.id}`
  if (!isNew) return { tone: 'info', title: `Updated: ${name}`, topic, ...(panel.whatsNew ? { detail: panel.whatsNew } : {}) }
  if (panel.isOptIn) return { tone: 'info', title: `New panel: ${name}`, topic, detail: `Add it from ⚙ Manage (/dock manage).\n${panel.description}` }

  return { tone: 'info', title: `New panel: ${name}`, topic, detail: `Added to your dock.\n${panel.description}` }
}

/**
 * The notices for the built-in panels the person has not heard about, and the record to keep afterwards.
 * Without a record, panels the layout already knows count as heard and only opt-in ones it lacks are announced.
 * @example
 * // before: seen { jira: 1 }, panels [jira (rev 2, whatsNew 'Moves tickets'), slacker (opt-in)]
 * // after:  notices ['Updated: 🎫 Jira', 'New panel: 💬 Slacker'], record { jira: 2, slacker: 1 }
 */
export function panelNews(seen: SeenPanels | undefined, panels: readonly DockPanel[], knownIds: readonly string[]): PanelNews {
  const record: SeenPanels = Object.fromEntries(panels.map(panel => [panel.id, revisionOf(panel)]))
  const notices = panels.flatMap((panel): PanelNotice[] => {
    if (seen === undefined) return panel.isOptIn && !knownIds.includes(panel.id) ? [noticeOf(panel, true)] : []
    const heard = seen[panel.id]
    if (heard === undefined) return [noticeOf(panel, true)]

    return revisionOf(panel) > heard ? [noticeOf(panel, false)] : []
  })

  return { notices, record }
}
