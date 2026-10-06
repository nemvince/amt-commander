import { analyzer } from 'vite-bundle-analyzer'
import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'
import { DEFAULT_TIER, FEATURE_IDS, flagName, resolveFeatures } from '@meshcommander/build-system'
import { themePlugin } from './build/theme-plugin'
import { resolveTheme } from '@meshcommander/build-system/themes'

/**
 * Feature selection: an explicit `FEATURES` list wins, otherwise the `TIER`
 * preset applies. `resolveFeatures` adds mandatory features and closes over
 * `requires`, so callers cannot produce an incoherent set.
 */
const selected = resolveFeatures(process.env.FEATURES, process.env.TIER ?? DEFAULT_TIER)

/** Theme baked into this build. Development loads all of them instead. */
const theme = resolveTheme(process.env.THEME)

/** Where `scripts/build-firmware.ts` will look for the emitted HTML. */
const buildName = process.env.BUILD_NAME ?? process.env.TIER ?? 'custom'

/**
 * One global per feature, as `<id>` -> `<flag>`.
 *
 * Hyphenated legacy names cannot be identifiers (`FEAT.Desktop-Multi` parses as
 * subtraction, `FEAT['Desktop-Multi']` never folds), so each flag is injected as
 * its own global that the minifier collapses to a literal. That constant folding
 * is the only thing that drops whole pages, their libs and their CSS.
 */
const flagDefines = Object.fromEntries(
  FEATURE_IDS.map((id) => [`__FEAT_${flagName(id)}__`, String(selected.has(id))] as const),
)

export default defineConfig(({ command }) => ({
  plugins: [
    // Development needs every theme so the overlay can switch at runtime; a
    // build gets only the selected one.
    themePlugin({ theme, dev: command === 'serve' }),
    preact(),
    // `ANALYZE=1` writes dist/<build>/bundle-stats.json for the treemap.
    ...(process.env.ANALYZE
      ? [analyzer({ analyzerMode: 'json', fileName: 'bundle-stats.json', defaultSizes: 'gzip' })]
      : []),
  ],
  define: { ...flagDefines, __THEME__: JSON.stringify(theme) },
  build: {
    outDir: 'dist/' + buildName,
    emptyOutDir: true,
    target: 'es2023',
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    // Measured: terser with aggressive settings came out ~900 B *larger*
    // gzipped than the stock minifier here. Smaller minified output does not
    // mean smaller gzipped output, so this is left at the default.
  },
  server: {
    proxy: {
      '/wsman': 'http://127.0.0.1:8765',
      '/ws-redirection': { target: 'ws://127.0.0.1:8765', ws: true },
      '/amt-storage': 'http://127.0.0.1:8765',
    },
  },
}))
