// Where the Bitbucket token comes from and how it is sent. Pure: no `$`. The token is read at run time by the
// wiring file, held in a module variable only, and never goes into state, a notice, a log or an error line.

import { DEFAULT_TOKEN_ENV, KEYCHAIN_SERVICE } from './setup'

export { DEFAULT_TOKEN_ENV, KEYCHAIN_SERVICE }

const ACCOUNT_RE = /^[^\s'"]+$/
/** The only env vars a Bitbucket token is read from. */
export const ENV_TOKEN_NAMES: readonly string[] = ['BITBUCKET_TOKEN', 'BITBUCKET_API_TOKEN', 'ATLASSIAN_API_TOKEN']
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const AUTH_VALUE_RE = /\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]+/gi
const MIN_SECRET_CHARS = 4

export function isValidAccount(account: string): boolean {
  return ACCOUNT_RE.test(account)
}

export function isReadableTokenEnv(name: string): boolean {
  return ENV_TOKEN_NAMES.includes(name)
}

/** The read-only lookup for this platform; undefined where there is no keychain tool (Windows). */
export function keychainLookupArgv(platform: string, account: string): string[] | undefined {
  if (!isValidAccount(account)) return undefined
  if (platform === 'darwin') return ['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w']
  if (platform === 'linux') return ['secret-tool', 'lookup', 'service', KEYCHAIN_SERVICE, 'account', account]

  return undefined
}

/** The token a keychain tool printed: its trailing line break dropped; blank means no token. */
export function tokenFromKeychainOutput(stdout: string): string | undefined {
  const token = stdout.replace(/\r?\n$/, '')

  return token.trim() === '' ? undefined : token
}

/** The token in the named env var, read through the caller's getter; a name outside `ENV_TOKEN_NAMES` reads nothing. */
export function tokenFromEnv(name: string, read: (name: string) => string | undefined): string | undefined {
  if (!isReadableTokenEnv(name)) return undefined

  const token = read(name)?.trim()

  return token === undefined || token === '' ? undefined : token
}

function utf8Bytes(text: string): number[] {
  const bytes: number[] = []

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0

    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  }

  return bytes
}

/** Standard base64 of the text's UTF-8 bytes. */
export function base64Of(text: string): string {
  const bytes = utf8Bytes(text)
  let out = ''

  for (let at = 0; at < bytes.length; at += 3) {
    const [a = 0, b, c] = [bytes[at], bytes[at + 1], bytes[at + 2]]
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)

    out += BASE64.charAt((triple >> 18) & 63) + BASE64.charAt((triple >> 12) & 63)
    out += b === undefined ? '=' : BASE64.charAt((triple >> 6) & 63)
    out += c === undefined ? '=' : BASE64.charAt(triple & 63)
  }

  return out
}

/** Bitbucket Cloud's documented REST auth for an API token: Basic `email:token`. */
export function basicAuthHeader(email: string, token: string): string {
  return `Basic ${base64Of(`${email}:${token}`)}`
}

/**
 * Text that may be shown or logged: the given secrets, their Basic form, and any `Basic …` / `Bearer …` value
 * become `***`.
 * @example
 * // before: 'HTTP 401 for Basic dXNlcjp0b2s=, token s3cret'
 * // after:  'HTTP 401 for ***, token ***'
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  const hidden = secrets.flatMap(secret => (secret.length < MIN_SECRET_CHARS ? [] : [secret, base64Of(secret)]))
  const bare = hidden.reduce((result, secret) => result.split(secret).join('***'), text)

  return bare.replace(AUTH_VALUE_RE, '***')
}
