// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.core

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * Assembles ONE document-start script, registered once per WebView before
 * loadUrl():
 *   1. scriptlets emitted by adblock-rust's url_cosmetic_resources()
 *      (injected_script is already fully templated by the engine),
 *   2. our bundled fetch/XHR player-response shim,
 *   3. the 500 ms playback/ad-state watchdog and SPA URL observer.
 *
 * Cosmetic CSS/procedural rules are injected later on onPageFinished and on
 * SPA URL changes by CosmeticScript; both YouTube origins are covered here.
 */
object InjectedScript {
    private const val TAG = "ShieldTube.Inject"
    private val ORIGINS = arrayOf("https://www.youtube.com/", "https://m.youtube.com/")

    fun build(context: Context): String {
        val shim = readAsset(context, "js/shieldtube-shim.js")
        val watchdog = readAsset(context, "js/shieldtube-watchdog.js")

        val engineScript = buildString {
            ORIGINS.forEach { url ->
                try {
                    val script = JSONObject(AdBlockEngine.cosmeticFor(url))
                        .optString("injected_script", "")
                    if (script.isNotBlank()) append(script).append('\n')
                } catch (e: Exception) {
                    Log.w(TAG, "no scriptlets for $url", e)
                }
            }
        }

        // One IIFE so a throw in a scriptlet can never wedge page startup.
        return "try{(function(){\n$engineScript\n$shim\n$watchdog\n})();}catch(e){}"
    }

    private fun readAsset(context: Context, path: String): String = try {
        context.assets.open(path).bufferedReader().use { it.readText() }
    } catch (e: Exception) {
        Log.e(TAG, "document-start asset missing: $path", e)
        ""
    }
}
