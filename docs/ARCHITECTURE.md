<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Architecture

Status: **step 1 + minimal player** (2026-11-11). Settings, cosmetic layer and
ad-state watchdog are deferred by the project lead until after the first APK.
Deferred items are marked **[DEFERRED]**.

## Module map

| Layer | Location | Responsibility |
|---|---|---|
| L1 Network blocking | `rust/src/engine.rs`, `ffi_c.rs`, `ffi_jni.rs` | `adblock =0.13.5` behind `RwLock<State>`; scalar `checkRequest(url, sourceUrl, requestType)` |
| L1 Kotlin binding | `app/.../nativebridge/AdBlockBridge.kt`, `core/AdBlockEngine.kt`, `core/RequestTypeMapper.kt` | JNI bridge, one engine per process, WebView type → uBO type |
| L1 interception | `player/ShieldWebViewClient.kt` | `shouldInterceptRequest`, empty-body `WebResourceResponse`, `BlockLog` |
| L2 Scriptlets | `rust` `url_cosmetic_resources().injected_script`, `assets/js/shieldtube-shim.js`, `core/InjectedScript.kt` | one `addDocumentStartJavaScript` script, fetch/XHR patch, `ytInitialPlayerResponse` |
| L3 Cosmetic | `core/AdBlockEngine.cosmeticFor()` + `core/InjectedScript.kt` (scriptlets only) | JSON-out cosmetic resources **[DEFERRED: CSS `<style>` + MutationObserver]** |
| L4 Watchdog | — | **[DEFERRED]** |
| Diagnostics | `core/BlockLog.kt` | 500-entry preallocated ring buffer, monotonic counters |
| Vendoring | `scripts/fetch-lists.sh`, `scripts/prune_lists.py`, `assets/lists/`, `assets/legal/` | pinned-SHA, checksummed, 0.97 MiB payload |
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
    needed for blocking (verified: 0.97 MiB shipped in the APK).
17. **Memory** — one engine, one WebView, 500-slot preallocated log, splash
    removed after ready, WebView destroyed in `onDestroy`.

**Not yet handled (deferred):** SPA-route cosmetic re-application, ad-state
watchdog, server-side ad injection detection, 24 h opportunistic list updates,
settings screen / open-source screen, D-pad DOM focus traversal pass.

## Known limitation (not silently hidden)

`brave/adblock-resources/dist/resources.json` contains only 17 Brave-specific
resources. The vendored uBO lists reference 109 scriptlet names that are not in
that set (recorded in `assets/lists/SOURCES.json`). Those scriptlets cannot be
injected by adblock-rust. The load-bearing `json-prune` /
`trusted-replace-fetch-response` behaviour is implemented in our own
document-start shim instead. A converter from uBO's ES-module
`src/js/resources/scriptlets.js` (vendored under `assets/legal/`) is future
work.
