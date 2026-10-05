/**
 * IDER status bar, shared by the SOL and Remote Desktop views.
 *
 * Legacy renders IDER as a status overlay bar inside those two views
 * (index.html:820-838, wired at :9660). Owning the engine here keeps the two
 * pages free of IDER imports beyond this one component.
 */
import { useEffect, useMemo } from 'preact/hooks'
import { FEAT_IDER } from '../features'
import { createIder, type IderDevice, type IderStartMode } from '../lib/ider'
import { IderOverlay } from './ider-overlay'

export function IderBar() {
  const engine = useMemo(() => createIder(), [])
  useEffect(() => () => engine.stop(), [engine])

  if (!FEAT_IDER) return null

  return (
    <IderOverlay
      view={engine.view}
      onStart={(floppy: File | null, cdrom: File | null, mode: IderStartMode) =>
        engine.start({ floppy, cdrom, mode })
      }
      onEject={(device: IderDevice) => engine.eject(device)}
      onStop={() => engine.stop()}
    />
  )
}