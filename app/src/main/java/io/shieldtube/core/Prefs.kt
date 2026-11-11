// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.core

import android.content.Context

/**
 * Tiny SharedPreferences wrapper. The settings screen is deferred (lead
 * priority change 2026-11-11); these keys are already the ones it will use.
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

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun userAgent(context: Context): String =
        prefs(context).getString(KEY_UA, null).takeUnless { it.isNullOrBlank() } ?: DEFAULT_UA

    fun homeUrl(context: Context): String =
        if (prefs(context).getBoolean(KEY_FALLBACK, false)) FALLBACK_URL else HOME_URL

    fun shieldsEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_SHIELDS, true)
}
