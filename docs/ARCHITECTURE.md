<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Architecture

Status: **step 1 + player + settings + cosmetic layer + watchdog**
(2026-11-12). The last three were listed as **[DEFERRED]** on 2026-11-11 and
have since landed; this table is checked against the source tree, not against
the plan. Anything still absent is called out rather than marked done.

## Module map

| Layer | Location | Responsibility |
|---|---|---|
| L1 Network blocking | `rust/src/engine.rs`, `ffi_c.rs`, `ffi_jni.rs` | `adblock =0.13.5` behind `RwLock<State>`; scalar `checkRequest(url, sourceUrl, requestType)` |
| L1 Kotlin binding | `app/.../nativebridge/AdBlockBridge.kt`, `core/AdBlockEngine.kt`, `core/RequestTypeMapper.kt` | JNI bridge, one engine per process, WebView type → uBO type |
| L1 interception | `player/ShieldWebViewClient.kt` | `shouldInterceptRequest`, empty-body `WebResourceResponse`, `BlockLog` |
| L2 Scriptlets | `rust` `url_cosmetic_resources().injected_script`, `assets/js/shieldtube-shim.js`, `core/InjectedScript.kt` | one `addDocumentStartJavaScript` script, fetch/XHR patch, `ytInitialPlayerResponse` |
| L3 Cosmetic | `core/AdBlockEngine.cosmeticFor()`, `core/CosmeticScript.kt`, `assets/js/shieldtube-cosmetic.js` | JSON-out cosmetic resources -> one `<style>` element, procedural-action evaluator, 250 ms debounced MutationObserver; re-applied on SPA URL changes |
| L4 Watchdog | `assets/js/shieldtube-watchdog.js` (inside the single document-start script) | 500 ms playback/ad-state tick, stall reporting, ad-segment seek (DOM overlay + <= 180 s only), SPA URL observer |
| Settings / licences | `settings/SettingsActivity.kt`, `settings/OpenSourceActivity.kt` | D-pad-only shields toggle, /tv vs mobile fallback, UA override, counters, manual list update, clear-data, GPLv3 + source screen |
| List updates | `core/ListUpdater.kt`, `core/ListPruner.kt` | opportunistic 24 h update of the six list groups into `filesDir/lists`, 2 MiB cap, parsed with `trusted=false` |
| Diagnostics | `core/BlockLog.kt` | 500-entry preallocated ring buffer, monotonic counters |
| Vendoring | `scripts/fetch-lists.sh`, `scripts/prune_lists.py`, `assets/lists/`, `assets/legal/` | pinned-SHA, checksummed, **1.14 MiB** payload (1,191,228 B; 2 MiB cap) |
| Toolchain | `scripts/bootstrap-toolchain.sh`, `rust-toolchain.toml` | Rust 1.99.1, NDK r27c, JDK 17, SDK 34 |

`vendor/adblock-rust-ffi/` is a reference-only vendor of the archived Brave C
FFI crate, never compiled or linked (see `VENDORED.md`).

## Data flow

```
startup
  ShieldTubeApp.onCreate -> WebView.setDataDirectorySuffix (API 28+)
  PlayerActivity.onCreate -> splash
     -> AdBlockEngine.initializeAsync (single background thread)
        -> assets/lists/*.txt + resources.json -> JSON payload
        -> JNI nativeCreate -> Rust FilterSet + Engine::use_resources
     -> main thread: create WebView, configure, register ONE document-start
        script (engine injected_script + shim), addJavascriptInterface
        -> loadUrl(https://www.youtube.com/tv)

per request
  WebView network thread -> shouldInterceptRequest
     -> RequestTypeMapper.map (Accept > extension > XHR marker)
     -> JNI nativeCheckRequest -> Rust Request::new(..,"get")
        -> Engine::check_network_request().should_block()
     -> false: return null (no allocation)
      true: BlockLog.record (preallocated slot) + empty 200 WebResourceResponse

per document
  addDocumentStartJavaScript (page world, before any page JS)
     -> adblock-rust scriptlets (already templated)
     -> shim: patch window.fetch / XHR / ytInitialPlayerResponse
     -> shim: Widevine probe -> JS bridge -> native notice
```

## Threading model

* **Main/UI thread**: WebView creation, `addDocumentStartJavaScript`,
  `addJavascriptInterface`, `loadUrl`, key handling, `onRenderProcessGone`
  recreation, all UI.
* **WebView network thread**: `shouldInterceptRequest`. Only a volatile handle
  read, one JNI call, and (on a hit) a preallocated ring-buffer write.
* **`shieldtube-engine` thread**: engine construction/rebuild, asset reads,
  `nativeCreate` / `nativeAddLists`. Results posted to the main `Handler`.
* **JS bridge thread**: `addJavascriptInterface` callbacks; UI work is posted
  to the main handler.
* `Engine` is `Send + Sync` because the crate's `single-thread` feature is
  disabled; `RwLock` allows concurrent reads and a serialized rebuild.
  Poisoned locks are recovered with `into_inner()` so a panic cannot wedge
  playback permanently.

## Failure modes explicitly handled

1. **Rust panic across FFI/JNI** — every one of the 11 C+JNI entry points is
   wrapped in `catch_unwind`; `panic = "unwind"` in both profiles. Safe
   defaults: `false`, `0`, `null`, `{}`.
2. **Player endpoint false positive** — `youtubei/v1/player` and `/next` are
   whitelisted in Rust before matching; tests assert this even with a rule
   that matches them.
3. **Wrong `requestType`** — explicit mapping from Accept/extension/XHR;
   unit tests prove `$script` rules do not match as `image`.
4. **Unparseable URL / invalid payload** — Rust fails open (`false`), Kotlin
   fails open, `nativeCreate` returns 0 and the splash reports it.
5. **Renderer death (OOM on 1 GB boxes)** — `onRenderProcessGone` recreates
   the WebView on the main thread and restores `currentUrl`.
6. **Missing `DOCUMENT_START_SCRIPT` feature** — feature check plus
   `onPageStarted` `evaluateJavascript` fallback.
7. **Missing origin rules** — both `https://www.youtube.com` and
   `https://m.youtube.com` are registered.
8. **POST bodies unreadable natively** — the `/youtubei/v1/player` cleanup is
   done in JS (`fetch`/XHR patch), never in `shouldInterceptRequest`.
9. **Widevine L3 / no EME** — shim probes `requestMediaKeySystemAccess` and
   `canPlayType`, reports to native, native shows a clear notice.
10. **Google OAuth in WebView** — `accounts.google.com` navigation is
    intercepted; activation-code flow (`youtube.com/activate`) is primary.
11. **External top-level navigation** — confirmation dialog before leaving
    YouTube hosts.
12. **`target=_blank` / popups** — `WebChromeClient.onCreateWindow` routes
    into the same WebView.
13. **Corrupt / changed vendored lists** — pinned commit SHAs, SHA-256 of every
    upstream blob, `CHECKSUMS.sha256` verification, and a re-run abort if a
    pinned blob's hash changes.
14. **Disk-backed toolchain preflight** — bootstrap refuses a <6 GiB target
    (this sandbox's `/tmp` is a 992 MB tmpfs; that failure happened and is
    fixed).
15. **Engine rebuild on list update** — rules are immutable in 0.13.5, so
    `addLists(replace=true)` rebuilds; on any failure the previous engine stays
    active.
16. **Airplane mode** — all lists + resources are bundled assets; no network
    needed for blocking (verified: 1,191,228 B = 1.14 MiB of lists + resources
    inside the APK; the 2 MiB cap has 0.86 MiB headroom).
17. **Memory** — one engine, one WebView, 500-slot preallocated log, splash
    removed after ready, WebView destroyed in `onDestroy`.

**Still not implemented (deliberately, not silently):** server-side ad
injection detection, D-pad DOM focus traversal pass inside the YouTube page
(the app's own screens are D-pad navigable), and per-app telemetry-free
diagnostics export.

Previously listed here as "not handled" but now implemented:
SPA-route cosmetic re-application (`PlayerActivity` `"url"` bridge message ->
`applyCosmetic`), the ad-state watchdog, the 24 h opportunistic list updater,
and the settings / open-source screens.

## Scriptlet coverage (status changed 2026-11-11 → fixed)

The original limitation — "`dist/resources.json` has only 17 Brave-specific
resources, so 109 referenced `+js()` names are dropped" — **no longer applies**.
`scripts/prune_lists.py` merges
`scripts/build_ubo_resources.py` output (generated from the pinned
`gorhill/uBlock` source with a pinned esbuild) into the bundled
`assets/lists/resources.json`.

Verified in this tree:

```
resources.json entries ............................ 98
distinct +js() names referenced by shipped lists ... 89
names with no matching resource entry .............. 0
SOURCES.json unresolvedScriptletReferences ........ []
SOURCES.json unresolvedRedirectReferences ......... []
```

`docs/SPEC-DEVIATIONS.md` §7b now carries a dated correction note; its prose is
kept as the historical record of the gap.

What the shim still owns: the load-bearing
`json-prune` / `trusted-replace-fetch-response` behaviour for the
`/youtubei/v1/player` response is implemented in `assets/js/shieldtube-shim.js`
(document-start fetch/XHR patch), not delegated to a scriptlet.

