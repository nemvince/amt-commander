import { useEffect, useRef, useState } from 'preact/hooks'
import { FEAT_DesktopFocus, FEAT_DesktopMulti, FEAT_DesktopRotation, FEAT_DesktopSettings, FEAT_DesktopType, FEAT_IDER, FEAT_PowerControl } from '../features'
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
import { IderBar } from '../ui/ider-bar'
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
  const [full, setFull] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showType, setShowType] = useState(false)
  const [typeText, setTypeText] = useState('')
  const [specialKey, setSpecialKey] = useState(0)
  const [focusLevel, setFocusLevel] = useState(0)
  const [screens, setScreens] = useState<ScreenInfo | null>(null)
  /** Blocks injection while a modal is up, like the legacy `xxdialogMode`. */
  const dialogOpen = useRef(false)
  const reconnectTimer = useRef<number | null>(null)
  const live = kvmLinkState.value === 3
  const screen = kvmScreen.value

  const start = () => {
    const session = sessionRef.current
    const channel = channelRef.current
    if (session == null || channel == null || channel.State !== 0) return
    session.Start()
    // Screen blanking rides on IPS_ScreenConfigurationService, which needs
    // AMT 11 (index.html:5392). If the device rejects it, carry on regardless.
    if (blankScreen && amtVersion.value > 9) {
      const stack = getStack()
      if (stack != null) {
        stack.Exec('IPS_ScreenConfigurationService', 'SetSessionState', { SessionState: 1, ConsecutiveRebootsNum: 3 }, (_s, _n, _r, status) => {
          if (status !== 200) setBlankScreen(false)
          channel.Start()
        })
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

  const toggleFullscreen = () => {
    const next = !full
    setFull(next)
    if (next) stageRef.current?.requestFullscreen?.()
    else if (document.fullscreenElement != null) document.exitFullscreen?.()
  }

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
  const injectable = live && !viewOnly

  return (
    <div class={'page' + (full ? ' kvm-fullscreen' : '')}>
      <div class="page-header">
        {FEAT_IDER ? <IderBar /> : null}
        <h1 class="page-title">{S.navKvm}</h1>
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

      <section class="table-panel">
        <div class="table-titlebar">
          <h2 class="table-title">{S.navKvm}</h2>
          <div class="table-actions">
            <button type="button" class="btn" onClick={live ? () => channelRef.current?.Stop() : start}>
              {live ? S.kvmDisconnect : S.kvmConnect}
            </button>
            <button type="button" class="btn" onClick={toggleFullscreen}>
              {full ? S.kvmExitFullscreen : S.kvmFullscreen}
            </button>
            {FEAT_DesktopFocus && (
              <button
                type="button"
                class="btn"
                onClick={() => {
                  const next = (focusLevel + 64) % 192
                  setFocusLevel(next)
                  const session = sessionRef.current
                  if (session != null) session.focusMode = next
                }}
              >
                {[S.kvmFocusAll, S.kvmFocusSmall, S.kvmFocusLarge][focusLevel / 64]}
              </button>
            )}
            {FEAT_DesktopRotation && (
              <>
                <button type="button" class="btn" title={S.kvmRotateLeft} onClick={() => rotate(-1)}>
                  ↺
                </button>
                <button type="button" class="btn" title={S.kvmRotateRight} onClick={() => rotate(1)}>
                  ↻
                </button>
              </>
            )}
            {FEAT_DesktopSettings && (
              <button
                type="button"
                class="btn"
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
                {S.kvmSettings}
              </button>
            )}
          </div>
        </div>

        {FEAT_DesktopMulti && screens != null && screens.isActive.filter(Boolean).length > 1 && (
          <div class="btn-row">
            <span>{S.kvmDisplay}</span>
            {screens.isActive.map((active, i) =>
              active ? (
                <button
                  key={i}
                  type="button"
                  class={'btn' + (i === screens.defaultScreen ? ' btn-primary' : '')}
                  title={S.kvmSwitchTo.replace('{0}', String(i + 1))}
                  onClick={() => switchScreen(i)}
                >
                  {i + 1}
                </button>
              ) : null,
            )}
          </div>
        )}

        <div class="kvm-stage-wrap">
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

        <div class="statusbar">
          <span>{statusText}</span>
          <span class="header-spacer" />
          <span class="mono">
            {screen.width}x{screen.height}
          </span>
          {FEAT_PowerControl && amtVersion.value > 9 && (
            <label class="btn">
              <input type="checkbox" checked={blankScreen} onChange={(e) => setBlankScreen(e.currentTarget.checked)} />
              {S.kvmBlankScreen}
            </label>
          )}
          <label class="btn">
            <input type="checkbox" checked={viewOnly} onChange={(e) => setViewOnly(e.currentTarget.checked)} />
            {S.kvmViewOnly}
          </label>
        </div>

        <div class="btn-row">
          <span>{S.kvmSpecialKey}</span>
          <select
            value={String(specialKey)}
            disabled={!injectable}
            onChange={(e) => setSpecialKey(Number(e.currentTarget.value))}
          >
            {SPECIAL_KEYS.map((k, i) => (
              <option key={k.label} value={i}>
                {k.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            class="btn"
            disabled={!injectable}
            onClick={() => sessionRef.current?.sendKeys(SPECIAL_KEYS[specialKey].seq)}
          >
            {S.kvmSend}
          </button>
          {settings.showcad && (
            <button type="button" class="btn" disabled={!injectable} onClick={() => sessionRef.current?.sendCad()}>
              {S.kvmCad}
            </button>
          )}
          {FEAT_DesktopType && (
            <button
              type="button"
              class="btn"
              disabled={!injectable}
              onClick={() => {
                dialogOpen.current = true
                setShowType(true)
              }}
            >
              {S.kvmType}
            </button>
          )}
        </div>
      </section>

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