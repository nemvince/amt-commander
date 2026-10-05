/**
 * Storage (view 21).
 *
 * The one page that does not speak WSMAN: firmware serves a plain HTTP document
 * at /amt-storage/ (index.html:11408), and the same URL scheme opens, downloads
 * and deletes the individual files it lists. The legacy app funneled all of it
 * through the WSMAN XHR queue, so this page reuses that same comm object rather
 * than opening a second connection -- that also keeps the browser's native 401
 * digest prompt working.
 *
 * Firmware answers with the legacy JSON document; newer 3PDS firmware (and the
 * local mock) answer with an AmtStorage XML inventory. Both are accepted.
 */
import { useEffect, useState } from 'preact/hooks'
import { FEAT_FileSaver } from '../features'
import { format, type AmtStack } from '../lib/amt-stack'
import { connState, getStack } from '../state/device'
import { S } from '../strings'
import { Table, type Column } from '../ui/table'
import { TrashIcon } from '../ui/icons'

interface StorageItem {
  /** Path below /amt-storage/, empty for XML volume rows. */
  handle: string
  name: string
  /** Device name for volumes, `vendor / app` for files. */
  location: string
  mount: string
  filesystem: string
  total: number
  used: number
  free: number
  link: string
}

interface StorageDoc {
  items: StorageItem[]
  /** Vendor/app folders the device left empty, which legacy deletes on sight. */
  emptyMounts: string[]
  raw: string
}

export function StoragePage() {
  const [doc, setDoc] = useState<StorageDoc>({ items: [], emptyMounts: [], raw: '' })
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  // Read the connection signal in the body so the fetch also fires when the
  // device finishes connecting after this page mounted.
  const conn = connState.value
  useEffect(() => {
    const stack = getStack()
    if (conn !== 'connected' || stack == null) return
    stack.wsman.comm.PerformAjax(
      '',
      (data, status) => {
        if (status !== 200 || data == null) {
          setError(format(S.storageLoadFailed, status))
          return
        }
        const parsed = parseDocument(data)
        setError('')
        setDoc(parsed)
        pruneEmptyMounts(stack, parsed.emptyMounts)
      },
      null,
      0,
      '/amt-storage/',
      'GET',
    )
  }, [conn, reload])

  const refresh = () => setReload((n) => n + 1)

  const remove = (handle: string) => {
    const stack = getStack()
    if (stack == null || handle === '') return
    stack.wsman.comm.PerformAjax(
      '',
      (_data, status) => {
        if (status !== 200) setError(format(S.storageDeleteFailed, status))
        refresh()
      },
      null,
      0,
      '/amt-storage/' + handle,
      'DELETE',
    )
  }

  const open = (handle: string) => {
    if (handle !== '') window.open('/amt-storage/' + handle, '_blank', 'noopener,noreferrer')
  }

  const download = (handle: string, name: string) => {
    const stack = getStack()
    if (stack == null || handle === '') return
    stack.wsman.comm.PerformAjax(
      '',
      (data, status) => {
        if (status !== 200 || data == null) return
        saveBlob(name, data)
      },
      null,
      0,
      '/amt-storage/' + handle,
      'GET',
    )
  }

  const columns: Column[] = [
    { label: S.name, cell: (r: StorageItem) => r.name || '—' },
    { label: S.storageDevice, cell: (r: StorageItem) => r.location || '—' },
    { label: S.mountPoint, cell: (r: StorageItem) => r.mount || '—' },
    { label: S.filesystem, cell: (r: StorageItem) => r.filesystem || '—' },
    { label: S.totalCapacity, cell: (r: StorageItem) => bytes(r.total), numeric: true },
    { label: S.used, cell: (r: StorageItem) => bytes(r.used), numeric: true },
    { label: S.freeSpace, cell: (r: StorageItem) => bytes(r.free), numeric: true },
    {
      label: S.actions,
      cell: (r: StorageItem) =>
        r.handle === '' ? (
          '—'
        ) : (
          <span class="btn-row" style="padding:0">
            <button type="button" class="btn" onClick={() => open(r.handle)}>
              {S.open}
            </button>
            {FEAT_FileSaver ? (
              <button type="button" class="btn" onClick={() => download(r.handle, r.name)}>
                {S.download}
              </button>
            ) : null}
            <button type="button" class="btn btn-icon" title={S.remove} onClick={() => remove(r.handle)}>
              <TrashIcon />
            </button>
          </span>
        ),
    },
  ]

  return (
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">{S.navStorage}</h1>
      </div>

      {error !== '' && <div class="banner error">{error}</div>}

      <Table
        title={S.navStorage}
        columns={columns}
        rows={doc.items}
        keyOf={(r) => r.handle + r.name + r.mount}
        onRefresh={refresh}
        onClear={FEAT_FileSaver ? () => saveBlob('amt-storage.json', doc.raw) : undefined}
        empty={S.noFiles}
      />
    </div>
  )
}

/**
 * Legacy deletes vendor/app folders as soon as they hold no files, so the
 * device's storage does not fill up with empty directories.
 */
function pruneEmptyMounts(stack: AmtStack, mounts: string[]) {
  for (const m of mounts) stack.wsman.comm.PerformAjax('', () => {}, null, 0, '/amt-storage/' + m, 'DELETE')
}

function parseDocument(text: string): StorageDoc {
  // The firmware occasionally pads the document with control bytes; drop them so
  // JSON.parse has a chance (index.html:11417).
  const clean = text.replace(/[\x00-\x1f]/g, '')
  try {
    return parseJson(JSON.parse(clean))
  } catch {
    return parseVolumes(clean)
  }
}

/** Legacy document: a vendor / app / name tree, or the newer flat `content` array. */
function parseJson(json: { content?: unknown }): StorageDoc {
  const items: StorageItem[] = []
  const emptyMounts: string[] = []
  const content = json.content as Record<string, unknown> | unknown[] | undefined

  const file = (vendor: string, app: string, name: string, entry: { size?: number; link?: string }) => {
    items.push({
      handle: vendor + (vendor !== '' ? '/' : '') + app + (app !== '' ? '/' : '') + name,
      name,
      location: vendor === '' ? 'Root' : vendor + (app === '' ? '' : ' / ' + app),
      mount: '',
      filesystem: '',
      total: Number(entry?.size ?? 0),
      used: 0,
      free: 0,
      link: String(entry?.link ?? ''),
    })
  }

  if (Array.isArray(content)) {
    for (const c of content as Record<string, unknown>[]) {
      const name = String(c['name'] ?? '')
      if (name === '') continue
      file(String(c['vendor'] ?? ''), String(c['app'] ?? ''), name, c as { size?: number })
    }
  } else if (content != null && typeof content === 'object') {
    for (const vendor of Object.keys(content)) {
      const apps = content[vendor] as Record<string, Record<string, { size?: number; link?: string }>>
      if (Object.keys(apps ?? {}).length === 0 && vendor !== '') emptyMounts.push(vendor)
      for (const app of Object.keys(apps ?? {})) {
        const files = apps[app] ?? {}
        if (Object.keys(files).length === 0) {
          emptyMounts.push(vendor + '/' + app)
          continue
        }
        for (const name of Object.keys(files)) file(vendor, app, name, files[name])
      }
    }
  }
  return { items, emptyMounts, raw: JSON.stringify(json) }
}

/** Newer firmware answers with an AmtStorage inventory instead of a file list. */
function parseVolumes(xml: string): StorageDoc {
  const items: StorageItem[] = []
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return { items, emptyMounts: [], raw: xml }

  for (const device of Array.from(doc.getElementsByTagName('StorageDevice'))) {
    const name = childText(device, 'Name')
    // Volumes sit inside a <Volumes> wrapper, so they are descendants, not children.
    const volumes = Array.from(device.getElementsByTagName('Volume'))
    if (volumes.length === 0) {
      items.push({
        handle: '',
        name,
        location: name,
        mount: '',
        filesystem: '',
        total: childNum(device, 'TotalSize'),
        used: childNum(device, 'UsedSpace'),
        free: childNum(device, 'FreeSpace'),
        link: '',
      })
      continue
    }
    for (const volume of volumes) {
      items.push({
        handle: '',
        name: childText(volume, 'Name') || name,
        location: name,
        mount: childText(volume, 'MountPoint'),
        filesystem: childText(volume, 'FileSystem'),
        total: childNum(volume, 'TotalSize'),
        used: childNum(volume, 'UsedSpace'),
        free: childNum(volume, 'FreeSpace'),
        link: '',
      })
    }
  }
  return { items, emptyMounts: [], raw: xml }
}

/** Direct children only: a device's Name must not pick up its volumes' names. */
function childText(el: Element, name: string): string {
  for (const c of Array.from(el.children)) if (c.localName === name) return c.textContent ?? ''
  return ''
}

function childNum(el: Element, name: string): number {
  return Number(childText(el, name)) || 0
}

function bytes(n: number): string {
  if (!n) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + units[i]
}

/** Replaces the legacy filesaver.js polyfill: blob URL plus a synthetic download. */
function saveBlob(name: string, data: string) {
  const url = URL.createObjectURL(new Blob([data]))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
