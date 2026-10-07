#!/usr/bin/env bun
/**
 * One-shot gzipped-size measurement for a feature selection.
 *
 * Mirrors `build-firmware.ts` single-build mode so numbers never diverge:
 *   1. spawn `vite build` for the selection,
 *   2. inline JS/CSS via the same `inlineAssetTags` regexes,
 *   3. `zopfli.gzipAsync` over the inlined HTML (50 iterations by default,
 *      `NUMITERATIONS` overrides; keep it in step with `build-firmware.ts`),
 *   4. print `gz: <bytes> raw: <bytes>`.
 *
 * Default selection is the large tier (requires-closed, `theme = mesh`);
 * override with `FEATURES`, `TIER`, `THEME`, `BUILD_NAME` envs.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import zopfli from '@gfx/zopfli'
import { resolveFeatures } from '@meshcommander/build-system'
import { resolveTheme } from '@meshcommander/build-system/themes'

const root = new URL('..', import.meta.url).pathname
const distDir = join(root, 'dist')

const tier = process.env.TIER ?? 'large'
const theme = resolveTheme(process.env.THEME ?? 'mesh')
const buildName = process.env.BUILD_NAME ?? 'large-measure'

const selected = process.env.FEATURES
  ? resolveFeatures(process.env.FEATURES)
  : resolveFeatures(undefined, tier)

const featEnv: Record<string, string> = {}
// Duplicate vite.config.ts resolution path so the printed list matches the build.
// `process.env.FEATURES` here is the closed list; vite.config.ts does the same close.
featEnv.FEATURES = [...selected].join(',')
featEnv.THEME = theme
featEnv.BUILD_NAME = buildName

// ANALYZE passthrough — vite.config.ts watches for this
if (process.env.ANALYZE) featEnv.ANALYZE = process.env.ANALYZE

console.log(`measure: tier=${tier} theme=${theme} build=${buildName}`)
console.log(`  features (${selected.size}): ${[...selected].sort().join(', ')}`)

const proc = Bun.spawnSync(['bunx', 'vite', 'build'], {
  cwd: root,
  env: { ...process.env, ...featEnv },
  stdout: 'pipe',
  stderr: 'pipe',
})

if (proc.exitCode !== 0) {
  console.error(proc.stderr.toString())
  throw new Error(`vite build failed for ${buildName}`)
}
if (proc.stderr.toString().trim().length > 0) {
  // vite warnings still go to stderr; surface them once
  process.stderr.write(proc.stderr.toString())
}

// --- inline — copy of build-firmware.ts:inlineAssetTags ---------------
function inlineAssetTags(html: string, build: string): string {
  const inlined = html
    .replace(/<script([^>]*)\ssrc="([^"]+)"([^>]*)><\/script>/g, (_m, before, src, after) => {
      const file = join(distDir, build, src.replace(/^\//, ''))
      if (!existsSync(file)) return _m
      const code = readFileSync(file, 'utf8')
      return `<script${before.replace(/\scrossorigin/, '')}${after.replace(/\s*crossorigin="[^"]*"/, '')}>${code}</script>`
    })
    .replace(/<link([^>]*)rel="stylesheet"([^>]*)href="([^"]+)"[^>]*>/g, (m, _a, _b, href) => {
      const file = join(distDir, build, href.replace(/^\//, ''))
      if (!existsSync(file)) return m
      return `<style>${readFileSync(file, 'utf8')}</style>`
    })
  return inlined.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').trim()
}

function externalRefs(html: string): string[] {
  return [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith('data:'))
}

const html = readFileSync(join(distDir, buildName, 'index.html'), 'utf8')
const inlined = inlineAssetTags(html, buildName)
const leftovers = externalRefs(inlined)

const raw = Buffer.byteLength(inlined, 'utf8')
const it = Number(process.env.NUMITERATIONS ?? 50)
const gz = Buffer.from(await zopfli.gzipAsync(Buffer.from(inlined, 'utf8'), { numiterations: it }))

console.log(`  externalRefs: ${leftovers.length === 0 ? '[] (ok)' : leftovers.join(', ')}`)
console.log(`gz: ${gz.byteLength} raw: ${raw} (zopfli iterations=${it})`)
if (leftovers.length > 0) {
  console.error(`un-inlined refs: ${leftovers.join(', ')}`)
  process.exit(1)
}
