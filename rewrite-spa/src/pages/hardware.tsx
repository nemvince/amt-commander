/**
 * Hardware Information (`#/hardware`), legacy view 2 -- index.html:8041-8142.
 *
 * The legacy panel pulls every hardware class in one BatchEnum and renders one
 * block per component. device state's `hw` signal carries the same batch, but
 * only the GET-fetched singletons survive it (BatchEnum reports enumerated
 * classes as `null` in `response`), so the page runs the batch itself and keeps
 * every instance of every class.
 */
import { useSignal } from '@preact/signals'
import { items, num, text } from '../lib/wsm'
import { Details, type Field } from '../ui/details'
import { useEffect } from 'preact/hooks'
import type { WsmanNode } from '../lib/wsman'
import { getStack, pending } from '../state/device'
import { S } from '../strings'
import { RefreshIcon } from '../ui/icons'
import { Table, type Column } from '../ui/table'

/** Legacy class list, verbatim from index.html:8047. */
const HW_CLASSES = [
  '*CIM_ComputerSystemPackage',
  'CIM_SystemPackaging',
  '*CIM_Chassis',
  'CIM_Chip',
  '*CIM_Card',
  '*CIM_BIOSElement',
  'CIM_Processor',
  'CIM_PhysicalMemory',
  'CIM_MediaAccessDevice',
  'CIM_PhysicalPackage',
  'CIM_Battery',
]

/** DSP0134 2.7.1 enumerations, verbatim from index.html:8052-8064. */
const CPU_STATUS = ['Unknown', 'Enabled', 'Disabled by User', 'Disabled By BIOS (POST Error)', 'Idle', 'Other']

const MEM_TYPE =
  'Unknown|Other|DRAM|Synchronous DRAM|Cache DRAM|EDO|EDRAM|VRAM|SRAM|RAM|ROM|Flash|EEPROM|FEPROM|EPROM|CDRAM|3DRAM|SDRAM|SGRAM|RDRAM|DDR|DDR-2|BRAM|FB-DIMM|DDR3|FBD2|DDR4|LPDDR|LPDDR2|LPDDR3|LPDDR4'.split(
    '|'
  )

const MEM_FORM_FACTOR =
  ['', 'Other', 'Unknown', 'SIMM', 'SIP', 'Chip', 'DIP', 'ZIP', 'Proprietary Card', 'DIMM', 'TSOP', 'Row of chips', 'RIMM', 'SODIMM', 'SRIMM', 'FB-DIM']

const PROC_FAMILY: Record<string, string> = {
  '191': 'Intel Core 2 Duo Processor',
  '192': 'Intel Core 2 Solo processor',
  '193': 'Intel Core 2 Extreme processor',
  '194': 'Intel Core 2 Quad processor',
  '195': 'Intel Core 2 Extreme mobile processor',
  '196': 'Intel Core 2 Duo mobile processor',
  '197': 'Intel Core 2 Solo mobile processor',
  '198': 'Intel Core i7 processor',
  '199': 'Dual-Core Intel Celeron processor'
}

const BATTERY_CHEMISTRY =
  'Other|Unknown|Lead Acid|Nickel Cadmium|Nickel Metal Hydride|Lithium-ion|Zinc air|Lithium Polymer'.split('|')

type Inventory = Record<string, WsmanNode[]>
/** One definition row: the label and the value the device reported. */

/**
 * Every instance arrives wrapped in its class element, both in the GetResponse
 * body and per item of an enumeration (amt-0.2.0.js:94 flattens the same wrapper).
 */

/** A GET-fetched class reports its instance in `response`, an enumerated one its
 * item array in `responses`, which the stack passes through untyped. */

/** Scalar property as trimmed text; nested nodes and absent keys read as empty. */


/** `Intel(R) Corporation` -> `Intel® Corporation`, without going through HTML. */
function trademarks(value: string): string {
  return value.replace(/\(R\)/g, '®').replace(/\(TM\)/g, '™')
}

/** index.html:14032. AMT hands back a byte-reversed, dashless GUID. */
function guidToStr(guid: string): string {
  if (guid.length < 32) return guid
  return (
    guid.slice(6, 8) +
    guid.slice(4, 6) +
    guid.slice(2, 4) +
    guid.slice(0, 2) +
    '-' +
    guid.slice(10, 12) +
    guid.slice(8, 10) +
    '-' +
    guid.slice(14, 16) +
    guid.slice(12, 14) +
    '-' +
    guid.slice(16, 20) +
    '-' +
    guid.slice(20)
  )
}

function utcDate(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString('en-US', { timeZone: 'UTC' })
}


export function HardwarePage() {
  const inventory = useSignal<Inventory>({})

  const refresh = () => {
    const stack = getStack()
    if (stack == null) return
    stack.BatchEnum('', HW_CLASSES, (_s, _name, results) => {
      const next: Inventory = {}
      for (const cls of Object.keys(results)) next[cls] = items(results[cls])
      inventory.value = next
    })
  }

  useEffect(() => {
    refresh()
  }, [])

  const hw = inventory.value
  const at = (cls: string, index = 0) => hw[cls]?.[index]
  const all = (cls: string) => hw[cls] ?? []

  const chassis = at('CIM_Chassis')
  const card = at('CIM_Card')
  const bios = at('CIM_BIOSElement')
  const packaging = at('CIM_SystemPackaging')
  const chips = all('CIM_Chip')
  const processors = all('CIM_Processor')
  const modules = all('CIM_PhysicalMemory')
  const media = all('CIM_MediaAccessDevice')
  const packages = all('CIM_PhysicalPackage')
  const battery = at('CIM_Battery')

  const platform: Field[] = [
    [S.computerModel, text(chassis, 'Model')],
    [S.manufacturer, text(chassis, 'Manufacturer')],
    [S.version, text(chassis, 'Version')],
    [S.serialNumber, text(chassis, 'SerialNumber')],
    [S.systemId, guidToStr(text(packaging, 'PlatformGUID')).toLowerCase()]
  ]

  const baseboard: Field[] = [
    [S.manufacturer, text(card, 'Manufacturer')],
    [S.productName, text(card, 'Model')],
    [S.version, text(card, 'Version')],
    [S.serialNumber, text(card, 'SerialNumber')],
    [S.assetTag, text(card, 'Tag')],
    [S.replaceable, card?.['CanBeFRUed'] === true ? S.yes : S.no]
  ]

  const biosFields: Field[] = [
    [S.biosVendor, text(bios, 'Manufacturer')],
    [S.version, text(bios, 'SoftwareElementID')],
    [S.releaseDate, utcDate(text((bios?.['ReleaseDate'] as WsmanNode) ?? {}, 'Datetime'))]
  ]

  type ProcessorRow = { label: string; chip: WsmanNode; cpu: WsmanNode }
  const processorColumns: Column[] = [
    { label: S.processor, cell: (r: ProcessorRow) => r.label },
    { label: S.manufacturer, cell: (r: ProcessorRow) => trademarks(text(r.chip, 'Manufacturer')) },
    { label: S.family, cell: (r: ProcessorRow) => PROC_FAMILY[String(r.cpu['Family'])] ?? text(r.cpu, 'Family') },
    { label: S.version, cell: (r: ProcessorRow) => trademarks(text(r.chip, 'Version')) },
    { label: S.maxSocketSpeed, cell: (r: ProcessorRow) => text(r.cpu, 'MaxClockSpeed') + ' MHz', numeric: true },
    { label: S.status, cell: (r: ProcessorRow) => CPU_STATUS[Number(r.cpu['CPUStatus'])] ?? S.unknown }
  ]
  const processorRows: ProcessorRow[] = processors.map((cpu, index) => ({
    // Legacy pairs by position: the leading CIM_Chip entries are the processors.
    label: S.processor + ' ' + (index + 1),
    chip: chips[index] ?? {},
    cpu
  }))

  type MemoryRow = { label: string; node: WsmanNode }
  const memoryColumns: Column[] = [
    { label: S.memory, cell: (r: MemoryRow) => r.label },
    { label: S.bankLabel, cell: (r: MemoryRow) => text(r.node, 'BankLabel') },
    { label: S.manufacturer, cell: (r: MemoryRow) => text(r.node, 'Manufacturer') },
    { label: S.partNumber, cell: (r: MemoryRow) => text(r.node, 'PartNumber') },
    { label: S.serialNumber, cell: (r: MemoryRow) => text(r.node, 'SerialNumber') },
    {
      label: S.capacity,
      cell: (r: MemoryRow) => Math.trunc(num(r.node, 'Capacity') / 0x100000) + ' MB',
      numeric: true
    },
    { label: S.formFactor, cell: (r: MemoryRow) => MEM_FORM_FACTOR[Number(r.node['FormFactor'])] ?? S.unknown },
    { label: S.type, cell: (r: MemoryRow) => MEM_TYPE[Number(r.node['MemoryType'])] ?? S.unknown }
  ]
  const memoryRows: MemoryRow[] = modules.map((node, index) => ({
    label: S.memoryModule + ' ' + (index + 1),
    node
  }))

  type StorageRow = { label: string; device: WsmanNode; pack: WsmanNode }
  const storageColumns: Column[] = [
    { label: S.storageDevices, cell: (r: StorageRow) => r.label },
    { label: S.model, cell: (r: StorageRow) => text(r.pack, 'Model') },
    {
      label: S.serialNumber,
      cell: (r: StorageRow) => text(r.pack, 'SerialNumber') || S.unknown
    },
    {
      label: S.capacity,
      // MaxMediaSize is in kilobytes; the legacy factor of 1000/0x100000 overstated
      // every disk by ~5%, so this converts KB -> MB the straightforward way.
      cell: (r: StorageRow) => Math.round(num(r.device, 'MaxMediaSize') / 1024) + ' MB',
      numeric: true
    }
  ]
  const storageRows: StorageRow[] = media.map((device, index) => ({
    label: S.storageMedia + ' ' + (index + 1),
    device,
    // PhysicalPackage mirrors MediaAccessDevice offset by one: entry 0 is the card.
    pack: packages[index + 1] ?? {}
  }))

  // Everything AMT reported, so the cards, chips and packages the panels above do
  // not surface individually are still visible (legacy index.html:8142).
  type PartRow = { key: string; cls: string; node: WsmanNode }
  const partColumns: Column[] = [
    { label: S.class, cell: (r: PartRow) => r.cls },
    { label: S.elementName, cell: (r: PartRow) => text(r.node, 'ElementName') || text(r.node, 'Name') },
    { label: S.model, cell: (r: PartRow) => text(r.node, 'Model') },
    { label: S.manufacturer, cell: (r: PartRow) => text(r.node, 'Manufacturer') },
    { label: S.serialNumber, cell: (r: PartRow) => text(r.node, 'SerialNumber') },
    { label: S.assetTag, cell: (r: PartRow) => text(r.node, 'Tag') }
  ]
  const partRows: PartRow[] = Object.keys(hw).flatMap((cls) =>
    hw[cls].map((node, index) => ({ key: cls + '/' + index, cls: cls.replace(/^\*/, ''), node }))
  )

  const batteryFields: Field[] = []
  if (battery != null) {
    // The manufacture data lives on the package whose PackageType is 11 (Battery).
    const pack = packages.find((node) => Number(node['PackageType']) === 11)
    if (pack != null) {
      batteryFields.push(
        [S.deviceName, text(battery, 'DeviceID')],
        [S.manufacturer, text(pack, 'Manufacturer')],
        [S.manufactureDate, utcDate(text((pack['ManufactureDate'] as WsmanNode) ?? {}, 'Datetime'))],
        [S.serialNumber, text(pack, 'SerialNumber')],
        [S.type, BATTERY_CHEMISTRY[Number(battery['Chemistry'])] ?? S.unknown],
        [S.designCapacity, text(battery, 'DesignCapacity') + ' mWatt-hours'],
        [S.designVoltage, text(battery, 'DesignVoltage') + ' mVolts']
      )
      if (text(pack, 'OtherIdentifyingInfo') !== '') {
        batteryFields.push([S.otherInfo, text(pack, 'OtherIdentifyingInfo')])
      }
    }
  }

  return (
    <div class="page">
      <div class="page-header">
        <button type="button" class="btn" onClick={refresh}>
          <RefreshIcon />
          {S.refresh}
        </button>
      </div>

      <Details loading={pending.value > 0} title={S.platform} fields={platform} />
      <Details loading={pending.value > 0} title={S.baseboard} fields={baseboard} />
      <Details loading={pending.value > 0} title={S.bios} fields={biosFields} />

      <Table loading={pending.value > 0}
        title={S.processor}
        columns={processorColumns}
        rows={processorRows}
        keyOf={(r) => r.label}
        empty={S.noData}
      />
      <Table loading={pending.value > 0} title={S.memory} columns={memoryColumns} rows={memoryRows} keyOf={(r) => r.label} empty={S.noData} />
      <Table loading={pending.value > 0}
        title={S.storageDevices}
        columns={storageColumns}
        rows={storageRows}
        keyOf={(r) => r.label}
        empty={S.noData}
      />

      {batteryFields.length > 0 && <Details loading={pending.value > 0} title={S.battery} fields={batteryFields} />}

      <Table loading={pending.value > 0}
        title={S.allComponents}
        columns={partColumns}
        rows={partRows}
        keyOf={(r) => r.key}
        empty={S.noData}
        footer={<p class="table-note">{S.hardwareNote}</p>}
      />
    </div>
  )
}
