/**
 * Replayed device for the promo site's live demo.
 *
 * A browser cannot talk to an AMT device from another origin -- AMT answers no
 * CORS preflight and holds no credentials for it -- so the demo runs the real
 * console build against `responses.json`, the recorded conversation captured
 * from the mock device (`packages/mock/export-static.ts`). Everything here is
 * read-only: the demo has no way to mutate a real device, and nothing outside
 * this Service Worker's scope is ever touched.
 *
 * The console asks for `wsman` relative to its own document, so the requests
 * arrive under the registration scope and match by path suffix. WebSocket
 * traffic (`ws-redirection`: KVM, SOL and IDE-R) cannot be intercepted by a
 * Service Worker at all, which is why those pages stay disconnected in the demo.
 */

const SCOPE = new URL(self.registration.scope)
const RESPONSES_URL = new URL('../responses.json', SCOPE)

/** `<action>|<resource uri>` of a WSMAN envelope; the mock routes on these two. */
const wsmanKey = (body) => {
  const action = body.match(/<a:Action>([^<]*)<\/a:Action>/)
  const resuri = body.match(/<w:ResourceURI>([^<]*)<\/w:ResourceURI>/)
  return action && resuri ? `${action[1]}|${resuri[1]}` : null
}

let entries = null

const load = async () => {
  if (entries != null) {
    return entries
  }
  const res = await fetch(RESPONSES_URL)
  if (!res.ok) {
    throw new Error(`responses.json -> ${res.status}`)
  }
  entries = await res.json()
  return entries
}

const replay = async (request) => {
  const url = new URL(request.url)
  const body = request.method === 'POST' ? await request.clone().text() : null
  const key = body == null ? null : wsmanKey(body)

  const entry = (await load()).find(
    (e) =>
      e.method === request.method &&
      url.pathname.endsWith(e.path) &&
      (e.match == null || e.match === key),
  )
  if (entry == null) {
    console.warn(`[demo] no recorded response for ${request.method} ${url.pathname} ${key ?? ''}`)
    return new Response(`no recorded response for ${request.method} ${url.pathname} ${key ?? ''}\n`, {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    })
  }
  return new Response(entry.body, {
    status: entry.status,
    headers: { 'Content-Type': entry.contentType },
  })
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // The browser only dispatches requests from clients inside this scope, so the
  // path is all that needs matching -- a page under `/demo/` asks for `wsman`
  // and `amt-storage/...` relative to itself.
  const isWsman = url.pathname.endsWith('/wsman')
  const isStorage = url.pathname.includes('/amt-storage/')
  if (!isWsman && !isStorage) {
    return
  }
  // An exception inside a fetch handler is a silent network fallback, which is
  // exactly the failure that looks like "the demo is broken and the server
  // answered 404". Answer with the error instead.
  event.respondWith(
    replay(event.request).catch(
      (e) =>
        new Response(`demo replay failed: ${e.message}\n`, {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        }),
    ),
  )
})
