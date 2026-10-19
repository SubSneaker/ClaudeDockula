// Lays out a drawn element tree (what the plugin test kit's `ui.drawn()` returns) into terminal rows:
// a small flexbox for Box / Text / Button / Client, cell-exact, emoji and CJK two cells wide.
// Output rows are runs of [text, style], style being '' or a space-separated list:
// b (bold), d (dim), u (underline), i (inverse), c:<themeKey> (colour).

const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe],
  [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab],
  [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3],
  [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0],
  [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f000, 0x1faff], [0x20000, 0x3fffd]
]

function isZeroWidth(p) {
  return (p >= 0x300 && p <= 0x36f) || (p >= 0x200b && p <= 0x200f) || (p >= 0xfe00 && p <= 0xfe0f) || (p >= 0x1f3fb && p <= 0x1f3ff)
}

/** The plugin's own cell measure (hooks/dock/ui.tsx), so rows line up exactly as the terminal draws them. */
export function measureChars(text) {
  const out = []
  let joined = false
  for (const ch of text) {
    const p = ch.codePointAt(0) ?? 0
    const last = out[out.length - 1]
    if (joined && last) { last[0] += ch; joined = false }
    else if (p === 0x200d && last) { last[0] += ch; joined = true }
    else if (p === 0xfe0f && last) { last[0] += ch; last[1] = 2 }
    else out.push([ch, isZeroWidth(p) ? 0 : WIDE.some(([a, b]) => p >= a && p <= b) ? 2 : 1])
  }
  return out
}

const cellsOf = text => measureChars(text).reduce((s, [, w]) => s + w, 0)

function styleKey(st) {
  return [st.bold && 'b', st.dim && 'd', st.underline && 'u', st.inverse && 'i', st.color && `c:${st.color}`].filter(Boolean).join(' ')
}

/** A block: `w` cells wide, `grid[row][col]` a cell `{ ch, st, w }`, `null` behind a wide char, or undefined for a blank. */
function blank(w, h) {
  return { w, h, grid: Array.from({ length: h }, () => new Array(w).fill(undefined)) }
}

function put(target, block, x, y, clipW = target.w, clipH = target.h) {
  for (let r = 0; r < block.h; r += 1) {
    const ty = y + r
    if (ty < 0 || ty >= clipH) continue
    for (let c = 0; c < block.w; c += 1) {
      const tx = x + c
      if (tx < 0 || tx >= clipW) continue
      const cell = block.grid[r][c]
      if (cell !== undefined) target.grid[ty][tx] = cell
    }
  }
}

/** Inline runs of a Text (nested Texts inherit), as lines of [char, cells, style]. */
function textLines(node, inherited) {
  const p = node.props ?? {}
  const st = {
    bold: p.bold ?? inherited.bold,
    dim: p.dimColor ?? inherited.dim,
    underline: p.underline ?? inherited.underline,
    inverse: p.inverse ?? inherited.inverse,
    color: p.color ?? inherited.color
  }
  const lines = [[]]
  for (const child of node.children ?? []) {
    if (typeof child === 'string' || typeof child === 'number') {
      const parts = String(child).split('\n')
      parts.forEach((part, i) => {
        if (i > 0) lines.push([])
        for (const [ch, w] of measureChars(part)) lines[lines.length - 1].push([ch, w, st])
      })
    } else if (child && typeof child === 'object') {
      const sub = textLines(child, st)
      sub.forEach((line, i) => {
        if (i > 0) lines.push([])
        lines[lines.length - 1].push(...line)
      })
    }
  }
  return lines
}

const lineCells = line => line.reduce((s, [, w]) => s + w, 0)

function fitLine(line, cells) {
  if (lineCells(line) <= cells) return line
  const kept = []
  let used = 0
  for (const item of line) {
    if (used + item[1] > cells - 1) break
    kept.push(item)
    used += item[1]
  }
  const st = (line[kept.length] ?? line[line.length - 1])?.[2] ?? {}
  return cells < 1 ? [] : [...kept, ['…', 1, st]]
}

function wrapLine(line, cells) {
  if (cells < 1) return [[]]
  const out = [[]]
  let used = 0
  for (const item of line) {
    if (used + item[1] > cells) { out.push([]); used = 0 }
    out[out.length - 1].push(item)
    used += item[1]
  }
  return out
}

function linesToBlock(lines, w) {
  const block = blank(w, lines.length)
  lines.forEach((line, r) => {
    let c = 0
    for (const [ch, cw, st] of line) {
      if (c + cw > w) break
      block.grid[r][c] = { ch, st, w: cw }
      if (cw === 2) block.grid[r][c + 1] = null
      c += cw
    }
  })
  return block
}

function layoutText(node, avail, inherited) {
  const wrap = node.props?.wrap ?? 'wrap'
  let lines = textLines(node, inherited)
  if (wrap.startsWith('truncate')) lines = lines.map(line => fitLine(line, avail))
  else lines = lines.flatMap(line => wrapLine(line, avail))
  const w = Math.min(avail, Math.max(0, ...lines.map(lineCells)))
  return linesToBlock(lines, w)
}

const ACCENT = 'claude'

/** A Button as the terminal draws it: `[ label ]`, or the label alone when `plain` (`1: label` with a hotkey). */
function buttonAsText(node) {
  const p = node.props ?? {}
  const inner = (node.children ?? []).length > 0 ? node.children : [p.label ?? '']
  const label = { type: 'Text', props: { dimColor: p.dimColor || undefined, color: p.variant === 'primary' ? ACCENT : undefined }, children: inner }
  if (p.plain) {
    return p.hotkey
      ? { type: 'Text', props: {}, children: [{ type: 'Text', props: { color: ACCENT }, children: [p.hotkey] }, ': ', label] }
      : label
  }
  return { type: 'Text', props: {}, children: ['[ ', label, ' ]'] }
}

function edges(p, name) {
  const all = p[name] ?? 0
  const x = p[`${name}X`] ?? all
  const y = p[`${name}Y`] ?? all
  return {
    top: p[`${name}Top`] ?? y,
    bottom: p[`${name}Bottom`] ?? y,
    left: p[`${name}Left`] ?? x,
    right: p[`${name}Right`] ?? x
  }
}

/**
 * Lays `node` out in at most `avail` cells. `fill` asks a box to take the whole width (a column parent stretches its
 * children); otherwise it takes what its content needs.
 */
export function layout(node, avail, fill = true, inherited = {}) {
  if (node === null || node === undefined || node === false) return blank(0, 0)
  if (typeof node === 'string' || typeof node === 'number') return layoutText({ type: 'Text', children: [node] }, avail, inherited)
  if (Array.isArray(node)) return layout({ type: 'Box', props: { flexDirection: 'column' }, children: node }, avail, fill, inherited)
  if (node.type === 'Text') return layoutText(node, avail, inherited)
  if (node.type === 'Button') return layoutText(buttonAsText(node), avail, inherited)
  // Box and Client (a Client holds its module's drawing as its one child).
  const p = node.props ?? {}
  const margin = edges(p, 'margin')
  const pad = edges(p, 'padding')
  const outer = typeof p.width === 'number' ? Math.min(p.width, avail) : avail - margin.left - margin.right
  const inner = Math.max(0, outer - pad.left - pad.right)
  const kids = (node.children ?? []).filter(k => k !== null && k !== undefined && k !== false && k !== '')
  const flowKids = kids.filter(k => k?.props?.position !== 'absolute')
  const absKids = kids.filter(k => k?.props?.position === 'absolute')
  const isRow = node.type === 'Box' && (p.flexDirection ?? 'row') === 'row'
  const gap = isRow ? (p.columnGap ?? p.gap ?? 0) : (p.rowGap ?? p.gap ?? 0)

  let content
  if (isRow) {
    const slots = flowKids.map(k => {
      const kp = k?.props ?? {}
      const fixed = typeof kp.width === 'number'
      const natural = layout(k, inner, false, inherited)
      return { k, fixed, base: natural.w, grow: kp.flexGrow ?? 0, shrink: kp.flexShrink ?? 1 }
    })
    const used = slots.reduce((s, x) => s + x.base, 0) + gap * Math.max(0, slots.length - 1)
    let free = inner - used
    const sizes = slots.map(x => x.base)
    if (free > 0) {
      const grow = slots.reduce((s, x) => s + x.grow, 0)
      if (grow > 0) {
        let left = free
        slots.forEach((x, i) => {
          if (x.grow > 0) {
            const add = Math.floor((free * x.grow) / grow)
            sizes[i] += add
            left -= add
          }
        })
        const last = slots.map((x, i) => (x.grow > 0 ? i : -1)).filter(i => i >= 0).pop()
        if (last !== undefined) sizes[last] += left
        free = 0
      }
    } else if (free < 0) {
      let over = -free
      for (let i = slots.length - 1; i >= 0 && over > 0; i -= 1) {
        if (slots[i].shrink > 0 && !slots[i].fixed) {
          const cut = Math.min(over, sizes[i])
          sizes[i] -= cut
          over -= cut
        }
      }
      free = 0
    }
    const blocks = slots.map((x, i) => layout(x.k, sizes[i], x.grow > 0 || x.fixed, inherited))
    const h = Math.max(0, ...blocks.map(b => b.h))
    const height = typeof p.height === 'number' ? p.height : h
    const width = fill || typeof p.width === 'number' ? inner : Math.min(inner, Math.max(0, used))
    content = blank(width, height)
    let x = 0
    let between = gap
    if (free > 0) {
      if (p.justifyContent === 'flex-end') x = free
      else if (p.justifyContent === 'center') x = Math.floor(free / 2)
      else if (p.justifyContent === 'space-between' && slots.length > 1) between = gap + free / (slots.length - 1)
    }
    let pos = x
    blocks.forEach((b, i) => {
      put(content, b, Math.round(pos), 0)
      pos += sizes[i] + between
    })
  } else {
    const blocks = flowKids.map(k => ({ b: layout(k, inner, true, inherited) }))
    const naturalW = Math.max(0, ...blocks.map(({ b }) => b.w))
    const w = fill || typeof p.width === 'number' ? inner : Math.min(inner, naturalW)
    const h = blocks.reduce((s, { b }) => s + b.h, 0) + gap * Math.max(0, blocks.length - 1)
    content = blank(w, h)
    let y = 0
    blocks.forEach(({ b }, i) => {
      put(content, b, 0, y)
      y += b.h + (i < blocks.length - 1 ? gap : 0)
    })
    if (typeof p.height === 'number') {
      const sized = blank(w, p.height)
      put(sized, content, 0, 0)
      content = sized
    }
  }

  const box = blank(content.w + pad.left + pad.right, content.h + pad.top + pad.bottom)
  put(box, content, pad.left, pad.top)
  for (const k of absKids) {
    const kp = k.props ?? {}
    const top = kp.top ?? 0
    const height = typeof kp.height === 'number' ? kp.height : kp.bottom !== undefined ? box.h - top - kp.bottom : undefined
    const b = layout({ ...k, props: { ...kp, height } }, kp.width ?? box.w, true, inherited)
    const clipped = height !== undefined && kp.overflow === 'hidden' ? { ...b, h: Math.min(b.h, height) } : b
    put(box, clipped, (kp.left ?? 0) + pad.left, top + pad.top)
  }
  const result = blank(box.w + margin.left + margin.right, box.h + margin.top + margin.bottom)
  put(result, box, margin.left, margin.top)
  return result
}

/** The block's rows as runs of [text, style]; trailing blanks trimmed. */
export function toRuns(block) {
  return block.grid.map(row => {
    const runs = []
    let lastSt = null
    for (const cell of row) {
      if (cell === null) continue
      const ch = cell === undefined ? ' ' : cell.ch
      const st = cell === undefined ? '' : styleKey(cell.st)
      if (runs.length > 0 && st === lastSt) runs[runs.length - 1][0] += ch
      else runs.push([ch, st])
      lastSt = st
    }
    while (runs.length > 0 && runs[runs.length - 1][1] === '' && runs[runs.length - 1][0].trim() === '') runs.pop()
    if (runs.length > 0 && runs[runs.length - 1][1] === '') runs[runs.length - 1][0] = runs[runs.length - 1][0].replace(/\s+$/, '')
    return runs
  })
}

export function plainRows(block) {
  return toRuns(block).map(runs => runs.map(([t]) => t).join(''))
}

export { cellsOf }
