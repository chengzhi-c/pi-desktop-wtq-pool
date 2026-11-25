// lib/ is tracked and loaded directly by the host; --check compares without rewriting it.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
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

try {
  esbuild.buildSync({
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

  const names = entryPoints.map(file => `${basename(file, '.ts')}.js`)

  if (check) {
    // Renamed sources must not leave an old module that the host can still require.
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
    if (drift.length > 0) {
      console.error(`build: lib/ does not match src/ — ${drift.join(', ')}; run node build.mjs`)
      process.exitCode = 1
    } else {
      console.log(`build: lib/ matches src/ (${names.length} file(s))`)
    }
  } else {
    const orphans = readdirSync(libDir).filter(name => name.endsWith('.js') && !names.includes(name)).sort()
    for (const name of orphans) unlinkSync(join(libDir, name))
    const swept = orphans.length === 0 ? '' : `, swept ${orphans.length} without a source (${orphans.join(', ')})`
    console.log(`build: emitted ${names.length} CommonJS file(s) to lib/${swept}`)
  }
} finally {
  if (check) rmSync(outDir, { recursive: true, force: true })
}
