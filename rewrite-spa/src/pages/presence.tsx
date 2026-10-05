/**
 * Agent Presence -- legacy view 19 (index.html:6977-7202).
 *
 * Watchdogs, their state transitions and the actions bound to them. The
 * reference capture returned zero AMT_AgentPresenceWatchdog instances, so the
 * tables below are expected to render their empty state on an unprovisioned
 * device; every read tolerates a missing node.
 */
import { useEffect, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { PullAgentPresence, getStack, agentPresence } from '../state/device'
import type { WsmanNode } from '../lib/wsman'
import { S } from '../strings'
import { Dialog } from '../ui/dialog'
import { Table, type Column } from '../ui/table'

/** amt-0.2.0.js:542 -- watchdog CurrentState is a bit field. */
const STATES: [number, string][] = [
  [1, S.notStarted],
  [2, S.stopped],
  [4, S.running],
  [8, S.expired],
  [16, S.suspended],
]
/** index.html:7020-7021 */
const ENABLED_STATES = [
  S.unknown,
  S.other,
  S.enabled,
  S.disabled,
  S.shuttingDown,
  S.notApplicable,
  S.enabledButOffline,
  S.inTest,
  S.deferred,
  S.quiesce,
  S.starting,
]
const MONITORED_ENTITIES = [
  S.unknown,
  S.other,
  S.operatingSystem,
  S.osBootProcess,
  S.osShutdownProcess,
  S.firmwareBootProcess,
  S.biosBootProcess,
  S.application,
  S.serviceProcessor,
]

const capabilities = signal<WsmanNode | null>(null)

function s(node: WsmanNode | null | undefined, key: string): string {
  const v = node?.[key]
  if (v == null) return ''
  if (typeof v === 'object' && !Array.isArray(v)) return String((v as WsmanNode)['Value'] ?? '')
  return Array.isArray(v) ? '' : String(v)
}

function n(node: WsmanNode | undefined, key: string): number {
  return Number(s(node, key)) || 0
}

function yes(v: unknown): boolean {
  return v === true || v === 'true'
}

/** Instances out of a batch-enum slot that may hold one node or a list. */
function instances(slot: WsmanNode | WsmanNode[] | undefined): WsmanNode[] {
  if (slot == null) return []
  return (Array.isArray(slot) ? slot : [slot]).flatMap((x) => (Array.isArray(x) ? x : [x]))
}

/** Bit-field state mask to its labels, index.html:7067-7072. */
function transitionStr(state: number): string {
  if (state === 31) return S.anyState
  return STATES.filter(([bit]) => (state & bit) !== 0)
    .map(([, label]) => label)
    .join(', ')
}

/** DeviceID is a base64 encoded GUID; render it the way index.html:7041 does. */
function guidStr(deviceId: string): string {
  try {
    const hex = [...atob(deviceId)].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    const g = (a: number, b: number) => hex.slice(a, b)
    return `${g(6, 8)}${g(4, 6)}${g(2, 4)}${g(0, 2)}-${g(10, 12)}${g(8, 10)}-${g(14, 16)}${g(12, 14)}-${g(16, 20)}-${hex.slice(20)}`
  } catch {
    return deviceId
  }
}

function mask(current: number, bit: number, checked: boolean): number {
  return checked ? current | bit : current & ~bit
}

export function PresencePage() {
  const ap = agentPresence.value
  const watchdogs = instances(ap?.['Watchdog'] as WsmanNode | undefined)
  const actions = instances(ap?.['Action'] as WsmanNode | undefined)

  const [adding, setAdding] = useState<WsmanNode | null>(null)
  const [removing, setRemoving] = useState<WsmanNode | null>(null)
  const [clearing, setClearing] = useState<WsmanNode | null>(null)

  const pull = () => {
    PullAgentPresence()
    getStack()?.Get('AMT_AgentPresenceCapabilities', (_s, _name, resp) => {
      capabilities.value = (resp?.Body as WsmanNode) ?? null
    }, undefined, 1)
  }

  useEffect(pull, [])

  const watchdogColumns: Column[] = [
    { label: S.name, cell: (w: WsmanNode) => s(w, 'MonitoredEntityDescription') || guidStr(s(w, 'DeviceID')) },
    { label: S.currentState, cell: (w: WsmanNode) => transitionStr(n(w, 'CurrentState')) },
    { label: S.monitoredEntity, cell: (w: WsmanNode) => MONITORED_ENTITIES[n(w, 'MonitoredEntity')] ?? S.unknown },
    { label: S.enabledState, cell: (w: WsmanNode) => ENABLED_STATES[n(w, 'EnabledState')] ?? S.unknown },
    { label: S.startupInterval, cell: (w: WsmanNode) => `${s(w, 'StartupInterval')} ${S.seconds}` },
    { label: S.timeoutInterval, cell: (w: WsmanNode) => `${s(w, 'TimeoutInterval')} ${S.seconds}` },
    {
      label: S.actions,
      cell: (w: WsmanNode) => (
        <div class="btn-row">
          <button type="button" class="btn" onClick={() => setAdding(w)}>
            {S.addWatchdogAction}
          </button>
          <button type="button" class="btn" onClick={() => setClearing(w)}>
            {S.deleteWatchdogActions}
          </button>
          <button type="button" class="btn" onClick={() => setRemoving(w)}>
            {S.remove}
          </button>
        </div>
      ),
    },
  ]

  const actionColumns: Column[] = [
    { label: S.policyAction, cell: (a: WsmanNode) => s(a, 'PolicyActionName') },
    { label: S.oldState, cell: (a: WsmanNode) => transitionStr(n(a, 'OldState')) },
    { label: S.newState, cell: (a: WsmanNode) => transitionStr(n(a, 'NewState')) },
    { label: S.eventOnTransition, cell: (a: WsmanNode) => (yes(a['EventOnTransition']) ? S.yes : S.no) },
    { label: S.actionSd, cell: (a: WsmanNode) => (yes(a['ActionSd']) ? S.yes : S.no) },
    { label: S.actionEac, cell: (a: WsmanNode) => (yes(a['ActionEac']) ? S.yes : S.no) },
  ]

  return (
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">{S.navPresence}</h1>
      </div>

      <section class="table-panel">
        <div class="table-titlebar">
          <h2 class="table-title">{S.general}</h2>
        </div>
        <dl class="kv">
          <dt>{S.maxWatchdogs}</dt>
          <dd class="mono">{s(capabilities.value, 'MaxTotalAgents') || '—'}</dd>
          <dt>{S.maxActions}</dt>
          <dd class="mono">{s(capabilities.value, 'MaxTotalActions') || '—'}</dd>
        </dl>
      </section>

      <Table
        title={S.watchdogsHeading}
        columns={watchdogColumns}
        rows={watchdogs}
        keyOf={(w) => s(w, 'DeviceID')}
        onRefresh={pull}
        empty={S.noWatchdog}
      />

      <Table
        title={S.actionsHeading}
        columns={actionColumns}
        rows={actions}
        keyOf={(a) => s(a, 'PolicyActionName')}
        onRefresh={pull}
        empty={S.noWatchdogActions}
      />

      {adding != null && (
        <AddActionDialog
          watchdog={adding}
          onClose={() => setAdding(null)}
          onDone={() => {
            setAdding(null)
            pull()
          }}
        />
      )}

      {clearing != null && (
        <Dialog
          title={S.deleteWatchdogActions}
          buttons={[
            { label: S.ok, value: 'ok', primary: true },
            { label: S.cancel, value: 'cancel' },
          ]}
          onClose={(v) => {
            const w = clearing
            setClearing(null)
            if (v !== 'ok') return
            getStack()?.Exec('AMT_AgentPresenceWatchdog', 'DeleteAllActions', {}, pull, undefined, 0, {
              DeviceID: s(w, 'DeviceID'),
            })
          }}
        >
          <p>{S.confirmDeleteActions}</p>
        </Dialog>
      )}

      {removing != null && (
        <Dialog
          title={S.removeWatchdog}
          buttons={[
            { label: S.remove, value: 'remove' },
            { label: S.cancel, value: 'cancel' },
          ]}
          onClose={(v) => {
            const w = removing
            setRemoving(null)
            if (v !== 'remove') return
            getStack()?.Delete('AMT_AgentPresenceWatchdog', { DeviceID: s(w, 'DeviceID') }, pull)
          }}
        >
          <dl class="kv">
            <dt>{S.name}</dt>
            <dd>{s(removing, 'MonitoredEntityDescription') || guidStr(s(removing, 'DeviceID'))}</dd>
            <dt>{S.currentState}</dt>
            <dd>{transitionStr(n(removing, 'CurrentState'))}</dd>
            <dt>{S.monitoredEntity}</dt>
            <dd>{MONITORED_ENTITIES[n(removing, 'MonitoredEntity')] ?? S.unknown}</dd>
            <dt>{S.enabledState}</dt>
            <dd>{ENABLED_STATES[n(removing, 'EnabledState')] ?? S.unknown}</dd>
          </dl>
        </Dialog>
      )}
    </div>
  )
}

/** AMT_AgentPresenceWatchdog.AddAction, index.html:7167-7174. */
function AddActionDialog(props: { watchdog: WsmanNode; onClose: () => void; onDone: () => void }) {
  const [from, setFrom] = useState(0)
  const [to, setTo] = useState(0)
  const [event, setEvent] = useState(true)

  return (
    <Dialog
      title={S.addWatchdogAction}
      width={520}
      buttons={[
        { label: S.ok, value: 'ok', primary: true },
        { label: S.cancel, value: 'cancel' },
      ]}
      onClose={(v) => {
        if (v !== 'ok' || from === 0 || to === 0 || !event) return
        getStack()?.Exec(
          'AMT_AgentPresenceWatchdog',
          'AddAction',
          { OldState: from, NewState: to, EventOnTransition: event },
          props.onDone,
          undefined,
          0,
          { DeviceID: s(props.watchdog, 'DeviceID') },
        )
      }}
    >
      <div class="field-row">
        <label>
          {S.from}
          {STATES.map(([bit, label]) => (
            <span key={bit}>
              <input
                type="checkbox"
                checked={(from & bit) !== 0}
                onChange={(e) => setFrom(mask(from, bit, e.currentTarget.checked))}
              />
              {label}
            </span>
          ))}
        </label>
        <label>
          {S.to}
          {STATES.map(([bit, label]) => (
            <span key={bit}>
              <input
                type="checkbox"
                checked={(to & bit) !== 0}
                onChange={(e) => setTo(mask(to, bit, e.currentTarget.checked))}
              />
              {label}
            </span>
          ))}
        </label>
        <label>
          <input type="checkbox" checked={event} onChange={(e) => setEvent(e.currentTarget.checked)} />
          {S.writeToEventLog}
        </label>
      </div>
    </Dialog>
  )
}
