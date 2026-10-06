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
git clone https://github.com/nemvince/meshcommander-rewrite
cd meshcommander-rewrite
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
