// Pure helpers for the person's own panels plugin (`dockula-panels`), which ➕ New panel sets up from
// template/companion/ the first time; they take no `$`.

export const COMPANION_NAME = 'dockula-panels'
export const TEMPLATE_DIR = 'template/companion'
const TEMPLATE_SUFFIX = '.tmpl'

/** Every file the template holds, by its path in the companion; each is read from `<path>.tmpl`. */
export const COMPANION_FILES: readonly string[] = [
  'hooks/hooks.json',
  'hooks/register.tsx',
  'hooks/panels/index.ts',
  'hooks/kit/spans.ts',
  'types/index.d.ts',
  'tsconfig.json',
  'tests/panels.test.ts',
  // Last: a folder with a manifest counts as set up, so it is written once everything else is.
  '.claude-plugin/plugin.json',
]

export const COMPANION_MANIFEST = '.claude-plugin/plugin.json'

/**
 * The companion's folder: the Claude config folder's `skills/dockula-panels`, where the engine loads a plugin
 * every session and reloads it on save.
 * @example
 * // ('/Users/example/.claude/', undefined) → '/Users/example/.claude/skills/dockula-panels'
 * // (undefined, '/Users/example')          → '/Users/example/.claude/skills/dockula-panels'
 */
export function companionRoot(configDir: string | undefined, home: string | undefined): string | undefined {
  const base = configDir?.trim() ? configDir.trim() : home?.trim() ? `${home.trim().replace(/\/+$/, '')}/.claude` : undefined

  return base === undefined ? undefined : `${base.replace(/\/+$/, '')}/skills/${COMPANION_NAME}`
}

export function templatePath(pluginRoot: string, file: string): string {
  return `${pluginRoot}/${TEMPLATE_DIR}/${file}${TEMPLATE_SUFFIX}`
}
