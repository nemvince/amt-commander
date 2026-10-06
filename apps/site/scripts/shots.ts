/**
 * Capture the console for the promo site's screenshot wall.
 *
 * The console is driven against the mock device rather than the replayed demo:
 * the mock speaks the redirection WebSocket, so the KVM viewer shows a real
 * framebuffer and the SOL terminal a real banner -- a Service Worker cannot
 * replay either, and a screenshot of two "disconnected" pages sells nothing.
 *
 * Both colour schemes are shot, because the themes carry a light and a dark
 * variant of every palette.
 *
 *   bun apps/site/scripts/shots.ts
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const CONSOLE_DIR = new URL('../../console/', import.meta.url).pathname
const MOCK_DIR = new URL('../../../packages/mock/', import.meta.url).pathname
const OUT_DIR = new URL('../public/shots/', import.meta.url).pathname

/**
 * The console's own dev port, overridable so this can run while another dev
 * server holds 5173. The mock port is not: the console's vite config proxies
 * `/wsman` to 127.0.0.1:8765, so the mock has to be there.
 */
const PORT = Number(process.env.SHOTS_PORT ?? 5173)
const MOCK_PORT = 8765

/**
 * The pages worth showing.
 *
 * `connect` clicks the page's own session button first: the redirection pages
 * start disconnected, and a screenshot of a black stage proves nothing. `ready`
 * is the selector that only appears once the mock has actually answered.
 */
const PAGES: readonly {
  name: string
  hash: string
  ready: string
  connect: boolean
  settle: number
}[] = [
  { name: 'system', hash: 'system', ready: '.kv', connect: false, settle: 1200 },
  { name: 'kvm', hash: 'kvm', ready: '.statusbar', connect: true, settle: 4000 },
  { name: 'sol', hash: 'sol', ready: '.terminal-output', connect: true, settle: 3000 },
  { name: 'hardware', hash: 'hardware', ready: '.table-panel', connect: false, settle: 1500 },
  { name: 'events', hash: 'events', ready: '.table tbody tr', connect: false, settle: 1500 },
]

const waitForPort = async (port: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fetch(`http://localhost:${port}/`)
      return
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`nothing listening on ${port} after ${timeoutMs} ms`)
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

const mock = Bun.spawn(['bun', 'server.ts'], { cwd: MOCK_DIR, stdout: 'inherit', stderr: 'inherit' })
const vite = Bun.spawn(['bunx', 'vite', '--port', String(PORT), '--strictPort'], {
  cwd: CONSOLE_DIR,
  env: {
    ...process.env,
    // Every page the shots need, and nothing else: the flags decide what exists.
    FEATURES: 'Desktop,Terminal,IDER,HardwareInfo,EventLog',
  },
  stdout: 'ignore',
  stderr: 'inherit',
})

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

try {
  await waitForPort(MOCK_PORT, 20_000)
  await waitForPort(PORT, 60_000)

  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  // The theme overlay is a development affordance; it has no place in a
  // screenshot of the product.
  await page.addInitScript(() => {
    const style = document.createElement('style')
    style.textContent = '.theme-picker { display: none !important }'
    document.addEventListener('DOMContentLoaded', () => document.head.append(style))
  })

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    mkdirSync(`${OUT_DIR}${scheme}/`, { recursive: true })
    for (const { name, hash, ready, connect, settle } of PAGES) {
      await page.goto(`http://localhost:${PORT}/#/${hash}`)
      await page.waitForSelector(ready, { timeout: 20_000 })
      if (connect) {
        await page.click('.media-bar button')
        await page.waitForFunction(
          () => document.querySelector('.statusbar')?.textContent?.includes('Connected') === true,
          undefined,
          { timeout: 20_000 },
        )
      }
      await page.waitForTimeout(settle)
      await page.screenshot({ path: `${OUT_DIR}${scheme}/${name}.png` })
      console.log(`shot      ${scheme}/${name}.png`)
    }
  }
} finally {
  await browser?.close()
  vite.kill()
  mock.kill()
}
