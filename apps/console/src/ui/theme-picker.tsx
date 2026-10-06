/**
 * Development-only theme switcher.
 *
 * In dev `theme-plugin.ts` loads every theme file at once, so flipping
 * `data-theme` on <html> repaints the app with no reload. The choice is kept in
 * localStorage because the dev server reloads on every save, and a reload would
 * otherwise snap back to whatever `__THEME__` the build was configured with.
 *
 * In a build `import.meta.env.DEV` folds to `false`, so app.tsx drops this
 * module -- and its import of THEMES -- entirely.
 */
import { useEffect, useState } from 'preact/hooks'
import { THEMES } from '@meshcommander/build-system/themes'
import '../styles/theme-picker.css'

const STORAGE_KEY = 'theme'

export function ThemePicker() {
  const [active, setActive] = useState(() => document.documentElement.dataset.theme ?? '')

  // main.tsx already set the build's theme; a stored choice overrides it.
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored != null && THEMES.some((t) => t.id === stored)) {
      document.documentElement.dataset.theme = stored
      setActive(stored)
    }
  }, [])

  function pick(id: string) {
    document.documentElement.dataset.theme = id
    localStorage.setItem(STORAGE_KEY, id)
    setActive(id)
  }

  return (
    <div class="theme-picker" role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          class={'theme-swatch' + (t.id === active ? ' active' : '')}
          title={t.description ?? t.label}
          aria-pressed={t.id === active}
          onClick={() => pick(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
