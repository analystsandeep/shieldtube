// SPDX-License-Identifier: GPL-3.0-or-later
//! C ABI. Only scalars, C strings, and one opaque handle cross this boundary.
//! cbindgen generates include/shieldtube.h from this file (build.rs).
//!
//! Everything here is wrapped in `catch_unwind`: unwinding out of an
//! `extern "C"` function is UB, and a Rust panic crossing JNI aborts the app.

use crate::engine::ShieldEngine;
use std::{
    ffi::{CStr, CString},
    os::raw::c_char,
    panic::{catch_unwind, AssertUnwindSafe},
};

/// Panic barrier shared with the JNI surface. Returns a type-safe default and
/// never lets a Rust panic escape into C/JNI.
pub(crate) fn guard<T: Default>(label: &str, f: impl FnOnce() -> T) -> T {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(value) => value,
        Err(_) => {
            eprintln!("[shieldtube] panic caught in {label}; returning safe default");
            T::default()
        }
    }
}

unsafe fn cstr<'a>(p: *const c_char) -> Option<&'a str> {
    if p.is_null() {
        return None;
    }
    CStr::from_ptr(p).to_str().ok()
}

unsafe fn engine_ref(handle: *mut ShieldEngine) -> Option<&'static ShieldEngine> {
    if handle.is_null() {
        None
    } else {
        Some(&*handle)
    }
}

/// Create an engine from a JSON payload:
/// `{"lists":[{"name","text","format","trusted"}],"resources":[...]}`
/// Returns null on invalid input. Caller owns the handle; release with
/// `st_engine_destroy`.
#[no_mangle]
pub unsafe extern "C" fn st_engine_create(lists_json: *const c_char) -> *mut ShieldEngine {
    guard("st_engine_create", || {
        let json = match cstr(lists_json) {
            Some(s) => s,
            None => return std::ptr::null_mut(),
        };
        match ShieldEngine::create(json) {
            Ok(engine) => Box::into_raw(Box::new(engine)),
            Err(e) => {
                eprintln!("[shieldtube] st_engine_create failed: {e}");
                std::ptr::null_mut()
            }
        }
    })
}

/// Add or replace lists. `lists_json` is
/// `{"lists":[...],"replace":bool}`. Rebuilds the engine atomically.
#[no_mangle]
pub unsafe extern "C" fn st_engine_add_lists(
    handle: *mut ShieldEngine,
    lists_json: *const c_char,
) -> bool {
    guard("st_engine_add_lists", || {
        let (engine, json) = match (engine_ref(handle), cstr(lists_json)) {
            (Some(e), Some(j)) => (e, j),
            _ => return false,
        };
        match engine.add_lists(json) {
            Ok(_) => true,
            Err(e) => {
                eprintln!("[shieldtube] st_engine_add_lists failed: {e}");
                false
            }
        }
    })
}

/// Scalar network match. `request_type` is one of
/// script, image, xhr, subdocument, media, stylesheet, document, font, other.
#[no_mangle]
pub unsafe extern "C" fn st_engine_check_request(
    handle: *mut ShieldEngine,
    url: *const c_char,
    source_url: *const c_char,
    request_type: *const c_char,
) -> bool {
    guard("st_engine_check_request", || {
        let (engine, url, source, kind) = match (
            engine_ref(handle),
            cstr(url),
            cstr(source_url),
            cstr(request_type),
        ) {
            (Some(e), Some(u), Some(s), Some(k)) => (e, u, s, k),
            _ => return false,
        };
        engine.check_request(url, source, kind)
    })
}

/// Returns a NUL-terminated JSON string (UrlSpecificResources). Caller MUST
/// release it with `st_string_free`. Returns null on failure.
#[no_mangle]
pub unsafe extern "C" fn st_engine_cosmetic_for(
    handle: *mut ShieldEngine,
    url: *const c_char,
) -> *mut c_char {
    guard("st_engine_cosmetic_for", || {
        let (engine, url) = match (engine_ref(handle), cstr(url)) {
            (Some(e), Some(u)) => (e, u),
            _ => return std::ptr::null_mut(),
        };
        CString::new(engine.cosmetic_for(url))
            .map(CString::into_raw)
            .unwrap_or(std::ptr::null_mut())
    })
}

/// Release a string returned by `st_engine_cosmetic_for`.
#[no_mangle]
pub unsafe extern "C" fn st_string_free(s: *mut c_char) {
    guard("st_string_free", || {
        if !s.is_null() {
            drop(CString::from_raw(s));
        }
    })
}

/// Release an engine handle.
#[no_mangle]
pub unsafe extern "C" fn st_engine_destroy(handle: *mut ShieldEngine) {
    guard("st_engine_destroy", || {
        if !handle.is_null() {
            drop(Box::from_raw(handle));
        }
    })
}
