/// <reference types="vite/client" />

/** Replaced at build time by vite `define` with the active tier's flag object. */
declare const __FEATURES__: Record<string, boolean>

/** Theme id baked into this build, from the `THEME` environment variable. */
declare const __THEME__: string

/**
 * Served by `build/theme-plugin.ts`: the selected theme in a build, every theme
 * in development. Typescript needs the specifier declared because it is not a
 * path on disk.
 */
declare module 'virtual:theme.css'
