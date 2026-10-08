# Building MeshCommander

The console is one self-contained `.htm.gz`: a Preact application compiled with
exactly the features and the theme you choose, inlined into a single file,
minified and zopfli-compressed. A console you are going to flash is built by the
CLI described here, on your own machine -- nothing in this repository builds one
for you over the network. The promo site only puts the command together, and its
own demo page is generated at build time from this same pipeline.

## What you need

Bun 1.4 or newer and a checkout:

```sh
git clone https://github.com/nemvince/amt-commander
cd amt-commander
bun install
```

That is the whole setup for the console itself: one Bun workspace, one install,
no native toolchain. Only the screenshot script wants more, and only once --
Playwright's Chromium, see [Develop](#develop).

## Build one

`bun run cli` is the front end. Run it bare on a terminal and it opens a picker
where you toggle features, watch the measured size move, and build what you see.
Without a terminal it builds instead of asking, so it is safe in a script.

```sh
bun run cli                                                  # pick features
bun run cli build --tier small                               # a preset
bun run cli build --features Desktop,Terminal,IDER --theme midnight
bun run cli features                                         # what can be turned on
bun run cli themes                                           # the four palettes
```

Artifacts land in `apps/console/dist/firmware/`. `--name mine` names the
artifact, `--out /tmp/console.htm.gz` writes it somewhere else, and `build`
prints the command that would flash what it just produced. Full option list:
`bun run cli --help`.

## Sizes, and the 64 KB limit

Every size this project prints is gzipped bytes from a real build of that exact
selection, never a guess from module sizes. Intel AMT gives the console 65,536
bytes of user flash and refuses a page larger than that, so:

- the `small` preset is the preset that fits -- it is the one to fall back to;
- nothing blocks an over-limit build: `bun run cli build` reports the artifact
  size and says so when a custom selection is past 65,536 B, because only you
  know which features a custom build needs;
- `--features` is how you trade a page away for headroom, and the picker prices
  every feature before you commit to it.

No build in this repository gates on the number any more. The three-tier
pipeline that used to fail the build when `small` did not fit went away with the
build service. The promo site's picker sums measured marginals, which is close
but not a build -- it says `measured` only for a selection that was itself built
-- so if the budget matters to you, build the selection and read the `size:`
line.

`bun run cli measure` rebuilds that size table from scratch -- one real build per
feature, for every theme -- and writes
`apps/console/build/.size-cache.json`, which is also what the promo site's
picker reads. Run it after changing the console's code or markup, or the numbers
the site shows will describe the old build. Narrow it with `--theme` when you
only care about one palette.

### Baseline (mesh theme, 2026-10-07)

Measured with `apps/console/scripts/measure.ts` (`Vite → inlineAssetTags → zopfli numiterations:50`):

| tier | features | gzipped | raw |
|------|----------|---------|-----|
| mandatory-only* | 3 (`Desktop, PowerControl, VersionWarning`) | 39,228 B | 120,477 B |
| `small` | 15 | 46,576 B | 144,836 B |
| `medium` | 24 | 60,212 B | 192,836 B |
| `large` | 32 | 78,584 B | 284,921 B |

`*` mandatory-only is not a tier preset, but the cost before any optional feature (60% of the 65,536 B budget). `large` is over budget and cannot be brought under it by trimming: even brotli q11 -- which the device cannot serve (see `build-firmware.ts`) -- measures 70,159 B on this payload, and zopfli already beats zlib -9 by 3.1 KB. The only way to fit `large` is to drop features from it.

What the build pipeline already does to keep these numbers down:

- `minify: 'oxc'` — measured smallest *gzipped* (terser +144 B, esbuild +2,280 B on the large tier). Smaller minified output is not smaller gzipped output here.
- `cssMinify: 'lightningcss'`, `cssCodeSplit: false`, `modulePreload: {polyfill:false}`.
- Repeated byte-order helpers live once in `lib/bytes.ts` instead of per protocol module, and `terminal.ts` keeps its CP437 table as decimal rather than hex literals.
- Per-page CSS is imported by the page module that needs it, not by `app.tsx`.
- `build-firmware.ts` inlines the JS/CSS into one HTML document, collapses the shell's whitespace and comments, then zopfli-gzips. 50 iterations measured smallest under a 15 s budget (15 → +18 B, 100 → +3 B and 2× slower).
- `script-blocks.json` reaches the bundle through `build/script-blocks-plugin.ts`, which re-emits it as a plain object literal (see below).

### The block library used to ship in every tier

`lib/script-blocks.json` is 66 KB (11.3 KB gzipped) and only the Script Editor
needs it. It used to be pulled in by `lib/scripting.ts` reading
`blockFile.blocks` **while the module was evaluated**, and a module whose side
effects the bundler cannot analyse is not droppable — so every tier carried it,
including a mandatory-only build:

| build | before | after |
|---|---|---|
| mandatory-only (3 feats) | 50,199 B | 39,228 B |
| `small` (15 feats) | 57,576 B | **46,576 B** |
| `medium` (24 feats) | 70,809 B | **60,212 B** |
| `large` (32 feats) | 78,770 B | 78,584 B |

`medium` now fits the budget. Two changes did it:

1. **Reach the data through a call, not at module scope.**
   `lib/scripting.ts` exposes `scriptLibrary()` and resolves the JSON on first
   use; `pages/scripts.tsx` — the only consumer — calls it inside the component.
   A tier without `FEAT_Scripting` then drops the data with the page.
2. **Emit it as an ES module, not a JSON module.**
   `build/script-blocks-plugin.ts` serves `virtual:script-blocks` as
   `export default {...}`. Vite's JSON transform wraps the data in a property
   read on a hoisted object, which costs ~235 B gzipped more on this payload.
   The `.json` file stays the single source of truth, so there is nothing
   generated to fall out of date.

Both were needed: the plugin alone does not remove the module, and the lazy read
alone still paid the JSON transform's overhead.

### Why `large` cannot be made to fit

Every route to 65,536 B was measured and all fail, so the goal is not reachable
without dropping features from the tier:

- **Compression.** On the `large` payload: zopfli 50 = 78,584 B, zlib -9 =
  81,911 B, brotli q11 = **70,159 B** — still over, and AMT cannot serve brotli
  anyway (it replays `Content-Encoding`, and the browser then fails to decode).
- **Minifier.** oxc is already the smallest *gzipped*; terser is +144 B and
  esbuild +2,280 B.
- **Content trims.** The whole of steps 3–4 — byte-helper dedup, CP437 decimals,
  CSS purge, per-page CSS, HTML shell minify — are worth under a kilobyte on
  `large`, which is what the tier is measured against.
- **String splitting.** The ceiling probe (stub the entire `S` table empty)
  gives `small` = 50,912 B and `large` = 72,149 B: even deleting *every* UI
  string leaves `large` over budget, so a per-feature string split cannot help.
- **Feature removal.** Dropping 15 of 16 optional features reaches 53,886 B. The
  largest tier that actually fits, measured feature by feature, is **23 of 32**
  (drop the Scripting pair, the Terminal cluster, the IDE-R cluster and
  `AuditLog` — 64,306 B); 22 features gives 62,132 B with headroom. That is a
  change to `TIERS.large` in `packages/build-system/src/features.ts`, which
  removes pages from the default build, so it is left to an explicit product
  decision rather than applied here.

**Chunked (multi-file) delivery is not available either.**
`packages/build-system/src/amt-loader.ts:36-37` defines
`CONSOLE_NAMES = ['index.htm', 'logon.htm']` and warns at line 504 that any other
entry "would be stored but never shown"; `build-firmware.ts` hard-fails if any
external reference survives inlining. Nothing in the repo — code, mock, captured
corpus, or CI — ever fetches a user-flash-served sibling asset, so multi-file
serving is **unverified**. One hardware probe decides it: install `index.htm`
plus a second entry, then `GET http://<amt>:16992/<entry>` with digest and see
whether the device serves it.


## Put it on a device

The promo site's picker is the shortest route here: choose features and a theme,
paste the AMT address, and it prints exactly the `install` line below with your
selection baked in, ready to paste into the checkout. The picker itself compiles
nothing -- the command it hands you is the same one you would type.

Two ways to flash, depending on what you have access to.

**From the device's own page.** Build a console that includes the installer:

```sh
bun run cli build --features Desktop,InstallFromWeb --name installer
bun run cli install --host 10.0.0.1 -u admin -p secret --name installer
```

Flash that once (through a machine that can reach the device, or by uploading the
artifact through AMT's own storage page). Afterwards the console has an "Install
from web" page: paste the URL of the artifact you actually want there, press
Install, and it writes itself into user flash and reloads. That is the only way
to install a console from a device you can only reach through a browser.

**From this machine.** `install` uploads an artifact over WSMAN, building it
first if it does not exist yet:

```sh
bun run cli install --host 10.0.0.1 -u admin -p secret --name small
bun run cli install --host 10.0.0.1 -u admin -p secret --out /tmp/console.htm.gz
```

`--name` and `--out` reuse an artifact you have already built rather than
rebuilding it; `--tls` uses the HTTPS port (16993). The upload deletes the
existing entry first and writes in 8 KiB blocks, halving the block size when the
device answers 400 or 500 -- AMT's HTTP server resets connections under a tight
write loop, and the device's user-flash budget is the limit that actually stops
you.

If the device's web server is already serving a console, replace it by writing to
`index.htm`; that is what the default path does.

## Develop

```sh
bun run mock       # mock AMT device on :8765, replaying captured responses
bun run console    # console dev server, proxies /wsman to the mock
bun run site       # the promo site (builds the demo console first)
bun run typecheck  # tsc -b across every workspace
bun run test       # bun test: the feature manifest's gating contract
```

The mock speaks enough of AMT to walk the pages -- including the redirection
WebSocket, so the KVM viewer shows a real framebuffer and the SOL terminal a real
banner -- without hardware.

The promo site's screenshots are committed assets, captured the same way:

```sh
bun run --cwd apps/site shots          # rewrites apps/site/public/shots/{light,dark}/
```

It starts its own mock and console dev server (on `SHOTS_PORT`, default 5173),
drives the pages with Playwright and shoots every page in both colour schemes,
so re-run it whenever the console's chrome changes -- a stale screenshot is a
product claim the build no longer makes. It needs Playwright's Chromium once:
`bunx playwright install chromium`. Only the five pages listed in
`apps/site/scripts/shots.ts` are shot; add a page there and it appears in the
carousel.

## Troubleshooting

- `unknown feature "X"` -- ids are exact and some are legacy names with hyphens
  (`Desktop-Multi`, `Terminal-Enumation-All`). `bun run cli features` lists them
  all.
- The small preset no longer fits -- turn features off; the picker prices each
  one, and `bun run cli measure` refreshes those prices after a code change.
- The promo site shows far fewer bytes for a theme than the CLI builds -- its
  table has no measurement for that theme, so it fell back to another one's
  numbers. Re-run `bun run cli measure` (no `--theme`) and rebuild the site.
- `401` from a device -- wrong credentials, or the account is not enabled for
  remote access on that device.
- The upload stops with `400` or `500` -- the device refused the block size or
  the write rate. Both the loader and the in-console installer halve the block
  and retry; if it still fails, the artifact is larger than the device's free
  user flash.
- The redirection pages (KVM, SOL, IDE-R) report the port is busy -- AMT allows
  one redirection session at a time, and another console (or a stale session on
  the device) is holding it.
