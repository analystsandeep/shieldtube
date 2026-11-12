<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Documentation drift report — 2026-11-12

Produced while reconciling `docs/ARCHITECTURE.md`, `docs/BUILD.md`, `README.md`,
`docs/LICENSING.md` and `docs/SPEC-DEVIATIONS.md` against the source tree.
Everything here was verified by reading code, listing the APK, or running a
build — not by inference.

## Fixed in this pass

| # | Where | Claim | Reality |
|---|---|---|---|
| 1 | `README.md:10`, `docs/BUILD.md:39,114` | "9 tests" / "9 passed" | 10 tests. Fixed. |
| 2 | `docs/ARCHITECTURE.md:5,16,17` | Cosmetic layer and watchdog marked **[DEFERRED]** | Both implemented (`core/CosmeticScript.kt`, `assets/js/shieldtube-cosmetic.js`, `assets/js/shieldtube-watchdog.js`). |
| 3 | `docs/ARCHITECTURE.md:19,107` | assets payload "0.97 MiB" | 1,191,228 B = **1.14 MiB** (measured byte sum of the 7 payload files). |
| 4 | `docs/ARCHITECTURE.md:111` | "Not yet handled: SPA cosmetic re-application, watchdog, 24 h list updates, settings/open-source screens" | All four exist. `PlayerActivity` `"url"` bridge message → `applyCosmetic`. |
| 5 | `docs/ARCHITECTURE.md:117`, `docs/SPEC-DEVIATIONS.md §7b` | "17 Brave resources, 109 unresolved `+js()` names" | Stale. 98 resource entries; 89 distinct `+js()` names referenced; **0** unresolved (`SOURCES.json` `unresolvedScriptletReferences: []`). |
| 6 | `docs/LICENSING.md:20` | Open source screen **[DEFERRED]** | `settings/OpenSourceActivity.kt` exists and renders `BuildConfig.SOURCE_URL` + `assets/legal/LICENSE.txt`. |
| 7 | `docs/LICENSING.md`, in-app string | "complete uBO source is bundled under `assets/legal/ubo/`" | True for debug APKs only. Release APKs now exclude it (see `mergeReleaseAssets.doLast`); GPLv3 §6 is met by the repository. LICENSING.md now states this per artefact. **`res/values/strings.xml` `open_source_body` still says "bundled" — see open item O4.** |
| 8 | `docs/BUILD.md:117-125` | APKs at `apks/app-debug.apk` / `apks/app-release.apk` with old sizes | `apks/` contains only `README.md`; `.gitignore` line 10 is `*.apk`. Corrected to the canonical `app/build/outputs/apk/**` paths and this session's real sizes. |
| 9 | `README.md:12-16` | "Open source screen remains deferred"; "workflow not runner-validated" | Screen exists; CI has now run (run #1 failed on the `sdkmanager` path, fixed in `ff0ceba`). |

## Open items found, deliberately NOT changed in this pass

Each one needs a decision or a code change beyond a doc edit; none is silently
fixed.

| # | What | Why it needs a decision |
|---|---|---|
| O1 | `README.md` / `docs/BUILD.md` imply a fresh clone builds offline: "Airplane mode — all lists + resources are bundled assets; no network needed for blocking". | True for BLOCKING at runtime; false for BUILDING. A first build downloads the Gradle distribution, ~40 crates, the Android SDK/NDK. The wording is about the app, but it reads as a build guarantee. |
| O2 | `gradle.properties` sets `-Xmx1200m`; `docs/BUILD.md` documents `-Xmx768m` for this sandbox. | Both are legitimate for different hosts, but the doc should say which is authoritative where. Left as documented guidance rather than changed code. |
| O3 | `docs/BUILD.md` says the `.so` files are "packaged unstripped" and suggests `android.ndkPath`. | Real warning, reproduced (`stripDebugDebugSymbols` → "Unable to strip … libshieldtube.so"). No functional impact; fixing it would change packaging, so it stays a documented tradeoff. |
| O4 | `res/values/strings.xml` `open_source_body` tells the user "The complete corresponding uBO source is bundled under `assets/legal/ubo/`". | After the release-asset change this is false in a release APK. Fixing it means reworking the in-app attribution text (a user-visible string) and deciding whether the app should say "in the source repository" instead. Needs the lead's wording decision. |
| O5 | `docs/ON-DEVICE-TEST.md` (new) — no automated equivalent exists for the manual checklist. | By design; instrumented tests need hardware. |
| O6 | `scripts/fetch-lists.sh` re-run is claimed deterministic; only the CHECKSUMS verify is exercised in CI. | A full re-vendor run needs network to `raw.githubusercontent.com` at 5 pinned SHAs. Not run in this pass; the pinned blobs and `SOURCES.json` were verified intact instead. |

## Verified-unchanged (checked, no drift)

* `scripts/verify-checksums.sh` → all 7 list checksums + 89 uBO source files OK.
* `SOURCES.json` `outputs[*].bytes` match the files on disk exactly.
* `rust/include/shieldtube.h` matches `rust/src/ffi_c.rs` (6 symbols; 11 exports per ABI including the 5 `Java_*`).
* `.github/workflows/ci.yml` step list matches `docs/BUILD.md`'s described gate order, except for the `sdkmanager` path (fixed).
