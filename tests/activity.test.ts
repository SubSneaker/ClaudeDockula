import { describe, expect, test } from 'claude-code/testing'

import { summarizeActivity } from '../hooks/panels/activity'
import { describeToolCall, relativePath, splitMcpToolName } from '../hooks/panels/activity/describe'

const CWD = '/repo'

describe('describeToolCall', () => {
  test('Bash shows its description, else the first line of its command', () => {
    const described = describeToolCall('Bash', { command: 'pnpm lint', description: 'Run lint' }, CWD)
    const undescribed = describeToolCall('Bash', { command: 'cat <<EOF\nhello\nEOF' }, CWD)

    expect(described).toEqual({ name: 'Bash', summary: 'Run lint' })
    expect(undescribed.summary).toBe('cat <<EOF …')
  })

  test('Read and Grep show the path or pattern, paths relative to the cwd', () => {
    const readCall = describeToolCall('Read', { file_path: '/repo/src/a.ts' }, CWD)
    const grepCall = describeToolCall('Grep', { pattern: 'useSWR', path: '/repo/src' }, CWD)

    expect(readCall.summary).toBe('src/a.ts')
    expect(grepCall.summary).toBe('useSWR')
  })

  test('an MCP tool shows its server and tool', () => {
    const call = describeToolCall('mcp__plugin_x_chrome-devtools__click', { uid: '1' }, CWD)

    expect(call).toEqual({ name: 'plugin_x_chrome-devtools', summary: 'click' })
    expect(splitMcpToolName('Bash')).toBeUndefined()
  })

  test('a long command is cut', () => {
    const call = describeToolCall('Bash', { command: 'x'.repeat(500) }, CWD)

    expect(call.summary.length).toBe(160)
    expect(call.summary.endsWith(' …')).toBe(true)
  })

  test('paths outside the cwd stay absolute', () => {
    expect(relativePath('/other/a.ts', CWD)).toBe('/other/a.ts')
    expect(relativePath('/repository/a.ts', CWD)).toBe('/repository/a.ts')
    expect(relativePath('/repo', CWD)).toBe('.')
  })
})


test('the band summary counts the tool calls, capped at the log', () => {
  const call = { id: 'a', name: 'Bash', summary: '', status: 'done' } as const

  expect(summarizeActivity({ calls: [], files: [] })).toBe('0')
  expect(summarizeActivity({ calls: [call, { ...call, id: 'b' }], files: [] })).toBe('2')
  expect(summarizeActivity({ calls: Array.from({ length: 50 }, (_, n) => ({ ...call, id: String(n) })), files: [] })).toBe('50+')
})
