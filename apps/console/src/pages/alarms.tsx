/**
 * Wake Alarms -- legacy view 23 (index.html:11681-11833).
 *
 * IPS_AlarmClockOccurrence instances plus the AMT_AlarmClockService.AddAlarm
 * template. The reference capture enumerated zero occurrences, so the table is
 * normally empty until an alarm is added.
 */
import { useEffect, useState } from 'preact/hooks'
import { s } from '../lib/wsm'
import { PullAlarms, alarms, getStack, pending } from '../state/device'
import type { WsmanNode } from '../lib/wsman'
import { S } from '../strings'
import { Dialog } from '../ui/dialog'
import { Table, type Column } from '../ui/table'


function child(node: WsmanNode | undefined, key: string): WsmanNode | undefined {
  const v = node?.[key]
  return v != null && typeof v === 'object' && !Array.isArray(v) ? (v as WsmanNode) : undefined
}

/** `P1DT2H30M` to "1 day 2 hours 30 minutes", index.html:11691-11696. */
function intervalText(iso: string): string {
  const body = iso.replace('T', '').substring(iso.indexOf('P') + 1)
  const spaced =
    ' ' +
    body
      .replace('D', ' ' + S.days + ' ')
      .replace('H', ' ' + S.hours + ' ')
      .replace('M', ' ' + S.minutes + ' ')
  return spaced
    .replace(/ 1 days /, ' 1 day ')
    .replace(/ 1 hours /, ' 1 hour ')
    .replace(/ 1 minutes /, ' 1 minute ')
    .trim()
}

/** `PT0S` style interval back to the days/hours/minutes triple the form uses. */
function intervalParts(iso: string): [number, number, number] {
  const parts: [number, number, number] = [0, 0, 0]
  for (const chunk of iso.replace('P', '').replace('T', '').replace(/(\d+)([DHM])/g, '$1,').split(',')) {
    const unit = chunk.slice(-1)
    const value = Number(chunk.slice(0, -1))
    if (unit === 'D') parts[0] = value
    if (unit === 'H') parts[1] = value
    if (unit === 'M') parts[2] = value
  }
  return parts
}
const pad = (v: number) => String(v).padStart(2, '0')

function startOf(alarm: WsmanNode): Date {
  const iso = s(child(alarm, 'StartTime'), 'Datetime')
  const d = new Date(iso)
  return isNaN(d.getTime()) ? new Date() : d
}

function localStamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}Z`
  )
}

export function AlarmsPage() {
  const rows = alarms.value

  const [editing, setEditing] = useState<WsmanNode | 'new' | null>(null)
  const [clearing, setClearing] = useState(false)

  const pull = () => PullAlarms()
  useEffect(pull, [])

  const columns: Column[] = [
    { label: S.name, cell: (a: WsmanNode) => s(a, 'ElementName') },
    { label: S.wakeTime, cell: (a: WsmanNode) => startOf(a).toLocaleString() },
    { label: S.repeat, cell: (a: WsmanNode) => intervalText(s(child(a, 'Interval'), 'Interval')) },
    {
      label: S.afterWake,
      cell: (a: WsmanNode) => (a['DeleteOnCompletion'] === true || a['DeleteOnCompletion'] === 'true' ? S.deleteAlarm : S.keepAlarm),
    },
    {
      label: S.actions,
      cell: (a: WsmanNode) => (
        <div class="btn-row">
          <button type="button" class="btn" onClick={() => setEditing(a)}>
            {S.details}
          </button>
          <button
            type="button"
            class="btn"
            onClick={() => getStack()?.Delete('IPS_AlarmClockOccurrence', a, pull)}
          >
            {S.remove}
          </button>
        </div>
      ),
    },
  ]

  return (
    <div class="page">
      <Table loading={pending.value > 0}
        title={S.alarmsHeading}
        columns={columns}
        rows={rows}
        keyOf={(a) => s(a, 'InstanceID') || s(a, 'ElementName')}
        onRefresh={pull}
        onAdd={() => setEditing('new')}
        onClear={rows.length > 0 ? () => setClearing(true) : undefined}
        empty={S.noWakeAlarms}
      />

      {editing != null && (
        <AlarmDialog
          alarm={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null)
            pull()
          }}
        />
      )}

      {clearing && (
        <Dialog
          title={S.removeAllAlarms}
          buttons={[
            { label: S.ok, value: 'ok', primary: true },
            { label: S.cancel, value: 'cancel' },
          ]}
          onClose={(v) => {
            setClearing(false)
            if (v !== 'ok') return
            let pending = rows.length
            for (const alarm of rows) {
              getStack()?.Delete('IPS_AlarmClockOccurrence', alarm, (_stack, _name, _response, status) => {
                if (status === 200 && --pending === 0) pull()
              })
            }
          }}
        >
          <p>{S.confirmRemoveAll}</p>
        </Dialog>
      )}
    </div>
  )
}

/**
 * index.html:11734-11817. Adding goes out as a raw AMT_AlarmClockService AddAlarm
 * template; editing is a PUT on IPS_AlarmClockOccurrence.
 */
function AlarmDialog(props: { alarm?: WsmanNode; onClose: () => void; onDone: () => void }) {
  const existing = props.alarm
  const start = existing != null ? startOf(existing) : new Date(Date.now() + 86400000)
  const [name, setName] = useState(existing != null ? s(existing, 'ElementName') : '')
  const [date, setDate] = useState(`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`)
  const [time, setTime] = useState(`${pad(start.getHours())}:${pad(start.getMinutes())}:${pad(start.getSeconds())}`)
  const [repeat, setRepeat] = useState(
    existing != null && child(existing, 'Interval') != null
      ? intervalParts(s(child(existing, 'Interval'), 'Interval')).join('-')
      : '',
  )
  const [deleteOnWake, setDeleteOnWake] = useState(existing?.['DeleteOnCompletion'] === true)

  const ok = name.length > 0 && date.split('-').length === 3 && time.split(':').length === 3

  const save = () => {
    const stack = getStack()
    if (stack == null || !ok) return
    const when = localStamp(new Date(`${date}T${time}`))
    const [days = 0, hours = 0, minutes = 0] = repeat.split('-')
    const interval = `P${days || 0}DT${hours || 0}H${minutes || 0}M`

    if (existing == null) {
      const template =
        '<d:AlarmTemplate xmlns:d="http://intel.com/wbem/wscim/1/amt-schema/1/AMT_AlarmClockService"' +
        ' xmlns:s="http://intel.com/wbem/wscim/1/ips-schema/1/IPS_AlarmClockOccurrence">' +
        `<s:InstanceID>${name}</s:InstanceID>` +
        `<s:StartTime><p:Datetime xmlns:p="http://schemas.dmtf.org/wbem/wscim/1/common">${when}</p:Datetime></s:StartTime>` +
        `<s:Interval><p:Interval xmlns:p="http://schemas.dmtf.org/wbem/wscim/1/common">${interval}</p:Interval></s:Interval>` +
        `<s:DeleteOnCompletion>${deleteOnWake}</s:DeleteOnCompletion></d:AlarmTemplate>`
      stack.wsman.ExecMethodXml(stack.CompleteName('AMT_AlarmClockService'), 'AddAlarm', template, props.onDone, undefined, 0)
      return
    }

    const updated: WsmanNode = { ...existing }
    updated['StartTime'] = { Datetime: when }
    updated['Interval'] = { Interval: interval }
    updated['DeleteOnCompletion'] = deleteOnWake
    stack.Put('IPS_AlarmClockOccurrence', updated, props.onDone, undefined, undefined, {
      InstanceID: s(existing, 'InstanceID'),
    })
  }

  return (
    <Dialog
      title={S.addAlarm}
      width={460}
      buttons={[
        { label: S.ok, value: 'ok', primary: true },
        { label: S.cancel, value: 'cancel' },
      ]}
      onClose={(v) => {
        if (v === 'ok') save()
        else props.onClose()
      }}
    >
      <div class="field-row">
        <label>
          {S.name}
          <input type="text" value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <label>
          {S.alarmDate}
          <input type="date" value={date} onInput={(e) => setDate(e.currentTarget.value)} />
        </label>
        <label>
          {S.alarmTime}
          <input type="time" step="1" value={time} onInput={(e) => setTime(e.currentTarget.value)} />
        </label>
        <label>
          {S.repeatHint}
          <input type="text" placeholder="1-0-30" value={repeat} onInput={(e) => setRepeat(e.currentTarget.value)} />
        </label>
        <label>
          <input type="checkbox" checked={deleteOnWake} onChange={(e) => setDeleteOnWake(e.currentTarget.checked)} />
          {S.deleteWhenDone}
        </label>
        {existing != null && <p class="mono">{startOf(existing).toLocaleString()}</p>}
      </div>
    </Dialog>
  )
}