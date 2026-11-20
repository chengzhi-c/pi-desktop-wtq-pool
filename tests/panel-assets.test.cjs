'use strict'

/**
 * The shipped panel and manifest, checked as files.
 *
 * Every other suite lifts named functions out of `panel.js`, so a renamed
 * element or an id missing from the page would leave the panel dead while the
 * suite stayed green.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')

test('the panel only addresses elements the shipped page contains', () => {
  const script = fs.readFileSync(path.join(root, 'renderer/panel.js'), 'utf8')
  const page = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8')
  const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]))
  const used = new Set([
    ...[...script.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]),
    ...[...script.matchAll(/querySelector(?:All)?\("#([A-Za-z][\w-]*)/g)].map((match) => match[1]),
  ])
  assert.ok(used.size > 0, 'the panel script must address at least one element')
  for (const id of used) assert.ok(ids.has(id), `renderer/index.html must define #${id}`)
})

test('the manifest and package agree on the shipped version and entry', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  assert.equal(manifest.version, pkg.version)
  assert.equal(manifest.main, 'main.js')
  assert.ok(fs.existsSync(path.join(root, manifest.main)))
})
