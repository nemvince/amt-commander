/**
 * Icon button that opens a small dropdown menu.
 *
 * Positioning is plain CSS relative to the wrapper: every menu here hangs off a
 * toolbar with room beneath it, so a positioning library would be dead weight in
 * a bundle that has to fit Intel AMT's flash. Closes on outside click, on
 * Escape, and on selection.
 */
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'

export type MenuEntry =
  | { id: string; sep: true }
  | { id: string; heading: string }
  | { id: string; label: string; checked?: boolean; onSelect: () => void }

export interface IconMenuProps {
  /** Accessible name and tooltip for the trigger. */
  label: string
  icon: ComponentChildren
  entries: MenuEntry[]
  /** Hang the panel from the right edge; for triggers near the right side. */
  align?: 'left' | 'right'
}

export function IconMenu(props: IconMenuProps) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    const onDown = (e: MouseEvent) => {
      if (wrap.current == null || !wrap.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div class="menu" ref={wrap}>
      <button
        type="button"
        class={'btn menu-trigger' + (open ? ' is-open' : '')}
        title={props.label}
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {props.icon}
      </button>
      {open && (
        <div class={'menu-panel' + (props.align === 'right' ? ' menu-right' : '')} role="menu">
          {props.entries.map((entry) => {
            if ('sep' in entry) {
              return <div key={entry.id} class="menu-sep" role="separator" />
            }
            if ('heading' in entry) {
              return (
                <div key={entry.id} class="menu-heading">
                  {entry.heading}
                </div>
              )
            }
            return (
              <button
                key={entry.id}
                type="button"
                role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={entry.checked === undefined ? undefined : entry.checked}
                class="menu-item"
                onClick={() => {
                  setOpen(false)
                  entry.onSelect()
                }}
              >
                <span class="menu-tick" aria-hidden="true">
                  {entry.checked === true ? '✓' : ''}
                </span>
                {entry.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
