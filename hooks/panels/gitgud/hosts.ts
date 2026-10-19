// Which service a host or repo belongs to, from what the card knows: saved answers, known hosts and the host being
// set up. Pure: the wiring files ask it before they run an adapter.
import type { GhItem, GitgudState } from '../../../types'
import { apiHostOf, KNOWN_HOSTS } from './detect'
import { parseRepoKey, repoKeyOfRepo } from './ids'
import { OVERLAP_POLL_MS } from './model'
import { adapterOf } from './providers'
import type { ProviderAdapter, ProviderId, RepoRef } from './providers/types'
import { hostConfigOf } from './runner'
import type { GgHostConfig } from './setup'

/** The session folder's repo as a key. */
export function currentKeyOf(state: GitgudState): string | undefined {
  return state.currentRepo ? repoKeyOfRepo(state.currentRepo) : undefined
}

/** What the card knows of a host: its service, where its API is, and the config saved for it. */
export interface HostInfo {
  host: string
  provider: ProviderId
  apiHost: string
  config?: GgHostConfig
}

export function hostInfoOf(state: GitgudState, host: string): HostInfo | undefined {
  const config = hostConfigOf(state.settings?.hosts, host)
  const pending = state.setup?.host === host ? state.setup : undefined
  const provider = config?.provider ?? KNOWN_HOSTS[host] ?? state.hosts?.[host]?.provider ?? pending?.provider ?? (state.host === host ? state.provider : undefined)
  if (provider === undefined) return undefined
  const saved = config?.apiHost === undefined && pending?.apiHost !== undefined ? { apiHost: pending.apiHost } : config

  return { host, provider, apiHost: apiHostOf(provider, host, saved), ...(config ? { config } : {}) }
}

export function repoRefOf(state: GitgudState, repo: string): RepoRef | undefined {
  const parsed = parseRepoKey(repo)
  const info = parsed === undefined ? undefined : hostInfoOf(state, parsed.host)

  return parsed === undefined || info === undefined ? undefined : { provider: info.provider, host: info.host, apiHost: info.apiHost, path: parsed.path }
}

export function adapterOfHost(state: GitgudState, host: string): ProviderAdapter | undefined {
  const info = hostInfoOf(state, host)

  return info === undefined ? undefined : adapterOf(info.provider)
}

/** The adapter of the service an item or repo key lives on. */
export function adapterOfRepo(state: GitgudState, repo: string): ProviderAdapter | undefined {
  const host = parseRepoKey(repo)?.host

  return host === undefined ? undefined : adapterOfHost(state, host)
}

/** A bare pull request item for an id: enough for an adapter to read its thread, diff and head. */
export function itemStubOf(id: string, repo: string, number: number, provider: ProviderId): GhItem {
  return { id, kind: 'pr', provider, repo, number, title: '', url: '', author: '', updatedAt: '', comments: 0 }
}

/** Bitbucket's hourly rate limit asks for a slower read of every open PR's files. */
const BITBUCKET_OVERLAP_POLL_MS = 900_000

/** How often a service's open PRs are read again for the overlap check. */
export function overlapPollMsOf(provider: ProviderId): number {
  return provider === 'bitbucket' ? BITBUCKET_OVERLAP_POLL_MS : OVERLAP_POLL_MS
}
