// Unified-diff helpers for the overlap inspector: hunks, the base lines each one changes, where two diffs collide,
// and the PR files response. Pure: no `$`.
import type { GhDiffHunk, GhDiffSide } from '../../../types'
import { drawable } from './parse'

/** One side's diff text per drawing; two sides stay under the `Code` element's 100 000 characters. */
export const DIFF_SIDE_CAP = 40_000
/** An untracked file shown as all added is cut to this many characters, `+` prefixes and header included. */
export const UNTRACKED_CAP = 36_000
/** Room kept free for a rewritten `@@` header. */
const HEADER_ROOM = 40

export interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** The `@@` line and its body, without a trailing newline. */
  text: string
  /** The base lines the hunk changes: from its `-` lines and the base line before and after each insertion. */
  span: [number, number]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function changedSpan(oldStart: number, body: readonly string[]): [number, number] {
  let cursor = oldStart
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  const touch = (line: number) => {
    low = Math.min(low, line)
    high = Math.max(high, line)
  }
  // A `+` run right after `-` lines replaces them; a `+` run after context inserts between two base lines.
  let previous = ' '
  for (const line of body) {
    const mark = line.charAt(0)
    if (mark === '-') {
      touch(cursor)
      cursor += 1
      previous = '-'
    } else if (mark === '+') {
      if (previous !== '-') {
        touch(Math.max(1, cursor - 1))
        touch(cursor)
      }
    } else if (mark === ' ' || line === '') {
      cursor += 1
      previous = ' '
    }
  }

  return low === Number.POSITIVE_INFINITY ? [oldStart, oldStart] : [low, high]
}

/**
 * The hunks of a unified diff (a `git diff` or a GitHub `patch`): file headers, `index` and binary lines are read past.
 * @example
 * // before: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c'
 * // after:  [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, text: '@@ -1,2 +1,2 @@\n a\n-b\n+c', span: [2, 2] }]
 */
export function parseHunks(diff: string): Hunk[] {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  const hunks: Hunk[] = []
  let at = 0
  while (at < lines.length) {
    const match = HUNK_HEADER.exec(lines[at] ?? '')
    if (match === null) {
      at += 1
      continue
    }
    const header = lines[at] ?? ''
    const oldStart = Number(match[1])
    const oldCount = match[2] === undefined ? 1 : Number(match[2])
    const newStart = Number(match[3])
    const newCount = match[4] === undefined ? 1 : Number(match[4])
    const body: string[] = []
    let oldLeft = oldCount
    let newLeft = newCount
    at += 1
    while (at < lines.length && (oldLeft > 0 || newLeft > 0 || (lines[at] ?? '').startsWith('\\'))) {
      const line = lines[at] ?? ''
      const mark = line.charAt(0)
      if (mark === '-') oldLeft -= 1
      else if (mark === '+') newLeft -= 1
      else if (mark === ' ' || line === '') {
        oldLeft -= 1
        newLeft -= 1
      } else if (mark !== '\\') break
      body.push(line === '' ? ' ' : line)
      at += 1
    }
    hunks.push({ oldStart, oldCount, newStart, newCount, text: [header, ...body].join('\n'), span: changedSpan(oldStart, body) })
  }

  return hunks
}

function intersects(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1]
}

/**
 * The base-line ranges where both diffs change something, merged and sorted: each colliding pair counts as the
 * union of its two spans.
 * @example
 * // before: mine spans [[120, 130], [300, 305]], theirs spans [[125, 140], [302, 310]]
 * // after:  [[120, 140], [300, 310]]
 */
export function overlapRanges(mine: readonly Hunk[], theirs: readonly Hunk[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  for (const a of mine) {
    for (const b of theirs) {
      if (intersects(a.span, b.span)) pairs.push([Math.min(a.span[0], b.span[0]), Math.max(a.span[1], b.span[1])])
    }
  }
  pairs.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const range of pairs) {
    const last = merged.at(-1)
    if (last !== undefined && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }

  return merged
}

/** Whether each hunk of `side` changes base lines the other diff also changes. */
export function markOverlaps(side: readonly Hunk[], other: readonly Hunk[]): boolean[] {
  return side.map(hunk => other.some(one => intersects(hunk.span, one.span)))
}

/** `2 hunks overlap · base lines 120–140, 300–310`; undefined when nothing overlaps. */
export function overlapSummary(mine: readonly Hunk[], theirs: readonly Hunk[]): string | undefined {
  const ranges = overlapRanges(mine, theirs)
  if (ranges.length === 0) return undefined
  const count = markOverlaps(mine, theirs).filter(Boolean).length
  const lines = ranges.map(([low, high]) => (low === high ? String(low) : `${low}–${high}`)).join(', ')

  return `${count} ${count === 1 ? 'hunk overlaps' : 'hunks overlap'} · base ${ranges.length === 1 && ranges[0]?.[0] === ranges[0]?.[1] ? 'line' : 'lines'} ${lines}`
}

/**
 * Code text the `Code` element takes: line breaks as `\n`, tabs kept, every other control character and escape
 * sequence dropped.
 * @example
 * // before: 'a\tb\r\n\u001b[31mred'
 * // after:  'a\tb\nred'
 */
export function cleanCodeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.split('\t').map(drawable).join('\t'))
    .join('\n')
}

const TRIM_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/**
 * A hunk cut at a line break to fit `room` characters, its `@@` counts rewritten from the lines kept so it still
 * parses; undefined when not even one line fits.
 * @example
 * // before: '@@ -1,3 +1,3 @@\n a\n-b\n+c\n d' with room for two lines
 * // after:  '@@ -1,2 +1,1 @@\n a\n-b'
 */
export function trimHunk(text: string, room: number): string | undefined {
  const [head = '', ...body] = text.split('\n')
  const match = TRIM_HEADER.exec(head)
  if (match === null) return undefined
  const kept: string[] = []
  let used = HEADER_ROOM + (match[3]?.length ?? 0)
  for (const line of body) {
    if (used + line.length + 1 > room) break
    kept.push(line)
    used += line.length + 1
  }
  while (kept.at(-1)?.startsWith('\\')) kept.pop()
  const oldCount = kept.filter(line => line === '' || line.startsWith(' ') || line.startsWith('-')).length
  const newCount = kept.filter(line => line === '' || line.startsWith(' ') || line.startsWith('+')).length
  if (oldCount + newCount === 0) return undefined

  return [`@@ -${match[1]},${oldCount} +${match[2]},${newCount} @@${match[3] ?? ''}`, ...kept].join('\n')
}

/**
 * The first hunks that fit in `cap` characters; the first one that does not is trimmed at a line break when part of
 * it fits. `cut` counts the hunks left out, `isTrimmed` is set when a hunk was shortened.
 * @example
 * // before: three hunks of 30 000 characters, cap 40 000
 * // after:  { hunks: [the first, the second trimmed], cut: 1, isTrimmed: true }
 */
export function fitHunks<T extends { text: string }>(
  hunks: readonly T[],
  cap: number = DIFF_SIDE_CAP
): { hunks: T[]; cut: number; isTrimmed?: true } {
  const kept: T[] = []
  let used = 0
  let isTrimmed = false
  for (const hunk of hunks) {
    if (used + hunk.text.length + 1 > cap) {
      const text = trimHunk(hunk.text, cap - used)
      if (text !== undefined) {
        kept.push({ ...hunk, text })
        isTrimmed = true
      }
      break
    }
    kept.push(hunk)
    used += hunk.text.length + 1
  }

  return { hunks: kept, cut: hunks.length - kept.length , ...(isTrimmed ? { isTrimmed: true as const } : {}) }
}

/** One side as the inspector stores it: cleaned hunks under the cap, each flagged when it overlaps the other side. */
export function diffSide(hunks: readonly Hunk[], other: readonly Hunk[], note?: string): GhDiffSide {
  const flags = markOverlaps(hunks, other)
  const all: GhDiffHunk[] = hunks.map((hunk, index) => ({ text: cleanCodeText(hunk.text), ...(flags[index] ? { isOverlap: true } : {}) }))
  const fitted = fitHunks(all)
  const notes = [note, fitted.isTrimmed ? 'A long hunk was cut to fit.' : undefined].filter(Boolean).join(' ')

  return { hunks: fitted.hunks, ...(fitted.cut > 0 ? { cut: fitted.cut } : {}), ...(notes !== '' ? { note: notes } : {}) }
}

/**
 * Runs of hunks to draw: consecutive plain hunks share one `Code`, an overlapping one gets its own with a flag.
 * @example
 * // before: [a, b(overlap), c, d]
 * // after:  [{ text: 'a', isOverlap: false }, { text: 'b', isOverlap: true }, { text: 'c\nd', isOverlap: false }]
 */
export function diffRuns(hunks: readonly GhDiffHunk[]): Array<{ text: string; isOverlap: boolean }> {
  const runs: Array<{ text: string; isOverlap: boolean }> = []
  for (const hunk of hunks) {
    const last = runs.at(-1)
    const isOverlap = hunk.isOverlap === true
    if (last !== undefined && !last.isOverlap && !isOverlap) last.text = `${last.text}\n${hunk.text}`
    else runs.push({ text: hunk.text, isOverlap })
  }

  return runs
}

/** A side's hunks as one diff text again (for the prompt and the clipboard). */
export function sideText(side: GhDiffSide | undefined): string {
  return (side?.hunks ?? []).map(hunk => hunk.text).join('\n')
}

/**
 * An untracked file as one all-added hunk of at most `cap` characters, cut at a line break; undefined for a binary file.
 * @example
 * // before: 'a\nb\n'
 * // after:  { text: '@@ -0,0 +1,2 @@\n+a\n+b', isCut: false }
 */
export function untrackedHunk(text: string, cap: number = UNTRACKED_CAP): { text: string; isCut: boolean } | undefined {
  if (text.includes('\0')) return undefined
  if (text === '') return { text: '', isCut: false }
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const kept: string[] = []
  let used = HEADER_ROOM
  for (const line of lines) {
    if (used + line.length + 2 > cap) break
    kept.push(`+${line}`)
    used += line.length + 2
  }
  if (kept.length === 0) kept.push(`+${(lines[0] ?? '').slice(0, Math.max(0, cap - HEADER_ROOM - 2))}`)

  return { text: [`@@ -0,0 +1,${kept.length} @@`, ...kept].join('\n'), isCut: kept.length < lines.length }
}

/**
 * Every top-level JSON value in a text, in order: `gh api --paginate` prints one array per page back to back.
 * A value cut short at the end is dropped.
 * @example
 * // before: '[{"a":1}]\n[{"a":"]["}]'
 * // after:  [[{ a: 1 }], [{ a: '][' }]]
 */
export function parseJsonSequence(text: string): unknown[] {
  const values: unknown[] = []
  let depth = 0
  let start = -1
  let isInString = false
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]
    if (isInString) {
      if (char === '\\') at += 1
      else if (char === '"') isInString = false
      continue
    }
    if (char === '"') isInString = true
    else if (char === '[' || char === '{') {
      if (depth === 0) start = at
      depth += 1
    } else if (char === ']' || char === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        try {
          values.push(JSON.parse(text.slice(start, at + 1)))
        } catch {
          // A broken page is left out; the others still count.
        }
        start = -1
      }
    }
  }

  return values
}

/** One entry of `GET /repos/{owner}/{repo}/pulls/{n}/files`. */
export interface PrFileEntry {
  filename: string
  previousFilename?: string
  status?: string
  /** Absent for a binary file or one too large for GitHub to diff. */
  patch?: string
}

function stringField(value: object, field: string): string | undefined {
  const found: unknown = field in value ? Reflect.get(value, field) : undefined

  return typeof found === 'string' ? found : undefined
}

/** The files of every page of `gh api …/files --paginate`. */
export function parsePrFiles(stdout: string): PrFileEntry[] {
  return parseJsonSequence(stdout).flatMap(page =>
    (Array.isArray(page) ? page : []).flatMap((entry: unknown): PrFileEntry[] => {
      if (typeof entry !== 'object' || entry === null) return []
      const filename = stringField(entry, 'filename')
      if (filename === undefined) return []
      const previousFilename = stringField(entry, 'previous_filename')
      const status = stringField(entry, 'status')
      const patch = stringField(entry, 'patch')

      return [{ filename, ...(previousFilename ? { previousFilename } : {}), ...(status ? { status } : {}), ...(patch !== undefined ? { patch } : {}) }]
    })
  )
}

/** The PR's entry for a path: by its name, else by the name it had before a rename. */
export function findPrFile(files: readonly PrFileEntry[], path: string): PrFileEntry | undefined {
  return files.find(file => file.filename === path) ?? files.find(file => file.previousFilename === path)
}

/** `headRefOid` of `gh pr view --json headRefOid`, when it is a full sha. */
export function parseHeadSha(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout)
    const sha = typeof parsed === 'object' && parsed !== null ? stringField(parsed, 'headRefOid') : undefined

    return sha !== undefined && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined
  } catch {
    return undefined
  }
}

/** `baseRefName` of `gh pr view --json baseRefName`, when it is a plain branch name. */
export function parseBaseRef(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout)
    const ref = typeof parsed === 'object' && parsed !== null ? stringField(parsed, 'baseRefName') : undefined

    return ref !== undefined && /^[\w./-]+$/.test(ref) && !ref.startsWith('-') ? ref : undefined
  } catch {
    return undefined
  }
}

/** A repo-relative path safe to join under the repo root: no `..`, not absolute. */
export function isSafeRepoPath(path: string): boolean {
  return path !== '' && !path.startsWith('/') && !path.split(/[\\/]/).includes('..')
}
