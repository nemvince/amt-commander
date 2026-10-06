/**
 * VT100 terminal model for Serial-over-LAN.
 *
 * Ported from amt-terminal-0.0.2.js. The model knows nothing about websockets:
 * device data arrives through write(), keystrokes leave through the onSend
 * callback as a plain string ready for the redirect channel. Rendering is a pure
 * function of the grid, so the page can paint it into a <pre>.
 *
 * Deliberate deviations from the legacy file, all bug fixes that no well-behaved
 * stream can tell apart from the original: the cursor cannot be left outside the
 * grid (the legacy CSI B/C clamps let it run past the last row, where the next
 * erase threw), SU/SD/DL blank their last row, ED 1 erases from the start of the
 * screen to the cursor, SGR 90-109 stop indexing past the palette, and CSI 0 P
 * deletes one character instead of clearing the whole line.
 */
import { FEAT_TerminalEnumationAll, FEAT_TerminalFxEnumationAll } from '../features'

/** 0 = UTF-8, 1 = extended ASCII (CP437), 2 = Intel extended ASCII. */
export type TerminalEmulation = 0 | 1 | 2
/** 0 = Intel, 1 = Alternate, 2 = VT100+. */
export type FxEmulation = 0 | 1 | 2

/** The slice of a keyboard event the emulator needs. */
export interface KeyLike {
  which: number
  ctrlKey?: boolean
  repeat?: boolean
  preventDefault?: () => void
  stopPropagation?: () => void
}

export interface TerminalOptions {
  width?: number
  height?: number
  /** Encoded keystrokes; hand the string straight to the redirect channel. */
  onSend?: (keys: string) => void
}

export interface Terminal {
  width: number
  height: number
  emulation: TerminalEmulation
  fxEmulation: FxEmulation
  /** What the Return key sends: '\r\n' or '\n'. */
  lineFeed: string
  /** The visible screen, one string per row. */
  screen(): string[]
  /** Scrollback plus screen, colour-attributed, ready for a <pre>. */
  html(): string
  write(data: string): void
  resize(width: number, height: number): void
  reset(): void
  sendKey(code: number): void
  sendKeys(keys: string): void
  handleKeyDown(e: KeyLike): void
  handleKeyPress(e: KeyLike): void
  handleKeyUp(e: KeyLike): void
}

/** ANSI palette, verbatim from amt-terminal-0.0.2.js:30. */
const COLORS = [
  '000000',
  'BB0000',
  '00BB00',
  'BBBB00',
  '0000BB',
  'BB00BB',
  '00BBBB',
  'BBBBBB',
  '555555',
  'FF5555',
  '55FF55',
  'FFFF55',
  '5555FF',
  'FF55FF',
  '55FFFF',
  'FFFFFF',
]

const VT_REVERSE = 2
/** Attribute of a blank cell: light grey on black. */
const BLANK_ATT = 7 << 6
/** Scrolled-off lines kept above the screen (legacy keeps 800). */
const SCROLLBACK_MAX = 800

// Escape-sequence states.
const ST_NORMAL = 0
const ST_ESC = 1
const ST_CSI = 2
const ST_CHARSET = 4
const ST_OSC = 6

/** CP437 high half, the byte-to-character table of amt-terminal-0.0.2.js:438. */
const CP437 = [
  0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7, 0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee,
  0x00ec, 0x00c4, 0x00c5, 0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9, 0x00ff, 0x00d6,
  0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192, 0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa,
  0x00da, 0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb, 0x2593, 0x2592, 0x2591, 0x2502,
  0x2524, 0x2561, 0x2562, 0x2556, 0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510, 0x2514,
  0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f, 0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550,
  0x256c, 0x2567, 0x2568, 0x2564, 0x2565, 0x2568, 0x2558, 0x2552, 0x2553, 0x256b, 0x256a, 0x2518, 0x250c,
  0x2588, 0x2584, 0x258b, 0x2590, 0x2580, 0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4,
  0x03c6, 0x03b8, 0x2126, 0x03b4, 0x221e, 0x00f8, 0x03b5, 0x220f, 0x2261, 0x00b1, 0x2265, 0x2266, 0x2320,
  0x2321, 0x00f7, 0x2248, 0x00b0, 0x2022, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x220e, 0x00a0,
]
/** The Intel table differs from CP437 in exactly one cell: index 46. */
const CP437_INTEL = CP437.with(46, 0x00ae)

/** Cells of one attribute share a span; cache the markup per attribute. */
const SPANS = new Map<number, string>()
function spanOpen(att: number): string {
  let s = SPANS.get(att)
  if (s === undefined) {
    // SGR 7, and the cursor cell, swap the two colours.
    const fg = (att >> (att & VT_REVERSE ? 12 : 6)) & 0x0f
    const bg = (att >> (att & VT_REVERSE ? 6 : 12)) & 0x0f
    s = '<span style="color:#' + COLORS[fg] + ';background-color:#' + COLORS[bg] + '">'
    SPANS.set(att, s)
  }
  return s
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

class Vt100 implements Terminal {
  width: number
  height: number
  emulation: TerminalEmulation = FEAT_TerminalEnumationAll ? 1 : 0
  fxEmulation: FxEmulation = 0
  lineFeed = '\r\n'

  private chars: string[][]
  private atts: number[][]
  private scrollback: string[] = []

  private x = 0
  private y = 0
  private saveX = 0
  private saveY = 0
  private escState = ST_NORMAL
  /** Dense CSI parameters: one entry per ';', so length is the parameter count. */
  private args: number[] = []
  private escPrivate = 0
  private regionTop = 0
  private regionBottom: number
  private lineWrap = true
  private altKeypad = false
  private cursorVisible = true
  private fColor = 7
  private bColor = 0
  private reverse = 0
  /** Streaming UTF-8 decoder; it holds the tail of a split code point. */
  private utf8 = new TextDecoder()
  private onSend: (keys: string) => void

  constructor(opts: TerminalOptions) {
    this.width = opts.width || 80
    this.height = opts.height || 25
    this.regionBottom = this.height - 1
    this.onSend = opts.onSend ?? (() => {})
    this.chars = []
    this.atts = []
    this.alloc(this.width, this.height)
    this.reset()
  }

  private alloc(width: number, height: number): void {
    this.chars = new Array(height)
    this.atts = new Array(height)
    for (let y = 0; y < height; y++) {
      const chars = new Array<string>(width).fill(' ')
      const atts = new Array<number>(width).fill(BLANK_ATT)
      this.chars[y] = chars
      this.atts[y] = atts
    }
  }

  /** RIS: full device reset, as TermResetScreen does in legacy. */
  reset(): void {
    this.lineWrap = true
    this.cursorVisible = true
    this.fColor = 7
    this.bColor = 0
    this.reverse = 0
    this.x = 0
    this.y = 0
    this.regionTop = 0
    this.regionBottom = this.height - 1
    this.altKeypad = false
    this.scrollback = []
    this.utf8.decode() // flush and drop any half-decoded code point
    for (let y = 0; y < this.height; y++) this.blank(y, BLANK_ATT)
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.alloc(width, height)
    this.reset()
  }

  // ---------------------------------------------------------------- rendering

  screen(): string[] {
    const rows: string[] = new Array(this.height)
    for (let y = 0; y < this.height; y++) rows[y] = this.chars[y].join('')
    return rows
  }

  html(): string {
    const rows = this.scrollback.length > 0 ? this.scrollback.slice() : []
    for (let y = 0; y < this.height; y++) rows.push(this.renderLine(y))
    return rows.join('\n')
  }

  private renderLine(y: number): string {
    const chars = this.chars[y]
    const atts = this.atts[y]
    let out = ''
    let x = 0
    while (x < this.width) {
      // The cursor is drawn by swapping its colours, as legacy does.
      let att = atts[x]
      if (this.cursorVisible && this.x === x && this.y === y) att |= VT_REVERSE
      let end = x + 1
      while (end < this.width) {
        let next = atts[end]
        if (this.cursorVisible && this.x === end && this.y === y) next |= VT_REVERSE
        if (next !== att) break
        end++
      }
      const text = chars
        .slice(x, end)
        .join('')
        .replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
      out += spanOpen(att) + text + '</span>'
      x = end
    }
    return out
  }

  // ----------------------------------------------------------------- incoming

  write(data: string): void {
    // In UTF-8 mode the device sends raw UTF-8 bytes, which can be split across
    // redirect frames; the streaming decoder reassembles them.
    if (FEAT_TerminalEnumationAll && this.emulation === 0) {
      const bytes = new Uint8Array(data.length)
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff
      data = this.utf8.decode(bytes, { stream: true })
    }
    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i)
      this.esc(data.charAt(i), c)
    }
  }

  /** The escape-sequence state machine. */
  private esc(b: string, c: number): void {
    switch (this.escState) {
      case ST_ESC:
        switch (b) {
          case '[':
            this.args = [0]
            this.escPrivate = 0
            this.escState = ST_CSI
            return
          case '(':
          case ')':
            this.escState = ST_CHARSET
            return
          case ']':
            this.escState = ST_OSC
            return
          case '=':
            this.altKeypad = true // alternate keypad
            break
          case '>':
            this.altKeypad = false // numeric keypad
            break
          case '7':
            this.saveX = this.x
            this.saveY = this.y
            break
          case '8':
            this.x = this.saveX
            this.y = this.saveY
            break
          case 'M':
            this.scrollDown(1) // reverse index
            break
        }
        break

      case ST_CSI: {
        const last = this.args.length - 1
        if (c >= 0x30 && c <= 0x39) {
          this.args[last] = this.args[last] * 10 + (c - 0x30)
          return
        }
        if (b === ';') {
          this.args.push(0)
          return
        }
        if (b === '?') {
          this.escPrivate = 1
          return
        }
        this.sequence(b)
        break
      }

      case ST_CHARSET:
        break

      case ST_OSC:
        // OSC strings carry the window title, which nothing here displays; they
        // are consumed so they do not leak onto the screen. BEL ends them.
        if (c === 7) break
        return

      default:
        if (c === 27) {
          this.escState = ST_ESC
          return
        }
        this.print(b, c)
        return
    }
    this.escState = ST_NORMAL
  }

  /** A CSI with its final byte. */
  private sequence(code: string): void {
    const args = this.args
    const n = args.length
    const a0 = args[0]
    if (this.escPrivate === 1) {
      // DECTCEM: show or hide the cursor.
      if (a0 === 25) this.cursorVisible = code === 'h'
      return
    }
    switch (code) {
      case 'c': // RIS
        this.reset()
        return
      case 'A': // CUU, default 1 line
        if (n === 1) this.y = Math.max(0, this.y - (a0 || 1))
        return
      case 'B': // CUD
        if (n === 1) this.y = Math.min(this.height - 1, this.y + (a0 || 1))
        return
      case 'C': // CUF
        if (n === 1) this.x = Math.min(this.width - 1, this.x + (a0 || 1))
        return
      case 'D': // CUB
        if (n === 1) this.x = Math.max(0, this.x - (a0 || 1))
        return
      case 'd': // VPA
        if (n === 1) this.y = clamp(a0 - 1, 0, this.height - 1)
        return
      case 'G': // CHA
        if (n === 1) this.x = clamp(a0 - 1, 0, this.width - 1)
        return
      case 'H': // CUP
        if (n === 2) {
          this.y = clamp(Math.max(1, args[0]), 1, this.height) - 1
          this.x = clamp(Math.max(1, args[1]), 1, this.width) - 1
        } else {
          this.y = 0
          this.x = 0
        }
        return
      case 'P': // DCH
        this.deleteChars(Math.max(1, a0))
        return
      case 'X': // ECH
        this.eraseChars(Math.max(1, a0))
        return
      case 'L': // IL
        this.insertLines(Math.max(1, a0))
        return
      case 'M': // DL
        this.deleteLines(Math.max(1, a0))
        return
      case 'S': // SU
        this.scrollUp(Math.max(1, a0))
        return
      case 'T': // SD
        this.scrollDown(Math.max(1, a0))
        return
      case 'J':
        this.eraseDisplay(a0)
        return
      case 'K':
        this.eraseLine(a0)
        return
      case 'm':
        this.attributes(args)
        return
      case 'h': // autowrap on
        this.lineWrap = true
        return
      case 'l': // autowrap off
        this.lineWrap = false
        return
      case 'r': // DECSTBM
        if (n === 2) {
          this.regionTop = clamp(args[0] - 1, 0, this.height - 1)
          this.regionBottom = clamp(args[1] - 1, 0, this.height - 1)
          if (this.regionTop > this.regionBottom) this.regionTop = this.regionBottom
        }
        return
    }
  }

  private attributes(args: readonly number[]): void {
    for (let i = 0; i < args.length; i++) {
      const v = args[i]
      if (!v) {
        this.bColor = 0
        this.fColor = 7
        this.reverse = 0
      } else if (v === 1) {
        if (this.fColor < 8) this.fColor += 8
      } else if (v === 2 || v === 22) {
        if (this.fColor >= 8) this.fColor -= 8
      } else if (v === 7) {
        this.reverse = VT_REVERSE
      } else if (v === 27) {
        this.reverse = 0
      } else if (v >= 30 && v <= 37) {
        const bright = this.fColor >= 8
        this.fColor = v - 30
        if (bright) this.fColor += 8
      } else if (v >= 40 && v <= 47) {
        this.bColor = v - 40
      } else if (v >= 90 && v <= 99) {
        this.fColor = Math.min(15, v - 82)
      } else if (v >= 100 && v <= 109) {
        this.bColor = Math.min(15, v - 92)
      }
    }
  }

  // ------------------------------------------------------------------ drawing

  private att(): number {
    return (this.fColor << 6) + (this.bColor << 12) + this.reverse
  }

  private blank(y: number, att: number): void {
    this.chars[y].fill(' ')
    this.atts[y].fill(att)
  }

  private eraseSpan(y: number, from: number, to: number, att: number): void {
    const chars = this.chars[y]
    const atts = this.atts[y]
    for (let x = from; x < to; x++) {
      chars[x] = ' '
      atts[x] = att
    }
  }

  /** A character cell. C1 bytes are not special: legacy renders them as text. */
  private print(b: string, c: number): void {
    if (c === 0 || c === 7) return // NUL and BEL
    if (FEAT_TerminalEnumationAll && (c & 0x80) !== 0) {
      if (this.emulation === 1) b = String.fromCharCode(CP437[c & 0x7f])
      else if (this.emulation === 2) b = String.fromCharCode(CP437_INTEL[c & 0x7f])
    }
    switch (c) {
      case 16: // Intel BIOSes emit these three as displayable characters.
        b = ' '
        break
      case 24:
        b = '↑'
        break
      case 25:
        b = '↓'
        break
      case 8: // backspace
        if (this.x > 0) this.x--
        return
      case 9: // tab
        for (let i = 8 - (this.x % 8); i > 0; i--) this.print(' ', 32)
        return
      case 10: // linefeed
        this.y++
        if (this.y > this.regionBottom) {
          this.recordScrollback(this.regionTop)
          this.scrollUp(1)
          this.y = this.regionBottom
        }
        // Cooked mode (the CR+LF setting): linefeed also returns to column one.
        if (this.lineFeed === '\r\n') this.x = 0
        return
      case 13: // carriage return
        this.x = 0
        return
    }
    if (this.x >= this.width) {
      this.x = 0
      if (this.lineWrap) this.y++
      if (this.y >= this.height - 1) {
        this.scrollUp(1)
        this.y = this.height - 1
      }
    }
    this.chars[this.y][this.x] = b
    this.atts[this.y][this.x] = this.att()
    this.x++
  }
  private recordScrollback(y: number): void {
    this.scrollback.push(this.renderLine(y))
    if (this.scrollback.length > SCROLLBACK_MAX) {
      this.scrollback.splice(0, this.scrollback.length - SCROLLBACK_MAX)
    }
  }

  /** One row onto another; the rows are separate arrays, so this is a copy. */
  private copyRow(dst: number, src: number): void {
    const chars = this.chars[dst]
    const atts = this.atts[dst]
    const from = this.chars[src]
    const fromAtts = this.atts[src]
    for (let x = 0; x < this.width; x++) {
      chars[x] = from[x]
      atts[x] = fromAtts[x]
    }
  }

  /** Scroll the region up, blanking the rows that fall off the bottom. */
  private scrollUp(n: number): void {
    n = Math.min(n, this.regionBottom - this.regionTop + 1)
    for (let y = this.regionTop; y <= this.regionBottom - n; y++) this.copyRow(y, y + n)
    for (let y = this.regionBottom - n + 1; y <= this.regionBottom; y++) this.blank(y, BLANK_ATT)
  }

  /** Reverse index: scroll the region down, blanking the rows that come in. */
  private scrollDown(n: number): void {
    n = Math.min(n, this.regionBottom - this.regionTop + 1)
    for (let y = this.regionBottom; y >= this.regionTop + n; y--) this.copyRow(y, y - n)
    for (let y = this.regionTop; y < this.regionTop + n; y++) this.blank(y, BLANK_ATT)
  }

  private deleteChars(n: number): void {
    const chars = this.chars[this.y]
    const atts = this.atts[this.y]
    for (let x = this.x; x < this.width - n; x++) {
      chars[x] = chars[x + n]
      atts[x] = atts[x + n]
    }
    for (let x = Math.max(this.x, this.width - n); x < this.width; x++) {
      chars[x] = ' '
      atts[x] = BLANK_ATT
    }
  }

  private eraseChars(n: number): void {
    let x = this.x
    let y = this.y
    while (n > 0 && y < this.height) {
      this.chars[y][x] = ' '
      this.atts[y][x] = BLANK_ATT
      if (++x >= this.width) {
        x = 0
        y++
      }
      n--
    }
  }

  private insertLines(n: number): void {
    if (this.y < this.regionTop || this.y > this.regionBottom) return
    n = Math.min(n, this.regionBottom - this.y + 1)
    for (let y = this.regionBottom; y >= this.y + n; y--) this.copyRow(y, y - n)
    for (let y = this.y; y < this.y + n; y++) this.blank(y, BLANK_ATT)
  }

  private deleteLines(n: number): void {
    if (this.y < this.regionTop || this.y > this.regionBottom) return
    n = Math.min(n, this.regionBottom - this.y + 1)
    for (let y = this.y; y <= this.regionBottom - n; y++) this.copyRow(y, y + n)
    for (let y = this.regionBottom - n + 1; y <= this.regionBottom; y++) this.blank(y, BLANK_ATT)
  }

  private eraseDisplay(mode: number): void {
    const att = this.att()
    if (mode === 2) {
      for (let y = 0; y < this.height; y++) this.blank(y, att)
      this.x = 0
      this.y = 0
      this.scrollback = []
    } else if (mode === 1) {
      this.eraseSpan(this.y, 0, this.x + 1, att)
      for (let y = 0; y < this.y; y++) this.blank(y, att)
    } else {
      this.eraseSpan(this.y, this.x, this.width, att)
      for (let y = this.y + 1; y < this.height; y++) this.blank(y, att)
    }
  }

  private eraseLine(mode: number): void {
    const att = this.att()
    if (mode === 1) this.eraseSpan(this.y, 0, this.x + 1, att)
    else if (mode === 2) this.blank(this.y, att)
    else this.eraseSpan(this.y, this.x, this.width, att)
  }

  // ------------------------------------------------------------------ outgoing

  sendKey(code: number): void {
    this.onSend(String.fromCharCode(code))
  }

  sendKeys(keys: string): void {
    this.onSend(keys)
  }

  /** keypress: printable characters and Return. */
  handleKeyPress(e: KeyLike): void {
    if (e.ctrlKey) {
      e.preventDefault?.()
      e.stopPropagation?.()
      return
    }
    if (e.which === 127) this.sendKey(8)
    else if (e.which === 13) this.sendKeys(this.lineFeed)
    else if (e.which !== 0) this.sendKey(e.which)
  }

  handleKeyUp(e: KeyLike): void {
    if (e.which !== 8 && e.which !== 32 && e.which !== 9) return
    e.preventDefault?.()
    e.stopPropagation?.()
  }

  /** keydown: control keys, the arrow/paging block, and F1 to F12. */
  handleKeyDown(e: KeyLike): void {
    const w = e.which
    if (w >= 65 && w <= 90 && e.ctrlKey === true) {
      this.sendKey(w - 64) // Ctrl-A..Ctrl-Z
      e.preventDefault?.()
      e.stopPropagation?.()
      return
    }
    if (w === 27) {
      this.sendKeys('\x1b')
      return
    }

    const alt = this.altKeypad
    switch (w) {
      case 37:
        this.sendKeys(alt ? '\x1bOD' : '\x1b[D')
        return
      case 38:
        this.sendKeys(alt ? '\x1bOA' : '\x1b[A')
        return
      case 39:
        this.sendKeys(alt ? '\x1bOC' : '\x1b[C')
        return
      case 40:
        this.sendKeys(alt ? '\x1bOB' : '\x1b[B')
        return
      case 33:
        this.sendKeys('\x1b[5~')
        return
      case 34:
        this.sendKeys('\x1b[6~')
        return
      case 35:
        this.sendKeys('\x1b[F')
        return
      case 36:
        this.sendKeys('\x1b[H')
        return
      case 45:
        this.sendKeys('\x1b[2~')
        return
      case 46:
        this.sendKeys('\x1b[3~')
        return
      case 9:
        this.sendKeys('\t')
        e.preventDefault?.()
        e.stopPropagation?.()
        return
    }

    if (FEAT_TerminalFxEnumationAll && w > 111 && w < 124 && e.repeat !== true) {
      const i = w - 112
      const intel = [80, 81, 119, 120, 116, 117, 113, 114, 112, 77]
      const alternate = [49, 50, 51, 52, 53, 54, 55, 56, 57, 48, 33, 64]
      const vt100plus = [80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91]
      if (this.fxEmulation === 0 && w < 122) {
        this.sendKeys('\x1b[O' + String.fromCharCode(intel[i]))
        return
      }
      if (this.fxEmulation === 1) {
        this.sendKeys('\x1b' + String.fromCharCode(alternate[i]))
        return
      }
      if (this.fxEmulation === 2) {
        this.sendKeys('\x1bO' + String.fromCharCode(vt100plus[i]))
        return
      }
    }

    if (w !== 8 && w !== 32 && w !== 9) return
    this.sendKey(w)
    e.preventDefault?.()
    e.stopPropagation?.()
  }
}

export function createTerminal(opts: TerminalOptions = {}): Terminal {
  return new Vt100(opts)
}
