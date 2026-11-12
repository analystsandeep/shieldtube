// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.core

import android.content.Context
import android.util.Log

/**
 * Builds the page-side cosmetic injection from engine JSON. The JS library is
 * cached: it installs a single `<style>` element, debounced 250 ms
 * MutationObserver, procedural-action evaluator and SPA-friendly update().
 */
object CosmeticScript {
    private const val TAG = "ShieldTube.Cosmetic"
    private const val ASSET = "js/shieldtube-cosmetic.js"

    @Volatile private var library: String? = null

    private fun readLibrary(context: Context): String {
        library?.let { return it }
        return synchronized(this) {
            library ?: try {
                context.applicationContext.assets.open(ASSET)
                    .bufferedReader().use { it.readText() }
                    .also { library = it }
            } catch (e: Exception) {
                Log.e(TAG, "cosmetic library asset missing", e)
                ""
            }
        }
    }

    fun build(context: Context, cosmeticJson: String): String =
        "try{(function(){\n${readLibrary(context)}\n" +
            "window.__shieldtubeCosmetic.update($cosmeticJson);\n" +
            "})();}catch(e){}"

    fun buildClear(): String =
        "try{(function(){if(window.__shieldtubeCosmetic){" +
            "window.__shieldtubeCosmetic.clear();}})();}catch(e){}"
}
