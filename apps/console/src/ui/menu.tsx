/**
 * Icon button that opens a small dropdown menu.
 *
 * The panel is `position: fixed` and placed from the trigger's rect, rather than
 * absolutely positioned against the wrapper. Every menu here hangs off
 * `.media-bar`, and that bar is a scroll container (`overflow-x: auto`, which
 * computes to `overflow-y: auto` as well) so that a cramped toolbar can be
 * scrolled instead of clipping controls nobody could reach. An absolutely
 * positioned panel is a descendant of that container, so the browser clipped it
 * to the bar's ~33px height: the menu rendered behind the video stage, and the
 * panel's own height inflated the bar's `scrollHeight`, which is what made the
 * toolbar scroll vertically. Fixed positioning leaves the scroll container, so
 * neither happens.
 *
 * Closes on outside click, on Escape, and on selection.
 */
import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

export type MenuEntry =
  | { id: string; heading: string }
  | {
      id: string
      label: string
      checked?: boolean
      onSelect: () => void
      /** Shown but not selectable -- e.g. a key that needs a live session. */
      disabled?: boolean
    }
  /*
   * A labelled `<select>`, for a setting with more than two states. Kept in the
   * menu rather than sent to a dialog so every viewer setting is in one place,
   * and it does not close the menu: choosing a value is not "picking an action".
   */
  | {
      id: string
      label: string
      select: {
        value: string
        options: readonly { value: string; label: string }[]
        onChange: (value: string) => void
      }
    }

export interface IconMenuProps {
  /** Accessible name and tooltip for the trigger. */
  label: string
  icon: ComponentChildren
  entries: MenuEntry[]
  /** Called on every open/close; used to fetch data the entries need. */
  onOpenChange?: (open: boolean) => void
}

/** Gap between the trigger and the panel, in px. */
const GAP = 4

export function IconMenu(props: IconMenuProps) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)

  /*
   * Placed in a layout effect, before the first paint, so the panel never shows
   * at the viewport's top-left corner for a frame. Styles are written straight
   * onto the node rather than held in state: the position is a measurement of
   * the DOM, so round-tripping it through a render only adds a frame of lag and
   * a chance to disagree with what was measured.
   *
   * Re-placed on scroll rather than dismissed: the trigger lives in a toolbar
   * that scrolls horizontally, so the panel has to follow the button it belongs
   * to. Capture phase, because the scrolling element is an ancestor.
   */
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    const place = () => {
      const trigger = wrap.current
      const box = panel.current
      if (trigger == null || box == null) {
        return
      }
      const rect = trigger.getBoundingClientRect()
      // Keep the panel on screen; the trigger itself is always in view.
      const left = Math.min(
        Math.max(GAP, rect.left),
        Math.max(GAP, window.innerWidth - box.offsetWidth - GAP),
      )
      const below = rect.bottom + GAP
      const top =
        below + box.offsetHeight > window.innerHeight - GAP
          ? Math.max(GAP, rect.top - GAP - box.offsetHeight)
          : below
      box.style.top = `${top}px`
      box.style.left = `${left}px`
      box.style.visibility = 'visible'
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

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
        onClick={() => {
          props.onOpenChange?.(!open)
          setOpen(!open)
        }}
      >
        {props.icon}
      </button>
      {open && (
        <div class="menu-panel" role="menu" ref={panel}>
          {props.entries.map((entry) => {
            if ('heading' in entry) {
              return (
                <div key={entry.id} class="menu-heading">
                  {entry.heading}
                </div>
              )
            }
            if ('select' in entry) {
              return (
                <label key={entry.id} class="menu-field">
                  <span>{entry.label}</span>
                  <select
                    value={entry.select.value}
                    onChange={(e) => entry.select.onChange(e.currentTarget.value)}
                  >
                    {entry.select.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              )
            }
            return (
              <button
                key={entry.id}
                type="button"
                role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={entry.checked === undefined ? undefined : entry.checked}
                class="menu-item"
                disabled={entry.disabled === true}
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
