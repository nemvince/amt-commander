/**
 * The feature manifest: one entry per toggleable feature.
 *
 * This is the single source of truth for the build system. `vite.config.ts`
 * turns a selection into `__FEAT_*__` define globals, the CLI/TUI renders the
 * picker from it, and the size estimator walks it. Adding a feature means adding
 * an entry here plus the `FEAT_*` export it gates in `src/features.ts`.
 *
 * Grouping, labels and dependencies live here rather than in the picker so that
 * the CLI, the TUI and any future front-end all present the same model.
 */

export interface FeatureDef {
  /** The legacy flag name, e.g. `Desktop-Multi`. Used as the id everywhere. */
  id: string
  /** Human label for pickers. */
  label: string
  /** Picker section. */
  group: string
  /** One-line explanation of what turning this off costs you. */
  description?: string
  /** Always enabled; `resolveFeatures` re-adds it even if omitted. */
  mandatory?: boolean
  /** Enabled when no explicit selection is given. */
  default?: boolean
  /** Features pulled in automatically when this one is on. */
  requires?: string[]
  /**
   * Part of the legacy flag vocabulary but gating nothing in this codebase, so
   * the pickers hide it. Kept so the tier presets stay byte-compatible with the
   * original compiler manifests.
   */
  inert?: boolean
}

/**
 * The remote-desktop core is mandatory: this is a KVM console, and the advisory
 * banner is a security notice rather than a feature.
 */
export const FEATURES: readonly FeatureDef[] = [
  // --- Shell -----------------------------------------------------------------
  { id: 'VersionWarning', label: 'Firmware advisory', group: 'Shell', mandatory: true,
    description: 'Banner warning when the installed AMT firmware has a known advisory.' },
  { id: 'FileSaver', label: 'Save to file', group: 'Shell',
    description: 'Download buttons for reports and logs.' },

  // --- Remote desktop --------------------------------------------------------
  { id: 'Desktop', label: 'Remote desktop (KVM)', group: 'Remote desktop', mandatory: true,
    description: 'The KVM viewer itself.' },
  { id: 'Desktop-Multi', label: 'Multiple displays', group: 'Remote desktop', requires: ['Desktop'],
    description: 'Switch between the machine\'s monitors.' },
  { id: 'DesktopRotation', label: 'Rotate display', group: 'Remote desktop', requires: ['Desktop'],
    description: 'Quarter-turn the viewer.' },
  { id: 'Desktop-Settings', label: 'Viewer settings', group: 'Remote desktop', requires: ['Desktop'],
    description: 'Encoding, colour depth and bandwidth options.' },
  { id: 'DesktopType', label: 'Type text', group: 'Remote desktop', requires: ['Desktop'],
    description: 'Send a block of text as keystrokes.' },
  { id: 'DesktopFocus', label: 'Focus mode', group: 'Remote desktop', requires: ['Desktop'],
    description: 'Repaint only the region around the pointer.' },

  // --- Serial and IDE redirection -------------------------------------------
  { id: 'Terminal', label: 'Serial-over-LAN', group: 'Serial / IDE-R',
    description: 'The SOL terminal page.' },
  { id: 'TerminalSize', label: 'Terminal size', group: 'Serial / IDE-R', requires: ['Terminal'],
    description: '80x25 / 100x30 selector.' },
  { id: 'Terminal-Enumation-All', label: 'Character encoding', group: 'Serial / IDE-R', requires: ['Terminal'],
    description: 'UTF-8 / Extended Ascii / Intel Ascii.' },
  { id: 'Terminal-FxEnumation-All', label: 'F-key emulation', group: 'Serial / IDE-R', requires: ['Terminal'],
    description: 'Intel / alternate / VT100+ function keys.' },
  { id: 'IDER', label: 'IDE redirection', group: 'Serial / IDE-R',
    description: 'Mount floppy and CD images over IDE-R.' },
  { id: 'IDERStats', label: 'IDE-R disk map', group: 'Serial / IDE-R', requires: ['IDER'],
    description: 'Per-sector read activity map for mounted images.' },

  // --- Machine information ---------------------------------------------------
  { id: 'HardwareInfo', label: 'Hardware information', group: 'Information',
    description: 'SMBIOS inventory, processors and memory.' },
  { id: 'EventLog', label: 'Event log', group: 'Information',
    description: 'AMT firmware event log.' },
  { id: 'AuditLog', label: 'Audit log', group: 'Information',
    description: 'Security audit trail.' },
  { id: 'Storage', label: 'Storage', group: 'Information',
    description: 'User-flash volumes and files.' },
  { id: 'NetworkSettings', label: 'Network settings', group: 'Information',
    description: 'Wired interface configuration.' },
  { id: 'Wireless', label: 'Wireless profiles', group: 'Information', requires: ['NetworkSettings'],
    description: 'Wi-Fi profile list within network settings.' },
  { id: 'PowerControl', label: 'Power control', group: 'Information', mandatory: true,
    description: 'Power on/off/reset actions.' },
  { id: 'PowerControl-Advanced', label: 'Advanced power', group: 'Information', requires: ['PowerControl'],
    description: 'Boot-to-BIOS, diagnostic boot and erase actions.' },

  // --- Management ------------------------------------------------------------
  { id: 'SystemDefense', label: 'System defense', group: 'Management',
    description: 'Network filters and policies.' },
  { id: 'RemoteAccess', label: 'Internet settings', group: 'Management',
    description: 'CIRA / remote access configuration.' },
  { id: 'AgentPresence', label: 'Agent presence', group: 'Management',
    description: 'Agent watchdog state.' },
  { id: 'Alarms', label: 'Wake alarms', group: 'Management',
    description: 'Scheduled power-up alarms.' },
  { id: 'EventSubscriptions', label: 'Subscriptions', group: 'Management',
    description: 'Event subscription filters.' },
  { id: 'Scripting', label: 'Scripting engine', group: 'Management',
    description: 'Run ME scripts from the console.' },
  { id: 'Scripting-Editor', label: 'Script editor', group: 'Management', requires: ['Scripting'],
    description: 'Block-based script builder UI.' },

  // --- Inert legacy flags ----------------------------------------------------
  { id: 'Look-Commander', label: 'Commander look', group: 'Edition', inert: true },
  { id: 'Mode-Firmware', label: 'Firmware mode', group: 'Edition', inert: true,
    description: 'Edition marker from the original compiler manifest.' },
  { id: 'ContextMenus', label: 'Context menus', group: 'Edition', inert: true },
]

export const FEATURE_IDS: readonly string[] = FEATURES.map((f) => f.id)

const BY_ID = new Map(FEATURES.map((f) => [f.id, f]))

/** Pickers skip these: they gate nothing, so showing them would mislead. */
export const VISIBLE_FEATURES: readonly FeatureDef[] = FEATURES.filter((f) => f.inert !== true)

export const MANDATORY: readonly string[] = FEATURES.filter((f) => f.mandatory === true).map((f) => f.id)

/**
 * Tier presets, kept so existing builds and the byte-verified historical
 * manifests keep working. A preset is just a named feature selection; the
 * per-feature toggles are the real mechanism.
 */
const PRESET_SMALL: readonly string[] = [
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
]

const PRESET_MEDIUM_ONLY: readonly string[] = [
  'AuditLog',
  'FileSaver',
  'IDER',
  'RemoteAccess',
  'SystemDefense',
  'Terminal',
  'Terminal-Enumation-All',
  'Terminal-FxEnumation-All',
  'TerminalSize',
]

const PRESET_LARGE_ONLY: readonly string[] = [
  'AgentPresence',
  'Alarms',
  'ContextMenus',
  'DesktopFocus',
  'EventSubscriptions',
  'IDERStats',
  'Scripting',
  'Scripting-Editor',
]

export const TIERS: Record<string, readonly string[]> = {
  small: PRESET_SMALL,
  medium: [...PRESET_SMALL, ...PRESET_MEDIUM_ONLY],
  large: [...PRESET_SMALL, ...PRESET_MEDIUM_ONLY, ...PRESET_LARGE_ONLY],
}

export const DEFAULT_TIER = 'large'

/**
 * `Desktop-Multi` -> `DesktopMulti`.
 *
 * Hyphenated names cannot be identifiers (`FEAT.Desktop-Multi` parses as
 * subtraction, `FEAT['Desktop-Multi']` never folds), so each flag is injected as
 * its own global that the minifier collapses to a literal. That constant folding
 * is the only thing that drops whole pages, their libs and their CSS.
 */
export function flagName(id: string): string {
  const def = BY_ID.get(id)
  if (def == null) throw new Error(`unknown feature "${id}"`)
  return id.replace(/-/g, '')
}

/** Feature ids grouped for display, in manifest order, inert ones removed. */
export function featuresByGroup(): Map<string, FeatureDef[]> {
  const out = new Map<string, FeatureDef[]>()
  for (const f of VISIBLE_FEATURES) {
    const list = out.get(f.group)
    if (list == null) out.set(f.group, [f])
    else list.push(f)
  }
  return out
}

/** Ids pulled in transitively by `requires`, plus the mandatory core. */
function closeOver(seed: Iterable<string>): Set<string> {
  const out = new Set<string>()
  const queue = [...seed, ...MANDATORY]
  while (queue.length > 0) {
    const id = queue.pop()!
    if (out.has(id)) continue
    if (!BY_ID.has(id)) throw new Error(`unknown feature "${id}"`)
    out.add(id)
    for (const dep of BY_ID.get(id)!.requires ?? []) queue.push(dep)
  }
  return out
}

/**
 * Turn a selection into the final feature set.
 *
 * `spec` is a comma-separated list of feature ids. When omitted, the tier preset
 * (or the manifest defaults) applies. Mandatory features and `requires`
 * dependencies are always added.
 */
export function resolveFeatures(spec?: string, tier?: string): Set<string> {
  const trimmed = spec?.trim()
  if (trimmed != null && trimmed !== '') {
    const ids = trimmed.split(',').map((s) => s.trim()).filter((s) => s !== '')
    return closeOver(ids)
  }
  const t = tier ?? DEFAULT_TIER
  const preset = TIERS[t]
  if (preset == null) throw new Error(`unknown tier "${t}", expected one of ${Object.keys(TIERS).join(', ')}`)
  return closeOver(preset)
}

/** Inverse of a selection, for the picker: ids currently on. */
export function isEnabled(selection: Set<string>, id: string): boolean {
  return selection.has(id)
}
