/**
 * Dev proxy that points the SPA at a real Intel AMT host.
 *
 * Browsers cannot attach an Authorization header to a WebSocket, and AMT's
 * `/ws-redirection` answers a plain GET with nothing, so the digest challenge is
 * only visible on a real upgrade attempt. This proxy therefore performs the
 * websocket handshake itself over a raw socket, with HTTP Digest, and relays
 * frames: device->browser payloads are re-framed unmasked, browser->device frames
 * are already masked and pass through byte for byte.
 *
 *   AMT_PASS=... bun dev/inspect-live-wsman.ts
 *
 * It relays whatever the browser asks for, including power and configuration
 * changes, so only point it at a device you are authorised to manage.
 */
import { createHash } from 'node:crypto'

const HOST = process.env.AMT_HOST ?? '192.168.10.103:16992'
const PORT = Number(process.env.PORT ?? 8765)
const USER = process.env.AMT_USER ?? 'admin'
const PASS = process.env.AMT_PASS
if (!PASS) throw new Error('Set AMT_PASS in the environment')

const entries: string[] = []
const [UP_HOST, UP_PORT] = HOST.split(':')
const WS_KEY = 'x3JJHMbDL1EzLkh9GBhXDw=='

type Challenge = { realm: string; nonce: string; opaque?: string; algorithm: string; qop?: string }

const parseChallenge = (header: string): Challenge | null => {
  const realm = /realm="([^"]*)"/.exec(header)?.[1]
  const nonce = /nonce="([^"]*)"/.exec(header)?.[1]
  if (realm == null || nonce == null) return null
  return {
    realm,
    nonce,
    opaque: /opaque="([^"]*)"/.exec(header)?.[1],
    algorithm: /algorithm=([^,\s]*)/.exec(header)?.[1] ?? 'MD5',
    qop: /qop="?([^",\s]+)"?/.exec(header)?.[1],
  }
}

const digestHeader = (c: Challenge): string => {
  const uri = '/ws-redirection'
  const cnonce = '0a4f113bd7e5c3a1'
  const nc = '00000001'
  const ha1 = createHash('md5').update(`${USER}:${c.realm}:${PASS}`).digest('hex')
  const ha2 = createHash('md5').update(`GET:${uri}`).digest('hex')
  const response = c.qop
    ? createHash('md5').update(`${ha1}:${c.nonce}:${nc}:${cnonce}:${c.qop}:${ha2}`).digest('hex')
    : createHash('md5').update(`${ha1}:${c.nonce}:${ha2}`).digest('hex')
  return (
    `Digest username="${USER}", realm="${c.realm}", nonce="${c.nonce}", uri="${uri}", ` +
    `response="${response}", algorithm=${c.algorithm}` +
    (c.qop ? `, qop=${c.qop}, nc=${nc}, cnonce="${cnonce}"` : '') +
    (c.opaque ? `, opaque="${c.opaque}"` : '')
  )
}

const upgradeRequest = (auth?: string): string =>
  'GET /ws-redirection HTTP/1.1\r\n' +
  `Host: ${HOST}\r\n` +
  'Upgrade: websocket\r\n' +
  'Connection: Upgrade\r\n' +
  `Sec-WebSocket-Key: ${WS_KEY}\r\n` +
  'Sec-WebSocket-Version: 13\r\n' +
  (auth ? `Authorization: ${auth}\r\n` : '') +
  '\r\n'

/**
 * Wrap a browser payload as a masked binary frame for the device.
 *
 * Bun hands `message()` the payload with the frame header already stripped, so
 * the header (and the RFC-required client mask) has to be rebuilt here. Sending
 * the bare payload makes the device close the socket immediately.
 */
const frameMasked = (payload: Uint8Array): Buffer => {
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const len = payload.length
  let header: Buffer
  if (len < 126) header = Buffer.from([0x82, 0x80 | len])
  else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x82
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x82
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  const body = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]))
  return Buffer.concat([header, mask, body])
}

type Upstream = {
  /** Raw frame bytes straight through, for the browser's already-masked frames. */
  sendFrame: (bytes: Buffer) => void
  end: () => void
}

/**
 * Opens the device socket. The first upgrade is unauthenticated so the digest
 * challenge can be read, then the same socket is retried with credentials.
 */
function openUpstream(hooks: {
  onPayload: (data: Uint8Array) => void
  onOpen: () => void
  onClose: (code: number) => void
}): Upstream {
  let write: (bytes: Buffer) => void = () => {}
  let end: () => void = () => {}
  let closed = false
  /**
   * Digest to dial on the retry. AMT treats a lingering half-open upgrade as an
   * already-occupied redirection session, so the retry must wait for this
   * socket to close rather than being dialled straight after end().
   */
  let retryWith: string | null = null

  const shutdown = (code: number) => {
    if (closed) return
    closed = true
    entries.push(`ws-redirection: session shutdown code=${code}`)
    hooks.onClose(code)
  }

  /**
   * One upgrade attempt on its own connection. AMT answers an unauthenticated
   * upgrade with 401 and then drops the socket, so the authenticated retry has to
   * go over a brand new connection rather than reusing this one.
   */
  const attempt = (auth: string | null, onChallenge: (c: Challenge) => void, isRetry = false) => {
    let handshake = Buffer.alloc(0)
    let upgraded = false
    let fragment: Uint8Array | null = null

    const socket = Bun.connect({
      hostname: UP_HOST ?? '',
      port: Number(UP_PORT ?? 16992),
      socket: {
        open(s) {
          write = (bytes) => {
            try {
              s.write(bytes)
            } catch {
              shutdown(1011)
            }
          }
          end = () => {
            try {
              s.end()
            } catch {
              /* already gone */
            }
          }
          s.write(Buffer.from(upgradeRequest(auth ?? undefined), 'latin1'))
        },
        data(_s, chunk) {
          handshake = Buffer.concat([handshake, Buffer.from(chunk)])

          if (!upgraded) {
            const eol = handshake.indexOf('\r\n\r\n')
            if (eol < 0) return
            const head = handshake.subarray(0, eol).toString()
            handshake = handshake.subarray(eol + 4)
            if (/^HTTP\/1\.1 101/.test(head)) {
              upgraded = true
              entries.push('ws-redirection: upstream 101 Switching Protocols')
              hooks.onOpen()
              return
            }
            const c = parseChallenge(/www-authenticate:\s*(.+)/i.exec(head)?.[1] ?? '')
            if (c == null) {
              entries.push(`ws-redirection: upgrade refused: ${head.split('\r\n')[0]}`)
              end()
              if (isRetry) shutdown(1011)
              return
            }
            entries.push(`ws-redirection: digest challenge realm=${c.realm} nonce=${c.nonce.slice(0, 10)}...`)
            retryWith = digestHeader(c)
            end()
            onChallenge(c)
            return
          }

          let buf = Buffer.from(handshake)
          handshake = Buffer.alloc(0)
          while (buf.length >= 2) {
            const fin = (buf[0] & 0x80) !== 0
            const opcode = buf[0] & 0x0f
            let len = buf[1] & 0x7f
            let off = 2
            if (len === 126) {
              if (buf.length < 4) break
              len = buf.readUInt16BE(2)
              off = 4
            } else if (len === 127) {
              if (buf.length < 10) break
              len = Number(buf.readBigUInt64BE(2))
              off = 10
            }
            if (buf.length < off + len) break
            let payload = new Uint8Array(buf.subarray(off, off + len))
            buf = buf.subarray(off + len)

            if (opcode === 0x8) {
              const code = len >= 2 ? (payload[0] << 8) + payload[1] : 0
              const why = len > 2 ? new TextDecoder().decode(payload.subarray(2)).trim() : ''
              entries.push(`ws-redirection: device CLOSE frame code=${code} reason=${JSON.stringify(why)}`)
              end()
              shutdown(1000)
              return
            }
            if (opcode === 0x9 || opcode === 0xa) continue
            if (opcode === 0x0 && fragment != null) {
              const merged = new Uint8Array(fragment.length + payload.length)
              merged.set(fragment, 0)
              merged.set(payload, fragment.length)
              payload = merged
            }
            fragment = fin ? payload : payload
            if (fin) {
              hooks.onPayload(fragment)
              fragment = null
            }
          }
          if (buf.length > 0) handshake = buf
        },
        error() {
          // The unauthenticated attempt is dropped by design; only the
          // authenticated socket failing is a real session failure.
          if (isRetry && !closed) {
            entries.push('ws-redirection: upstream socket error')
            shutdown(1011)
          }
        },
        close() {
          if (retryWith != null) {
            const auth = retryWith
            retryWith = null
            attempt(auth, () => {}, true)
            return
          }
          if (!upgraded) {
            if (isRetry && !closed) {
              entries.push('ws-redirection: authenticated socket closed before 101')
              shutdown(1011)
            }
            return
          }
          entries.push('ws-redirection: authenticated socket closed by peer')
          shutdown(1006)
        },
      },
    })
    return socket
  }

  attempt(null, () => {})

  return {
    sendFrame: (bytes) => write(bytes),
    end: () => end(),
  }
}

type SessionId = { id: string }

const sessions = new Map<string, Upstream>()
const pending = new Map<string, Uint8Array[]>()

Bun.serve<SessionId>({
  port: PORT,
  idleTimeout: 120,
  async fetch(req, server) {
    const url = new URL(req.url)

    if (url.pathname === '/__errors') return Response.json(entries)
    if (url.pathname === '/__clear') {
      entries.length = 0
      return Response.json({ ok: true })
    }

    if (url.pathname === '/ws-redirection') {
      if (server.upgrade(req, { data: { id: crypto.randomUUID() } })) return undefined as unknown as Response
      return new Response('expected websocket upgrade', { status: 400 })
    }

    if (url.pathname !== '/wsman' || req.method !== 'POST') {
      return new Response('proxy: POST /wsman, WS /ws-redirection, GET /__errors', {
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    const body = await req.text()
    const action = body.match(/<a:Action>([^<]*)</)?.[1] ?? 'unknown-action'
    const resource = body.match(/<w:ResourceURI>([^<]*)</)?.[1] ?? 'unknown-resource'

    const child = Bun.spawn(
      [
        'curl', '-sS', '--max-time', '20', '-X', 'POST',
        '-H', 'Content-Type: application/http',
        '--digest', '-u', `${USER}:${PASS}`,
        '--data-binary', '@-',
        '-w', '\n__HTTP_STATUS__%{http_code}',
        `http://${HOST}/wsman`,
      ],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    )
    child.stdin.write(body)
    child.stdin.end()
    const raw = await new Response(child.stdout).text()
    const marker = raw.lastIndexOf('\n__HTTP_STATUS__')
    const xml = marker < 0 ? raw : raw.slice(0, marker)
    const parsed = Number(raw.slice(marker + 16))
    // curl can report 0 when the device closes without a status line.
    const status = marker < 0 || !(parsed >= 100 && parsed <= 599) ? 502 : parsed
    const fault = xml.match(/<[^>]*Text[^>]*>([^<]+)/)?.[1]
    entries.push(`${status} ${action.split('/').pop()} ${resource.split('/').pop()}${fault ? ` | ${fault}` : ''}`)
    if (status >= 400 || xml.includes(':Fault')) console.log(entries[entries.length - 1])
    return new Response(xml, { status, headers: { 'Content-Type': 'application/soap+xml; charset=UTF-8' } })
  },

  websocket: {
    open(ws) {
      const id = ws.data.id
      pending.set(id, [])
      entries.push('ws-redirection: browser session opened')

      const upstream = openUpstream({
        onPayload: (data) => {
          entries.push(
            `ws-recv len=${data.length} [${[...data.subarray(0, 24)].map((x) => x.toString(16).padStart(2, '0')).join(' ')}]`,
          )
          // Bun frames the payload itself, so hand over the raw bytes; wrapping
          // them in another frame would leave the browser parsing frame bytes as
          // protocol data and bailing out.
          if (ws.readyState === 1) ws.send(Buffer.from(data))
        },
        onOpen: () => {
          sessions.set(id, upstream)
          for (const frame of pending.get(id) ?? []) {
            upstream.sendFrame(frameMasked(frame))
            entries.push(`ws-send REPLAYED len=${frame.length} first=0x${frame[0]?.toString(16)}`)
          }
          pending.delete(id)
        },
        onClose: (code) => {
          sessions.delete(id)
          if (ws.readyState === 1) ws.close(code === 1006 ? 1011 : code, 'device closed')
        },
      })
    },

    message(ws, msg) {
      const id = ws.data.id
      const upstream = sessions.get(id)
      if (upstream == null) {
        const queue = pending.get(id) ?? []
        queue.push(new Uint8Array(msg as unknown as ArrayBuffer))
        pending.set(id, queue)
        entries.push(`ws-send QUEUED (upstream still handshaking) len=${queue[queue.length - 1].length}`)
        return
      }
      // `msg` is the payload, so re-frame it with a mask before it goes upstream.
      const payload = new Uint8Array(msg as unknown as ArrayBuffer)
      entries.push(`ws-send len=${payload.length} first=0x${payload[0]?.toString(16).padStart(2, '0')}`)
      upstream.sendFrame(frameMasked(payload))
    },

    close(ws) {
      entries.push('ws-redirection: browser session closed')
      sessions.get(ws.data.id)?.end()
      sessions.delete(ws.data.id)
      pending.delete(ws.data.id)
    },
  },
})

console.log(`Live AMT proxy on :${PORT} -> http://${HOST} (raw-socket digest relay for /ws-redirection)`)
