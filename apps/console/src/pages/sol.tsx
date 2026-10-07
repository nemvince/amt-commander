import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import '../styles/ider.css'
import { FEAT_IDER, FEAT_TerminalEnumationAll, FEAT_TerminalSize } from '../features'
import { createIder } from '../lib/ider'
import { createRedirect, type RedirectChannel, type RedirectModule } from '../lib/redirect'
import { createTerminal, type Terminal, type TerminalEmulation } from '../lib/terminal'
import { S } from '../strings'
import { IderSessionButton, iderSummary } from '../ui/ider-session'
import { NavIcon } from '../ui/icons'
import { IconMenu, type MenuEntry } from '../ui/menu'

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
 * IDER rides the same view in legacy (index.html:947-952). It is the same
 * control the Remote Desktop page offers -- a toolbar button opening a dialog --
 * because the engine is a separate protocol-3 channel in both cases and closing
 * the dialog must not eject the mounted medium.
 */
export function SolPage() {
  const screenRef = useRef<HTMLPreElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const channel = useRef<RedirectChannel | null>(null)
  const model = useRef<Terminal | null>(null)
  const [tick, setTick] = useState(0)
  const [state, setState] = useState(0)
  const [size, setSize] = useState(storedSize)

  /*
   * The IDE-R engine belongs to the page, not to its dialog: closing the popup
   * must not eject the mounted medium or drop a live session.
   */
  const ider = useMemo(() => (FEAT_IDER ? createIder() : null), [])
  useEffect(() => () => ider?.stop(), [ider])
  const { live: iderLive, connected: iderConnected, label: iderLabel } = iderSummary(ider?.view.value ?? null)

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

  const chooseSize = (next: { w: number; h: number }) => {
    setSize(next)
    terminal.resize(next.w, next.h)
    try {
      localStorage.setItem(SIZE_KEY, next.w + 'x' + next.h)
    } catch {
      // Storage can be unavailable; the size still applies for this session.
    }
    setTick((t) => t + 1)
  }

  const chooseLineFeed = (lf: '\r\n' | '\n') => {
    terminal.lineFeed = lf
    setTick((t) => t + 1)
  }

  const chooseFx = (mode: 0 | 1 | 2) => {
    terminal.fxEmulation = mode
    setTick((t) => t + 1)
  }

  const chooseEncoding = (mode: TerminalEmulation) => {
    terminal.emulation = mode
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

  /** Line ending, encoding, F-keys and size all collapse into one menu. */
  const terminalMenu: MenuEntry[] = []
  terminalMenu.push({ id: 'lf-h', heading: S.solLineEnding })
  terminalMenu.push({
    id: 'lf-crlf',
    label: S.solCrLf,
    checked: terminal.lineFeed === '\r\n',
    onSelect: () => chooseLineFeed('\r\n'),
  })
  terminalMenu.push({
    id: 'lf-lf',
    label: S.solLf,
    checked: terminal.lineFeed === '\n',
    onSelect: () => chooseLineFeed('\n'),
  })
  if (FEAT_TerminalEnumationAll) {
    terminalMenu.push({ id: 'enc-h', heading: S.solEncoding })
    ;[S.solEncUtf8, S.solEncAscii, S.solEncIntel].forEach((label, i) => {
      terminalMenu.push({
        id: 'enc' + i,
        label,
        checked: terminal.emulation === i,
        onSelect: () => chooseEncoding(i as TerminalEmulation),
      })
    })
  }
  terminalMenu.push({ id: 'fx-h', heading: S.solFxKeys })
  ;[S.solFxIntel, S.solFxAlt, S.solFxVt100].forEach((label, i) => {
    terminalMenu.push({
      id: 'fx' + i,
      label,
      checked: terminal.fxEmulation === i,
      onSelect: () => chooseFx(i as 0 | 1 | 2),
    })
  })
  if (FEAT_TerminalSize) {
    terminalMenu.push({ id: 'sz-h', heading: S.solSize })
    SIZES.forEach((s) => {
      terminalMenu.push({
        id: 'sz' + s.w,
        label: s.w + 'x' + s.h,
        checked: size.w === s.w && size.h === s.h,
        onSelect: () => chooseSize(s),
      })
    })
  }

  return (
    <div class="media-page">
      {/*
        Same left-to-right grouping as the Remote Desktop bar, so the two windows
        read alike: the session button, a separator, then the view's own settings
        menu and IDE-R. Nothing is pushed to the far edge -- the shared controls
        sit at the same offsets in both windows.
      */}
      <div class="media-bar">
        <button type="button" class="btn btn-primary" onClick={toggleConnect}>
          {state === 0 ? S.solConnect : S.solDisconnect}
        </button>
        <span class="bar-sep" aria-hidden="true" />
        <IconMenu label={S.solSettings} icon={<NavIcon name="sol" size={14} />} entries={terminalMenu} />
        {FEAT_IDER && <IderSessionButton engine={ider} />}
      </div>

      <div class="media-stage">
        <div class="media-surface sol-surface" onClick={() => inputRef.current?.focus()}>
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

      <div class="statusbar">
        <span>{STATES[state] ?? S.disconnected}</span>
        <span class="header-spacer" />
        {iderLive && (
          <span class={'kvm-mode' + (iderConnected ? ' kvm-mode-live' : '')}>{iderLabel}</span>
        )}
      </div>

      {/* Same control as the Remote Desktop window: the engine above keeps the
          session alive whether this dialog is open or not. */}
    </div>
  )
}
