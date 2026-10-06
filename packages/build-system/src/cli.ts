#!/usr/bin/env bun
/**
 * Build CLI and picker TUI for the single-file console.
 *
 * `apps/console/scripts/build-firmware.ts` does the actual work (one vite build
 * per selection, then inline + zopfli); this file is the user-facing front end:
 * compose a selection, see what it costs, build it, flash it. The root script
 * `cli` is the short way in; `--help` prints the whole interface.
 *
 *   bun run cli                                    # pick features
 *   bun run cli features                           # the manifest
 *   bun run cli themes                             # the theme list
 *   bun run cli build --features Desktop,Terminal,IDER --theme mesh
 *   bun run cli install --host 10.0.0.1 -u admin -p secret --yes
 *   bun run cli measure                            # refresh the size table
 *
 * Sizes come from `./estimate.ts`: an estimate is free and instant, a real
 * measurement runs the compiler. The TUI always says which one it is showing.
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_TIER,
  FEATURES,
  MANDATORY,
  TIERS,
  USER_FLASH_LIMIT,
  featuresByGroup,
  resolveFeatures,
} from './features'
import type { FeatureDef } from './features'
import { DEFAULT_THEME, THEMES, resolveTheme } from './themes'
import { cachePath, estimateSize, measureSize, refreshMeasurements } from './estimate'
import type { SizeEstimate } from './estimate'

/**
 * The console app owns `scripts/`, `dist/` and the size cache; this package is
 * just the front end, so every child process runs from the console directory.
 */
const ROOT = fileURLToPath(new URL('../../../apps/console/', import.meta.url))

const COLOR = process.stdout.isTTY === true && process.env.NO_COLOR == null
const paint = (code: string, s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = (s: string) => paint('2', s)
const bold = (s: string) => paint('1', s)

const ORDER: Record<string, number> = Object.fromEntries(FEATURES.map((f, i) => [f.id, i]))
const DEF: Record<string, FeatureDef | undefined> = Object.fromEntries(FEATURES.map((f) => [f.id, f]))
/** Display groups; iteration order is manifest order and skips inert flags. */
const GROUPS = [...featuresByGroup()]
const ROWS = GROUPS.flatMap(([, defs]) => defs)

// Manifest order, so selections, CLI output and the TUI never reshuffle.
const sortIds = (ids: Iterable<string>) => [...ids].sort((a, b) => ORDER[a] - ORDER[b])

/** Ids pulled in by `requires`, plus the mandatory core. */
function closure(seed: Iterable<string>): Set<string> {
  const out = new Set<string>()
  const queue = [...seed, ...MANDATORY]
  while (queue.length > 0) {
    const id = queue.pop()!
    if (out.has(id)) continue
    out.add(id)
    for (const dep of DEF[id]?.requires ?? []) queue.push(dep)
  }
  return out
}

const bytes = (n: number) => `${n.toLocaleString('en-US')} B`
const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`
// Artifacts and paths are relative to the package root, not the shell's cwd.
const rel = (p: string) => (p.startsWith(ROOT) ? relative(ROOT, p) : p)

/** Cut a painted line to `width` visible columns, escapes kept intact. */
function clamp(line: string, width: number): string {
  let visible = 0
  let out = ''
  for (let i = 0; i < line.length; ) {
    if (line[i] === '\x1b') {
      const end = line.indexOf('m', i)
      if (end < 0) break
      out += line.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (visible >= width) break
    out += line[i]
    visible++
    i++
  }
  return out
}

// ------------------------------------------------------------------ args

interface Args {
  command: string
  features?: string
  theme?: string
  tier?: string
  name?: string
  out?: string
  host?: string
  user?: string
  pass?: string
  tls: boolean
  yes: boolean
}

const COMMANDS = ['ui', 'build', 'install', 'measure', 'features', 'themes'] as const

/** Args fields that take a string value (as opposed to booleans). */
type ValueField = 'features' | 'theme' | 'tier' | 'name' | 'out' | 'host' | 'user' | 'pass'

const VALUE_FLAGS: Record<string, ValueField> = {
  '--features': 'features',
  '--theme': 'theme',
  '--tier': 'tier',
  '--name': 'name',
  '--out': 'out',
  '--host': 'host',
  '--user': 'user',
  '-u': 'user',
  '--pass': 'pass',
  '-p': 'pass',
}

const BOOL_FLAGS: Record<string, 'tls' | 'yes'> = { '--tls': 'tls', '--yes': 'yes' }

const USAGE = `usage: bun run cli <command> [options]

commands
  ui                       pick features in a terminal (the default there)
  build                    build one artifact for a selection
  install                  flash an artifact into the device; builds it first
                           unless --name or --out already point at one
  features                 list the feature ids --features accepts
  themes                   list the theme ids --theme accepts
  measure                  re-measure the size table with real builds (slow;
                           one build per feature, every theme unless --theme)

selection
  --features <a,b,c>       exact feature ids, e.g. --features Desktop,Terminal,IDER
  --tier <${Object.keys(TIERS).join('|')}>   preset shorthand (default ${DEFAULT_TIER}); ignored when --features is given

output
  --theme <id>             theme baked in (default ${DEFAULT_THEME})
  --name <name>            artifact name -> dist/firmware/<name>.htm.gz
  --out <path>             write the artifact here instead

device (install)
  --host <host>            AMT address, no port (default localhost; --tls picks
                           :16993 instead of :16992)
  -u, --user <user>        AMT user (default admin)
  -p, --pass <pass>        AMT password
  --tls                    use https instead of http
  --yes                    do not ask for confirmation

examples
  bun run cli                                                  pick features
  bun run cli build --tier small
  bun run cli build --features Desktop,Terminal,IDER --theme midnight
  bun run cli install --host 10.0.0.1 -u admin -p secret --name small

Artifacts land in apps/console/dist/firmware/. Sizes are gzipped bytes, and AMT
gives a console 65,536 B of user flash -- that is the limit the small tier is
measured against. \`bun run cli features\` shows what can be turned on.`

function parseArgs(argv: string[]): Args {
  /*
   * The picker is the default on a terminal, because it can ask about anything
   * the arguments left out. Without a terminal there is nothing to ask and no
   * keys to read, so a bare invocation builds instead -- otherwise `bun run
   * build --features X` piped into a script would print a selection and exit
   * without producing an artifact.
   */
  const a: Args = { command: process.stdin.isTTY === true ? 'ui' : 'build', tls: false, yes: false }
  const bare: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-?' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = eq > 0 ? arg.slice(0, eq) : arg
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined

    const bool = BOOL_FLAGS[flag]
    if (bool != null) {
      if (inline != null) throw new Error(`${flag} takes no value`)
      a[bool] = true
      continue
    }
    const key = VALUE_FLAGS[flag]
    if (key == null) {
      if (arg.startsWith('-') && arg !== '-') throw new Error(`unknown option ${arg}`)
      bare.push(arg)
      continue
    }
    const value = inline ?? argv[++i]
    if (value == null) throw new Error(`${flag} needs a value`)
    a[key] = value
  }
  if (bare.length > 1) throw new Error(`unexpected argument "${bare[1]}"`)
  if (bare.length === 1) {
    const cmd = bare[0]
    if (!(COMMANDS as readonly string[]).includes(cmd)) {
      throw new Error(`unknown command "${cmd}", expected one of ${COMMANDS.join(', ')}`)
    }
    a.command = cmd
  }
  return a
}

/** The selection a command should act on, resolved and in manifest order. */
function selectIds(a: Args): string[] {
  const explicit = a.features?.trim() ?? ''
  const set = explicit === ''
    ? resolveFeatures(undefined, a.tier ?? DEFAULT_TIER)
    : resolveFeatures(explicit)
  return sortIds(set)
}

/** Build name: `--name`, else a slug that names the recipe instead of a date. */
function buildName(a: Args, ids: readonly string[], theme: string): string {
  if (a.name != null && a.name.trim() !== '') return a.name.trim()
  const slug = theme.replace(/[^a-z0-9._-]+/gi, '-')
  const hash = new Bun.CryptoHasher('sha256').update(ids.join(',')).digest('hex').slice(0, 6)
  return `${slug}-${ids.length}f-${hash}`
}

// ------------------------------------------------------- firmware pipeline

interface Built {
  artifact: string
  bytes: number
}

/**
 * Reject an output path before spawning anything.
 *
 * Without this a bad `--out` surfaced as a stack trace from inside the WASM
 * compressor with its entire minified source dumped to the terminal, and the
 * actual cause (a directory, a missing parent, no permission) was unreadable.
 */
function checkOutPath(raw: string): string | null {
  const abs = resolve(process.cwd(), raw)
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    return `${rel(abs)} is a directory; --out wants a file path`
  }
  const dir = dirname(abs)
  if (!existsSync(dir)) return `directory ${rel(dir)} does not exist`
  try {
    accessSync(dir, constants.W_OK)
  } catch {
    return `cannot write into ${rel(dir)} (permission denied)`
  }
  return null
}

/**
 * One custom build: `FEATURES` is absolute, `TIER` only names the preset for
 * logging, `OUT` pins the artifact path. build-firmware reports the gzipped
 * size as a machine-readable `size: <bytes>` line.
 */
async function firmwareBuild(a: Args, ids: string[], theme: string, name: string): Promise<Built | null> {
  const out = a.out != null && a.out.trim() !== '' ? resolve(process.cwd(), a.out.trim()) : null
  if (out != null) {
    const problem = checkOutPath(out)
    if (problem != null) {
      console.error(`${bold('build')}  ${problem}`)
      return null
    }
  }
  const artifact = out ?? join(ROOT, 'dist', 'firmware', `${name}.htm.gz`)
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FEATURES: ids.join(','),
    TIER: a.tier ?? DEFAULT_TIER,
    THEME: theme,
    BUILD_NAME: name,
  }
  if (out != null) env.OUT = out
  if (process.env.ENCODING == null) env.ENCODING = artifact.endsWith('.br') ? 'br' : 'gzip'

  console.log(`${bold('build')}  ${ids.length} features, theme ${theme} -> ${rel(artifact)}`)
  const proc = Bun.spawn(['bun', 'scripts/build-firmware.ts'], {
    cwd: ROOT,
    env,
    stdout: 'pipe',
    // Captured, not inherited: on a failure the child can print a stack trace
    // through the WASM compressor, including one enormous line of its own
    // source. Streaming that hides the actual error.
    stderr: 'pipe',
  })

  let text = ''
  let line = ''
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    text += chunk
    line += chunk
    const lines = line.split('\n')
    line = lines.pop()!
    for (const l of lines) process.stdout.write('  ' + l + '\n')
  }
  if (line !== '') process.stdout.write('  ' + line + '\n')
  const code = await proc.exited
  const err = await new Response(proc.stderr).text()

  let size: number | null = null
  for (const m of text.matchAll(/^size:\s*(\d+)\s*$/gm)) size = Number(m[1])

  if (code !== 0) {
    console.error(`build failed (exit ${code})`)
    // The cause is at the end, and a stack frame can be thousands of columns
    // wide, so trim each line before showing the last few.
    const tail = err.split('\n').map((l) => (l.length > 160 ? l.slice(0, 160) + '…' : l)).filter((l) => l.trim() !== '')
    for (const l of tail.slice(-6)) console.error(`  ${l}`)
    return null
  }
  if (size == null) {
    console.error('build-firmware.ts did not report a `size: <bytes>` line; cannot confirm the artifact')
    return null
  }
  if (!existsSync(artifact)) {
    console.error(`build reported ${bytes(size)} but ${rel(artifact)} does not exist`)
    return null
  }
  return { artifact, bytes: size }
}

/** Shell out to the AMT loader with the upload arguments the user gave. */
async function amtUpload(a: Args, artifact: string): Promise<number> {
  // The loader now ships in this package, so it is addressed absolutely rather
  // than as a path relative to the console.
  const loader = fileURLToPath(new URL('./amt-loader.ts', import.meta.url))
  const argv = ['bun', loader, 'upload', '--file', artifact]
  if (a.host != null) argv.push('--host', a.host)
  if (a.user != null) argv.push('--user', a.user)
  if (a.pass != null) argv.push('--pass', a.pass)
  if (a.tls) argv.push('--tls')
  if (a.yes) argv.push('--yes')
  console.log(`${bold('install')}  ${rel(artifact)} -> ${a.host ?? 'localhost'}`)
  const proc = Bun.spawn(argv, { cwd: ROOT, stdio: ['inherit', 'inherit', 'inherit'] })
  return await proc.exited
}

// --------------------------------------------------------------- commands

function cmdFeatures(): void {
  for (const [group, defs] of GROUPS) {
    console.log(bold(group))
    for (const f of defs) {
      const tags = [
        f.mandatory === true ? 'mandatory' : '',
        f.requires != null && f.requires.length > 0 ? `requires ${f.requires.join(', ')}` : '',
      ].filter((t) => t !== '')
      console.log(`  ${f.id.padEnd(26)} ${f.label.padEnd(22)}${tags.length > 0 ? dim(tags.join(' · ')) : ''}`)
      if (f.description != null) console.log(`  ${' '.repeat(26)} ${dim(f.description)}`)
    }
    console.log('')
  }
  const inert = FEATURES.filter((f) => f.inert === true)
  console.log(bold('Edition (legacy flags, gate nothing, hidden from pickers)'))
  for (const f of inert) console.log(`  ${f.id.padEnd(26)} ${f.label.padEnd(22)}${f.description != null ? dim(f.description) : ''}`)
  console.log('')
  console.log(`${FEATURES.length} features, ${MANDATORY.length} mandatory. Tiers:`)
  for (const [tier, ids] of Object.entries(TIERS)) {
    console.log(`  ${tier.padEnd(8)} ${String(ids.length).padStart(2)} features${tier === DEFAULT_TIER ? dim('  (default)') : ''}`)
  }
}

function cmdThemes(): void {
  for (const t of THEMES) {
    console.log(`  ${t.id.padEnd(14)} ${t.label.padEnd(18)}${t.description != null ? dim(t.description) : ''}${t.id === DEFAULT_THEME ? dim('  (default)') : ''}`)
  }
}

async function cmdMeasure(a: Args): Promise<number> {
  const ids = selectIds(a)
  const theme = resolveTheme(a.theme)
  const tty = process.stdout.isTTY === true
  /*
   * Every theme by default. A theme is a CSS file, so its sizes differ, and the
   * promo site shows the numbers for *whichever* theme is selected -- measuring
   * one theme and shipping that table leaves three quarters of the picker
   * falling back to another palette's figures. `--theme` still narrows it.
   */
  const themes = a.theme != null && a.theme.trim() !== '' ? [theme] : THEMES.map((t) => t.id)
  // The cache is a shared marginal table: core baseline plus every feature on
  // top of it, so one refresh makes `estimateSize` exact for any selection.
  console.log(
    `${bold('measure')}  baseline ${MANDATORY.length} core features, +${ROWS.length - MANDATORY.length} marginals, ` +
      `themes ${themes.join(', ')}`,
  )
  for (const t of themes) {
    await refreshMeasurements({ features: MANDATORY, theme: t }, (label, done, total) => {
      const line = `  ${t} [${done}/${total}] ${label}`
      if (tty) process.stdout.write(`\r\x1b[K${line}`)
      else process.stdout.write(line + '\n')
    })
    if (tty) process.stdout.write('\r\x1b[K')
  }
  const est = estimateSize(ids, theme)
  console.log(`selection  ${ids.length} features, ${bytes(est.bytes)}  ${est.exact ? paint('32', 'MEASURED') : paint('33', 'ESTIMATE')}`)
  if (est.unmeasured.length > 0) console.log(`unmeasured ${est.unmeasured.join(', ')}`)
  console.log(`cache      ${cachePath()}`)
  return 0
}

async function cmdBuild(a: Args): Promise<number> {
  const ids = selectIds(a)
  const theme = resolveTheme(a.theme)
  const name = buildName(a, ids, theme)
  const built = await firmwareBuild(a, ids, theme, name)
  if (built == null) return 1
  console.log(`artifact ${rel(built.artifact)}  ${bytes(built.bytes)} (${kb(built.bytes)})`)
  /*
   * A custom selection is not the small preset, so nothing else here checks it
   * against the device's budget -- and a console that does not fit is a console
   * the device will not serve.
   */
  if (built.bytes >= USER_FLASH_LIMIT) {
    console.log(
      `over      ${bytes(USER_FLASH_LIMIT)} is all AMT gives a console; this artifact will not fit`,
    )
  }
  console.log(`next      bun run cli install --host <device> --name ${name}`)
  return 0
}

/**
 * Sequential prompt for values the command line did not supply.
 *
 * Arguments are taken as given; anything missing is asked for on a terminal, and
 * a scripted run never blocks on stdin (off a terminal the value falls through
 * unchanged and the loader reports what it needs).
 *
 * Lines are queued rather than requested one at a time: `readline.question()`
 * drops anything already buffered when the next question is issued, so typing
 * three answers ahead -- or pasting them -- stalled after the second prompt.
 */
class Prompts {
  private rl: ReturnType<typeof createInterface>
  private waiting: ((line: string) => void) | null = null
  private buffered: string[] = []

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout })
    this.rl.on('line', (line) => {
      const w = this.waiting
      if (w != null) {
        this.waiting = null
        w(line)
      } else {
        this.buffered.push(line)
      }
    })
  }

  ask(label: string, given: string | undefined, def?: string): Promise<string | undefined> {
    if (given != null && given.trim() !== '') return Promise.resolve(given)
    if (process.stdin.isTTY !== true) return Promise.resolve(given)
    const suffix = def != null ? ` (${def})` : ''
    process.stdout.write(`  ${label}${suffix}: `)
    const { promise, resolve } = Promise.withResolvers<string | undefined>()
    const take = (line: string) => {
      const v = line.trim()
      resolve(v !== '' ? v : def)
    }
    const next = this.buffered.shift()
    if (next != null) {
      process.stdout.write(`${next}\n`)
      take(next)
    } else {
      this.waiting = take
    }
    return promise
  }

  close(): void {
    this.rl.close()
  }
}

async function cmdInstall(a: Args): Promise<number> {
  let artifact: string
  const explicitOut = a.out != null && a.out.trim() !== '' ? resolve(process.cwd(), a.out.trim()) : null
  /*
   * `--name` is how `build` reports its artifact, so flashing it back should
   * flash that artifact: rebuilding the same name first would silently discard
   * what the user just built (and picked features for).
   */
  const named = a.name != null && a.name.trim() !== '' ? join(ROOT, 'dist', 'firmware', `${a.name.trim()}.htm.gz`) : null
  const reuse = explicitOut != null && existsSync(explicitOut) ? explicitOut : explicitOut == null && named != null && existsSync(named) ? named : null
  if (reuse != null) {
    artifact = reuse
    console.log(`${bold('install')}  reusing ${rel(artifact)}`)
  } else {
    const ids = selectIds(a)
    const theme = resolveTheme(a.theme)
    const built = await firmwareBuild(a, ids, theme, buildName(a, ids, theme))
    if (built == null) return 1
    artifact = built.artifact
    console.log(`artifact ${rel(artifact)}  ${bytes(built.bytes)} (${kb(built.bytes)})`)
  }

  // Installing to "localhost" with an empty password can only fail, so ask
  // rather than guess.
  const needed = a.host == null || a.user == null || a.pass == null
  if (needed && process.stdin.isTTY === true) console.log(bold('target AMT device'))
  const prompts = needed && process.stdin.isTTY === true ? new Prompts() : null
  try {
    if (prompts != null) {
      a.host = await prompts.ask('AMT address', a.host, 'localhost')
      a.user = await prompts.ask('username', a.user, 'admin')
      a.pass = await prompts.ask('password', a.pass)
    }
  } finally {
    prompts?.close()
  }
  if (a.pass == null || a.pass === '') {
    console.error(`${bold('install')}  a password is required; pass --pass or run on a terminal`)
    return 1
  }
  return await amtUpload(a, artifact)
}

// --------------------------------------------------------------------- ui

/** Raw single-keystroke reader: arrow keys, space, ctrl-c and plain letters. */
async function* readKeys(): AsyncGenerator<string> {
  process.stdin.setRawMode?.(true)
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true })
    while (buf.length > 0) {
      const ch = buf[0]
      if (ch === '\x1b') {
        // Arrows arrive as a 3-byte CSI sequence; wait for the tail if split.
        if (buf.length < 3) break
        const seq = buf.slice(0, 3)
        buf = buf.slice(3)
        yield seq === '\x1b[A' ? 'up' : seq === '\x1b[B' ? 'down' : 'other'
        continue
      }
      buf = buf.slice(1)
      if (ch === '\x03' || ch === '\x04') yield 'quit'
      else if (ch === ' ' || ch === '\r' || ch === '\n') yield 'toggle'
      else yield ch
    }
  }
}

async function cmdUi(a: Args): Promise<number> {
  let theme = resolveTheme(a.theme)
  // User choices only; dependencies and the mandatory core are derived.
  const on = new Set(selectIds(a).filter((id) => !MANDATORY.includes(id)))
  const ids = () => sortIds(closure(on))

  let cursor = 0
  let status = ''
  let measured: number | null = null
  let est: SizeEstimate = estimateSize(ids(), theme)

  const costs = new Map<string, number | null>()
  /** Individual cost: this feature (plus what it drags in) over the core. */
  const costOf = (id: string): number | null => {
    const key = `${theme}:${id}`
    if (!costs.has(key)) {
      const own = estimateSize(sortIds(closure([id])), theme)
      const base = estimateSize(MANDATORY, theme)
      // Marginals only exist once the shared table has been measured.
      const value = own.unmeasured.length > 0 || base.unmeasured.length > 0 ? null : own.bytes - base.bytes
      costs.set(key, value)
    }
    return costs.get(key)!
  }

  const refresh = () => {
    est = estimateSize(ids(), theme)
    measured = null
  }

  const toggle = (id: string) => {
    if (MANDATORY.includes(id)) {
      status = `${id} is mandatory`
      return
    }
    if (on.has(id)) {
      on.delete(id)
      // Anything that would pull it straight back in goes off with it.
      for (const other of [...on]) if (closure([other]).has(id)) on.delete(other)
      status = `- ${id}`
    } else {
      on.add(id)
      status = `+ ${id}`
    }
    refresh()
  }

  /** First body line currently shown; the feature list scrolls, nothing else. */
  let scroll = 0

  const frame = (): string => {
    const width = process.stdout.columns ?? 100
    const rows = process.stdout.rows ?? 40
    const live = ids()

    const head: string[] = []
    head.push(bold('MeshCommander build picker') + dim(`   theme ${theme} (t)   ${a.tier != null ? `tier ${a.tier}` : 'custom'}   ${live.length} features`))
    head.push(
      measured != null
        ? `${dim('total')} ${paint('32', `${bytes(measured)}  measured`)}`
        : est.bytes === 0 && est.unmeasured.length > 0
          ? `${dim('total')} ${paint('33', 'unknown  (cache cold, nothing measured yet)')}`
          : `${dim('total')} ${paint('33', `~${bytes(est.bytes)}  estimate`)}${est.exact ? dim(' (measured whole)') : est.unmeasured.length > 0 ? dim(` (${est.unmeasured.length} unmeasured)`) : dim(' (all parts measured)')}`,
    )
    head.push(dim('space toggle · ↑↓ move · t theme · m measure · b build · i install · q quit'))
    head.push('')

    /*
     * The body is taller than most terminals, so it scrolls: build every line,
     * note where the cursor sits, then show a window around it. Group headings
     * scroll with their features on purpose -- a heading pinned to the top of a
     * window it does not belong to reads as a lie.
     */
    const body: string[] = []
    let cursorLine = 0
    for (const [group, defs] of GROUPS) {
      body.push(bold(group))
      for (const f of defs) {
        const cur = ROWS[cursor]?.id === f.id
        if (cur) cursorLine = body.length
        const locked = MANDATORY.includes(f.id)
        const enabled = locked || live.includes(f.id)
        const cost = costOf(f.id)
        const prefix = `${cur ? '>' : ' '} [${locked ? '•' : enabled ? 'x' : ' '}] ${f.label.padEnd(26)}`
        /*
         * A marginal can come out negative or zero: it is the difference between
         * two independent builds, so gzip variance and a stale cache can put it
         * below the baseline. Rendering that as `+-0.1 KiB` was the bug.
         * `core` is reserved for the locked features; an optional feature that
         * happens to measure as free reads `~0` instead.
         */
        const price = (
          cost == null ? '?'
            : locked ? 'core'
              : Math.abs(cost) < 64 ? '~0'
                : `${cost > 0 ? '+' : '-'}${kb(Math.abs(cost))}`
        ).padStart(10)
        const plain = `${prefix}${price}  ${f.id}  ${f.description ?? ''}`
        body.push(cur ? paint('1;36', prefix) + dim(plain.slice(prefix.length)) : plain)
      }
      body.push('')
    }

    const foot: string[] = ['', status === '' ? dim('ready') : paint('36', status)]

    // Two rows are always reserved for the scroll hints so the window size does
    // not change as they appear and disappear, which would make it jitter.
    const viewH = Math.max(3, rows - head.length - foot.length - 2)
    if (cursorLine < scroll) scroll = cursorLine
    if (cursorLine >= scroll + viewH) scroll = cursorLine - viewH + 1
    scroll = Math.max(0, Math.min(scroll, Math.max(0, body.length - viewH)))

    const above = scroll
    const below = Math.max(0, body.length - (scroll + viewH))
    const lines = [
      ...head,
      above > 0 ? dim(`  ↑ ${above} more`) : '',
      ...body.slice(scroll, scroll + viewH),
      below > 0 ? dim(`  ↓ ${below} more`) : '',
      ...foot,
    ]
    return lines.map((l) => (l.length > width ? clamp(l, width) : l)).join('\n')
  }

  const draw = () => process.stdout.write(`\x1b[H\x1b[2J${frame()}`)

  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    // No keys to read: report the selection instead of hanging on stdin.
    console.log(`${bold('selection')}  theme ${theme}, ${ids().length} features`)
    console.log(ids().join(','))
    console.log(
      measured != null
        ? `total ${bytes(measured)} measured`
        : est.bytes === 0 && est.unmeasured.length > 0
          ? 'total unknown (cache cold, nothing measured yet)'
          : `total ~${bytes(est.bytes)} estimate${est.exact ? ' (measured whole)' : est.unmeasured.length > 0 ? ` (${est.unmeasured.length} unmeasured)` : ' (all parts measured)'}`,
    )
    return 0
  }

  const suspend = async <T>(fn: () => Promise<T>): Promise<T> => {
    process.stdin.setRawMode?.(false)
    process.stdout.write('\x1b[?25h\x1b[?1049l')
    try {
      return await fn()
    } finally {
      process.stdin.setRawMode?.(true)
      process.stdout.write('\x1b[?1049h\x1b[?25l')
    }
  }

  process.stdout.write('\x1b[?1049h\x1b[?25l')
  // A resize changes how much of the list fits; redraw now rather than waiting
  // for the next keypress. `on` is optional because not every runtime emits
  // 'resize' on stdout -- without it the viewport still adapts on the next key.
  const onResize = () => draw()
  process.stdout.on?.('resize', onResize)
  try {
    draw()
    for await (const key of readKeys()) {
      const row = ROWS[cursor]
      switch (key) {
        case 'up':
        case 'k':
          cursor = (cursor - 1 + ROWS.length) % ROWS.length
          break
        case 'down':
        case 'j':
          cursor = (cursor + 1) % ROWS.length
          break
        case 'toggle':
          if (row != null) toggle(row.id)
          break
        case 't': {
          const i = THEMES.findIndex((t) => t.id === theme)
          theme = THEMES[(i + 1) % THEMES.length].id
          status = `theme ${theme}`
          refresh()
          break
        }
        case 'm': {
          status = 'measuring … (running the real compiler)'
          draw()
          const want = ids()
          try {
            measured = await measureSize(want, theme)
            est = estimateSize(want, theme)
            status = `measured ${bytes(measured)}`
          } catch (e) {
            measured = null
            status = `measurement failed: ${(e as Error).message.split('\n')[0]}`
          }
          break
        }
        case 'b': {
          const name = buildName(a, ids(), theme)
          const built = await suspend(() => firmwareBuild(a, ids(), theme, name))
          status = built == null ? 'build failed' : `built ${rel(built.artifact)}  ${bytes(built.bytes)} (${kb(built.bytes)})`
          break
        }
        case 'i': {
          const built = await suspend(async () => {
            const name = buildName(a, ids(), theme)
            const artifact = a.out != null && a.out.trim() !== '' && existsSync(resolve(process.cwd(), a.out.trim()))
              ? resolve(process.cwd(), a.out.trim())
              : (await firmwareBuild(a, ids(), theme, name))?.artifact
            if (artifact == null) return 1
            return await amtUpload(a, artifact)
          })
          status = built === 0 ? 'install finished' : `install failed (exit ${built})`
          break
        }
        case 'q':
        case 'Q':
          return 0
      }
      draw()
    }
  } finally {
    process.stdout.off?.('resize', onResize)
    process.stdout.write('\x1b[?25h\x1b[?1049l')
    process.stdin.setRawMode?.(false)
  }
  return 0
}

// ------------------------------------------------------------------- main

async function main(): Promise<number> {
  let a: Args
  try {
    a = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    console.error(USAGE)
    return 2
  }
  try {
    switch (a.command) {
      case 'features':
        cmdFeatures()
        return 0
      case 'themes':
        cmdThemes()
        return 0
      case 'build':
        return await cmdBuild(a)
      case 'install':
        return await cmdInstall(a)
      case 'measure':
        return await cmdMeasure(a)
      default:
        return await cmdUi(a)
    }
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    return 1
  }
}

process.exitCode = await main()
