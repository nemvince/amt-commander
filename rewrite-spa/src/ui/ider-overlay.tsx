/**
 * IDER overlay: status bar, mount controls and the per-device sector disk map.
 *
 * Replaces the legacy `#id_iderstatus` bar (index.html:820-838), the start dialog
 * (index.html:9634) and `iderSectorStats`'s canvas drawing (index.html:9737-9769).
 *
 * The component is engine-free by design: it reads a plain snapshot through a
 * signal and reports user intent through callbacks, so a page can drop it in
 * without importing the IDER client. That keeps the engine and its CSS out of
 * pages that never render the bar.
 */
import type { Signal } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { FEAT_IDERStats } from '../features'
import type { IderDevice, IderHeatMap, IderStartMode, IderView } from '../lib/ider'
import { S } from '../strings'

export interface IderOverlayProps {
  /** Live session snapshot; reading `.value` here subscribes the component. */
  view: Signal<IderView>
  /** Mount the given media (either may be null) and open a session. */
  onStart: (floppy: File | null, cdrom: File | null, mode: IderStartMode) => void
  /** Drop the medium in a slot; the session stays up. */
  onEject: (device: IderDevice) => void
  /** Tear the session down. */
  onStop: () => void
}

/** Canvas geometry, matching index.html:9735. */
const MAP_WIDTH = 600
const MAP_CELL = 6
const MAP_COLUMNS = MAP_WIDTH / MAP_CELL

type HeatMapProps = {
  heat: IderHeatMap
  /** Bumped by the engine every stats refresh; the map itself is mutated in place. */
  tick: number
}

function HeatMap(props: HeatMapProps) {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const { heat } = props

  useEffect(() => {
    const el = canvas.current
    if (!el) {
      return
    }
    const ctx = el.getContext('2d')
    if (!ctx) {
      return
    }
    el.width = MAP_WIDTH
    el.height = Math.max(1, Math.ceil(heat.blocks / MAP_COLUMNS) * MAP_CELL)
    ctx.fillStyle = 'rgba(225,250,225,1)'
    ctx.fillRect(0, 0, MAP_WIDTH, el.height)
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    for (let block = 0; block < heat.blocks; block++) {
      if (!heat.map[block]) {
        continue
      }
      ctx.fillRect(
        (block % MAP_COLUMNS) * MAP_CELL,
        Math.floor(block / MAP_COLUMNS) * MAP_CELL,
        MAP_CELL,
        MAP_CELL
      )
    }
  }, [heat, props.tick])

  return (
    <div>
      <p class="ider-heat-title">
        <b>{heat.device === 'floppy' ? S.iderFloppyLabel : S.iderCdromLabel}</b>, {heat.blockBytes}{' '}
        {S.iderPerBlock}
      </p>
      <canvas ref={canvas} />
    </div>
  )
}

export function IderOverlay(props: IderOverlayProps) {
  const view = props.view.value
  const running = view.status !== 'idle'
  const [floppy, setFloppy] = useState<File | null>(null)
  const [cdrom, setCdrom] = useState<File | null>(null)
  const [mode, setMode] = useState<IderStartMode>(1)
  const [mapOpen, setMapOpen] = useState(false)
  const [error, setError] = useState('')

  // Mirrors the dialog checks in index.html:9646-9647.
  const validate = (floppyFile: File | null, cdromFile: File | null) => {
    if (floppyFile == null && cdromFile == null) {
      return S.iderNoImage
    }
    if (floppyFile != null && floppyFile.size % 512 !== 0) {
      return S.iderBadFloppy
    }
    if (cdromFile != null && cdromFile.size % 2048 !== 0) {
      return S.iderBadCdrom
    }
    return ''
  }

  const start = () => {
    const problem = validate(floppy, cdrom)
    setError(problem)
    if (problem !== '') {
      return
    }
    props.onStart(floppy, cdrom, mode)
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    let floppyFile: File | null = null
    let cdromFile: File | null = null
    for (const file of Array.from(e.dataTransfer?.files ?? [])) {
      const name = file.name.toLowerCase()
      if (name.endsWith('.iso')) {
        cdromFile = file
      } else if (name.endsWith('.img')) {
        floppyFile = file
      }
    }
    const problem = validate(floppyFile, cdromFile)
    setError(problem)
    if (problem !== '') {
      return
    }
    setFloppy(floppyFile)
    setCdrom(cdromFile)
    // A dropped image starts a graceful session straight away (index.html:2278).
    props.onStart(floppyFile, cdromFile, 1)
  }

  const summary = !running
    ? S.iderIdle
    : `${S.iderSession}, ${view.status === 'live' ? S.connected : S.connecting}, ${view.bytesFromAmt} ${S.iderIn}, ${view.bytesToAmt} ${S.iderOut}.`

  return (
    <div class="ider">
      <div
        class="statusbar"
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault()
        }}
      >
        <span>{summary}</span>
        <span class="header-spacer" />
        <div class="btn-row">
          {FEAT_IDERStats && running ? (
            <button type="button" class="btn" onClick={() => setMapOpen(!mapOpen)}>
              {S.iderDiskMap}
            </button>
          ) : null}
          {running && view.floppy ? (
            <button type="button" class="btn" onClick={() => props.onEject('floppy')}>
              {S.iderEject} {S.iderFloppyLabel}
            </button>
          ) : null}
          {running && view.cdrom ? (
            <button type="button" class="btn" onClick={() => props.onEject('cdrom')}>
              {S.iderEject} {S.iderCdromLabel}
            </button>
          ) : null}
          {running ? (
            <button type="button" class="btn" onClick={props.onStop}>
              {S.iderStop}
            </button>
          ) : null}
        </div>
      </div>

      {running ? null : (
        <div class="ider-mount">
          <label>
            <span>{S.iderFloppy}</span>
            <input
              type="file"
              accept=".img"
              onChange={(e) => {
                setFloppy(e.currentTarget.files?.[0] ?? null)
                setError('')
              }}
            />
          </label>
          <label>
            <span>{S.iderCdrom}</span>
            <input
              type="file"
              accept=".iso"
              onChange={(e) => {
                setCdrom(e.currentTarget.files?.[0] ?? null)
                setError('')
              }}
            />
          </label>
          <label>
            <span>{S.iderStartMode}</span>
            <select
              value={mode}
              onChange={(e) => setMode(Number(e.currentTarget.value) as IderStartMode)}
            >
              <option value={0}>{S.iderOnReboot}</option>
              <option value={1}>{S.iderGraceful}</option>
              <option value={2}>{S.iderNow}</option>
            </select>
          </label>
          <button type="button" class="btn btn-primary" onClick={start}>
            {S.iderStart}
          </button>
        </div>
      )}

      {error === '' ? null : <p class="ider-error status-error">{error}</p>}

      {FEAT_IDERStats && running && mapOpen && view.heat.length > 0 ? (
        <div class="ider-heat">
          {view.heat.map((heat) => (
            <HeatMap key={heat.device} heat={heat} tick={view.tick} />
          ))}
        </div>
      ) : null}
    </div>
  )
}