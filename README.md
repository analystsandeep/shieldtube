<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# ShieldTube

An ad-blocking YouTube client for Android TV / Google TV. A `WebView` pointed
at `youtube.com/tv` plus an on-device adblock engine (Rust / `adblock-rust`),
document-start scriptlets, cosmetic filtering and an ad-state watchdog. No
proxy, no VPN, no DNS trick, no backend, no telemetry.

**Status (2026-11-11, refreshed after toolchain rebuild):** step 1 + minimal
player complete. `cargo fmt`, `cargo clippy -D warnings`, 9 Rust tests, 2
JVM/JNI tests, bundled-list checksums, four Rust `cdylib`s, `lintDebug` (0
errors), `assembleDebug`, `assembleRelease` and `apksigner verify` are all green.
The GitHub Actions workflow is written and its local equivalents pass, but it
has not been runner-validated. Settings / cosmetic layer / watchdog / in-app
"Open source" screen remain deferred per the project lead's priority change.

Verified outputs (regenerated in this sandbox, not distributable):
`apks/app-debug.apk` (17,640,988 B) and
`apks/app-release.apk` (15,522,295 B, debug-signed). Their canonical Gradle
outputs are `app/build/outputs/apk/debug/app-debug.apk` and
`app/build/outputs/apk/release/app-release.apk`.

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

- Settings screen (Shields toggle, list update, UA override, counters, open
  source, clear data) — including the user-facing activation-flow notice.
- Cosmetic layer and ad-state watchdog (the document-start shim and network
  blocking land with the minimal player).
- In-app "Open source" screen; `docs/LICENSING.md` still contains a
  `SOURCE_URL` placeholder that must be replaced before public distribution.
- Generic uBO scriptlet coverage (`docs/SPEC-DEVIATIONS.md` §7b).
- GitHub Actions runner validation (the workflow and local gates exist).
- Connected instrumented smoke test on real hardware (the test source exists).
- Real-device §9 acceptance run (lead confirmed a real ARM TV box is available).
