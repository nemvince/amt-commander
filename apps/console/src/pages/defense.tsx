/**
 * System Defense -- legacy view 18 (index.html:7204-7634).
 *
 * Shows the heuristic packet filter policies, the per-interface filter
 * statistics and the policy controls. The reference capture returned zero
 * instances of AMT_SystemDefensePolicy, so every table here renders its empty
 * state instead of assuming a policy exists.
 */
import { useEffect, useState } from 'preact/hooks'
import { n, s, selectorValue, yes } from '../lib/wsm'
import { signal } from '@preact/signals'
import { PullSystemDefense, getStack, pending, systemDefense } from '../state/device'
import { S } from '../strings'
import { Dialog } from '../ui/dialog'
import { Table, type Column } from '../ui/table'
import type { WsmanNode } from '../lib/wsman'

const CIM_ETHERNET_PORT = 'http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_EthernetPort'
const AMT_POLICY = 'http://intel.com/wbem/wscim/1/amt-schema/1/AMT_SystemDefensePolicy'

/** Description tables, verbatim from index.html:7217-7220. */
const ETHERNET_TYPES: Record<string, string> = { 2048: S.allIpPackets, 2054: S.allArpPackets }
const IP_TYPES: Record<string, string> = { 4: S.ipv4, 6: S.ipv6 }
const FILTER_PROFILES: Record<string, string> = {
  0: S.allowCount,
  1: S.dropCount,
  2: S.rateLimit,
  3: S.allow,
  4: S.drop,
}
/** Matching-rule fields of an IP header filter, in legacy declaration order. */
const IP_FILTER_FIELDS = [
  'HdrProtocolID',
  'HdrDestAddress',
  'HdrDestMask',
  'HdrSrcAddress',
  'HdrSrcMask',
  'HdrSrcPortStart',
  'HdrSrcPortEnd',
  'HdrDestPortStart',
  'HdrDestPortEnd',
  'HdrSrcAddressEndOfRange',
  'TCPFlagsOn',
  'TCPFlagsOff',
]

/** Per-interface filter counters, keyed by AMT ethernet port index. */
const filterStats = signal<Record<string, Record<string, number>>>({})

/** Scalar property read that tolerates missing nodes and `{ Value }` wrappers. */



/** Instances of one class out of the batch enum signal; tolerates either shape. */
function instances(src: Record<string, WsmanNode[]>, key: string): WsmanNode[] {
  const list = src[key]
  if (list == null) return []
  return list.flatMap((x) => (Array.isArray(x) ? x : [x]))
}

/** Depth-first search for a `<w:Selector Name="...">` value anywhere in a reference. */

function filterDescription(cls: string, f: WsmanNode): string {
  const proto = cls === 'AMT_Hdr8021Filter' ? n(f, 'HdrProtocolID8021') : n(f, 'HdrIPVersion')
  const known = cls === 'AMT_Hdr8021Filter' ? ETHERNET_TYPES[proto] : IP_TYPES[proto]
  const parts = [
    known ?? (cls === 'AMT_Hdr8021Filter' ? `${S.allEthernetProtocol} ${proto}` : `${S.allIpProtocol} ${proto}`),
    FILTER_PROFILES[n(f, 'FilterProfile')] ?? '',
  ]
  if (n(f, 'FilterProfile') === 2 && s(f, 'FilterProfileData')) parts.push(`${S.packetsPerSecond} ${s(f, 'FilterProfileData')}`)
  if (yes(f['ActionEventOnMatch'])) parts.push(S.eventOnMatch)
  return parts.filter(Boolean).join(', ')
}

/** Default action for one direction of a policy, index.html:7607-7615. */
function defaultAction(node: WsmanNode, direction: 'Tx' | 'Rx'): string {
  return (
    (yes(node[direction + 'DefaultDrop']) ? S.drop : S.allow) +
    (yes(node[direction + 'DefaultCount']) ? ', ' + S.count : '') +
    (yes(node[direction + 'DefaultMatchEvent']) ? ', ' + S.event : '')
  )
}

/** Ethernet port index -> policy, from the network-port/policy associations. */
function linkedPolicies(src: Record<string, WsmanNode[]>, policies: WsmanNode[]): Record<string, WsmanNode> {
  const out: Record<string, WsmanNode> = {}
  for (const link of instances(src, 'AMT_NetworkPortSystemDefensePolicy')) {
    const port = /(\d+)$/.exec(selectorValue(link['Antecedent'], 'DeviceID'))?.[1]
    const match = policies.find((p) => s(p, 'InstanceID') === selectorValue(link['Dependent'], 'InstanceID'))
    if (port != null && match != null) out[port] = match
  }
  return out
}

export function DefensePage() {
  const sd = systemDefense.value
  const policies = instances(sd, 'AMT_SystemDefensePolicy')
  const filters = [
    ...instances(sd, 'AMT_Hdr8021Filter').map((node) => ({ cls: 'AMT_Hdr8021Filter', node })),
    ...instances(sd, 'AMT_IPHeadersFilter').map((node) => ({ cls: 'AMT_IPHeadersFilter', node })),
  ]
  const linked = linkedPolicies(sd, policies)

  const [defaultPolicyFor, setDefaultPolicyFor] = useState<number | null>(null)
  const [detail, setDetail] = useState<{ cls: string; node: WsmanNode } | null>(null)
  const [adding, setAdding] = useState(false)

  const refresh = () => {
    PullSystemDefense()
    filterStats.value = Object.fromEntries(Object.keys(linked).map((k) => [k, {}]))
  }
  const pullStats = (network: number) => {
    const stack = getStack()
    if (stack == null || linked[network] == null) return
    stack.Exec(
      'AMT_SystemDefensePolicy',
      'UpdateStatistics',
      {
        NetworkInterface:
          '<a:Address></a:Address><a:ReferenceParameters><w:ResourceURI>' +
          CIM_ETHERNET_PORT +
          '</w:ResourceURI><w:SelectorSet><w:Selector Name="DeviceID">Intel(r) AMT Ethernet Port ' +
          network +
          '</w:Selector></w:SelectorSet></a:ReferenceParameters>',
        ResetOnRead: false,
      },
      () => {
        stack.Enum('AMT_ActiveFilterStatistics', (_s, _name, items, status) => {
          if (status !== 200) return
          const counts: Record<string, number> = {}
          for (const item of (items ?? []) as WsmanNode[]) {
            counts[selectorValue(item['Dependent'], 'Name') || s(item, 'InstanceID')] = n(item, 'ReadCount')
          }
          filterStats.value = { ...filterStats.value, [network]: counts }
        })
      },
      network,
      0,
      { InstanceID: s(linked[network], 'InstanceID') },
    )
  }

  useEffect(() => {
    PullSystemDefense()
  }, [])

  // Legacy polls the counters every 5s and stops as soon as no policy is linked.
  useEffect(() => {
    const networks = Object.keys(linked)
    if (networks.length === 0) return
    const tick = () => networks.forEach((x) => pullStats(Number(x)))
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [sd])

  const statRows = Object.keys(linked).flatMap((network) => {
    const counts = filterStats.value[network] ?? {}
    return Object.keys(counts).map((filter) => ({
      label: `${Number(network) === 0 ? S.wired : S.wireless} ${filter}`,
      value: `${counts[filter]} ${counts[filter] === 1 ? S.packet : S.packets}`,
    }))
  })

  const policyColumns: Column[] = [
    { label: S.policyName, cell: (p: WsmanNode) => s(p, 'PolicyName') },
    { label: S.precedence, numeric: true, cell: (p: WsmanNode) => String(n(p, 'PolicyPrecedence')) },
    { label: S.defaultTxAction, cell: (p: WsmanNode) => defaultAction(p, 'Tx') },
    { label: S.defaultRxAction, cell: (p: WsmanNode) => defaultAction(p, 'Rx') },
    {
      label: S.actions,
      cell: (p: WsmanNode) => (
        <button type="button" class="btn" onClick={() => setDetail({ cls: 'AMT_SystemDefensePolicy', node: p })}>
          {S.details}
        </button>
      ),
    },
  ]

  const filterColumns: Column[] = [
    {
      label: S.name,
      cell: (f: { cls: string; node: WsmanNode }) =>
        `${n(f.node, 'FilterDirection') === 0 ? '← ' : '→ '}${s(f.node, 'Name')}`,
    },
    {
      label: S.type,
      cell: (f: { cls: string; node: WsmanNode }) =>
        `${f.cls === 'AMT_Hdr8021Filter' ? S.ethernetTraffic : S.ipTraffic}, ${filterDescription(f.cls, f.node)}`,
    },
    {
      label: S.actions,
      cell: (f: { cls: string; node: WsmanNode }) => (
        <button type="button" class="btn" onClick={() => setDetail({ cls: f.cls, node: f.node })}>
          {S.details}
        </button>
      ),
    },
  ]

  return (
    <div class="page">
      <section class="table-panel">
        <div class="table-titlebar">
          <h2 class="table-title">{S.general}</h2>
        </div>
        <dl class="kv">
          <dt>{S.defaultWiredPolicy}</dt>
          <dd>
            <button type="button" class="btn" onClick={() => setDefaultPolicyFor(0)}>
              {linked[0] != null ? s(linked[0], 'PolicyName') : S.none}
            </button>
          </dd>
          <dt>{S.defaultWirelessPolicy}</dt>
          <dd>
            <button type="button" class="btn" onClick={() => setDefaultPolicyFor(1)}>
              {linked[1] != null ? s(linked[1], 'PolicyName') : S.none}
            </button>
          </dd>
          {statRows.map((r) => (
            <>
              <dt>{r.label}</dt>
              <dd class="mono">{r.value}</dd>
            </>
          ))}
        </dl>
      </section>

      <Table loading={pending.value > 0}
        title={S.policiesHeading}
        columns={policyColumns}
        rows={policies}
        keyOf={(p) => s(p, 'InstanceID')}
        onRefresh={refresh}
        empty={S.noPolicies}
      />

      <Table loading={pending.value > 0}
        title={S.filtersHeading}
        columns={filterColumns}
        rows={filters}
        keyOf={(f) => f.cls + ':' + s(f.node, 'InstanceID')}
        onAdd={() => setAdding(true)}
        empty={S.noFilters}
      />

      {defaultPolicyFor != null && (
        <DefaultPolicyDialog
          network={defaultPolicyFor}
          policies={policies}
          current={linked[String(defaultPolicyFor)]}
          onClose={() => setDefaultPolicyFor(null)}
          onDone={() => {
            setDefaultPolicyFor(null)
            PullSystemDefense()
          }}
        />
      )}

      {detail != null && (
        <Dialog
          title={detail.cls === 'AMT_SystemDefensePolicy' ? S.policyName : s(detail.node, 'Name')}
          buttons={[
            { label: S.remove, value: 'remove' },
            { label: S.close, value: 'cancel' },
          ]}
          onClose={(v) => {
            const d = detail
            setDetail(null)
            if (v === 'remove') getStack()?.Delete(d.cls, d.node, () => PullSystemDefense())
          }}
        >
          <dl class="kv">
            <dt>{S.name}</dt>
            <dd>{s(detail.node, 'Name') || s(detail.node, 'PolicyName')}</dd>
            {detail.cls === 'AMT_SystemDefensePolicy' ? (
              <>
                <dt>{S.defaultTxAction}</dt>
                <dd>{defaultAction(detail.node, 'Tx')}</dd>
                <dt>{S.defaultRxAction}</dt>
                <dd>{defaultAction(detail.node, 'Rx')}</dd>
              </>
            ) : (
              <>
                <dt>{S.matchingTraffic}</dt>
                <dd>{filterDescription(detail.cls, detail.node)}</dd>
                <dt>{S.direction}</dt>
                <dd>{n(detail.node, 'FilterDirection') === 0 ? S.outbound : S.inbound}</dd>
                {IP_FILTER_FIELDS.filter((f) => s(detail.node, f) !== '').map((f) => (
                  <>
                    <dt class="mono">{f}</dt>
                    <dd class="mono">{s(detail.node, f)}</dd>
                  </>
                ))}
              </>
            )}
          </dl>
        </Dialog>
      )}

      {adding && (
        <AddFilterDialog
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false)
            PullSystemDefense()
          }}
        />
      )}
    </div>
  )
}

/**
 * Pick the policy applied to an ethernet port. Changing it removes the old
 * association first, as index.html:7384-7395 does.
 */
function DefaultPolicyDialog(props: {
  network: number
  policies: WsmanNode[]
  current?: WsmanNode
  onClose: () => void
  onDone: () => void
}) {
  const currentId = props.current != null ? s(props.current, 'InstanceID') : ''
  const [pick, setPick] = useState(currentId)

  const endpoint = (resourceUri: string, name: string, value: string) => ({
    Address: 'http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous',
    ReferenceParameters: {
      ResourceURI: resourceUri,
      SelectorSet: { Selector: { '@Name': name, Value: value } },
    },
  })

  const apply = () => {
    const stack = getStack()
    if (stack == null) return
    const antecedent = endpoint(CIM_ETHERNET_PORT, 'DeviceID', `Intel(r) AMT Ethernet Port ${props.network}`)
    const done = () => {
      if (pick === '') {
        props.onDone()
        return
      }
      const dependent = endpoint(AMT_POLICY, 'InstanceID', pick)
      stack.Create('AMT_NetworkPortSystemDefensePolicy', { Antecedent: antecedent, Dependent: dependent }, () =>
        props.onDone(),
      )
    }
    if (props.current == null) {
      done()
      return
    }
    stack.Delete(
      'AMT_NetworkPortSystemDefensePolicy',
      { Antecedent: antecedent, Dependent: endpoint(AMT_POLICY, 'InstanceID', currentId) },
      done,
    )
  }

  return (
    <Dialog
      title={S.defaultPolicyDialog}
      width={420}
      buttons={[
        { label: S.ok, value: 'ok', primary: true },
        { label: S.cancel, value: 'cancel' },
      ]}
      onClose={(v) => {
        if (v === 'ok') apply()
        else props.onClose()
      }}
    >
      <div class="field-row">
        <label>
          {S.policyName}
          <select value={pick} onChange={(e) => setPick((e.currentTarget as HTMLSelectElement).value)}>
            <option value="">{S.none}</option>
            {props.policies.map((p) => (
              <option key={s(p, 'InstanceID')} value={s(p, 'InstanceID')}>
                {s(p, 'PolicyName')}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Dialog>
  )
}

/** index.html:7405-7476 -- AMT_Hdr8021Filter for 802.1 headers, AMT_IPHeadersFilter for IP. */
function AddFilterDialog(props: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState(0)
  const [direction, setDirection] = useState(0)
  const [profile, setProfile] = useState(0)
  const [rate, setRate] = useState('')
  const [event, setEvent] = useState(false)

  const ok = name.length > 0 && (profile !== 2 || Number(rate) > 0)

  return (
    <Dialog
      title={S.addFilter}
      width={460}
      buttons={[
        { label: S.ok, value: 'ok', primary: true },
        { label: S.cancel, value: 'cancel' },
      ]}
      onClose={(v) => {
        if (v !== 'ok' || !ok) return
        const eth = type <= 1
        const filter: WsmanNode = {
          Name: name,
          FilterDirection: direction,
          FilterProfile: profile,
          ActionEventOnMatch: event,
        }
        if (eth) filter['HdrProtocolID8021'] = type === 0 ? 2048 : 2054
        else filter['HdrIPVersion'] = type === 2 ? 4 : 6
        if (profile === 2) filter['FilterProfileData'] = rate
        getStack()?.Create(eth ? 'AMT_Hdr8021Filter' : 'AMT_IPHeadersFilter', filter, () => props.onDone())
      }}
    >
      <div class="field-row">
        <label>
          {S.name}
          <input type="text" value={name} maxLength={16} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <label>
          {S.type}
          <select value={String(type)} onChange={(e) => setType(Number(e.currentTarget.value))}>
            <option value="0">{S.ethernetIpFilter}</option>
            <option value="1">{S.ethernetArpFilter}</option>
            <option value="2">{S.ipv4Filter}</option>
            <option value="3">{S.ipv6Filter}</option>
          </select>
        </label>
        <label>
          {S.direction}
          <select value={String(direction)} onChange={(e) => setDirection(Number(e.currentTarget.value))}>
            <option value="0">{S.outbound}</option>
            <option value="1">{S.inbound}</option>
          </select>
        </label>
        <label>
          {S.action}
          <select value={String(profile)} onChange={(e) => setProfile(Number(e.currentTarget.value))}>
            <option value="0">{S.allowCount}</option>
            <option value="1">{S.dropCount}</option>
            <option value="2">{S.rateLimit}</option>
            <option value="3">{S.allow}</option>
            <option value="4">{S.drop}</option>
          </select>
        </label>
        {profile === 2 && (
          <label>
            {S.packetsPerSecond}
            <input type="number" value={rate} onInput={(e) => setRate(e.currentTarget.value)} />
          </label>
        )}
        <label>
          {S.eventLog}
          <select value={event ? '1' : '0'} onChange={(e) => setEvent(e.currentTarget.value === '1')}>
            <option value="0">{S.doNothing}</option>
            <option value="1">{S.eventOnMatch}</option>
          </select>
        </label>
      </div>
    </Dialog>
  )
}