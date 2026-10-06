/**
 * On-demand firmware build service.
 *
 * A browser cannot assemble a custom build: feature gating happens in the
 * bundler, so an arbitrary combination needs a real toolchain. This server owns
 * that toolchain -- it shells out to the console's `scripts/build-firmware.ts`
 * exactly the way `estimate.ts` does and answers with the gzipped artifact.
 *
 * Builds are cached on disk by (source revision, theme, feature set), and at
 * most two run at once, so a burst of requests queues instead of spawning
 * unbounded vite processes. The revision is part of the key because a cache
 * that outlives the sources hands out artifacts the console no longer builds.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveFeatures } from '@meshcommander/build-system'
import { resolveTheme } from '@meshcommander/build-system/themes'

const PORT = Number(process.env.PORT ?? 8787)
/** Unset means any origin: this service only compiles, there is no secret here. */
const ORIGIN = process.env.ALLOWED_ORIGIN ?? '*'
const CACHE_DIR = process.env.BUILD_CACHE_DIR ?? join(homedir(), '.cache', 'meshcommander-builds')

/** The console app owns `scripts/build-firmware.ts` and `dist/`, so it is the cwd. */
const CONSOLE_DIR = new URL('../../apps/console/', import.meta.url).pathname

const MAX_FEATURES = 32
const MAX_CONCURRENT = 2

mkdirSync(CACHE_DIR, { recursive: true })

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

/** Last `n` characters, so a failing build reports its stderr without a flood. */
const tail = (s: string, n: number) => (s.length > n ? `...${s.slice(-n)}` : s)

/**
 * Digest of everything that changes what a build produces.
 *
 * Reading the sources once at startup costs milliseconds and buys a cache that
 * cannot serve an artifact from before the last edit -- without it, a build
 * service restarted after a console change keeps answering with the old bytes.
 */
function sourceRevision(): string {
  const hash = createHash('sha256')
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else hash.update(entry.name).update(readFileSync(path))
    }
  }
  for (const dir of ['src', 'scripts', 'build']) walk(join(CONSOLE_DIR, dir))
  for (const file of ['index.html', 'package.json', 'vite.config.ts']) hash.update(readFileSync(join(CONSOLE_DIR, file)))
  walk(new URL('../../packages/build-system/src/', import.meta.url).pathname)
  return hash.digest('hex').slice(0, 12)
}

const REVISION = sourceRevision()

/** Order-insensitive identity of a build: it names the cache file and the build. */
function cacheKey(theme: string, features: readonly string[]): string {
  return createHash('sha256')
    .update(`${REVISION}|${theme}|${[...features].sort().join(',')}`)
    .digest('hex')
}

let active = 0
const waiting: (() => void)[] = []

/** Wait for a build slot; the returned function gives it back. */
async function acquire(): Promise<() => void> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve))
  active++
  return () => {
    active--
    waiting.shift()?.()
  }
}

/**
 * Build `key` into the cache and return the artifact path. The cache file *is*
 * the artifact, so nothing is copied after the build.
 */
async function build(key: string, features: string[], theme: string): Promise<string> {
  const out = join(CACHE_DIR, `${key}.htm.gz`)
  if (existsSync(out)) return out

  const release = await acquire()
  try {
    // Another request may have built the same key while we waited for a slot.
    if (existsSync(out)) return out

    const proc = Bun.spawn(['bun', join(CONSOLE_DIR, 'scripts', 'build-firmware.ts')], {
      cwd: CONSOLE_DIR,
      env: { ...process.env, FEATURES: features.join(','), THEME: theme, BUILD_NAME: key, OUT: out },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    if (code !== 0 || !existsSync(out)) {
      throw new Error(`build failed (exit ${code}):\n${tail(stderr, 4000)}`)
    }
    return out
  } finally {
    release()
  }
}

async function handleBuild(req: Request): Promise<Response> {
  let body: { features?: unknown; theme?: unknown }
  try {
    body = (await req.json()) as { features?: unknown; theme?: unknown }
  } catch {
    return json(400, { error: 'body must be JSON' })
  }

  const features = body.features
  if (!Array.isArray(features)) return json(400, { error: '"features" must be an array' })
  if (features.length > MAX_FEATURES) {
    return json(400, { error: `at most ${MAX_FEATURES} features, got ${features.length}` })
  }

  let selected: string[]
  let theme: string
  try {
    selected = [...resolveFeatures(features.join(','))]
    theme = resolveTheme(typeof body.theme === 'string' ? body.theme : undefined)
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : String(err) })
  }

  const key = cacheKey(theme, selected)
  const name = `${theme}-${selected.length}f-${key.slice(0, 8)}.htm.gz`
  try {
    const out = await build(key, selected, theme)
    return new Response(Bun.file(out), {
      headers: {
        ...CORS,
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${name}"`,
      },
    })
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : String(err) })
  }
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    if (pathname === '/health') {
      if (req.method !== 'GET') return json(405, { error: 'method not allowed' })
      return json(200, { ok: true, cached: readdirSync(CACHE_DIR).length })
    }

    if (pathname === '/build') {
      if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
      return await handleBuild(req)
    }

    return json(404, { error: 'not found' })
  },
})

console.log(`build service listening on http://localhost:${PORT} (cache ${CACHE_DIR})`)
