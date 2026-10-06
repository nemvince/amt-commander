/**
 * Build-time feature flags.
 *
 * Each flag is its own compile-time constant rather than a property of an object.
 * An object property read survives bundling as a dynamic lookup, so `FEAT.Desktop`
 * never folds to a constant and no branch -- and therefore no page module or its
 * CSS -- is ever dropped; every tier came out byte-identical. Referencing a bare
 * global that `define` replaced with `true`/`false` folds reliably, which is what
 * actually shrinks the smaller tiers.
 *
 * Flag names come from the legacy `.wcc` build (hyphenated names such as
 * `Desktop-Multi` are exposed under a camelCase alias, since a hyphenated name
 * cannot be written as an identifier at all).
 */

/** Every flag as a bare global, replaced by vite's `define` at build time. */
declare const __FEAT_VersionWarning__: boolean
declare const __FEAT_FileSaver__: boolean
declare const __FEAT_Desktop__: boolean
declare const __FEAT_DesktopMulti__: boolean
declare const __FEAT_DesktopRotation__: boolean
declare const __FEAT_DesktopSettings__: boolean
declare const __FEAT_DesktopType__: boolean
declare const __FEAT_DesktopFocus__: boolean
declare const __FEAT_Terminal__: boolean
declare const __FEAT_TerminalSize__: boolean
declare const __FEAT_TerminalEnumationAll__: boolean
declare const __FEAT_TerminalFxEnumationAll__: boolean
declare const __FEAT_IDER__: boolean
declare const __FEAT_IDERStats__: boolean
declare const __FEAT_HardwareInfo__: boolean
declare const __FEAT_EventLog__: boolean
declare const __FEAT_AuditLog__: boolean
declare const __FEAT_Storage__: boolean
declare const __FEAT_NetworkSettings__: boolean
declare const __FEAT_Wireless__: boolean
declare const __FEAT_SystemDefense__: boolean
declare const __FEAT_AgentPresence__: boolean
declare const __FEAT_Alarms__: boolean
declare const __FEAT_Scripting__: boolean
declare const __FEAT_ScriptingEditor__: boolean
declare const __FEAT_EventSubscriptions__: boolean
declare const __FEAT_RemoteAccess__: boolean
declare const __FEAT_PowerControl__: boolean
declare const __FEAT_InstallFromWeb__: boolean


// Shell
export const FEAT_VersionWarning = __FEAT_VersionWarning__
export const FEAT_FileSaver = __FEAT_FileSaver__

// Remote desktop
export const FEAT_Desktop = __FEAT_Desktop__
export const FEAT_DesktopMulti = __FEAT_DesktopMulti__
export const FEAT_DesktopRotation = __FEAT_DesktopRotation__
export const FEAT_DesktopSettings = __FEAT_DesktopSettings__
export const FEAT_DesktopType = __FEAT_DesktopType__
export const FEAT_DesktopFocus = __FEAT_DesktopFocus__

// Serial over LAN
export const FEAT_Terminal = __FEAT_Terminal__
export const FEAT_TerminalSize = __FEAT_TerminalSize__
export const FEAT_TerminalEnumationAll = __FEAT_TerminalEnumationAll__
export const FEAT_TerminalFxEnumationAll = __FEAT_TerminalFxEnumationAll__

// IDER
export const FEAT_IDER = __FEAT_IDER__
export const FEAT_IDERStats = __FEAT_IDERStats__

// Feature pages
export const FEAT_HardwareInfo = __FEAT_HardwareInfo__
export const FEAT_EventLog = __FEAT_EventLog__
export const FEAT_AuditLog = __FEAT_AuditLog__
export const FEAT_Storage = __FEAT_Storage__
export const FEAT_NetworkSettings = __FEAT_NetworkSettings__
export const FEAT_Wireless = __FEAT_Wireless__
export const FEAT_SystemDefense = __FEAT_SystemDefense__
export const FEAT_AgentPresence = __FEAT_AgentPresence__
export const FEAT_Alarms = __FEAT_Alarms__
export const FEAT_Scripting = __FEAT_Scripting__
export const FEAT_ScriptingEditor = __FEAT_ScriptingEditor__
export const FEAT_EventSubscriptions = __FEAT_EventSubscriptions__
export const FEAT_RemoteAccess = __FEAT_RemoteAccess__

// Power
export const FEAT_PowerControl = __FEAT_PowerControl__

// Install from web (opt-in; see pages/install.tsx)
export const FEAT_InstallFromWeb = __FEAT_InstallFromWeb__
