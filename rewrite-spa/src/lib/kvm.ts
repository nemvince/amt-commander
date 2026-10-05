/**
 * Remote Desktop (KVM) session engine.
 *
 * Ported from amt-desktop-0.0.2.js. The wire transport (the device's own
 * `/ws-redirection` websocket) lives in redirect.ts; this module is the RFB
 * client that sits on top of it: handshake, framebuffer decoding, canvas
 * painting and input injection.
 *
 * Nothing runs at import time -- the canvas is handed in by the page -- so the
 * module is safe to import from a tier that never loads it.
 */
import { signal } from '@preact/signals'
import type { RedirectChannel, RedirectModule } from './redirect'

/**
 * RFB stream states, matching `obj.state` in amt-desktop-0.0.2.js:15. Once
 * streaming, a FramebufferUpdate header bumps the state to 100 + <pending
 * tiles> and every decoded tile decrements it (amt-desktop-0.0.2.js:222,318).
 */
export const RFB_VERSION = 0
export const RFB_SECURITY_TYPES = 1
export const RFB_SECURITY_RESULT = 2
export const RFB_SERVER_INIT = 3
export const RFB_STREAM = 4

/** Disconnect codes the page maps to user-facing messages (index.html:8878). */
export const DISCONNECT = {
  /** Redirection port busy. */
  BUSY: 2,
  /** Unsupported connection type. */
  UNSUPPORTED: 3,
  /** AMT dropped right after client init: try RLE8, or the GPU is unsupported. */
  KVM_DISCONNECT: 50000,
  /** Everything looked good, so the drop came from AMT -- retry if we ran a while. */
  AMT_DISCONNECT: 50001,
  /** Display too large for the AMT KVM buffer. */
  BUFFER_OVERFLOW: 50002,
  /**
   * The redirection channel came up but no framebuffer ever did. AMT answers
   * this way when the target has no display session -- powered off, asleep, or
   * still booting -- so it is worth telling the user rather than showing a bare
   * "Disconnected".
   */
  NO_DISPLAY: 50003,
} as const

/** Intel AMT's "Desktop Size" pseudo-encoding, -223 on the wire. */
const ENC_DESKTOP_SIZE = -223
/** Largest tile AMT emits; anything bigger is a protocol violation. */
const MAX_TILE = 64
/** bpp * w * h above this overflows the AMT KVM buffer. */
const MAX_BUFFER = 9216000

export interface KvmSettings {
  /** 1 = RLE, 2 = 16bit, 4 = Gray, 16 = 4bit Color (index.html:8673). */
  encflags: number
  showfocus: boolean
  showmouse: boolean
  showcad: boolean
  limitFrameRate: boolean
  noMouseRotate: boolean
  reverseMouseWheel: boolean
  /** Quarter turns clockwise, 0..3. */
  rotation: number
}

/**
 * Default to full 16-bit colour (bit 1 = RLE, bit 2 = 16bpp). Legacy shipped
 * encflags 1, i.e. 8-bit RGB332, which band badly on photographic content; the
 * extra bandwidth is worth it and the settings dialog can still drop back.
 */
export const DEFAULT_KVM_SETTINGS: KvmSettings = {
  encflags: 3,
  showfocus: false,
  showmouse: true,
  showcad: true,
  limitFrameRate: false,
  noMouseRotate: false,
  reverseMouseWheel: false,
  rotation: 0,
}

/** Same localStorage key the legacy viewer used (index.html:8950). */
const STORAGE_KEY = 'desktopsettings'

/** `localStorage` is only touched from these two, never at import time. */
export function loadKvmSettings(): KvmSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw != null) return { ...DEFAULT_KVM_SETTINGS, ...(JSON.parse(raw) as Partial<KvmSettings>) }
  } catch {
    /* private mode or disabled storage, defaults are fine */
  }
  return { ...DEFAULT_KVM_SETTINGS }
}

export function saveKvmSettings(s: KvmSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* nothing to do, the settings just don't persist */
  }
}

/** Redirect link state: 0 disconnected, 1 connecting, 2 setup, 3 connected. */
export const kvmLinkState = signal(0)
/** Current desktop geometry in device pixels; the page mirrors it onto the canvas. */
export const kvmScreen = signal({ width: 640, height: 400 })

/** [keysym, down] pairs, in order. */
export type KeySeq = readonly (readonly [number, number])[]

export interface KvmSession extends RedirectModule {
  readonly protocol: 2
  /** RFB stream state; 4 streaming, 100+n means n tiles still pending. */
  readonly state: number
  readonly canvas: HTMLCanvasElement
  readonly settings: KvmSettings
  /** Last screen size in device pixels. */
  readonly screenWidth: number
  readonly screenHeight: number
  /** Rotation in quarter turns clockwise. */
  rotation: number
  /** Last injected mouse position, in unrotated framebuffer coordinates. */
  readonly mx: number
  readonly my: number
  /** 0 = whole screen, 64 = small focus box, 128 = large focus box. */
  focusMode: number
  /** Reverse the injected scroll direction. */
  reverseMouseWheel: boolean
  /** Set by the page after the session went live, used for the 50001 retry rule. */
  connectTime: number
  /** Set by the page before starting, read when the link drops. */
  disconnectCode: number
  /** Fires after every geometry change so the page can re-fit the surface. */
  onScreenSizeChange: ((width: number, height: number) => void) | null
  attach(channel: RedirectChannel): void
  setSettings(s: Partial<KvmSettings>): void
  setRotation(turns: number): boolean
  sendKey(keysym: number, down: number): void
  sendKeys(seq: KeySeq): void
  /** Control, Alt, Delete down/up (amt-desktop-0.0.2.js:876). */
  sendCad(): void
  onKeyDown(e: KeyboardEvent): void
  onKeyUp(e: KeyboardEvent): void
  onMouseDown(e: MouseEvent): void
  onMouseUp(e: MouseEvent): void
  onMouseMove(e: MouseEvent, force?: boolean): void
  onMouseWheel(e: WheelEvent): void
}

// ShortToStr / IntToStr are big-endian (common-0.0.1.js:29-31).
function intToStr(v: number): string {
  return String.fromCharCode((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff)
}

function shortToStr(v: number): string {
  return String.fromCharCode((v >> 8) & 0xff, v & 0xff)
}

/** AMT hands out a 2-bit blue in the top of the byte; browsers want a full ramp. */
function fixColor(c: number): number {
  return c > 127 ? c + 32 : c
}

/**
 * `e.code` -> AMT keysym, language independent (amt-desktop-0.0.2.js:667-734).
 * AMT only understands a subset of X11 keysyms, so `Key<letter>` maps to the
 * ASCII code of the character rather than to a hardware scancode.
 */
const AMT_KEYSYMS: Record<string, number> = {
  Pause: 19,
  CapsLock: 20,
  Space: 32,
  Quote: 39,
  Minus: 45,
  NumpadMultiply: 42,
  NumpadAdd: 43,
  PrintScreen: 44,
  Comma: 44,
  NumpadSubtract: 45,
  NumpadDecimal: 46,
  Period: 46,
  Slash: 47,
  NumpadDivide: 47,
  Semicolon: 59,
  Equal: 61,
  OSLeft: 91,
  BracketLeft: 91,
  OSRight: 91,
  Backslash: 92,
  BracketRight: 93,
  ContextMenu: 93,
  Backquote: 96,
  NumLock: 144,
  ScrollLock: 145,
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  NumpadEnter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  End: 0xff57,
  Insert: 0xff63,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  ControlLeft: 0xffe3,
  ControlRight: 0xffe4,
  AltLeft: 0xffe9,
  AltRight: 0xffea,
  MetaLeft: 0xffe7,
  MetaRight: 0xffe8,
}

export function createKvmSession(canvas: HTMLCanvasElement, initial?: Partial<KvmSettings>): KvmSession {
  const ctx = canvas.getContext('2d')
  if (ctx == null) throw new Error('2d canvas unavailable')

  let channel: RedirectChannel | null = null
  let acc: Uint8Array | null = null
  /** RFB protocol state, see the RFB_* constants. */
  let state = RFB_VERSION
  /** True once the device has handed us a framebuffer; reset on every teardown. */
  let everStreamed = false
  /** Bytes per pixel: 1 = RGB332, 2 = RGB565 (amt-desktop-0.0.2.js:23). */
  let bpp = 1
  let useRLE = true
  let graymode = false
  let lowcolor = false
  /** ms to hold between frames, 0 = as fast as the device will push. */
  let frameRateDelay = 0
  let settings: KvmSettings = { ...DEFAULT_KVM_SETTINGS, ...initial }
  let rotation = settings.rotation
  let screenWidth = 640
  let screenHeight = 400
  /** Unrotated framebuffer size, kept so mouse coordinates survive a rotation. */
  let rwidth = 0
  let rheight = 0
  let buttonmask = 0
  let mx = 0
  let my = 0
  let ox = -1
  let oy = -1
  let focusMode = settings.showfocus ? 64 : 0
  let nagleTimer: number | null = null
  /** Scratch canvas for re-rotating the painted surface. */
  let tcanvas: HTMLCanvasElement | null = null

  /** Reusable tile buffer, keyed by "<w>x<h>" (amt-desktop-0.0.2.js:260). */
  let spare: ImageData | null = null
  let sparew = 0
  let spareh = 0
  /** Spare geometry after rotation, which swaps the axes on odd quarter turns. */
  let sparew2 = 0
  let spareh2 = 0
  const spareCache: Record<string, ImageData> = {}

  function send(x: string): void {
    channel?.Send(x)
  }

  function resize(w: number, h: number): void {
    canvas.width = rwidth = screenWidth = w
    canvas.height = rheight = screenHeight = h
    kvmScreen.value = { width: w, height: h }
    obj.onScreenSizeChange?.(w, h)
  }

  /**
   * Rotation offsets, ported from amt-desktop-0.0.2.js:538-584: arot* place a
   * tile in the rotated canvas, crot* map a canvas position back into
   * unrotated framebuffer space.
   */
  function arotX(x: number, y: number): number {
    if (rotation === 1) return canvas.width - sparew2 - y
    if (rotation === 2) return canvas.width - sparew2 - x
    if (rotation === 3) return y
    return x
  }

  function arotY(x: number, y: number): number {
    if (rotation === 1) return x
    if (rotation === 2) return canvas.height - spareh2 - y
    if (rotation === 3) return canvas.height - spareh - x
    return y
  }

  function crotX(x: number, y: number): number {
    if (rotation === 1) return y
    if (rotation === 2) return canvas.width - x
    if (rotation === 3) return canvas.height - y
    return x
  }

  function crotY(x: number, y: number): number {
    if (rotation === 1) return canvas.width - x
    if (rotation === 2) return canvas.height - y
    if (rotation === 3) return x
    return y
  }

  /** Map a linear index in the unrotated tile onto the rotated spare buffer. */
  function rotatedIndex(p: number): number {
    if (rotation === 0) return p
    const x = p % sparew
    const y = Math.floor(p / sparew)
    if (rotation === 1) return x * sparew2 + (sparew2 - 1 - y)
    if (rotation === 2) return sparew * spareh - 1 - p
    return (sparew2 - 1 - x) * sparew2 + y
  }

  function setPixel8(v: number, p: number): void {
    const pp = rotatedIndex(p) << 2
    const d = spare!.data
    if (graymode) {
      if (lowcolor) v <<= 4
      d[pp] = d[pp + 1] = d[pp + 2] = v
    } else {
      d[pp] = v & 224
      d[pp + 1] = (v & 28) << 3
      d[pp + 2] = fixColor((v & 3) << 6)
    }
  }

  function setPixel16(v: number, p: number): void {
    const pp = rotatedIndex(p) << 2
    const d = spare!.data
    d[pp] = (v >> 8) & 248
    d[pp + 1] = (v >> 3) & 252
    d[pp + 2] = (v & 31) << 3
  }

  function setPixel8run(v: number, p: number, run: number): void {
    const d = spare!.data
    let pp = p << 2
    if (graymode) {
      if (lowcolor) v <<= 4
      while (--run >= 0) {
        d[pp] = d[pp + 1] = d[pp + 2] = v
        pp += 4
      }
      return
    }
    const r = v & 224
    const g = (v & 28) << 3
    const b = fixColor((v & 3) << 6)
    while (--run >= 0) {
      d[pp] = r
      d[pp + 1] = g
      d[pp + 2] = b
      pp += 4
    }
  }

  function setPixel16run(v: number, p: number, run: number): void {
    const d = spare!.data
    const r = (v >> 8) & 248
    const g = (v >> 3) & 252
    const b = (v & 31) << 3
    let pp = p << 2
    while (--run >= 0) {
      d[pp] = r
      d[pp + 1] = g
      d[pp + 2] = b
      pp += 4
    }
  }

  function putImage(x: number, y: number): void {
    ctx!.putImageData(spare!, arotX(x, y), arotY(x, y))
  }

  /** Solid tiles skip ImageData entirely and go straight to a canvas fillRect. */
  function fillSolid(v: number, x: number, y: number, width: number, height: number): void {
    const c = ctx!
    if (graymode) {
      if (lowcolor) v <<= 4
      c.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')'
    } else {
      c.fillStyle =
        'rgb(' +
        (bpp === 1
          ? (v & 224) + ',' + ((v & 28) << 3) + ',' + fixColor((v & 3) << 6)
          : ((v >> 8) & 248) + ',' + ((v >> 3) & 252) + ',' + ((v & 31) << 3)) +
        ')'
    }
    c.fillRect(
      rotation === 2 ? x - canvas.width : rotation === 3 ? x - canvas.height : x,
      rotation === 1 ? y - canvas.width : rotation === 2 ? y - canvas.height : y,
      width,
      height,
    )
  }

  /**
   * RLE tile payload, sub-encoding from amt-desktop-0.0.2.js:335:
   *   0        raw pixels
   *   1        one solid colour for the whole tile
   *   2..16    packed palette, `br` bits per pixel taken from each byte
   *   128      flat RLE: colour then a 255-terminated run length
   *   129..255 palette RLE: a set high index bit marks a run
   */
  /**
   * Compressed RLE tiles, inflated in arrival order.
   *
   * `DecompressionStream('deflate-raw')` is the browser's own inflate -- legacy
   * shelled out to zlib-inflate.js, and 'raw' is the right mode because the
   * device emits headerless DEFLATE (legacy called `inflateInit(-15)`). Chained
   * promises keep tiles painting in the order the device sent them, which a bare
   * `inflate().then()` per tile would not.
   */
  let inflateChain: Promise<void> = Promise.resolve()

  function queueInflate(data: Uint8Array, x: number, y: number, width: number, height: number, s: number): void {
    inflateChain = inflateChain.then(async () => {
      try {
        const inflated = await inflateRawDeflate(data)
        if (inflated.length === 0) return
        decodeLRE(inflated, 0, x, y, width, height, s)
      } catch {
        // A malformed tile only costs us that tile; keep the session alive.
      }
    })
  }

  async function inflateRawDeflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Response(data as unknown as BodyInit)
      .body!.pipeThrough(new DecompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }

  function decodeLRE(data: Uint8Array, ptr: number, x: number, y: number, width: number, height: number, s: number): void {
    const sub = data[ptr++]
    const palette: number[] = []
    let rlecount = 0
    let i: number

    if (sub === 0) {
      // Raw pixels, little-endian RGB565 when bpp is 2.
      if (bpp === 2) {
        for (i = 0; i < s; i++) setPixel16(data[ptr++] + (data[ptr++] << 8), i)
      } else {
        for (i = 0; i < s; i++) setPixel8(data[ptr++], i)
      }
      putImage(x, y)
      return
    }

    if (sub === 1) {
      fillSolid(bpp === 2 ? data[ptr++] + (data[ptr++] << 8) : data[ptr++], x, y, width, height)
      return
    }

    if (sub < 17) {
      // Packed palette: br bits per pixel, 8 pixels per byte, high bits first.
      for (i = 0; i < sub; i++) palette[i] = bpp === 2 ? data[ptr++] + (data[ptr++] << 8) : data[ptr++]
      const br = sub === 2 ? 1 : sub <= 4 ? 2 : 4
      const bm = (1 << br) - 1
      while (rlecount < s && ptr < data.length) {
        const v = data[ptr++]
        for (i = 8 - br; i >= 0; i -= br) {
          const c = palette[(v >> i) & bm]
          if (bpp === 2) setPixel16(c, rlecount++)
          else setPixel8(c, rlecount++)
        }
      }
      putImage(x, y)
      return
    }

    if (sub === 128) {
      // Flat RLE. Runs are the only form that can skip pixels, so they are the
      // only one that has to respect the rotation index by index.
      while (rlecount < s && ptr < data.length) {
        const v = bpp === 2 ? data[ptr++] + (data[ptr++] << 8) : data[ptr++]
        let runlength = 1
        let n: number
        do {
          runlength += (n = data[ptr++])
        } while (n === 255)
        if (rotation === 0) {
          if (bpp === 2) setPixel16run(v, rlecount, runlength)
          else setPixel8run(v, rlecount, runlength)
          rlecount += runlength
        } else {
          while (--runlength >= 0) {
            if (bpp === 2) setPixel16(v, rlecount++)
            else setPixel8(v, rlecount++)
          }
        }
      }
      putImage(x, y)
      return
    }

    // Palette RLE.
    for (i = 0; i < sub - 128; i++) palette[i] = bpp === 2 ? data[ptr++] + (data[ptr++] << 8) : data[ptr++]
    while (rlecount < s && ptr < data.length) {
      let runlength = 1
      const index = data[ptr++]
      const v = palette[index % 128]
      if (index > 127) {
        let n: number
        do {
          runlength += (n = data[ptr++])
        } while (n === 255)
      }
      if (rotation === 0) {
        if (bpp === 2) setPixel16run(v, rlecount, runlength)
        else setPixel8run(v, rlecount, runlength)
        rlecount += runlength
      } else {
        while (--runlength >= 0) {
          if (bpp === 2) setPixel16(v, rlecount++)
          else setPixel8(v, rlecount++)
        }
      }
    }
    putImage(x, y)
  }

  /** Resize the scratch tile, recycling a cached one when the geometry matches. */
  function ensureSpare(width: number, height: number): void {
    if (sparew === width && spareh === height) return
    sparew = sparew2 = width
    spareh = spareh2 = height
    if (rotation === 1 || rotation === 3) {
      sparew2 = height
      spareh2 = width
    }
    const name = sparew2 + 'x' + spareh2
    spare = spareCache[name] ?? null
    if (spare == null) {
      spare = ctx!.createImageData(sparew2, spareh2)
      spareCache[name] = spare
      // Opaque, or putImageData would blend with whatever was underneath.
      const d = spare.data
      for (let i = 3; i < d.length; i += 4) d[i] = 0xff
    }
  }

  function sendRefresh(): void {
    if (focusMode > 0) {
      // Focus mode only repaints the box around the last mouse position.
      const df = focusMode * 2
      send(
        String.fromCharCode(3, 1) +
          shortToStr(Math.max(Math.min(ox, mx) - focusMode, 0)) +
          shortToStr(Math.max(Math.min(oy, my) - focusMode, 0)) +
          shortToStr(df + Math.abs(ox - mx)) +
          shortToStr(df + Math.abs(oy - my)),
      )
      ox = mx
      oy = my
    } else {
      send(String.fromCharCode(3, 1, 0, 0, 0, 0) + shortToStr(rwidth) + shortToStr(rheight))
    }
  }

  const obj: KvmSession = {
    protocol: 2,
    canvas,
    connectTime: 0,
    disconnectCode: 0,
    reverseMouseWheel: false,
    onScreenSizeChange: null,

    get state() {
      return state
    },
    get settings() {
      return settings
    },
    get screenWidth() {
      return screenWidth
    },
    get screenHeight() {
      return screenHeight
    },
    get mx() {
      return mx
    },
    get my() {
      return my
    },
    get rotation() {
      return rotation
    },
    set rotation(v: number) {
      rotation = ((v % 4) + 4) % 4
    },
    get focusMode() {
      return focusMode
    },
    set focusMode(v: number) {
      focusMode = v
    },

    attach(ch: RedirectChannel) {
      channel = ch
    },

    setSettings(s: Partial<KvmSettings>) {
      settings = { ...settings, ...s }
      if (s.rotation != null) rotation = ((s.rotation % 4) + 4) % 4
      if (s.showfocus === false) focusMode = 0
    },

    /** Reset the decoder; called by the page right before the channel starts. */
    Start() {
      state = RFB_VERSION
      acc = null
      nagleTimer = null
      bpp = settings.encflags & 2 ? 2 : 1
      useRLE = (settings.encflags & 1) !== 0
      graymode = (settings.encflags & 4) !== 0
      lowcolor = (settings.encflags & 16) !== 0
      frameRateDelay = settings.limitFrameRate ? 200 : 0
      obj.reverseMouseWheel = settings.reverseMouseWheel
      rotation = ((settings.rotation % 4) + 4) % 4
      buttonmask = 0
      mx = my = 0
      ox = oy = -1
      obj.connectTime = 0
      obj.disconnectCode = 0
      spare = null
      sparew = spareh = sparew2 = spareh2 = 0
      for (const k in spareCache) delete spareCache[k]
    },

    Send(data: Uint8Array | string) {
      channel?.Send(data)
    },

    xxStateChange(newstate: number) {
      kvmLinkState.value = newstate
      if (newstate !== 0) return
      // The transport dropped before any pixels moved: the target had no display
      // session (powered off, still booting, or at a disk-encryption prompt),
      // which is worth saying instead of showing a bare Disconnected.
      if (!everStreamed && obj.disconnectCode === 0) obj.disconnectCode = DISCONNECT.NO_DISPLAY
      everStreamed = false
      state = RFB_VERSION
      acc = null
      if (nagleTimer != null) {
        clearTimeout(nagleTimer)
        nagleTimer = null
      }
      ctx!.fillStyle = '#000000'
      ctx!.fillRect(0, 0, canvas.width, canvas.height)
      resize(640, 400)
    },

    ProcessBinaryData(data: Uint8Array) {
      acc = acc == null ? new Uint8Array(data) : concat(acc, data)

      while (acc != null && acc.length > 0) {
        let cmdsize = 0
        const v = new DataView(acc.buffer, acc.byteOffset, acc.byteLength)

        if (state === RFB_VERSION && acc.length >= 12) {
          // "RFB 003.008\n" in, "RFB 003.008\n" out. Auth is a no-op because
          // the websocket was already authenticated against AMT.
          cmdsize = 12
          state = RFB_SECURITY_TYPES
          send('RFB 003.008\n')
        } else if (state === RFB_SECURITY_TYPES && acc.length >= 1) {
          cmdsize = acc[0] + 1
          send(String.fromCharCode(1)) // the 'None' security type
          state = RFB_SECURITY_RESULT
        } else if (state === RFB_SECURITY_RESULT && acc.length >= 4) {
          cmdsize = 4
          if (v.getUint32(0) !== 0) {
            channel?.Stop(DISCONNECT.UNSUPPORTED)
            return
          }
          send(String.fromCharCode(1)) // shared desktop flag
          state = RFB_SERVER_INIT
          obj.disconnectCode = DISCONNECT.KVM_DISCONNECT
        } else if (state === RFB_SERVER_INIT && acc.length >= 24) {
          const namelen = v.getUint32(20)
          if (acc.length < 24 + namelen) return
          cmdsize = 24 + namelen
          // Only width and height are read: we force RGB565 or RGB332 and
          // ignore the pixel format the device offers (amt-desktop-0.0.2.js:142).
          resize(v.getUint16(0), v.getUint16(2))

          // SetEncodings. AMT will not let us omit RAW. The count is taken
          // before Desktop Size is appended, exactly as legacy builds it
          // (amt-desktop-0.0.2.js:174) -- AMT accepts the odd count.
          let encodings = ''
          if (useRLE) encodings += intToStr(16)
          encodings += intToStr(0)
          send(String.fromCharCode(2, 0) + shortToStr(encodings.length / 4 + 1) + encodings + intToStr(ENC_DESKTOP_SIZE))

          if (!graymode) {
            // 16-bit RGB565 is the AMT default, 8-bit has to be asked for.
            if (bpp === 1) {
              send(
                String.fromCharCode(0, 0, 0, 0, 8, 8, 0, 1) +
                  shortToStr(7) +
                  shortToStr(7) +
                  shortToStr(3) +
                  String.fromCharCode(5, 2, 0, 0, 0, 0),
              )
            }
          } else if (bpp === 2) {
            // Grayscale is never more than 8 bits wide.
            bpp = 1
          } else if (!lowcolor) {
            send(String.fromCharCode(0, 0, 0, 0, 8, 8, 0, 1) + shortToStr(255) + shortToStr(0) + shortToStr(0) + String.fromCharCode(0, 0, 0, 0, 0, 0))
          } else {
            send(String.fromCharCode(0, 0, 0, 0, 8, 4, 0, 1) + shortToStr(15) + shortToStr(0) + shortToStr(0) + String.fromCharCode(0, 0, 0, 0, 0, 0))
          }

          state = RFB_STREAM
          everStreamed = true
          obj.connectTime = Date.now()
          obj.disconnectCode = DISCONNECT.AMT_DISCONNECT
          // The link is only usable once the device has handed us a framebuffer.
          // Without this the page stays non-live and silently drops all input.
          obj.xxStateChange(3)
          sendRefresh()
          if (bpp * screenWidth * screenHeight > MAX_BUFFER) obj.disconnectCode = DISCONNECT.BUFFER_OVERFLOW
        } else if (state === RFB_STREAM) {
          switch (acc[0]) {
            case 0: // FramebufferUpdate: type, pad, number-of-rectangles
              if (acc.length < 4) return
              state = 100 + v.getUint16(2)
              cmdsize = 4
              // AMT always sends at least one rectangle, but a zero-length
              // update would park the state machine at 100 forever.
              if (state === 100) {
                state = RFB_STREAM
                sendRefresh()
              }
              break
            case 2: // bell, nothing to do
              cmdsize = 1
              break
            case 3: {
              // ServerCutText. The inband KVM data channel that used to consume
              // this is not part of the firmware build, so just step over it.
              if (acc.length < 8) return
              const len = v.getUint32(4) + 8
              if (acc.length < len) return
              cmdsize = len
              break
            }
          }
        } else if (state > 100 && acc.length >= 12) {
          const x = v.getUint16(0)
          const y = v.getUint16(2)
          const width = v.getUint16(4)
          const height = v.getUint16(6)
          const s = width * height
          const encoding = v.getUint32(8)

          if (encoding < 17) {
            if (width < 1 || width > MAX_TILE || height < 1 || height > MAX_TILE) {
              channel?.Stop(DISCONNECT.KVM_DISCONNECT)
              return
            }
            ensureSpare(width, height)
          }

          if (encoding === 0xffffff21) {
            // Desktop Size: the display resolution changed under us.
            resize(width, height)
            send(String.fromCharCode(3, 0, 0, 0, 0, 0) + shortToStr(screenWidth) + shortToStr(screenHeight))
            cmdsize = 12
            if (bpp * screenWidth * screenHeight > MAX_BUFFER) obj.disconnectCode = DISCONNECT.BUFFER_OVERFLOW
          } else if (encoding === 0) {
            // RAW: width * height pixels straight after the 12-byte header.
            const cs = 12 + s * bpp
            if (acc.length < cs) return
            cmdsize = cs
            if (bpp === 2) {
              let ptr = 12
              for (let i = 0; i < s; i++) {
                setPixel16(v.getUint16(ptr, true), i)
                ptr += 2
              }
            } else {
              let ptr = 12
              for (let i = 0; i < s; i++) setPixel8(acc[ptr++], i)
            }
            putImage(x, y)
          } else if (encoding === 16) {
            // RLE: an optional 5-byte zlib header plus the LRE payload.
            if (acc.length < 16) return
            const datalen = v.getUint32(12)
            if (acc.length < 16 + datalen) return
            if (datalen > 5 && acc[16] === 0 && v.getUint16(17, true) === datalen - 5) {
              decodeLRE(acc.subarray(21, 16 + datalen), 0, x, y, width, height, s)
            } else {
              // Compressed block. Inflate is async, so it cannot run inside this
              // synchronous drain; queue it and paint in arrival order.
              queueInflate(acc.slice(16, 16 + datalen), x, y, width, height, s)
            }
            cmdsize = 16 + datalen
          } else {
            channel?.Stop(DISCONNECT.UNSUPPORTED)
            return
          }

          if (--state === 100) {
            state = RFB_STREAM
            if (frameRateDelay === 0) sendRefresh()
            else setTimeout(sendRefresh, frameRateDelay)
          }
        }

        if (cmdsize === 0) return
        acc = cmdsize === acc.length ? null : acc.slice(cmdsize)
      }
    },

    setRotation(turns: number): boolean {
      while (turns < 0) turns += 4
      const next = turns % 4
      if (next === rotation) return true
      if (tcanvas == null) tcanvas = document.createElement('canvas')
      const tctx = tcanvas.getContext('2d')!

      // Undo the current rotation into the scratch canvas...
      let rw = canvas.width
      let rh = canvas.height
      if (rotation === 1 || rotation === 3) {
        rw = canvas.height
        rh = canvas.width
      }
      tctx.setTransform(1, 0, 0, 1, 0, 0)
      tcanvas.width = rw
      tcanvas.height = rh
      tctx.rotate(rotation * -90 * (Math.PI / 180))
      tctx.drawImage(
        canvas,
        rotation === 1 || rotation === 2 ? -canvas.width : 0,
        rotation === 2 || rotation === 3 ? -canvas.height : 0,
      )

      // ...and apply the new one.
      if (rotation === 0 || rotation === 2) {
        canvas.height = rw
        canvas.width = rh
      } else {
        canvas.height = rh
        canvas.width = rw
      }
      ctx!.setTransform(1, 0, 0, 1, 0, 0)
      ctx!.rotate(next * 90 * (Math.PI / 180))
      rotation = next
      ctx!.drawImage(
        tcanvas,
        rotation === 2 ? -canvas.width : rotation === 3 ? -canvas.height : 0,
        rotation === 1 ? -canvas.width : rotation === 2 ? -canvas.height : 0,
      )
      ctx!.setTransform(1, 0, 0, 1, 0, 0)
      obj.onScreenSizeChange?.(canvas.width, canvas.height)
      return true
    },

    sendKey(keysym: number, down: number) {
      // KeyEvent: type, down flag, 2 pad, big-endian keysym.
      send(String.fromCharCode(4, down, 0, 0) + intToStr(keysym))
    },

    sendKeys(seq: KeySeq) {
      let buf = ''
      for (const [k, d] of seq) buf += String.fromCharCode(4, d, 0, 0) + intToStr(k)
      send(buf)
    },

    sendCad() {
      obj.sendKeys([
        [0xffe3, 1],
        [0xffe9, 1],
        [0xffff, 1],
        [0xffff, 0],
        [0xffe9, 0],
        [0xffe3, 0],
      ])
    },

    onKeyDown(e: KeyboardEvent) {
      const k = convertAmtKeyCode(e)
      if (k != null) obj.sendKey(k, 1)
      e.preventDefault()
    },

    onKeyUp(e: KeyboardEvent) {
      const k = convertAmtKeyCode(e)
      if (k != null) obj.sendKey(k, 0)
      e.preventDefault()
    },

    /** Map a page coordinate onto the remote framebuffer and inject it. */
    onMouseMove(e: MouseEvent, force?: boolean) {
      injectMouse(e, force === true)
    },

    onMouseDown(e: MouseEvent) {
      buttonmask |= 1 << e.button
      injectMouse(e, true)
    },

    onMouseUp(e: MouseEvent) {
      buttonmask &= 0xffff - (1 << e.button)
      injectMouse(e, true)
    },

    onMouseWheel(e: WheelEvent) {
      // A positive delta means scroll up, which AMT models as button 3.
      let v = -e.deltaY
      if (v === 0) return
      if (obj.reverseMouseWheel) v = -v
      const tmp = buttonmask
      buttonmask |= 1 << (v > 0 ? 3 : 4)
      injectMouse(e, true)
      buttonmask = tmp
      injectMouse(e, true)
      e.preventDefault()
    },
  }

  function injectMouse(e: MouseEvent, force: boolean): void {
    if (state < RFB_STREAM) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    mx = (e.clientX - rect.left) * (canvas.width / rect.width)
    my = (e.clientY - rect.top) * (canvas.height / rect.height)

    // Rotated surfaces are wider or taller than the framebuffer behind them.
    if (rotation === 1 || rotation === 3) {
      mx = (mx * rwidth) / canvas.width
      my = (my * rheight) / canvas.height
    }
    if (!settings.noMouseRotate) {
      const cx = crotX(mx, my)
      my = crotY(mx, my)
      mx = cx
    }

    const packet = () => send(String.fromCharCode(5, buttonmask) + shortToStr(mx) + shortToStr(my))
    if (force) {
      packet()
      if (nagleTimer != null) {
        clearTimeout(nagleTimer)
        nagleTimer = null
      }
    } else if (nagleTimer == null) {
      // Throttle motion so a fast pointer does not flood the device.
      nagleTimer = setTimeout(() => {
        packet()
        nagleTimer = null
      }, 50)
    }
  }

  return obj
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const merged = new Uint8Array(a.length + b.length)
  merged.set(a, 0)
  merged.set(b, a.length)
  return merged
}

function convertAmtKeyCode(e: KeyboardEvent): number | undefined {
  const code = e.code
  if (code.startsWith('Key') && code.length === 4) return code.charCodeAt(3) + (e.shiftKey ? 0 : 32)
  if (code.startsWith('Digit') && code.length === 6) return code.charCodeAt(5)
  if (code.startsWith('Numpad') && code.length === 7) return code.charCodeAt(6)
  return AMT_KEYSYMS[code]
}