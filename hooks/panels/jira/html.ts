// The claude.ai connector answers in HTML when a body holds what markdown cannot (mentions, media,
// panels) and says so with `appliedContentFormat: "html"`; the prompt and the cards want markdown.

const HTML_START = /^\s*<(p|h[1-6]|ul|ol|div|table|figure|blockquote|pre)\b/i
const LIST_ITEM = /^(?:- |\d+\. )/
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  bull: '•',
  middot: '·',
  rarr: '→',
  larr: '←',
  times: '×',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  euro: '€'
}
/** Control characters a prompt or a drawn row may not hold: C0 and C1, newline and tab kept. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** Whether a Jira body is HTML rather than markdown. */
export function looksLikeHtml(text: string): boolean {
  return HTML_START.test(text)
}

function isControlPoint(point: number): boolean {
  return (point < 0x20 && point !== 0x09 && point !== 0x0a) || (point >= 0x7f && point <= 0x9f)
}

/**
 * `&#x41;` or `&#65;` as its character; a control character or a lone surrogate is dropped, and one past
 * Unicode's range stays as written.
 */
function codePointOf(whole: string, digits: string, radix: number): string {
  const point = Number.parseInt(digits, radix)
  if (!(point >= 0 && point <= 0x10ffff)) return whole
  if (isControlPoint(point) || (point >= 0xd800 && point <= 0xdfff)) return ''

  return String.fromCodePoint(point)
}

/** The text without control characters, newlines and tabs kept. */
export function dropControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, '')
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return codePointOf(whole, name.slice(2), 16)
    if (name.startsWith('#')) return codePointOf(whole, name.slice(1), 10)

    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/**
 * Numbers each `<ol>`'s own items before the tags go; the items of a list nested in one keep their own markers.
 * @example
 * // before: '<ol><li>One<ul><li>a</li></ul></li><li>Two</li></ol>'
 * // after:  '\n\n1. One<ul><li>a</li></ul></li>\n2. Two</li>\n'
 */
function numberOrderedLists(html: string): string {
  // One entry per open list, innermost last: the items an `<ol>` numbered so far, undefined for a `<ul>`.
  const open: Array<number | undefined> = []

  return html.replace(/<(\/?)(ol|ul|li)\b[^>]*>/gi, (tag, slash: string, name: string) => {
    const kind = name.toLowerCase()
    if (kind === 'li') {
      const count = open[open.length - 1]
      if (slash !== '' || count === undefined) return tag
      open[open.length - 1] = count + 1

      return `\n${count + 1}. `
    }
    if (slash !== '') open.pop()
    else open.push(kind === 'ol' ? 0 : undefined)

    return kind === 'ol' ? '\n' : tag
  })
}

/**
 * Each innermost `<blockquote>` as quoted markdown, `> ` before every line, until none is left.
 * @example
 * // before: '<blockquote><p>One</p><p>Two</p></blockquote>'
 * // after:  '\n\n> One\n>\n> Two\n\n'
 */
function quoteBlockquotes(html: string): string {
  const innermost = /<blockquote\b[^>]*>((?:(?!<blockquote\b)[\s\S])*?)<\/blockquote>/gi
  const quoteInnermost = (text: string) =>
    text.replace(innermost, (_whole, inner: string) => `\n\n${quoteLines(tagsToMarkdown(inner))}\n\n`)
  let text = html
  for (let quoted = quoteInnermost(text); quoted !== text; quoted = quoteInnermost(text)) text = quoted

  return text
}

function quoteLines(markdown: string): string {
  return markdown
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .split('\n')
    .map(line => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n')
}

/** `<a href="u">text</a>` as a markdown link, or the bare URL when the text is the URL. */
function linkOf(_whole: string, href: string, text: string): string {
  const label = text.replace(/<[^>]+>/g, '').trim()

  return label === '' || label === href ? href : `[${label}](${href})`
}

/**
 * Jira's HTML body as markdown: paragraphs, headings, lists, links, code and emphasis kept; mentions as their
 * text; media named; every other tag dropped and entities decoded.
 * @example
 * // before: '<p>Hi <span data-type="mention">@Alex</span>,<br>see <a href="https://x">the PR</a>.</p><ul><li><p>One</p></li></ul>'
 * // after:  'Hi @Alex,\nsee [the PR](https://x).\n\n- One'
 */
export function htmlToMarkdown(html: string): string {
  const lines = dropControlChars(decodeEntities(tagsToMarkdown(quoteBlockquotes(html))))
    .replace(/^(- |\d+\. )[ \t]+/gm, '$1')
    .split('\n')
    .map(line => line.trimEnd())

  return joinListItems(lines)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Every tag as its markdown, or dropped; the entities are left for the caller to decode once. */
function tagsToMarkdown(html: string): string {
  return numberOrderedLists(html)
    .replace(/<div\b[^>]*data-type="media"[^>]*data-alt="([^"]*)"[^>]*>\s*<\/div>/gi, '[media: $1]')
    .replace(/<div\b[^>]*data-type="media"[^>]*>\s*<\/div>/gi, '[media]')
    .replace(/<img\b[^>]*\balt="([^"]+)"[^>]*>/gi, '[image: $1]')
    .replace(/<img\b[^>]*>/gi, '[image]')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, linkOf)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])\b[^>]*>/gi, (_whole, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/?(ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<pre\b[^>]*>(\s*<code\b[^>]*>)?/gi, '\n\n```\n')
    .replace(/(<\/code>\s*)?<\/pre>/gi, '\n```\n\n')
    .replace(/<\/?code\b[^>]*>/gi, '`')
    .replace(/<\/?(strong|b)\b[^>]*>/gi, '**')
    .replace(/<\/?(em|i)\b[^>]*>/gi, '_')
    .replace(/<hr\b[^>]*>/gi, '\n\n---\n\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/(p|h[1-6]|div|blockquote|tr|table|figure)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
}

/** Drops the blank lines between two list items, which the paragraphs inside each `<li>` left. */
function joinListItems(lines: readonly string[]): string[] {
  return lines.filter((line, index) => {
    if (line !== '') return true
    const before = lines.slice(0, index).findLast(one => one !== '')
    const after = lines.slice(index + 1).find(one => one !== '')

    return !(before !== undefined && after !== undefined && LIST_ITEM.test(before) && LIST_ITEM.test(after))
  })
}
