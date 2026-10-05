/**
 * Build the three firmware tiers and package each as a single gzipped HTML file
 * suitable for flashing into Intel AMT flash storage.
 *
 * AMT serves the page from its own web server with no sibling assets, so the JS
 * and CSS bundles are inlined into index.html before gzipping. Small must stay
 * under the 64 KiB AMT file-storage limit (readme.md:50).
 *
 *   bun scripts/build-firmware.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TIERS = ['small', 'medium', 'large'] as const
type Tier = (typeof TIERS)[number]

/** AMT firmware file-storage limit; Small must fit or it cannot be flashed. */
const SMALL_LIMIT = 65_536
/** Warn when a tier exceeds the legacy artifact by more than this. */
const LEGACY_TOLERANCE = 1.1

const root = new URL('..', import.meta.url).pathname
const distDir = join(root, 'dist')
const outDir = join(distDir, 'firmware')

const LEGACY_DIR = join(root, '..', 'output')

function legacySize(tier: Tier): number | null {
  const p = join(LEGACY_DIR, `Firmware-${cap(tier)}.gz`)
  return existsSync(p) ? statSync(p).size : null
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Strip Vite's crossorigin/modulepreload so the inlined tags stay self-contained. */
function inlineAssetTags(html: string): string {
  return html
    .replace(/<script([^>]*)\ssrc="([^"]+)"([^>]*)><\/script>/g, (_m, before, src, after) => {
      const file = join(distDir, currentTier, src.replace(/^\//, ''))
      if (!existsSync(file)) return _m
      const code = readFileSync(file, 'utf8')
      return `<script${before.replace(/\scrossorigin/, '')}${after.replace(/\s*crossorigin="[^"]*"/, '')}>${code}</script>`
    })
    .replace(/<link([^>]*)rel="stylesheet"([^>]*)href="([^"]+)"[^>]*>/g, (m, _a, _b, href) => {
      const file = join(distDir, currentTier, href.replace(/^\//, ''))
      if (!existsSync(file)) return m
      return `<style>${readFileSync(file, 'utf8')}</style>`
    })
}

let currentTier: Tier = 'large'

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const results: { tier: Tier; raw: number; gz: number; legacy: number | null }[] = []
const failures: string[] = []

for (const tier of TIERS) {
  currentTier = tier
  process.stdout.write(`building ${tier} ... `)
  const proc = Bun.spawnSync(['bunx', 'vite', 'build'], {
    cwd: root,
    env: { ...process.env, TIER: tier },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    console.log('FAILED')
    console.error(proc.stderr.toString())
    throw new Error(`vite build failed for tier ${tier}`)
  }

  const tierDir = join(distDir, tier)
  const html = readFileSync(join(tierDir, 'index.html'), 'utf8')
  const inlined = inlineAssetTags(html)

  // Nothing external may remain: the artifact is served with no sibling files.
  const leftovers = [...inlined.matchAll(/<(?:script[^>]*\ssrc|link[^>]*href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith('data:'))
  if (leftovers.length > 0) failures.push(`${tier}: un-inlined external reference(s): ${leftovers.join(', ')}`)

  const raw = Buffer.byteLength(inlined)
  const gzipped = Bun.gzipSync(Buffer.from(inlined, 'utf8'), { level: 9 })
  const artifact = join(outDir, `Firmware-${cap(tier)}.htm.gz`)
  writeFileSync(artifact, gzipped)

  results.push({ tier, raw, gz: gzipped.byteLength, legacy: legacySize(tier) })
  console.log(`${(raw / 1024).toFixed(1)} KiB raw, ${(gzipped.byteLength / 1024).toFixed(1)} KiB gz`)
}

// ------------------------------------------------------------------- report

const pad = (s: string | number, n: number) => String(s).padStart(n)
console.log('')
console.log('  tier      raw        gzipped    legacy      delta')
console.log('  ' + '-'.repeat(52))
for (const r of results) {
  const delta = r.legacy ? ((r.gz - r.legacy) / r.legacy) * 100 : 0
  const deltaStr = r.legacy ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%` : 'n/a'
  console.log(
    `  ${r.tier.padEnd(8)} ${pad((r.raw / 1024).toFixed(1) + 'K', 9)} ${pad((r.gz / 1024).toFixed(1) + 'K', 11)} ${pad(r.legacy ? (r.legacy / 1024).toFixed(1) + 'K' : 'n/a', 10)} ${deltaStr.padStart(10)}`,
  )
}

// ------------------------------------------------------------------ gating

const small = results.find((r) => r.tier === 'small')!
if (small.gz >= SMALL_LIMIT) {
  failures.push(`Small tier is ${small.gz} B gzipped, over the ${SMALL_LIMIT} B AMT file-storage limit`)
}

for (const r of results) {
  if (r.legacy == null) continue
  if (r.gz > r.legacy * LEGACY_TOLERANCE) {
    const pct = (((r.gz - r.legacy) / r.legacy) * 100).toFixed(1)
    console.warn(`\nWARNING: ${r.tier} is ${pct}% larger gzipped than the legacy artifact.`)
  }
}

// Tier gating. Markers are literals that exist only in a gated module's own code --
// nav labels live in the shared string table and would appear in every tier, so
// they prove nothing.
const GATING: { tier: Tier; forbidden: string[] }[] = [
  {
    tier: 'small',
    forbidden: ['script.mescript', 'ActionEac', 'ACL Entry Added', 'AMT_RemoteAccessPolicyAppliesToMPS'],
  },
  { tier: 'medium', forbidden: ['script.mescript', 'ActionEac'] },
]
for (const { tier, forbidden } of GATING) {
  const artifact = join(outDir, `Firmware-${cap(tier)}.htm.gz`)
  const text = new TextDecoder().decode(Bun.gunzipSync(readFileSync(artifact)))
  for (const needle of forbidden) {
    const count = text.split(needle).length - 1
    if (count > 0) failures.push(`${tier} artifact contains ${count} occurrence(s) of gated string "${needle}"`)
  }
}

if (failures.length > 0) {
  console.error('\nBUILD FAILED:')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log(`\nWrote ${results.length} artifacts to dist/firmware/`)
console.log(`Size gate passed: Small ${small.gz} B < ${SMALL_LIMIT} B`)