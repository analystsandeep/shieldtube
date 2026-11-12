// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.player

import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import io.shieldtube.core.AdBlockEngine
import io.shieldtube.core.BlockLog
import io.shieldtube.core.Prefs

private const val TAG = "ShieldTube.WebViewClient"

private val YOUTUBE_HOSTS = setOf(
    "youtube.com", "www.youtube.com", "m.youtube.com",
    "youtube-nocookie.com", "www.youtube-nocookie.com",
    "youtu.be", "www.youtu.be"
)

private val OAUTH_HOSTS = setOf("accounts.google.com", "accounts.google.co.in")

private val OAUTH_PATH_HINTS = setOf(
    "/signin", "/o/oauth2", "/ServiceLogin", "/accounts/signin", "/v3/signin"
)

/**
 * One WebViewClient per WebView. Network requests are checked against the Rust
 * engine; every block is recorded in the bounded (500-entry) BlockLog. Both
 * YouTube origins load inline; everything else is intercepted and only shown
 * with explicit user confirmation. document-start injection works on both.
 */
class ShieldWebViewClient(
    private val activity: PlayerActivity,
    private val confirmExternal: (String) -> Unit,
    private val showActivationNotice: () -> Unit,
    private val injectFallback: (WebView, String) -> Unit = { _, _ -> }
) : WebViewClient() {

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?
    ): WebResourceResponse? {
        val url = request?.url?.toString() ?: return null
        val sourceUrl = activity.currentUrl
        val type = mapRequestType(request)
        if (AdBlockEngine.isBlocked(url, sourceUrl, type)) {
            val host = Uri.parse(url).host.orEmpty()
            BlockLog.add(url, "$type→$host")
            Log.d(TAG, "BLOCK $type $url")
            return WebResourceResponse("text/plain", "utf-8", null)
        }
        return null
    }

    override fun shouldOverrideUrlLoading(
        view: WebView?,
        request: WebResourceRequest?
    ): Boolean {
        val url = request?.url?.toString() ?: return false
        return shouldOverrideUrlLoading(view, url)
    }

    @Suppress("OverridingDeprecatedMember")
    override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
        val target = url ?: return false
        val parsed = Uri.parse(target)
        val host = parsed.host?.lowercase().orEmpty()

        if (target.startsWith("file:///android_asset/")) return false

        if (OAUTH_HOSTS.any { host == it || host.endsWith(".$it") } ||
            (host.endsWith("google.com") &&
                OAUTH_PATH_HINTS.any { parsed.path.orEmpty().startsWith(it) })
        ) {
            showActivationNotice()
            return true
        }

        if (YOUTUBE_HOSTS.any { host == it || host.endsWith(".$it") } ||
            target == Prefs.HOME_URL ||
            target.startsWith("about:") ||
            target.startsWith("javascript:")
        ) {
            return false
        }

        if (target.startsWith("https://") || target.startsWith("http://")) {
            confirmExternal(target)
            return true
        }
        return true // block intent:, market:, youtube:, tel:, etc.
    }

    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
        super.onPageStarted(view, url, favicon)
        if (view != null && url != null) injectFallback(view, url)
    }

    override fun onPageFinished(view: WebView?, url: String?) {
        super.onPageFinished(view, url)
        activity.onPageFinished(url)
    }

    override fun onRenderProcessGone(view: WebView?, detail: android.webkit.RenderProcessGoneDetail?): Boolean {
        return activity.onRenderProcessGone(view, detail)
    }

    override fun onReceivedError(
        view: WebView?,
        request: WebResourceRequest?,
        error: android.webkit.WebResourceError?
    ) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && request?.isForMainFrame == true) {
            val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                error?.errorCode?.toString()
            } else {
                null
            }
            Log.w(TAG, "main frame error: $code ${error?.description}")
        }
        super.onReceivedError(view, request, error)
    }

    private fun mapRequestType(request: WebResourceRequest): String {
        val isMainFrame = request.isForMainFrame
        val url = request.url.toString()
        val path = Uri.parse(url).path.orEmpty()
        val guessed = when {
            isMainFrame -> "document"
            url.contains("googlevideo.com") || url.contains("/videoplayback") -> "media"
            path.endsWith(".js") || path.contains("/base.js") -> "script"
            path.endsWith(".css") -> "stylesheet"
            path.endsWith(".png") || path.endsWith(".jpg") ||
                path.endsWith(".webp") || path.endsWith(".gif") -> "image"
            path.endsWith(".woff") || path.endsWith(".woff2") ||
                path.endsWith(".ttf") -> "font"
            request.requestHeaders?.get("X-Requested-With") == "XMLHttpRequest" -> "xhr"
            else -> "other"
        }
        // adblock-rust recognises: beacon, csp_report, document, font, image,
        // imageset, media, object, object_subrequest, other, ping, script,
        // stylesheet, subdocument, websocket, webtransport, xhr, xmlhttprequest.
        return guessed
    }
}
