/**
 * Firmware console build — single self-contained HTML.
 *
 * Baseline gzipped sizes (mesh theme, `inlineAssetTags → zopfli numiterations:50`):
 *   mandatory-only (Desktop+PowerControl+VersionWarning): 39,228 B
 *   small (15 feats): 46,576 B · medium (24): 60,212 B · large (32): 78,584 B
 * Budget is USER_FLASH_LIMIT = 65,536 B — large cannot fit by trimming: the
 * mandatory core is 60% of the budget before one optional feature, and even
 * brotli q11 measures 70,159 B on this payload (and AMT cannot serve brotli).
 * Fitting `large` means dropping features, not tuning the pipeline.
 * Re-run `bun scripts/measure.ts` after changing console code and update this
 * header and `docs/building.md#baseline` when the numbers move.
 *
 * Minifier benchmark (large mesh, zopfli 50):
 *   oxc  → 78,584 B (winner, kept)
 *   terser {passes:3 toplevel ecma:2023 drop_console} → +144 B
 *   esbuild {drop:['console','debugger']} → +2,280 B
 * Smaller minified ≠ smaller gzipped — keep minify:'oxc'.
 */
import { visualizer } from 'rollup-plugin-visualizer'; // For bundle analysis
import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'
import type { CSSOptions } from 'vite'
import { DEFAULT_TIER, FEATURE_IDS, flagName, resolveFeatures } from '@meshcommander/build-system'
import { themePlugin } from './build/theme-plugin.ts'
import { scriptBlocksPlugin } from './build/script-blocks-plugin.ts'
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
    // `script-blocks.json` enters as a plain object literal: cheaper gzipped than
    // Vite's JSON module, and droppable by a tier with FEAT_Scripting off.
    scriptBlocksPlugin({ file: new URL('./src/lib/script-blocks.json', import.meta.url).pathname }),
    preact(),
    // `ANALYZE=1` writes dist/<build>/bundle-stats.json for the treemap.
    ...(process.env.ANALYZE
      ? [visualizer({
      open: true,
      filename: 'bundle-stats.html',
      gzipSize: true,
      brotliSize: true,
    }),]
      : []),
  ],
  define: { ...flagDefines, __THEME__: JSON.stringify(theme), 'process.env.NODE_ENV': '"production"' },
  // Vite 8/rolldown supports these at runtime; the published UserConfig type here
  // lags behind the implementation, so a narrow unchecked cast is the precise boundary.
  css: {
    transformer: 'lightningcss',
    lightningcss: { targets: { chrome: 110 << 16 } },
  } as unknown as CSSOptions,
  oxc: { removeUnusedImports: true } as unknown as Record<string, boolean>,
  build: {
    outDir: 'dist/' + buildName,
    emptyOutDir: true,
    target: 'es2023',
    cssTarget: 'chrome110',
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 64 * 1024,
    modulePreload: { polyfill: false },
    cssMinify: 'lightningcss',
    minify: 'oxc',
  },
  server: {
    proxy: {
      '/wsman': 'http://127.0.0.1:8765',
      '/ws-redirection': { target: 'ws://127.0.0.1:8765', ws: true },
      '/amt-storage': 'http://127.0.0.1:8765',
    },
  },
}))
