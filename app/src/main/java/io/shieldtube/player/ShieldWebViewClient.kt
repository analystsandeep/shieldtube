// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.player

import android.graphics.Bitmap
import android.net.Uri
import android.util.Log
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import io.shieldtube.core.AdBlockEngine
import io.shieldtube.core.BlockLog
import io.shieldtube.core.Prefs
import io.shieldtube.core.RequestTypeMapper
import java.io.ByteArrayInputStream
import java.util.Locale

class ShieldWebViewClient(
    private val activity: PlayerActivity,
    private val onExternal: (String) -> Unit,
    private val onActivation: () -> Unit,
    private val onPageStartedFallback: (WebView, String) -> Unit
) : WebViewClient() {

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest
    ): WebResourceResponse? {
        // Never block the top-level document; the engine whitelists player
        // endpoints too, but a document must always reach the renderer.
        if (request.isForMainFrame) return null
        val url = request.url?.toString() ?: return null
        val type = RequestTypeMapper.map(request)

        // Hot path: no allocation unless this request is actually a hit.
        if (!Prefs.shieldsEnabled(view.context)) return null
        if (!AdBlockEngine.isBlocked(url, activity.currentUrl, type)) return null

        BlockLog.record(url, type)
        val mime = RequestTypeMapper.mimeFor(url, type)
        Log.i(TAG, "BLOCK $type $url")
        return WebResourceResponse(
            mime,
            "utf-8",
            200,
            "OK",
            mapOf("Content-Type" to mime, "Cache-Control" to "no-store"),
            ByteArrayInputStream(ByteArray(0))
        )
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        handleUrl(request.url?.toString(), request.isForMainFrame)

    @Suppress("DEPRECATION")
    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
        handleUrl(url, true)

    private fun handleUrl(url: String?, mainFrame: Boolean): Boolean {
        if (url.isNullOrBlank()) return false
        val host = try {
            Uri.parse(url).host.orEmpty().lowercase(Locale.ROOT)
        } catch (e: Exception) {
            ""
        }
        // Google forbids OAuth in embedded WebViews. Never navigate there.
        if (host.startsWith("accounts.google.")) {
            onActivation()
            return true
        }
        if (mainFrame && !isYouTubeHost(host)) {
            onExternal(url)
            return true
        }
        return false
    }

    private fun isYouTubeHost(host: String): Boolean = listOf(
        "youtube.com", "youtu.be", "youtube-nocookie.com", "googlevideo.com", "ytimg.com"
    ).any { host == it || host.endsWith(".$it") } || host == "youtube.googleapis.com"

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        super.onPageStarted(view, url, favicon)
        if (!url.isNullOrBlank()) onPageStartedFallback(view, url)
    }

    override fun onPageFinished(view: WebView, url: String?) {
        super.onPageFinished(view, url)
        activity.onPageFinished(url)
    }

    override fun onRenderProcessGone(
        view: WebView,
        detail: RenderProcessGoneDetail
    ): Boolean = activity.onRenderProcessGone(view, detail)

    private companion object {
        const val TAG = "ShieldTube.Client"
    }
}
