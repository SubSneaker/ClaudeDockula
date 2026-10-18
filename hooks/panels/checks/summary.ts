export interface CheckOutput {
  exitCode: number
  stdout: string
  stderr: string
}

export interface CheckSummary {
  isPassed: boolean
  /** What failed, as a count when the output gives one ("197 errors"), else the exit code. */
  problem?: string
  /** The first meaningful lines of a failed run, the ones naming a file first. */
  lines: string[]
}

const MAX_LINES = 6
const MAX_LINE_LENGTH = 160
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
/** What pnpm, npm, yarn and bun print around a script: their own banners, warnings and exit lines. */
const NOISE_RE =
  /^(?:\[WARN\]|\s?WARN\s|\[ELIFECYCLE\]|\s?ELIFECYCLE\s|npm (?:ERR!|WARN|notice)|error Command failed|info Visit https:\/\/yarnpkg|yarn run v|bun run v|error: script |\$ |> |Checking formatting)/
const FILE_RE = /[\w@[\]().\/-]+\.(?:[cm]?[jt]sx?|json|css|scss|mdx?|ya?ml)(?=$|[\s:(,)])/
const FILE_TOKEN_RE = new RegExp(FILE_RE.source, 'g')
const ESLINT_ROW_RE = /^\s+(\d+):(\d+)\s+(?:error|warning)\s+(.*)$/
const ERROR_WORD_RE = /error|fail|✖|×|✗|exception|cannot|not found/i

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** `42s`, `1m 05s`; `<1s` under a second. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`

  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/**
 * Turns a check's raw output into what the panel shows: passed or not, a short problem, and the
 * first lines worth reading, files first, paths made short.
 * @example
 * // before: { exitCode: 2, stdout: "src/a.ts(3,1): error TS2322: Type 'x'…\n  Types of property…\n", stderr: '' }
 * // after:  { isPassed: false, problem: '1 error', lines: ["src/a.ts(3,1): error TS2322: Type 'x'…"] }
 */
export function summarizeCheckOutput(output: CheckOutput, cwd?: string): CheckSummary {
  if (output.exitCode === 0) return { isPassed: true, lines: [] }

  const text = stripAnsi(`${output.stdout}\n${output.stderr}`)
  const rows = joinEslintRows(readableLines(text)).map(line => compactLine(line, cwd))
  const problem = countProblem(text) ?? `exit code ${output.exitCode}`

  return { isPassed: false, problem, lines: pickMeaningfulLines(rows) }
}

function readableLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '' && !NOISE_RE.test(line))
}

/**
 * ESLint's default output names the file once, then indents its problems; this puts the file on each.
 * @example
 * // before: ['/repo/src/a.ts', '  3:1  error  Unexpected any  no-explicit-any']
 * // after:  ['/repo/src/a.ts:3:1 Unexpected any  no-explicit-any']
 */
function joinEslintRows(lines: string[]): string[] {
  const joined: string[] = []
  let file: string | undefined
  let hasRows = false
  for (const line of lines) {
    const row = file === undefined ? null : ESLINT_ROW_RE.exec(line)
    if (row) {
      joined.push(`${file}:${row[1]}:${row[2]} ${row[3]?.trim() ?? ''}`)
      hasRows = true
      continue
    }
    if (file !== undefined && !hasRows) joined.push(file)
    file = isBarePath(line) ? line.trim() : undefined
    hasRows = false
    if (file === undefined) joined.push(line)
  }
  if (file !== undefined && !hasRows) joined.push(file)

  return joined
}

function isBarePath(line: string): boolean {
  const match = FILE_RE.exec(line.trim())

  return match !== null && match[0] === line.trim()
}

function compactLine(line: string, cwd?: string): string {
  const relative = cwd ? line.split(`${cwd.replace(/\/$/, '')}/`).join('') : line
  const compact = relative
    .trim()
    .replace(/^\[(?:warn|error)\]\s+/, '')
    .replace(FILE_TOKEN_RE, compactPath)

  return compact.length > MAX_LINE_LENGTH ? `${compact.slice(0, MAX_LINE_LENGTH - 1)}…` : compact
}

/** `src/app/[lang]/assets/_components/Item.tsx` → `…/_components/Item.tsx` */
function compactPath(path: string): string {
  const segments = path.split('/').filter(segment => segment !== '')
  if (segments.length <= 3) return path

  return `…/${segments.slice(-2).join('/')}`
}

function pickMeaningfulLines(lines: string[]): string[] {
  const naming = lines.filter(line => FILE_RE.test(line))
  if (naming.length > 0) return naming.slice(0, MAX_LINES)
  const erroring = lines.filter(line => ERROR_WORD_RE.test(line))
  if (erroring.length > 0) return erroring.slice(0, MAX_LINES)

  return lines.slice(-MAX_LINES)
}

/** The count the tool itself reports (eslint, tsc, vitest, prettier), when it reports one. */
function countProblem(text: string): string | undefined {
  const eslint = /✖ \d+ problems? \((\d+) errors?/.exec(text)
  if (eslint?.[1]) return plural(Number(eslint[1]), 'error')
  const tscErrors = text.match(/error TS\d+/g)
  if (tscErrors) return plural(tscErrors.length, 'error')
  const tests = /Tests\s+(\d+) failed/.exec(text)
  if (tests?.[1]) return `${plural(Number(tests[1]), 'test')} failed`
  const testFiles = /Test Files\s+(\d+) failed/.exec(text)
  if (testFiles?.[1]) return `${plural(Number(testFiles[1]), 'test file')} failed`
  const unformatted = /issues found in (\d+) files/.exec(text)
  if (unformatted?.[1]) return `${plural(Number(unformatted[1]), 'file')} to format`
  if (/issues found in the above file/.test(text)) return '1 file to format'

  return undefined
}
