/**
 * Intel(R) AMT console loader.
 *
 * Installs a gzipped single-file console into the device's user-flash storage
 * and removes it again. This is the modern equivalent of the 2016-era
 * `MeshCommanderFirmware-*.exe` WinForms loader, reimplemented against the same
 * AMT user-flash HTTP API.
 *
 * The wire protocol (verified against AMT 11.8.50):
 *   GET    /amt-storage/                -> JSON listing { information, content }
 *   GET    /amt-storage/<path>          -> stored bytes, served as Content-Encoding: gzip
 *   PUT    /amt-storage/<path>[?append=1] -> <metadata>…<link>base64</link></metadata>
 *   DELETE /amt-storage/<path>
 *
 * The body is AMT's metadata envelope: the file is base64 inside a <link>
 * element, and the <headers> block records the Content-Encoding/Content-Type AMT
 * should serve it back with.
 *
 *   bun scripts/amt-loader.ts                       # interactive wizard
 *   bun scripts/amt-loader.ts check -h 192.168.1.10
 *   bun scripts/amt-loader.ts upload -h … -u … -p … dist/firmware/Firmware-Large.htm.gz
 */
import { existsSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { join } from 'node:path'
import { hexMd5 } from '../src/lib/md5'

// ------------------------------------------------------------------ constants

const HTTP_PORT = 16992
const HTTPS_PORT = 16993
const DEFAULT_ENTRY = 'index.htm'
/** Default install path: AMT serves index.htm straight out of user flash. */
const DEFAULT_PATH = DEFAULT_ENTRY
/** Filenames AMT will actually serve as the console. */
const CONSOLE_NAMES = ['index.htm', 'logon.htm']

type Level = 'info' | 'ok' | 'warn' | 'err' | 'dim'

const C = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[34m',
  cyan: '[36m',
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: string, s: string) => (useColor ? code + s + C.reset : s)

function say(msg = '', level: Level = 'info') {
  const map: Record<Level, string> = {
    info: C.reset,
    ok: C.green,
    warn: C.yellow,
    err: C.red,
    dim: C.dim,
  }
  console.log(paint(map[level], msg))
}

const step = (m: string) => say(`  ${m}`, 'dim')
const good = (m: string) => say(`  ${paint(C.green, '✓')} ${m}`, 'ok')
const bad = (m: string) => say(`  ${paint(C.red, '✗')} ${m}`, 'err')
const warn = (m: string) => say(`  ${paint(C.yellow, '!')} ${m}`, 'warn')

function banner(title: string, sub?: string) {
  const w = Math.max(title.length, sub?.length ?? 0) + 4
  const bar = paint(C.cyan, '─'.repeat(w))
  console.log(bar)
  console.log(`  ${paint(C.bold, title)}`)
  if (sub) console.log(`  ${paint(C.dim, sub)}`)
  console.log(bar)
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(2)} MiB`
}

/** Indented key/value listing used for the summary blocks. */
function field(k: string, v: string, level: Level = 'info') {
  const pad = k.padEnd(22, ' ')
  say(`  ${paint(C.dim, pad)} ${v}`, level)
}

// ------------------------------------------------------------------- digest

interface DigestChallenge {
  realm: string
  nonce: string
  qop?: string
  opaque?: string
  algorithm?: string
}

/** Parse a `WWW-Authenticate: Digest …` header into its fields. */
function parseChallenge(header: string): DigestChallenge | null {
  if (!/^digest/i.test(header.trim())) return null
  const body = header.trim().replace(/^digest\s+/i, '')
  const get = (key: string) => body.match(new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|([^,]+))`, 'i'))
  const realm = get('realm')
  const nonce = get('nonce')
  if (!realm || !nonce) return null
  const qop = get('qop')
  const opaque = get('opaque')
  const algorithm = get('algorithm')
  return {
    realm: realm[1] ?? realm[2]?.trim() ?? '',
    nonce: nonce[1] ?? nonce[2]?.trim() ?? '',
    qop: qop ? (qop[1] ?? qop[2]?.trim()) : undefined,
    opaque: opaque ? (opaque[1] ?? opaque[2]?.trim()) : undefined,
    algorithm: algorithm ? (algorithm[1] ?? algorithm[2]?.trim()) : undefined,
  }
}

function md5hex(s: string): string {
  return hexMd5(s)
}

interface Creds {
  host: string
  user: string
  pass: string
  tls: boolean
}

/**
 * Minimal HTTP digest client. AMT's console endpoints are digest-protected and
 * `fetch` has no built-in digest support, so we answer the challenge ourselves.
 *
 * Credentials are folded in as ISO-8859-1 per RFC 2617; hexMd5 encodes UTF-8,
 * which differs only for non-ASCII passwords.
 */
/** Backoff between transport retries. */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/** AMT intermittently drops the socket on :16992 while answering storage calls. */
const MAX_TRANSPORT_RETRIES = 3

/** Build the Authorization header for a digest challenge. */
function digestHeader(
  challenge: DigestChallenge,
  creds: Creds,
  method: string,
  uri: string,
): string {
  const { realm, nonce, qop, opaque, algorithm } = challenge
  if (algorithm && !/^md5$/i.test(algorithm)) {
    throw new Error(`unsupported digest algorithm: ${algorithm}`)
  }
  const ha1 = md5hex(`${creds.user}:${realm}:${creds.pass}`)
  const ha2 = md5hex(`${method}:${uri}`)

  const parts = [
    `username="${creds.user}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
  ]
  let response: string
  if (qop) {
    const nc = '00000001'
    const cnonce = Math.random().toString(16).slice(2, 18).padEnd(16, '0')
    response = md5hex(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
    parts.push(`qop=auth`, `nc=${nc}`, `cnonce="${cnonce}"`)
  } else {
    response = md5hex(`${ha1}:${nonce}:${ha2}`)
  }
  parts.push(`response="${response}"`)
  if (opaque) parts.push(`opaque="${opaque}"`)
  return `Digest ${parts.join(', ')}`
}

/**
 * Minimal HTTP digest client. AMT's console endpoints are digest-protected and
 * `fetch` has no built-in digest support, so we answer the challenge ourselves.
 *
 * Credentials are folded in as ISO-8859-1 per RFC 2617; hexMd5 encodes UTF-8,
 * which differs only for non-ASCII passwords.

 * Auth and transport retries are counted separately on purpose: sharing one
 * counter means a single dropped socket makes every later challenge unanswered
 * and the call fails with a bare 401.
 */
async function amtFetch(creds: Creds, path: string, init: RequestInit = {}): Promise<Response> {
  const scheme = creds.tls ? 'https' : 'http'
  const port = creds.tls ? HTTPS_PORT : HTTP_PORT
  const url = `${scheme}://${creds.host}:${port}${path}`
  const uri = path.split('?')[0]
  const method = (init.method ?? 'GET').toUpperCase()

  for (let tryNo = 0; ; tryNo++) {
    let res: Response
    try {
      res = await fetch(url, init as RequestInit)
    } catch (e) {
      if (tryNo >= MAX_TRANSPORT_RETRIES) throw e
      await sleep(250 * (tryNo + 1))
      continue
    }

    if (res.status !== 401) return res
    const challenge = parseChallenge(res.headers.get('www-authenticate') ?? '')
    if (!challenge) return res

    const headers = new Headers(init.headers ?? {})
    headers.set('Authorization', digestHeader(challenge, creds, method, uri))
    try {
      return await fetch(url, { ...init, headers })
    } catch (e) {
      if (tryNo >= MAX_TRANSPORT_RETRIES) throw e
      await sleep(250 * (tryNo + 1))
    }
  }
}

// -------------------------------------------------------------- storage API

interface StorageEntry {
  size: number
  link: string
}
interface StorageListing {
  /** AMT nests the device facts here; `realms` is the free user-flash budget. */
  information?: { version?: number; realms?: number; user?: string }
  content: Record<string, StorageEntry>
}

async function listStorage(creds: Creds): Promise<{ listing: StorageListing; server: string }> {
  const res = await amtFetch(creds, '/amt-storage/')
  const server = (res.headers.get('server') ?? '').replace('Intel(R) Active Management Technology ', 'AMT ')
  if (!res.ok) throw new Error(`GET /amt-storage/ -> ${res.status} ${res.statusText}`)
  /**
   * AMT renders each entry into a fixed-width buffer and never clears the tail,
   * so the `link` field arrives padded with NULs -- or with whatever bytes happened
   * to be in the buffer, which decode to U+FFFD. Either way the document is not
   * valid JSON until that padding is removed.
   */
  const txt = (await res.text()).replace(/[\0\uFFFD]/g, '')
  const listing = JSON.parse(txt) as StorageListing
  return { listing, server }
}

/**
 * Read a stored entry.
 *
 * AMT always serves user-flash entries as `Content-Encoding: gzip`, so the HTTP
 * layer hands back the *decompressed* page even though the device is storing gzip.
 * `stored` is the compressed size the listing reports; `bytes` is the served page.
 */
async function readEntry(
  creds: Creds,
  path: string,
): Promise<{ bytes: Uint8Array; encoding: string | null; stored: number }> {
  const { listing } = await listStorage(creds)
  const res = await amtFetch(creds, `/amt-storage/${path}`)
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    encoding: res.headers.get('content-encoding'),
    stored: listing.content?.[path]?.size ?? -1,
  }
}

async function deleteEntry(creds: Creds, path: string): Promise<boolean> {
  const res = await amtFetch(creds, `/amt-storage/${path}`, { method: 'DELETE' })
  if (res.status === 404) return false
  if (!res.ok && res.status !== 200) throw new Error(`DELETE ${path} -> ${res.status}`)
  return true
}

/**
 * AMT metadata envelope: the gzip payload followed by a <link> element naming it,
 * and <headers> declaring how the device should serve the entry.
 *
 * Note the payload is raw bytes, not base64 -- <link> is a label for the content
 * that precedes it, not a container. (Base64 only appears in the .NET build because
 * that is how the payload is stored inside the executable.)
 */
function metadataHead(link: string | null): string {
  return (
    '<metadata><headers><h>Content-Encoding:gzip</h>' +
    '<h>Content-Type:text/html</h></headers>' +
    (link ? `<link>${link}</link>` : '') +
    '</metadata>'
  )
}

/** Follower chunks carry only the empty metadata marker. */
const METADATA_FOLLOWUP = '<metadata></metadata>'

/** AMT caps a single PUT body; the original loader uses 8 KiB and halves on 500. */
const BLOCK_SIZE = 8192

/**
 * Write a gzipped console into user flash.
 *
 * The body is an AMT metadata envelope whose <headers> say how to serve the entry,
 * immediately followed by the gzip payload. That framing is the whole trick: AMT
 * reads the trailing metadata and applies it to the bytes that preceded it.
 *
 * Content-Type must be absent (the original loader sets it to the empty string),
 * otherwise AMT answers 400 and writes nothing.
 */
async function writeEntry(
  creds: Creds,
  path: string,
  gzip: Uint8Array,
  link: string | null = null,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let blockSize = BLOCK_SIZE
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await pushAll(creds, path, gzip, link, blockSize, onProgress)
      return
    } catch (e) {
      // A 500 means the block was too big for this device; halve and retry.
      if (!(e instanceof StorageError) || e.status !== 500 || blockSize <= 256) throw e
      blockSize = Math.floor(blockSize / 2)
    }
  }
}

async function pushAll(
  creds: Creds,
  path: string,
  gzip: Uint8Array,
  link: string | null,
  blockSize: number,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const first = Buffer.from(metadataHead(link), 'utf8')
  let offset = 0
  while (offset < gzip.length) {
    const head = offset === 0 ? first : Buffer.from(METADATA_FOLLOWUP, 'utf8')
    const room = blockSize - head.length
    const take = Math.min(gzip.length - offset, room)
    const body = Buffer.concat([head, Buffer.from(gzip.subarray(offset, offset + take))])
    const target = offset === 0 ? `/amt-storage/${path}` : `/amt-storage/${path}?append=1`
    const res = await amtFetch(creds, target, { method: 'PUT', body })
    if (!res.ok) throw new StorageError(`PUT ${path} -> ${res.status} ${res.statusText}`, res.status)
    offset += take
    onProgress?.(offset, gzip.length)
  }
}

/** Carries the HTTP status so the caller can tell "too big" from a real failure. */
class StorageError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'StorageError'
    this.status = status
  }
}

// ------------------------------------------------------------------ commands

interface Options {
  host: string
  user: string
  pass: string
  tls: boolean
  file?: string
  entry: string
  path: string
  /** Value for the <link> element; AMT stores it as the entry's link field. */
  link: string | null
  yes: boolean
  dryRun: boolean
}

async function cmdCheck(o: Options) {
  banner('Intel(R) AMT console loader', 'checking device and user-flash capacity')
  const creds: Creds = { host: o.host, user: o.user, pass: o.pass, tls: o.tls }

  let listing: StorageListing
  let server: string
  try {
    ;({ listing, server } = await listStorage(creds))
  } catch (e) {
    bad(`could not reach the device at ${o.host}:${o.tls ? HTTPS_PORT : HTTP_PORT}`)
    say(`    ${(e as Error).message}`, 'dim')
    return 1
  }

  good(`connected to ${server || 'Intel(R) AMT'}`)
  field('user', listing.information?.user ?? o.user)
  field('storage API', `v${listing.information?.version ?? '?'}`)
  field('free space', listing.information?.realms != null ? bytes(listing.information.realms) : 'unknown')

  const names = Object.keys(listing.content ?? {})
  field('entries', names.length ? `${names.length} file(s)` : 'none')
  for (const n of names) {
    field('  ' + n, bytes(listing.content[n].size))
  }
  console.log()
  return 0
}

async function cmdUpload(o: Options) {
  if (!o.file) {
    bad('no file given — pass a gzipped console (e.g. dist/firmware/Firmware-Large.htm.gz)')
    return 2
  }
  const file = Bun.file(o.file)
  if (!(await file.exists())) {
    bad(`file not found: ${o.file}`)
    return 2
  }

  const gzip = new Uint8Array(await file.arrayBuffer())
  const magic = gzip[0] === 0x1f && gzip[1] === 0x8b
  banner('Intel(R) AMT console loader', `installing ${o.file}`)

  if (!magic) {
    warn('this file does not start with a gzip magic number')
    warn('AMT stores the console as-is, so it must already be gzipped')
    if (!o.yes) return 2
  }

  const creds: Creds = { host: o.host, user: o.user, pass: o.pass, tls: o.tls }
  const { listing } = await listStorage(creds)
  const existing = listing.content?.[o.path]
  if (existing) {
    field('existing', `${o.path} (${bytes(existing.size)})`)
    if (!o.yes) {
      warn('an entry is already installed; re-run with --yes to replace it')
      return 1
    }
  } else {
    field('existing', 'none')
  }

  if (o.dryRun) {
    const head = Buffer.from(metadataHead(o.link ?? null), 'utf8')
    say()
    step('dry run — nothing was written. This is exactly what would be sent:')
    say()
    say(`    ${paint(C.cyan, `PUT http://${o.host}:${o.tls ? HTTPS_PORT : HTTP_PORT}/amt-storage/${o.path}`)}`)
    say(`    ${paint(C.dim, 'Authorization: Digest …   (computed per request)')}`)
    say(`    ${paint(C.dim, 'Content-Type: <absent — AMT answers 400 if it is set>')}`)
    say(`    ${paint(C.dim, `Content-Length: ${head.length + gzip.length}`)}`)
    say()
    say(`    ${paint(C.dim, head.toString('utf8'))}`)
    say(`    ${paint(C.dim, '«' + gzip.length + ' bytes of gzip»')}`)
    say()
    const chunks = Math.max(1, Math.ceil(gzip.length / (BLOCK_SIZE - head.length)))
    field('gzip payload', bytes(gzip.length))
    field('metadata head', `${head.length} bytes`)
    field('requests', `${chunks} (${chunks === 1 ? 'single block' : `${BLOCK_SIZE} B blocks, first without ?append=1`})`)
    field('free space', listing.information?.realms != null ? bytes(listing.information.realms) : 'unknown')
    const base = o.path.slice(o.path.lastIndexOf('/') + 1)
    if (!CONSOLE_NAMES.includes(base)) {
      warn(`AMT serves ${CONSOLE_NAMES.join(' or ')} — this entry would be stored but never shown`)
    }
    return 0
  }

  if (listing.information?.realms != null && gzip.length > listing.information.realms) {
    bad(`payload is ${bytes(gzip.length)} but only ${bytes(listing.information!.realms!)} is free`)
    return 1
  }

  // Replacing is done as a delete-then-put so a re-run is idempotent; AMT's
  // ?append=1 would otherwise concatenate onto the previous file.
  if (existing) {
    step('removing previous entry…')
    await deleteEntry(creds, o.path)
  }

  step(`uploading ${bytes(gzip.length)}…`)
  let lastPct = -1
  await writeEntry(creds, o.path, gzip, o.link ?? null, (done, total) => {
    const pct = Math.floor((done / total) * 100)
    if (pct >= lastPct + 20) {
      lastPct = pct
      process.stdout.write(`\r  ${paint(C.dim, `  …${pct}%  (${bytes(done)} of ${bytes(total)})`)}`)
    }
  })
  process.stdout.write('\r')
  good(`uploaded ${bytes(gzip.length)}`)

  step('verifying…')
  const after = await listStorage(creds)
  const written = after.listing.content?.[o.path]
  if (!written) {
    bad('device does not list the entry after upload')
    return 1
  }
  if (written.size !== gzip.length) {
    bad(`size mismatch: sent ${gzip.length}, device reports ${written.size}`)
    return 1
  }
  const back = await readEntry(creds, o.path)
  // The device stores gzip but serves it decoded, so compare against the inflated page.
  const expected = Bun.gunzipSync(gzip as unknown as Uint8Array<ArrayBuffer>)
  const same =
    back.bytes.length === expected.length && back.bytes.every((b, i) => b === expected[i])
  if (!same) {
    bad(`data check failed: served ${back.bytes.length} bytes, expected ${expected.length}`)
    return 1
  }
  good(`verified — ${bytes(written.size)} stored, ${bytes(expected.length)} served`)
  field('console path', `/amt-storage/${o.path}`)
  return 0
}

async function cmdRemove(o: Options) {
  banner('Intel(R) AMT console loader', 'removing the installed console')
  const creds: Creds = { host: o.host, user: o.user, pass: o.pass, tls: o.tls }
  const { listing } = await listStorage(creds)
  const names = Object.keys(listing.content ?? {})
  if (names.length === 0) {
    step('nothing to remove')
    return 0
  }
  if (!o.yes) {
    field('will remove', names.join(', '))
    warn('re-run with --yes to confirm')
    return 1
  }
  for (const n of names) {
    const path = n.includes('/') ? n : o.path
    step(`deleting ${path}…`)
    await deleteEntry(creds, path)
  }
  good('removed')
  return 0
}

async function cmdVerify(o: Options) {
  banner('Intel(R) AMT console loader', 'verifying the installed console')
  const creds: Creds = { host: o.host, user: o.user, pass: o.pass, tls: o.tls }
  const { listing, server } = await listStorage(creds)
  good(`connected to ${server || 'Intel(R) AMT'}`)
  const entry = listing.content?.[o.path]
  if (!entry) {
    warn(`no entry at /amt-storage/${o.path}`)
    return 1
  }
  field('stored (gzip)', bytes(entry.size))
  field('content-encoding', entry.link ? `link: ${entry.link}` : 'inline')

  const back = await readEntry(creds, o.path)
  const html = new TextDecoder().decode(back.bytes)
  field('served page', bytes(back.bytes.length))
  field('title', (html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '—').replace(/\s+/g, ' ').trim())
  const isHtml = /<\s*(!doctype|html)/i.test(html)
  if (!isHtml) {
    bad('served bytes do not look like an HTML page')
    return 1
  }
  good('entry looks good')
  return 0
}

// ------------------------------------------------------------------ argument

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('-')) {
      out._ = out._ ? `${out._} ${a}` : a
      continue
    }
    const key = a.replace(/^--?/, '')
    const next = argv[i + 1]
    if (next && !next.startsWith('-')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

const USAGE = `
${paint(C.bold, 'amt-loader')} — install a gzipped console into Intel(R) AMT user flash

  ${paint(C.cyan, 'bun scripts/amt-loader.ts')} [command] [options]

Commands
  wizard             guided install (the default when run from a terminal)
  check              show device, free space and installed entries
  upload             install a gzipped console
  verify             read back the installed console and validate it
  remove             delete the installed console

Options
  -h, --host <host>  AMT address (default localhost)
  -u, --user <user>  AMT user (default admin)
  -p, --pass <pass>  AMT password
      --tls          use https :${HTTPS_PORT} instead of http :${HTTP_PORT}
      --file <path>  gzipped console to install
      --entry <name> entry name (default ${DEFAULT_ENTRY})
      --path <p>     storage path (default ${DEFAULT_PATH})
      --link <name>  value for the metadata <link> element
      --yes          do not ask for confirmation
      --dry-run      show what would happen, write nothing

With no command and a TTY you get an interactive wizard.
`

// --------------------------------------------------------------- interactive

/**
 * Prompt for a value.
 *
 * On a terminal this is a normal readline question. When stdin is a pipe we read
 * the answers up front and hand them out from a queue -- readline drops lines that
 * were already buffered by the time the next question() is issued, which stalls a
 * scripted run after the first answer.
 */
class Prompter {
  private queue: string[] = []
  private pending = 0
  private rl: ReturnType<typeof createInterface> | null = null

  private static async drain(): Promise<string[]> {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)
  }

  static async open(interactive: boolean): Promise<Prompter> {
    const p = new Prompter()
    if (interactive) {
      p.rl = createInterface({ input: process.stdin, output: process.stdout })
    } else {
      p.queue = (await Prompter.drain()).filter((l) => l.trim() !== '')
    }
    return p
  }

  async ask(q: string, def?: string): Promise<string> {
    if (this.rl) {
      const suffix = def ? paint(C.dim, ` (${def})`) : ''
      const a = (await this.rl.question(`  ${q}${suffix}: `)).trim()
      return a || def || ''
    }
    this.pending++
    process.stdout.write(`  ${q}${def ? paint(C.dim, ` (${def})`) : ''}: `)
    const a = (this.queue.shift() ?? '').trim()
    if (a !== '') process.stdout.write(`${a}\n`)
    else process.stdout.write(`${def ?? ''}\n`)
    return a || def || ''
  }

  /**
   * Choose one of `choices`.
   *
   * On a terminal the list is printed and the answer typed (arrow keys are overkill
   * for three or four entries). When stdin is a pipe the answer is a 1-based number
   * or the choice id, so a scripted run can use either.
   */
  async choose(q: string, choices: { id: string; label: string; hint?: string }[]): Promise<string> {
    if (this.rl) {
      say(`  ${q}`)
      choices.forEach((c, i) => {
        const n = paint(C.cyan, String(i + 1).padStart(2))
        const hint = c.hint ? paint(C.dim, `  ${c.hint}`) : ''
        say(`    ${n}) ${c.label}${hint}`)
      })
      const suffix = paint(C.dim, ' (number)')
      const a = (await this.rl.question(`  ${suffix}: `)).trim()
      return a
    }
    process.stdout.write(`  ${q} [${choices.map((_, i) => i + 1).join('/')}]: `)
    const a = (this.queue.shift() ?? '').trim()
    const idx = Number(a) - 1
    const hit =
      Number.isInteger(idx) && idx >= 0 && choices[idx]
        ? choices[idx].id
        : choices.find((c) => c.id === a.toLowerCase())?.id
    process.stdout.write(`${hit ?? a}\n`)
    return hit ?? a
  }

  close() {
    this.rl?.close()
  }
}

/**
 * Console builds the wizard offers, cheapest first.
 *
 * These are the tiers `build-firmware.ts` emits. Small is the safe default: it is
 * what fits in the tightest user-flash budgets, and it is the one AMT is most
 * likely to serve under a small activation partition.
 */
const VARIANTS = [
  { id: 'small', label: 'Small', file: 'dist/firmware/Firmware-Small.htm.gz' },
  { id: 'medium', label: 'Medium', file: 'dist/firmware/Firmware-Medium.htm.gz' },
  { id: 'large', label: 'Large', file: 'dist/firmware/Firmware-Large.htm.gz' },
]

const CUSTOM = 'custom'

/** Repo root, so the defaults resolve no matter where the tool is run from. */
const REPO = join(new URL('..', import.meta.url).pathname)

/** Variants whose artifact has actually been built, with their on-disk size. */
function builtVariants(): { id: string; label: string; file: string; size: string }[] {
  return VARIANTS.flatMap((v) => {
    const p = join(REPO, v.file)
    if (!existsSync(p)) return []
    return [{ ...v, size: bytes(statSync(p).size) }]
  })
}

async function wizard(dryRun: boolean): Promise<number> {
  banner('Intel(R) AMT console loader', 'gzip a console into the device user flash')
  const asker = await Prompter.open(process.stdin.isTTY === true)

  try {
    const host = await asker.ask('AMT address', 'localhost')
    const user = await asker.ask('username', 'admin')
    const pass = await asker.ask('password')
    const tls = (await asker.ask(`use TLS :${HTTPS_PORT}?`, 'no')).toLowerCase().startsWith('y')
    const built = builtVariants()
    let file: string
    if (built.length === 0) {
      warn('no built consoles found under dist/firmware — run bun run build:firmware first')
      file = await asker.ask('gzipped console to install', VARIANTS[0].file)
    } else {
      const pick = await asker.choose('console build', [
        ...built.map((v) => ({ id: v.id, label: v.label, hint: `${v.size}  ${v.file}` })),
        { id: CUSTOM, label: 'Custom path…', hint: 'type any gzipped console' },
      ])
      if (pick === CUSTOM) file = await asker.ask('path to gzipped console')
      else file = (built.find((v) => v.id === pick) ?? built[0]).file
    }
    const creds: Creds = { host, user, pass, tls }
    console.log()

    const { listing, server } = await listStorage(creds)
    good(`connected to ${server || 'Intel(R) AMT'}`)
    field('user', listing.information?.user ?? user)
    field('free space', listing.information?.realms != null ? bytes(listing.information.realms) : 'unknown')
    field('installed', Object.keys(listing.content ?? {}).join(', ') || 'none')
    console.log()

    const o: Options = {
      host,
      user,
      pass,
      tls,
      file,
      entry: DEFAULT_ENTRY,
      path: DEFAULT_PATH,
      link: null,
      yes: true,
      dryRun,
    }
    return await cmdUpload(o)
  } catch (e) {
    bad((e as Error).message)
    return 1
  } finally {
    asker.close()
  }
}

// ---------------------------------------------------------------------- main

const argv = process.argv.slice(2)
const args = parseArgs(argv)
const positional = String(args._ ?? '').trim()
// No command: use the wizard on a terminal, otherwise assume a read-only check.
const command = positional || (process.stdin.isTTY && process.stdout.isTTY ? '' : 'check')

if (args.help || args.h === 'help' || command === 'help') {
  console.log(USAGE)
  process.exit(0)
}

const o: Options = {
  host: String(args.host ?? args.h ?? 'localhost'),
  user: String(args.user ?? args.u ?? 'admin'),
  pass: String(args.pass ?? args.p ?? ''),
  tls: Boolean(args.tls),
  file: args.file ? String(args.file) : positional && positional !== 'check' && positional !== 'verify' && positional !== 'remove' ? positional : undefined,
  entry: String(args.entry ?? DEFAULT_ENTRY),
  path: String(args.path ?? DEFAULT_PATH),
  link: args.link ? String(args.link) : null,
  yes: Boolean(args.yes ?? args.y),
  dryRun: Boolean(args['dry-run']),
}

let code = 0
try {
  if (!command || command === 'wizard') {
    code = await wizard(o.dryRun)
  } else if (command === 'check') {
    code = await cmdCheck(o)
  } else if (command === 'upload') {
    code = await cmdUpload(o)
  } else if (command === 'verify') {
    code = await cmdVerify(o)
  } else if (command === 'remove') {
    code = await cmdRemove(o)
  } else {
    console.log(USAGE)
    code = 2
  }
} catch (e) {
  bad((e as Error).message)
  code = 1
}
process.exit(code)
