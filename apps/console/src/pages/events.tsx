/**
 * Event Log (`#/events`), legacy view 6 -- index.html:6070-6157.
 *
 * Two distinct reads sit behind this page. Enumerating `AMT_MessageLog` on its own
 * only describes the log (record count, capacity, IsFrozen); the records come from
 * the PositionToFirstRecord / GetRecords walk the legacy stack exposed as
 * GetMessageLog (amt-0.2.0.js:497-535). That walk is re-run here because the ported
 * stack carries no GetMessageLog, and each base64 record is decoded into the same
 * object the legacy panel rendered.
 */
import { useSignal, type Signal } from '@preact/signals'
import '../styles/events.css'
import { useEffect, useState } from 'preact/hooks'
import { format } from '../lib/amt-stack'
import { PullEventLog, eventLog, getStack, pending } from '../state/device'
import { S } from '../strings'
import { Dialog } from '../ui/dialog'
import { LockIcon, UnlockIcon } from '../ui/icons'
import { Table, type Column } from '../ui/table'

/** RecordArray is read in pages of this size, matching amt-0.2.0.js:502. */
const PAGE_SIZE = 390

/** One decoded AMT_MessageLog record; the field names are the legacy ones. */
type EventRecord = {
  Time: number
  DeviceAddress: number
  Desc: string
  Entity: number
  EntityInstance: number
  EntityStr: string
  EventData: number[]
  EventOffset: number
  EventSensorType: number
  EventSeverity: number
  EventSourceType: number
  EventType: number
  SensorNumber: number
}

/** Table row: the record plus its position in the unfiltered log. */
type EventRow = { index: number; record: EventRecord }

/** One definition row: the label and the value the device reported. */
type Field = [string, string]

// common-0.0.1.js:28 -- little-endian 32-bit read over the decoded record bytes.
const readIntX = (bytes: string, offset: number) =>
  bytes.charCodeAt(offset + 3) * 0x1000000 +
  (bytes.charCodeAt(offset + 2) << 16) +
  (bytes.charCodeAt(offset + 1) << 8) +
  bytes.charCodeAt(offset)

const SYSTEM_ENTITY_TYPES =
  'Unspecified|Other|Unknown|Processor|Disk|Peripheral|System management module|System board|Memory module|Processor module|Power supply|Add in card|Front panel board|Back panel board|Power system board|Drive backplane|System internal expansion board|Other system board|Processor board|Power unit|Power module|Power management board|Chassis back panel board|System chassis|Sub chassis|Other chassis board|Disk drive bay|Peripheral bay|Device bay|Fan cooling|Cooling unit|Cable interconnect|Memory device|System management software|BIOS|Intel(r) ME|System bus|Group|Intel(r) ME|External environment|Battery|Processing blade|Connectivity switch|Processor/memory module|I/O module|Processor I/O module|Management controller firmware|IPMI channel'.split(
    '|'
  )

const FIRMWARE_ERROR =
  'Unspecified.|No system memory is physically installed in the system.|No usable system memory, all installed memory has experienced an unrecoverable failure.|Unrecoverable hard-disk/ATAPI/IDE device failure.|Unrecoverable system-board failure.|Unrecoverable diskette subsystem failure.|Unrecoverable hard-disk controller failure.|Unrecoverable PS/2 or USB keyboard failure.|Removable boot media not found.|Unrecoverable video controller failure.|No video device detected.|Firmware (BIOS) ROM corruption detected.|CPU voltage mismatch (processors that share same supply have mismatched voltage requirements)|CPU speed matching failure'.split(
    '|'
  )

const FIRMWARE_PROGRESS =
  'Unspecified.|Memory initialization.|Starting hard-disk initialization and test|Secondary processor(s) initialization|User authentication|Entering BIOS setup|USB resource configuration|PCI resource configuration|Option ROM initialization|Video initialization|Cache initialization|SM Bus initialization|Keyboard controller initialization|Embedded controller/management controller initialization|Docking station attachment|Enabling docking station|Docking station ejection|Disabling docking station|Calling operating system wake-up vector|Starting operating system boot process|Baseboard or motherboard initialization|reserved|Floppy initialization|Keyboard test|Pointing device test|Primary processor initialization'.split(
    '|'
  )

const OCR_PROGRESS = [
  'Boot parameters received from CSME',
  'CSME Boot Option % added successfully',
  'HTTPS URI name resolved',
  'HTTPS connected successfully',
  'HTTPSBoot download is completed',
  'Attempt to boot',
  'Exit boot services'
]
const OCR_ERROR = [
  '',
  'No network connection available',
  'Name resolution of URI failed',
  'Connection to URI failed',
  'OEM app not found at local URI',
  'HTTPS TLS Auth failed',
  'HTTPS Digest Auth failed',
  'Verified boot failed (bad image)',
  'HTTPS Boot File not found'
]
const OCR_SOURCE: Record<number, string> = { 1: '', 2: 'HTTPS', 4: 'Local PBA', 8: 'WinRE' }

/** The erase sub-targets of the platform-erase progress events. */
const ERASE_TARGETS: Record<number, string> = { 2: S.deviceSsd, 3: S.deviceTpm, 5: S.deviceBiosGoldenConfig }

const WATCHDOG_STATES: Record<number, string> = {
  1: S.notStarted,
  2: S.stopped,
  4: S.running,
  8: S.expired,
  16: S.suspended
}

/** amt-0.2.0.js:593 -- the watchdog uuid is printed in hex, byte by byte. */
const hexByte = (value: number) => value.toString(16).padStart(2, '0')

/** amt-0.2.0.js:547-642: sensor type plus event data, in words. */
function detailOf(record: EventRecord): string {
  const data = record.EventData
  const type = record.EventSensorType
  const offset = record.EventOffset

  if (type === 15) {
    if (data[0] === 235) return S.invalidData
    if (offset === 0) return FIRMWARE_ERROR[data[1]] ?? S.unknown
    if (offset === 3) {
      if (data[0] === 170 && data[1] === 48) return format(S.ocrError, OCR_ERROR[data[2]] ?? '')
      if (data[0] === 170 && data[1] === 64) {
        if (data[2] === 1) return S.eraseSsdError
        if (data[2] === 2) return S.eraseTpmUnsupported
        if (data[2] === 3) return S.reachedMaxCounter
      } else {
        return S.oemFirmwareError
      }
    }
    if (offset === 5) {
      if (data[0] === 170 && data[1] === 48) {
        if (data[2] === 1) return format(S.ocrBootOption, data[3], OCR_SOURCE[data[3]] ?? '')
        if (data[2] < 7) return format(S.ocrProgress, OCR_PROGRESS[data[2]] ?? '')
        return format(S.ocrUnknownProgress, data[2])
      }
      if (data[0] === 170 && data[1] === 64) {
        const target = ERASE_TARGETS[data[3]]
        if (target != null && data[2] === 1) return format(S.startedErasing, target)
        if (target != null && data[2] === 2) return format(S.erasingEnded, target)
        if (data[2] === 3) return S.beginningPlatformErase
        if (data[2] === 4) return S.clearReservedParameters
        if (data[2] === 5) return S.allSettingDecremented
      } else {
        return S.oemFirmwareProgress
      }
    }
    return FIRMWARE_PROGRESS[data[1]] ?? S.unknown
  }

  if (type === 18 && data[0] === 170) {
    return format(
      S.watchdogState,
      hexByte(data[4]) + hexByte(data[3]) + hexByte(data[2]) + hexByte(data[1]),
      hexByte(data[6]) + hexByte(data[5]),
      WATCHDOG_STATES[data[7]] ?? S.unknown
    )
  }

  if (type === 5 && offset === 0) return S.caseIntrusion

  if (type === 192 && offset === 0 && data[0] === 170 && data[1] === 48) {
    if (data[2] === 0) return S.solSessionEstablished
    if (data[2] === 1) return S.solSessionFinished
    if (data[2] === 2) return S.iderSessionEstablished
    if (data[2] === 3) return S.iderSessionFinished
  }

  if (type === 36) {
    const handle = (data[1] << 24) + (data[2] << 16) + (data[3] << 8) + data[4]
    const nic = data[0] === 0xaa ? S.wired : '#' + data[0]
    if (handle === 4294967293) return format(S.filterInbound, nic)
    if (handle === 4294967292) return format(S.filterOutbound, nic)
    if (handle === 4294967290) return format(S.filterSpoofed, nic)
    return format(S.filterMatched, handle, nic)
  }

  if (type === 192) {
    if (data[2] === 0) return S.securityPolicyTx
    if (data[2] === 2) return S.securityPolicyRx
    return S.securityPolicy
  }

  if (type === 193) {
    if (data[0] === 0xaa && data[1] === 0x30) return S.userRemoteConnectionRequest
    if (data[0] === 0xaa && data[1] === 0x20 && data[2] === 0x04) return S.hwaError
  }

  if (type === 6) return format(S.authFailed, data[1] + (data[2] << 8))
  if (type === 30) return S.noBootableMedia
  if (type === 32) return S.osLockupOrPowerInterrupt
  if (type === 35) return data[0] === 64 ? S.biosPostWatchdog : S.systemBootFailure
  if (type === 37) return S.firmwareStarted
  return format(S.unknownSensorType, type)
}

/** One base64 RecordArray entry, per amt-0.2.0.js:521-531. */
function decodeRecord(encoded: string): EventRecord | null {
  let bytes: string
  try {
    bytes = atob(encoded)
  } catch {
    return null
  }
  const stamp = readIntX(bytes, 0)
  if (!(stamp > 0 && stamp < 0xffffffff)) return null
  const data: number[] = []
  for (let i = 13; i < 21; i++) data.push(bytes.charCodeAt(i))
  const record: EventRecord = {
    // The device stamps UTC; offsetting by the browser zone keeps the rendered
    // wall clock identical to the value the firmware recorded.
    Time: (stamp + new Date().getTimezoneOffset() * 60) * 1000,
    DeviceAddress: bytes.charCodeAt(4),
    Entity: bytes.charCodeAt(11),
    EntityInstance: bytes.charCodeAt(12),
    EntityStr: SYSTEM_ENTITY_TYPES[bytes.charCodeAt(11)] ?? S.unknown,
    EventData: data,
    EventOffset: bytes.charCodeAt(7),
    EventSensorType: bytes.charCodeAt(5),
    EventSeverity: bytes.charCodeAt(9),
    EventSourceType: bytes.charCodeAt(8),
    EventType: bytes.charCodeAt(6),
    SensorNumber: bytes.charCodeAt(10),
    Desc: ''
  }
  record.Desc = detailOf(record)
  return record
}

function readRecords(
  into: Signal<EventRecord[]>,
  iteration: string,
  accumulated: EventRecord[]
): void {
  getStack()?.Exec(
    'AMT_MessageLog',
    'GetRecords',
    { IterationIdentifier: iteration, MaxReadRecords: PAGE_SIZE },
    (_s, _name, resp) => {
      const body = resp?.Body
      if (body?.['ReturnValue'] !== 0) return
      const raw = body['RecordArray']
      const batch: unknown[] = Array.isArray(raw) ? raw : raw == null ? [] : [raw]
      const decoded = batch
        .map((entry) => decodeRecord(String(entry)))
        .filter((record): record is EventRecord => record != null)
      const all = accumulated.concat(decoded)
      // A device that answers without a RecordArray would otherwise loop forever.
      if (batch.length === 0 || body['NoMoreRecords'] === true) {
        into.value = all
        return
      }
      readRecords(into, String(body['IterationIdentifier'] ?? iteration), all)
    }
  )
}

/** GetMessageLog, ported from amt-0.2.0.js:497-503. */
function pullRecords(into: Signal<EventRecord[]>): void {
  const stack = getStack()
  if (stack == null) return
  stack.Exec('AMT_MessageLog', 'PositionToFirstRecord', {}, (_s, _name, resp) => {
    const body = resp?.Body
    const iteration = body?.['IterationIdentifier']
    if (body?.['ReturnValue'] !== 0 || iteration == null) {
      into.value = []
      return
    }
    readRecords(into, String(iteration), [])
  })
}

/** Legacy icon thresholds, index.html:6115, expressed as a status class. */
function severityOf(severity: number): { cls: string; label: string } {
  if (severity >= 16) return { cls: 'status-error', label: S.critical }
  if (severity >= 8) return { cls: 'status-warn', label: S.warning }
  return { cls: 'status-ok', label: S.information }
}

function stamp(value: number): string {
  return new Date(value).toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function DetailList(props: { record: EventRecord }) {
  const m = props.record
  const fields: Field[] = [
    [S.time, stamp(m.Time)],
    [S.source, m.EntityStr.replace('(r)', '®')],
    [S.description, m.Desc],
    [S.deviceAddress, String(m.DeviceAddress)],
    [S.entity, String(m.Entity)],
    [S.entityInstance, String(m.EntityInstance)],
    [S.eventData, m.EventData.join(', ')],
    [S.offset, String(m.EventOffset)],
    [S.sensorType, String(m.EventSensorType)],
    [S.severity, String(m.EventSeverity)],
    [S.sourceType, String(m.EventSourceType)],
    [S.type, String(m.EventType)],
    [S.sensorNumber, String(m.SensorNumber)]
  ]
  return (
    <dl class="kv">
      {fields.map(([label, value]) => (
        <>
          <dt>{label}</dt>
          <dd class="mono">{value === '' ? '—' : value}</dd>
        </>
      ))}
    </dl>
  )
}

export function EventsPage() {
  const records = useSignal<EventRecord[]>([])
  const [filter, setFilter] = useState('')
  /** Index of the record shown in the details dialog, or -1 for the whole log. */
  const [detail, setDetail] = useState<number | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const refresh = () => {
    PullEventLog()
    pullRecords(records)
  }

  useEffect(() => {
    refresh()
  }, [])

  const settings = eventLog.value[0]
  const frozen = settings?.['IsFrozen'] === true
  const needle = filter.toLowerCase()
  const rows: EventRow[] = records.value
    .map((record, index) => ({ index, record }))
    .filter(
      ({ record }) =>
        needle === '' ||
        record.Desc.toLowerCase().includes(needle) ||
        record.EntityStr.toLowerCase().includes(needle)
    )

  const columns: Column[] = [
    { label: S.eventNumber, cell: (r: EventRow) => r.index + 1 },
    { label: S.time, cell: (r: EventRow) => stamp(r.record.Time) },
    { label: S.source, cell: (r: EventRow) => r.record.EntityStr.replace('(r)', '®') },
    {
      label: S.description,
      cell: (r: EventRow) => (
        <button type="button" class="btn-link" onClick={() => setDetail(r.index)}>
          {r.record.Desc}
        </button>
      )
    },
    {
      label: S.severity,
      cell: (r: EventRow) => {
        const level = severityOf(r.record.EventSeverity)
        return <span class={level.cls}>{level.label}</span>
      }
    }
  ]

  const clearLog = () => {
    setConfirmClear(false)
    getStack()?.Exec('AMT_MessageLog', 'ClearLog', {}, () => refresh())
  }

  const toggleFreeze = () => {
    getStack()?.Exec('AMT_MessageLog', 'FreezeLog', { Freeze: !frozen }, () => PullEventLog())
  }

  const shown = detail != null && detail >= 0 ? records.value[detail] : undefined

  return (
    <div class="page">
      <div class="page-header">
        <div class="table-actions">
          <button type="button" class="btn" onClick={refresh}>
            {S.refresh}
          </button>
          <button
            type="button"
            class="btn"
            onClick={() => setConfirmClear(true)}
            disabled={records.value.length === 0}
          >
            {S.clearEventLog}
          </button>
          <button type="button" class="btn" onClick={toggleFreeze}>
            {frozen ? <UnlockIcon /> : <LockIcon />}
            {frozen ? S.unfreezeLog : S.freezeLog}
          </button>
          <button
            type="button"
            class="btn"
            onClick={() => setDetail(-1)}
            disabled={records.value.length === 0}
          >
            {S.viewAll}
          </button>
        </div>
      </div>

      {settings != null && (
        <section class="table-panel">
          <div class="table-titlebar">
            <h2 class="table-title">{String(settings['ElementName'] ?? S.navEvents)}</h2>
          </div>
          <dl class="kv">
            <dt>{S.records}</dt>
            <dd class="mono">{String(settings['CurrentNumberOfRecords'] ?? '—')}</dd>
            <dt>{S.maximumRecords}</dt>
            <dd class="mono">{String(settings['MaxNumberOfRecords'] ?? '—')}</dd>
            <dt>{S.logStatus}</dt>
            <dd class="mono">{String(settings['Status'] ?? S.unknown)}</dd>
          </dl>
        </section>
      )}

      <Table loading={pending.value > 0}
        title={S.events}
        columns={columns}
        rows={rows}
        keyOf={(r) => String(r.index)}
        empty={S.noEvents}
        footer={
          <div class="field-row">
            <label>
              <span>{S.eventFilter}</span>
              <input
                type="text"
                value={filter}
                placeholder={S.eventFilter}
                onInput={(e) => setFilter(e.currentTarget.value)}
              />
            </label>
          </div>
        }
      />

      {confirmClear && (
        <Dialog
          title={S.navEvents}
          onClose={(value) => {
            if (value === 'ok') clearLog()
            else setConfirmClear(false)
          }}
          buttons={[
            { label: S.ok, value: 'ok', primary: true },
            { label: S.cancel, value: 'cancel' }
          ]}
        >
          <p>{S.clearEventLogConfirm}</p>
        </Dialog>
      )}

      {detail != null && (
        <Dialog
          title={detail === -1 ? S.allEvents : format(S.eventDetails, detail + 1)}
          width={760}
          onClose={() => setDetail(null)}
          buttons={[{ label: S.close, value: 'cancel' }]}
        >
          {detail === -1 ? (
            rows.map(({ index, record }) => (
              <div class="event-record">
                <h3 class="event-record-title">
                  {format(S.eventDetails, index + 1)} — {stamp(record.Time)}
                </h3>
                <DetailList record={record} />
              </div>
            ))
          ) : shown != null ? (
            <DetailList record={shown} />
          ) : (
            <p>{S.noData}</p>
          )}
        </Dialog>
      )}
    </div>
  )
}