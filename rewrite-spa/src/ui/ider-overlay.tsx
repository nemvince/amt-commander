/**
 * IDER overlay: session toolbar, mount controls and the per-device sector map.
 *
 * Replaces the legacy `#id_iderstatus` bar (index.html:820-838), the start dialog
 * (index.html:9634) and `iderSectorStats`'s canvas drawing (index.html:9737-9769).
 *
 * The component is engine-free by design: it reads a plain snapshot through a
 * signal and reports user intent through callbacks, so a page can drop it in
 * without importing the IDER client. That keeps the engine and its CSS out of
 * pages that never render the bar.
 *
 * Layout is one toolbar row: state on the left, controls on the right. Idle and
 * running are the same row -- mounting uses file buttons that show the chosen
 * filename, and a running session shows ejectable chips instead.
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
  const [dragging, setDragging] = useState(false)
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
    setDragging(false)
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

  /** One mount slot: a button-shaped label over a hidden native file input. */
  const picker = (file: File | null, set: (f: File | null) => void, label: string, accept: string) => (
    <>
      <label class={'btn ider-pick' + (file == null ? '' : ' is-set')} title={label}>
        <input
          type="file"
          accept={accept}
          onChange={(e) => {
            set(e.currentTarget.files?.[0] ?? null)
            setError('')
          }}
        />
        <span class="ider-pick-name">{file == null ? label : file.name}</span>
      </label>
      {file == null ? null : (
        <button
          type="button"
          class="ider-x"
          title={S.clear}
          aria-label={S.clear}
          onClick={() => set(null)}
        />
      )}
    </>
  )

  return (
    <div
      class={'ider' + (dragging ? ' ider-dragging' : '')}
      onDrop={onDrop}
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragging) {
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        const to = e.relatedTarget as Node | null
        if (to != null && e.currentTarget.contains(to)) {
          return
        }
        setDragging(false)
      }}
    >
      <div class="ider-toolbar">
        <span class={'ider-state ider-state-' + view.status}>
          <span class="ider-dot" aria-hidden="true" />
          {running ? S.iderSession : S.iderIdle}
        </span>

        {running ? (
          <>
            <span class={'ider-pill ider-pill-' + view.status}>
              {view.status === 'live' ? S.connected : S.connecting}
            </span>
            <span class="ider-counters mono">
              {view.bytesFromAmt} {S.iderIn} · {view.bytesToAmt} {S.iderOut}
            </span>
          </>
        ) : null}

        <span class="header-spacer" />

        {running ? (
          <>
            {view.floppy == null ? null : (
              <span class="ider-chip">
                <span class="ider-chip-kind">{S.iderFloppyLabel}</span>
                <span class="ider-chip-name mono">{view.floppy.name}</span>
                <button
                  type="button"
                  class="ider-x"
                  title={S.iderEject}
                  aria-label={S.iderEject}
                  onClick={() => props.onEject('floppy')}
                />
              </span>
            )}
            {view.cdrom == null ? null : (
              <span class="ider-chip">
                <span class="ider-chip-kind">{S.iderCdromLabel}</span>
                <span class="ider-chip-name mono">{view.cdrom.name}</span>
                <button
                  type="button"
                  class="ider-x"
                  title={S.iderEject}
                  aria-label={S.iderEject}
                  onClick={() => props.onEject('cdrom')}
                />
              </span>
            )}
            {FEAT_IDERStats ? (
              <button
                type="button"
                class={'btn' + (mapOpen ? ' btn-primary' : '')}
                aria-pressed={mapOpen}
                onClick={() => setMapOpen(!mapOpen)}
              >
                {S.iderDiskMap}
              </button>
            ) : null}
            <button type="button" class="btn" onClick={props.onStop}>
              {S.iderStop}
            </button>
          </>
        ) : (
          <>
            <span class="ider-hint">{S.iderDropHint}</span>
            {picker(floppy, setFloppy, S.iderFloppy, '.img')}
            {picker(cdrom, setCdrom, S.iderCdrom, '.iso')}
            <select
              class="ider-mode"
              value={mode}
              title={S.iderStartMode}
              aria-label={S.iderStartMode}
              onChange={(e) => setMode(Number(e.currentTarget.value) as IderStartMode)}
            >
              <option value={0}>{S.iderOnReboot}</option>
              <option value={1}>{S.iderGraceful}</option>
              <option value={2}>{S.iderNow}</option>
            </select>
            <button
              type="button"
              class="btn btn-primary"
              disabled={floppy == null && cdrom == null}
              onClick={start}
            >
              {S.iderStart}
            </button>
          </>
        )}
      </div>

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
