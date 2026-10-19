import { stripAnsi, summarizeCheckOutput } from '../checks/summary'
import { drawable } from './parse'

const MAX_LINE = 200
const CONTEXT_LINES = 8
const ROW_PREFIX_RE = /^[^\t\n]*\t[^\t\n]*\t/
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/
const ERROR_MARK = '##[error]'
const PREAMBLE_RE = /^(?:Current runner version:|Operating System\b|Runner Image\b|Secret source:|Prepare workflow directory|Prepare all required actions)/

/**
 * Strips `job\tstep\t`, a BOM, the timestamp, ANSI codes and every other escape or control character (`tput`'s
 * `ESC ( B` among them), and drops groups, command echoes and the runner preamble.
 * @example
 * // before: ['build\tRun tsc\t\uFEFF2026-10-15T07:18:06.3Z \u001b[31mfoo.ts(1,1): error TS1\u001b[0m', 'build\tRun tsc\t2026-10-15T07:18:06.3Z ##[group]Run x']
 * // after:  ['foo.ts(1,1): error TS1']
 */
export function cleanLogLines(raw: string): string[] {
  const lines: string[] = []
  let isInGroup = false
  for (const row of raw.split(/\r?\n/)) {
    const line = drawable(
      stripAnsi(row)
        .replace(ROW_PREFIX_RE, '')
        .replace(/\uFEFF/g, '')
        .replace(TIMESTAMP_RE, '')
    ).trimEnd()
    if (line.startsWith('##[group]')) {
      isInGroup = true
      continue
    }
    if (line.startsWith('##[endgroup]')) {
      isInGroup = false
      continue
    }
    if (isInGroup || line.trim() === '' || line.startsWith('[command]') || PREAMBLE_RE.test(line)) continue
    lines.push(line)
  }

  return lines
}

function cut(line: string): string {
  const text = line.trim()

  return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text
}

/**
 * The context of every `##[error]`: up to 8 lines before it, then its message.
 * @example
 * // before: ['a', 'b', '##[error]Process completed with exit code 2.']
 * // after:  ['a', 'b', 'Process completed with exit code 2.']
 */
function errorContext(lines: string[]): string[] {
  const picked: string[] = []
  lines.forEach((line, index) => {
    if (!line.startsWith(ERROR_MARK)) return
    const before = lines.slice(Math.max(0, index - CONTEXT_LINES), index).filter(prior => !prior.startsWith(ERROR_MARK))
    picked.push(...before, line.slice(ERROR_MARK.length))
  })

  return [...new Set(picked)]
}

/**
 * The lines that say why a job failed: the checks parser's reading first, else the context of each `##[error]`.
 * @example
 * // before: 'build\tRun tsc\t2026-…Z src/a.ts(3,1): error TS2322: …\n…##[error]Process completed with exit code 2.'
 * // after:  { problem: '1 error', lines: ['src/a.ts(3,1): error TS2322: …'] }
 */
export function excerptFailedLog(raw: string, max = 12): { problem?: string; lines: string[] } {
  const lines = cleanLogLines(raw)
  const summary = summarizeCheckOutput({ exitCode: 1, stdout: lines.join('\n'), stderr: '' })
  if (summary.problem && !summary.problem.startsWith('exit code') && summary.lines.length > 0) {
    return { problem: summary.problem, lines: summary.lines.slice(0, max).map(cut) }
  }

  const context = errorContext(lines)
  const tail = context.length > 0 ? context : lines.slice(-CONTEXT_LINES)
  const picked = tail.slice(-max).map(cut)
  const problem = lines.find(line => line.startsWith(ERROR_MARK))?.slice(ERROR_MARK.length)

  return problem === undefined ? { lines: picked } : { problem: cut(problem), lines: picked }
}

const GITLAB_SECTION_RE = /section_(?:start|end):\d+:[^\r\n\u001b]*/g
const GITLAB_PREAMBLE_RE = /^(?:Running with gitlab-runner|Preparing the "|Using (?:Docker|Kubernetes|effective pull policy|docker image)|Pulling docker image|Authenticating with credentials|Preparing environment|Getting source from Git repository|Fetching changes|Initialized empty Git|Created fresh repository|Checking out |Skipping Git submodules|Resolving secrets|Running on |Cleaning up )/
const GITLAB_ERROR_RE = /^ERROR: /

/**
 * A GitLab job trace as text `excerptFailedLog` can read: ANSI, `section_start`/`section_end` markers, carriage-return
 * redraws and the runner preamble go, and `ERROR: …` lines become `##[error]` lines.
 * @example
 * // before: 'section_start:1:step_script\r\u001b[0K\u001b[32;1m$ npm test\u001b[0;m\nERROR: Job failed: exit code 1'
 * // after:  '$ npm test\n##[error]Job failed: exit code 1'
 */
export function cleanGitlabTrace(raw: string): string {
  const lines: string[] = []
  for (const row of raw.split(/\r?\n/)) {
    const segments = stripAnsi(row.replace(GITLAB_SECTION_RE, '')).split('\r')
    const last = segments.reverse().find(segment => segment.trim() !== '') ?? ''
    const line = drawable(last).trimEnd()
    if (line.trim() === '' || GITLAB_PREAMBLE_RE.test(line)) continue
    lines.push(GITLAB_ERROR_RE.test(line) ? `${ERROR_MARK}${line.slice('ERROR: '.length)}` : line)
  }

  return lines.join('\n')
}
