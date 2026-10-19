// The adapters by provider.
import { bitbucketAdapter } from './bitbucket'
import { githubAdapter } from './github'
import { gitlabAdapter } from './gitlab'
import type { ProviderAdapter, ProviderId } from './types'

export const ADAPTERS: Partial<Record<ProviderId, ProviderAdapter>> = { github: githubAdapter, gitlab: gitlabAdapter, bitbucket: bitbucketAdapter }

/** The adapter for a provider; undefined for one that is not built. */
export function adapterOf(provider: ProviderId): ProviderAdapter | undefined {
  return ADAPTERS[provider]
}
