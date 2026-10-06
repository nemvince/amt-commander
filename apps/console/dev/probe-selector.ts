/**
 * Minimal control probe: does the device still answer a redirection selector?
 *
 * Uses the same raw-socket + digest approach as inspect-live-wsman.ts, but with
 * no browser in the loop, so it tells us whether the device is refusing sessions
 * or whether the relay is at fault. Read-only: it opens a session and closes it.
 *
 *   AMT_PASS=... bun dev/probe-selector.ts [1=sol 2=kvm 3=ider]
 */
import { createHash } from 'node:crypto'

const HOST = process.env.AMT_HOST ?? '192.168.10.103:16992'
const USER = process.env.AMT_USER ?? 'admin'
const PASS = process.env.AMT_PASS
if (!PASS) throw new Error('Set AMT_PASS')

const protocol = Number(process.argv[2] ?? 2)
const SELECTORS: Record<number, number[]> = {
  1: [0x10, 0x00, 0x00, 0x00, 0x53, 0x4f, 0x4c, 0x20],
  2: [0x10, 0x01, 0x00, 0x00, 0x4b, 0x56, 0x4d, 0x52],
  3: [0x10, 0x00, 0x00, 0x00, 0x49, 0x44, 0x45, 0x52],
}
const WS_KEY = 'x3JJHMbDL1EzLkh9GBhXDw=='

const [h, p] = HOST.split(':')
let write: (b: Buffer) => void = () => {}
let done = false
let first = true
let endSocket: () => void = () => {}
/** Digest to use on the retry; the challenge socket must close before we dial. */
let retryWith: string | null = null

const finish = (code: string) => {
  if (done) return
  done = true
  console.log(`RESULT protocol=${protocol} -> ${code}`)
  process.exit(0)
}

const digest = (header: string): string | null => {
  const realm = /realm="([^"]*)"/.exec(header)?.[1]
  const nonce = /nonce="([^"]*)"/.exec(header)?.[1]
  if (realm == null || nonce == null) return null
  const opaque = /opaque="([^"]*)"/.exec(header)?.[1]
  const algorithm = /algorithm=([^,\s]*)/.exec(header)?.[1] ?? 'MD5'
  const uri = '/ws-redirection'
  const cnonce = '0a4f113bd7e5c3a1'
  const nc = '00000001'
  const ha1 = createHash('md5').update(`${USER}:${realm}:${PASS}`).digest('hex')
  const ha2 = createHash('md5').update(`GET:${uri}`).digest('hex')
  const response = createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`).digest('hex')
  return (
    `Digest username="${USER}", realm="${realm}", nonce="${nonce}", uri="${uri}", ` +
    `response="${response}", algorithm=${algorithm}, qop=auth, nc=${nc}, cnonce="${cnonce}"` +
    (opaque ? `, opaque="${opaque}"` : '')
  )
}

const req = (auth?: string): string =>
  'GET /ws-redirection HTTP/1.1\r\n' +
  `Host: ${HOST}\r\n` +
  'Upgrade: websocket\r\n' +
  'Connection: Upgrade\r\n' +
  `Sec-WebSocket-Key: ${WS_KEY}\r\n` +
  'Sec-WebSocket-Version: 13\r\n' +
  (auth ? `Authorization: ${auth}\r\n` : '') +
  '\r\n'

/** Client frames must be masked; build one for an arbitrary payload. */
function maskedFrame(payload: Uint8Array): Buffer {
  const mask = Buffer.from([1, 2, 3, 4])
  const len = payload.length
  let header: Buffer
  if (len < 126) header = Buffer.from([0x82, 0x80 | len])
  else {
    header = Buffer.alloc(4)
    header[0] = 0x82
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  }
  const body = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]))
  return Buffer.concat([header, mask, body])
}

const connect = (auth: string | null) => {
  let handshake = Buffer.alloc(0)
  let upgraded = false
  const sock = Bun.connect({
    hostname: h ?? '',
    port: Number(p ?? 16992),
    socket: {
      open(s) {
        write = (b) => {
          try {
            s.write(b)
          } catch {
            finish('write-failed')
          }
        }
        endSocket = () => {
          try {
            s.end()
          } catch {
            /* already gone */
          }
        }
        s.write(Buffer.from(req(auth ?? undefined), 'latin1'))
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
            console.log('101 Switching Protocols; sending selector')
            write(maskedFrame(new Uint8Array(SELECTORS[protocol])))
            return
          }
          const d = digest(/www-authenticate:\s*(.+)/i.exec(head)?.[1] ?? '')
          if (d == null) {
            console.log('no challenge; head was:', head.split('\r\n')[0])
            finish('refused')
          } else {
            // Dial the retry only after this socket is fully closed: AMT treats a
            // lingering half-open upgrade as an occupied redirection session.
            retryWith = d
            endSocket()
          }
          return
        }
        // Parse one server frame and report it.
        const buf = handshake
        if (buf.length < 2) return
        const opcode = buf[0] & 0x0f
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) {
          len = buf.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          len = Number(buf.readBigUInt64BE(2))
          off = 10
        }
        const payload = buf.subarray(off, off + len)
        console.log(`recv opcode=${opcode} len=${len} first=0x${payload[0]?.toString(16)}`)
        if (opcode === 0x8) finish('device-close')
        else if (first) finish('got-reply')
        else {
          // Keep reading briefly in case more arrives.
          setTimeout(() => finish('idle'), 2000)
        }
      },
      error() {
        if (retryWith == null) finish(first ? 'socket-error' : 'socket-error-after-reply')
      },
      close() {
        if (retryWith != null) {
          const auth = retryWith
          retryWith = null
          connect(auth)
          return
        }
        finish(first ? 'closed-before-reply' : 'closed-after-reply')
      },
    },
  })
  void sock
}

connect(null)
setTimeout(() => finish('timeout'), 15000)