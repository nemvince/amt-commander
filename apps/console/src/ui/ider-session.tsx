/**
 * IDE-R control shared by the Remote Desktop and Serial-over-LAN windows.
 *
 * Both pages present IDE-R the same way: a toolbar button that opens a dialog
 * holding the mount controls, with a chip in the status bar saying what is
 * redirected. The dialog is not the session -- the engine lives on the page, so
 * closing it never ejects a mounted medium.
 */
import { useState } from 'preact/hooks'
import type { IderEngine, IderView } from '../lib/ider'
import { S } from '../strings'
import { Dialog } from './dialog'
import { IderOverlay } from './ider-overlay'

/** What the status chip shows: whether anything is redirected, and what. */
export function iderSummary(view: IderView | null): { live: boolean; connected: boolean; label: string } {
  /*
   * A mounted image is not a redirected one: the engine keeps the file chosen
   * after a stop so it can be restarted, so both the button and the chip follow
   * `status` and would otherwise claim a session that is not there.
   */
  const live = view != null && view.status !== 'idle'
  const media = view == null ? [] : [view.floppy, view.cdrom].filter((m) => m != null)
  const label = media.length > 0 ? `${S.kvmIder} ${media.map((m) => m?.name).join(', ')}` : S.kvmIder
  return { live, connected: view?.status === 'live', label }
}

export interface IderSessionButtonProps {
  /** Null on a tier without IDER, which renders nothing. */
  engine: IderEngine | null
  /**
   * Called as the dialog opens and closes. Remote Desktop uses it to stop
   * routing keystrokes into the session while a modal is up.
   */
  onOpenChange?: (open: boolean) => void
}

export function IderSessionButton({ engine, onOpenChange }: IderSessionButtonProps) {
  const [open, setOpen] = useState(false)
  if (engine == null) return null
  const { live } = iderSummary(engine.view.value)

  const set = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }

  return (
    <>
      <button
        type="button"
        class={'btn' + (live ? ' btn-primary' : '')}
        title={S.iderSession}
        aria-pressed={live}
        onClick={() => set(true)}
      >
        {S.kvmIder}
      </button>
      {open && (
        <Dialog title={S.iderSession} onClose={() => set(false)}>
          <IderOverlay
            view={engine.view}
            onStart={(floppy, cdrom, mode) => engine.start({ floppy, cdrom, mode })}
            onEject={(device) => engine.eject(device)}
            onStop={() => engine.stop()}
          />
        </Dialog>
      )}
    </>
  )
}
