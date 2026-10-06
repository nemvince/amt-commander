MeshCommander
=============

*** Intel has discontinued support for this tool. Please contact Intel support for alternatives ***

MeshCommander is an Intel(R) Active Management Technology (Intel(R) AMT) remote
management tool: a hardware-KVM remote desktop viewer, a Serial-over-LAN
terminal, IDE-Redirection and much more. It is built on web technologies and runs
on many platforms, and it is deliberately space efficient so that it can be
uploaded into Intel AMT flash space and served by the device's own web server.

This repository is a from-scratch rewrite of the console as a TypeScript/Preact
application, together with everything needed to ship it as a product:

| Path | What it is |
|---|---|
| `apps/console` | The console itself. One Vite build per feature selection, inlined and zopfli-compressed into a single `.htm.gz` small enough for AMT user flash. |
| `apps/site` | The promo site: screenshots, a feature picker with live measured sizes, a theme gallery, a replayed live demo, and the exact CLI command that builds and flashes your selection. It never builds a *custom* artifact — the only thing it compiles is its own demo console, at build time. |
| `packages/build-system` | The feature manifest, the theme registry, the size estimator, the AMT loader and the CLI/TUI picker that builds and flashes. The only thing in the repository that produces an artifact. |
| `packages/mock` | A mock AMT device for development: real captured WSMAN responses, a canned redirection session, and the export that the site's demo replays. |

Everything is a Bun workspace; `bun install` once at the root is all the setup
there is.

```
bun run build        # every workspace: one console artifact (default selection)
                     # plus the promo site, including its demo console
bun run typecheck    # tsc -b across the workspace
bun run console      # the console dev server (proxies /wsman to the mock)
bun run mock         # the mock AMT device on :8765
bun run site         # the promo site dev server
```

Building a custom console — pick features, see what they cost, build it, flash
it — is one command, and it is the same command the promo site hands you:

```
bun run cli                                    # interactive picker
bun run cli build --features Desktop,Terminal,IDER --theme midnight
bun run cli install --host 10.0.0.1 -u admin -p secret --name small
```

Sizes shown by the picker are measurements, never guesses: `bun run cli measure`
runs real builds and records them in `apps/console/build/.size-cache.json`.
The full walkthrough, from first build to flashing a device, is in
[docs/building.md](docs/building.md).

The screenshots on the site and the demo console inside it are generated the same
way and committed: `bun run --cwd apps/site shots` re-captures the shots against
the mock device, and `bun run --cwd apps/site build` rebuilds the demo. Both are
worth re-running after a change to the console's chrome.


Background
----------

The released MeshCommander — the MSI installer, the NPM package, the firmware
installer and MeshCMD — is still published at
[MeshCommander.com](https://www.meshcommander.com/meshcommander). Its console is
the application this repository reimplements.


Tutorials
---------

There are plenty of [tutorial videos here](https://www.meshcommander.com/meshcommander/tutorials).

Introduction to MeshCommander.  
[![MeshCommander - Introduction](https://img.youtube.com/vi/k7xVkZSVY0E/mqdefault.jpg)](https://www.youtube.com/watch?v=k7xVkZSVY0E)


License
-------

This software is licensed under [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0).
