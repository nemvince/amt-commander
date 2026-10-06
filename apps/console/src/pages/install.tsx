/**
 * Install from web (opt-in feature).
 *
 * Fetches a gzipped console artifact over the network and flashes it into the
 * device's user flash, from the page the device itself is serving. That
 * placement is the whole point: the PUT goes to a relative `/amt-storage/...`,
 * which is the only way this request carries the browser's cached digest
 * credentials -- a cross-origin page gets a challenge it cannot answer.
 *
 * The wire format mirrors `packages/build-system/src/amt-loader.ts`: an AMT
 * metadata envelope describing how the entry should be served, immediately
 * followed by the gzip payload, then follower blocks carrying only the empty
 * metadata marker. No request Content-Type may be set: with one, AMT answers
 * 400 and writes nothing.
 */
import { useState } from 'preact/hooks'
import { format } from '../lib/amt-stack'
import type { WsmanComm } from '../lib/wsman'
import { getStack } from '../state/device'
import { INSTALL } from '../strings'

/** The headers AMT is to serve the stored entry with, sent with the first block. */
const METADATA_HEAD =
  '<metadata><headers><h>Content-Encoding:gzip</h><h>Content-Type:text/html</h></headers></metadata>'

/** Follower chunks carry only the empty metadata marker. */
const METADATA_FOLLOWUP = '<metadata></metadata>'

/** AMT caps a single PUT body; the loader starts at 8 KiB and halves on 400/500. */
const BLOCK_SIZE = 8192
/** Smallest block worth trying before reporting the failure. */
const MIN_BLOCK_SIZE = 256
/** Flash entry AMT serves as the console. */
const ENTRY = '/amt-storage/index.htm'
/** The device resets the connection when written in a tight loop. */
const BLOCK_DELAY = 120

const encoder = new TextEncoder()

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

interface Progress {
  blocks: number
  done: number
  total: number
}

export function InstallPage() {
  const [artifactUrl, setArtifactUrl] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [installed, setInstalled] = useState(false)
  const [busy, setBusy] = useState(false)

  const install = async () => {
    const comm = getStack()?.wsman.comm
    if (comm == null) {
      setError(format(INSTALL.installFailed, 0))
      return
    }
    setError('')
    setStatus(INSTALL.installing)
    setInstalled(false)
    setBusy(true)

    let artifact: Uint8Array<ArrayBuffer>
    try {
      const res = await fetch(artifactUrl)
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText)
      artifact = new Uint8Array(await res.arrayBuffer())
    } catch (e) {
      // Cross-origin artifacts fail here: AMT sends no CORS headers either.
      setError(format(INSTALL.installFetchFailed, String(e)))
      setStatus('')
      setBusy(false)
      return
    }
    /*
     * The device serves the stored entry under the Content-Encoding declared in
     * the metadata, so anything that is not already gzip -- a server that sends
     * .gz files as `Content-Encoding: gzip` hands back the decompressed console
     * -- would be stored as a corrupt stream.
     */
    if (artifact[0] !== 0x1f || artifact[1] !== 0x8b) {
      setError(format(INSTALL.installNotGzip, artifact.length))
      setStatus('')
      setBusy(false)
      return
    }

    const progress = (p: Progress) => setStatus(format(INSTALL.installProgress, p.blocks, p.done, p.total))
    const failure = await flash(comm, artifact, progress)
    if (failure == null) {
      setStatus(INSTALL.installComplete)
      setInstalled(true)
    } else {
      setError(failure)
      setStatus('')
    }
    setBusy(false)
  }

  return (
    <div class="page">
      {error !== '' && <div class="banner error">{error}</div>}

      <section class="table-panel">
        <div class="table-titlebar">
          <h2 class="table-title">{INSTALL.navInstall}</h2>
        </div>
        <div class="field-row">
          <label>
            {INSTALL.artifactUrl}
            <input
              type="text"
              size={56}
              value={artifactUrl}
              placeholder="http://192.0.2.10:8080/download/console.htm.gz"
              onInput={(e) => setArtifactUrl(e.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            class="btn btn-primary"
            disabled={busy || artifactUrl.trim() === ''}
            onClick={() => void install()}
          >
            {busy ? INSTALL.installing : INSTALL.installAction}
          </button>
          {installed && (
            <button type="button" class="btn" onClick={() => location.reload()}>
              {INSTALL.installReload}
            </button>
          )}
        </div>
        <p class="table-empty">{status !== '' ? status : INSTALL.installHint}</p>
      </section>
    </div>
  )
}

/**
 * Replace whatever the device serves today with the artifact.
 *
 * Returns the error message to show, or null on success.
 */
async function flash(
  comm: WsmanComm,
  artifact: Uint8Array<ArrayBuffer>,
  onProgress: (p: Progress) => void,
): Promise<string | null> {
  // Ignore a 404: a device that has never had a console installed has nothing here.
  const deleted = await request(comm, 'DELETE', ENTRY, undefined, 0)
  if (deleted !== 200 && deleted !== 404) return format(INSTALL.installFailed, deleted)

  let blockSize = BLOCK_SIZE
  let lastStatus = 0
  // Same ladder as the loader: five halvings from 8 KiB reach the floor, and the
  // sixth attempt is the one that gets to report the failure.
  for (let attempt = 0; attempt < 6; attempt++) {
    lastStatus = await pushAll(comm, artifact, blockSize, onProgress)
    if (lastStatus >= 200 && lastStatus < 300) return null
    // 401 is the device's digest challenge going unanswered, not a storage fault.
    if (lastStatus === 401) return INSTALL.installNoCredentials
    /*
     * 400 and 500 both turn up when the device is unhappy -- with the block size,
     * or with the rate it is being written at. Halving and retrying is what
     * recovers it, so treat them the same rather than failing hard.
     */
    if ((lastStatus !== 400 && lastStatus !== 500) || blockSize <= MIN_BLOCK_SIZE) break
    blockSize = Math.floor(blockSize / 2)
    await sleep(400 * (attempt + 1))
  }
  return format(INSTALL.installFailed, lastStatus)
}

/** Write the artifact block by block; returns the HTTP status that stopped it. */
async function pushAll(
  comm: WsmanComm,
  artifact: Uint8Array<ArrayBuffer>,
  blockSize: number,
  onProgress: (p: Progress) => void,
): Promise<number> {
  let offset = 0
  let blocks = 0
  while (offset < artifact.length) {
    const head = encoder.encode(offset === 0 ? METADATA_HEAD : METADATA_FOLLOWUP)
    const take = Math.min(artifact.length - offset, blockSize - head.length)
    const body = new Uint8Array(head.length + take)
    body.set(head)
    body.set(artifact.subarray(offset, offset + take), head.length)

    const target = offset === 0 ? ENTRY : ENTRY + '?append=1'
    const status = await request(comm, 'PUT', target, body, 1)
    if (status < 200 || status >= 300) return status

    offset += take
    blocks++
    onProgress({ blocks, done: offset, total: artifact.length })
    if (offset < artifact.length) await sleep(BLOCK_DELAY)
  }
  return 200
}

/** One storage request; resolves with the HTTP status, or 0 when the socket failed. */
function request(
  comm: WsmanComm,
  action: string,
  url: string,
  body: Uint8Array<ArrayBuffer> | undefined,
  pri: number,
): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>()
  comm.PerformAjax('', (_data, status) => resolve(status), null, pri, url, action, body)
  return promise
}
