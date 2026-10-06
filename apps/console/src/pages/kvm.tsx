import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { FEAT_DesktopFocus, FEAT_DesktopMulti, FEAT_DesktopRotation, FEAT_DesktopSettings, FEAT_DesktopType, FEAT_IDER } from '../features'
import { S } from '../strings'
import { amtVersion, getStack, powerState } from '../state/device'
import { createRedirect, type RedirectChannel } from '../lib/redirect'
import {
  DISCONNECT,
  createKvmSession,
  kvmLinkState,
  kvmScreen,
  loadKvmSettings,
  saveKvmSettings,
  type KeySeq,
  type KvmSession,
  type KvmSettings,
} from '../lib/kvm'
import { Dialog } from '../ui/dialog'
import { ExpandIcon, NavIcon, SettingsIcon } from '../ui/icons'
import { IconMenu, type MenuEntry } from '../ui/menu'
import { createIder } from '../lib/ider'
import { IderOverlay } from '../ui/ider-overlay'
import type { WsmanNode } from '../lib/wsman'

/**
 * Remote Desktop page.
 *
 * The engine lives in lib/kvm.ts; this file owns the page shell, the WSMAN
 * calls legacy makes around the session (blanking, KVM enable, display info)
 * and the toolbar. Nothing touches the DOM at module scope.
 */

const F_KEY_LABELS: readonly string[] = [
  S.kvmKeyF1,
  S.kvmKeyF2,
  S.kvmKeyF3,
  S.kvmKeyF4,
  S.kvmKeyF5,
  S.kvmKeyF6,
  S.kvmKeyF7,
  S.kvmKeyF8,
  S.kvmKeyF9,
  S.kvmKeyF10,
  S.kvmKeyF11,
  S.kvmKeyF12,
]

/** Special key combinations, verbatim from index.html:9124-9151. */
const SPECIAL_KEYS: { label: string; seq: KeySeq }[] = [
  { label: S.kvmKeyWin, seq: [[0xffe7, 1], [0xffe7, 0]] },
  { label: S.kvmKeyWinDown, seq: [[0xffe7, 1], [0xff54, 1], [0xff54, 0], [0xffe7, 0]] },
  { label: S.kvmKeyWinUp, seq: [[0xffe7, 1], [0xff52, 1], [0xff52, 0], [0xffe7, 0]] },
  { label: S.kvmKeyWinL, seq: [[0xffe7, 1], [0x6c, 1], [0x6c, 0], [0xffe7, 0]] },
  { label: S.kvmKeyWinM, seq: [[0xffe7, 1], [0x6d, 1], [0x6d, 0], [0xffe7, 0]] },
  { label: S.kvmKeyWinR, seq: [[0xffe7, 1], [0x72, 1], [0x72, 0], [0xffe7, 0]] },
  { label: S.kvmKeyWinLeft, seq: [[0xffe7, 1], [0xff51, 1], [0xff51, 0], [0xffe7, 0]] },
  { label: S.kvmKeyWinRight, seq: [[0xffe7, 1], [0xff53, 1], [0xff53, 0], [0xffe7, 0]] },
  {
    label: S.kvmKeyShiftWinM,
    seq: [
      [0xffe1, 1],
      [0xffe7, 1],
      [0x6d, 1],
      [0x6d, 0],
      [0xffe7, 0],
      [0xffe1, 0],
    ],
  },
  { label: S.kvmKeyAltTab, seq: [[0xffe9, 1], [0xff09, 1], [0xff09, 0], [0xffe9, 0]] },
  { label: S.kvmKeyAltF4, seq: [[0xffe9, 1], [0xffc1, 1], [0xffc1, 0], [0xffe9, 0]] },
  { label: S.kvmKeyCtrlW, seq: [[0xffe3, 1], [0x77, 1], [0x77, 0], [0xffe3, 0]] },
  ...F_KEY_LABELS.map(
    (label, i): { label: string; seq: KeySeq } => ({
      label,
      seq: [
        [0xffbe + i, 1],
        [0xffbe + i, 0],
      ],
    }),
  ),
  { label: S.kvmKeyEnter, seq: [[0xff0d, 1], [0xff0d, 0]] },
]

/** Pixel formats. encflags bit 1 = RLE, 2 = 16bit, 4 = gray, 16 = 4bit gray. */
const PIXEL_FORMATS: { value: number; label: string }[] = [
  { value: 1, label: S.kvmEncRle8 },
  { value: 3, label: S.kvmEncRle16 },
  { value: 0, label: S.kvmEncRaw8 },
  { value: 2, label: S.kvmEncRaw16 },
]
const GRAY_PIXEL_FORMATS: { value: number; label: string }[] = [
  { value: 5, label: S.kvmEncRle8Gray },
  { value: 21, label: S.kvmEncRle4Gray },
]

interface ScreenInfo {
  /** IPS_ScreenSettingData.IsActive, three entries. */
  isActive: boolean[]
  /** IPS_KVMRedirectionSettingData.DefaultScreen. */
  defaultScreen: number
}

/** IPS_KVMRedirectionSAP reports KVM as enabled in these states. */
function kvmEnabled(body: WsmanNode): boolean {
  const es = body['EnabledState']
  const rs = body['RequestedState']
  return (es === 6 && rs === 2) || es === 2 || es === 6
}

export function KvmPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const focusRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<KvmSession | null>(null)
  const channelRef = useRef<RedirectChannel | null>(null)

  const [settings, setSettings] = useState<KvmSettings>(loadKvmSettings)
  const [draft, setDraft] = useState<KvmSettings>(settings)
  const [message, setMessage] = useState('')
  const [kvmMissing, setKvmMissing] = useState(false)
  const [graySupported, setGraySupported] = useState(false)
  const [viewOnly, setViewOnly] = useState(false)
  const [blankScreen, setBlankScreen] = useState(false)
  /**
   * Blanking support, straight from the device: bit 0 of
   * `IPS_ScreenConfigurationService.EnabledState` is what the legacy app gates
   * the checkbox on (index.html:5601). `null` means "not answered yet", which is
   * treated as supported so the button is not hidden by a failed probe.
   */
  const [blankSupported, setBlankSupported] = useState<boolean | null>(null)
  const [full, setFull] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showType, setShowType] = useState(false)
  const [typeText, setTypeText] = useState('')
  const [showIder, setShowIder] = useState(false)
  const [focusLevel, setFocusLevel] = useState(0)
  const [screens, setScreens] = useState<ScreenInfo | null>(null)
  /** Blocks injection while a modal is up, like the legacy `xxdialogMode`. */
  const dialogOpen = useRef(false)
  const reconnectTimer = useRef<number | null>(null)
  const live = kvmLinkState.value === 3
  const screen = kvmScreen.value

  /*
   * The IDE-R engine belongs to the page, not to its dialog: closing the popup
   * must not eject the mounted medium or drop a live session. It also lets the
   * status bar report what is redirected while the dialog is out of the way.
   */
  const ider = useMemo(() => (FEAT_IDER ? createIder() : null), [])
  useEffect(() => () => ider?.stop(), [ider])
  const iderView = ider?.view.value ?? null
  /*
   * A mounted image is not a redirected one: the engine keeps the file chosen
   * after a stop so it can be restarted, so both the button and the status chip
   * follow `status` and would otherwise claim a session that is not there.
   */
  const iderLive = iderView != null && iderView.status !== 'idle'
  const iderMedia = iderView == null ? [] : [iderView.floppy, iderView.cdrom].filter((m) => m != null)
  const iderLabel = iderMedia.length > 0 ? `${S.kvmIder} ${iderMedia.map((m) => m?.name).join(', ')}` : S.kvmIder

  /**
   * Blank the device screen, now.
   *
   * Blanking is a device-side display state rather than a session setting: AMT
   * applies it through IPS_ScreenConfigurationService whatever the link is
   * doing, so the button works before, during and after a session. The old
   * checkbox was only read inside `start()`, which is why ticking it on a live
   * session did nothing.
   */
  const applyBlank = (on: boolean) => {
    const stack = getStack()
    if (stack == null) return
    const previous = blankScreen
    setBlankScreen(on)
    stack.Exec(
      'IPS_ScreenConfigurationService',
      'SetSessionState',
      { SessionState: on ? 1 : 0, ConsecutiveRebootsNum: 3 },
      (_s, _n, _r, status) => {
        if (status !== 200) {
          // The device refused it: report the truth rather than the wish.
          setBlankScreen(previous)
          setMessage(S.kvmBlankUnsupported)
        }
      },
    )
  }

  const start = () => {
    const session = sessionRef.current
    const channel = channelRef.current
    if (session == null || channel == null || channel.State !== 0) return
    session.Start()
    /*
     * Re-assert blanking as the session opens (index.html:8773). The device
     * keeps the blanked state across sessions, but it also drops it on some
     * resets, so a build that was told to blank asserts it again rather than
     * trusting that it survived.
     */
    if (blankScreen && blankSupported !== false && amtVersion.value > 9) {
      const stack = getStack()
      if (stack != null) {
        stack.Exec(
          'IPS_ScreenConfigurationService',
          'SetSessionState',
          { SessionState: 1, ConsecutiveRebootsNum: 3 },
          (_s, _n, _r, status) => {
            if (status !== 200) {
              setBlankScreen(false)
            }
            channel.Start()
          },
        )
        return
      }
    }
    channel.Start()
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas == null) return
    const session = createKvmSession(canvas, settings)
    const channel = createRedirect(session)
    session.attach(channel)
    sessionRef.current = session
    channelRef.current = channel

    channel.onStateChanged = (_ch, state) => {
      if (state !== 0) return
      // 50001 means AMT dropped a healthy session: retry, but only once it has
      // run long enough for a retry to stand a chance (index.html:8884).
      const code = session.disconnectCode
      if (code === DISCONNECT.AMT_DISCONNECT && session.connectTime > 0 && session.connectTime + 5000 < Date.now()) {
        if (reconnectTimer.current != null) clearTimeout(reconnectTimer.current)
        reconnectTimer.current = setTimeout(start, 200)
      } else if (code === DISCONNECT.BUSY) {
        setMessage(S.kvmBusy)
      } else if (code === DISCONNECT.UNSUPPORTED) {
        setMessage(S.kvmUnsupported)
      } else if (code === DISCONNECT.KVM_DISCONNECT) {
        setMessage(S.kvmLinkLost)
      } else if (code === DISCONNECT.BUFFER_OVERFLOW) {
        setMessage(S.kvmBufferOverflow)
      } else if (code === DISCONNECT.NO_DISPLAY) {
        setMessage(S.kvmNoDisplay)
      }
    }

    return () => {
      if (reconnectTimer.current != null) clearTimeout(reconnectTimer.current)
      channel.Stop()
      sessionRef.current = null
      channelRef.current = null
    }
    // Deliberately empty deps: one session per mount, settings arrive later
    // through setSettings.
  }, [])

  useEffect(() => {
    const stack = getStack()
    if (stack == null) return
    stack.Get('CIM_KVMRedirectionSAP', (_s, _n, resp) => {
      if (resp?.Body != null) setKvmMissing(!kvmEnabled(resp.Body))
    })
  }, [amtVersion.value])

  /** Same question for blanking: does this device allow it at all? */
  useEffect(() => {
    const stack = getStack()
    if (stack == null || amtVersion.value <= 9) return
    stack.Get('IPS_ScreenConfigurationService', (_s, _n, resp) => {
      const state = resp?.Body?.['EnabledState']
      if (typeof state === 'number') {
        setBlankSupported((state & 1) !== 0)
      }
    })
  }, [amtVersion.value])

  /** index.html:8822-8849: which displays exist, and which one KVM is on. */
  const pullScreens = () => {
    const stack = getStack()
    if (stack == null || !FEAT_DesktopMulti) return
    stack.BatchEnum('', ['*IPS_ScreenSettingData', '*IPS_KVMRedirectionSettingData'], (_s, _batch, results) => {
      const screenResult = results['IPS_ScreenSettingData']
      const kvmResult = results['IPS_KVMRedirectionSettingData']
      if (screenResult.status !== 200 || screenResult.responses?.Body == null || kvmResult.responses?.Body == null) return
      const raw = screenResult.responses.Body['IsActive']
      setScreens({
        isActive: Array.isArray(raw) ? raw.map((v) => v === true) : [true, false, false],
        defaultScreen: (kvmResult.responses.Body['DefaultScreen'] as number) ?? 0,
      })
    })
  }

  useEffect(() => {
    if (!FEAT_DesktopMulti) return
    pullScreens()
    const timer = setInterval(pullScreens, 5000)
    return () => clearInterval(timer)
    // Re-pulls whenever the link state flips, not on every render.
  }, [live])

  const switchScreen = (index: number) => {
    const stack = getStack()
    if (stack == null) return
    stack.Get('IPS_KVMRedirectionSettingData', (_s, _n, resp) => {
      const body = resp?.Body
      if (body == null) return
      stack.Put('IPS_KVMRedirectionSettingData', { ...body, DefaultScreen: index }, () => pullScreens())
    })
  }

  /**
   * Port of featuresDlgOk (index.html:10393) for the KVM-only case: the
   * redirection listener carries a 32768 bit plus one bit per session type.
   */
  const enableKvm = () => {
    const stack = getStack()
    if (stack == null) return
    stack.Get('AMT_RedirectionService', (_s, _n, resp) => {
      const body = resp?.Body
      if (body == null) {
        setMessage(S.error)
        return
      }
      const r = { ...body, ListenerEnabled: true, EnabledState: 32770 }
      stack.Exec('AMT_RedirectionService', 'RequestStateChange', { RequestedState: 32770 }, (_s2, _n2, _r2, status) => {
        if (status !== 200) {
          setMessage(S.error + ' ' + status)
          return
        }
        stack.Exec('CIM_KVMRedirectionSAP', 'RequestStateChange', { RequestedState: 2 }, (_s3, _n3, _r3, status3) => {
          if (status3 !== 200) {
            setMessage(S.error + ' ' + status3)
            return
          }
          stack.Put('AMT_RedirectionService', r, () => setKvmMissing(false))
        })
      })
    })
  }

  // Keys land on the document, not just the canvas, so a stray Tab still types.
  useEffect(() => {
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      const session = sessionRef.current
      if (session == null || !live || viewOnly || dialogOpen.current) return
      const t = e.target
      if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      if (down) session.onKeyDown(e)
      else session.onKeyUp(e)
    }
    const keyDown = onKey(true)
    const keyUp = onKey(false)
    document.addEventListener('keydown', keyDown)
    document.addEventListener('keyup', keyUp)
    return () => {
      document.removeEventListener('keydown', keyDown)
      document.removeEventListener('keyup', keyUp)
    }
  }, [live, viewOnly])

  /** Route a canvas pointer event into the engine, then repaint the focus box. */
  const injectMouse = <E extends MouseEvent>(fn: (s: KvmSession, e: E) => void) => (e: E) => {
    const session = sessionRef.current
    if (session == null || viewOnly || dialogOpen.current) return
    fn(session, e)
    e.preventDefault()
    // DesktopFocus moves the box straight on the node; a re-render per pointer
    // event would be far more expensive than the box is worth.
    const box = focusRef.current
    if (box != null && session.focusMode > 0) {
      const df = session.focusMode * 2
      const x = Math.max(Math.min(session.mx, session.screenWidth - session.focusMode) - session.focusMode, 0)
      const y = Math.max(Math.min(session.my, session.screenHeight - session.focusMode) - session.focusMode, 0)
      box.style.display = 'block'
      box.style.left = (x / session.screenWidth) * 100 + '%'
      box.style.top = (y / session.screenHeight) * 100 + '%'
      box.style.width = (df / session.screenWidth) * 100 + '%'
      box.style.height = (df / session.screenHeight) * 100 + '%'
    }
  }

  const applySettings = (next: KvmSettings) => {
    setSettings(next)
    saveKvmSettings(next)
    const session = sessionRef.current
    if (session == null) return
    session.setSettings(next)
    // The pixel format is fixed for the life of a session, so re-open it.
    if (live) {
      channelRef.current?.Stop()
      setTimeout(start, 800)
    }
  }

  /** Rotation is a display setting, so it survives a reconnect like the rest. */
  const rotate = (delta: number) => {
    const session = sessionRef.current
    if (session == null) return
    session.setRotation(session.rotation + delta)
    const next = { ...settings, rotation: session.rotation }
    setSettings(next)
    saveKvmSettings(next)
  }

  /**
   * The Fullscreen API is the source of truth; `full` only drives the fallback
   * CSS takeover for browsers without it. Reading the real state (rather than
   * flipping a flag) means Esc and browser-initiated exits stay in sync instead
   * of stranding the page in fullscreen layout with no way back.
   */
  const toggleFullscreen = () => {
    const stage = stageRef.current
    if (document.fullscreenElement != null) {
      void document.exitFullscreen?.()
      return
    }
    if (stage?.requestFullscreen != null) {
      void stage.requestFullscreen()
      return
    }
    setFull(!full)
  }

  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement != null)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  /** index.html:9083: one character per tick, down then up, US layout. */
  const sendTypedText = () => {
    const session = sessionRef.current
    const text = typeText
    setShowType(false)
    setTypeText('')
    if (session == null || !live || text === '') return
    let i = 0
    const timer = setInterval(() => {
      if (i >= text.length || kvmLinkState.value !== 3) {
        clearInterval(timer)
        return
      }
      const code = text.charCodeAt(i++)
      session.sendKeys([[code, 1], [code, 0]])
    }, 10)
  }

  const statusText = live
    ? S.connected
    : kvmLinkState.value === 1
      ? S.connecting
      : kvmLinkState.value === 2
        ? S.kvmSetup
        : S.disconnected
  /** Same three states the header chip paints: up, on its way, or down. */
  const linkClass = live ? 'ok' : kvmLinkState.value === 0 ? 'error' : 'warn'
  const injectable = live && !viewOnly

  /** Screens to offer in the display menu; null unless the device has several. */
  const multiScreens =
    FEAT_DesktopMulti && screens != null && screens.isActive.filter(Boolean).length > 1 ? screens : null

  /** Focus, rotation and screen switching collapse into one toolbar menu. */
  const displayMenu: MenuEntry[] = []
  if (FEAT_DesktopFocus) {
    displayMenu.push({ id: 'focus-h', heading: S.kvmFocus })
    ;[S.kvmFocusAll, S.kvmFocusSmall, S.kvmFocusLarge].forEach((label, i) => {
      displayMenu.push({
        id: 'focus' + i,
        label,
        checked: focusLevel / 64 === i,
        onSelect: () => {
          setFocusLevel(i * 64)
          const session = sessionRef.current
          if (session != null) session.focusMode = i * 64
        },
      })
    })
  }
  if (FEAT_DesktopRotation) {
    displayMenu.push({ id: 'rot-h', heading: S.kvmRotate })
    displayMenu.push({ id: 'rot-l', label: S.kvmRotateLeft, onSelect: () => rotate(-1) })
    displayMenu.push({ id: 'rot-r', label: S.kvmRotateRight, onSelect: () => rotate(1) })
  }
  if (multiScreens != null) {
    displayMenu.push({ id: 'scr-h', heading: S.kvmDisplay })
    multiScreens.isActive.forEach((active, i) => {
      if (!active) {
        return
      }
      displayMenu.push({
        id: 'scr' + i,
        label: S.kvmSwitchTo.replace('{0}', String(i + 1)),
        checked: i === multiScreens.defaultScreen,
        onSelect: () => switchScreen(i),
      })
    })
  }

  /**
   * `focus-h` etc: focus, rotation and screen switching collapse into the
   * display menu. Keyboard input does the same in its own menu, so one bar can
   * hold everything without a second row.
   */
  const keyboardMenu: MenuEntry[] = [{ id: 'key-h', heading: S.kvmSpecialKey }]
  SPECIAL_KEYS.forEach((key, i) => {
    keyboardMenu.push({
      id: 'key' + i,
      label: key.label,
      disabled: !injectable,
      onSelect: () => sessionRef.current?.sendKeys(key.seq),
    })
  })
  if (settings.showcad) {
    keyboardMenu.push({
      id: 'cad',
      label: S.kvmCad,
      disabled: !injectable,
      onSelect: () => sessionRef.current?.sendCad(),
    })
  }
  if (FEAT_DesktopType) {
    keyboardMenu.push({
      id: 'type',
      label: S.kvmType,
      disabled: !injectable,
      onSelect: () => {
        dialogOpen.current = true
        setShowType(true)
      },
    })
  }

  return (
    <div class={'media-page kvm-page' + (full ? ' kvm-fullscreen' : '')}>
      {/*
        One actions bar, one screen, one status bar: the layout a virtual machine
        window has. Everything that does not fit in the bar lives behind a menu or
        a dialog -- display placement, viewer settings, keyboard input and IDE-R.
      */}
      <div class="media-bar kvm-bar">
        <button type="button" class="btn" onClick={live ? () => channelRef.current?.Stop() : start}>
          {live ? S.kvmDisconnect : S.kvmConnect}
        </button>
        <button
          type="button"
          class="btn"
          title={full ? S.kvmExitFullscreen : S.kvmFullscreen}
          aria-label={full ? S.kvmExitFullscreen : S.kvmFullscreen}
          onClick={toggleFullscreen}
        >
          <ExpandIcon size={14} />
        </button>

        <span class="kvm-sep" aria-hidden="true" />

        {displayMenu.length > 0 && (
          <IconMenu label={S.kvmDisplay} icon={<NavIcon name="kvm" size={14} />} entries={displayMenu} />
        )}
        {FEAT_DesktopSettings && (
          <button
            type="button"
            class="btn"
            title={S.kvmSettings}
            aria-label={S.kvmSettings}
            onClick={() => {
              const stack = getStack()
              // Grayscale needs a device that offers it (index.html:8977).
              if (stack != null && amtVersion.value > 15) {
                stack.Get('IPS_KVMRedirectionSettingData', (_s, _n, resp) => {
                  setGraySupported(resp?.Body?.['GrayscalePixelFormatSupported'] === true)
                })
              }
              setDraft(settings)
              dialogOpen.current = true
              setShowSettings(true)
            }}
          >
            <SettingsIcon size={14} />
          </button>
        )}
        {FEAT_IDER && (
          <button
            type="button"
            class={'btn' + (iderLive ? ' btn-primary' : '')}
            title={S.iderSession}
            aria-pressed={iderLive}
            onClick={() => setShowIder(true)}
          >
            {S.kvmIder}
          </button>
        )}

        <span class="kvm-sep" aria-hidden="true" />

        {amtVersion.value > 9 && blankSupported !== false && (
          <button
            type="button"
            class={'btn' + (blankScreen ? ' btn-primary' : '')}
            aria-pressed={blankScreen}
            title={S.kvmBlankScreenHint}
            onClick={() => applyBlank(!blankScreen)}
          >
            {S.kvmBlankScreen}
          </button>
        )}
        <button
          type="button"
          class={'btn' + (viewOnly ? ' btn-primary' : '')}
          aria-pressed={viewOnly}
          title={S.kvmViewOnlyHint}
          onClick={() => setViewOnly(!viewOnly)}
        >
          {S.kvmViewOnly}
        </button>

        <span class="kvm-sep" aria-hidden="true" />

        <IconMenu label={S.kvmKeyboard} icon={S.kvmKeyboard} entries={keyboardMenu} />
      </div>

      {message !== '' && (
        <div class="banner error">
          <span>{message}</span>
          <button type="button" class="btn" onClick={() => setMessage('')}>
            {S.close}
          </button>
        </div>
      )}

      {kvmMissing && (
        <div class="banner error">
          <span>{S.kvmRedirDisabled}</span>
          <button type="button" class="btn" onClick={enableKvm}>
            {S.kvmEnableTitle}
          </button>
        </div>
      )}

      {powerState.value > 0 && powerState.value !== 2 && <div class="banner error">{S.kvmNotPoweredOn}</div>}

      <div class="media-stage">
        <div class="media-surface kvm-stage" ref={stageRef}>
            <canvas
              class="kvm-canvas"
              ref={canvasRef}
              width={screen.width}
              height={screen.height}
              style={settings.showmouse ? undefined : { cursor: 'none' }}
              onContextMenu={(e) => e.preventDefault()}
              onMouseDown={injectMouse((s, e) => s.onMouseDown(e))}
              onMouseUp={injectMouse((s, e) => s.onMouseUp(e))}
              onMouseMove={injectMouse((s, e) => s.onMouseMove(e))}
              onWheel={injectMouse<WheelEvent>((s, e) => s.onMouseWheel(e))}
            />
            {FEAT_DesktopFocus && <div class="kvm-focus" ref={focusRef} />}
          </div>
        </div>

        {/*
          Status only. The blanking and view-only modes appear here as their own
          state (`blank`, `view-only`) because that is what they are -- the
          toolbar buttons that set them say the same thing with aria-pressed.
        */}
        <div class={'statusbar kvm-status kvm-status-' + linkClass}>
          <span class={'kvm-status-dot status-' + linkClass} aria-hidden="true" />
          <span class={'status-' + linkClass}>{statusText}</span>
          <span class="header-spacer" />
          {iderLive && (
            <span class={'kvm-mode' + (iderView?.status === 'live' ? ' kvm-mode-live' : '')}>
              {iderLabel}
            </span>
          )}
          {multiScreens != null && (
            <span>
              {S.kvmDisplay} {multiScreens.defaultScreen + 1}
            </span>
          )}
          <span class="mono">
            {screen.width}x{screen.height}
          </span>
          {blankScreen && <span class="kvm-mode">{S.kvmBlankScreen}</span>}
          {viewOnly && <span class="kvm-mode">{S.kvmViewOnly}</span>}
        </div>

      {/*
        IDE-R is a dialog rather than a bar of its own: the controls are only
        wanted while an image is being mounted, and the engine above keeps the
        session alive whether this is open or not.
      */}
      {showIder && ider != null && (
        <Dialog title={S.iderSession} onClose={() => setShowIder(false)}>
          <IderOverlay
            view={ider.view}
            onStart={(floppy, cdrom, mode) => ider.start({ floppy, cdrom, mode })}
            onEject={(device) => ider.eject(device)}
            onStop={() => ider.stop()}
          />
        </Dialog>
      )}

      {showSettings && (
        <Dialog
          title={S.kvmViewerSettings}
          onClose={(v) => {
            dialogOpen.current = false
            setShowSettings(false)
            if (v === 'ok') applySettings(draft)
          }}
          buttons={[
            { label: S.ok, value: 'ok', primary: true },
            { label: S.cancel, value: 'cancel' },
          ]}
        >
          <div class="kvm-dialog-field">
            <span>{S.kvmPixelFormat}</span>
            <select
              value={String(draft.encflags)}
              onChange={(e) => setDraft({ ...draft, encflags: Number(e.currentTarget.value) })}
            >
              {(graySupported ? GRAY_PIXEL_FORMATS.concat(PIXEL_FORMATS) : PIXEL_FORMATS).map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          {(
            [
              ['showmouse', S.kvmShowLocalCursor],
              ['showcad', S.kvmShowCad],
              ['limitFrameRate', S.kvmLimitFrameRate],
              ['reverseMouseWheel', S.kvmReverseWheel],
              ...(FEAT_DesktopFocus ? ([['showfocus', S.kvmShowFocusTool]] as const) : []),
              ...(FEAT_DesktopRotation ? ([['noMouseRotate', S.kvmNoMouseRotate]] as const) : []),
            ] as [keyof KvmSettings, string][]
          ).map(([key, label]) => (
            <label class="kvm-dialog-field" key={key}>
              <span>{label}</span>
              <input type="checkbox" checked={draft[key] as boolean} onChange={(e) => setDraft({ ...draft, [key]: e.currentTarget.checked })} />
            </label>
          ))}
        </Dialog>
      )}

      {showType && (
        <Dialog
          title={S.kvmTypeDialogTitle}
          onClose={(v) => {
            dialogOpen.current = false
            if (v === 'ok') sendTypedText()
            else setShowType(false)
          }}
          buttons={[
            { label: S.ok, value: 'ok', primary: true },
            { label: S.cancel, value: 'cancel' },
          ]}
        >
          <p>{S.kvmTypeDialogHint}</p>
          <label>
            {S.kvmTypeDialogLabel}
            <textarea
              class="kvm-type-input"
              maxLength={2000}
              value={typeText}
              onInput={(e) => setTypeText(e.currentTarget.value)}
            />
          </label>
        </Dialog>
      )}
    </div>
  )
}