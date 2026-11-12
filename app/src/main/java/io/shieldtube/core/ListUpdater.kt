// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.core

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Opportunistic 24 h filter-list updater. Bundled, checksum-verified lists are
 * always the offline baseline; runtime downloads are pruned, size-capped, and
 * parsed with trusted=false by AdBlockEngine. No analytics or telemetry: the
 * only network calls are the five upstream list repositories named below.
 */
object ListUpdater {
    private const val TAG = "ShieldTube.Updater"
    private const val MAX_FILE_BYTES = 2 * 1024 * 1024
    private const val UPDATE_INTERVAL_MS = 24L * 60L * 60L * 1000L

    private data class Group(
        val output: String,
        val repo: String,
        val defaultBranch: String,
        val paths: List<String>
    )

    private val GROUPS = listOf(
        Group("brave-specific.txt", "brave/adblock-lists", "master",
            listOf("brave-lists/brave-specific.txt")),
        Group("brave-unbreak.txt", "brave/adblock-lists", "master",
            listOf("brave-unbreak.txt")),
        Group("ubo-filters.txt", "uBlockOrigin/uAssets", "master",
            listOf("filters/filters.txt", "filters/filters-2026.txt", "filters/quick-fixes.txt")),
        Group("ubo-unbreak.txt", "uBlockOrigin/uAssets", "master",
            listOf("filters/unbreak.txt")),
        Group("easylist-core.txt", "easylist/easylist", "master",
            listOf(
                "easylist/easylist_adservers.txt",
                "easylist/easylist_general_block.txt",
                "easylist/easylist_specific_block.txt",
                "easylist/easylist_thirdparty.txt",
                "easylist/easylist_allowlist.txt"
            )),
        Group("easyprivacy-core.txt", "easylist/easylist", "master",
            listOf(
                "easyprivacy/easyprivacy_general.txt",
                "easyprivacy/easyprivacy_thirdparty.txt",
                "easyprivacy/easyprivacy_specific_uBO.txt",
                "easyprivacy/easyprivacy_allowlist.txt"
            ))
    )

    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "shieldtube-updater").apply { priority = Thread.MIN_PRIORITY }
    }
    private val main = Handler(Looper.getMainLooper())

    fun maybeUpdateAsync(context: Context, onDone: (Boolean, String) -> Unit) =
        updateAsync(context, false, onDone)

    fun forceUpdateAsync(context: Context, onDone: (Boolean, String) -> Unit) =
        updateAsync(context, true, onDone)

    private fun updateAsync(context: Context, force: Boolean, onDone: (Boolean, String) -> Unit) {
        val app = context.applicationContext
        val last = Prefs.lastListUpdate(app)
        if (!force && last > 0L && System.currentTimeMillis() - last < UPDATE_INTERVAL_MS) {
            main.post { onDone(false, "Lists are up to date; bundled baseline active") }
            return
        }
        executor.execute {
            val result = try {
                updateBlocking(app)
            } catch (t: Throwable) {
                Log.w(TAG, "opportunistic update unavailable; bundled lists remain", t)
                false to "Update unavailable; bundled lists remain active"
            }
            main.post {
                if (result.first) {
                    AdBlockEngine.reloadAsync(app) { ok ->
                        val message = if (ok) {
                            result.second
                        } else {
                            "Lists updated but engine reload failed; restart the app"
                        }
                        onDone(ok, message)
                    }
                } else {
                    onDone(false, result.second)
                }
            }
        }
    }

    private fun updateBlocking(context: Context): Pair<Boolean, String> {
        val refs = mutableMapOf<String, String>()
        val dir = File(context.filesDir, "lists")
        dir.deleteRecursively()
        if (!dir.mkdirs() && !dir.isDirectory) error("cannot create ${dir.absolutePath}")

        val digest = MessageDigest.getInstance("SHA-256")
        var totalBytes = 0
        for (group in GROUPS) {
            val ref = refs.getOrPut(group.repo) { latestRef(group.repo, group.defaultBranch) }
            val texts = group.paths.map { path ->
                fetchText("https://raw.githubusercontent.com/${group.repo}/$ref/$path")
            }
            val combined = ListPruner.combine(texts)
            val bytes = combined.toByteArray(Charsets.UTF_8)
            totalBytes += bytes.size
            if (totalBytes > MAX_FILE_BYTES) error("runtime update exceeds 2 MiB cap")
            digest.update(bytes)
            val tmp = File(dir, "${group.output}.tmp")
            val dest = File(dir, group.output)
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(dest)) {
                dest.writeBytes(bytes)
                tmp.delete()
            }
        }
        val sha = digest.digest().joinToString("") { "%02x".format(it) }
        Prefs.setListUpdate(context, System.currentTimeMillis(), sha)
        Log.i(TAG, "lists updated: $totalBytes bytes, sha256=$sha")
        return true to "Lists updated (${totalBytes / 1024} KiB, sha256 ${sha.take(12)}…)"
    }

    private fun latestRef(repo: String, fallback: String): String = try {
        val body = fetchText("https://api.github.com/repos/$repo/commits/HEAD")
        val sha = JSONObject(body).optString("sha", "")
        if (sha.length == 40) sha else fallback
    } catch (e: Exception) {
        Log.w(TAG, "cannot resolve HEAD for $repo; using $fallback", e)
        fallback
    }

    private fun fetchText(url: String): String {
        var connection: HttpURLConnection? = null
        try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 12000
                requestMethod = "GET"
                setRequestProperty("User-Agent", "ShieldTube/0.1 (local list updater)")
                setRequestProperty("Accept", "*/*")
                instanceFollowRedirects = true
            }
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                error("HTTP ${connection.responseCode} for $url")
            }
            val out = ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val buf = ByteArray(8192)
                var total = 0
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    total += n
                    if (total > MAX_FILE_BYTES * 2) error("upstream blob too large: $url")
                    out.write(buf, 0, n)
                }
            }
            return String(out.toByteArray(), Charsets.UTF_8)
        } finally {
            connection?.disconnect()
        }
    }

    fun clearUpdates(context: Context) {
        File(context.applicationContext.filesDir, "lists").deleteRecursively()
        Prefs.clearAll(context)
    }
}
