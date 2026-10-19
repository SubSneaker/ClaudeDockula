import { COPY_EXCLUDES, EMPTY_TREE } from './review'

/** Executables tried in order when `gh` is not on PATH. */
export const GH_CANDIDATES: readonly string[] = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']

// git, always `git --no-optional-locks …`
export const GIT_BRANCH: string[] = ['git', '--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD']
export const GIT_TOPLEVEL: string[] = ['git', '--no-optional-locks', 'rev-parse', '--show-toplevel']
export const GIT_STATUS_PORCELAIN: string[] = ['git', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']
export function gitMergeBase(base: string): string[] {
  return ['git', '--no-optional-locks', 'merge-base', 'HEAD', `origin/${base}`]
}
export function gitChangedSince(mergeBase: string): string[] {
  return ['git', '--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', mergeBase, 'HEAD']
}
/** The commit two refs share. */
export function gitMergeBaseOf(a: string, b: string): string[] {
  return ['git', '--no-optional-locks', 'merge-base', a, b]
}
/** One path, named from the repo root and taken literally. */
function topPath(path: string): string {
  return `:(top,literal)${path}`
}
/** Whether one file is the same at two commits: exit 0 when it is. */
export function gitSameAt(a: string, b: string, path: string): string[] {
  return ['git', '--no-optional-locks', 'diff', '--quiet', '--no-ext-diff', '--no-textconv', a, b, '--', topPath(path)]
}
/** One file's working tree (uncommitted included) against a commit. */
export function gitDiffPath(mergeBase: string, path: string): string[] {
  return ['git', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', mergeBase, '--', topPath(path)]
}
/** One file's status: `?? path` when it is untracked. */
export function gitStatusPath(path: string): string[] {
  return [...GIT_STATUS_PORCELAIN, '--', topPath(path)]
}
export function gitLogSince(mergeBase: string): string[] {
  return ['git', '--no-optional-locks', 'log', '--no-merges', '--format=%h%x09%s', `${mergeBase}..HEAD`]
}
export function gitDiffStat(mergeBase: string): string[] {
  return ['git', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--stat', mergeBase, 'HEAD']
}
export function gitDiff(mergeBase: string): string[] {
  return ['git', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', mergeBase, 'HEAD', '--', '.', ':(exclude)*.lock', ':(exclude)pnpm-lock.yaml', ':(exclude)package-lock.json']
}

// The background review's clean copy: read from the local repo into the review's own folder, never a checkout.
export const GIT_VERSION: string[] = ['git', '--version']
/** The filter drivers the person's git config defines, which the copy switches off. */
export const GIT_FILTER_DRIVERS: string[] = ['git', '--no-optional-locks', 'config', '--null', '--get-regexp', '^filter\\.']
/** Exit 0 when the commit is on this machine. */
export function gitHasCommit(sha: string): string[] {
  return ['git', '--no-optional-locks', 'cat-file', '-e', `${sha}^{commit}`]
}
/**
 * The commit's files as stored, as a tar outside the repo, each under `tree/`: no attributes from the commit's own
 * `.gitattributes` (`--attr-source` the empty tree), and every filter driver of the person's config left with no
 * program and not required, so git passes the content through as stored (no git-crypt decryption, no git-lfs download).
 */
export function gitArchive(sha: string, tarPath: string, filterDrivers: readonly string[]): string[] {
  const offs = filterDrivers.flatMap(name => ['-c', `filter.${name}.process=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.required=false`])

  return ['git', '--no-optional-locks', `--attr-source=${EMPTY_TREE}`, ...offs, 'archive', '--format=tar', '--prefix=tree/', '-o', tarPath, sha]
}
/** The tar unpacked beside it, without Claude Code's project config and git hook folders. */
export function tarExtract(tarPath: string, dir: string): string[] {
  return ['tar', '-xf', tarPath, '-C', dir, ...COPY_EXCLUDES.flatMap(pattern => ['--exclude', pattern])]
}
/** A finished review's folder, gone. */
export function removeReviewDir(dir: string): string[] {
  return ['rm', '-rf', dir]
}
