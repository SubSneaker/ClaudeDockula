import type { BranchFile, BranchStatus } from '../../../types'
import { findTicketKey } from '../../settings'

const AHEAD_BEHIND = /^\+(\d+) -(\d+)$/
const QUOTED_PART = /((?:\\[0-7]{3})+)|\\(.)/g
const ESCAPED_CHARS: Record<string, string> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v'
}

/** One line for a failed `git status`, from what it wrote to stderr. */
export function describeGitFailure(stderr: string): string {
  if (/not a git repository/i.test(stderr)) return 'Not a git repository.'
  const firstLine = stderr.trim().split('\n')[0]

  return firstLine ? `git status failed: ${firstLine}` : 'git status failed.'
}

/**
 * Reads `git status --porcelain=v2 --branch` output into the branch panel's status; the ticket key is the
 * match of `ticketPattern`, else the default pattern.
 * @example
 * // before:
 * // # branch.oid a1b2c3d4e5f...
 * // # branch.head ABC-101/add-export-button
 * // # branch.upstream origin/ABC-101/add-export-button
 * // # branch.ab +2 -0
 * // 1 MM N... 100644 100644 100644 a1b2c3d e4f5a6b src/a.ts
 * // ? notes.md
 * // after:
 * // { branch: 'ABC-101/add-export-button', commit: 'a1b2c3d', ticket: 'ABC-101',
 * //   upstream: 'origin/ABC-101/add-export-button', ahead: 2, behind: 0,
 * //   staged: 1, modified: 1, untracked: 1, conflicted: 0, fileCount: 2,
 * //   files: [{ code: 'MM', path: 'src/a.ts' }, { code: '??', path: 'notes.md' }] }
 */
export function parseGitStatus(stdout: string, ticketPattern?: string): BranchStatus {
  const status: BranchStatus = {
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicted: 0,
    files: [],
    fileCount: 0
  }

  for (const line of stdout.split('\n')) {
    if (line.startsWith('# ')) readHeaderLine(status, line.slice(2), ticketPattern)
    else readEntryLine(status, line)
  }
  status.fileCount = status.files.length

  return status
}

function readHeaderLine(status: BranchStatus, header: string, ticketPattern?: string): void {
  const space = header.indexOf(' ')
  const name = header.slice(0, space)
  const value = header.slice(space + 1)

  if (name === 'branch.oid' && value !== '(initial)') status.commit = value.slice(0, 7)
  if (name === 'branch.head' && value !== '(detached)') {
    status.branch = value
    status.ticket = findTicketKey(value, ticketPattern)
  }
  if (name === 'branch.upstream') status.upstream = value
  if (name === 'branch.ab') {
    const match = AHEAD_BEHIND.exec(value)
    status.ahead = Number(match?.[1] ?? 0)
    status.behind = Number(match?.[2] ?? 0)
  }
}

/** Fields before the path: `1` ordinary, `2` renamed or copied, `u` unmerged. */
const FIELDS_BEFORE_PATH: Record<string, number> = { '1': 8, '2': 9, u: 10 }

function readEntryLine(status: BranchStatus, line: string): void {
  const fields = line.split(' ')
  const kind = fields[0] ?? ''

  if (kind === '?') {
    status.untracked += 1
    status.files.push({ code: '??', path: unquoteGitPath(line.slice(2)) })
    return
  }

  const pathAt = FIELDS_BEFORE_PATH[kind]
  if (pathAt === undefined) return

  const xy = fields[1] ?? '..'
  // A rename's path is followed by a tab and the path it came from.
  const path = fields.slice(pathAt).join(' ').split('\t')[0] ?? ''
  const file: BranchFile = { code: xy.replaceAll('.', ' '), path: unquoteGitPath(path) }

  if (kind === 'u') status.conflicted += 1
  else {
    if (xy[0] !== '.') status.staged += 1
    if (xy[1] !== '.') status.modified += 1
  }
  status.files.push(file)
}

/**
 * Undoes git's C-style quoting of a path holding unusual characters; other paths pass through.
 * @example
 * // before: "\"docs/\\346\\227\\245 \\\"a\\\".md\""
 * // after:  'docs/日 "a".md'
 */
export function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path

  return path
    .slice(1, -1)
    .replace(QUOTED_PART, (_match: string, octalRun?: string, escaped?: string) =>
      octalRun !== undefined ? decodeOctalBytes(octalRun) : (ESCAPED_CHARS[escaped ?? ''] ?? escaped ?? '')
    )
}

/** `\346\227\245` → `日`: a run of octal-escaped bytes decoded as UTF-8. */
function decodeOctalBytes(run: string): string {
  const bytes = run
    .split('\\')
    .slice(1)
    .map((octal) => parseInt(octal, 8))

  return new TextDecoder().decode(new Uint8Array(bytes))
}
