/**
 * Feature-set size estimator.
 *
 * Every number comes from a real build: `measureSize` runs
 * `scripts/build-firmware.ts` in single-build mode (`FEATURES`/`THEME`/
 * `BUILD_NAME`/`OUT`) and parses the one `size: <bytes>` line it prints. Gzip
 * size of constant-folded, minified output cannot be derived from module sizes,
 * so nothing here guesses from those.
 *
 * Measurements land in `build/.size-cache.json`, keyed by a hash of (feature
 * set, theme). `refreshMeasurements` fills the mandatory-only baseline plus one
 * entry per visible non-mandatory feature measured as baseline + that feature's
 * whole requires-closure; `estimateSize` adds the marginals of features nothing
 * else in the selection already carries, on top of the baseline.
 *
 * `exact` means "this is a real measurement of this exact set", which only
 * happens when the requested selection has been measured before. Everything
 * else is an estimate: code shared between features still makes the sum drift,
 * it is just no longer inflated by re-counting a dependency for every dependent.
 */
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FEATURES, MANDATORY, VISIBLE_FEATURES, resolveFeatures } from './features'

const root = new URL('..', import.meta.url).pathname

export interface SizeEstimate {
  bytes: number
  exact: boolean
  unmeasured: string[]
}

export interface SizeMeasurement {
  theme: string
  /** Resolved feature ids (sorted) this measurement was built from. */
  features: string[]
  bytes: number
  measuredAt: string
}

export interface SizeCache {
  version: number
  /** Measurement key (see `cacheKey`) -> measurement. */
  entries: Record<string, SizeMeasurement>
}

const CACHE_VERSION = 1

/** Features that gate nothing: they cost no bytes and are never measured. */
const INERT = new Set(FEATURES.filter((f) => f.inert === true).map((f) => f.id))

/** The mandatory-only set every marginal is measured against. */
const BASELINE = resolve(MANDATORY)

/** Measured as baseline + this feature; mandatory ones are already baseline. */
const MARGINAL_FEATURES = VISIBLE_FEATURES.filter((f) => f.mandatory !== true)

export function cachePath(): string {
  return new URL('.size-cache.json', import.meta.url).pathname
}

/** A missing or unreadable cache reads as empty; the next refresh rebuilds it. */
export function loadCache(): SizeCache {
  try {
    const raw = JSON.parse(readFileSync(cachePath(), 'utf8')) as Partial<SizeCache>
    if (raw.version !== CACHE_VERSION || typeof raw.entries !== 'object' || raw.entries == null) {
      return { version: CACHE_VERSION, entries: {} }
    }
    return { version: CACHE_VERSION, entries: raw.entries }
  } catch {
    return { version: CACHE_VERSION, entries: {} }
  }
}

/** Order-insensitive key over (feature set, theme). */
function cacheKey(features: Iterable<string>, theme: string): string {
  return createHash('sha256')
    .update(`${theme}\0${[...features].sort().join(',')}`)
    .digest('hex')
    .slice(0, 16)
}

/** Closed feature set: mandatory core and all `requires` dependencies included. */
function resolve(ids: readonly string[]): string[] {
  // An empty list must mean "mandatory core", not the default tier preset.
  return [...resolveFeatures(ids.length > 0 ? ids.join(',') : MANDATORY.join(','))]
}

/** Ids `id` pulls in through `requires`, transitively, excluding itself. */
function closureOf(id: string): string[] {
  const out: string[] = []
  const stack = [...(FEATURES.find((f) => f.id === id)?.requires ?? [])]
  while (stack.length > 0) {
    const dep = stack.pop()!
    if (out.includes(dep)) continue
    out.push(dep)
    stack.push(...(FEATURES.find((f) => f.id === dep)?.requires ?? []))
  }
  return out
}

export function estimateSize(features: readonly string[], theme: string): SizeEstimate {
  const cache = loadCache()
  const selected = resolve(features)

  // Only a measurement of exactly this set is exact.
  const whole = cache.entries[cacheKey(selected, theme)]
  if (whole != null) return { bytes: whole.bytes, exact: true, unmeasured: [] }

  const base: number | null = cache.entries[cacheKey(BASELINE, theme)]?.bytes ?? null
  const inBaseline = new Set(BASELINE)
  const enabled = selected.filter((id) => !inBaseline.has(id) && !INERT.has(id))

  if (base == null) {
    return { bytes: 0, exact: false, unmeasured: [...BASELINE, ...enabled] }
  }

  /*
   * Each entry is measured as baseline + that feature's whole requires-closure,
   * so a dependency's cost is already inside every dependent's number. Adding
   * the dependency's own entry as well counted it once per dependent, which is
   * what inflated a full selection by ~25%. Sum only the features nothing else
   * in the selection already carries.
   */
  const coveredByDependent = new Set<string>()
  for (const id of enabled) {
    for (const dep of closureOf(id)) {
      if (!inBaseline.has(dep)) coveredByDependent.add(dep)
    }
  }

  const unmeasured: string[] = []
  let bytes = base
  for (const id of enabled) {
    if (coveredByDependent.has(id)) continue
    const entry = cache.entries[cacheKey(resolve([...BASELINE, id]), theme)]
    if (entry == null) unmeasured.push(id)
    else bytes += entry.bytes - base
  }
  return { bytes, exact: false, unmeasured }
}

/**
 * Build the given selection for real and record the artifact size. The build is
 * `scripts/build-firmware.ts` in single-build mode -- nothing is estimated.
 */
export async function measureSize(features: readonly string[], theme: string): Promise<number> {
  const selected = resolve(features)
  const key = cacheKey(selected, theme)
  const buildName = `size-probe-${key.slice(0, 8)}`
  const out = join(tmpdir(), `meshcommander-${buildName}.htm.gz`)

  const proc = Bun.spawnSync(['bun', join(root, 'scripts', 'build-firmware.ts')], {
    cwd: root,
    env: {
      ...process.env,
      FEATURES: selected.join(','),
      THEME: theme,
      BUILD_NAME: buildName,
      OUT: out,
      // Cache keys have no encoding axis: always measure the shipped gzip.
      ENCODING: 'gzip',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = proc.stdout.toString()
  if (proc.exitCode !== 0) {
    throw new Error(`size probe ${buildName} failed (exit ${proc.exitCode}):\n${proc.stderr.toString()}`)
  }
  const match = stdout.match(/^size: (\d+)$/m)
  if (match == null) throw new Error(`size probe ${buildName} printed no "size: <bytes>" line:\n${stdout}`)
  const bytes = Number(match[1])

  rmSync(out, { force: true })
  rmSync(join(root, 'dist', buildName), { recursive: true, force: true })

  const cache = loadCache()
  cache.entries[key] = { theme, features: [...selected].sort(), bytes, measuredAt: new Date().toISOString() }
  writeFileSync(cachePath(), JSON.stringify(cache, null, 2) + '\n')
  return bytes
}

/**
 * Measure `base.features` (the always-on core; mandatory set when the list is
 * empty) as the baseline, then every visible non-mandatory feature as
 * baseline + that feature -- one real build each.
 */
export async function refreshMeasurements(
  base: { features: readonly string[]; theme: string },
  onProgress?: (label: string, done: number, total: number) => void,
): Promise<void> {
  const baseline = resolve(base.features)
  const targets: { label: string; features: string[] }[] = [
    { label: 'baseline', features: baseline },
    ...MARGINAL_FEATURES.map((f) => ({ label: f.id, features: [...baseline, f.id] })),
  ]

  let done = 0
  for (const target of targets) {
    await measureSize(target.features, base.theme)
    onProgress?.(target.label, ++done, targets.length)
  }
}
