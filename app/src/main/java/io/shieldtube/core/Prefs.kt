// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.core

import android.content.Context

/**
 * Tiny SharedPreferences wrapper. All values are local; no account, backend or
 * telemetry is involved. Clearing data signs the WebView out and resets the
 * one-time ToS acceptance and opportunistic-update timestamp.
 */
object Prefs {
    // Cobalt/25, not /26: Cobalt/26 breaks playback ~45s in 2026 (BotGuard).
    const val DEFAULT_UA =
        "Mozilla/5.0 (PS4; Leanback Shell) Cobalt/25.lts.40.1035033; compatible;"
    const val HOME_URL = "https://www.youtube.com/tv"
    const val FALLBACK_URL = "https://m.youtube.com"

    private const val FILE = "shieldtube"
    private const val KEY_UA = "ua_override"
    private const val KEY_SHIELDS = "shields_enabled"
    private const val KEY_FALLBACK = "use_mobile_fallback"
    private const val KEY_TOS = "tos_accepted"
    private const val KEY_LAST_UPDATE = "last_list_update"
    private const val KEY_UPDATE_SHA = "list_update_sha"

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun userAgent(context: Context): String =
        prefs(context).getString(KEY_UA, null).takeUnless { it.isNullOrBlank() } ?: DEFAULT_UA

    fun hasUserAgentOverride(context: Context): Boolean =
        !prefs(context).getString(KEY_UA, null).isNullOrBlank()

    fun setUserAgent(context: Context, value: String?) {
        prefs(context).edit().apply {
            if (value.isNullOrBlank()) remove(KEY_UA) else putString(KEY_UA, value.trim())
        }.apply()
    }

    fun homeUrl(context: Context): String =
        if (prefs(context).getBoolean(KEY_FALLBACK, false)) FALLBACK_URL else HOME_URL

    fun useMobileFallback(context: Context): Boolean =
        prefs(context).getBoolean(KEY_FALLBACK, false)

    fun setUseMobileFallback(context: Context, value: Boolean) {
        prefs(context).edit().putBoolean(KEY_FALLBACK, value).apply()
    }

    fun shieldsEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_SHIELDS, true)

    fun setShieldsEnabled(context: Context, value: Boolean) {
        prefs(context).edit().putBoolean(KEY_SHIELDS, value).apply()
    }

    fun tosAccepted(context: Context): Boolean =
        prefs(context).getBoolean(KEY_TOS, false)

    fun setTosAccepted(context: Context, value: Boolean) {
        prefs(context).edit().putBoolean(KEY_TOS, value).apply()
    }

    fun lastListUpdate(context: Context): Long =
        prefs(context).getLong(KEY_LAST_UPDATE, 0L)

    fun listUpdateSha(context: Context): String =
        prefs(context).getString(KEY_UPDATE_SHA, "").orEmpty()

    fun setListUpdate(context: Context, atMillis: Long, sha256: String) {
        prefs(context).edit()
            .putLong(KEY_LAST_UPDATE, atMillis)
            .putString(KEY_UPDATE_SHA, sha256)
            .apply()
    }

    fun clearAll(context: Context) {
        prefs(context).edit().clear().apply()
    }
}
