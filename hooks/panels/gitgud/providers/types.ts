// The provider adapter contract: every operation is a pure generator that yields the requests it needs and
// returns a parsed value. Only the wiring files hold `$`; they run each request and feed the outcome back in.
import type { GhCheck, GhHealth, GhItem, GhRepo, GhScope } from '../../../../types'
import type { PrFileEntry } from '../diff'
import type { FullThread, ListsResult, Parsed, PrFiles } from '../parse'

export type { Parsed } from '../parse'

export type ProviderId = 'github' | 'gitlab' | 'bitbucket'
export interface RepoRef { provider: ProviderId; host: string; apiHost: string; path: string } // path: 'acme/web' or 'g/sub/proj'
export type Req =
  | { kind: 'cli'; tool: 'gh' | 'glab'; argv: string[]; env: Record<string, string>; timeoutMs?: number }
  | { kind: 'git'; argv: string[] }                                  // read-only git, e.g. rev-parse of a short hash
  | { kind: 'http'; method: 'GET'; url: string; headers?: Record<string, string>; needsToken: boolean; accept?: 'json' | 'text' }
export type Outcome = { exitCode: number; stdout: string; stderr: string; status?: number; headers?: Record<string, string>; isTruncated?: boolean }
/** A PR's files for the inspector; `isPartial` is set when the read came back cut short. */
export type PrFilesRead = PrFileEntry[] & { isPartial?: boolean }
export type Step = Req | readonly Req[]                              // an array runs in parallel through the gates
export type Op<T> = Generator<Step, Parsed<T>, Outcome | Outcome[]>

/** What a list call needs: the scope, the followed repos (repo keys) and the host it asks. */
export interface ListsCtx {
  host: string
  apiHost: string
  scope: GhScope
  repos: readonly RepoRef[]
  login?: string
  ticketPattern?: string
}

/** Overlap input already read, by `${repo}#${number}`, valid while the head sha matches. */
export type OverlapCache = Record<string, { headSha: string; files: string[] }>

export interface BranchPr { number: number; url: string; baseRef: string; title: string }

export interface ProviderCaps {
  issues: boolean
  failedLogs: boolean; checkoutCommand: (item: GhItem) => string | undefined
  vocab: { noun: 'pull request' | 'merge request'; short: 'PR' | 'MR'; sigil: '#' | '!' }
  templatePaths: readonly string[]
}

export interface ProviderAdapter {
  id: ProviderId; caps: ProviderCaps
  health(host: string): Op<{ health: GhHealth; login?: string; userId?: string; error?: string }>
  repoOf(ref: RepoRef): Op<GhRepo>                            // validate + default branch
  lists(ctx: ListsCtx): Op<ListsResult>                       // review / mine / issues, normalized GhItem[]
  search(ctx: ListsCtx, text: string): Op<GhItem[]>
  details(ctx: ListsCtx, items: readonly GhItem[]): Op<Record<string, Partial<GhItem>>>  // ci/review fill-in where lists lack them
  checks(item: GhItem): Op<GhCheck[]>
  failedLog(item: GhItem, check: GhCheck): Op<string>          // raw text; caps.failedLogs false → never called
  thread(item: GhItem): Op<FullThread>
  diff(item: GhItem): Op<string>                              // unified diff text
  head(item: GhItem): Op<{ headSha: string; baseSha?: string; baseRef: string }>  // headSha full (resolved via git if short)
  prFiles(item: GhItem): Op<PrFilesRead>                    // per-file patches for the inspector
  openPrFiles(ref: RepoRef, known: OverlapCache): Op<PrFiles[]>  // overlap input; per-pr adapters reuse cache by head sha
  prForBranch(ref: RepoRef, branch: string): Op<BranchPr | undefined>
  recentRepos(host: string): Op<string[]>; searchRepos(host: string, text: string): Op<string[]>
}
