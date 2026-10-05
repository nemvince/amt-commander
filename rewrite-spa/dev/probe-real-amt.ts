/**
 * Capture real WSMAN responses from a live AMT host.
 *
 * Doubles as (a) verification that the ported stack's request XML is accepted by
 * real firmware and (b) the seed corpus for dev/mock, so the mock replays the
 * exact shapes the device produces rather than hand-written approximations.
 *
 *   bun dev/probe-real-amt.ts <host:port> <user> <pass> [outdir]
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const host = process.argv[2] ?? '192.168.10.103:16992'
const user = process.argv[3] ?? 'admin'
const pass = process.argv[4] ?? 'Vince123!'
const outDir = process.argv[5] ?? 'dev/mock/real'

const AMT = 'http://intel.com/wbem/wscim/1/amt-schema/1/'
const CIM = 'http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/'
const IPS = 'http://intel.com/wbem/wscim/1/ips-schema/1/'

const ENVELOPE_OPEN =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
  ' xmlns:xsd="http://www.w3.org/2001/XMLSchema"' +
  ' xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"' +
  ' xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"' +
  ' xmlns="http://www.w3.org/2003/05/soap-envelope" >'
const ANON = '<a:ReplyTo><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo>'

let msgId = 1

function post(body: string): Promise<string> {
  const req =
    `curl -s --max-time 20 -X POST -H 'Content-Type: application/http' --digest ` +
    `-u ${JSON.stringify(user + ':' + pass)} --data-binary @- ${JSON.stringify(`http://${host}/wsman`)}`
  const proc = Bun.spawn(['bash', '-c', req], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  proc.stdin.write(body)
  proc.stdin.end()
  return new Response(proc.stdout).text()
}

const header = (action: string, resuri: string) =>
  `${ENVELOPE_OPEN}<Header><a:Action>${action}</a:Action><a:To>/wsman</a:To>` +
  `<w:ResourceURI>${resuri}</w:ResourceURI><a:MessageID>${msgId++}</a:MessageID>${ANON}` +
  `<w:OperationTimeout>PT60S</w:OperationTimeout></Header>`

function bodyOf(xml: string): string {
  const m = xml.match(/<a:Body>([\s\S]*)<\/a:Body>/)
  return m ? m[1] : xml
}

/** Enumerate then pull to exhaustion, returning the concatenated item elements. */
async function enumerateClass(resuri: string): Promise<{ items: string[]; raw: string[]; fault?: string }> {
  const enumResp = await post(
    header('http://schemas.xmlsoap.org/ws/2004/09/enumeration/Enumerate', resuri) +
      '<Body><Enumerate xmlns="http://schemas.xmlsoap.org/ws/2004/09/enumeration" /></Body></Envelope>',
  )
  const ctx = enumResp.match(/<g:EnumerationContext>([^<]*)</)?.[1]
  if (!ctx) return { items: [], raw: [enumResp], fault: 'no enumeration context' }

  const items: string[] = []
  const raw: string[] = [enumResp]
  for (let page = 0; page < 50; page++) {
    const pullResp = await post(
      header('http://schemas.xmlsoap.org/ws/2004/09/enumeration/Pull', resuri) +
        '<Body><Pull xmlns="http://schemas.xmlsoap.org/ws/2004/09/enumeration"><EnumerationContext>' +
        ctx +
        '</EnumerationContext></Pull></Body></Envelope>',
    )
    raw.push(pullResp)
    const body = bodyOf(pullResp)
    if (body.includes(':Fault')) return { items, raw, fault: 'pull fault' }
    const itemBlock = body.match(/<g:Items>([\s\S]*?)<\/g:Items>/)?.[1]
    if (itemBlock) for (const m of itemBlock.matchAll(/<h:[A-Za-z0-9_]+>[\s\S]*?<\/h:[A-Za-z0-9_]+>/g)) items.push(m[0])
    // Legacy semantics: AMT ends the sequence by dropping the EnumerationContext.
    if (!/<g:EnumerationContext>/.test(body)) break
  }
  return { items, raw }
}

async function invoke(resuri: string, method: string, args: string[] = []): Promise<string> {
  const argsXml = args
    .map((a) => {
      const eq = a.indexOf('=')
      const k = a.slice(0, eq)
      return `<r:${k}>${a.slice(eq + 1)}</r:${k}>`
    })
    .join('')
  return post(
    `${ENVELOPE_OPEN}<Header><a:Action>${resuri}/${method}</a:Action><a:To>/wsman</a:To>` +
      `<w:ResourceURI>${resuri}</w:ResourceURI><a:MessageID>${msgId++}</a:MessageID>${ANON}` +
      `<w:OperationTimeout>PT60S</w:OperationTimeout></Header>` +
      `<Body><r:${method}_INPUT xmlns:r="${resuri}">${argsXml}</r:${method}_INPUT></Body></Envelope>`,
  )
}

const CLASSES: [name: string, resuri: string][] = [
  ['CIM_SoftwareIdentity', CIM + 'CIM_SoftwareIdentity'],
  ['AMT_SetupAndConfigurationService', AMT + 'AMT_SetupAndConfigurationService'],
  ['CIM_ComputerSystemPackage', CIM + 'CIM_ComputerSystemPackage'],
  ['CIM_Chassis', CIM + 'CIM_Chassis'],
  ['CIM_Card', CIM + 'CIM_Card'],
  ['CIM_BIOSElement', CIM + 'CIM_BIOSElement'],
  ['CIM_Processor', CIM + 'CIM_Processor'],
  ['CIM_PhysicalMemory', CIM + 'CIM_PhysicalMemory'],
  ['CIM_MediaAccessDevice', CIM + 'CIM_MediaAccessDevice'],
  ['CIM_PhysicalPackage', CIM + 'CIM_PhysicalPackage'],
  ['CIM_Battery', CIM + 'CIM_Battery'],
  ['CIM_Chip', CIM + 'CIM_Chip'],
  ['CIM_SystemPackaging', CIM + 'CIM_SystemPackaging'],
  ['AMT_MessageLog', AMT + 'AMT_MessageLog'],
  ['AMT_AuditLog', AMT + 'AMT_AuditLog'],
  ['AMT_AuthorizationService', AMT + 'AMT_AuthorizationService'],
  ['AMT_NetworkPortPolicyConfiguration', AMT + 'AMT_NetworkPortPolicyConfiguration'],
  ['AMT_WiFiPortConfigurationService', AMT + 'AMT_WiFiPortConfigurationService'],
  ['AMT_SystemDefensePolicy', AMT + 'AMT_SystemDefensePolicy'],
  ['AMT_RemoteAccessService', AMT + 'AMT_RemoteAccessService'],
  ['AMT_EnvironmentDetectionSettingData', AMT + 'AMT_EnvironmentDetectionSettingData'],
  ['AMT_AgentPresenceWatchdog', AMT + 'AMT_AgentPresenceWatchdog'],
  ['AMT_AgentPresenceWatchdogAction', AMT + 'AMT_AgentPresenceWatchdogAction'],
  ['AMT_AgentPresenceWatchdogVA', AMT + 'AMT_AgentPresenceWatchdogVA'],
  ['IPS_AlarmClockOccurrence', IPS + 'IPS_AlarmClockOccurrence'],
  ['AMT_EventSubscriptionService', AMT + 'AMT_EventSubscriptionService'],
  ['AMT_EventFilter', AMT + 'AMT_EventFilter'],
  ['AMT_GeneralSettings', AMT + 'AMT_GeneralSettings'],
  ['CIM_ServiceAvailableToElement', CIM + 'CIM_ServiceAvailableToElement'],
]

const seed: Record<string, unknown> = {}

mkdirSync(outDir, { recursive: true })

for (const [name, resuri] of CLASSES) {
  const { items, raw, fault } = await enumerateClass(resuri)
  if (fault && items.length === 0) {
    console.log(`${name.padEnd(40)} SKIP (${fault})`)
    continue
  }
  seed[name] = { resuri, items }
  writeFileSync(`${outDir}/${name}.xml`, raw.join('\n'))
  console.log(`${name.padEnd(40)} ${String(items.length).padStart(4)} instances`)
}

// Singletons read with a GET need their InstanceID selector; capture those too.
const GETS: [name: string, resuri: string, id: string][] = [
  ['CIM_SoftwareIdentity', CIM + 'CIM_SoftwareIdentity', 'AMT FW Core Version'],
]

for (const [name, resuri, id] of GETS) {
  const resp = await post(
    `${ENVELOPE_OPEN}<Header><a:Action>http://schemas.xmlsoap.org/ws/2004/09/transfer/Get</a:Action>` +
      `<a:To>/wsman</a:To><w:ResourceURI>${resuri}</w:ResourceURI><a:MessageID>${msgId++}</a:MessageID>${ANON}` +
      `<w:OperationTimeout>PT60S</w:OperationTimeout>` +
      `<w:SelectorSet><w:Selector Name="InstanceID">${id}</w:Selector></w:SelectorSet></Header><Body /></Envelope>`,
  )
  console.log(`GET ${name} (${id}) -> ${bodyOf(resp).slice(0, 120)}`)
}

// A few method calls the firmware tiers rely on.
const INVOKES: [name: string, resuri: string, method: string, args: string[]][] = [
  ['GetUuid', AMT + 'AMT_SetupAndConfigurationService', 'GetUuid', []],
  [
    'GetLowAccuracyTimeSynch',
    AMT + 'AMT_TimeSynchronizationService',
    'GetLowAccuracyTimeSynch',
    [],
  ],
  ['GetAdminAclEntry', AMT + 'AMT_AuthorizationService', 'GetAdminAclEntry', []],
  ['GetUserAclEntryEx', AMT + 'AMT_AuthorizationService', 'GetUserAclEntryEx', ['Handle=0']],
]

const invokes: Record<string, string> = {}
for (const [name, resuri, method, args] of INVOKES) {
  const resp = await invoke(resuri, method, args)
  invokes[name] = bodyOf(resp)
  console.log(`INVOKE ${name.padEnd(28)} -> ${bodyOf(resp).slice(0, 160)}`)
}

seed['__invokes'] = invokes
writeFileSync(`${outDir}/seed.json`, JSON.stringify(seed, null, 1))
console.log(`\nWrote ${outDir}/seed.json (${Object.keys(seed).length} entries)`)