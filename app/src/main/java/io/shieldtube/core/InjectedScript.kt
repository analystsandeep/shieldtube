// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.core

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * Assembles ONE document-start script, registered once per WebView before
 * loadUrl():
 *   1. scriptlets emitted by adblock-rust's url_cosmetic_resources()
 *      (injected_script is already fully templated by the engine), and
 *   2. our bundled shim (assets/js/shieldtube-shim.js).
 *
 * Both https://www.youtube.com and https://m.youtube.com are covered by the
 * origin rules in PlayerActivity; computing scriptlets for both origins makes
 * the payload correct whichever host serves the player.
 */
object InjectedScript {
    private const val TAG = "ShieldTube.Inject"
    private val ORIGINS = arrayOf("https://www.youtube.com/", "https://m.youtube.com/")

    fun build(context: Context): String {
        val shim = try {
            context.assets.open("js/shieldtube-shim.js").bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            Log.e(TAG, "shim asset missing; document start will be a no-op", e)
            ""
        }

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
        return "try{(function(){\n$engineScript\n$shim\n})();}catch(e){}"
    }
}
