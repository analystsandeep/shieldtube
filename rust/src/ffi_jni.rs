// SPDX-License-Identifier: GPL-3.0-or-later
//! JNI surface. Matches `io.shieldtube.nativebridge.AdBlockBridge`.
//!
//! Deliberately tiny and string/scalar only (lead condition 2):
//!   createEngine(listsJson) -> Long handle
//!   addLists(handle, listsJson) -> Boolean
//!   checkRequest(handle, url, sourceUrl, requestType) -> Boolean
//!   cosmeticFor(handle, url) -> String (JSON)
//!   destroy(handle)
//! No cbindgen structs cross the boundary; cosmetic data is JSON-in/JSON-out.

use crate::{engine::ShieldEngine, ffi_c::guard};
use jni::{
    objects::{JObject, JString},
    sys::{jboolean, jlong, jstring},
    JNIEnv,
};

fn java_string(env: &mut JNIEnv<'_>, value: &JString<'_>) -> String {
    match env.get_string(value) {
        Ok(s) => s.into(),
        Err(_) => String::new(),
    }
}

unsafe fn engine_ref(handle: jlong) -> Option<&'static ShieldEngine> {
    if handle == 0 {
        None
    } else {
        Some(&*(handle as *const ShieldEngine))
    }
}

#[no_mangle]
pub extern "system" fn Java_io_shieldtube_nativebridge_AdBlockBridge_nativeCreate<'local>(
    mut env: JNIEnv<'local>,
    _this: JObject<'local>,
    lists_json: JString<'local>,
) -> jlong {
    guard("nativeCreate", || {
        let json = java_string(&mut env, &lists_json);
        match ShieldEngine::create(&json) {
            Ok(engine) => Box::into_raw(Box::new(engine)) as jlong,
            Err(e) => {
                eprintln!("[shieldtube] nativeCreate failed: {e}");
                0
            }
        }
    })
}

#[no_mangle]
pub extern "system" fn Java_io_shieldtube_nativebridge_AdBlockBridge_nativeAddLists<'local>(
    mut env: JNIEnv<'local>,
    _this: JObject<'local>,
    handle: jlong,
    lists_json: JString<'local>,
) -> jboolean {
    guard("nativeAddLists", || {
        let Some(engine) = (unsafe { engine_ref(handle) }) else {
            return 0;
        };
        let json = java_string(&mut env, &lists_json);
        match engine.add_lists(&json) {
            Ok(_) => 1,
            Err(e) => {
                eprintln!("[shieldtube] nativeAddLists failed: {e}");
                0
            }
        }
    })
}

#[no_mangle]
pub extern "system" fn Java_io_shieldtube_nativebridge_AdBlockBridge_nativeCheckRequest<'local>(
    mut env: JNIEnv<'local>,
    _this: JObject<'local>,
    handle: jlong,
    url: JString<'local>,
    source_url: JString<'local>,
    request_type: JString<'local>,
) -> jboolean {
    guard("nativeCheckRequest", || {
        let Some(engine) = (unsafe { engine_ref(handle) }) else {
            return 0;
        };
        let u = java_string(&mut env, &url);
        let s = java_string(&mut env, &source_url);
        let t = java_string(&mut env, &request_type);
        if engine.check_request(&u, &s, &t) {
            1
        } else {
            0
        }
    })
}

#[no_mangle]
pub extern "system" fn Java_io_shieldtube_nativebridge_AdBlockBridge_nativeCosmeticFor<'local>(
    mut env: JNIEnv<'local>,
    _this: JObject<'local>,
    handle: jlong,
    url: JString<'local>,
) -> jstring {
    guard("nativeCosmeticFor", || {
        let Some(engine) = (unsafe { engine_ref(handle) }) else {
            return std::ptr::null_mut();
        };
        let u = java_string(&mut env, &url);
        let json = engine.cosmetic_for(&u);
        env.new_string(json)
            .map(|s| JObject::from(s).into_raw())
            .unwrap_or(std::ptr::null_mut())
    })
}

#[no_mangle]
pub extern "system" fn Java_io_shieldtube_nativebridge_AdBlockBridge_nativeDestroy<'local>(
    _env: JNIEnv<'local>,
    _this: JObject<'local>,
    handle: jlong,
) {
    guard("nativeDestroy", || {
        if handle != 0 {
            unsafe { drop(Box::from_raw(handle as *mut ShieldEngine)) };
        }
    })
}
