import type { GhOverlap } from '../../../types'
import { itemId } from './model'
import type { PrFiles } from './parse'

export type NameStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T'

const NAME_STATUSES: readonly string[] = ['A', 'M', 'D', 'R', 'C', 'T']

function isNameStatus(letter: string): letter is NameStatus {
  return NAME_STATUSES.includes(letter)
}

/**
 * Every path in `git status --porcelain=v1 -z`: a rename or copy lists its origin as the next entry.
 * @example
 * // before: 'R  new.ts\0old.ts\0?? fresh.ts\0 M a.ts\0'
 * // after:  ['new.ts', 'old.ts', 'fresh.ts', 'a.ts']
 */
export function parsePorcelainZ(stdout: string): string[] {
  const entries = stdout.split('\0')
  const paths = new Set<string>()
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] ?? ''
    if (entry.length < 4) continue
    paths.add(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
      const origin = entries[++index]
      if (origin) paths.add(origin)
    }
  }

  return [...paths]
}

/**
 * The entries of `git diff --name-status -z`: a rename or copy carries its origin in `from`.
 * @example
 * // before: 'M\0a.ts\0R087\0old.ts\0new.ts\0'
 * // after:  [{ status: 'M', path: 'a.ts' }, { status: 'R', path: 'new.ts', from: 'old.ts' }]
 */
export function parseNameStatusZ(stdout: string): { status: NameStatus; path: string; from?: string }[] {
  const entries = stdout.split('\0')
  const rows: { status: NameStatus; path: string; from?: string }[] = []
  for (let index = 0; index < entries.length; index++) {
    const letter = (entries[index] ?? '').charAt(0)
    if (!isNameStatus(letter)) continue
    if (letter === 'R' || letter === 'C') {
      const from = entries[++index]
      const path = entries[++index]
      if (from && path) rows.push({ status: letter, path, from })
      continue
    }
    const path = entries[++index]
    if (path) rows.push({ status: letter, path })
  }

  return rows
}

export interface OverlapInput {
  local: readonly string[]
  prs: readonly PrFiles[]
  repo: string
  branch?: string
  branchPr?: number
}

/** The other open PRs that share files with the local changes, most shared files first; the branch's own PR is left out. */
export function computeOverlaps(input: OverlapInput): GhOverlap[] {
  const local = new Set(input.local)
  const overlaps: GhOverlap[] = []
  for (const pr of input.prs) {
    if (pr.number === input.branchPr || (input.branch !== undefined && pr.headRef === input.branch)) continue
    const files = [...new Set(pr.files.filter(file => local.has(file)))].sort()
    if (files.length === 0) continue
    overlaps.push({
      prId: itemId(input.repo, pr.number),
      number: pr.number,
      repo: input.repo,
      title: pr.title,
      author: pr.author,
      url: pr.url,
      headRef: pr.headRef,
      files,
      ...(pr.isPartial ? { isPartial: true } : {})
    })
  }

  return overlaps.sort((a, b) => b.files.length - a.files.length || a.number - b.number)
}
