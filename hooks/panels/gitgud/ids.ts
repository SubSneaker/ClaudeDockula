// Repo keys (`host/path`), item ids (`host/path#n`) and their Button-key encodings. Pure: no `$`.
// The old `owner/name` and `owner/name#n` shapes still read, as github.com.

export const LEGACY_HOST = 'github.com'

const TILDE = /[~]/g
const NUMBER = /^\d+$/

export interface ParsedRepoKey {
  host: string
  /** `acme/web` or `g/sub/proj`: two or more segments. */
  path: string
}

export interface ParsedItemId extends ParsedRepoKey {
  /** The canonical repo key, `host/path`. */
  repo: string
  number: number
}

function isSegments(parts: readonly string[]): boolean {
  return parts.every(part => part !== '' && !/[\s#]/.test(part))
}

/**
 * A repo key read apart; `owner/name` (no host) reads as github.com.
 * @example
 * // 'gitlab.com/g/sub/proj' → { host: 'gitlab.com', path: 'g/sub/proj' }
 * // 'acme/web'              → { host: 'github.com', path: 'acme/web' }
 */
export function parseRepoKey(key: string): ParsedRepoKey | undefined {
  const parts = key.split('/')
  if (parts.length < 2 || !isSegments(parts)) return undefined
  if (parts.length === 2) return { host: LEGACY_HOST, path: key }
  const [host = '', ...path] = parts

  return { host: host.toLowerCase(), path: path.join('/') }
}

export function repoKeyOf(host: string, path: string): string {
  return `${host.toLowerCase()}/${path}`
}

/** A repo key with its host: `acme/web` becomes `github.com/acme/web`; anything unreadable is left alone. */
export function canonicalRepoKey(key: string): string {
  const parsed = parseRepoKey(key)

  return parsed === undefined ? key : repoKeyOf(parsed.host, parsed.path)
}

export function itemId(repo: string, number: number): string {
  return `${repo}#${number}`
}

/** An item id read apart; the old `owner/name#n` shape reads as github.com. */
export function parseItemId(id: string): ParsedItemId | undefined {
  const at = id.lastIndexOf('#')
  const number = id.slice(at + 1)
  const parsed = at < 0 || !NUMBER.test(number) ? undefined : parseRepoKey(id.slice(0, at))
  if (parsed === undefined) return undefined

  return { ...parsed, repo: repoKeyOf(parsed.host, parsed.path), number: Number(number) }
}

/** The id with its host: `acme/web#12` becomes `github.com/acme/web#12`. */
export function canonicalItemId(id: string): string {
  const parsed = parseItemId(id)

  return parsed === undefined ? id : itemId(parsed.repo, parsed.number)
}

/** The key of a loaded repo: `host/path`; a repo without a host is github.com's. */
export function repoKeyOfRepo(repo: { nameWithOwner: string; host?: string; path?: string }): string {
  return repoKeyOf(repo.host ?? LEGACY_HOST, repo.path ?? repo.nameWithOwner)
}

/** Whether `repo` is the session folder's repo; names are compared case-insensitively, with or without the host. */
export function isSessionRepo(repo: string, currentRepo: string | undefined): boolean {
  return currentRepo !== undefined && canonicalRepoKey(repo).toLowerCase() === canonicalRepoKey(currentRepo).toLowerCase()
}

function encodePart(part: string): string {
  return encodeURIComponent(part).replace(TILDE, '%7E')
}

function decodeParts(encoded: string): string[] | undefined {
  try {
    return encoded.split('~').map(part => decodeURIComponent(part))
  } catch {
    return undefined
  }
}

/**
 * An item id made safe inside a Button key: `/` and `#` become `~`.
 * @example
 * // before: 'gitlab.com/g/sub/proj#12'
 * // after:  'gitlab.com~g~sub~proj~12'
 */
export function encodeItemId(id: string): string {
  const at = id.lastIndexOf('#')
  const parsed = at < 0 ? undefined : parseItemId(id)
  if (parsed === undefined) return encodePart(id)

  return [...id.slice(0, at).split('/'), id.slice(at + 1)].map(encodePart).join('~')
}

/** `encodeItemId` read back as a canonical id (an old `owner/name#n` gains `github.com/`); undefined when it is not one. */
export function decodeItemId(encoded: string): string | undefined {
  const parts = decodeParts(encoded)
  const number = parts?.at(-1) ?? ''
  if (parts === undefined || parts.length < 3 || !NUMBER.test(number)) return undefined
  const id = itemId(parts.slice(0, -1).join('/'), Number(number))

  return parseItemId(id) === undefined ? undefined : canonicalItemId(id)
}

/** `gitlab.com/g/sub` → `gitlab.com~g~sub`, safe inside a Button key. */
export function encodeRepoName(name: string): string {
  return name.split('/').map(encodePart).join('~')
}

/** `encodeRepoName` read back; undefined when it is not one. */
export function decodeRepoName(encoded: string): string | undefined {
  const name = decodeParts(encoded)?.join('/')

  return name !== undefined && parseRepoKey(name) !== undefined ? name : undefined
}

/**
 * The folder a repo's files go in, one level under the panel's folder.
 * @example
 * // 'gitlab.com/g/sub/proj' → 'gitlab.com/g__sub__proj'
 * // 'acme/web'              → 'github.com/acme__web'
 */
export function repoFolderOf(repo: string): string {
  const parsed = parseRepoKey(repo)
  const safe = (text: string): string => text.replace(/[^\w.-]/g, '_')

  return parsed === undefined ? safe(repo) : `${safe(parsed.host)}/${parsed.path.split('/').map(safe).join('__')}`
}
