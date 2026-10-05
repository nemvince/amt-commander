/**
 * IDE Redirection (IDER) client.
 *
 * Ported from amt-ider-ws-0.0.1.js; the firmware wiring (start dialog, status bar,
 * disk map, 500ms stats poll) comes from index.html:9588-9853 and index.html:820-838.
 * Drives createRedirect() with protocol 3 (IDER selector).
 *
 * There are no top-level side effects here: every device constant below is plain
 * data and the transport is only created when createIder() is called, so a tier
 * that never mounts a disk image never opens a websocket.
 */
import { signal, type Signal } from '@preact/signals'
import { FEAT_IDERStats } from '../features'
import { createRedirect, type RedirectModule } from './redirect'

/** Virtual device slot. */
export type IderDevice = 'floppy' | 'cdrom'

/** When the target should attach the redirected media. */
export type IderStartMode = 0 | 1 | 2

export type IderStatus = 'idle' | 'connecting' | 'live'

export type IderInfo = {
  major: number
  minor: number
  fwmajor: number
  fwminor: number
  readbfr: number
  writebfr: number
  proto: number
  iana: number
}

export type IderMedium = { name: string; size: number }

/**
 * Per-device sector heat map. `map` is mutated in place as the guest reads, so
 * consumers redraw off IderView.tick rather than off the identity of `heat`.
 */
export type IderHeatMap = {
  device: IderDevice
  /** Bytes covered by one block on the canvas (512 / 2048, times a power of two). */
  blockBytes: number
  blocks: number
  map: Uint8Array
}

export type IderView = {
  status: IderStatus
  /** Target has accepted the IDER feature toggle. */
  enabled: boolean
  bytesFromAmt: number
  bytesToAmt: number
  info: IderInfo | null
  floppy: IderMedium | null
  cdrom: IderMedium | null
  /** Per-device read heat maps; always empty when IDERStats is off. */
  heat: IderHeatMap[]
  /** Bumped on every stats refresh (500ms while live, plus on state changes). */
  tick: number
}

export type IderStartOptions = {
  floppy?: File | null
  cdrom?: File | null
  mode: IderStartMode
}

/** Everything a page needs to drive an IDER session. */
export type IderEngine = {
  /** Live snapshot. Reading `.value` inside a component subscribes it. */
  view: Signal<IderView>
  /** Tear down any session, mount the given media and connect the transport. */
  start: (options: IderStartOptions) => void
  /** Drop the medium mounted in a slot without dropping the session. */
  eject: (device: IderDevice) => void
  stop: () => void
}

const DEV_FLOPPY = 0xa0
const DEV_CD = 0xb0

/** CommandID + attributes + little-endian sequence number. */
const HEADER = 8
/** Frame opcodes that reach us with that header intact. */
const OP_CODES: Record<number, true> = {
  0x41: true,
  0x43: true,
  0x44: true,
  0x45: true,
  0x46: true,
  0x49: true,
  0x4a: true,
  0x4b: true,
  0x50: true,
  0x53: true,
}

const RX_TIMEOUT = 30000
const TX_TIMEOUT = 0
const HEARTBEAT = 20000
const VERSION = 1

/** Keep the map under this many blocks so a redraw stays cheap. */
const MAX_HEAT_BLOCKS = 8000
/** The largest block count the target is allowed to advertise (amt-ider-ws-0.0.1.js:209). */
const MAX_BUFFER = 8192

// Byte helpers. IDER frames are little-endian; SCSI payload is big-endian.
const readShortLE = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8)
const readIntLE = (b: Uint8Array, p: number) =>
  (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0
const readShortBE = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1]
const readIntBE = (b: Uint8Array, p: number) =>
  ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0
const intBE = (v: number) =>
  new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff])
const intLE = (v: number) =>
  new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff])
const shortLE = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff])

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

// Mode sense / configuration blobs, verbatim from amt-ider-ws-0.0.1.js:40-69.
const MODE_SENSE_LS120_DISK_PAGE = new Uint8Array([
  0, 38, 49, 128, 0, 0, 0, 0, 5, 30, 16, 169, 8, 32, 2, 0, 3, 195, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 0, 0, 0, 0, 0, 0,
  0, 2, 208, 0, 0,
])
const MODE_SENSE_3F_LS120 = new Uint8Array([
  0, 92, 36, 128, 0, 0, 0, 0, 1, 10,
  0, 1, 0, 0, 0, 0, 2, 0, 0, 0,
  3, 22, 0, 160, 0, 0, 0, 0, 0, 18,
  2, 0, 0, 0, 0, 0, 0, 0, 160, 0,
  0, 0, 5, 30, 16, 169, 8, 32, 2, 0,
  3, 195, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 40, 0, 0, 0, 0, 0, 0, 0,
  2, 208, 0, 0, 8, 10, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 11, 6, 0, 0,
  0, 17, 36, 49,
])
const MODE_SENSE_FLOPPY_DISK_PAGE = new Uint8Array([
  0, 38, 36, 128, 0, 0, 0, 0, 5, 30,
  4, 176, 2, 18, 2, 0, 0, 80, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 40, 0,
  0, 0, 0, 0, 0, 0, 2, 208, 0, 0,
])
const MODE_SENSE_3F_FLOPPY = new Uint8Array([
  0, 92, 36, 128, 0, 0, 0, 0, 1, 10,
  0, 1, 0, 0, 0, 0, 2, 0, 0, 0,
  3, 22, 0, 160, 0, 0, 0, 0, 0, 18,
  2, 0, 0, 0, 0, 0, 0, 0, 160, 0,
  0, 0, 5, 30, 4, 176, 2, 18, 2, 0,
  0, 80, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 40, 0, 0, 0, 0, 0, 0, 0,
  2, 208, 0, 0, 8, 10, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 11, 6, 0, 0,
  0, 17, 36, 49,
])
const MODE_SENSE_CD_1A = new Uint8Array([
  0, 18, 1, 128, 0, 0, 0, 0, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
])
const MODE_SENSE_CD_1D = new Uint8Array([
  0, 18, 1, 128, 0, 0, 0, 0, 29, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
])
const MODE_SENSE_CD_2A = new Uint8Array([
  0, 32, 1, 128, 0, 0, 0, 0, 42, 24, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
])
const MODE_SENSE_3F_CD = new Uint8Array([
  0, 40, 1, 128, 0, 0, 0, 0, 1, 6,
  0, 255, 0, 0, 0, 0, 42, 24, 0, 0,
  0, 0, 2, 0, 0, 0, 0, 0, 0, 128,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0,
])
const MODE_SENSE_FLOPPY_ERROR = new Uint8Array([
  0, 18, 36, 128, 0, 0, 0, 0, 1, 10, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0,
])
const MODE_SENSE_LS120_ERROR = new Uint8Array([
  0, 18, 49, 128, 0, 0, 0, 0, 1, 10, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0,
])
const MODE_SENSE_CD_ERROR = new Uint8Array([
  0, 14, 1, 128, 0, 0, 0, 0, 1, 6, 0, 255, 0, 0, 0, 0,
])

const CD_PROFILE_LIST = new Uint8Array([0, 0, 3, 4, 0, 8, 1, 0])
const CD_CORE = new Uint8Array([0, 1, 3, 4, 0, 0, 0, 2])
const CD_MORPHING = new Uint8Array([0, 2, 3, 4, 0, 0, 0, 0])
const CD_REMOVABLE = new Uint8Array([0, 3, 3, 4, 41, 0, 0, 2])
const CD_RANDOM = new Uint8Array([0, 16, 1, 8, 0, 0, 8, 0, 0, 1, 0, 0])
const CD_READ = new Uint8Array([0, 30, 3, 0])
const CD_POWER_MANAGEMENT = new Uint8Array([1, 0, 3, 0])
const CD_TIMEOUT = new Uint8Array([1, 5, 3, 0])

// RD_CD_DiskInfo is deliberately absent: the legacy switch carried two
// `case 0x51` branches and the first one always won, so its only reader was
// unreachable dead code.
const RD_CD_PERFORMANCE = new Uint8Array([0, 0, 0, 4, 2, 0, 0, 0])

const EMPTY_LENGTH = cat(intBE(0x3c), intBE(0x08))

/** Creates an IDER session. Nothing happens on the wire until start() is called. */
export const createIder = (): IderEngine => {
  let acc = new Uint8Array(0)
  let inSequence = 0
  let outSequence = 0
  let bytesToAmt = 0
  let bytesFromAmt = 0
  let iderinfo: IderInfo | null = null
  let readBufferSize = 512
  let enabled = false
  let live = false
  let floppyFile: File | null = null
  let cdromFile: File | null = null
  let floppyReady = false
  let cdromReady = false
  let startMode: IderStartMode = 1
  let tick = 0
  let heatMaps: IderHeatMap[] = []
  let statsTimer: number | null = null

  // One disk read in flight; the rest queue up. Mirrors amt-ider-ws-0.0.1.js:678-704.
  let readFile: File | null = null
  let readDev = DEV_FLOPPY
  let readLba = 0
  let readLen = 0

  const readQueue: { file: File; dev: number; lba: number; len: number; feature: number }[] = []
  let resetQueued = false

  const view = signal<IderView>({
    status: 'idle',
    enabled: false,
    bytesFromAmt: 0,
    bytesToAmt: 0,
    info: null,
    floppy: null,
    cdrom: null,
    heat: [],
    tick: 0,
  })

  const sendCommand = (cmd: number, data?: Uint8Array, completed?: boolean, dma?: number) => {
    const attributes = (cmd > 50 && completed === true ? 2 : 0) + (dma ? 1 : 0)
    const frame = new Uint8Array(HEADER + (data?.length ?? 0))
    frame[0] = cmd
    frame[3] = attributes
    new DataView(frame.buffer).setUint32(4, outSequence++, true)
    if (data) frame.set(data, HEADER)
    channel.Send(frame)
    bytesToAmt += frame.length
  }

  // CommandEndResponse (SCSI_SENSE). `error` selects the 0xC5 hard-error reply
  // over the 0x87 sense-data reply (amt-ider-ws-0.0.1.js:154-157); only the
  // latter carries sense/asc/asq, and both branches are 23 bytes.
  const sendCommandEndResponse = (
    error: boolean,
    sense: number,
    device: number,
    asc: number,
    asq: number
  ) => {
    const head = error
      ? new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xc5, 0, 3, 0, 0, 0, device, 0x50, 0, 0, 0])
      : cat(
          new Uint8Array(12),
          new Uint8Array([0x87, (sense << 4) & 0xff, 3, 0, 0, 0, device, 0x51, sense, asc, asq])
        )
    sendCommand(0x51, head, true)
  }

  /** DataToHost (SCSI_READ) — the device-data message that carries disk bytes. */
  const sendDataToHost = (device: number, completed: boolean, data: Uint8Array, dma: number) => {
    const dmalen = dma ? 0 : data.length
    const head = new Uint8Array([
      0,
      data.length & 0xff,
      (data.length >> 8) & 0xff,
      0,
      dma ? 0xb4 : 0xb5,
      0,
      2,
      0,
      dmalen & 0xff,
      (dmalen >> 8) & 0xff,
      device,
      0x58,
    ])
    const tail = completed
      ? new Uint8Array([0x85, 0, 3, 0, 0, 0, device, 0x50, 0, 0, 0, 0, 0, 0])
      : new Uint8Array(14)
    sendCommand(0x54, cat(head, tail, data), completed, dma)
  }

  /** GetDataFromHost (SCSI_CHUNK) — asks the guest to hand us write data. */
  const sendGetDataFromHost = (device: number, chunksize: number) => {
    sendCommand(
      0x52,
      cat(
        new Uint8Array([
          0,
          chunksize & 0xff,
          (chunksize >> 8) & 0xff,
          0,
          0xb5,
          0,
          0,
          0,
          chunksize & 0xff,
          (chunksize >> 8) & 0xff,
          device,
          0x58,
        ]),
        new Uint8Array(12)
      ),
      false
    )
  }

  /** DisableEnableFeatures (REGS_TOGGLE); type 3 needs a 4 byte value. */
  const sendToggle = (value: number) => sendCommand(0x48, cat(new Uint8Array([3]), intLE(value)))

  const requestToggle = () => {
    if (startMode === 0) sendToggle(0x01 + 0x08)
    else if (startMode === 1) sendToggle(0x01 + 0x10)
    else sendToggle(0x01 + 0x18)
  }

  const refreshView = () => {
    tick++
    view.value = {
      status: channel.State === 0 ? 'idle' : live ? 'live' : 'connecting',
      enabled,
      bytesFromAmt,
      bytesToAmt,
      info: iderinfo,
      floppy: floppyFile ? { name: floppyFile.name, size: floppyFile.size } : null,
      cdrom: cdromFile ? { name: cdromFile.name, size: cdromFile.size } : null,
      heat: heatMaps,
      tick,
    }
  }

  /** Legacy iderSectorStats (index.html:9737). mode 0 mounts, mode 1 reads. */
  const sectorStats = (device: IderDevice, mode: number, total: number, start: number, len: number) => {
    if (mode === 0) {
      let divisor = 1
      while (total / divisor > MAX_HEAT_BLOCKS) divisor *= 2
      const blockBytes = (device === 'floppy' ? 512 : 2048) * divisor
      if (total === 0) {
        heatMaps = heatMaps.filter((m) => m.device !== device)
        return
      }
      const map = {
        device,
        blockBytes,
        blocks: Math.ceil(total / divisor),
        map: new Uint8Array(Math.ceil(total / divisor)),
      }
      heatMaps = [...heatMaps.filter((m) => m.device !== device), map]
      return
    }
    const map = heatMaps.find((m) => m.device === device)
    if (!map) return
    const divisor = map.blockBytes / (device === 'floppy' ? 512 : 2048)
    for (let i = start / divisor; i < (start + len) / divisor; i++) map.map[i] = 1
  }

  const pumpReads = async (feature: number) => {
    let fr = feature
    while (readFile != null) {
      const chunk = Math.min(readLen, readBufferSize)
      const start = readLba
      readLen -= chunk
      readLba += chunk
      const buf = new Uint8Array(await readFile.slice(start, start + chunk).arrayBuffer())
      sendDataToHost(readDev, readLen === 0, buf, fr & 1)
      if (readLen > 0 && !resetQueued) continue
      readFile = null
      if (resetQueued) {
        sendCommand(0x47)
        readQueue.length = 0
        resetQueued = false
        break
      }
      const next = readQueue.shift()
      if (!next) break
      readFile = next.file
      readDev = next.dev
      readLba = next.lba
      readLen = next.len
      fr = next.feature
    }
  }

  const sendDiskData = (dev: number, lba: number, len: number, featureRegister: number) => {
    let media: File | null = null
    let mediaBlocks = 0
    if (dev === DEV_FLOPPY && floppyFile != null) {
      media = floppyFile
      mediaBlocks = floppyFile.size >> 9
    }
    if (dev === DEV_CD && cdromFile != null) {
      media = cdromFile
      mediaBlocks = cdromFile.size >> 11
    }
    if (len < 0 || lba + len > mediaBlocks) {
      sendCommandEndResponse(true, 0x05, dev, 0x21, 0x00)
      return
    }
    if (len === 0) {
      sendCommandEndResponse(true, 0x00, dev, 0x00, 0x00)
      return
    }
    if (media == null) return
    if (FEAT_IDERStats) sectorStats(dev === DEV_FLOPPY ? 'floppy' : 'cdrom', 1, mediaBlocks, lba, len)
    const byteLba = dev === DEV_FLOPPY ? lba << 9 : lba << 11
    const byteLen = dev === DEV_FLOPPY ? len << 9 : len << 11
    if (readFile != null) {
      readQueue.push({ file: media, dev, lba: byteLba, len: byteLen, feature: featureRegister })
      return
    }
    readFile = media
    readDev = dev
    readLba = byteLba
    readLen = byteLen

    void pumpReads(featureRegister)
  }

  const handleScsi = (dev: number, cdb: Uint8Array, featureRegister: number, deviceFlags: number) => {
    const dma = featureRegister & 1
    switch (cdb[0]) {
      case 0x00: // TEST_UNIT_READY
        if (dev === DEV_FLOPPY) {
          if (floppyFile == null) {
            sendCommandEndResponse(true, 0x02, dev, 0x3a, 0x00)
            return
          }
          if (!floppyReady) {
            floppyReady = true
            sendCommandEndResponse(true, 0x06, dev, 0x28, 0x00)
            return
          }
        } else {
          if (cdromFile == null) {
            sendCommandEndResponse(true, 0x02, dev, 0x3a, 0x00)
            return
          }
          if (!cdromReady) {
            cdromReady = true
            sendCommandEndResponse(true, 0x06, dev, 0x28, 0x00)
            return
          }
        }
        sendCommandEndResponse(true, 0x00, dev, 0x00, 0x00)
        break

      case 0x08: // READ_6
      case 0x28: // READ_10
        sendDiskData(
          dev,
          cdb[0] === 0x08
            ? ((cdb[1] & 0x1f) << 16) + (cdb[2] << 8) + cdb[3]
            : readIntBE(cdb, 2),
          cdb[0] === 0x08 ? (cdb[4] === 0 ? 256 : cdb[4]) : readShortBE(cdb, 7),
          featureRegister
        )
        break

      case 0x0a: // WRITE_6 — not supported, the target has no medium to write.
        sendCommandEndResponse(true, 0x02, dev, 0x3a, 0x00)
        break

      case 0x1a: // MODE_SENSE_6
        if (cdb[2] === 0x3f && cdb[3] === 0x00) {
          const writeProtect = 0x80
          if (dev === DEV_FLOPPY && floppyFile != null) {
            sendDataToHost(dev, true, new Uint8Array([0, 0x00, writeProtect, 0]), dma)
            return
          }
          if (dev === DEV_CD && cdromFile != null) {
            sendDataToHost(dev, true, new Uint8Array([0, 0x05, writeProtect, 0]), dma)
            return
          }
        }
        sendCommandEndResponse(true, 0x05, dev, 0x24, 0x00)
        break

      case 0x1b: // START_STOP, sent when the target ejects the CD
        sendCommandEndResponse(true, 0, dev, 0, 0)
        break

      case 0x1e: // LOCK_UNLOCK / ALLOW_MEDIUM_REMOVAL
        if ((dev === DEV_FLOPPY && floppyFile == null) || (dev === DEV_CD && cdromFile == null)) {
          sendCommandEndResponse(true, 0x02, dev, 0x3a, 0x00)
          return
        }
        sendCommandEndResponse(true, 0x00, dev, 0x00, 0x00)
        break

      case 0x23: // READ_FORMAT_CAPACITIES (floppy only)
        if (
          (dev === DEV_FLOPPY && (floppyFile == null || floppyFile.size === 0)) ||
          (dev === DEV_CD && (cdromFile == null || cdromFile.size === 0))
        ) {
          sendCommandEndResponse(false, 0x05, dev, 0x24, 0x00)
          return
        }
        sendDataToHost(
          dev,
          true,
          cat(intBE(8), new Uint8Array([0, 0, 0x0b, 0x40, 0x02, 0, 0x02, 0])),
          dma
        )
        break

      case 0x25: { // READ_CAPACITY
        const file = dev === DEV_FLOPPY ? floppyFile : cdromFile
        if (file == null || file.size === 0) {
          sendCommandEndResponse(true, 0x02, dev, 0x3a, 0x00)
          return
        }
        const blocks = dev === DEV_FLOPPY ? file.size >> 9 : file.size >> 11
        sendDataToHost(
          deviceFlags,
          true,
          cat(intBE(blocks - 1), new Uint8Array([0, 0, dev === DEV_CD ? 0x08 : 0x02, 0])),
          dma
        )
        break
      }

      case 0x2a: // WRITE_10 (floppy only)
      case 0x2e: // WRITE_AND_VERIFY (floppy only)
        sendGetDataFromHost(dev, 512 * readShortBE(cdb, 7))
        break

      case 0x43: { // READ_TOC, CD audio only
        if (dev === DEV_FLOPPY) {
          sendCommandEndResponse(true, 0x05, dev, 0x20, 0x00)
          return
        }
        const msf = cdb[1] & 0x02
        const format = (cdb[2] & 0x07) === 0 ? cdb[9] >> 6 : cdb[2] & 0x07
        if (format === 1) {
          sendDataToHost(
            dev,
            true,
            new Uint8Array([0, 0x0a, 1, 1, 0, 0x14, 1, 0, 0, 0, 0, 0]),
            dma
          )
        } else if (msf) {
          sendDataToHost(
            dev,
            true,
            new Uint8Array([
              0, 0x12, 1, 1, 0, 0x14, 1, 0, 0, 0, 2, 0, 0, 0x14, 0xaa, 0, 0, 0, 0x34, 0x13,
            ]),
            dma
          )
        } else {
          sendDataToHost(
            dev,
            true,
            new Uint8Array([
              0, 0x12, 1, 1, 0, 0x14, 1, 0, 0, 0, 0, 0, 0, 0x14, 0xaa, 0, 0, 0, 0, 0,
            ]),
            dma
          )
        }
        break
      }

      case 0x46: { // GET_CONFIGURATION
        const buflen = readShortBE(cdb, 7)
        if (buflen === 0) {
          sendDataToHost(dev, true, EMPTY_LENGTH, dma)
          return
        }
        const sendAll = cdb[1] !== 2
        const firstcode = readShortBE(cdb, 2)
        const feature = (code: number, data: Uint8Array) => {
          if (firstcode === code || (sendAll && firstcode < code)) return data
          return new Uint8Array(0)
        }
        const body = cat(
          intBE(8),
          feature(0x0000, CD_PROFILE_LIST),
          feature(0x0001, CD_CORE),
          feature(0x0002, CD_MORPHING),
          feature(0x0003, CD_REMOVABLE),
          feature(0x0010, CD_RANDOM),
          feature(0x001e, CD_READ),
          feature(0x0100, CD_POWER_MANAGEMENT),
          feature(0x0105, CD_TIMEOUT)
        )
        sendDataToHost(dev, true, cat(intBE(body.length), body).subarray(0, buflen), dma)
        break
      }

      case 0x4a: // GET_EVENT_STATUS_NOTIFICATION
        if (cdb[1] !== 0x01 && cdb[4] !== 0x10) {
          sendCommandEndResponse(true, 0x05, dev, 0x26, 0x01)
          break
        }
        const present = (dev === DEV_FLOPPY && floppyFile != null) || (dev === DEV_CD && cdromFile != null)
        sendDataToHost(dev, true, new Uint8Array([0, present ? 0x02 : 0x00, 0x80, 0x00]), dma)
        break

      case 0x4c:
        sendCommand(
          0x51,
          cat(
            new Uint8Array(12),
            new Uint8Array([0x87, 0x50, 0x03, 0, 0, 0, 0xb0, 0x51, 0x05, 0x20, 0])
          ),
          true
        )
        break

      // The legacy switch carried a second, unreachable `case 0x51` for
      // READ_DISK_INFORMATION; the first case wins there, so it wins here too.
      case 0x51: // READ_DISC_INFO
        sendCommandEndResponse(false, 0x05, dev, 0x20, 0x00)
        break

      case 0x55: // MODE_SELECT_10
        sendCommandEndResponse(true, 0x05, dev, 0x20, 0x00)
        break

      case 0x5a: { // MODE_SENSE_10
        const buflen = readShortBE(cdb, 7)
        if (buflen === 0) {
          sendDataToHost(dev, true, EMPTY_LENGTH, dma)
          return
        }
        const sectors =
          dev === DEV_FLOPPY ? (floppyFile != null ? floppyFile.size >> 9 : 0) : cdromFile != null ? cdromFile.size >> 11 : 0
        const ls120 = sectors > 0xb40
        let page: Uint8Array | null = null
        switch (cdb[2] & 0x3f) {
          case 0x01:
            page =
              dev === DEV_FLOPPY
                ? ls120
                  ? MODE_SENSE_LS120_ERROR
                  : MODE_SENSE_FLOPPY_ERROR
                : MODE_SENSE_CD_ERROR
            break
          case 0x05:
            page =
              dev === DEV_FLOPPY
                ? ls120
                  ? MODE_SENSE_LS120_DISK_PAGE
                  : MODE_SENSE_FLOPPY_DISK_PAGE
                : null
            break
          case 0x3f:
            page =
              dev === DEV_FLOPPY
                ? ls120
                  ? MODE_SENSE_3F_LS120
                  : MODE_SENSE_3F_FLOPPY
                : MODE_SENSE_3F_CD
            break
          case 0x1a:
            page = dev === DEV_CD ? MODE_SENSE_CD_1A : null
            break
          case 0x1d:
            page = dev === DEV_CD ? MODE_SENSE_CD_1D : null
            break
          case 0x2a:
            page = dev === DEV_CD ? MODE_SENSE_CD_2A : null
            break
        }
        if (page == null) sendCommandEndResponse(false, 0x05, dev, 0x20, 0x00)
        else sendDataToHost(dev, true, page, dma)
        break
      }

      case 0xac: // GET_PERFORMANCE
        sendDataToHost(dev, true, RD_CD_PERFORMANCE, dma)
        break

      default:
        sendCommandEndResponse(false, 0x05, dev, 0x20, 0x00)
        break
    }
  }

  const handleSessionStart = (): number => {
    if (acc.length < 30) return 0
    const len = acc[29]
    if (acc.length < HEADER + 22 + len) return 0
    const info: IderInfo = {
      major: acc[HEADER],
      minor: acc[HEADER + 1],
      fwmajor: acc[HEADER + 2],
      fwminor: acc[HEADER + 3],
      readbfr: readShortLE(acc, 16),
      writebfr: readShortLE(acc, 18),
      proto: acc[21],
      iana: readIntLE(acc, 25),
    }
    if (info.proto !== 0 || info.readbfr > MAX_BUFFER || info.writebfr > MAX_BUFFER) {
      stop()
      return 0
    }
    iderinfo = info
    readBufferSize = info.readbfr
    requestToggle()
    refreshView()
    return HEADER + 22 + len
  }

  /** Returns the bytes consumed, 0 when the frame is still incomplete. */
  const processDataEx = (): number => {
    if (acc.length < HEADER) return 0
    switch (acc[0]) {
      case 0x41: // OPEN_SESSION reply
        return handleSessionStart()
      case 0x43: // CLOSE
        stop()
        return HEADER
      case 0x44: // KEEPALIVEPING
        sendCommand(0x45)
        return HEADER
      case 0x45: // KEEPALIVEPONG
        return HEADER
      case 0x46: // RESETOCCURED
        if (acc.length < 9) return 0
        if (readFile == null) sendCommand(0x47)
        else resetQueued = true
        return 9
      case 0x49: { // STATUS_DATA, the DisableEnableFeaturesReply
        if (acc.length < 13) return 0
        const type = acc[8]
        const value = readIntLE(acc, 9)
        if (type === 1 && (value & 1) !== 0) requestToggle()
        else if (type === 2) enabled = (value & 2) !== 0
        return 13
      }
      case 0x4a: // ERROR OCCURED
        return acc.length < 11 ? 0 : 11
      case 0x4b: // HEARTBEAT
        return HEADER
      case 0x50: // COMMAND WRITTEN
        if (acc.length < 28) return 0
        handleScsi(
          (acc[14] & 0x10) !== 0 ? DEV_CD : DEV_FLOPPY,
          acc.subarray(16, 28),
          acc[9],
          acc[14]
        )
        return 28
      case 0x53: { // DATA FROM HOST, a guest write we cannot honour
        if (acc.length < 14) return 0
        const len = readShortLE(acc, 9)
        if (acc.length < 14 + len) return 0
        sendCommand(
          0x51,
          new Uint8Array([
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x87, 0x70, 0x03, 0, 0, 0, 0xa0, 0x51, 0x07, 0x27,
            0,
          ]),
          true
        )
        return 14 + len
      }
      default:
        stop()
        return 0
    }
  }

  const processBinaryData = (data: Uint8Array) => {
    bytesFromAmt += data.length
    const merged = new Uint8Array(acc.length + data.length)
    merged.set(acc, 0)
    merged.set(data, acc.length)
    acc = merged

    while (acc.length > 0) {
      // The transport strips the command header off the first 0x41 frame before
      // handing it over (amt-redir-ws-0.1.0.js:230), so a bare payload can land
      // here. Put a header back so the offsets below line up.
      if (!OP_CODES[acc[0]]) {
        const restored = new Uint8Array(HEADER + acc.length)
        restored[0] = 0x41
        restored.set(acc, HEADER)
        acc = restored
      }
      const len = processDataEx()
      if (len === 0) return
      if (inSequence !== readIntLE(acc, 4)) {
        stop()
        return
      }
      inSequence++
      acc = acc.subarray(len)
    }
  }

  /** OPEN_SESSION — sent once the redirection channel reports the session up. */
  const openSession = () => {
    live = true
    if (statsTimer == null) statsTimer = setInterval(refreshView, 500)
    sendCommand(
      0x40,
      cat(shortLE(RX_TIMEOUT), shortLE(TX_TIMEOUT), shortLE(HEARTBEAT), intLE(VERSION))
    )
    if (FEAT_IDERStats) {
      sectorStats('floppy', 0, floppyFile != null ? floppyFile.size >> 9 : 0, 0, 0)
      sectorStats('cdrom', 0, cdromFile != null ? cdromFile.size >> 11 : 0, 0, 0)
    }
    refreshView()
  }

  const stop = () => {
    channel.Stop()
    live = false
    if (statsTimer != null) {
      clearInterval(statsTimer)
      statsTimer = null
    }
    acc = new Uint8Array(0)
    readFile = null
    readQueue.length = 0
    resetQueued = false
    refreshView()
  }

  const module: RedirectModule = {
    protocol: 3,
    Start: openSession,
    ProcessBinaryData: processBinaryData,
    xxStateChange: (state) => {
      if (state === 3 && !live) openSession()
      if (state === 0) stop()
    },
  }

  const channel = createRedirect(module)

  return {
    view,
    start: (options) => {
      stop()
      floppyFile = options.floppy ?? null
      cdromFile = options.cdrom ?? null
      startMode = options.mode
      inSequence = 0
      outSequence = 0
      bytesToAmt = 0
      bytesFromAmt = 0
      iderinfo = null
      enabled = false
      floppyReady = false
      cdromReady = false
      readBufferSize = 512
      heatMaps = []
      channel.Start()
      refreshView()
    },
    eject: (device) => {
      if (device === 'floppy') {
        floppyFile = null
        floppyReady = false
      } else {
        cdromFile = null
        cdromReady = false
      }
      refreshView()
    },
    stop,
  }
}