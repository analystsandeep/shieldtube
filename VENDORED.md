<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Vendored: `brave/adblock-rust-ffi`

**Upstream:** https://github.com/brave/adblock-rust-ffi (archived 2024-01-08)
**Pinned commit:** `5382a0669bdbebaa9db740d74510c6e347fac27f`
**Local path:** `vendor/adblock-rust-ffi/`
**Integrity:** `SHA256SUMS` in that directory covers every vendored file.
**Upstream license:** MPL-2.0 (`vendor/adblock-rust-ffi/LICENSE`). It is retained
unchanged. This is a reference vendor, **not** a compiled or linked dependency;
`settings.gradle.kts` and the Cargo workspace never include it.

## Audit (lead condition 1, 2026-11-11)

I read the whole crate before writing a wrapper. Verdict: the C ABI is coherent
and it still builds, but it cannot be used as ShieldTube's FFI layer.

**It compiles.** Against the pinned Rust 1.99.1 toolchain:

```
$ cargo check --manifest-path vendor/adblock-rust-ffi/Cargo.toml
    Checking adblock v0.3.15
    Checking adblock-ffi v0.1.0 (...)
warning: calls to `std::mem::forget` with a value that implements `Copy` does nothing
   --> src/lib.rs:209:5
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 13.49s
exit 0
```

(one warning: `std::mem::forget(ptr)` on a raw pointer is a no-op).

**Why it is still genuinely unusable here:**

| # | Problem | Evidence |
|---|---|---|
| 1 | **No JNI at all** | All 11 exports are C functions `engine_create`, `engine_match`, `engine_url_cosmetic_resources`, … in `src/lib.rs`; the only consumer is the C++ `src/wrapper.cc` / `wrapper.h`. Kotlin `external fun` requires `Java_*` symbols. There is no "working JNI" here to fork. |
| 2 | **`panic = "abort"` in both profiles** | `Cargo.toml` `[profile.dev]` and `[profile.release]`. `catch_unwind` cannot catch an abort; §8 requires every FFI entry point to survive a Rust panic. The fork uses bare `unwrap()`/`expect()` and `assert!` at every boundary, e.g. `CStr::from_ptr(rules).to_str().unwrap()`, so bad input aborts the process. |
| 3 | **Pins `adblock ~0.3.15`** | `Engine::from_filter_set`, `add_filter_list(&str, FilterFormat)`, `check_network_urls_with_hostnames_subset`, `enable_tags` — all replaced in 0.13.5 by `new_with_filter_set`, `add_filter_list(String, ParseOptions)`, `check_network_request(&Request)`, `should_block()`. No `ParseOptions.permissions`, no `PermissionMask`, no `procedural_actions`. |
| 4 | **Not a scalar boolean network match** | `engine_match` takes 9 out-parameters: `bool *did_match_rule`, `bool *did_match_exception`, `bool *did_match_important`, `char **redirect`. The lead's condition 2 requires a scalar boolean and forbids hand-written struct-ish ABIs across four architectures. |
| 5 | **Requires a C callback we cannot supply** | `set_domain_resolver(DomainResolverCallback)` must be called before any engine use; the host must provide a C function pointer resolving public-suffix boundaries. 0.13.5's `embedded-domain-resolver` removes this entirely. |
| 6 | **Stale cosmetic schema** | `engine_url_cosmetic_resources` serialises whatever `adblock 0.3.15` returns — the pre-0.13 shape with `style_selectors`. That is precisely the field drift the lead asked us to guard against; the pinned 0.13.5 crate has `procedural_actions` instead. |
| 7 | **Unmaintained** | Repository archived; `Cargo.lock` from 2021; the last `src/lib.h` check-in is from 2021. Carrying it as production code would mean maintaining a 2021 API against a 2026 engine. |

## What we kept from it

* The idea of a single opaque `*mut Engine` handle plus C-string JSON payloads.
* `c_char_buffer_destroy` → our `st_string_free`.
* `engine_add_resources` (JSON `Resource` array) → our resources JSON in
  `createEngine`.
* The `cbindgen` build-script pattern (their `Makefile` uses the cbindgen CLI;
  our `rust/build.rs` uses the cbindgen crate).

## What we did instead

`rust/` is a fresh, ~250-line wrapper over `adblock =0.13.5`:

* `ffi_c.rs` — six `st_*` C functions, all `catch_unwind`-guarded, header at
  `rust/include/shieldtube.h` (compiles as both C11 and C++17, verified).
* `ffi_jni.rs` — five `Java_*` exports; JSON-in/JSON-out cosmetic, scalar match.
* `engine.rs` — `RwLock<State>`, `ParseOptions.permissions`, explicit
  `UrlSpecificResources` field construction (compile-time drift detection).

The vendored tree is deliberately **not** wired into any build. Deleting it
would lose the audit trail; keeping it uncompiled costs ~50 KB.
