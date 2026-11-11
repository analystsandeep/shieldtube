// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.core

import android.webkit.WebResourceRequest
import java.util.Locale

/**
 * WebView does not expose a uBO-style resource type. Getting this wrong
 * produces false positives (e.g. an `$image` rule matching a script).
 *
 * Precedence: Accept header > URL extension > XHR marker. WebView cannot tell
 * us whether a subframe is an iframe, so `subdocument` is only emitted when the
 * Accept header explicitly asks for a document; otherwise `other`.
 */
object RequestTypeMapper {
    private val IMAGE_EXT = setOf("png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif")
    private val MEDIA_EXT = setOf("mp4", "m4a", "mp3", "webm", "ts", "m3u8", "aac", "ogg", "flac")
    private val FONT_EXT = setOf("woff", "woff2", "ttf", "otf", "eot")

    fun map(request: WebResourceRequest): String {
        if (request.isForMainFrame) return "document"
        val path = request.url?.path.orEmpty()
        val ext = path.substringAfterLast('.', "").lowercase(Locale.ROOT)
        val headers = request.requestHeaders
        val accept = headers["Accept"].orEmpty()
        val requestedWith = headers["X-Requested-With"].orEmpty()

        return when {
            accept.contains("text/html") && !request.isForMainFrame -> "subdocument"
            accept.contains("text/css") || ext == "css" -> "stylesheet"
            ext in MEDIA_EXT || accept.contains("video/") || accept.contains("audio/") -> "media"
            ext in FONT_EXT || accept.contains("font") -> "font"
            ext in IMAGE_EXT || accept.contains("image/") -> "image"
            requestedWith.equals("XMLHttpRequest", ignoreCase = true) -> "xhr"
            ext == "js" || accept.contains("javascript") || accept.contains("application/json") -> "script"
            else -> "other"
        }
    }

    /** MIME for the empty body returned on a block hit. */
    fun mimeFor(url: String, type: String): String = when (type) {
        "script", "xhr" -> "application/javascript"
        "stylesheet" -> "text/css"
        "image" -> "image/png"
        "media" -> "video/mp4"
        "font" -> "application/octet-stream"
        "document", "subdocument" -> "text/html"
        else -> when (url.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
            "js" -> "application/javascript"
            "css" -> "text/css"
            "png", "gif", "jpg", "jpeg", "webp" -> "image/png"
            else -> "application/octet-stream"
        }
    }
}
