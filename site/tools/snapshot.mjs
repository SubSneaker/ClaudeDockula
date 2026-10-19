// Regenerates site/frames.json: the landing page's terminal frames, drawn by the plugin itself with made-up data.
//
//   node site/tools/snapshot.mjs
//
// Copies the plugin into a temporary folder, swaps its tests for site/probe/scenes.probe.tsx, runs
// `claude plugin test` there, and lays each printed tree out into rows of [text, style] runs (site/tools/rows.mjs).
// Then run `node site/build.mjs` to rebuild the compositions under docs/assets/.

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { layout, toRuns } from './rows.mjs'

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(SITE, '..')

/** Frame name → the columns it is laid out in. */
const WIDTHS = {
  'dock-all': 56,
  'dock-none': 56,
  'hero-band-closed': 129,
  'hero-band-focused': 72,
  'jira-rest': 56,
  'jira-drag-dev': 56,
  'jira-drag-review': 56,
  'jira-confirm': 56,
  'jira-moved': 56,
  slacker: 56,
  'bottom-12': 110,
  'bottom-drag1': 110,
  'bottom-drag2': 110,
  'bottom-drag3': 110,
  'bottom-drag4': 110,
  'bottom-drag5': 110,
  'bottom-drag6': 110,
  'bottom-18': 110,
  'gg-0': 56,
  'gg-6': 56,
  'gg-12': 56,
  'gg-18': 56,
  'gg-ask-on': 56,
  'gg-ask-off': 56,
  'gg-after': 56,
  'gg-done': 56
}

function runProbe() {
  const work = mkdtempSync(join(tmpdir(), 'dockula-frames-'))
  try {
    cpSync(REPO, work, {
      recursive: true,
      filter: source => !/\/(\.git|site|docs|tests|node_modules)(\/|$)/.test(source.slice(REPO.length))
    })
    mkdirSync(join(work, 'tests'))
    cpSync(join(SITE, 'probe', 'scenes.probe.tsx'), join(work, 'tests', 'probe.test.tsx'))
    const run = spawnSync('claude', ['plugin', 'test', work], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (run.status !== 0) throw new Error(`claude plugin test failed:\n${run.stdout}\n${run.stderr}`)
    return `${run.stdout}\n${run.stderr}`
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** `@@KIND name json` lines → { kind: { name: value } }. */
function parseOutput(output) {
  const found = {}
  for (const line of output.split('\n')) {
    const match = /^@@([A-Z]+) (\S+) (.*)$/.exec(line)
    if (!match) continue
    const [, kind, name, body] = match
    found[kind] ??= {}
    found[kind][name] = JSON.parse(body)
  }
  return found
}

/** Puts the GitGud list (drawn on its own in the probe) where the card holds its Client. */
function spliceList(node, list) {
  if (!node || typeof node !== 'object') return
  if (node.props?.key === 'gitgud-list-main') node.children = [list]
  for (const child of node.children ?? []) spliceList(child, list)
}

const found = parseOutput(runProbe())
const frames = {}
for (const [name, width] of Object.entries(WIDTHS)) {
  const tree = found.FRAME?.[name]
  if (!tree) throw new Error(`the probe printed no frame ${name}`)
  if (found.LIST?.[name]) spliceList(tree, found.LIST[name])
  frames[name] = { w: width, rows: toRuns(layout(tree, width)) }
}
const out = { frames }
writeFileSync(join(SITE, 'frames.json'), `${JSON.stringify(out)}\n`)
console.log(`site/frames.json: ${Object.keys(frames).length} frames`)
