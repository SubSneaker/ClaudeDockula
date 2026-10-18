const MCP_PREFIX = 'mcp__'
const MAX_SUMMARY_LENGTH = 160

/** The arguments worth showing, in the order they are looked for. */
const SUMMARY_KEYS = [
  'description',
  'file_path',
  'notebook_path',
  'pattern',
  'path',
  'query',
  'url',
  'skill',
  'command'
]
const PATH_KEYS = new Set(['file_path', 'notebook_path', 'path'])

export interface CallDescription {
  /** The tool's name, or the MCP server's for an MCP tool. */
  name: string
  summary: string
}

export interface McpToolParts {
  server: string
  tool: string
}

/**
 * Names a tool call and sums up its arguments in one line.
 * @example
 * describeToolCall('Bash', { command: 'pnpm lint', description: 'Run the linter' }, '/repo')
 * // { name: 'Bash', summary: 'Run the linter' }
 * describeToolCall('Read', { file_path: '/repo/src/a.ts' }, '/repo')
 * // { name: 'Read', summary: 'src/a.ts' }
 * describeToolCall('mcp__github__get_me', {}, '/repo')
 * // { name: 'github', summary: 'get_me' }
 */
export function describeToolCall(tool: string, args: object, cwd: string): CallDescription {
  const mcp = splitMcpToolName(tool)
  if (mcp !== undefined) return { name: mcp.server, summary: mcp.tool }

  for (const key of SUMMARY_KEYS) {
    const value = stringArg(args, key)
    if (value === undefined) continue

    return { name: tool, summary: oneLine(PATH_KEYS.has(key) ? relativePath(value, cwd) : value) }
  }

  return { name: tool, summary: '' }
}

/**
 * Splits an MCP tool's name at its last `__`, since server names may hold `_`.
 * @example
 * splitMcpToolName('mcp__plugin_x_chrome__click') // { server: 'plugin_x_chrome', tool: 'click' }
 */
export function splitMcpToolName(tool: string): McpToolParts | undefined {
  if (!tool.startsWith(MCP_PREFIX)) return undefined

  const rest = tool.slice(MCP_PREFIX.length)
  const cut = rest.lastIndexOf('__')
  if (cut <= 0) return undefined

  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) }
}

/** `path` relative to `cwd` when it lies inside it, else unchanged. */
export function relativePath(path: string, cwd: string): string {
  if (cwd === '') return path
  if (path === cwd) return '.'

  const base = cwd.endsWith('/') ? cwd : `${cwd}/`

  return path.startsWith(base) ? path.slice(base.length) : path
}

/** The first line with its whitespace collapsed, cut to MAX_SUMMARY_LENGTH; `…` marks a cut. */
function oneLine(text: string): string {
  const lines = text.trim().split('\n')
  const first = (lines[0] ?? '').replace(/\s+/g, ' ').trim()
  const isCut = lines.length > 1 || first.length > MAX_SUMMARY_LENGTH

  return isCut ? `${first.slice(0, MAX_SUMMARY_LENGTH - 2)} …` : first
}

function stringArg(args: object, key: string): string | undefined {
  const value: unknown = Reflect.get(args, key)

  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
