/**
 * Audit Log (view 15).
 *
 * Ported from the ###BEGIN###{AuditLog} region (index.html:6251-6365) plus the
 * record decoder and string table in amt-0.2.0.js:644-856.
 *
 * Two calls feed this page. Enum('AMT_AuditLog') yields the log's own instance
 * (state, record count, overwrite policy) and lands in the auditLog signal;
 * ReadRecords yields the base64 event records, which have to be unpacked here
 * because the wire format is positional binary, not CIM.
 */
import { useEffect, useState } from 'preact/hooks'
import { readShort } from '../lib/bytes'
import type { WsmanValue } from '../lib/wsman'
import { format, type AmtStack } from '../lib/amt-stack'
import { getSidString } from '../lib/sid'
import { auditLog, connState, getStack, PullAuditLog } from '../state/device'
import { S, REALM_NAMES } from '../strings'
import { Dialog } from '../ui/dialog'
import { Table, type Column } from '../ui/table'
import { LockIcon, UnlockIcon } from '../ui/icons'

interface AuditEntry {
  time: Date
  initiator: string
  address: string
  application: string
  event: string
  /** Raw extended-data bytes, shown verbatim when nothing decodes them. */
  ex: string
  exStr: string | null
  /** Everything about the record, lowercased, for the filter box. */
  search: string
}

export function AuditPage() {
  const [records, setRecords] = useState<AuditEntry[]>([])
  const [filter, setFilter] = useState('')
  const [detail, setDetail] = useState<AuditEntry | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [reload, setReload] = useState(0)

  // The settings half of the page reads straight from the signal; the connection
  // signal is read here too so the pull still runs if the device connects after
  // this page mounted.
  const instance = auditLog.value[0]
  const conn = connState.value

  useEffect(() => {
    const stack = getStack()
    if (conn !== 'connected' || stack == null) return
    PullAuditLog()
    readRecords(stack, [], 0, setRecords)
  }, [conn, reload])

  const refresh = () => setReload((n) => n + 1)

  const setLock = (flag: number) => {
    const stack = getStack()
    if (stack == null) return
    stack.Exec('AMT_AuditLog', 'SetAuditLock', { LockTimeoutInSeconds: 0, Flag: flag, Handle: 0 }, () => refresh())
  }

  // Legacy ClearAuditLogEx: lock, clear, unlock, then let the device settle.
  const clear = () => {
    const stack = getStack()
    setConfirmClear(false)
    if (stack == null) return
    stack.Exec('AMT_AuditLog', 'SetAuditLock', { LockTimeoutInSeconds: 1, Flag: 0, Handle: 0 }, () => {
      stack.Exec('AMT_AuditLog', 'ClearLog', {}, () => {
        stack.Exec('AMT_AuditLog', 'SetAuditLock', { LockTimeoutInSeconds: 0, Flag: 2, Handle: 0 }, () => {
          setTimeout(refresh, 1000)
        })
      })
    })
  }

  const needle = filter.toLowerCase()
  const rows = needle === '' ? records : records.filter((r) => r.search.includes(needle))

  const columns: Column[] = [
    { label: S.time, cell: (r: AuditEntry) => r.time.toLocaleString() },
    {
      label: S.initiator,
      cell: (r: AuditEntry) => (r.initiator === '' ? '—' : r.initiator + (r.address === '' ? '' : ', ' + r.address)),
    },
    {
      label: S.event,
      cell: (r: AuditEntry) => (
        <a href="#" onClick={(ev) => { ev.preventDefault(); setDetail(r) }}>
          {[r.application, r.event, r.exStr].filter((p) => p !== '' && p != null).join(', ')}
        </a>
      ),
    },
  ]

  const stateBits = Number(instance?.['AuditState'] ?? 0)

  return (
    <div class="page">
      <section class="table-panel">
        <div class="table-titlebar">
          <h2 class="table-title">{S.auditSettings}</h2>
        </div>
        <dl class="kv">
          <dt>{S.auditState}</dt>
          <dd>{auditState(stateBits)}</dd>
          <dt>{S.auditStorage}</dt>
          <dd>
            {format(S.auditRecords, String(instance?.['CurrentNumberOfRecords'] ?? 0), String(instance?.['PercentageFree'] ?? 0))}
          </dd>
          <dt>{S.overwritePolicy}</dt>
          <dd>{Number(instance?.['OverwritePolicy'] ?? 0) === 2 ? S.wrapsWhenFull : S.neverOverwrites}</dd>
        </dl>
      </section>

      <Table
        title={S.auditEvents}
        columns={columns}
        rows={rows}
        keyOf={(r) => String(r.time.getTime()) + r.event + r.initiator}
        onRefresh={refresh}
        empty={S.noAuditEvents}
        footer={
          <div class="btn-row">
            <input
              type="text"
              placeholder={S.filter}
              value={filter}
              onInput={(e) => setFilter(e.currentTarget.value)}
            />
            <button type="button" class="btn" onClick={() => setLock(stateBits & 0x02 ? 2 : 1)}>
              {stateBits & 0x02 ? <UnlockIcon /> : <LockIcon />}
              {stateBits & 0x02 ? S.unlock : S.lock}
            </button>
            <button type="button" class="btn" onClick={() => setConfirmClear(true)}>
              {S.clearLog}
            </button>
          </div>
        }
      />

      {detail != null && (
        <Dialog title={S.auditEventDetails} onClose={() => setDetail(null)} buttons={[{ label: S.close, value: 'cancel' }]}>
          <dl class="kv">
            <dt>{S.time}</dt>
            <dd class="mono">{detail.time.toLocaleString()}</dd>
            {detail.initiator !== '' && (
              <>
                <dt>{S.initiator}</dt>
                <dd class="mono">{detail.initiator}</dd>
              </>
            )}
            {detail.address !== '' && (
              <>
                <dt>{S.address}</dt>
                <dd class="mono">{detail.address}</dd>
              </>
            )}
            <dt>{S.application}</dt>
            <dd>{detail.application}</dd>
            <dt>{S.event}</dt>
            <dd>{detail.event}</dd>
            {detail.exStr != null ? (
              <>
                <dt>{S.extendedData}</dt>
                <dd>{detail.exStr}</dd>
              </>
            ) : (
              detail.ex.length > 0 && (
                <>
                  <dt>{S.dataValues}</dt>
                  <dd class="mono">
                    {[...detail.ex].map((c) => c.charCodeAt(0)).join(',')}
                  </dd>
                  {detail.ex.length > 2 && readShort(detail.ex, 0) === detail.ex.length - 2 && (
                    <>
                      <dt>{S.dataString}</dt>
                      <dd class="mono">{detail.ex.substring(2)}</dd>
                    </>
                  )}
                </>
              )
            )}
          </dl>
        </Dialog>
      )}

      {confirmClear && (
        <Dialog
          title={S.navAudit}
          onClose={(v) => (v === 'ok' ? clear() : setConfirmClear(false))}
          buttons={[
            { label: S.ok, value: 'ok', primary: true },
            { label: S.cancel, value: 'cancel' },
          ]}
        >
          <p>{S.clearAuditLogConfirm}</p>
        </Dialog>
      )}
    </div>
  )
}

/** ReadRecords pages in batches of 256; keep asking until the count is met. */
function readRecords(stack: AmtStack, out: AuditEntry[], consumed: number, done: (r: AuditEntry[]) => void) {
  // `consumed` counts records the device handed over, not records that decoded:
  // a batch that will not decode must still advance the cursor or the paging
  // below never terminates.
  stack.Exec('AMT_AuditLog', 'ReadRecords', { StartIndex: consumed + 1 }, (_s, _name, resp) => {
    const body = resp?.Body
    const raw = body?.['EventRecords']
    const batch = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]) as WsmanValue[]
    for (const r of batch) {
      if (typeof r !== 'string') continue
      try {
        out.push(decodeRecord(atob(r)))
      } catch {
        // AMT occasionally hands back a record that does not decode; skip it.
      }
    }
    const total = Number(body?.['TotalRecordCount'] ?? 0)
    const next = consumed + batch.length
    if (batch.length > 0 && next < total) readRecords(stack, out, next, done)
    else done(out)
  })
}

function decodeRecord(e: string): AuditEntry {
  const appId = readShort(e, 0)
  const eventId = readShort(e, 2)
  const initiatorType = e.charCodeAt(4)

  let ptr = 5
  let initiator = ''
  if (initiatorType === 0) {
    // HTTP digest: a length prefixed user name.
    const len = e.charCodeAt(ptr++)
    initiator = e.substr(ptr, len)
    ptr += len
  } else if (initiatorType === 1) {
    // Kerberos: a length prefixed SID.
    const len = e.charCodeAt(9)
    initiator = getSidString(e.substr(10, len))
    ptr = 10 + len
  } else if (initiatorType === 2) {
    initiator = S.initiatorLocal
  } else if (initiatorType === 3) {
    initiator = S.initiatorKvm
  }

  const time = new Date((readInt(e, ptr) + new Date().getTimezoneOffset() * 60) * 1000)
  ptr += 4

  ptr++ // MCLocationType, unused by the console
  const netLen = e.charCodeAt(ptr++)
  const address = e.substr(ptr, netLen)
  ptr += netLen

  const exLen = e.charCodeAt(ptr++)
  const ex = e.substr(ptr, exLen)

  const application = AUDIT_STRINGS[appId] ?? '#' + appId
  const event = AUDIT_STRINGS[appId * 100 + eventId] ?? '#' + eventId
  const exStr = auditExtendedData(appId * 100 + eventId, ex)

  return {
    time,
    initiator,
    address: address === '0000:0000:0000:0000:0000:0000:0000:0001' ? '::1' : address,
    application,
    event,
    ex,
    exStr,
    search: [initiator, address, application, event, exStr ?? ''].join(' ').toLowerCase(),
  }
}

/** AuditState bit field (index.html:6270). */
function auditState(bits: number): string {
  const parts: string[] = [bits & 0x01 ? S.disabled : S.enabled]
  if (bits & 0x02) parts.push(S.locked)
  if (bits & 0x04) parts.push(S.almostFull)
  if (bits & 0x08) parts.push(S.full)
  if (bits & 0x10) parts.push(S.noKey)
  return parts.join(', ')
}

/** `* 0x1000000` rather than `<< 24`: the shift would sign the result. */
function readInt(v: string, p: number): number {
  return v.charCodeAt(p) * 0x1000000 + (v.charCodeAt(p + 1) << 16) + (v.charCodeAt(p + 2) << 8) + v.charCodeAt(p + 3)
}

/**
 * Decode the per-event extended data block, ported from
 * amt-0.2.0.js:769 GetAuditLogExtendedDataStr. Returns null for events whose
 * payload has no known shape, which is what the detail dialog falls back on.
 */
function auditExtendedData(id: number, data: string): string | null {
  const byte = (i: number) => data.charCodeAt(i)
  if ((id === 1602 || id === 1604) && byte(0) === 0) return data.substring(2, 2 + byte(1)) // ACL entry added/removed
  if (id === 1603) return byte(1) === 0 ? data.substring(3) : null // ACL entry modified
  if (id === 1605) return ['Invalid ME access', 'Invalid MEBx access'][byte(0)] ?? null
  if (id === 1606) {
    const enabled = ['Disabled', 'Enabled'][byte(0)]
    return byte(1) === 0 ? enabled + ', ' + data.substring(3) : enabled
  }
  if (id === 1607) {
    const auth = ['NoAuth', 'ServerAuth', 'MutualAuth']
    return 'Remote ' + auth[byte(0)] + ', Local ' + auth[byte(1)]
  }
  if (id === 1617) return REALM_NAMES[readInt(data, 0)] + ', ' + ['NoAuth', 'Auth', 'Disabled'][byte(4)] // realm auth mode
  if (id === 1619) return ['BIOS', 'MEBx', 'Local MEI', 'Local WSMAN', 'Remote WSAMN'][byte(0)] ?? null
  if (id === 1900) {
    // Firmware version is four 16 bit fields, before and after.
    const v = (o: number) => readShort(data, o)
    return 'From ' + [v(0), v(2), v(4), v(6)].join('.') + ' to ' + [v(8), v(10), v(12), v(14)].join('.')
  }
  if (id === 2100) return new Date(readInt(data, 0) * 1000 + new Date().getTimezoneOffset() * 60000).toLocaleString()
  if (id === 3000) {
    const optIn = ['None', 'KVM', 'All']
    return 'From ' + optIn[byte(0)] + ' to ' + optIn[byte(1)]
  }
  if (id === 3001) return ['Success', 'Failed 3 times'][byte(0)] ?? null
  return null
}

/**
 * Audit app and event names, verbatim from the Intel AMT security admin event
 * list (amt-0.2.0.js:648). Events are keyed `appId * 100 + eventId`.
 */
const AUDIT_STRINGS: Record<number, string> = {
  16: 'Security Admin',
  17: 'RCO',
  18: 'Redirection Manager',
  19: 'Firmware Update Manager',
  20: 'Security Audit Log',
  21: 'Network Time',
  22: 'Network Administration',
  23: 'Storage Administration',
  24: 'Event Manager',
  25: 'Circuit Breaker Manager',
  26: 'Agent Presence Manager',
  27: 'Wireless Configuration',
  28: 'EAC',
  29: 'KVM',
  30: 'User Opt-In Events',
  32: 'Screen Blanking',
  33: 'Watchdog Events',
  1600: 'Provisioning Started',
  1601: 'Provisioning Completed',
  1602: 'ACL Entry Added',
  1603: 'ACL Entry Modified',
  1604: 'ACL Entry Removed',
  1605: 'ACL Access with Invalid Credentials',
  1606: 'ACL Entry State',
  1607: 'TLS State Changed',
  1608: 'TLS Server Certificate Set',
  1609: 'TLS Server Certificate Remove',
  1610: 'TLS Trusted Root Certificate Added',
  1611: 'TLS Trusted Root Certificate Removed',
  1612: 'TLS Preshared Key Set',
  1613: 'Kerberos Settings Modified',
  1614: 'Kerberos Main Key Modified',
  1615: 'Flash Wear out Counters Reset',
  1616: 'Power Package Modified',
  1617: 'Set Realm Authentication Mode',
  1618: 'Upgrade Client to Admin Control Mode',
  1619: 'Unprovisioning Started',
  1700: 'Performed Power Up',
  1701: 'Performed Power Down',
  1702: 'Performed Power Cycle',
  1703: 'Performed Reset',
  1704: 'Set Boot Options',
  1705: 'Remote graceful power down initiated',
  1706: 'Remote graceful reset initiated',
  1707: 'Remote Standby initiated',
  1708: 'Remote Hiberate initiated',
  1709: 'Remote NMI initiated',
  1800: 'IDER Session Opened',
  1801: 'IDER Session Closed',
  1802: 'IDER Enabled',
  1803: 'IDER Disabled',
  1804: 'SoL Session Opened',
  1805: 'SoL Session Closed',
  1806: 'SoL Enabled',
  1807: 'SoL Disabled',
  1808: 'KVM Session Started',
  1809: 'KVM Session Ended',
  1810: 'KVM Enabled',
  1811: 'KVM Disabled',
  1812: 'VNC Password Failed 3 Times',
  1900: 'Firmware Updated',
  1901: 'Firmware Update Failed',
  2000: 'Security Audit Log Cleared',
  2001: 'Security Audit Policy Modified',
  2002: 'Security Audit Log Disabled',
  2003: 'Security Audit Log Enabled',
  2004: 'Security Audit Log Exported',
  2005: 'Security Audit Log Recovered',
  2100: 'Intel&reg; ME Time Set',
  2200: 'TCPIP Parameters Set',
  2201: 'Host Name Set',
  2202: 'Domain Name Set',
  2203: 'VLAN Parameters Set',
  2204: 'Link Policy Set',
  2205: 'IPv6 Parameters Set',
  2300: 'Global Storage Attributes Set',
  2301: 'Storage EACL Modified',
  2302: 'Storage FPACL Modified',
  2303: 'Storage Write Operation',
  2400: 'Alert Subscribed',
  2401: 'Alert Unsubscribed',
  2402: 'Event Log Cleared',
  2403: 'Event Log Frozen',
  2500: 'CB Filter Added',
  2501: 'CB Filter Removed',
  2502: 'CB Policy Added',
  2503: 'CB Policy Removed',
  2504: 'CB Default Policy Set',
  2505: 'CB Heuristics Option Set',
  2506: 'CB Heuristics State Cleared',
  2600: 'Agent Watchdog Added',
  2601: 'Agent Watchdog Removed',
  2602: 'Agent Watchdog Action Set',
  2700: 'Wireless Profile Added',
  2701: 'Wireless Profile Removed',
  2702: 'Wireless Profile Updated',
  2703: 'An existing profile sync was modified',
  2704: 'An existing profile link preference was changed',
  2705: 'Wireless profile share with UEFI enabled setting was changed',
  2800: 'EAC Posture Signer SET',
  2801: 'EAC Enabled',
  2802: 'EAC Disabled',
  2803: 'EAC Posture State',
  2804: 'EAC Set Options',
  2900: 'KVM Opt-in Enabled',
  2901: 'KVM Opt-in Disabled',
  2902: 'KVM Password Changed',
  2903: 'KVM Consent Succeeded',
  2904: 'KVM Consent Failed',
  3000: 'Opt-In Policy Change',
  3001: 'Send Consent Code Event',
  3002: 'Start Opt-In Blocked Event',
  3301: 'A user has modified the Watchdog Action settings',
  3302: 'A user has modified a Watchdog to add, remove, or alter the Watchdog Action connected to it',
}
