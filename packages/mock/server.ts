/**
 * Mock AMT device for local development.
 *
 * Replays the real response corpus captured from a live AMT 11.8.50 host
 * (real/seed.json) so pages exercise the exact shapes firmware produces.
 * Mutations (add/remove user, clear log, power) are applied in memory and
 * reflected in later reads, so a walkthrough can assert round-trips.
 *
 *   bun packages/mock/server.ts   # listens on :8765
 */
import { gunzipSync } from 'node:zlib'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'

/** Per-connection redirection session state. */
type WebSocketData = {
  phase: 'select' | 'session' | 'auth' | 'settings'
  protocol: number
  /** KVM RFB handshake progress; undefined for non-KVM sessions. */
  rfb?: number
  rfbBpp?: number
}

const PORT = Number(process.env.PORT ?? 8765)
/**
 * Version the mock reports for CIM_SoftwareIdentity. The real device is 11.8.50,
 * which checkAmtVersion() considers already fixed, so the default here is a
 * still-vulnerable build to exercise the VersionWarning banner.
 */
const MOCK_VERSION = process.env.MOCK_VERSION ?? '11.6.26'
/** Realm the device advertises in its 401 challenge, as reported by AMT_GeneralSettings. */
const DIGEST_REALM = process.env.MOCK_REALM ?? 'Digest:CDC70000000000000000000000000000'
const REAL_DIR = new URL('./real/', import.meta.url).pathname

const AMT = 'http://intel.com/wbem/wscim/1/amt-schema/1/'
const CIM = 'http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/'
const IPS = 'http://intel.com/wbem/wscim/1/ips-schema/1/'

// ---------------------------------------------------------------- corpus load

type Item = Record<string, string>
interface Seed {
  [cls: string]: { resuri: string; items: string[] } | Record<string, string>
}

/** resuri -> instance XML strings, as captured from the device. */
const classes = new Map<string, string[]>()

let invokesRaw: Record<string, string> = {}

if (existsSync(join(REAL_DIR, 'seed.json'))) {
  const seed = JSON.parse(readFileSync(join(REAL_DIR, 'seed.json'), 'utf8')) as Seed
  for (const [name, entry] of Object.entries(seed)) {
    if (name === '__invokes') {
      invokesRaw = entry as Record<string, string>
      continue
    }
    const e = entry as { resuri: string; items: string[] }
    classes.set(e.resuri, e.items)
  }
  console.log(`[mock] loaded ${classes.size} classes from real device corpus`)
} else {
  console.warn('[mock] no real corpus found; run: bun dev/probe-real-amt.ts <host> <user> <pass>')
}

// ------------------------------------------------------------- mutable state

/** Digest users as the device holds them: name, digest hash, permission, realms. */
let userAcls: { DigestUsername: string; DigestPassword: string; AccessPermission: number; Realms: string }[] = [
  { DigestUsername: 'admin', DigestPassword: '', AccessPermission: 4, Realms: 'Intel(R) AMT' },
]
let eventLog: string[] = classes.get(AMT + 'AMT_MessageLog') ?? []
let auditLog: string[] = classes.get(AMT + 'AMT_AuditLog') ?? []
/**
 * AMT_MessageLog is read through the legacy iteration protocol (PositionToFirstRecord
 * -> GetRecords -> RecordArray), not by enumeration. These are real RecordArray
 * payloads captured from the device, so the page decodes genuine records.
 */
const seededMessageRecords: string[] = (() => {
  const f = join(REAL_DIR, 'message-log-records.txt')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '')
})()
let messageRecords = [...seededMessageRecords]

/** Iteration state for the in-progress message-log read. */
const iterations = new Map<string, number>()

let powerState = 2
const requestLog: string[] = []
/**
 * Full request bodies as they arrived, for `export-static.ts`: the replay file
 * has to answer exactly the requests a real console makes, and the actions a
 * page walk issues are not otherwise written down anywhere.
 */
const rawLog: { method: string; path: string; body: string; query?: string; bodyBase64?: string }[] = []

/** WSMAN sends unprefixed element names inside the `h:` namespace; keep that shape. */
function wrapItem(className: string, props: Item): string {
  const inner = Object.entries(props)
    .map(([k, v]) => `<h:${k}>${escapeXml(v)}</h:${k}>`)
    .join('')
  return `<h:${className}>${inner}</h:${className}>`
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function pullResponse(items: string[], endOfSequence: boolean, resuri?: string): string {
  const body =
    '<g:PullResponse>' +
    '<g:Items>' +
    items.map((i) => `<h:${classOf(i)}>${innerOf(i)}</h:${classOf(i)}>`).join('') +
    '</g:Items>' +
    (endOfSequence ? '<g:EndOfSequence></g:EndOfSequence>' : '<g:EnumerationContext>ctx-1</g:EnumerationContext>') +
    '</g:PullResponse>'
  return envelope(body, resuri)
}

function classOf(itemXml: string): string {
  return itemXml.match(/^<h:([A-Za-z0-9_]+)>/)?.[1] ?? 'Unknown'
}
function innerOf(itemXml: string): string {
  return itemXml.replace(/^<h:[A-Za-z0-9_]+>/, '').replace(/<\/h:[A-Za-z0-9_]+>$/, '')
}

/**
 * `resuri` is echoed because the ported enumeration follows the device's
 * EnumerationContext with a Pull addressed to the ResourceURI the device
 * returned in its own response header -- exactly as the legacy app does.
 */
function envelope(body: string, resuri?: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<a:Envelope xmlns:g="http://schemas.dmtf.org/wbem/wsman/1/cimbinding.xsd"' +
    ' xmlns:f="http://schemas.xmlsoap.org/ws/2004/08/eventing"' +
    ' xmlns:e="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"' +
    ' xmlns:d="http://schemas.xmlsoap.org/ws/2004/09/transfer"' +
    ' xmlns:c="http://schemas.xmlsoap.org/ws/2004/09/enumeration"' +
    ' xmlns:b="http://schemas.xmlsoap.org/ws/2004/08/addressing"' +
    ' xmlns:a="http://www.w3.org/2003/05/soap-envelope"' +
    ' xmlns:h="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2"' +
    ' xmlns:i="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"' +
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<a:Header><b:To>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</b:To>' +
    '<b:RelatesTo>1</b:RelatesTo><b:ReplyTo><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></b:ReplyTo>' +
    (resuri ? `<b:ResourceURI>${resuri}</b:ResourceURI>` : '') +
    '<b:MessageID>uuid:00000000-8086-8086-8086-0000000000A0</b:MessageID></a:Header>' +
    '<a:Body>' +
    body +
    '</a:Body></a:Envelope>'
  )
}

function methodOutput(name: string, fields: Record<string, string | number>, resuri?: string): string {
  const inner = Object.entries(fields)
    .map(([k, v]) => `<g:${k}>${escapeXml(String(v))}</g:${k}>`)
    .join('')
  return envelope(`<g:${name}_OUTPUT>${inner}</g:${name}_OUTPUT>`, resuri)
}

function fault(subcode: string, reason: string): string {
  return envelope(
    '<a:Fault><a:Code><a:Value>a:Sender</a:Value><a:Subcode><a:Value>' +
      subcode +
      '</a:Value></a:Subcode></a:Code><a:Reason><a:Text xml:lang="en-US">' +
      reason +
      '</a:Text></a:Reason><a:Detail></a:Detail></a:Fault>',
  )
}

// ---------------------------------------------------------------- WSMAN route

function handleWsman(body: string): { status: number; xml: string } {
  const resuri = body.match(/<w:ResourceURI>([^<]*)<\/w:ResourceURI>/)?.[1] ?? ''
  const action = body.match(/<a:Action>([^<]*)<\/a:Action>/)?.[1] ?? ''
  const isEnumerate = action.endsWith('/enumeration/Enumerate')
  const isPull = action.endsWith('/enumeration/Pull')
  const methodMatch = action.match(/^(https?:\/\/[^/]+(?:\/[^/]+)*\/[A-Za-z0-9_]+)\/([A-Za-z0-9_]+)$/)
  const isGet = action.endsWith('/transfer/Get')
  const isPut = action.endsWith('/transfer/Put')
  const isCreate = action.endsWith('/transfer/Create')

  requestLog.push(`${action.split('/').pop()} ${resuri.split('/').pop() ?? ''}`)

  if (isEnumerate) {
    // Enumeration is two-legged: context, then pulls. Pages with no instances
    // still enumerate cleanly so the app's empty-state path is exercised.
    return { status: 200, xml: envelope('<g:EnumerateResponse><g:EnumerationContext>ctx-1</g:EnumerationContext></g:EnumerateResponse>', resuri) }
  }

  if (isPull) {
    if (resuri === AMT + 'AMT_MessageLog') return { status: 200, xml: pullResponse(eventLog, true, resuri) }
    if (resuri === AMT + 'AMT_AuditLog') return { status: 200, xml: pullResponse(auditLog, true, resuri) }
    if (resuri === IPS + 'IPS_AlarmClockOccurrence') {
      const items = [
        wrapItem('IPS_AlarmClockOccurrence', {
          InstanceID: 'Intel(r) AMT:AlarmClock:1',
          NextWakeTime: String(Math.floor(Date.now() / 1000) + 3600),
          'NextWakeTime.IsLocalTime': 'false',
        }),
      ]
      return { status: 200, xml: pullResponse(items, true, resuri) }
    }
    if (resuri === AMT + 'AMT_EventSubscriptionService') return { status: 200, xml: pullResponse([], true, resuri) }
    if (resuri === AMT + 'AMT_GeneralSettings') {
      // DigestRealm lives here, and digest passwords are computed against it.
      const item = wrapItem('AMT_GeneralSettings', {
        AMTNetworkEnabled: '1',
        DomainName: 'WORKGROUP',
        DigestRealm: DIGEST_REALM,
        IdleTimeoutInterval: '0',
      })
      return { status: 200, xml: pullResponse([item], true, resuri) }
    }
    if (resuri === CIM + 'CIM_ServiceAvailableToElement') {
      // Report live power state so a power action is observable on the next read.
      const item = wrapItem('CIM_AssociatedPowerManagementService', {
        PowerState: String(powerState),
        EnabledState: String(powerState === 2 ? 2 : 3),
      })
      return { status: 200, xml: pullResponse([item], true, resuri) }
    }
    if (resuri === CIM + 'CIM_SoftwareIdentity') {
      const item = wrapItem('CIM_SoftwareIdentity', {
        InstanceID: 'AMT',
        IsEntity: 'true',
        VersionString: MOCK_VERSION,
      })
      return { status: 200, xml: pullResponse([item], true, resuri) }
    }
    const known = classes.get(resuri) ?? []
    return { status: 200, xml: pullResponse(known, true, resuri) }
  }

  if (isGet) {
    const id = body.match(/<w:Selector Name="InstanceID">([^<]*)</)?.[1]
    if (resuri === AMT + 'AMT_BootCapabilities') {
      return { status: 200, xml: methodOutput('Get', {
        BIOSSetup: 'true',
        ForceDiagnosticBoot: 'true',
        SecureErase: 'true',
        PlatformErase: 'true',
        BootConfig: 'true',
      }) }
    }
    if (resuri === IPS + 'IPS_ScreenConfigurationService') {
      // Bit 0 of EnabledState is "screen blanking allowed" (index.html:5601).
      return { status: 200, xml: methodOutput('Get', { EnabledState: 1 }) }
    }
    if (resuri === CIM + 'CIM_KVMRedirectionSAP') {
      /*
       * The capture this corpus came from never held this class, and the console
       * asks for it on every KVM page load: without it the page reported the
       * redirection port as disabled (and offered to enable it) even while a
       * session was live. EnabledState 6 / RequestedState 2 is "enabled".
       */
      const sap = wrapItem('CIM_KVMRedirectionSAP', {
        ElementName: 'Intel(r) AMT KVM Redirection Service',
        EnabledState: '6',
        RequestedState: '2',
        Name: 'KVM Redirection Service',
      })
      return { status: 200, xml: envelope(`<g:CIM_KVMRedirectionSAP>${innerOf(sap)}</g:CIM_KVMRedirectionSAP>`) }
    }
    if (resuri === IPS + 'IPS_KVMRedirectionSettingData') {
      // The KVM settings dialog reads GrayscalePixelFormatSupported; the display
      // picker reads DefaultScreen. One display, grayscale offered.
      const kvm = wrapItem('IPS_KVMRedirectionSettingData', {
        DefaultScreen: '0',
        GrayscalePixelFormatSupported: 'true',
        EnabledState: '6',
      })
      return {
        status: 200,
        xml: envelope(`<g:IPS_KVMRedirectionSettingData>${innerOf(kvm)}</g:IPS_KVMRedirectionSettingData>`),
      }
    }
    if (resuri === IPS + 'IPS_ScreenSettingData') {
      // One active display, matching the 640x400 framebuffer this mock serves.
      const screen = wrapItem('IPS_ScreenSettingData', { IsActive: 'true' })
      return {
        status: 200,
        xml: envelope(`<g:IPS_ScreenSettingData>${innerOf(screen)}</g:IPS_ScreenSettingData>`),
      }
    }
    const items = classes.get(resuri) ?? []
    const match = id ? items.find((i) => i.includes(`<h:InstanceID>${id}</h:InstanceID>`)) : items[0]
    if (!match) return { status: 200, xml: fault('e:InvalidSelectors', 'The Selectors for the resource are not valid.') }
    return { status: 200, xml: envelope(`<g:${classOf(match)}>${innerOf(match)}</g:${classOf(match)}>`) }
  }

  if (isPut) {
    return { status: 200, xml: envelope('<g:PutResponse></g:PutResponse>') }
  }

  if (isCreate) {
    return { status: 200, xml: envelope('<g:CreatedResponse></g:CreatedResponse>') }
  }

  if (methodMatch) {
    const method = methodMatch[2]
    return { status: 200, xml: handleMethod(method, resuri, body) }
  }

  requestLog.push(`BAD-REQUEST action=${action.slice(-40)} resuri=${resuri.slice(-40)}`)
  return { status: 400, xml: fault('e:InvalidResourceURI', 'Unsupported action.') }
}

function handleMethod(method: string, resuri: string, body: string): string {
  switch (`${classNameOf(resuri)}.${method}`) {
    case 'AMT_SetupAndConfigurationService.GetUuid':
      return methodOutput('GetUuid', { UUID: 'TJPwhJcD5xGcQ7wAAFIAAA==', ReturnValue: 0 })
    case 'AMT_TimeSynchronizationService.GetLowAccuracyTimeSynch':
      return methodOutput('GetLowAccuracyTimeSynch', { Ta0: Math.floor(Date.now() / 1000), ReturnValue: 0 })
    case 'IPS_ScreenConfigurationService.SetSessionState': {
      // 1 blanks the monitor, 0 unblanks it; the device applies it immediately.
      const state = Number(body.match(/<r:SessionState>(\d+)<\/r:SessionState>/)?.[1] ?? '0')
      requestLog.push(state === 1 ? 'screen-blank on' : 'screen-blank off')
      return methodOutput('SetSessionState', { ReturnValue: 0 })
    }
    case 'AMT_GeneralSettings.Get':
      return methodOutput('Get', { DomainName: 'WORKGROUP', ReturnValue: 0 })
    case 'AMT_SetupAndConfigurationService.Get': {
      const items = classes.get(resuri) ?? []
      const match = items.find((i) => i.includes('ProvisioningMode'))
      return match
        ? envelope(`<g:${classOf(match)}>${innerOf(match)}</g:${classOf(match)}>`)
        : methodOutput('Get', { ProvisioningMode: 0, ReturnValue: 0 })
    }
    case 'CIM_PowerManagementService.RequestPowerStateChange': {
      const m = body.match(/<r:PowerState>(\d+)<\/r:PowerState>/)
      const next = m ? Number(m[1]) : powerState
      // AMT accepts then transitions; reflect it immediately for the mock.
      powerState = next === 8 ? 3 : 2
      requestLog.push(`power-state-changed ${next}`)
      return methodOutput('RequestPowerStateChange', { ReturnValue: 0 })
    }
    case 'AMT_MessageLog.ClearLog': {
      eventLog = []
      messageRecords = []
      requestLog.push('event-log-cleared')
      return methodOutput('ClearLog', { ReturnValue: 0 })
    }
    case 'AMT_AuditLog.ClearLog': {
      auditLog = []
      requestLog.push('audit-log-cleared')
      return methodOutput('ClearLog', { ReturnValue: 0 })
    }
    case 'AMT_AuthorizationService.EnumerateUserAclEntries': {
      // The ACL list nests UserAclEntry elements, so this body is assembled
      // directly -- methodOutput() would escape the markup into text.
      // The device answers with a flat handle list; each is resolved separately.
      const handles = userAcls.map((_u, i) => `<g:Handles>${i + 1}</g:Handles>`).join('')
      return envelope(
        '<g:EnumerateUserAclEntries_OUTPUT>' +
          handles +
          `<g:TotalRecordCount>${userAcls.length}</g:TotalRecordCount>` +
          '<g:ReturnValue>0</g:ReturnValue></g:EnumerateUserAclEntries_OUTPUT>',
      )
    }
    case 'AMT_AuthorizationService.GetUserAclEntryEx': {
      const h = body.match(/<r:Handle>(\d+)<\/r:Handle>/)?.[1]
      const i = Number(h ?? '1') - 1
      const u = userAcls[i]
      if (u == null) return methodOutput('GetUserAclEntryEx', { ReturnValue: 2053 })
      return methodOutput('GetUserAclEntryEx', {
        Handle: String(i + 1),
        DigestUsername: u.DigestUsername,
        DigestPassword: u.DigestPassword,
        AccessPermission: u.AccessPermission,
        Realms: u.Realms,
        ReturnValue: 0,
      })
    }
    case 'AMT_AuthorizationService.AddUserAclEntryEx':
    case 'AMT_AuthorizationService.SetAdminAclEntryEx': {
      const user = body.match(/<r:DigestUsername>([^<]*)<\/r:DigestUsername>/)?.[1] ?? 'admin'
      const pass = body.match(/<r:DigestPassword>([^<]*)<\/r:DigestPassword>/)?.[1] ?? ''
      const perm = body.match(/<r:AccessPermission>(\d+)</)?.[1] ?? '4'
      const realms = body.match(/<r:Realms>([^<]*)<\/r:Realms>/)?.[1] ?? 'Intel(R) AMT'
      const existing = userAcls.findIndex((u) => u.DigestUsername === user)
      const entry = { DigestUsername: user, DigestPassword: pass, AccessPermission: Number(perm), Realms: realms }
      if (existing >= 0) userAcls[existing] = entry
      else userAcls.push(entry)
      requestLog.push(`user-added ${user} perm=${perm} realms=${realms} digest=${pass} realm=${realms}`)
      return methodOutput(method, { ReturnValue: 0 })
    }
    case 'AMT_AuthorizationService.UpdateUserAclEntryEx': {
      const h = Number(body.match(/<r:Handle>(\d+)<\/r:Handle>/)?.[1] ?? '1') - 1
      const user = body.match(/<r:DigestUsername>([^<]*)<\/r:DigestUsername>/)?.[1]
      if (user != null && userAcls[h]) userAcls[h].DigestUsername = user
      requestLog.push(`user-updated ${user}`)
      return methodOutput('UpdateUserAclEntryEx', { ReturnValue: 0 })
    }
    case 'AMT_AuthorizationService.RemoveUserAclEntry': {
      const h = Number(body.match(/<r:Handle>(\d+)<\/r:Handle>/)?.[1] ?? '1') - 1
      const removed = userAcls.splice(h, 1)[0]
      requestLog.push(`user-removed ${removed?.DigestUsername ?? h}`)
      return methodOutput('RemoveUserAclEntry', { ReturnValue: 0 })
    }
    case 'CIM_BootService.SetBootConfigRole':
      requestLog.push('set-boot-config-role')
      return methodOutput('SetBootConfigRole', { ReturnValue: 0 })
    case 'CIM_BootConfigSetting.ChangeBootOrder':
      requestLog.push('change-boot-order')
      return methodOutput('ChangeBootOrder', { ReturnValue: 0 })
    case 'AMT_MessageLog.PositionToFirstRecord': {
      const id = String(iterations.size + 1)
      iterations.set(id, 0)
      return methodOutput('PositionToFirstRecord', { IterationIdentifier: id, ReturnValue: 0 })
    }
    case 'AMT_MessageLog.GetRecords': {
      const iter = body.match(/<r:IterationIdentifier>(\d+)</)?.[1] ?? '1'
      const max = Number(body.match(/<r:MaxReadRecords>(\d+)</)?.[1] ?? '10') || 10
      const offset = iterations.get(iter) ?? 0
      const page = messageRecords.slice(offset, offset + max)
      const next = offset + page.length
      const done = next >= messageRecords.length
      iterations.set(iter, next)
      // RecordArray repeats as sibling elements, so this body is assembled
      // directly -- methodOutput() would escape the markup into text.
      const arr = page.map((r) => `<g:RecordArray>${r}</g:RecordArray>`).join('')
      return envelope(
        '<g:GetRecords_OUTPUT>' +
          `<g:IterationIdentifier>${iter}</g:IterationIdentifier>` +
          `<g:NoMoreRecords>${done ? 'true' : 'false'}</g:NoMoreRecords>` +
          arr +
          '<g:ReturnValue>0</g:ReturnValue></g:GetRecords_OUTPUT>',
      )
    }
    case 'AMT_MessageLog.CancelIteration':
      return methodOutput('CancelIteration', { ReturnValue: 0 })
    case 'AMT_MessageLog.FreezeLog':
      return methodOutput('FreezeLog', { ReturnValue: 0 })
    case 'AMT_MessageLog.ClearLog':
      eventLog = []
      messageRecords = []
      requestLog.push('event-log-cleared')
      return methodOutput('ClearLog', { ReturnValue: 0 })
    case 'CIM_RecordLog.ClearLog':
      eventLog = []
      messageRecords = []
      requestLog.push('event-log-cleared')
      return methodOutput('ClearLog', { ReturnValue: 0 })
    case 'IPS_ScreenSettingData.Get':
      return methodOutput('Get', {
        'IPS_ScreenSettingData.IsActive[0]': 'true',
        'IPS_ScreenSettingData.IsActive[1]': 'true',
        'IPS_ScreenSettingData.IsActive[2]': 'false',
        ReturnValue: 0,
      })
    case 'IPS_KVMRedirectionSettingData.Get':
      // Redirection already enabled, so the KVM page proceeds straight to connect.
      return methodOutput('Get', {
        EnabledState: 2,
        RequestedState: 2,
        DefaultScreen: 1,
        ListenerEnabled: 'true',
        SessionActive: 'false',
        ReturnValue: 0,
      })
    case 'CIM_KVMRedirectionSAP.RequestStateChange':
      return methodOutput('RequestStateChange', { ReturnValue: 0 })
    case 'CIM_ComputerSystem.RequestStateChange':
      requestLog.push('computer-system-state-change')
      return methodOutput('RequestStateChange', { ReturnValue: 0 })
  }

  const fallback = invokesRaw[method]
  if (fallback) return envelope(fallback)
  return methodOutput(method, { ReturnValue: 0 })
}

function classNameOf(resuri: string): string {
  return resuri.substring(resuri.lastIndexOf('/') + 1)
}

// ------------------------------------------------------------ storage payload

/** Matches the legacy /amt-storage/ document that PullStorageResponse parses. */
function storageDocument(): string {
  const device =
    '<?xml version="1.0" encoding="utf-8"?><AmtStorage><StorageDevices>' +
    '<StorageDevice><Name>Intel(R) AMT:Storage:0</Name><TotalSize>500107862016</TotalSize>' +
    '<UsedSpace>123456789012</UsedSpace><FreeSpace>376651073004</FreeSpace>' +
    '<Volumes><Volume><Name>System</Name><MountPoint>C:\\</MountPoint><TotalSize>500107862016</TotalSize>' +
    '<UsedSpace>123456789012</UsedSpace><FreeSpace>376651073004</FreeSpace><FileSystem>NTFS</FileSystem></Volume></Volumes>' +
    '</StorageDevice>' +
    '<StorageDevice><Name>Intel(R) AMT:Storage:1</Name><TotalSize>0</TotalSize><UsedSpace>0</UsedSpace><FreeSpace>0</FreeSpace><Volumes></Volumes></StorageDevice>' +
    '<StorageDevice><Name>Intel(R) AMT:Storage:2</Name><TotalSize>0</TotalSize><UsedSpace>0</UsedSpace><FreeSpace>0</FreeSpace><Volumes></Volumes></StorageDevice>' +
    '</StorageDevices></AmtStorage>'
  return device
}

// ------------------------------------------------------------------- redirect

/** Drives a canned session so SOL/KVM/IDER walkthroughs have something to render. */
function openRedirect(ws: ServerWebSocket<WebSocketData>) {
  ws.data = { phase: 'select', protocol: 0 }
}

function onRedirectMessage(ws: ServerWebSocket<WebSocketData>, raw: Buffer) {
  const b = new Uint8Array(raw)
  const st = ws.data
  if (st.protocol === 2 && st.rfb !== undefined) {
    requestLog.push(`kvm-client-msg rfb=${st.rfb} len=${b.length} first=${b[0] ?? -1}`)
  }

  if (b[0] === 0x10) {
    // Protocol comes from the ASCII tag at bytes 4..7 -- SOL and IDER share a 0
    // in byte 1, so it cannot be used to tell them apart.
    const tag = String.fromCharCode(b[4] ?? 0, b[5] ?? 0, b[6] ?? 0, b[7] ?? 0).trim()
    st.protocol = tag === 'SOL' ? 1 : tag === 'KVMR' ? 2 : 3
    st.phase = 'session'
    requestLog.push(`redirect-selector proto=${st.protocol} tag=${JSON.stringify(tag)}`)
    // StartRedirectionSessionReply: status 0, no OEM data. The client needs the
    // full 13 bytes (the OEM length byte at offset 12) before it will proceed.
    send(ws, new Uint8Array([0x11, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x00]))
    return
  }
  if (b[0] === 0x13 && st.phase === 'session') {
    st.phase = 'auth'
    requestLog.push('redirect-auth')
    // AuthenticateSessionReply, status 0, zero-length auth data.
    send(ws, new Uint8Array([0x14, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00]))
    return
  }
  // Both opcodes are "settings request": KVM asks with 0x40, SOL with 0x20
  // (see redirect.ts: SOL must send its serial settings before anything else).
  if (b[0] === 0x40 || b[0] === 0x20) {
    if (st.protocol === 3 && st.phase === 'settings') {
      // IDER OPEN_SESSION reply: the IDER engine consumes this opcode itself.
      requestLog.push('ider-open-session')
      send(ws, new Uint8Array([0x41, 0, 0, 0, 0, 0, 0, 0]))
      return
    }
    st.phase = 'settings'
    requestLog.push('redirect-settings-request')
    // Response-to-settings (0x21): the client keys on the opcode byte.
    const settingsReply = new Uint8Array(23)
    settingsReply[0] = 0x21
    send(ws, settingsReply)
    return
  }
  if (st.phase !== 'settings') return

  if (b[0] === 0x2b) {
    requestLog.push('sol-keepalive')
    return
  }

  if (b[0] === 0x27) {
    requestLog.push('redirect-session-live')
    if (st.protocol === 1) sendSolBanner(ws)
    // The device leads RFB and the client stays passive, so the version banner
    // goes out now rather than waiting for a client message that never comes.
    if (st.protocol === 2) {
      st.rfb = 1 // next client message is its version banner
      send(ws, new TextEncoder().encode('RFB 003.008\n'))
    }
    if (st.protocol === 3) send(ws, new Uint8Array([0x41, 0x00, 0x00, 0x00]))
    return
  }

  // KVM: the device leads the RFB exchange and the client only answers, so each
  // step sends and then waits for exactly one client message before the next.
  if (st.protocol === 2 && st.rfb !== undefined) {
    if (st.rfb === 0) {
      st.rfb = 1 // awaiting the client's version banner
      send(ws, new TextEncoder().encode('RFB 003.008\n'))
      return
    }
    if (st.rfb === 1) {
      st.rfb = 2 // awaiting the chosen security type
      send(ws, new Uint8Array([1, 1])) // one type: None
      return
    }
    if (st.rfb === 2) {
      st.rfb = 3 // awaiting the shared-desktop flag
      send(ws, new Uint8Array([0, 0, 0, 0])) // security result: OK
      return
    }
    if (st.rfb === 3) {
      st.rfb = 4 // awaiting SetPixelFormat / SetEncodings / the first update request
      send(ws, rfbServerInit())
      return
    }
    if (st.rfb === 4 && b[0] === 2) {
      requestLog.push('kvm-set-encodings')
      return
    }
    if (st.rfb === 4 && b[0] === 0) {
      st.rfbBpp = b[4] === 16 ? 2 : 1
      requestLog.push(`kvm-pixel-format bpp=${st.rfbBpp}`)
      return
    }
    /*
     * The console never sends SetPixelFormat -- it takes the format from
     * ServerInit -- so an update request can arrive while the session is still
     * at 4. Waiting for a pixel format that never comes is why the viewer used
     * to sit on an empty stage: answer the request from either state, with the
     * bpp ServerInit advertised (RGB565) until a client says otherwise.
     */
    if ((st.rfb === 4 || st.rfb === 5) && b[0] === 3) {
      st.rfb = 5
      requestLog.push('kvm-framebuffer-update')
      send(ws, rfbFramebufferUpdate(st.rfbBpp ?? 2))
      return
    }
  }

  if (b[0] === 0x28) {
    // Echo typed SOL input back as display data.
    const len = b[8] + (b[9] << 8)
    const payload = new TextDecoder().decode(b.slice(10, 10 + len))
    requestLog.push('sol-echo ' + payload)
    sendSolData(ws, payload)
  }
}

function send(ws: ServerWebSocket<WebSocketData>, bytes: Uint8Array) {
  try {
    ws.send(bytes)
  } catch {
    /* peer closed */
  }
}

function sendSolData(socket: ServerWebSocket<WebSocketData>, text: string) {
  const payload = new TextEncoder().encode(text)
  const msg = new Uint8Array(10 + payload.length)
  msg.set([0x2a, 0x00, 0x00, 0x00, 0, 0, 0, 0, payload.length & 0xff, (payload.length >> 8) & 0xff])
  msg.set(payload, 10)
  send(socket, msg)
}

function sendSolBanner(socket: ServerWebSocket<WebSocketData>) {
  sendSolData(
    socket,
    '\r\nIntel(R) Active Management Technology\r\nSOL Version: 11.6.50\r\n\r\n' +
      'login: \r\nPassword: \r\n\r\nMESHCOMMANDER-SOL\r\n# ',
  )
}

/**
 * Minimal RFB server for the KVM decoder.
 *
 * The client drives the RFB handshake exactly as AMT does: it sends the version,
 * then SetPixelFormat and SetEncodings, and the device answers with security
 * types, the security result, ServerInit and finally framebuffer updates.
 */
const RFB_W = 640
const RFB_H = 400

function rfbServerInit(): Uint8Array {
  const name = 'Mock AMT KVM'
  const buf = new Uint8Array(24 + name.length)
  const dv = new DataView(buf.buffer)
  // ServerInit starts with width/height; unlike server messages, it has no type byte.
  dv.setUint16(0, RFB_W, false)
  dv.setUint16(2, RFB_H, false)
  // Pixel format: RGB565, little-endian true colour.
  buf[4] = 16
  buf[5] = 16
  buf[6] = 0
  buf[7] = 1
  dv.setUint16(8, 31, false)
  dv.setUint16(10, 63, false)
  dv.setUint16(12, 31, false)
  buf[14] = 11
  buf[15] = 5
  buf[16] = 0
  dv.setUint32(20, name.length, false)
  buf.set([...name].map((c) => c.charCodeAt(0)), 24)
  return buf
}

/** One RAW framebuffer update split into the 64x64 tiles the client accepts. */
function rfbFramebufferUpdate(bpp: number): Uint8Array {
  const pixelBytes = bpp === 2 ? 2 : 1
  const tiles: { x: number; y: number; width: number; height: number }[] = []
  for (let y = 0; y < RFB_H; y += 64) {
    for (let x = 0; x < RFB_W; x += 64) {
      tiles.push({ x, y, width: Math.min(64, RFB_W - x), height: Math.min(64, RFB_H - y) })
    }
  }
  const size = 4 + tiles.reduce((n, t) => n + 12 + t.width * t.height * pixelBytes, 0)
  const buf = new Uint8Array(size)
  const dv = new DataView(buf.buffer)
  buf[0] = 0 // FramebufferUpdate
  dv.setUint16(2, tiles.length, false)
  let p = 4
  for (const tile of tiles) {
    dv.setUint16(p, tile.x, false)
    dv.setUint16(p + 2, tile.y, false)
    dv.setUint16(p + 4, tile.width, false)
    dv.setUint16(p + 6, tile.height, false)
    dv.setUint32(p + 8, 0, false) // encoding 0 = RAW
    p += 12
    for (let y = tile.y; y < tile.y + tile.height; y++) {
      const band = Math.floor((y / RFB_H) * 4)
      for (let x = tile.x; x < tile.x + tile.width; x++) {
        const color = band === 0 ? 0xe0 : band === 1 ? 0x1c : band === 2 ? 0x03 : Math.floor((x / RFB_W) * 255)
        if (pixelBytes === 2) {
          // RGB565 little-endian pixel payload.
          const r = (color >> 5) & 7
          const g = (color >> 2) & 7
          const b = color & 3
          dv.setUint16(p, ((r * 31 / 7) << 11) | ((g * 63 / 7) << 5) | (b * 21), true)
          p += 2
        } else {
          // RGB332 single-byte pixel payload.
          buf[p++] = color
        }
      }
    }
  }
  return buf
}

// ---------------------------------------------------------------------- server

/**
 * Exported so `export-static.ts` can replay requests through the same handler
 * without a socket round trip.
 */
export const server = Bun.serve<WebSocketData>({
  port: PORT,
  idleTimeout: 60,

  async fetch(req, srv) {
    const url = new URL(req.url)
    const path = url.pathname

    if (path === '/ws-redirection') {
      if (srv.upgrade(req, { data: { phase: 'select', protocol: 0 } })) return undefined as unknown as Response
      return new Response('expected websocket upgrade', { status: 400 })
    }

    if (path === '/__log') {
      return Response.json({ requests: requestLog })
    }
    if (path === '/__raw') {
      return Response.json({ requests: rawLog })
    }
    if (path === '/__reset') {
      requestLog.length = 0
      rawLog.length = 0
      userAcls = [{ DigestUsername: 'admin', DigestPassword: '', AccessPermission: 4, Realms: 'Intel(R) AMT' }]
      eventLog = classes.get(AMT + 'AMT_MessageLog') ?? []
      messageRecords = [...seededMessageRecords]
      auditLog = classes.get(AMT + 'AMT_AuditLog') ?? []
      powerState = 2
      return Response.json({ ok: true })
    }

    if (path === '/wsman' && req.method === 'POST') {
      const body = await req.text()
      const { status, xml } = handleWsman(body)
      rawLog.push({ method: req.method, path, body })
      return new Response(xml, { status, headers: { 'Content-Type': 'application/soap+xml; charset=UTF-8' } })
    }

    /*
     * Storage writes carry the payload the installer sent, and a browser cannot
     * be asked for it from outside; base64 because text decoding mangles gzip.
     * The query string is kept separately so `?append=1` stays distinguishable
     * from the first block without changing the path export-static matches on.
     */
    const sent = req.method === 'GET' || req.method === 'HEAD' ? null : Buffer.from(await req.arrayBuffer())
    rawLog.push({
      method: req.method,
      path,
      query: url.search,
      body: sent?.toString('utf8') ?? '',
      bodyBase64: sent?.toString('base64'),
    })

    if (path.startsWith('/amt-storage/')) {
      return new Response(storageDocument(), { headers: { 'Content-Type': 'application/xml' } })
    }

    // Serve the packaged single-file firmware artifacts for final smoke tests.
    if (path.startsWith('/firmware/')) {
      const tier = path.slice('/firmware/'.length).replace(/\.html?$/, '')
      const file = join(process.cwd(), 'dist/firmware', `Firmware-${cap(tier)}.htm.gz`)
      if (!existsSync(file)) return new Response('artifact not built', { status: 404 })
      return new Response(gunzipSync(readFileSync(file)), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }

    return new Response('MeshCommander mock AMT device\n', { headers: { 'Content-Type': 'text/plain' } })
  },

  websocket: {
    open: openRedirect,
    message: (ws, msg) => onRedirectMessage(ws, msg as Buffer),
    close: () => {},
  },
})

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

console.log(`[mock] AMT mock listening on http://127.0.0.1:${PORT}`)
console.log(`[mock]   POST /wsman  |  WS /ws-redirection  |  GET /amt-storage/  |  GET /firmware/<tier>`)