import { analyzer } from 'vite-bundle-analyzer'
import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

export type Tier = 'small' | 'medium' | 'large'

/**
 * Feature flag sets, byte-verified against websitecompiler/Firmware-MeshCommander.wcc.
 * small(15) < medium(24) < large(32); each tier is a strict superset of the one below.
 */
const SMALL = [
  'Look-Commander',
  'Mode-Firmware',
  'VersionWarning',
  'Desktop',
  'Desktop-Multi',
  'DesktopRotation',
  'Desktop-Settings',
  'DesktopType',
  'EventLog',
  'HardwareInfo',
  'NetworkSettings',
  'PowerControl',
  'PowerControl-Advanced',
  'Storage',
  'Wireless',
] as const

const MEDIUM_ONLY = [
  'AuditLog',
  'FileSaver',
  'IDER',
  'RemoteAccess',
  'SystemDefense',
  'Terminal',
  'Terminal-Enumation-All',
  'Terminal-FxEnumation-All',
  'TerminalSize',
] as const

const LARGE_ONLY = [
  'AgentPresence',
  'Alarms',
  'ContextMenus',
  'DesktopFocus',
  'EventSubscriptions',
  'IDERStats',
  'Scripting',
  'Scripting-Editor',
] as const

export const TIERS: Record<Tier, readonly string[]> = {
  small: SMALL,
  medium: [...SMALL, ...MEDIUM_ONLY],
  large: [...SMALL, ...MEDIUM_ONLY, ...LARGE_ONLY],
}

const TIER = (process.env.TIER ?? 'large') as Tier
if (!(TIER in TIERS)) throw new Error(`Unknown TIER=${TIER}, expected one of ${Object.keys(TIERS)}`)

const ALL_FLAGS = [...new Set([...SMALL, ...MEDIUM_ONLY, ...LARGE_ONLY])]
const active = new Set(TIERS[TIER])

/**
 * Hyphenated legacy flag names cannot be identifiers (`FEAT.Desktop-Multi` parses
 * as subtraction, and `FEAT['Desktop-Multi']` never folds), so each flag is
 * injected as its own global -- `__FEAT_DesktopMulti__` -- which the minifier
 * collapses to a literal. That constant folding is the only thing that lets whole
 * pages, their libs and their CSS drop out of a tier; an object property read
 * stays dynamic, and every tier came out byte-identical.
 */
const ALIASES: Record<string, string> = {
  'Look-Commander': 'LookCommander',
  'Mode-Firmware': 'ModeFirmware',
  'Scripting-Editor': 'ScriptingEditor',
  'Desktop-Multi': 'DesktopMulti',
  'Desktop-Settings': 'DesktopSettings',
  'PowerControl-Advanced': 'PowerControlAdvanced',
  'Terminal-Enumation-All': 'TerminalEnumationAll',
  'Terminal-FxEnumation-All': 'TerminalFxEnumationAll',
}

// A hyphenated flag with no alias emits an invalid identifier that `define` silently
// skips, so the failure would surface as a blank app at runtime. Fail here instead.
for (const f of ALL_FLAGS) {
  if (!/^__FEAT_[A-Za-z0-9]+__$/.test(`__FEAT_${ALIASES[f] ?? f}__`)) {
    throw new Error(`Feature flag "${f}" needs an ALIASES entry in vite.config.ts`)
  }
}

const flagDefines = Object.fromEntries(
  ALL_FLAGS.map((f) => [`__FEAT_${ALIASES[f] ?? f}__`, String(active.has(f))] as const),
)

export default defineConfig({
  // `ANALYZE=1` writes dist/<tier>/bundle-stats.json for the treemap; the plugin
  // is skipped otherwise so ordinary builds stay fast.
  plugins: [
    preact(),
    ...(process.env.ANALYZE
      ? [analyzer({ analyzerMode: 'json', fileName: 'bundle-stats.json', defaultSizes: 'gzip' })]
      : []),
  ],
  define: flagDefines,
  build: {
    outDir: 'dist/' + TIER,
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
})