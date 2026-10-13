/**
 * Build script for pi-desktop-wtq-pool.
 *
 * Compiles the host-agnostic core modules in `src/*.ts` to CommonJS in `lib/`,
 * one output file per input (`bundle: false`), so the PI-Desktop host can
 * `require('./lib/upstream')` and friends and let Node resolve the cross-module
 * requires at runtime.
 *
 * Run with `node build.mjs` (or `npm run build`) from the plugin root.
 */

import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = fileURLToPath(new URL('.', import.meta.url))
const srcDir = join(root, 'src')
const outDir = join(root, 'lib')

const entryPoints = readdirSync(srcDir)
  .filter(name => name.endsWith('.ts'))
  .sort()
  .map(name => join(srcDir, name))

if (entryPoints.length === 0) {
  console.error('build: no TypeScript sources found in src/')
  process.exit(1)
}

const result = esbuild.buildSync({
  entryPoints,
  outdir: outDir,
  bundle: false,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  tsconfigRaw: '{}',
  sourcemap: false,
  logLevel: 'warning',
})

if (result.errors.length > 0) {
  for (const error of result.errors) console.error(error.text)
  process.exit(1)
}

const emitted = entryPoints.map(file => {
  const name = basename(file, '.ts')
  const outFile = join(outDir, `${name}.js`)
  return `lib/${name}.js (${statSync(outFile).size} B)`
})

console.log(`build: emitted ${emitted.length} CommonJS file(s) to lib/ — ${emitted.join(', ')}`)
