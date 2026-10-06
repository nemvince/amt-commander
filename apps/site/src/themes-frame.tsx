/**
 * One theme, painted in its own document.
 *
 * Theme tokens are scoped to `:root[data-theme="<id>"]`, so the only way to show
 * four themes at once is four documents -- the gallery frames this page once per
 * theme and sets the attribute from the query string. The markup is a slice of
 * the console's own shell with the console's own `base.css`, so the preview is
 * the real thing rather than a mock-up of it.
 */
import { render } from 'preact'
import { useEffect } from 'preact/hooks'
import { THEMES } from '@meshcommander/build-system/themes'
import '../../console/src/styles/base.css'
import '../../console/src/styles/themes/amber.css'
import '../../console/src/styles/themes/mesh.css'
import '../../console/src/styles/themes/midnight.css'
import '../../console/src/styles/themes/paper.css'
import './themes-frame.css'

const ROWS: readonly (readonly [string, string, string])[] = [
  ['AMT Firmware Version', '11.8.50', 'ok'],
  ['Provisioning Mode', 'Admin control mode', 'ok'],
  ['Power State', 'S0 — on', 'ok'],
  ['Network Interface', 'Wired, DHCP', 'warn'],
]

export function ThemeFrame() {
  const theme = new URLSearchParams(location.search).get('theme') ?? 'mesh'

  useEffect(() => {
    document.documentElement.dataset.theme = THEMES.some((t) => t.id === theme) ? theme : 'mesh'
  }, [theme])

  return (
    <div class="shell">
      <div class="brand">
        <span class="brand-mark">M</span>
        <span>MeshCommander</span>
      </div>
      <header class="header">
        <h1 class="header-title">System Status</h1>
        <span class="header-spacer" />
        <span class="chip connected">
          <i class="chip-dot" />
          Connected
        </span>
      </header>
      <nav class="nav">
        {['System Status', 'Remote Desktop', 'Serial-over-LAN', 'Hardware Information', 'Event Log', 'User Accounts'].map(
          (label, index) => (
            <button type="button" class={'nav-item' + (index === 0 ? ' active' : '')}>
              <i class="nav-dot" />
              {label}
            </button>
          ),
        )}
      </nav>
      <main class="main">
        <div class="page">
          <div class="table-panel">
            <div class="table-titlebar">
              <h2 class="table-title">General</h2>
              <span class="table-actions">
                <button type="button" class="btn">
                  Refresh
                </button>
                <button type="button" class="btn btn-primary">
                  Power on
                </button>
              </span>
            </div>
            <table class="table">
              <tbody>
                {ROWS.map(([name, value, state]) => (
                  <tr>
                    <th scope="row">{name}</th>
                    <td>
                      <span class={`status-${state}`}>{value}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  )
}

render(<ThemeFrame />, document.getElementById('app')!)
