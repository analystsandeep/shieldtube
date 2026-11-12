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

## Open items — all six resolved 2026-11-12

O1, O2 and O4 were fixed after the lead's decisions; O3 stays a documented
tradeoff; O5 and O6 were accepted as-is. Kept below with their resolution so the
history is auditable.

| # | What | Why it needs a decision |
|---|---|---|
| O1 | ~~`README.md` / `docs/BUILD.md` imply a fresh clone builds offline~~ | **FIXED 2026-11-12** (`docs/ARCHITECTURE.md` §16 + new "Network needed to build" in `docs/BUILD.md`): the claim is now explicitly scoped to runtime blocking of an installed app. |
| O2 | ~~`gradle.properties` sets `-Xmx1200m`; `docs/BUILD.md` documents `-Xmx768m`~~ | **FIXED 2026-11-12**: `docs/BUILD.md` now names `gradle.properties` (-Xmx1200m) as the committed default and `-Xmx768m` as sandbox command-line guidance only. |
| O3 | `docs/BUILD.md` says the `.so` files are "packaged unstripped" and suggests `android.ndkPath`. | **NO ACTION (lead decision 2026-11-12)**: real warning, reproduced; documented tradeoff stays documented. |
| O4 | ~~`res/values/strings.xml` `open_source_body` promises "bundled under `assets/legal/ubo/`"~~ | **FIXED 2026-11-12** (commit `448ad09`): now points at the source repository and names only `SOURCES.json` (verified present in the release APK). Wording is order-independent because the URL row renders below the body. Compiled string verified with `aapt2 dump strings`. |
| O5 | `docs/ON-DEVICE-TEST.md` (new) — no automated equivalent exists for the manual checklist. | **ACCEPTED as-is (lead decision 2026-11-12)**; instrumented tests need hardware. |
| O6 | `scripts/fetch-lists.sh` re-run is claimed deterministic; only the CHECKSUMS verify is exercised in CI. | **ACCEPTED as-is (lead decision 2026-11-12)**; the pinned blobs and `SOURCES.json` were verified intact instead. |

## Verified-unchanged (checked, no drift)

* `scripts/verify-checksums.sh` → all 7 list checksums + 89 uBO source files OK.
* `SOURCES.json` `outputs[*].bytes` match the files on disk exactly.
* `rust/include/shieldtube.h` matches `rust/src/ffi_c.rs` (6 symbols; 11 exports per ABI including the 5 `Java_*`).
* `.github/workflows/ci.yml` step list matches `docs/BUILD.md`'s described gate order, except for the `sdkmanager` path (fixed).
