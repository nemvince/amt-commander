/**
 * The promo page: what the console is, what it looks like, and a picker that
 * builds one to your selection.
 *
 * Everything the page states is measured elsewhere -- the sizes come from real
 * builds through `scripts/prepare.ts`, the screenshots from the console running
 * against the mock device (`scripts/shots.ts`), and the demo is the console
 * itself, replayed through the Service Worker.
 */
import { render } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  FEATURES,
  MANDATORY,
  TIERS,
  featuresByGroup,
  resolveFeatures,
} from '@meshcommander/build-system'
import type { FeatureDef } from '@meshcommander/build-system'
import { DEFAULT_THEME, THEMES } from '@meshcommander/build-system/themes'
import { estimateSize, formatBytes, type SizeTable } from './size'
import './site.css'

const REPO = 'https://github.com/Ylianst/MeshCommander'
/**
 * Where the "build locally" button points: the CLI guide in this repository.
 * The branch is named because a blob link has to be, and the rewrite lives here
 * until it lands on the default branch.
 */
const GUIDE = `${REPO}/blob/rewrite-spa/docs/building.md`
/** Where the "buy me a coffee" link in the footer points. */
const COFFEE = 'https://buymeacoffee.com/nemvince'
/**
 * Where the build service lives.
 *
 * `VITE_BUILD_SERVICE` is baked in at build time (the deploy workflow passes the
 * repository variable), and an empty value means "not configured here" -- hence
 * `||` rather than `??` -- so the local default still applies.
 */
const SERVICE = import.meta.env.VITE_BUILD_SERVICE || 'http://localhost:8787'

/** The demo build's selection, so the picker opens on something familiar. */
const DEFAULT_SELECTION = TIERS.large ?? MANDATORY

/** Console pages shot against the mock device, in both colour schemes. */
const SHOTS: readonly (readonly [string, string])[] = [
  ['system', 'System Status — firmware version, provisioning, power state'],
  ['kvm', 'Remote Desktop — the KVM viewer over AMT redirection'],
  ['sol', 'Serial-over-LAN — the SOL terminal'],
  ['hardware', 'Hardware Information — SMBIOS inventory'],
  ['events', 'Event Log — the firmware message log'],
]

const GROUPS = [...featuresByGroup()]

const sizeTables = async (): Promise<Record<string, SizeTable>> => {
  const res = await fetch('size-cache.json')
  if (!res.ok) {
    throw new Error(`size-cache.json -> ${res.status}`)
  }
  return (await res.json()) as Record<string, SizeTable>
}

function Hero() {
  return (
    <header class="hero">
      <img class="hero-mark" src="./mesh256.png" width="96" height="96" alt="" />
      <div>
        <h1>MeshCommander</h1>
        <p class="lede">
          An Intel&reg; AMT management console that ships as <strong>one HTML file</strong> — built
          from exactly the features and the theme you pick, and small enough to live in the
          device&rsquo;s own user flash.
        </p>
        <p class="hero-links">
          <a class="btn btn-primary" href="#build">
            Build yours
          </a>
          <a class="btn" href="#demo">
            Try the demo
          </a>
          <a class="btn" href={REPO}>
            Source
          </a>
          <a class="btn" href={GUIDE}>
            Build locally
          </a>
        </p>
      </div>
    </header>
  )
}

/**
 * Screenshot carousel.
 *
 * One stage instead of two walls of thumbnails: the shots are 1440x900, so a
 * grid made the reader scroll to compare pages that only differ in their middle.
 * Arrows, dots and the thumbnail rail all move the same index; the colour scheme
 * switches every image at once, since the same five pages were shot twice.
 */
function Screenshots() {
  const [scheme, setScheme] = useState<'light' | 'dark'>('light')
  const [index, setIndex] = useState(0)
  const [zoomed, setZoomed] = useState(false)
  const rail = useRef<HTMLDivElement>(null)

  /** Wrapping step, so the arrows never dead-end. */
  const step = (delta: number) => setIndex((i) => (i + delta + SHOTS.length) % SHOTS.length)
  const shot = SHOTS[index] ?? SHOTS[0]

  // Keep the active thumbnail visible once the rail is wider than its box.
  useEffect(() => {
    rail.current?.querySelector('.carousel-thumb.active')?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [index])

  // Escape closes the zoomed view; arrows page it like the stage.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZoomed(false)
      if (event.key === 'ArrowLeft') step(-1)
      if (event.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (shot == null) return null

  return (
    <section id="shots">
      <h2>Screenshots</h2>
      <p class="section-note">
        Captured from this console talking to a mock AMT device, so the KVM viewer and the SOL
        terminal are live sessions rather than mock-ups. Use the arrows or ← → to page through them.
      </p>

      <div class="carousel">
        <div class="carousel-stage">
          <button
            type="button"
            class="carousel-image"
            onClick={() => setZoomed(true)}
            aria-label={`Enlarge: ${shot[1]}`}
          >
            {/* `key` restarts the fade whenever the picture changes. */}
            <img
              key={`${scheme}-${shot[0]}`}
              src={`./shots/${scheme}/${shot[0]}.png`}
              width="1440"
              height="900"
              decoding="async"
              alt={shot[1]}
            />
          </button>
          <button type="button" class="carousel-arrow prev" onClick={() => step(-1)} aria-label="Previous screenshot">
            ‹
          </button>
          <button type="button" class="carousel-arrow next" onClick={() => step(1)} aria-label="Next screenshot">
            ›
          </button>
          <span class="carousel-count">
            {index + 1} / {SHOTS.length}
          </span>
        </div>

        <div class="carousel-bar">
          <p class="carousel-caption">{shot[1]}</p>
          <div class="segmented" role="group" aria-label="Appearance">
            {(['light', 'dark'] as const).map((option) => (
              <button
                type="button"
                class={'segment' + (option === scheme ? ' active' : '')}
                aria-pressed={option === scheme}
                onClick={() => setScheme(option)}
              >
                {option === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </div>

        <div class="carousel-rail" ref={rail}>
          {SHOTS.map(([name, caption], i) => (
            <button
              type="button"
              class={'carousel-thumb' + (i === index ? ' active' : '')}
              aria-current={i === index}
              aria-label={caption}
              onClick={() => setIndex(i)}
            >
              <img src={`./shots/${scheme}/${name}.png`} alt="" loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      </div>

      {zoomed && (
        <div class="lightbox" role="dialog" aria-modal="true" aria-label={shot[1]} onClick={() => setZoomed(false)}>
          <img src={`./shots/${scheme}/${shot[0]}.png`} alt={shot[1]} />
          <button type="button" class="lightbox-close" aria-label="Close" onClick={() => setZoomed(false)}>
            ×
          </button>
          <p class="lightbox-caption">{shot[1]}</p>
        </div>
      )}
    </section>
  )
}

interface PickerProps {
  selected: ReadonlySet<string>
  onToggle: (id: string, on: boolean) => void
  onPreset: (ids: readonly string[]) => void
  theme: string
  onTheme: (id: string) => void
  tables: Record<string, SizeTable> | null
  sizeError: string
}

function Picker({ selected, onToggle, onPreset, theme, onTheme, tables, sizeError }: PickerProps) {
  const resolved = useMemo(() => [...resolveFeatures([...selected].join(','))], [selected])
  const table = tables?.[theme] ?? tables?.mesh ?? null
  const estimate = estimateSize(resolved, table)
  const [status, setStatus] = useState('')
  const [artifact, setArtifact] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** Ask the build service for exactly this selection and theme. */
  const build = async () => {
    setBusy(true)
    setStatus('building…')
    setArtifact(null)
    try {
      const res = await fetch(`${SERVICE}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features: resolved, theme }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setStatus(`build failed: ${body?.error ?? res.statusText}`)
        return
      }
      const blob = await res.blob()
      const name = res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]
      setArtifact(URL.createObjectURL(blob))
      setStatus(`${formatBytes(blob.size)} — ${name ?? 'artifact ready'}`)
    } catch (e) {
      setStatus(
        `cannot reach the build service at ${SERVICE} (${(e as Error).message}). ` +
          'Run `bun run service` to host one locally.',
      )
    } finally {
      setBusy(false)
    }
  }

  /**
   * A selection is closed over `requires`, so a feature an enabled feature needs
   * cannot be turned off. Saying which one holds it is the difference between a
   * toggle that explains itself and one that looks broken.
   */
  const heldBy = new Map<string, string[]>()
  for (const f of FEATURES) {
    if (!resolved.includes(f.id)) {
      continue
    }
    for (const dep of f.requires ?? []) {
      heldBy.set(dep, [...(heldBy.get(dep) ?? []), f.label])
    }
  }

  return (
    <section id="build">
      <h2>Build it</h2>
      <p class="section-note">
        Every toggle is a compile-time flag: the code, its styles and its dependencies leave the
        artifact entirely, which is why the size moves as you click. Sizes are gzipped bytes from
        real builds, measured per theme. The build service then runs the same compiler this page was
        measured with, and answers with the artifact — ready to flash through the console&rsquo;s own
        installer or <span class="mono">amt-loader</span>.
      </p>

      <div class="picker">
        <div class="picker-list">
          <div class="picker-presets">
            {Object.entries(TIERS).map(([name, ids]) => (
              <button type="button" class="btn" onClick={() => onPreset(ids)}>
                {name} ({ids.length})
              </button>
            ))}
            <button type="button" class="btn" onClick={() => onPreset(MANDATORY)}>
              core only ({MANDATORY.length})
            </button>
          </div>
          {GROUPS.map(([group, defs]) => (
            <fieldset class="picker-group">
              <legend>{group}</legend>
              {defs.map((f: FeatureDef) => {
                const held = heldBy.get(f.id) ?? []
                return (
                  <label class="toggle">
                    <input
                      type="checkbox"
                      checked={resolved.includes(f.id)}
                      disabled={f.mandatory === true || held.length > 0}
                      onChange={(event) => onToggle(f.id, event.currentTarget.checked)}
                    />
                    <span>
                      <strong>{f.label}</strong>
                      {f.mandatory === true && <em class="tag">always on</em>}
                      {held.length > 0 && <em class="tag">held by {held.join(', ')}</em>}
                      {f.requires != null && <em class="tag">needs {f.requires.join(', ')}</em>}
                      {f.description != null && <span class="toggle-note">{f.description}</span>}
                    </span>
                  </label>
                )
              })}
            </fieldset>
          ))}
        </div>

        <aside class="picker-summary">
          <div class="size">
            <span class="size-value">{formatBytes(estimate.bytes)}</span>
            <span class="size-note">
              gzipped, {resolved.length} features —{' '}
              {estimate.exact ? 'measured' : 'estimate'}
              {estimate.unmeasured.length > 0 && `, ${estimate.unmeasured.length} unmeasured`}
            </span>
            {sizeError !== '' && (
              <span class="status-error">measurements unavailable: {sizeError}</span>
            )}
          </div>
          <div class="field">
            <label for="theme">Theme</label>
            <select
              id="theme"
              value={theme}
              onChange={(event) => onTheme(event.currentTarget.value)}
            >
              {THEMES.map((t) => (
                <option value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>
          <button type="button" class="btn btn-primary" disabled={busy} onClick={() => void build()}>
            {busy ? 'building…' : `Build ${resolved.length} features`}
          </button>
          {artifact != null && (
            <a class="btn" href={artifact} download={`meshcommander-${theme}.htm.gz`}>
              Download artifact
            </a>
          )}
          {status !== '' && <p class="mono status">{status}</p>}
          <p class="mono cli">
            bun run cli build --features {resolved.join(',')} --theme {theme}
          </p>
        </aside>
      </div>
    </section>
  )
}

function ThemeGallery() {
  return (
    <section id="themes">
      <h2>Themes</h2>
      <p class="section-note">
        Four palettes, each with a light and a dark variant. A build bakes exactly one of them in;
        the others cost nothing.
      </p>
      <div class="theme-grid">
        {THEMES.map((t) => (
          <figure class="theme">
            <iframe title={`${t.label} preview`} src={`./themes.html?theme=${t.id}`} loading="lazy" />
            <figcaption>
              <strong>{t.label}</strong>
              {t.description != null && <span>{t.description}</span>}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  )
}

/**
 * The console, replayed.
 *
 * Registration has to finish before the frame is created: a document is only
 * controlled by a Service Worker that was already active when it was fetched, so
 * mounting the iframe first would let the console's opening calls escape to the
 * real origin.
 */
function Demo() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const run = async () => {
      if (!('serviceWorker' in navigator)) {
        setError('this browser has no Service Worker support')
        return
      }
      try {
        // Not `navigator.serviceWorker.ready`: that promise is about the
        // registration controlling *this* page, and the demo's scope is
        // `/demo/`, so it would never settle here. `register` resolves as soon
        // as the worker is installing, so wait for it to be active instead.
        const registration = await navigator.serviceWorker.register('./sw.js', { scope: './demo/' })
        for (let attempt = 0; registration.active == null; attempt++) {
          if (attempt > 100) {
            throw new Error('the Service Worker never activated')
          }
          await new Promise((r) => setTimeout(r, 100))
        }
        setReady(true)
      } catch (e) {
        setError((e as Error).message)
      }
    }
    void run()
  }, [])

  return (
    <section id="demo">
      <h2>Live demo</h2>
      <p class="section-note">
        The console itself, running against a recorded conversation with a real AMT 11.8.50 device.
        The page calls are replayed by a Service Worker, so nothing here can touch a machine. The
        KVM and SOL streams are raw WebSockets, which a Service Worker cannot replay — those two
        pages need a real device.
      </p>
      {error !== '' && <p class="status-error">demo unavailable: {error}</p>}
      {!ready && error === '' && <p class="section-note">starting the replayed device…</p>}
      {ready && <iframe class="demo-frame" src="./demo/index.htm" title="MeshCommander demo" />}
    </section>
  )
}

export function App() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(DEFAULT_SELECTION))
  const [theme, setTheme] = useState(DEFAULT_THEME)
  const [tables, setTables] = useState<Record<string, SizeTable> | null>(null)
  const [sizeError, setSizeError] = useState('')

  useEffect(() => {
    sizeTables()
      .then(setTables)
      .catch((e: Error) => setSizeError(e.message))
  }, [])

  // The theme files are scoped to `:root[data-theme]`, so the site itself
  // repaints when a theme is picked -- the same mechanism the console uses.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const toggle = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) {
        next.add(id)
      } else {
        next.delete(id)
      }
      for (const mandatory of MANDATORY) {
        next.add(mandatory)
      }
      return next
    })
  }

  return (
    <>
      <Hero />
      <main>
        <Screenshots />
        <Picker
          selected={selected}
          onToggle={toggle}
          onPreset={(ids) => setSelected(new Set(ids))}
          theme={theme}
          onTheme={setTheme}
          tables={tables}
          sizeError={sizeError}
        />
        <ThemeGallery />
        <Demo />
      </main>
      <footer>
        <p>
          {FEATURES.length} feature flags, {THEMES.length} themes, one file.{' '}
          <a href={REPO}>github.com/Ylianst/MeshCommander</a>
        </p>
        <a class="btn coffee" href={COFFEE}>
          {/* Inline so the icon inherits the button's colour and costs no request. */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M3 5.5h8.5v4.2a2.8 2.8 0 0 1-2.8 2.8H5.8A2.8 2.8 0 0 1 3 9.7V5.5Z" />
            <path d="M11.5 6.8h1.2a1.9 1.9 0 0 1 0 3.8h-1.2" />
            <path d="M6 2.5v1.7M8.8 2.5v1.7" />
          </svg>
          Buy me a coffee
        </a>
      </footer>
    </>
  )
}

render(<App />, document.getElementById('app')!)
