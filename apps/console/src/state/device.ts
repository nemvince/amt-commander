/**
 * Device state and lifecycle.
 *
 * Reproduces the firmware-mode boot sequence from index.html: create the stacks,
 * read version + provisioning on open, then pull each remaining subsystem lazily
 * as the WSMAN queue drains (the `amtFirstPull` bitmask driven by onProcessChanged).
 */
import { batch, signal } from '@preact/signals'
import { FEAT_AuditLog, FEAT_EventLog, FEAT_HardwareInfo } from '../features'
import { createAmtStack, type AmtStack } from '../lib/amt-stack'
import type { WsmanNode } from '../lib/wsman'

/** Lazy-pull bitmask, matching index.html:1854. */
export const FIRST_PULL = {
  HardwareInfo: 1,
  Wireless: 2,
  SystemDefense: 4,
  Storage: 8,
  EventLog: 16,
  AuditLog: 32,
  ExtraInfo: 64,
  Dot1x: 128,
} as const

export type ConnState = 'connecting' | 'connected' | 'disconnected' | 'error'

export const connState = signal<ConnState>('disconnected')
export const connError = signal('')

export const amtVersion = signal(0)
export const amtVersionMinor = signal(0)
/** Full "major.minor.patch" string exactly as the device reported it. */
export const amtVersionString = signal('')
export const powerState = signal<number>(-1)
export const generalSettings = signal<WsmanNode | null>(null)
export const serviceAvailability = signal<WsmanNode | null>(null)
export const networkTime = signal(0)
export const provisioningMode = signal<number>(-1)
export const uuid = signal('')

export const hw = signal<Record<string, WsmanNode[]>>({})
export const eventLog = signal<WsmanNode[]>([])
export const auditLog = signal<WsmanNode[]>([])
export const storage = signal<{ name: string; size: number }[]>([])
export const network = signal<WsmanNode | null>(null)
export const wifi = signal<WsmanNode | null>(null)
export const alarms = signal<WsmanNode[]>([])
export const agentPresence = signal<WsmanNode | null>(null)
export const subscriptions = signal<WsmanNode[]>([])
export const systemDefense = signal<Record<string, WsmanNode[]>>({})
export const remoteAccess = signal<Record<string, WsmanNode[]>>({})
export const accounts = signal<WsmanNode[]>([])

/**
 * WSMAN requests still in flight. Drives the header counter and lets a page
 * tell "still loading" apart from "genuinely empty".
 */
export const pending = signal(0)

let amtstack: AmtStack | null = null
let amtFirstPull = 0
let powerPollTimer: number | null = null

/** Subscribe to queue-depth changes; drives the header counter and the idle pull pump. */
export function onProgress(inFlight: number) {
  pending.value = inFlight
  if (inFlight !== 0) return
  // Queue is idle: pull whatever has not been pulled yet, one subsystem per tick.
  if (amtstack == null) return
  if (amtVersion.value > 0 && (amtFirstPull & FIRST_PULL.ExtraInfo) === 0) {
    amtFirstPull |= FIRST_PULL.ExtraInfo
    PullExtraInfo()
    return
  }
  if (FEAT_HardwareInfo && (amtFirstPull & FIRST_PULL.HardwareInfo) === 0) {
    PullHardware()
    return
  }
  if (FEAT_EventLog && (amtFirstPull & FIRST_PULL.EventLog) === 0) {
    PullEventLog()
    return
  }
  if (FEAT_AuditLog && (amtFirstPull & FIRST_PULL.AuditLog) === 0) {
    PullAuditLog()
    return
  }
}

export function getStack(): AmtStack | null {
  return amtstack
}

/**
 * Firmware mode: the page is served by the device itself, so the endpoint is
 * addressed relative to the document rather than to the origin.
 *
 * On a device both resolve to `/wsman` -- the console is installed as
 * `index.htm` and served from the root. Document-relative is what lets the same
 * build run under a subpath (the promo site's demo mounts it at `/demo/`, where
 * an origin-absolute `/wsman` would leave the page's own Service Worker scope).
 */
export function connect() {
  connState.value = 'connecting'
  connError.value = ''
  amtFirstPull = 0
  amtVersion.value = 0
  powerState.value = -1

  amtstack = createAmtStack('wsman')
  amtstack.onProcessChanged = onProgress

  // Version + provisioning first: everything else keys off the AMT version.
  amtstack.BatchEnum(
    '',
    ['CIM_SoftwareIdentity', '*AMT_SetupAndConfigurationService'],
    (_stack, _batchname, results) => {
      // An enum hands back the flattened instance list; the firmware version is the
      // instance whose InstanceID is exactly 'AMT' (legacy getInstance()).
      const software = results['CIM_SoftwareIdentity']
      const items = Array.isArray(software?.responses) ? software.responses : []
      const amt = items.find((i) => i && i['InstanceID'] === 'AMT')
      if (amt) processSystemVersion(amt)
      else if (software?.status === 200 && software.response) processSystemVersion(software.response)
      const setup = results['*AMT_SetupAndConfigurationService'] ?? results['AMT_SetupAndConfigurationService']
      if (setup?.status === 200 && setup.responses?.Body) {
        provisioningMode.value = (setup.responses.Body['ProvisioningMode'] as number) ?? -1
      }
      connState.value = software?.status === 200 || setup?.status === 200 ? 'connected' : 'error'
      if (connState.value === 'error') connError.value = 'Could not read the Intel(R) AMT version.'
    },
  )

  PullSystemStatus()

  // The 5s power poll is non-firmware in the legacy app; firmware reads power state
  // as part of the boot sequence and then again after any power action.
  if (powerPollTimer != null) clearInterval(powerPollTimer)
}

export function disconnect() {
  if (powerPollTimer != null) {
    clearInterval(powerPollTimer)
    powerPollTimer = null
  }
  if (amtstack) {
    amtstack.onProcessChanged = null
    amtstack.CancelAllQueries(999)
    amtstack = null
  }
  connState.value = 'disconnected'
  onProgress(0)
}

export function processSystemVersion(body: WsmanNode) {
  const v = (body['VersionString'] as string) ?? ''
  if (v === '') return
  amtVersionString.value = v
  const parts = v.split('.')
  amtVersion.value = parseInt(parts[0], 10) || 0
  amtVersionMinor.value = parseInt(parts[1], 10) || 0
}

export function PullSystemStatus() {
  const stack = amtstack
  if (stack == null) return
  stack.Exec('AMT_TimeSynchronizationService', 'GetLowAccuracyTimeSynch', {}, (_stack, _name, resp) => {
    const body = resp?.Body
    if (body) networkTime.value = (body['Ta0'] as number) ?? 0
  })
  stack.Enum('CIM_ServiceAvailableToElement', (_stack, _name, items) => {
    const first = items?.[0] as WsmanNode | undefined
    serviceAvailability.value = first ?? null
    // This same record drives the legacy status display; do not wait for the
    // idle-only poll below, which necessarily refuses while the boot batch is busy.
    powerState.value = (first?.['PowerState'] as number) ?? -1
  })
}

export function PullPowerState() {
  const stack = amtstack
  if (stack == null || stack.GetPendingActions() !== 0) return
  stack.Enum('CIM_ServiceAvailableToElement', (_stack, _name, items) => {
    const el = items?.[0] as WsmanNode | undefined
    if (el) powerState.value = (el['PowerState'] as number) ?? -1
  })
}

function PullExtraInfo() {
  const stack = amtstack
  if (stack == null) return
  stack.Exec('AMT_SetupAndConfigurationService', 'GetUuid', {}, (_stack, _name, resp) => {
    if (resp?.Body) uuid.value = (resp.Body['UUID'] as string) ?? ''
  })
  stack.Enum('AMT_GeneralSettings', (_stack, _name, items) => {
    generalSettings.value = (items?.[0] as WsmanNode) ?? null
  })
}

export function PullHardware() {
  const stack = amtstack
  if (stack == null) return
  stack.BatchEnum(
    '',
    [
      '*CIM_ComputerSystemPackage',
      'CIM_SystemPackaging',
      '*CIM_Chassis',
      'CIM_Chip',
      '*CIM_Card',
      '*CIM_BIOSElement',
      'CIM_Processor',
      'CIM_PhysicalMemory',
      'CIM_MediaAccessDevice',
      'CIM_PhysicalPackage',
      'CIM_Battery',
    ],
    (_stack, _batchname, results) => {
      batch(() => {
        hw.value = Object.fromEntries(
          Object.entries(results)
            .filter(([, r]) => r.status === 200 && r.response != null)
            .map(([name, r]) => [name, [r.response as WsmanNode]]),
        )
      })
    },
  )
  amtFirstPull |= FIRST_PULL.HardwareInfo
}

export function PullEventLog() {
  const stack = amtstack
  if (stack == null) return
  stack.Enum('AMT_MessageLog', (_stack, _name, items) => {
    batch(() => {
      eventLog.value = (items as WsmanNode[]) ?? []
    })
  })
  amtFirstPull |= FIRST_PULL.EventLog
}

export function PullAuditLog() {
  const stack = amtstack
  if (stack == null) return
  stack.Enum('AMT_AuditLog', (_stack, _name, items) => {
    batch(() => {
      auditLog.value = (items as WsmanNode[]) ?? []
    })
  })
  amtFirstPull |= FIRST_PULL.AuditLog
}

export function PullAlarms() {
  const stack = amtstack
  if (stack == null) return
  stack.Enum('IPS_AlarmClockOccurrence', (_stack, _name, items) => {
    batch(() => {
      alarms.value = (items as WsmanNode[]) ?? []
    })
  })
}

export function PullAgentPresence() {
  const stack = amtstack
  if (stack == null) return
  stack.BatchEnum('', ['AMT_AgentPresenceWatchdog', 'AMT_AgentPresenceWatchdogAction'], (_stack, _batchname, results) => {
    batch(() => {
      agentPresence.value = {
        Watchdog: results['AMT_AgentPresenceWatchdog']?.response as WsmanNode,
        Action: results['AMT_AgentPresenceWatchdogAction']?.response as WsmanNode,
      }
    })
  })
}

export function PullSubscriptions() {
  const stack = amtstack
  if (stack == null) return
  // Legacy PullEventSubscriptions enumerates destinations and their associated
  // CIM_FilterCollectionSubscription objects; EventSubscriptionService is not a resource.
  stack.BatchEnum('', ['CIM_ListenerDestination', 'CIM_FilterCollectionSubscription'], (_stack, _batchname, results) => {
    const listeners = results['CIM_ListenerDestination']?.responses
    const subscriptionItems = results['CIM_FilterCollectionSubscription']?.responses
    const destinations = Array.isArray(listeners) ? listeners : []
    const links = Array.isArray(subscriptionItems) ? subscriptionItems : []
    batch(() => {
      subscriptions.value = links.map((link, i) => ({
        ...link,
        Destination: destinations[i]?.['Destination']
      }))
    })
  })
}

export function PullSystemDefense() {
  const stack = amtstack
  if (stack == null) return
  stack.BatchEnum(
    '',
    ['AMT_SystemDefensePolicy', 'AMT_NetworkPortSystemDefensePolicy', 'AMT_Hdr8021Filter', 'AMT_IPHeadersFilter', 'AMT_NetworkFilter'],
    (_stack, _batchname, results) => {
      batch(() => {
        systemDefense.value = Object.fromEntries(
          Object.entries(results)
            .filter(([, r]) => r.status === 200 && r.response != null)
            .map(([name, r]) => [name, [r.response as WsmanNode]]),
        )
      })
    },
  )
  amtFirstPull |= FIRST_PULL.SystemDefense
}

export function PullRemoteAccess() {
  const stack = amtstack
  if (stack == null) return
  stack.BatchEnum(
    '',
    ['AMT_RemoteAccessService', 'AMT_EnvironmentDetectionSettingData', 'AMT_UserInitiatedConnectionService'],
    (_stack, _batchname, results) => {
      batch(() => {
        remoteAccess.value = Object.fromEntries(
          Object.entries(results)
            .filter(([, r]) => r.status === 200 && r.response != null)
            .map(([name, r]) => [name, [r.response as WsmanNode]]),
        )
      })
    },
  )
}

export function PullAccounts() {
  const stack = amtstack
  if (stack == null) return
  // StartIndex is 1-based, and the device answers with a flat list of handles that
  // are then resolved one by one (legacy index.html:8184,8199).
  stack.Exec('AMT_AuthorizationService', 'EnumerateUserAclEntries', { StartIndex: 1 }, (_stack, _name, resp) => {
    const body = resp?.Body
    if (!body) return
    const handles = body['Handles']
    batch(() => {
      accounts.value = Array.isArray(handles)
        ? handles.map((h) => ({ Handle: h }) as WsmanNode)
        : handles != null
          ? [{ Handle: handles } as WsmanNode]
          : []
    })
  })
}

/**
 * Ask the device to change power state. The legacy app waits 800ms and re-reads
 * power state, because AMT acknowledges before the transition actually starts.
 */
export function RequestPowerStateChange(next: number) {
  const stack = amtstack
  if (stack == null) return
  stack.RequestPowerStateChange(next, (_stack, _name, resp) => {
    const rv = resp?.Body?.['ReturnValue']
    if (rv != null && rv !== 0) connError.value = 'Power request rejected: ' + rv
    setTimeout(() => PullPowerState(), 800)
  })
}