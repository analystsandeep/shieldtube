// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube

import io.shieldtube.nativebridge.AdBlockBridge
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Step-1 gate on the JVM side: prove the JNI surface blocks a known ad URL.
 * The host cdylib is built by scripts/build-rust-host.sh and found through
 * -Djava.library.path in app/build.gradle.kts.
 */
class AdBlockBridgeJniTest {

    private val payload = """
        {"lists":[{"name":"jvm-test.txt",
                   "text":"||doubleclick.net^\n||ads.example.org^\u0024script",
                   "format":"standard","trusted":true}],
         "resources":[]}
    """.trimIndent()

    @Test
    fun jniBlocksKnownAdUrlAndKeepsPlayerEndpoint() {
        val handle = AdBlockBridge.nativeCreate(payload)
        assertTrue("nativeCreate must return a non-zero handle", handle != 0L)
        try {
            assertTrue(
                AdBlockBridge.nativeCheckRequest(
                    handle,
                    "https://doubleclick.net/ads/banner.js",
                    "https://www.youtube.com/tv",
                    "script"
                )
            )
            assertFalse(
                AdBlockBridge.nativeCheckRequest(
                    handle,
                    "https://www.youtube.com/youtubei/v1/player?key=x",
                    "https://www.youtube.com/tv",
                    "xhr"
                )
            )
            assertFalse(
                AdBlockBridge.nativeCheckRequest(
                    handle,
                    "https://www.youtube.com/s/desktop/base.js",
                    "https://www.youtube.com/tv",
                    "script"
                )
            )
            val cosmetic = AdBlockBridge.nativeCosmeticFor(handle, "https://www.youtube.com/")
            assertNotNull("cosmeticFor must return JSON", cosmetic)
            assertTrue(cosmetic!!.contains("hide_selectors"))
            assertTrue(cosmetic.contains("injected_script"))
        } finally {
            AdBlockBridge.nativeDestroy(handle)
        }
    }

    @Test
    fun requestTypeChangesTheVerdict() {
        val handle = AdBlockBridge.nativeCreate(payload)
        assertTrue(handle != 0L)
        try {
            val url = "https://ads.example.org/creative.js"
            assertTrue(AdBlockBridge.nativeCheckRequest(handle, url, "https://www.youtube.com/tv", "script"))
            assertFalse(AdBlockBridge.nativeCheckRequest(handle, url, "https://www.youtube.com/tv", "image"))
        } finally {
            AdBlockBridge.nativeDestroy(handle)
        }
    }
}
