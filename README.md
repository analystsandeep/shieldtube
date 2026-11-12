<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# ShieldTube

An ad-blocking YouTube client for Android TV / Google TV. A `WebView` pointed
at `youtube.com/tv` plus an on-device adblock engine (Rust / `adblock-rust`),
document-start scriptlets, cosmetic filtering and an ad-state watchdog. No
proxy, no VPN, no DNS trick, no backend, no telemetry.

**Status (2026-11-11, refreshed after toolchain rebuild):** step 1 + minimal
player complete. `cargo fmt`, `cargo clippy -D warnings`, 10 Rust tests, 2
JVM/JNI tests, bundled-list checksums, four Rust `cdylib`s, `lintDebug` (0
errors), `assembleDebug`, `assembleRelease` and `apksigner verify` are all green.
The GitHub Actions workflow has now been runner-validated: run #1 failed on a
bad `sdkmanager` path (fixed in `ff0ceba`). The local equivalent of every gate
is green. The settings screen, cosmetic layer, watchdog and in-app "Open
source" screen all exist (they were listed here as deferred until 2026-11-12).

Verified outputs (regenerated in this sandbox, not distributable):
`app/build/outputs/apk/debug/app-debug.apk` (18,008,806 B) and
`app/build/outputs/apk/release/app-release.apk` (15,615,335 B, debug-signed,
GPLv3 uBO source tree excluded — see `docs/LICENSING.md`). `apks/` holds only a
README: APK binaries are not committed, because `.gitignore` has `*.apk`.

> Sandbox note: `.git/`, `.cache/` (toolchain) and `app/build/` are excluded from
> workspace snapshots, so after a turn boundary the toolchain and APK must be
> regenerated with `scripts/bootstrap-toolchain.sh` and `./gradlew assembleDebug`.
> The `apks/` copies are kept outside `app/build/` so they remain downloadable;
> a real git clone keeps the executable bit on `gradlew`.

## Sign-in (read this first)

Google blocks OAuth inside embedded WebViews (`403 disallowed_useragent`).
ShieldTube does **not** attempt embedded OAuth. Use the TV activation flow:
open the app, note the code shown on the TV screen, visit
**https://www.youtube.com/activate** on a phone or computer, enter the code.
Cookies persist in the WebView profile across restarts. Clearing app data
signs you out again.

## Build

```bash
bash scripts/bootstrap-toolchain.sh         # Rust 1.99.1, JDK 17, SDK 34, NDK r27c
. "$HOME/.cache/shieldtube-tc/env.sh"
cargo test --manifest-path rust/Cargo.toml   # step-1 gate
bash scripts/build-rust.sh                   # four ABIs -> app/src/main/jniLibs/
./gradlew assembleDebug                      # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease                   # signed (see docs/BUILD.md)
```

`scripts/bootstrap-toolchain.sh` defaults `SHIELDTUBE_RUST_TOOLCHAIN=1.99.1`,
matching `rust-toolchain.toml`.

## Layout

| Path | Contents |
|---|---|
| `rust/` | FFI crate: `engine.rs`, `ffi_c.rs`, `ffi_jni.rs`, cbindgen header, tests |
| `vendor/adblock-rust-ffi/` | Archived Brave FFI fork, vendored as reference (see `VENDORED.md`) |
| `app/` | Android TV app |
| `scripts/` | Toolchain, list vendor, native build, signing helpers |
| `docs/` | `ARCHITECTURE.md`, `BUILD.md`, `LICENSING.md`, `SPEC-DEVIATIONS.md` |

## Licensing

GPL-3.0-or-later for our code. `adblock-rust` is **MPL-2.0** (not MIT),
`brave/adblock-lists` is MPL-2.0, uBlock Origin's lists and scriptlets are
GPL-3.0. Vendored MPL files keep their MPL headers. See `docs/LICENSING.md`.

## Remaining work (lead priority change, 2026-11-11)

- Replace the `SOURCE_URL` placeholder before any public distribution
  (`docs/LICENSING.md`).
- Per-list attribution + checksum display in the Open source screen
  (`SOURCES.json` and `CHECKSUMS.sha256` ship but are not rendered).
- Connected instrumented smoke test on real hardware (source exists;
  `docs/ON-DEVICE-TEST.md` is the manual checklist).
- Real-device acceptance run on an ARM TV box.
- D-pad DOM focus traversal inside the YouTube page.

Done and removed from this list on 2026-11-12: settings screen, cosmetic layer,
ad-state watchdog, in-app "Open source" screen, generic uBO scriptlet coverage
(`SOURCES.json` unresolvedScriptletReferences is empty), GitHub Actions runner
validation.
