/**
 * Freeze this mock's answers into `static/responses.json`.
 *
 * The promo site's demo runs the real console build, but a browser cannot talk
 * to an AMT device from another origin, so a Service Worker answers its calls
 * from that file instead. Every body in it comes back out of this same server --
 * nothing here is hand-written XML.
 *
 * The requests it replays are the ones a real console sends, captured verbatim
 * in `static/requests.json` (a walk of the demo build's pages against this mock,
 * reading `GET /__raw`). Verbatim matters: a synthesized envelope would be
 * missing the method arguments -- `MaxReadRecords`, `IterationIdentifier` -- and
 * the handler would answer with its defaults, which is how the event log ended
 * up replaying one short page of records forever.
 *
 * To re-capture after a page changes:
 *   bun packages/mock/server.ts                     # one terminal
 *   curl localhost:8765/__reset
 *   # walk every page of the demo build (and press the toolbar buttons),
 *   # then keep each distinct POST /wsman body from:
 *   curl localhost:8765/__raw
 *
 *   bun packages/mock/export-static.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { server } from './server.ts'

interface Request {
  method: string
  path: string
  /** WSMAN only: `<action>|<resource uri>`, the pair the mock routes on. */
  match: string | null
  body: string
}

interface Entry {
  method: string
  path: string
  match: string | null
  status: number
  contentType: string
  body: string
}

const REQUESTS_FILE = new URL('./static/requests.json', import.meta.url).pathname
const OUT_FILE = new URL('./static/responses.json', import.meta.url).pathname

const { requests } = JSON.parse(readFileSync(REQUESTS_FILE, 'utf8')) as { requests: Request[] }

const record = async (request: Request): Promise<Entry> => {
  const res = await server.fetch(
    new Request('http://mock.local' + request.path, {
      method: request.method,
      ...(request.method === 'POST' ? { body: request.body } : {}),
    }),
  )
  const entry: Entry = {
    method: request.method,
    path: request.path,
    match: request.match,
    status: res.status,
    contentType: res.headers.get('content-type') ?? 'text/plain',
    body: await res.text(),
  }
  if (entry.status !== 200) {
    throw new Error(`${request.method} ${request.path} ${request.match ?? ''} -> ${entry.status}`)
  }
  return entry
}

const entries: Entry[] = []
for (const request of requests) {
  entries.push(await record(request))
}

// The Storage page is not in the demo's feature set, but the Service Worker
// advertises /amt-storage and this is the document a walk there reads.
entries.push(await record({ method: 'GET', path: '/amt-storage/', match: null, body: '' }))

mkdirSync(new URL('./static/', import.meta.url).pathname, { recursive: true })
writeFileSync(OUT_FILE, JSON.stringify(entries, null, 2) + '\n')
console.log(`wrote ${entries.length} responses to static/responses.json`)
process.exit(0)
