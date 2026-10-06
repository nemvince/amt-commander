/**
 * Theme registry.
 *
 * A theme is a CSS file under `src/styles/themes/<id>.css` that defines the
 * design tokens twice: once for light and once inside a
 * `@media (prefers-color-scheme: dark)` block. Every selector is scoped to
 * `:root[data-theme="<id>"]` so that several themes can be loaded at once in
 * development, and so the running app can switch by setting one attribute.
 *
 * Production bakes exactly one theme: `build/theme-plugin.ts` serves only the
 * selected file for `virtual:theme.css`, so the others cost nothing.
 */

export interface ThemeDef {
  id: string
  label: string
  description?: string
}

export const THEMES: readonly ThemeDef[] = [
  { id: 'mesh', label: 'Mesh', description: 'The original MeshCommander palette.' },
  { id: 'midnight', label: 'Midnight', description: 'Maximum contrast: true-black pages, deep-blue accents.' },
  { id: 'paper', label: 'Paper', description: 'Warm off-white stock and sepia ink; the quietest theme.' },
  { id: 'amber', label: 'Amber', description: 'High-visibility safety-orange accents on a warm ground.' },
]

export const DEFAULT_THEME = 'mesh'

/** Validate a theme id, falling back to the default when none is given. */
export function resolveTheme(id?: string): string {
  const wanted = id?.trim()
  if (wanted == null || wanted === '') return DEFAULT_THEME
  if (!THEMES.some((t) => t.id === wanted)) {
    throw new Error(`unknown theme "${wanted}", expected one of ${THEMES.map((t) => t.id).join(', ')}`)
  }
  return wanted
}

export function isTheme(id: string): boolean {
  return THEMES.some((t) => t.id === id)
}
