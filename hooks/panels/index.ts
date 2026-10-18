import type { On } from 'claude-code'

import { activityPanel, registerActivityHooks } from './activity'
import { branchPanel, registerBranchHooks } from './branch'
import { checksPanel, registerChecksHooks } from './checks'
import { type DockPanel } from './contract'
import { githubPanel, registerGithubHooks } from './github'
import { registerGithubOverlapHooks } from './githubOverlap'
import { registerGithubWorkHooks } from './githubWork'
import { jiraPanel, registerJiraHooks } from './jira'
import { registerSlackerHooks, slackerPanel } from './slacker'

/** The built-in panels; the person's own come from their panels plugin through `$.dockula.panels`. */
export const PANELS: DockPanel[] = [branchPanel, checksPanel, activityPanel, jiraPanel, slackerPanel, githubPanel]

/**
 * Each panel's own hooks, called by name: the engine only accepts `on` handed to a named
 * function of the mod, never through a property such as `panel.register`.
 */
export function registerPanelHooks(on: On): void {
  registerBranchHooks(on)
  registerChecksHooks(on)
  registerActivityHooks(on)
  registerJiraHooks(on)
  registerSlackerHooks(on)
  registerGithubHooks(on)
  registerGithubWorkHooks(on)
  registerGithubOverlapHooks(on)
}
