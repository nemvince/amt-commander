import { useEffect, useState } from 'preact/hooks'
import { FEAT_AgentPresence, FEAT_Alarms, FEAT_AuditLog, FEAT_Desktop, FEAT_EventLog, FEAT_EventSubscriptions, FEAT_HardwareInfo, FEAT_InstallFromWeb, FEAT_NetworkSettings, FEAT_RemoteAccess, FEAT_Scripting, FEAT_Storage, FEAT_SystemDefense, FEAT_Terminal } from './features'
import { INSTALL, S } from './strings'
import { connError, connState, pending } from './state/device'
import { NavIcon } from './ui/icons'
import { VersionWarning } from './ui/version-warning'
import { ThemePicker } from './ui/theme-picker'


import { SystemPage } from './pages/system'
import { HardwarePage } from './pages/hardware'
import { EventsPage } from './pages/events'
import { NetworkPage } from './pages/network'
import { StoragePage } from './pages/storage'
import { UsersPage } from './pages/users'
import { AuditPage } from './pages/audit'
import { DefensePage } from './pages/defense'
import { PresencePage } from './pages/presence'
import { AlarmsPage } from './pages/alarms'
import { SubsPage } from './pages/subs'
import { InternetPage } from './pages/internet'
import { ScriptsPage } from './pages/scripts'
import { SolPage } from './pages/sol'
import { KvmPage } from './pages/kvm'
import { InstallPage } from './pages/install'
import './styles/base.css'
import './styles/events.css'
import './styles/hardware.css'
import './styles/ider.css'
import './styles/kvm.css'
import './styles/scripts.css'
import './styles/users.css'


export interface PageDef {
  id: string
  label: string
  icon: string
  group: string
  /**
   * Media pages (Remote Desktop, SOL) fill the viewport instead of flowing down
   * the page: their own bars sit top and bottom with the media in between, and
   * the shell never scrolls them.
   */
  fill?: boolean
  render: () => preact.JSX.Element | null
}

/**
 * Direct conditionals only. `FEAT_Terminal ? page : null` folds to a constant at build
 * time so bundlers can drop the page module (and its CSS) from smaller tiers --
 * computed member access like `PAGES[FEAT_Terminal ? 'a':'b']` would defeat that.
 */
export const PAGES: (PageDef | null)[] = [
  { id: 'system', label: S.navSystem, icon: 'system', group: '', render: () => <SystemPage /> },
  FEAT_Desktop ? { id: 'kvm', label: S.navKvm, icon: 'kvm', group: '', fill: true, render: () => <KvmPage /> } : null,
  FEAT_Terminal ? { id: 'sol', label: S.navSol, icon: 'sol', group: '', fill: true, render: () => <SolPage /> } : null,
  FEAT_HardwareInfo
    ? { id: 'hardware', label: S.navHardware, icon: 'hardware', group: '', render: () => <HardwarePage /> }
    : null,
  FEAT_EventLog ? { id: 'events', label: S.navEvents, icon: 'events', group: '', render: () => <EventsPage /> } : null,
  FEAT_AuditLog ? { id: 'audit', label: S.navAudit, icon: 'audit', group: '', render: () => <AuditPage /> } : null,
  FEAT_Storage ? { id: 'storage', label: S.navStorage, icon: 'storage', group: '', render: () => <StoragePage /> } : null,
  FEAT_NetworkSettings
    ? { id: 'network', label: S.navNetwork, icon: 'network', group: '', render: () => <NetworkPage /> }
    : null,
  // User Accounts is ungated in the legacy app (index.html:778), so it always ships.
  { id: 'users', label: S.navUsers, icon: 'users', group: '', render: () => <UsersPage /> },
  FEAT_SystemDefense
    ? { id: 'defense', label: S.navDefense, icon: 'defense', group: '', render: () => <DefensePage /> }
    : null,
  FEAT_RemoteAccess
    ? { id: 'internet', label: S.navInternet, icon: 'internet', group: '', render: () => <InternetPage /> }
    : null,
  FEAT_AgentPresence
    ? { id: 'presence', label: S.navPresence, icon: 'presence', group: '', render: () => <PresencePage /> }
    : null,
  FEAT_EventSubscriptions
    ? { id: 'subs', label: S.navSubs, icon: 'subs', group: '', render: () => <SubsPage /> }
    : null,
  FEAT_Alarms ? { id: 'alarms', label: S.navAlarms, icon: 'alarms', group: '', render: () => <AlarmsPage /> } : null,
  FEAT_Scripting
    ? { id: 'scripts', label: S.navScripts, icon: 'scripts', group: '', render: () => <ScriptsPage /> }
    : null,
  // Off by default: installing firmware is a shell operation, not a device view.
  FEAT_InstallFromWeb
    ? { id: 'install', label: INSTALL.navInstall, icon: 'install', group: '', render: () => <InstallPage /> }
    : null,
]

const visible = PAGES.filter((p): p is PageDef => p !== null)
const DEFAULT_ROUTE = visible[0]?.id ?? 'system'

function routeFromHash(): string {
  const id = location.hash.replace(/^#\/?/, '')
  return visible.some((p) => p.id === id) ? id : DEFAULT_ROUTE
}

function Chip() {
  const state = connState.value
  const label =
    state === 'connected'
      ? S.connected
      : state === 'connecting'
        ? S.connecting
        : state === 'error'
          ? S.error
          : S.disconnected
  return (
    <span class={'chip ' + state}>
      <i class="chip-dot" />
      {label}
    </span>
  )
}

export function App() {
  const [route, setRoute] = useState(routeFromHash())

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const page = visible.find((p) => p.id === route) ?? visible[0]

  return (
    <div class="shell">
      <div class="brand">
        <span class="brand-mark">M</span>
        <span>{S.appName}</span>
      </div>

      <header class="header">
        <h1 class="header-title">{page?.label}</h1>
        {connError.value !== '' && <span class="status-error">{connError.value}</span>}
        <span class="header-spacer" />
        {pending.value > 0 && (
          <span class="loading-count" role="status" title={S.loading}>
            {pending.value} {S.loading}
          </span>
        )}
        <Chip />
      </header>

      <nav class="nav" aria-label="Views">
        {visible.map((p) => (
          <button
            key={p.id}
            type="button"
            class={'nav-item' + (p.id === page?.id ? ' active' : '')}
            aria-current={p.id === page?.id ? 'page' : undefined}
            onClick={() => {
              location.hash = '#/' + p.id
            }}
          >
            <NavIcon name={p.icon} />
            {p.label}
          </button>
        ))}
      </nav>

      <main class={'main' + (page?.fill === true ? ' main-fill' : '')}>
        <div class={'page' + (page?.fill === true ? ' page-fill' : '')}>
          <VersionWarning />
          {page?.render()}
        </div>
      </main>

      {/* Dev only: the constant folds away in a build, taking the picker and
          the theme list with it. */}
      {import.meta.env.DEV && <ThemePicker />}
    </div>
  )
}