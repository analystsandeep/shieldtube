<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Spec deviations, verified 2026-11-11

This file records every place the original brief was wrong or unachievable, and
what the code does instead. Sources were read, not assumed. Date uses the user's
local timezone (Asia/Calcutta).

## 1. adblock-rust has no `ffi` feature

`Cargo.toml` of `brave/adblock-rust` at version 0.13.5 declares:

```
default = ["embedded-domain-resolver", "full-regex-handling", "single-thread"]
debug-info, css-validation, content-blocking, embedded-domain-resolver,
resource-assembler, full-regex-handling, single-thread
```

There is no `ffi` feature and no cbindgen setup in the crate. cbindgen lived in
the separate, **archived** repository `brave/adblock-rust-ffi` (which had a
`cbindgen` feature, not `ffi`).

**What we do:** `rust/` is our own thin FFI crate. `build.rs` runs cbindgen over
`src/ffi_c.rs` only and writes `include/shieldtube.h`. Both a C ABI (`st_*`)
and a JNI ABI (`Java_*`) are produced from the same `cdylib`.

## 2. Vendored fork verdict (lead condition 1)

`vendor/adblock-rust-ffi/` contains the complete archived source. Its C ABI is
coherent for its era, but it is **genuinely unusable** here:

| Reason | Evidence |
|---|---|
| No JNI symbols at all | `src/lib.rs` exports only `engine_*` C functions; the consumer is `src/wrapper.cc` (C++). Kotlin `external fun` needs `Java_*` exports. |
| `panic = "abort"` in **both** profiles | `Cargo.toml`. `catch_unwind` cannot catch an abort, so §8's "wrap every FFI entry point" becomes impossible; a single `unwrap()` in the fork aborts the app. |
| Pins `adblock ~0.3.15` | Uses `Engine::from_filter_set`, `add_filter_list(&str, FilterFormat)`, `check_network_urls_with_hostnames_subset` — all removed/renamed by 0.13.5. No `procedural_actions`, no `PermissionMask`, no `Request::new(.., method)`. |
| Not JSON-in/JSON-out at the match call | `engine_match` takes nine out-pointers including `char **redirect`; the lead requires a scalar boolean network match and no hand-written struct ABI across four architectures. |
| Requires an external resolver | `set_domain_resolver(DomainResolverCallback)` must be called first, a C callback we cannot supply from Kotlin. 0.13.5's `embedded-domain-resolver` removes this requirement. |
| Old cosmetic schema | `engine_url_cosmetic_resources` serialises the pre-0.13 shape (`style_selectors`), i.e. exactly the field drift the lead warned about. |
| Unmaintained | Repository archived 2024-01-08; `Cargo.lock` is from 2021. |

We therefore vendor it as a **reference only** (never compiled, never linked)
and wrote a fresh wrapper. See `VENDORED.md`.

## 3. Licensing correction

`adblock-rust` is **MPL-2.0**, not MIT (`LICENSE`, `Cargo.toml`, README badge,
docs.rs all agree). `brave/adblock-lists` is MPL-2.0; `uBlockOrigin/uAssets`,
`gorhill/uBlock` and uBO scriptlets are GPL-3.0. "License the whole repo GPLv3"
is imprecise: MPL-2.0 §3.1 requires the covered source files to stay MPL-2.0,
while §3.3 permits the *larger work* to be distributed under GPLv3. Our own
code is GPL-3.0-or-later; vendored MPL files keep their own headers. See
`docs/LICENSING.md`.

## 4. API corrections against the exact pinned crate

Verified against the published crate `adblock-0.13.5.crate`
(sha256 `7a4c8558f27608dec74695c866f9a8ef897ec7a77cb826f8a5baf0b8ba461d2a`),
**not** the moving `master` branch:

| Brief | Reality |
|---|---|
| `set_resources` | `Engine::use_resources(&mut self, impl IntoIterator<Item = Resource>)` / `use_resource_storage`. |
| `style_selectors` | Does not exist. `UrlSpecificResources` = `hide_selectors`, `procedural_actions` (JSON-encoded), `exceptions`, `injected_script`, `generichide`. `rust/tests/engine_tests.rs::cosmetic_for_emits_the_pinned_0_13_5_schema` asserts this field set, including the absence of `style_selectors`. |
| "Implement scriptlet argument templating yourself" | Wrong. `patch_template_scriptlet()` in `resource_storage.rs` already replaces `{{1}}`..`{{9}}`; `get_scriptlet_resources()` returns ready-to-run JS. Re-substituting would be a no-op or corrupt args. `scriptlet_args_are_already_templated_by_adblock_rust` proves it. |
| `uBlockOrigin/.../assets/resources/scriptlets.js` | Path no longer exists; current uBO scriptlets are ES modules at `gorhill/uBlock/src/js/resources/scriptlets.js`. `adblock-rust`'s `assemble_scriptlet_resources()` is `#[deprecated]` and only parses the pre-2019 line format. We vendor `brave/adblock-resources/dist/resources.json` at a pinned SHA instead (same GPLv3 scriptlet lineage). |
| `brave-specific.txt` at repo root | It is `brave-lists/brave-specific.txt`. |
| uAssets "YouTube lists" | No `filters/youtube*.txt`; YouTube rules live in `filters/filters.txt`, `filters-2026.txt`, `unbreak.txt`, `quick-fixes.txt`. |

`rust/src/engine.rs` builds the cosmetic JSON field-by-field, so any future
field rename in the pinned crate is a **compile error**, not silent drift.

### Trust decision: `PermissionMask::from_bits(0xff)`

`rust/src/engine.rs` defines `FULL_TRUST = PermissionMask::from_bits(0xff)` and
assigns it to `ParseOptions.permissions` **only for lists with `trusted: true`**.

* adblock-rust stores a permission mask per parsed cosmetic rule, derived from
  `ParseOptions.permissions` (`lists.rs:484` → `CosmeticFilter::parse`).
* A `Resource` may require permission bits. Injection is allowed iff
  `resource.permission.is_injectable_by(filter_mask)`, implemented in
  `resources/mod.rs` as `!filter_mask.0 & self.0 == 0`. In words: every bit the
  resource requires must also be present on the rule.
* `0xff` therefore grants our rules all eight trust bits, which is what makes
  Brave/uBO **trusted** scriptlets (`trusted-replace-fetch-response`,
  `trusted-set-cookie`, …) injectable. Using the default `0` mask silently
  drops those scriptlets and would look like "the ad blocker stopped working".
* **Scope of the grant:** only lists vendored into the APK and covered by
  `app/src/main/assets/lists/CHECKSUMS.json` are sent with `trusted: true`.
  Opportunistic 24 h update downloads are sent with `trusted: false` (mask 0)
  because they are authenticated only by TLS + git-blob hash, not by a
  signature. This is the deliberate security boundary: a compromised upstream
  CDN cannot escalate itself into trusted-scriptlet territory.
* This is not a workaround for a bug; it is the API's intended mechanism, and
  it is why `Resource.permission` was added to adblock-rust.

## 5. Sign-in: primary, not a footnote (lead condition 4)

Google's OAuth policy forbids embedded user agents and returns
`403 disallowed_useragent` for `accounts.google.com` inside a WebView. So the
brief's "sign-in happens inside the WebView against Google's own pages" is not
achievable for direct Google OAuth.

**Primary flow:** YouTube `/tv` uses TV activation — the app shows the code, the
user visits `youtube.com/activate` on a phone/PC, and the resulting cookies
persist in the WebView profile across restarts (acceptance criterion 3). The
app does **not** attempt embedded OAuth at all. `PlayerActivity` intercepts
navigations to `accounts.google.com` and surfaces an in-app notice pointing at
the activation flow. This is documented in the settings screen once that screen
lands, and in `README.md` today.

## 6. User agent

`/tv` requires a TV UA; we pin **Cobalt/25**
(`Mozilla/5.0 (PS4; Leanback Shell) Cobalt/25.lts.40.1035033; compatible;`).
Cobalt/26 is known to break playback ~45 s into videos in 2026 (BotGuard).
`PlayerActivity` logs the UA actually in use at startup (assertion required by
the lead) and settings exposes a UA override.

## 7. Toolchain / build-order deviations

* Brief §10 step 1 asked for "one passing JVM test" before UI. The lead replaced
  this with: bootstrap the toolchain, `cargo ndk build` for all four ABIs, and
  `./gradlew assembleDebug` green in CI before UI. We do both: `cargo test`
  (Rust side) and `testDebugUnitTest` (JVM/JNI side).
* The sandbox has no Android SDK/NDK/Rust/JDK 17 preinstalled, so
  `scripts/bootstrap-toolchain.sh` installs them. Its `SHIELDTUBE_RUST_TOOLCHAIN`
  default is **1.99.1**, matching `rust-toolchain.toml` (lead fix 3a).
* `/tmp` in this environment is a 992 MB tmpfs; the bootstrap has a 6 GiB disk
  preflight and defaults to `$HOME/.cache/shieldtube-tc`.

## 7a. Lead fixes applied (2026-11-11)

* **(a)** `scripts/bootstrap-toolchain.sh` sets
  `SHIELDTUBE_RUST_TOOLCHAIN="${SHIELDTUBE_RUST_TOOLCHAIN:-1.99.1}"`, matching
  `rust-toolchain.toml` `channel = "1.99.1"`. There was no earlier version of
  the script in this session with a `stable` default; it was created correct.
  `bash -n` passes; the bootstrap ran successfully and printed
  `rustc 1.99.1 (58cf8f9c3 2026-10-13)`.
* **(b)** The `PermissionMask::from_bits(0xff)` trust decision is documented in
  **§4 above** ("Trust decision: `PermissionMask::from_bits(0xff)`"), including
  the exact `!filter_mask.0 & self.0 == 0` check, why mask 0 would silently
  drop trusted scriptlets, and why the grant is limited to bundled,
  checksum-verified lists. It is implemented in `rust/src/engine.rs`
  (`FULL_TRUST`, `opts.permissions`) and `core/AdBlockEngine.kt`
  (`"trusted":true`).

## 7b. Scriptlet resource gap (recorded, not hidden)

`brave/adblock-resources/dist/resources.json` at pinned SHA
`6da9b247c3368baa8b4f24cd02046e18702a6527` contains only **17** Brave-specific
resources. The pruned uBO/EasyList rules reference **109** `+js()` names that
are not in that set (`json-prune-fetch-response`,
`trusted-replace-xhr-response`, `set-constant`, …). `adblock-rust`'s
`get_scriptlet_resources()` skips resources it cannot resolve, so those
scriptlets are not injected. `assets/lists/SOURCES.json` records every
unresolved name. The load-bearing `json-prune` /
`trusted-replace-fetch-response` behaviour is implemented in our own
`assets/js/shieldtube-shim.js` (document-start `fetch`/XHR patch), which is why
the app does not depend on those resources for ad-metadata stripping. A
converter from uBO's ES-module `src/js/resources/scriptlets.js` (vendored
verbatim under `assets/legal/`, GPLv3 source compliance) is future work.

The old-format `assemble_scriptlet_resources()` in adblock-rust is
`#[deprecated]` and cannot parse current uBO ES modules, so it is not used.

## 7c. CI gates caught a real minSdk-23 bug (2026-11-11)

The first local `lintDebug` after the toolchain rebuild failed with exactly one
error: `PlayerActivity.kt:249: Call requires API level 26 (current min is 23):
android.webkit.RenderProcessGoneDetail#didCrash [NewApi]`. The renderer-gone
callback itself only fires on API 26+, but its `detail.didCrash()` call was
unguarded. This was fixed with an explicit `Build.VERSION.SDK_INT >= O` check,
not with a lint suppression or a minSdk change. The existing
`WebViewFeature.DOCUMENT_START_SCRIPT` guard was also made directly visible to
lint's `RequiresFeature` analysis. Re-running `lintDebug` produced **0 errors**.
The full local CI sequence (`cargo fmt --check`, `cargo clippy -D warnings`,
`cargo test`, checksum verification, four-ABI Rust build, `lintDebug`,
`testDebugUnitTest`, both APK builds, `apksigner verify`) is green. GitHub
Actions itself has not been runner-validated.

## 8. Remaining work per the 2026-11-11 priority change

Settings screen, cosmetic layer, ad-state watchdog and in-app "Open source"
screen come **after** the first `app-debug.apk` assembles. The CI workflow and
instrumented smoke-test source now exist; only GitHub Actions runner validation
and a real-device connected test remain. They are listed as TODOs in
`README.md` and are not silently omitted.

## 9. Corrections that were ours, not the brief's

Two errors in the original spec were acknowledged by the user as theirs:
`adblock-rust` is MPL-2.0 (not MIT), and scriptlet template patching is already
done inside the engine. Both are implemented as described above.
