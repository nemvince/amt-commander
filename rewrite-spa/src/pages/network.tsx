/**
 * Network Settings (`#/network`), legacy view 8 -- index.html:5688-5858 for the
 * wired side and index.html:7636-7705 for the wireless one.
 *
 * The legacy app folded these classes into its big PullSystemStatus batch and then
 * also into the system status panel; here they are the page's own data. device state
 * exposes a `network`/`wifi` pair but never writes it, so the page pulls directly.
 */
import { useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { FEAT_Wireless } from '../features'
import { format, type AmtResult } from '../lib/amt-stack'
import type { WsmanNode } from '../lib/wsman'
import { getStack } from '../state/device'
import { S } from '../strings'
import { RefreshIcon } from '../ui/icons'
import { Table, type Column } from '../ui/table'
import '../styles/network.css'

/** Wired-side classes, a subset of the legacy system-status batch (index.html:5390). */
const NET_CLASSES = [
  '*AMT_GeneralSettings',
  'AMT_EthernetPortSettings',
  'IPS_IPv6PortSettings',
  'CIM_ElementSettingData'
]

/** Wireless-side classes, verbatim from index.html:7648. */
const WIFI_CLASSES = [
  'CIM_WiFiPortCapabilities',
  'CIM_WiFiPort',
  'CIM_WiFiEndpoint',
  'CIM_WiFiEndpointSettings',
  'AMT_WiFiPortConfigurationService'
]

const LINK_POLICY: Record<number, string> = { 1: 'S0/AC', 14: 'Sx/AC', 16: 'S0/DC', 224: 'Sx/DC' }

/** index.html:7657. */
const WIFI_STATE: Record<number, string> = {
  3: S.disabled,
  32768: S.enabledInS0,
  32769: S.enabledInS0SxAc
}

/** index.html:7658. */
const RADIO_STATE: Record<number, string> = {
  2: S.onConnected,
  3: S.off,
  6: S.onDisconnected
}

/** index.html:7659. */
const WIFI_AUTH: Record<number, string> = {
  1: S.other,
  2: S.open,
  3: S.sharedKey,
  4: S.wpaPsk,
  5: S.wpa8021x,
  6: S.wpa2Psk,
  7: S.wpa28021x,
  32768: S.wpa3Sae,
  32769: S.wpa3Owe
}

/** index.html:7660. */
const WIFI_ENCRYPTION: Record<number, string> = {
  1: S.other,
  2: S.wep,
  3: S.tkipRc4,
  4: S.ccmpAes,
  5: S.noneValue
}

type NetData = Record<string, WsmanNode[]>
/** One definition row: the label and the value the device reported. */
type Field = [string, string]

/**
 * Every instance arrives wrapped in its class element, both in the GetResponse
 * body and per item of an enumeration (amt-0.2.0.js:94 flattens the same wrapper).
 */
function unwrap(node: WsmanNode): WsmanNode {
  const keys = Object.keys(node)
  const only = keys.length === 1 ? node[keys[0]] : undefined
  const wrapper = typeof only === 'object' && only != null && !Array.isArray(only)
  return wrapper && /^[A-Z]/.test(keys[0]) ? (only as WsmanNode) : node
}

/** A GET-fetched class reports its instance in `response`, an enumerated one its
 * item array in `responses`, which the stack passes through untyped. */
function items(result: AmtResult): WsmanNode[] {
  if (result.status !== 200) return []
  const body = result.response
  if (body != null) return [unwrap(body)]
  const many = result.responses as unknown
  return Array.isArray(many) ? (many as WsmanNode[]).map(unwrap) : []
}

/** Scalar property as trimmed text; nested nodes and absent keys read as empty. */
function text(node: WsmanNode | undefined, key: string): string {
  const value = node?.[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function num(node: WsmanNode | undefined, key: string): number {
  return Number(node?.[key] ?? 0)
}

/** AMT reports the boolean configuration flags as 0/1 or as true/false. */
function onOff(value: unknown): string {
  return value === 1 || value === true ? S.enabled : S.disabled
}

/** index.html:5873. AMT uses `::` and `::0` as its "unset" IPv6 placeholders. */
function ipOr(value: string, fallback: string): string {
  return value !== '' && value !== '::' && value !== '::0' ? value : fallback
}

/** `LinkPolicy` and friends arrive as a bare value when there is only one. */
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value]
}

/** Selector value out of an endpoint reference, e.g. CIM_ElementSettingData. */
function selectorValue(reference: WsmanNode | undefined): string {
  const params = reference?.['ReferenceParameters'] as WsmanNode | undefined
  const set = params?.['SelectorSet'] as WsmanNode | undefined
  const selector = list(set?.['Selector'])[0] as WsmanNode | undefined
  return text(selector, 'Value')
}

function Details(props: { title: string; fields: Field[] }) {
  return (
    <section class="table-panel">
      <div class="table-titlebar">
        <h2 class="table-title">{props.title}</h2>
      </div>
      <dl class="kv">
        {props.fields.map(([label, value]) => (
          <>
            <dt>{label}</dt>
            <dd class="mono">{value === '' ? '—' : value}</dd>
          </>
        ))}
      </dl>
    </section>
  )
}

/** Legacy dynamic-DNS sentence, index.html:5715-5719. */
function ddnsOf(gs: WsmanNode | undefined): string {
  if (gs?.['DDNSUpdateEnabled'] === true) {
    return format(
      S.ddnsPeriodic,
      text(gs, 'DDNSPeriodicUpdateInterval'),
      text(gs, 'DDNSTTL')
    )
  }
  if (gs?.['DDNSUpdateByDHCPServerEnabled'] === true) return S.ddnsByDhcp
  return S.disabled
}

/** Legacy link-policy sentence, index.html:5746-5754. */
function linkPolicyOf(port: WsmanNode): string {
  const names = list(port['LinkPolicy'])
    .map((value) => LINK_POLICY[Number(value)])
    .filter((name) => name != null)
  return names.length === 0 ? S.notAvailable : format(S.availableIn, names.join(', '))
}

export function NetworkPage() {
  const data = useSignal<NetData>({})

  const refresh = () => {
    const stack = getStack()
    if (stack == null) return
    const classes = FEAT_Wireless ? [...NET_CLASSES, ...WIFI_CLASSES] : NET_CLASSES
    stack.BatchEnum('', classes, (_s, _name, results) => {
      const next: NetData = {}
      for (const cls of Object.keys(results)) next[cls] = items(results[cls])
      data.value = next
    })
  }

  useEffect(() => {
    refresh()
  }, [])

  const net = data.value
  const gs = net['AMT_GeneralSettings']?.[0]
  const ports = net['AMT_EthernetPortSettings'] ?? []
  const ipv6Ports = net['IPS_IPv6PortSettings'] ?? []
  const elementSettings = net['CIM_ElementSettingData'] ?? []
  const wifiPort = net['CIM_WiFiPort']?.[0]
  const wifiEndpoint = net['CIM_WiFiEndpoint']?.[0]
  const wifiConfig = net['AMT_WiFiPortConfigurationService']?.[0]
  const wifiProfiles = (net['CIM_WiFiEndpointSettings'] ?? []).filter(
    (profile) => Number(profile['AuthenticationMethod']) !== 1
  )

  // index.html:5726 -- the wireless adapter carries WLANLinkProtectionLevel, or is
  // simply the second NIC on dual-interface machines.
  let wirelessIndex = -1
  ports.forEach((port, index) => {
    if (text(port, 'WLANLinkProtectionLevel') !== '' || index === 1) wirelessIndex = index
  })

  const hostName = text(gs, 'HostName') || text(gs, 'HostOSFQDN')
  const shared = gs?.['SharedFQDN']
  const general: Field[] = [
    [
      S.nameAndDomain,
      hostName +
        (hostName === ''
          ? ''
          : shared === true
            ? ', ' + S.sharedWithOs
            : shared === false
              ? ', ' + S.differentFromOs
              : '')
    ],
    [S.dynamicDns, ddnsOf(gs)]
  ]

  const interfacePanels = ports.map((port, index): { title: string; fields: Field[] } | null => {
    const wireless = wirelessIndex === index
    const mac = text(port, 'MACAddress')
    // On wireless-only machines the wired port reports an all-zero MAC; skip it.
    if (index === 0 && !wireless && mac === '00-00-00-00-00-00') return null

    const fields: Field[] = [[S.linkState, port['LinkIsUp'] === true ? S.linkUp : S.linkDown]]
    if (port['LinkPolicy'] != null) fields.push([S.linkPolicy, linkPolicyOf(port)])
    if (mac !== '00-00-00-00-00-00') fields.push([S.macAddress, mac])

    if (wireless && FEAT_Wireless && wifiPort != null) {
      const sync = wifiConfig?.['localProfileSynchronizationEnabled']
      const uefiShare = wifiConfig?.['UEFIWiFiProfileShareEnabled']
      fields.push([S.state, WIFI_STATE[num(wifiPort, 'EnabledState')] ?? S.unknown])
      fields.push([
        S.radioState,
        (RADIO_STATE[num(wifiEndpoint, 'EnabledState')] ?? S.unknown) +
          ', ' + S.ssid + ': ' + (text(wifiEndpoint, 'LANID') || S.noneValue)
      ])
      if (sync != null) fields.push([S.localProfileSync, onOff(sync)])
      fields.push([S.uefiWifiCoex, uefiShare == null ? S.unavailable : onOff(uefiShare)])
    }

    if (!wireless) {
      const ping =
        [S.disabled, S.icmpResponse, S.rmcpResponse, S.icmpAndRmcp][
          num(gs, 'PingResponseEnabled') + (num(gs, 'RmcpPingResponseEnabled') << 1)
        ] ?? S.unknown
      fields.push([S.respondToPing, ping])
      fields.push([
        S.ipv4State,
        (port['DHCPEnabled'] === true ? S.autoDhcp : S.staticIp) +
          (port['IpSyncEnabled'] === true ? ', ' + S.ipSync : '')
      ])
    }

    fields.push([S.ipv4Address, ipOr(text(port, 'IPAddress'), S.noneValue)])
    const gateway = text(port, 'DefaultGateway')
    if (gateway !== '') fields.push([S.ipv4GatewayMask, gateway + ' / ' + ipOr(text(port, 'SubnetMask'), S.noneValue)])
    const dns = ipOr(text(port, 'PrimaryDNS'), '')
    if (dns !== '') fields.push([S.ipv4Dns, dns + (text(port, 'SecondaryDNS') !== '' ? ' / ' + text(port, 'SecondaryDNS') : '')])

    const v6 = ipv6Ports[index]
    if (v6 != null) {
      // index.html:5815 -- IPv6 is enabled when the element setting is current.
      const setting = elementSettings.find(
        (item) => selectorValue(item['SettingData'] as WsmanNode) === 'Intel(r) IPS IPv6 Settings ' + index
      )
      const enabled = setting != null && Number(setting['IsCurrent']) === 1
      const manual =
        ipOr(text(v6, 'IPv6Address'), '') !== '' ||
        ipOr(text(v6, 'DefaultRouter'), '') !== '' ||
        ipOr(text(v6, 'PrimaryDNS'), '') !== '' ||
        ipOr(text(v6, 'SecondaryDNS'), '') !== ''
      fields.push([
        S.ipv6State,
        !enabled ? S.ipv6Disabled : manual ? S.ipv6AutomaticManual : S.ipv6Automatic
      ])
      if (enabled) {
        const addresses = list(v6['CurrentAddressInfo'])
          .map((entry) => String(entry).split(',')[0])
          .filter((entry) => entry !== '')
        fields.push([S.ipv6Address, addresses.length === 0 ? S.noneValue : addresses.join(', ')])
        const router = text(v6, 'CurrentDefaultRouter')
        if (router !== '') fields.push([S.ipv6Router, router])
        const dns6 = ipOr(text(v6, 'CurrentPrimaryDNS'), '')
        if (dns6 !== '') {
          fields.push([
            S.ipv6Dns,
            dns6 + (text(v6, 'CurrentSecondaryDNS') !== '' ? ' / ' + text(v6, 'CurrentSecondaryDNS') : '')
          ])
        }
      }
    }

    return { title: wireless ? S.wirelessInterface : S.wiredInterface, fields }
  })

  type ProfileRow = { key: string; profile: WsmanNode }
  const profileColumns: Column[] = [
    { label: S.profileName, cell: (r: ProfileRow) => text(r.profile, 'ElementName') },
    { label: S.ssid, cell: (r: ProfileRow) => text(r.profile, 'SSID') || S.noneValue },
    {
      label: S.authentication,
      cell: (r: ProfileRow) => WIFI_AUTH[num(r.profile, 'AuthenticationMethod')] ?? S.unknown
    },
    {
      label: S.encryption,
      cell: (r: ProfileRow) => WIFI_ENCRYPTION[num(r.profile, 'EncryptionMethod')] ?? S.unknown
    },
    { label: S.priority, cell: (r: ProfileRow) => num(r.profile, 'Priority'), numeric: true }
  ]
  const profileRows: ProfileRow[] = wifiProfiles
    .map((profile, index) => ({ key: text(profile, 'ElementName') + '/' + index, profile }))
    .sort((a, b) => num(a.profile, 'Priority') - num(b.profile, 'Priority'))

  return (
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">{S.navNetwork}</h1>
        <button type="button" class="btn" onClick={refresh}>
          <RefreshIcon />
          {S.refresh}
        </button>
      </div>

      <p class="page-note">{S.networkNote}</p>

      <Details title={S.generalSettings} fields={general} />

      {interfacePanels.map((panel, index) => (panel == null ? null : <Details key={index} title={panel.title} fields={panel.fields} />))}

      {FEAT_Wireless ? (
        <Table
          title={S.wirelessProfiles}
          columns={profileColumns}
          rows={profileRows}
          keyOf={(r) => r.key}
          empty={S.noWirelessProfiles}
        />
      ) : null}
    </div>
  )
}