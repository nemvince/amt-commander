/**
 * Intel AMT redirection transport over the device's own websocket.
 *
 * Ported from amt-redir-ws-0.1.0.js, firmware path only. The relay/digest
 * variants are dead code for the firmware edition: `/ws-redirection` is served by
 * AMT itself and the websocket is already authenticated, so the client replies to
 * StartRedirectionSessionReply with empty Kerberos auth.
 *
 * Wire constants are fixed by the protocol:
 *   SOL  selector 10 00 00 00 53 4F 4C 20
 *   KVM  selector 10 01 00 00 4B 56 4D 52
 *   IDER selector 10 00 00 00 49 44 45 52
 */

/** 1 = SOL, 2 = KVM, 3 = IDER. */
export type RedirectProtocol = 1 | 2 | 3

/** Consumer implemented by the terminal / desktop / IDER modules. */
export interface RedirectModule {
  protocol: RedirectProtocol
  /** Optional: receives the device's refusal status so the UI can explain it. */
  disconnectCode?: number
  /** Called once the session is live and data can flow. */
  Start(): void
  /** Text payload (SOL). */
  ProcessData?(data: string): void
  /** Binary payload (KVM, IDER). Preferred when present. */
  ProcessBinaryData?(data: Uint8Array): void
  /** Send raw bytes back up the channel. */
  Send?(data: Uint8Array | string): void
  /** 0 stopped, 1 connecting, 2 socket open, 3 streaming. */
  xxStateChange(state: number): void
}

export interface RedirectChannel {
  State: number
  connectstate: number
  onStateChanged: ((channel: RedirectChannel, state: number) => void) | null
  Start(): void
  Stop(reason?: number): void
  Send(data: Uint8Array | string): void
}

const SELECTORS: Record<RedirectProtocol, number[]> = {
  1: [0x10, 0x00, 0x00, 0x00, 0x53, 0x4f, 0x4c, 0x20], // SOL
  2: [0x10, 0x01, 0x00, 0x00, 0x4b, 0x56, 0x4d, 0x52], // KVM
  3: [0x10, 0x00, 0x00, 0x00, 0x49, 0x44, 0x45, 0x52], // IDER
}

function intToStrX(v: number): string {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, v >>> 0, true)
  return String.fromCharCode(b[0], b[1], b[2], b[3])
}

function shortToStrX(v: number): string {
  return String.fromCharCode(v & 0xff, (v >> 8) & 0xff)
}

export function createRedirect(module: RedirectModule): RedirectChannel {
  const obj = {} as RedirectChannel
  let socket: WebSocket | null = null
  let acc: Uint8Array | null = null
  let amtsequence = 1
  let keepAliveTimer: number | null = null
  obj.State = 0
  obj.connectstate = 0
  obj.onStateChanged = null

  function stateChange(next: number) {
    if (obj.State === next) return
    obj.State = next
    module.xxStateChange(next)
    obj.onStateChanged?.(obj, next)
  }

  function sendRaw(bytes: Uint8Array) {
    try {
      socket?.send(bytes as unknown as ArrayBufferView<ArrayBuffer>)
    } catch {
      /* socket closed underneath us */
    }
  }

  function sendText(x: string) {
    if (socket == null || socket.readyState !== WebSocket.OPEN) return
    const b = new Uint8Array(x.length)
    for (let i = 0; i < x.length; i++) b[i] = x.charCodeAt(i) & 0xff
    sendRaw(b)
  }

  obj.Send = function (data) {
    if (socket == null || obj.connectstate !== 1) return
    if (module.protocol === 1) {
      // SOL wraps user input in a typed-data message; everything else is raw.
      const payload = typeof data === 'string' ? data : ''
      sendText(
        String.fromCharCode(0x28, 0x00, 0x00, 0x00) + intToStrX(amtsequence++) + shortToStrX(payload.length) + payload,
      )
    } else {
      sendText(typeof data === 'string' ? data : String.fromCharCode(...data))
    }
  }

  function sendKeepAlive() {
    if (socket != null) sendText(String.fromCharCode(0x2b, 0x00, 0x00, 0x00) + intToStrX(amtsequence++))
  }

  function feed(data: Uint8Array) {
    if (module.ProcessBinaryData) module.ProcessBinaryData(data)
    else module.ProcessData?.(String.fromCharCode(...data))
  }

  function onMessage(e: MessageEvent) {
    if (!e.data || obj.connectstate === -1) return
    const incoming = new Uint8Array(e.data as ArrayBuffer)

    // KVM/IDER stream raw once the session is up.
    if (obj.connectstate === 1 && (module.protocol === 2 || module.protocol === 3)) {
      feed(incoming)
      return
    }

    // Otherwise accumulate: websocket frames do not line up with protocol messages.
    if (acc == null) acc = incoming
    else {
      const merged = new Uint8Array(acc.length + incoming.length)
      merged.set(acc, 0)
      merged.set(incoming, acc.length)
      acc = merged
    }

    while (acc != null && acc.length >= 1) {
      let cmdsize = 0
      switch (acc[0]) {
        case 0x11: // StartRedirectionSessionReply
          if (acc.length < 4) return
          if (acc[1] !== 0) {
            // Non-zero status is the reason the device refused the session
            // (2 = redirection port busy), and is the page's only clue why.
            module.disconnectCode = acc[1]
            obj.Stop(acc[1])
            return
          }
          if (acc.length < 13) return
          const oemlen = acc[12]
          if (acc.length < 13 + oemlen) return
          // Already authenticated by the websocket; reply with empty Kerberos auth.
          sendRaw(new Uint8Array([0x13, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00]))
          cmdsize = 13 + oemlen
          break

        case 0x14: // AuthenticateSessionReply
          if (acc.length < 9) return
          const authDataLen = new DataView(acc.buffer, acc.byteOffset).getUint32(5, true)
          if (acc.length < 9 + authDataLen) return
          if (acc[1] !== 0) {
            obj.Stop(3)
            return
          }
          cmdsize = 9 + authDataLen
          switch (module.protocol) {
            case 1: {
              // Serial-over-LAN: the first thing the device must see after auth
              // is its serial settings, or it drops the session outright
              // (amt-redir-ws-0.1.0.js:185-193).
              const MAX_TX_BUFFER = 10000
              const TX_TIMEOUT = 100
              const TX_OVERFLOW_TIMEOUT = 0
              const RX_TIMEOUT = 10000
              const RX_FLUSH_TIMEOUT = 100
              const HEARTBEAT = 0
              sendText(
                String.fromCharCode(0x20, 0x00, 0x00, 0x00) +
                  intToStrX(amtsequence++) +
                  shortToStrX(MAX_TX_BUFFER) +
                  shortToStrX(TX_TIMEOUT) +
                  shortToStrX(TX_OVERFLOW_TIMEOUT) +
                  shortToStrX(RX_TIMEOUT) +
                  shortToStrX(RX_FLUSH_TIMEOUT) +
                  shortToStrX(HEARTBEAT) +
                  intToStrX(0),
              )
              break
            }
            case 2:
              sendText(String.fromCharCode(0x40, 0x00, 0x00, 0x00) + intToStrX(amtsequence++))
              break
            case 3:
              // IDER is ready the moment authentication succeeds: unlike KVM it
              // has no 0x41 session-start opcode to wait for, so raise link state
              // here. That drives the engine's own OPEN_SESSION, which carries the
              // timeouts and protocol version the device expects
              // (amt-redir-ws-0.1.0.js:197-201).
              obj.connectstate = 1
              stateChange(3)
              break
          }
          break

        case 0x21: // Response to settings
          if (acc.length < 23) return
          cmdsize = 23
          sendText(
            String.fromCharCode(0x27, 0x00, 0x00, 0x00) +
              intToStrX(amtsequence++) +
              String.fromCharCode(0x00, 0x00, 0x1b, 0x00, 0x00, 0x00),
          )
          if (module.protocol === 1) keepAliveTimer = setInterval(sendKeepAlive, 2000)
          obj.connectstate = 1
          stateChange(3)
          break

        case 0x29: // Serial settings
          if (acc.length < 10) return
          cmdsize = 10
          break

        case 0x2a: // Incoming display data (SOL payload)
          if (acc.length < 10) return
          const total = 10 + acc[8] + (acc[9] << 8)
          if (acc.length < total) return
          feed(acc.slice(10, total))
          cmdsize = total
          break

        case 0x2b: // Keep alive
          if (acc.length < 8) return
          cmdsize = 8
          break

        case 0x41: // IDER session start
          if (acc.length < 8) return
          obj.connectstate = 1
          module.Start()
          if (acc.length > 8) feed(acc.slice(8))
          cmdsize = acc.length
          break

        case 0xf0: // Session is being recorded
          cmdsize = 1
          break

        default:
          obj.Stop(4)
          return
      }

      if (cmdsize === 0) return
      acc = cmdsize === acc.length ? null : acc.slice(cmdsize)
    }
  }

  obj.Start = function () {
    obj.connectstate = 0
    const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://'
    socket = new WebSocket(scheme + location.host + '/ws-redirection')
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      stateChange(2)
      sendRaw(new Uint8Array(SELECTORS[module.protocol]))
    }
    socket.onmessage = onMessage
    socket.onclose = () => obj.Stop(5)
    stateChange(1)
  }

  obj.Stop = function () {
    stateChange(0)
    obj.connectstate = -1
    acc = null
    if (socket != null) {
      socket.close()
      socket = null
    }
    if (keepAliveTimer != null) {
      clearInterval(keepAliveTimer)
      keepAliveTimer = null
    }
  }

  return obj
}