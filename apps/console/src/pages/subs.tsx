/**
 * Event Subscriptions -- legacy view 22 (index.html:6159-6249).
 *
 * Lists the event subscribers configured on the device and removes them with
 * CIM_FilterCollectionSubscription's UNSUBSCRIBE. The reference device refused
 * to enumerate AMT_EventSubscriptionService, so the table is normally empty.
 */
import { useEffect, useState } from 'preact/hooks'
import { s, selectorValue } from '../lib/wsm'
import { PullSubscriptions, getStack, pending, subscriptions } from '../state/device'
import type { SelectorSet, WsmanEndpoint, WsmanNode } from '../lib/wsman'
import { S } from '../strings'
import { Dialog } from '../ui/dialog'
import { Table, type Column } from '../ui/table'

const ANON = 'http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous'
/** index.html:6198 */
const DELIVERY_MODES: Record<string, string> = {
  2: S.push,
  3: S.pushWithAck,
  4: S.events,
  5: S.pull,
}


/** Depth-first search for a `<w:Selector Name="...">` value anywhere in a reference. */

/** UNSUBSCRIBE selectors for CIM_FilterCollectionSubscription, index.html:6215. */
function unsubscribeSelectors(sub: WsmanNode): SelectorSet {
  const endpoint = (resourceUri: string, selectors: [string, string][]): WsmanEndpoint => ({
    Address: ANON,
    ReferenceParameters: {
      ResourceURI: resourceUri,
      SelectorSet: {
        Selector: selectors.map(([name, value]) => ({ '@Name': name, Value: value })),
      },
    },
  })
  return {
    Filter: endpoint('http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_FilterCollection', [
      ['InstanceID', selectorValue(sub['Filter'], 'InstanceID')],
    ]),
    Handler: endpoint('http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_ListenerDestinationWSManagement', [
      ['CreationClassName', 'CIM_ListenerDestinationWSMAN'],
      ['Name', s(sub, 'Name')],
      ['SystemCreationClassName', 'CIM_ComputerSystem'],
      ['SystemName', 'Intel(r) AMT'],
    ]),
  }
}

export function SubsPage() {
  const rows = subscriptions.value
  const [detail, setDetail] = useState<WsmanNode | null>(null)

  const pull = () => PullSubscriptions()
  useEffect(pull, [])

  const columns: Column[] = [
    { label: S.filterLabel, cell: (x: WsmanNode) => selectorValue(x['Filter'], 'InstanceID') || s(x, 'ElementName') },
    { label: S.destination, cell: (x: WsmanNode) => s(x, 'Destination') },
    { label: S.deliveryMode, cell: (x: WsmanNode) => DELIVERY_MODES[s(x, 'DeliveryMode')] ?? s(x, 'DeliveryMode') },
    {
      label: S.actions,
      cell: (x: WsmanNode) => (
        <button type="button" class="btn" onClick={() => setDetail(x)}>
          {S.details}
        </button>
      ),
    },
  ]

  return (
    <div class="page">
      <Table loading={pending.value > 0}
        title={S.subscribersHeading}
        columns={columns}
        rows={rows}
        keyOf={(x) => s(x, 'Name') || s(x, 'Destination')}
        onRefresh={pull}
        empty={S.noSubscriptions}
      />

      {detail != null && (
        <Dialog
          title={S.subscription}
          buttons={[
            { label: S.remove, value: 'remove' },
            { label: S.close, value: 'cancel' },
          ]}
          onClose={(v) => {
            const sub = detail
            setDetail(null)
            if (v !== 'remove') return
            getStack()?.UnSubscribe('CIM_FilterCollectionSubscription', pull, undefined, 1, unsubscribeSelectors(sub))
          }}
        >
          <dl class="kv">
            <dt>{S.destination}</dt>
            <dd class="mono">{s(detail, 'Destination')}</dd>
            <dt>{S.filterLabel}</dt>
            <dd class="mono">{selectorValue(detail['Filter'], 'InstanceID') || s(detail, 'ElementName')}</dd>
            <dt>{S.deliveryMode}</dt>
            <dd>{DELIVERY_MODES[s(detail, 'DeliveryMode')] ?? s(detail, 'DeliveryMode')}</dd>
          </dl>
        </Dialog>
      )}
    </div>
  )
}