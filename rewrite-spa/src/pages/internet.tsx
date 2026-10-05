/**
 * Internet Settings -- legacy view 17 (index.html:9855-10321).
 *
 * Environment detection, the user-initiated tunnel state and the remote access
 * policy rules (CIRA/CILA). device.ts only enumerates the three singleton
 * classes; the management server and policy rule lists are pulled here so the
 * tables below have something to show on a device that is actually provisioned.
 */
import { useEffect, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { PullRemoteAccess, getStack, remoteAccess, amtVersion, amtVersionMinor } from '../state/device'
import { format } from '../lib/amt-stack'
import type { WsmanNode } from '../lib/wsman'
import { S } from '../strings'
import { Dialog } from '../ui/dialog'
import { Table, type Column } from '../ui/table'

const AMT_MPS = 'http://intel.com/wbem/wscim/1/amt-schema/1/AMT_ManagementPresenceRemoteSAP'

/** index.html:9865 -- AMT_UserInitiatedConnectionService EnabledState values. */
const CIRA_STATES: Record<string, string> = {
  32768: S.disabled,
  32769: S.biosEnabled,
  32770: S.osEnabled,
  32771: S.biosOsEnabled,
}
/** index.html:9903-9909 -- policy rule name prefix -> policy kind. */
const POLICY_KINDS = ['User', 'Alert', 'Periodic'] as const
type PolicyKind = (typeof POLICY_KINDS)[number]

const servers = signal<WsmanNode[]>([])
const rules = signal<WsmanNode[]>([])
const applies = signal<WsmanNode[]>([])

function s(node: WsmanNode | undefined, key: string): string {
  const v = node?.[key]
  if (v == null) return ''
  if (typeof v === 'object' && !Array.isArray(v)) return String((v as WsmanNode)['Value'] ?? '')
  return Array.isArray(v) ? '' : String(v)
}

/** Depth-first search for a `<w:Selector Name="...">` value anywhere in a reference. */
function selectorValue(node: unknown, attr: string): string {
  if (node == null || typeof node !== 'object') return ''
  if (Array.isArray(node)) {
    for (const x of node) {
      const v = selectorValue(x, attr)
      if (v) return v
    }
    return ''
  }
  const o = node as WsmanNode
  if (o['@Name'] === attr) return s(o, 'Value')
  for (const key in o) {
    const v = selectorValue(o[key], attr)
    if (v) return v
  }
  return ''
}

/** Little-endian 32 bit, matching legacy IntToStr / ReadInt. */
function intToStr(v: number): string {
  return String.fromCharCode(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255)
}

function readInt(b64: string, offset: number): number {
  const raw = atob(b64)
  if (raw.length < offset + 4) return 0
  return (
    (raw.charCodeAt(offset) |
      (raw.charCodeAt(offset + 1) << 8) |
      (raw.charCodeAt(offset + 2) << 16) |
      (raw.charCodeAt(offset + 3) << 24)) >>>
    0
  )
}

/** "each 60 seconds" / "at 3:30 daily", index.html:9931-9936. */
function periodicSummary(rule: WsmanNode | undefined): string {
  const data = s(rule, 'ExtendedData')
  if (rule == null || data === '') return ''
  if (readInt(data, 0) === 0) return format(S.eachSeconds, readInt(data, 4))
  const minutes = readInt(data, 8)
  return format(S.atDaily, `${readInt(data, 4)}:${minutes < 10 ? '0' : ''}${minutes}`)
}

/** Servers bound to each policy kind, index.html:9901-9909. */
function serversByPolicy(kind: PolicyKind): { server: WsmanNode; cila: boolean }[] {
  return applies.value.flatMap((link) => {
    const name = selectorValue(link['ManagedElement'], 'Name')
    const server = servers.value.find((x) => s(x, 'Name') === name)
    const bound = selectorValue(link['PolicySet'], 'PolicyRuleName').split(' ')[0]
    return server != null && bound === kind ? [{ server, cila: s(link, 'MpsType') === '1' }] : []
  })
}

export function InternetPage() {
  const ra = remoteAccess.value
  const env = ra['AMT_EnvironmentDetectionSettingData']?.[0]
  const uic = ra['AMT_UserInitiatedConnectionService']?.[0]
  const domains = [env?.['DetectionStrings'] ?? []].flat().map(String)
  // AMT 11.6 added the internal/external (CILA/CIRA) distinction.
  const cila = amtVersion.value > 11 || (amtVersion.value === 11 && amtVersionMinor.value >= 6)

  const [editingDomains, setEditingDomains] = useState(false)
  const [editingState, setEditingState] = useState(false)
  const [policy, setPolicy] = useState<PolicyKind | null>(null)
  const [removing, setRemoving] = useState<WsmanNode | null>(null)

  const pull = () => {
    PullRemoteAccess()
    const stack = getStack()
    if (stack == null) return
    stack.Enum('AMT_ManagementPresenceRemoteSAP', (_s, _n, items) => {
      servers.value = (items as WsmanNode[]) ?? []
    })
    stack.Enum('AMT_RemoteAccessPolicyRule', (_s, _n, items) => {
      rules.value = (items as WsmanNode[]) ?? []
    })
    stack.Enum('AMT_RemoteAccessPolicyAppliesToMPS', (_s, _n, items) => {
      applies.value = (items as WsmanNode[]) ?? []
    })
  }

  useEffect(pull, [])

  const serverColumns: Column[] = [
    { label: S.accessName, cell: (x: WsmanNode) => s(x, 'AccessInfo') },
    { label: S.port, numeric: true, cell: (x: WsmanNode) => s(x, 'Port') },
    { label: S.commonName, cell: (x: WsmanNode) => s(x, 'CN') },
    {
      label: S.actions,
      cell: (x: WsmanNode) => (
        <button type="button" class="btn" onClick={() => setRemoving(x)}>
          {S.remove}
        </button>
      ),
    },
  ]

  const ruleColumns: Column[] = [
    { label: S.policyRule, cell: (r: WsmanNode) => s(r, 'PolicyRuleName') },
    { label: S.tunnelLifetime, numeric: true, cell: (r: WsmanNode) => s(r, 'TunnelLifeTime') },
    { label: S.trigger, cell: (r: WsmanNode) => periodicSummary(r) || S.none },
  ]

  return (
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">{S.navInternet}</h1>
        <button type="button" class="btn" onClick={pull}>
          {S.refresh}
        </button>
      </div>

      <section class="table-panel">
        <div class="table-titlebar">
          <h2 class="table-title">{S.general}</h2>
        </div>
        <dl class="kv">
          <dt>{S.environmentDetection}</dt>
          <dd>
            <button type="button" class="btn" onClick={() => setEditingDomains(true)}>
              {domains.length === 0
                ? S.disabled
                : format(S.enabledDomains, `${domains.length} ${domains.length === 1 ? S.domain : S.domains}`)}
            </button>
          </dd>
          <dt>{S.userInitiationOptions}</dt>
          <dd>
            <button type="button" class="btn" onClick={() => setEditingState(true)}>
              {CIRA_STATES[s(uic, 'EnabledState')] ?? S.unknown}
            </button>
          </dd>
          {POLICY_KINDS.map((kind) => (
            <>
              <dt>{S.policyKinds[kind]}</dt>
              <dd>
                <button type="button" class="btn" onClick={() => setPolicy(kind)}>
                  {serversByPolicy(kind).length === 0
                    ? S.none
                    : serversByPolicy(kind).map((p) => s(p.server, 'AccessInfo') + (p.cila ? ' (' + S.cila + ')' : '')).join(', ')}
                </button>
              </dd>
            </>
          ))}
        </dl>
      </section>

      <Table
        title={S.serversHeading}
        columns={serverColumns}
        rows={servers.value}
        keyOf={(x) => s(x, 'Name') || s(x, 'AccessInfo')}
        empty={S.noServers}
      />

      <Table
        title={S.policyRulesHeading}
        columns={ruleColumns}
        rows={rules.value}
        keyOf={(r) => s(r, 'PolicyRuleName')}
        empty={S.noPolicyRules}
      />

      {editingDomains && (
        <DomainsDialog
          domains={domains}
          onClose={() => setEditingDomains(false)}
          onDone={() => {
            setEditingDomains(false)
            pull()
          }}
        />
      )}
      {editingState && <CiraStateDialog current={s(uic, 'EnabledState')} onClose={() => setEditingState(false)} onDone={pull} />}

      {policy != null && (
        <PolicyDialog
          kind={policy}
          cila={cila}
          servers={servers.value}
          bound={serversByPolicy(policy)}
          onClose={() => setPolicy(null)}
          onDone={() => {
            setPolicy(null)
            pull()
          }}
        />
      )}

      {removing != null && (
        <Dialog
          title={S.removeServer}
          buttons={[
            { label: S.remove, value: 'remove' },
            { label: S.cancel, value: 'cancel' },
          ]}
          onClose={(v) => {
            const server = removing
            setRemoving(null)
            if (v !== 'remove') return
            getStack()?.Delete('AMT_ManagementPresenceRemoteSAP', { Name: s(server, 'Name') }, pull)
          }}
        >
          <dl class="kv">
            <dt>{S.accessName}</dt>
            <dd>{s(removing, 'AccessInfo')}</dd>
            <dt>{S.port}</dt>
            <dd class="mono">{s(removing, 'Port')}</dd>
            <dt>{S.commonName}</dt>
            <dd>{s(removing, 'CN')}</dd>
          </dl>
        </Dialog>
      )}
    </div>
  )
}

/** index.html:10137-10146 -- AMT_UserInitiatedConnectionService.RequestStateChange. */
function CiraStateDialog(props: { current: string; onClose: () => void; onDone: () => void }) {
  const [state, setState] = useState(props.current || '32768')
  return (
    <Dialog
      title={S.userInitiatedTunnel}
      width={400}
      buttons={[
        { label: S.ok, value: 'ok', primary: true },
        { label: S.cancel, value: 'cancel' },
      ]}
      onClose={(v) => {
        if (v !== 'ok') {
          props.onClose()
          return
        }
        getStack()?.Exec(
          'AMT_UserInitiatedConnectionService',
          'RequestStateChange',
          { RequestedState: state },
          () => getStack()?.Get('AMT_UserInitiatedConnectionService', props.onDone),
        )
      }}
    >
      <div class="field-row">
        <label>
          {S.userInitiationOptions}
          <select value={state} onChange={(e) => setState(e.currentTarget.value)}>
            {Object.keys(CIRA_STATES).map((k) => (
              <option key={k} value={k}>
                {CIRA_STATES[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Dialog>
  )
}

/** index.html:10097-10121 -- PUT AMT_EnvironmentDetectionSettingData with the domain list. */
function DomainsDialog(props: { domains: string[]; onClose: () => void; onDone: () => void }) {
  const [list, setList] = useState(props.domains)
  const [entry, setEntry] = useState('')

  return (
    <Dialog
      title={S.environmentDetection}
      width={460}
      buttons={[
        { label: S.ok, value: 'ok', primary: true },
        { label: S.cancel, value: 'cancel' },
      ]}
      onClose={(v) => {
        if (v !== 'ok') return
        getStack()?.Put('AMT_EnvironmentDetectionSettingData', { DetectionStrings: list }, props.onDone)
      }}
    >
      <div class="dialog-body">
        <p>{S.environmentDetectionHelp}</p>
        {list.length === 0 && <p class="status-warn">{S.noIntranetDomains}</p>}
        {list.map((d, i) => (
          <div class="btn-row" key={d + i}>
            <span class="mono">{d}</span>
            <button type="button" class="btn" onClick={() => setList(list.filter((_, j) => j !== i))}>
              {S.remove}
            </button>
          </div>
        ))}
        {list.length < 5 && (
          <div class="field-row">
            <input
              type="text"
              placeholder={S.domainPlaceholder}
              maxLength={63}
              value={entry}
              onInput={(e) => setEntry(e.currentTarget.value)}
            />
            <button
              type="button"
              class="btn"
              disabled={entry.length === 0}
              onClick={() => {
                setList([...list, entry])
                setEntry('')
              }}
            >
              {S.add}
            </button>
          </div>
        )}
      </div>
    </Dialog>
  )
}

/** index.html:9980-10094 -- AMT_RemoteAccessService.AddRemoteAccessPolicyRule. */
function PolicyDialog(props: {
  kind: PolicyKind
  cila: boolean
  servers: WsmanNode[]
  bound: { server: WsmanNode; cila: boolean }[]
  onClose: () => void
  onDone: () => void
}) {
  const rule = rules.value.find((r) => s(r, 'PolicyRuleName').startsWith(props.kind))
  const [primary, setPrimary] = useState(s(props.bound[0]?.server, 'Name') ?? '')
  const [secondary, setSecondary] = useState(s(props.bound[1]?.server, 'Name') ?? '')
  const [internal, setInternal] = useState(props.bound[0]?.cila ? '1' : '0')
  const [internal2, setInternal2] = useState(props.bound[1]?.cila ? '1' : '0')
  const [lifetime, setLifetime] = useState(s(rule, 'TunnelLifeTime') || '0')
  const periodic = props.kind === 'Periodic'
  const [triggerType, setTriggerType] = useState(periodic && readInt(s(rule, 'ExtendedData'), 0) === 1 ? '1' : '0')
  const [timer, setTimer] = useState(periodic ? (triggerType === '1' ? periodicSummary(rule).split(' ')[1] ?? '' : String(readInt(s(rule, 'ExtendedData'), 4) || 3600)) : '')

  const reference = (name: string) =>
    '<Address xmlns="http://schemas.xmlsoap.org/ws/2004/08/addressing">http://schemas.xmlsoap.org/ws/2004/08/addressing</Address>' +
    '<ReferenceParameters xmlns="http://schemas.xmlsoap.org/ws/2004/08/addressing">' +
    '<ResourceURI xmlns="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd">' + AMT_MPS + '</ResourceURI>' +
    '<SelectorSet xmlns="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd">' +
    '<Selector Name="Name">' + name + '</Selector></SelectorSet></ReferenceParameters>'

  const apply = () => {
    const stack = getStack()
    if (stack == null) return
    if (primary === '') {
      props.onDone()
      return
    }
    const cira: string[] = []
    const cilaRefs: string[] = []
    const bin = (name: string, isInternal: boolean) => {
      if (name === '') return
      // Pre-11.6 firmware has no CILA bucket; everything is CIRA.
      ;(props.cila && isInternal ? cilaRefs : cira).push(reference(name))
    }
    bin(primary, internal === '1')
    bin(secondary, internal2 === '1')

    const trigger = POLICY_KINDS.indexOf(props.kind)
    const add = () => {
      let extended: string | undefined
      if (periodic) {
        extended = triggerType === '1' ? btoa(intToStr(1) + intToStr(Number(timer.split(':')[0])) + intToStr(Number(timer.split(':')[1]))) : btoa(intToStr(0) + intToStr(Number(timer)))
      }
      stack.Exec(
        'AMT_RemoteAccessService',
        'AddRemoteAccessPolicyRule',
        { Trigger: trigger, TunnelLifeTime: lifetime, ExtendedData: extended, MpServer: cira, InternalMpServer: cilaRefs },
        props.onDone,
      )
    }
    if (rule == null) add()
    else stack.Delete('AMT_RemoteAccessPolicyRule', { PolicyRuleName: s(rule, 'PolicyRuleName') }, add)
  }

  const pick = (value: string, onChange: (v: string) => void, allowNone = true) => (
    <select value={value} onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value)}>
      {allowNone && <option value="">{S.none}</option>}
      {props.servers.map((x) => (
        <option key={s(x, 'Name')} value={s(x, 'Name')}>
          {s(x, 'AccessInfo')}
        </option>
      ))}
    </select>
  )

  return (
    <Dialog
      title={S.policyKinds[props.kind]}
      width={460}
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
          {S.primaryServer}
          {pick(primary, setPrimary)}
        </label>
        {props.cila && (
          <label>
            {S.mpsType}
            <select value={internal} onChange={(e) => setInternal(e.currentTarget.value)}>
              <option value="0">{S.cira}</option>
              <option value="1">{S.cila}</option>
            </select>
          </label>
        )}
        {props.servers.length > 1 && (
          <label>
            {S.secondaryServer}
            {pick(secondary, setSecondary, primary !== '')}
          </label>
        )}
        {props.servers.length > 1 && props.cila && (
          <label>
            {S.secondaryMpsType}
            <select value={internal2} onChange={(e) => setInternal2(e.currentTarget.value)}>
              <option value="0">{S.cira}</option>
              <option value="1">{S.cila}</option>
            </select>
          </label>
        )}
        <label>
          {S.tunnelLifetime}
          <input type="number" value={lifetime} onInput={(e) => setLifetime(e.currentTarget.value)} />
        </label>
        {periodic && (
          <label>
            {S.triggerType}
            <select value={triggerType} onChange={(e) => setTriggerType(e.currentTarget.value)}>
              <option value="0">{S.triggerInterval}</option>
              <option value="1">{S.timeOfDay}</option>
            </select>
          </label>
        )}
        {periodic && (
          <label>
            {triggerType === '1' ? S.timeOfDay : S.triggerInterval}
            <input type="text" value={timer} onInput={(e) => setTimer(e.currentTarget.value)} />
          </label>
        )}
      </div>
    </Dialog>
  )
}