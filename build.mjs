/**
 * Build script for pi-desktop-wtq-pool.
 *
 * Compiles the host-agnostic core modules in `src/*.ts` to CommonJS in `lib/`,
 * one output file per input (`bundle: false`), so the PI-Desktop host can
 * `require('./lib/upstream')` and friends and let Node resolve the cross-module
 * requires at runtime.
 *
 * Run with `node build.mjs` (or `npm run build`) from the plugin root.
 * `node build.mjs --check` builds into a scratch directory instead and exits
 * non-zero when `lib/` does not match `src/`: `lib/` is tracked by git and is what
 * the installed plugin loads, so a working tree with a stale `lib/` looks built
 * and ships the previous code.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = fileURLToPath(new URL('.', import.meta.url))
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')
const check = process.argv.includes('--check')

const entryPoints = readdirSync(srcDir)
  .filter(name => name.endsWith('.ts'))
  .sort()
  .map(name => join(srcDir, name))

if (entryPoints.length === 0) {
  console.error('build: no TypeScript sources found in src/')
  process.exit(1)
}

const outDir = check ? mkdtempSync(join(tmpdir(), 'wtq-pool-build-')) : libDir

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
  if (check) rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}

const names = entryPoints.map(file => `${basename(file, '.ts')}.js`)

if (check) {
  // Every output has to match, and no output may exist without a source: a
  // renamed module leaves its old file behind, `require('./lib/old')` still
  // resolves it, and the plugin then runs code that is no longer in `src/`.
  const drift = []
  for (const name of names) {
    const built = join(outDir, name)
    const committed = join(libDir, name)
    if (!existsSync(committed)) drift.push(`missing lib/${name}`)
    else if (readFileSync(built, 'utf8') !== readFileSync(committed, 'utf8')) drift.push(`stale lib/${name}`)
  }
  if (existsSync(libDir)) {
    const expected = new Set(names)
    for (const name of readdirSync(libDir).sort()) {
      if (name.endsWith('.js') && !expected.has(name)) drift.push(`orphaned lib/${name}`)
    }
  }
  rmSync(outDir, { recursive: true, force: true })
  if (drift.length > 0) {
    console.error(`build: lib/ does not match src/ — ${drift.join(', ')}; run node build.mjs`)
    process.exit(1)
  }
  console.log(`build: lib/ matches src/ (${names.length} file(s))`)
} else {
  // A source that was renamed or deleted leaves its output behind, and the host
  // still reaches it. Sweeping here is what keeps "did the build run?" a question
  // about src/ alone.
  const orphans = existsSync(libDir)
    ? readdirSync(libDir).filter(name => name.endsWith('.js') && !names.includes(name)).sort()
    : []
  for (const name of orphans) unlinkSync(join(libDir, name))
  const emitted = names.map(name => `lib/${name} (${statSync(join(libDir, name)).size} B)`)
  const swept = orphans.length === 0 ? '' : `, swept ${orphans.length} without a source (${orphans.join(', ')})`
  console.log(`build: emitted ${emitted.length} CommonJS file(s) to lib/ — ${emitted.join(', ')}${swept}`)
}
