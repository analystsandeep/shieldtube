// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.core

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.shieldtube.nativebridge.AdBlockBridge
import java.util.concurrent.Executors

/**
 * One engine instance for the whole process. Construction happens off the main
 * thread; a splash is shown until [ready] flips. Never rebuilt per navigation.
 */
object AdBlockEngine {
    private const val TAG = "ShieldTube.Engine"

    private val listAssets = arrayOf(
        "brave-specific.txt",
        "ubo-filters.txt",
        "ubo-unbreak.txt",
        "easylist-core.txt",
        "easyprivacy-core.txt",
        "brave-unbreak.txt"
    )

    @Volatile private var handle: Long = 0L

    @Volatile var ready: Boolean = false
        private set

    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "shieldtube-engine").apply { priority = Thread.NORM_PRIORITY }
    }
    private val main = Handler(Looper.getMainLooper())

    fun initializeAsync(context: Context, onReady: (Boolean) -> Unit) {
        val app = context.applicationContext
        executor.execute {
            val ok = try {
                val payload = buildCreatePayload(app)
                val created = AdBlockBridge.nativeCreate(payload)
                if (created != 0L) {
                    handle = created
                    true
                } else {
                    Log.e(TAG, "nativeCreate returned 0")
                    false
                }
            } catch (t: Throwable) {
                Log.e(TAG, "engine construction failed", t)
                false
            }
            ready = ok
            main.post { onReady(ok) }
        }
    }

    private fun buildListsArray(context: Context): String {
        val lists = listAssets.mapNotNull { name ->
            val text = readAsset(context, "lists/$name") ?: return@mapNotNull null
            "{\"name\":${jsonString(name)},\"text\":${jsonString(text)}," +
                "\"format\":\"standard\",\"trusted\":true}"
        }
        return "[${lists.joinToString(",")}]"
    }

    private fun buildCreatePayload(context: Context): String {
        // resources.json is already JSON; inline it verbatim. Bundled and
        // checksum-verified, hence trusted=true for every list
        // (see docs/SPEC-DEVIATIONS.md, "Trust decision").
        val resources = readAsset(context, "lists/resources.json") ?: "[]"
        return "{\"lists\":${buildListsArray(context)},\"resources\":$resources}"
    }

    private fun readAsset(context: Context, path: String): String? = try {
        context.assets.open(path).bufferedReader().use { it.readText() }
    } catch (e: Exception) {
        Log.e(TAG, "bundled asset missing: $path", e)
        null
    }

    /** Called from WebView's network thread. Lock-free read of a volatile. */
    fun isBlocked(url: String, sourceUrl: String, requestType: String): Boolean {
        val current = handle
        if (current == 0L) return false
        return try {
            AdBlockBridge.nativeCheckRequest(current, url, sourceUrl, requestType)
        } catch (t: Throwable) {
            Log.e(TAG, "native checkRequest failed; failing open", t)
            false
        }
    }

    fun cosmeticFor(url: String): String {
        val current = handle
        if (current == 0L) return EMPTY_COSMETIC_JSON
        return try {
            AdBlockBridge.nativeCosmeticFor(current, url) ?: EMPTY_COSMETIC_JSON
        } catch (t: Throwable) {
            Log.e(TAG, "native cosmeticFor failed", t)
            EMPTY_COSMETIC_JSON
        }
    }

    /** Rebuild from bundled assets + optional updated lists from filesDir. */
    fun reloadAsync(context: Context, onDone: (Boolean) -> Unit) {
        val app = context.applicationContext
        executor.execute {
            val ok = try {
                val payload = buildCreatePayload(app)
                val current = handle
                if (current == 0L) {
                    val created = AdBlockBridge.nativeCreate(payload)
                    if (created != 0L) {
                        handle = created
                        ready = true
                        true
                    } else false
                } else {
                    // Engine rules are immutable: replace the whole set.
                    AdBlockBridge.nativeAddLists(
                        current,
                        "{\"lists\":${buildListsArray(app)},\"replace\":true}"
                    )
                }
            } catch (t: Throwable) {
                Log.e(TAG, "reload failed; bundled lists stay active", t)
                false
            }
            main.post { onDone(ok) }
        }
    }
}
