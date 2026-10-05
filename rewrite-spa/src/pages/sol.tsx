import { useEffect, useRef, useState } from 'preact/hooks'
import { FEAT_IDER, FEAT_TerminalEnumationAll, FEAT_TerminalSize } from '../features'
import { createRedirect, type RedirectChannel, type RedirectModule } from '../lib/redirect'
import { createTerminal, type Terminal, type TerminalEmulation } from '../lib/terminal'
import { S } from '../strings'
import { IderBar } from '../ui/ider-bar'

/** Redirection states, in redirect-channel order. */
const STATES = [S.disconnected, S.connecting, S.solSettingUp, S.connected]

const SIZE_KEY = 'solsize'
const SIZES = [
  { w: 80, h: 25 },
  { w: 100, h: 30 },
]

/** The legacy size toggle remembers nothing; persisting it is the one upgrade. */
function storedSize(): { w: number; h: number } {
  try {
    if (localStorage.getItem(SIZE_KEY) === '100x30') return SIZES[1]
  } catch {
    // Storage can be unavailable; fall back to the default size.
  }
  return SIZES[0]
}

/**
 * Serial-over-LAN, the rewrite of legacy view 13. The redirect channel carries
 * the session; the terminal model owns everything else.
 *
 * IDER rides the same view in legacy (index.html:947-952) and hooks in here at
 * `session` below: it only needs the module identity of the live channel, so a
 * mounted IDER overlay can attach its own protocol-3 channel to this page.
 */
export function SolPage() {
  const screenRef = useRef<HTMLPreElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const channel = useRef<RedirectChannel | null>(null)
  const model = useRef<Terminal | null>(null)
  const [tick, setTick] = useState(0)
  const [state, setState] = useState(0)
  const [size, setSize] = useState(storedSize)

  if (model.current == null) {
    const terminal = createTerminal({
      width: size.w,
      height: size.h,
      onSend: (keys) => channel.current?.Send(keys),
    })
    model.current = terminal
    const module: RedirectModule = {
      protocol: 1,
      Start: () => setTick((t) => t + 1),
      ProcessData: (data) => {
        terminal.write(data)
        setTick((t) => t + 1)
      },
      xxStateChange: (next) => {
        if (next === 0) terminal.reset()
        setState(next)
      },
    }
    channel.current = createRedirect(module)
  }
  const terminal = model.current

  // Follow the tail of the stream, like the legacy scrollTop assignment.
  useEffect(() => {
    const el = screenRef.current
    if (el != null) el.scrollTop = el.scrollHeight
  }, [tick])

  useEffect(() => {
    if (state === 3) inputRef.current?.focus()
  }, [state])

  useEffect(() => () => channel.current?.Stop(), [])

  const toggleConnect = () => {
    const chan = channel.current
    if (chan == null) return
    if (chan.State === 0) chan.Start()
    else chan.Stop()
  }

  const toggleSize = () => {
    const next = size.w === SIZES[0].w ? SIZES[1] : SIZES[0]
    setSize(next)
    terminal.resize(next.w, next.h)
    try {
      localStorage.setItem(SIZE_KEY, next.w + 'x' + next.h)
    } catch {
      // Storage can be unavailable; the size still applies for this session.
    }
    setTick((t) => t + 1)
  }

  const toggleLineFeed = () => {
    terminal.lineFeed = terminal.lineFeed === '\r\n' ? '\n' : '\r\n'
    setTick((t) => t + 1)
  }

  const toggleFx = () => {
    terminal.fxEmulation = ((terminal.fxEmulation + 1) % 3) as 0 | 1 | 2
    setTick((t) => t + 1)
  }

  const toggleEncoding = () => {
    terminal.emulation = ((terminal.emulation + 1) % 3) as TerminalEmulation
    setTick((t) => t + 1)
  }

  const onKeyDown = (e: KeyboardEvent) => terminal.handleKeyDown(e)
  const onKeyPress = (e: KeyboardEvent) => {
    // Everything typed goes to the device; the input itself stays empty.
    e.preventDefault()
    terminal.handleKeyPress(e)
  }
  const onKeyUp = (e: KeyboardEvent) => terminal.handleKeyUp(e)
  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData?.getData('text')
    if (text) terminal.sendKeys(text)
  }

  const encoding = [S.solEncUtf8, S.solEncAscii, S.solEncIntel][terminal.emulation]
  const fxKeys = [S.solFxIntel, S.solFxAlt, S.solFxVt100][terminal.fxEmulation]

  return (
    <div class="page">
      <div class="page-header">
        {FEAT_IDER ? <IderBar /> : null}
      </div>

      <div class="statusbar">
        <button type="button" class="btn btn-primary" onClick={toggleConnect}>
          {state === 0 ? S.solConnect : S.solDisconnect}
        </button>
        <span>{STATES[state] ?? S.disconnected}</span>
        <button
          type="button"
          class="btn"
          style="margin-left:auto"
          title={S.solCrTitle}
          onClick={toggleLineFeed}
        >
          {terminal.lineFeed === '\r\n' ? S.solCrLf : S.solLf}
        </button>
        <button type="button" class="btn" title={S.solFxTitle} onClick={toggleFx}>
          {fxKeys}
        </button>
        {FEAT_TerminalSize && (
          <button type="button" class="btn" title={S.solSizeTitle} onClick={toggleSize}>
            {size.w}x{size.h}
          </button>
        )}
        {FEAT_TerminalEnumationAll && (
          <button type="button" class="btn" title={S.solEncTitle} onClick={toggleEncoding}>
            {encoding}
          </button>
        )}
      </div>

      <div class="media-surface" onClick={() => inputRef.current?.focus()}>
        <pre
          class="terminal-output"
          ref={screenRef}
          aria-label={S.solScreen}
          dangerouslySetInnerHTML={{ __html: terminal.html() }}
        />
        <input
          ref={inputRef}
          class="terminal-input"
          aria-label={S.solKeyHint}
          placeholder={S.solKeyHint}
          spellcheck={false}
          autocomplete="off"
          onKeyDown={onKeyDown}
          onKeyPress={onKeyPress}
          onKeyUp={onKeyUp}
          onPaste={onPaste}
        />
      </div>
    </div>
  )
}
