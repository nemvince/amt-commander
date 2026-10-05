import { useState } from 'preact/hooks'
import {
  RequestPowerStateChange,
  amtVersion,
  amtVersionString,
  generalSettings,
  getStack,
  networkTime,
  pending,
  powerState,
  provisioningMode,
  uuid,
} from '../state/device'
import { S } from '../strings'
import { Dialog } from '../ui/dialog'
import { Table, type Column } from '../ui/table'
import { PowerIcon } from '../ui/icons'

/**
 * Power action codes, verbatim from the legacy dialog (index.html:10683-10731).
 * `state` is the gate: the device can only accept actions that make sense from
 * where it currently is (1 = powered on, 2 = powered off).
 */
interface PowerAction {
  label: string
  /** RequestPowerStateChange value. */
  state?: number
  /** Legacy 500/501 go out as an OS power-saving change instead. */
  osPower?: number
  needs?: 'BIOSSetup' | 'ForceDiagnosticBoot' | 'SecureErase' | 'PlatformErase'
  boot?: string
  /** 1 = only when powered on, 2 = only when powered off. */
  when?: number
}

const POWER_ACTIONS: PowerAction[] = [
  { label: 'Power up', state: 2, when: 2 },
  { label: 'Reset', state: 10, when: 1 },
  { label: 'Power cycle', state: 5, when: 1 },
  { label: 'Power down', state: 8, when: 1 },
  { label: 'Sleep', state: 4, when: 1 },
  { label: 'Hibernate', state: 7, when: 1 },
  { label: 'Soft-off', state: 12, when: 1 },
  { label: 'Soft-reset', state: 14, when: 1 },
  { label: 'OS Wake from Standby', osPower: 2, when: 1 },
  { label: 'OS Power Saving', osPower: 3, when: 1 },
  { label: 'Power up to BIOS', state: 2, boot: 'Intel(r) AMT:BootConfig:BIOS', needs: 'BIOSSetup', when: 2 },
  { label: 'Reset to BIOS', state: 10, boot: 'Intel(r) AMT:BootConfig:BIOS', needs: 'BIOSSetup', when: 1 },
  { label: 'Power on to diagnostic', state: 2, boot: 'Intel(r) AMT:BootConfig:Diags', needs: 'ForceDiagnosticBoot', when: 2 },
  { label: 'Reset to diagnostic', state: 10, boot: 'Intel(r) AMT:BootConfig:Diags', needs: 'ForceDiagnosticBoot', when: 1 },
]

/** Legacy gates the "next boot" actions behind AMT_BootCapabilities. */
type BootCapabilities = Record<string, boolean>

export function SystemPage() {
  const [showPower, setShowPower] = useState(false)
  const [caps, setCaps] = useState<BootCapabilities | null>(null)
  const version = amtVersion.value

  // AMT 2 == powered on; anything else means we can only offer "power up".
  const on = powerState.value === 2
  const gate = on ? 1 : 2

  const openPower = () => {
    const stack = getStack()
    setShowPower(true)
    if (stack == null) return
    stack.Get('AMT_BootCapabilities', (_stack, _name, resp) => {
      if (resp?.Body) setCaps(resp.Body as BootCapabilities)
    })
  }

  const runAction = (a: PowerAction) => {
    const stack = getStack()
    setShowPower(false)
    if (stack == null) return
    if (a.osPower != null) {
      stack.RequestOSPowerStateChange(a.osPower, () => {})
      return
    }
    // Setting a boot source needs the boot-order dance the legacy app performs:
    // clear the order, PUT AMT_BootSettingData, then SetBootConfigRole(1).
    if (a.boot != null) {
      stack.Exec('CIM_BootConfigSetting', 'ChangeBootOrder', { Source: a.boot }, (_st, _n, resp) => {
        if (resp?.Body?.['ReturnValue'] !== 0) return
        stack.SetBootConfigRole('Intel(r) AMT:BootConfig:BootConfig0', () => {
          if (a.state != null) RequestPowerStateChange(a.state)
        })
      })
      return
    }
    if (a.state != null) RequestPowerStateChange(a.state)
  }

  const available = POWER_ACTIONS.filter((a) => {
    const when = a.when ?? gate
    if (when !== gate) return false
    if (a.needs && caps != null && caps[a.needs] !== true) return false
    if (a.state === 4 || a.state === 7) return version > 9
    return true
  })

  const rows = available.map((a) => ({ label: a.label, action: a }))

  const powerColumns: Column[] = [
    { label: S.powerControl, cell: (r: { label: string }) => r.label },
  ]

  const versionRows = [
    { label: 'AMT Firmware Version', value: amtVersionString.value === '' ? S.loading : amtVersionString.value },
    { label: 'UUID', value: uuid.value || '—' },
    { label: 'Provisioning Mode', value: provisioningMode.value === 0 ? 'Provisioned' : 'Not provisioned' },
    { label: 'Device Time', value: networkTime.value ? new Date(networkTime.value * 1000).toUTCString() : '—' },
    {
      label: 'Domain',
      value: String((generalSettings.value?.['DomainName'] as string) ?? '—'),
    },
  ]

  return (
    <div class="page">
      <section class="table-panel">
        <div class="table-titlebar">
          <h2 class="table-title">{S.general}</h2>
        </div>
        <dl class="kv">
          {versionRows.map((r) => (
            <>
              <dt>{r.label}</dt>
              <dd class="mono">{r.value}</dd>
            </>
          ))}
        </dl>
      </section>

      <section class="table-panel">
        <div class="table-titlebar">
          <h2 class="table-title">{S.powerControl}</h2>
          <div class="table-actions">
            <button type="button" class="btn" onClick={openPower}>
              <PowerIcon />
              {S.powerControl}
            </button>
          </div>
        </div>
        <div class="btn-row">
          <span class={'status-' + (on ? 'ok' : 'warn')}>
            {on ? 'Powered on' : powerState.value < 0 ? 'Unknown' : 'Powered off'}
          </span>
        </div>
      </section>

      {showPower && (
        <Dialog title="Power Actions" onClose={() => setShowPower(false)} buttons={[{ label: S.close, value: 'cancel' }]}>
          <Table loading={pending.value > 0}
            columns={powerColumns}
            rows={rows}
            keyOf={(r) => r.label}
            empty={S.noData}
            footer={
              <div class="btn-row">
                {rows.map((r) => (
                  <button key={r.label} type="button" class="btn" onClick={() => runAction(r.action)}>
                    {r.label}
                  </button>
                ))}
              </div>
            }
          />
        </Dialog>
      )}
    </div>
  )
}
