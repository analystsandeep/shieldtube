// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.nativebridge

/**
 * Thin Kotlin mirror of rust/src/ffi_jni.rs.
 *
 * JSON-in / JSON-out for cosmetic data; scalar boolean for network matching;
 * one opaque Long handle. No structs cross the ABI (lead condition 2).
 *
 * On Android the library comes from jniLibs; in JVM unit tests it is the host
 * cdylib found via -Djava.library.path (see app/build.gradle.kts).
 */
object AdBlockBridge {
    init {
        System.loadLibrary("shieldtube")
    }

    /** `{"lists":[...],"resources":[...]}` -> opaque handle, 0 on failure. */
    external fun nativeCreate(listsJson: String): Long

    /** `{"lists":[...],"replace":bool}` -> success. Rebuilds the engine. */
    external fun nativeAddLists(handle: Long, listsJson: String): Boolean

    external fun nativeCheckRequest(
        handle: Long,
        url: String,
        sourceUrl: String,
        requestType: String
    ): Boolean

    /** Serialized UrlSpecificResources (hide_selectors, procedural_actions, ...). */
    external fun nativeCosmeticFor(handle: Long, url: String): String?

    external fun nativeDestroy(handle: Long)
}
