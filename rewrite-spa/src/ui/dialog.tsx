/**
 * Generic modal dialog, replacing the legacy 27 hand-rolled modals driven by
 * setDialogMode(mode, title, buttons, cb, content, tag).
 *
 * Legacy semantics kept: a title bar, a body that renders a caller-supplied node,
 * a row of buttons whose click resolves the caller's callback, and Escape / click
 * on the backdrop / the close button all resolving to the same cancel path.
 */
import type { ComponentChildren } from 'preact'
import { useEffect } from 'preact/hooks'
import { S } from '../strings'

export interface DialogProps {
  title: string
  /** Receives the pressed button's `value`, or 'cancel' for Escape/backdrop/close. */
  onClose: (value: string) => void
  /** Button row. `value` is handed back to onClose, mirroring the legacy callback. */
  buttons?: { label: string; value: string; primary?: boolean }[]
  width?: number
  children: ComponentChildren
}

export function Dialog(props: DialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose('cancel')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div class="dialog-backdrop" onClick={() => props.onClose('cancel')}>
      <div
        class="dialog"
        style={props.width ? { maxWidth: props.width + 'px' } : undefined}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <div class="dialog-title">
          <span>{props.title}</span>
          <button type="button" class="dialog-close" onClick={() => props.onClose('cancel')} aria-label={S.close}>
            ×
          </button>
        </div>
        <div class="dialog-body">{props.children}</div>
        {(props.buttons?.length ?? 0) > 0 && (
          <div class="dialog-buttons">
            {props.buttons!.map((b) => (
              <button
                key={b.value}
                type="button"
                class={b.primary ? 'btn btn-primary' : 'btn'}
                onClick={() => props.onClose(b.value)}
              >
                {b.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}