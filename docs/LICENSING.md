<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Licensing

**ShieldTube's own code is GPL-3.0-or-later.** The full text is in `LICENSE`.

This is the correct compliance path, not a workaround: uBlock Origin's scriptlet
resources are GPLv3, so any APK that embeds them (or JS derived from them) must
be distributed under GPLv3 with corresponding source. We do not fight this.

## Source offer

`SOURCE_URL` — **replace this placeholder with the public repository URL before
distributing the APK**:

```
https://github.com/<owner>/shieldtube
```

The GPLv3 source offer must be reachable from the app. The in-app "Open source"
screen (`settings/OpenSourceActivity.kt`) now exists and shows the
`BuildConfig.SOURCE_URL`, the component table and the GPLv3 text read from
`assets/legal/LICENSE.txt`. **Do not ship a public release until the real
`SOURCE_URL` replaces the placeholder** — the screen renders the placeholder in
yellow and refuses to navigate.

### What a RELEASE APK actually packages (measured 2026-11-12)

| Asset | Release APK | Debug APK |
|---|---|---|
| `legal/LICENSE.txt` (GPLv3 text) | **yes** — read by OpenSourceActivity | yes |
| `lists/**` (pruned lists + resources.json) | yes (1.14 MiB) — read by the engine | yes |
| `js/**` (shim, cosmetic, watchdog) | yes — read at document start | yes |
| `legal/ubo/**` + `legal/ubo-scriptlets.js` (verbatim uBO source, 643,659 B, 91 entries) | **no** | yes |

`mergeReleaseAssets.doLast` in `app/build.gradle.kts` drops the verbatim uBO
source tree from the release APK: no runtime code opens it, and GPLv3 §6 is
satisfied by this repository, which is where it is actually useful. Measured
effect: release APK 15,819,196 → **15,615,335 bytes** (−203,861). Debug APKs
keep the tree so the packaged bytes can be diffed against
`assets/legal/ubo/SHA256SUMS`. The scripts/ list-side corresponding source
(`scripts/fetch-lists.sh` pins + `SOURCES.json`) is unchanged.

## What is bundled and under which licence

| Component | Licence | Where | Notes |
|---|---|---|---|
| Our Kotlin / Gradle / Rust wrapper / JS shim | GPL-3.0-or-later | `app/`, `rust/`, `scripts/`, `docs/` | Copyright 2026 ShieldTube contributors |
| `brave/adblock-rust` `=0.13.5` | **MPL-2.0** (not MIT — see `SPEC-DEVIATIONS.md` §3) | Cargo dependency, statically linked into `libshieldtube.so` | Source: https://github.com/brave/adblock-rust |
| `brave/adblock-lists` (pinned `a190fe0…`) | MPL-2.0 | `assets/lists/brave-specific.txt`, `brave-unbreak.txt` | Source: https://github.com/brave/adblock-lists |
| `brave/adblock-resources` `dist/resources.json` (pinned `6da9b24…`) | MPL-2.0, **contains uBO-derived GPL-3.0 scriptlets** | `assets/lists/resources.json` | Source: https://github.com/brave/adblock-resources |
| `uBlockOrigin/uAssets` (pinned `9f1bcde…`) | GPL-3.0 | `assets/lists/ubo-filters.txt`, `ubo-unbreak.txt` | Source: https://github.com/uBlockOrigin/uAssets |
| `easylist/easylist` (pinned `6282f2d…`) | GPL-3.0 | `assets/lists/easylist-core.txt`, `easyprivacy-core.txt` | Source: https://github.com/easylist/easylist ; canonical lists at https://easylist.to |
| `gorhill/uBlock` `src/js/resources/scriptlets.js` (pinned `2bc679d…`) | GPL-3.0 | `assets/legal/ubo-scriptlets.js` (verbatim) | Source: https://github.com/gorhill/uBlock |
| `brave/adblock-rust-ffi` (pinned `5382a06…`) | MPL-2.0 | `vendor/adblock-rust-ffi/` — **reference only, not compiled or linked into the APK** | Source: https://github.com/brave/adblock-rust-ffi |
| AndroidX / Kotlin stdlib | Apache-2.0 | Gradle dependencies | https://developer.android.com/jetpack |

## MPL-2.0 nuance (important)

"License the whole repo GPLv3" is imprecise. MPL-2.0 §3.1 requires the covered
source files to remain under MPL-2.0, while §3.3 permits distributing the
*larger work* under GPLv3 (MPL-2.0 lists GPLv2/GPLv3 as Secondary Licences).
Accordingly:

* Our own files carry `SPDX-License-Identifier: GPL-3.0-or-later`.
* Vendored MPL files keep their original headers (`vendor/adblock-rust-ffi/LICENSE`
  is retained verbatim; MPL-2.0 source for the linked crate is available from
  the upstream URL above and from the `Cargo.lock` pin).
* We do not relicense MPL-covered source.
* The APK as a whole is offered under GPL-3.0-or-later, with the MPL-2.0
  covered source made available under MPL-2.0 as required.

The pruned lists are derivative works of their upstreams; `SOURCES.json`
records the exact commit SHA, upstream path, upstream SHA-256 and licence for
every one, so the "corresponding source" of a shipped list is reproducible via
`scripts/fetch-lists.sh`.

## In-app notices — status

* "Open source" screen: **implemented** (`settings/OpenSourceActivity.kt`) —
  component table, GPLv3 text from assets, `BuildConfig.SOURCE_URL`.
* Per-list attribution and checksum display: **still missing**; `SOURCES.json`
  and `CHECKSUMS.sha256` ship in the APK but nothing renders them.
* No telemetry, analytics or crash reporter is included (hard constraint).
