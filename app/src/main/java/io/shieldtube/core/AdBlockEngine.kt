// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.core

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.shieldtube.nativebridge.AdBlockBridge
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/**
 * One engine instance for the whole process. Construction and list reloads
 * happen off the main thread; a splash is shown until [ready] flips. A
 * read/write lock keeps WebView network callbacks from using a handle while a
 * settings/list update atomically swaps in a freshly built engine.
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

    private val lock = ReentrantReadWriteLock()
    private var handle: Long = 0L

    @Volatile var ready: Boolean = false
        private set

    @Volatile private var enabled = true

    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "shieldtube-engine").apply { priority = Thread.NORM_PRIORITY }
    }
    private val main = Handler(Looper.getMainLooper())

    fun initializeAsync(context: Context, onReady: (Boolean) -> Unit) {
        val app = context.applicationContext
        enabled = Prefs.shieldsEnabled(app)
        executor.execute {
            val ok = try {
                val payload = buildCreatePayload(app)
                val created = AdBlockBridge.nativeCreate(payload)
                if (created != 0L) {
                    lock.write {
                        destroyLocked()
                        handle = created
                        ready = true
                    }
                    true
                } else {
                    Log.e(TAG, "nativeCreate returned 0")
                    false
                }
            } catch (t: Throwable) {
                Log.e(TAG, "engine construction failed", t)
                false
            }
            main.post { onReady(ok) }
        }
    }

    fun setEnabled(context: Context, value: Boolean) {
        Prefs.setShieldsEnabled(context, value)
        enabled = value
        Log.i(TAG, "shields ${if (value) "enabled" else "disabled"}")
    }

    fun isEnabled(): Boolean = enabled

    private fun buildListsArray(context: Context): String {
        val updateDir = File(context.filesDir, "lists")
        val lists = listAssets.mapNotNull { name ->
            val updated = File(updateDir, name)
            val text = if (updated.isFile && updated.length() > 0) {
                try {
                    updated.readText(Charsets.UTF_8)
                } catch (e: Exception) {
                    Log.w(TAG, "updated list unreadable, falling back to bundled: $name", e)
                    readAsset(context, "lists/$name")
                }
            } else {
                readAsset(context, "lists/$name")
            } ?: return@mapNotNull null
            // Bundled lists are checksum-verified and trusted. Opportunistic
            // runtime updates are TLS-only and parsed with trusted=false.
            val trusted = !(updated.isFile && updated.length() > 0)
            "{\"name\":${jsonString(name)},\"text\":${jsonString(text)}," +
                "\"format\":\"standard\",\"trusted\":$trusted}"
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

    /** Called from WebView's network thread. Never touches the handle after swap. */
    fun isBlocked(url: String, sourceUrl: String, requestType: String): Boolean {
        if (!enabled) return false
        return lock.read {
            val current = handle
            if (current == 0L) {
                false
            } else {
                try {
                    AdBlockBridge.nativeCheckRequest(current, url, sourceUrl, requestType)
                } catch (t: Throwable) {
                    Log.e(TAG, "native checkRequest failed; failing open", t)
                    false
                }
            }
        }
    }

    fun cosmeticFor(url: String): String {
        if (!enabled) return EMPTY_COSMETIC_JSON
        return lock.read {
            val current = handle
            if (current == 0L) {
                EMPTY_COSMETIC_JSON
            } else {
                try {
                    AdBlockBridge.nativeCosmeticFor(current, url) ?: EMPTY_COSMETIC_JSON
                } catch (t: Throwable) {
                    Log.e(TAG, "native cosmeticFor failed", t)
                    EMPTY_COSMETIC_JSON
                }
            }
        }
    }

    /** Cosmetic queries are off the main thread; callback is delivered on main. */
    fun cosmeticAsync(context: Context, url: String, onResult: (String) -> Unit) {
        executor.execute {
            val json = cosmeticFor(url)
            main.post { onResult(json) }
        }
    }

    /** Rebuild from bundled assets + optional updated lists from filesDir. */
    fun reloadAsync(context: Context, onDone: (Boolean) -> Unit) {
        val app = context.applicationContext
        executor.execute {
            val ok = try {
                val payload = buildCreatePayload(app)
                val created = AdBlockBridge.nativeCreate(payload)
                if (created != 0L) {
                    lock.write {
                        destroyLocked()
                        handle = created
                        ready = true
                    }
                    true
                } else {
                    Log.e(TAG, "reload nativeCreate returned 0; bundled lists stay active")
                    false
                }
            } catch (t: Throwable) {
                Log.e(TAG, "reload failed; previous engine stays active", t)
                false
            }
            main.post { onDone(ok) }
        }
    }

    fun clearRuntimeCaches(context: Context) {
        File(context.applicationContext.filesDir, "lists").deleteRecursively()
    }

    private fun destroyLocked() {
        val old = handle
        if (old != 0L) {
            try {
                AdBlockBridge.nativeDestroy(old)
            } catch (t: Throwable) {
                Log.w(TAG, "nativeDestroy failed", t)
            }
            handle = 0L
            ready = false
        }
    }
}
