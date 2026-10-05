/**
 * Serves `virtual:theme.css`.
 *
 * In production the module contains exactly the selected theme, so the other
 * themes are not in the bundle at all. In development it concatenates every
 * theme file, which is what lets the dev overlay switch themes at runtime by
 * setting `data-theme` on the document element.
 *
 * The module id ends in `.css` so Vite runs it through the CSS pipeline.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

export const THEME_MODULE = 'virtual:theme.css'
const RESOLVED = '\0' + THEME_MODULE

export interface ThemePluginOptions {
  /** Theme id baked into the build. */
  theme: string
  /** Dev mode loads every theme so the overlay can switch. */
  dev: boolean
}

function themeDir(): string {
  return new URL('../src/styles/themes/', import.meta.url).pathname
}

export function themePlugin(options: ThemePluginOptions): Plugin {
  return {
    name: 'meshcommander:theme',
    resolveId(id) {
      return id === THEME_MODULE ? RESOLVED : null
    },
    load(id) {
      if (id !== RESOLVED) return null
      const dir = themeDir()
      const files = readdirSync(dir).filter((f) => f.endsWith('.css')).sort()
      if (options.dev) {
        // Without these the module registers no file dependency, so editing a
        // theme neither hot-reloads nor invalidates on a full page reload --
        // you keep testing a stale concatenation until vite restarts.
        for (const f of files) this.addWatchFile(join(dir, f))
        return files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
      }
      const chosen = join(dir, `${options.theme}.css`)
      this.addWatchFile(chosen)
      return readFileSync(chosen, 'utf8')
    },
  }
}
