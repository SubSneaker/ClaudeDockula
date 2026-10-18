import type { Register } from 'claude-code'

import { registerDockHooks } from './dock/DockPane'
import { registerNewPanelHooks } from './dock/NewPanelPane'
import { registerUserPanelHooks } from './dock/user'
import { registerPanelHooks } from './panels'

export const register: Register = on => {
  registerUserPanelHooks(on)
  registerPanelHooks(on)
  registerDockHooks(on)
  registerNewPanelHooks(on)
}
