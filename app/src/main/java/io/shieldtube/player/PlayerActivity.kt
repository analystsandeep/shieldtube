// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.player

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import io.shieldtube.R
import io.shieldtube.core.AdBlockEngine
import io.shieldtube.core.BlockLog
import io.shieldtube.core.InjectedScript
import io.shieldtube.core.Prefs
import org.json.JSONObject

/**
 * Minimal player (lead priority change 2026-11-11). Deliberately excludes the
 * settings screen, cosmetic layer and ad-state watchdog until the APK builds.
 */
class PlayerActivity : Activity() {

    private lateinit var container: FrameLayout
    private lateinit var splash: TextView
    private lateinit var notice: TextView
    private var webView: WebView? = null
    private var documentStartScript: String = ""
    private var documentStartSupported = false
    private val main = Handler(Looper.getMainLooper())

    /** Source URL for request matching; updated on every page finish. */
    var currentUrl: String = Prefs.HOME_URL

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        hideSystemUi()

        container = FrameLayout(this).also { setContentView(it) }

        splash = TextView(this).apply {
            text = getString(R.string.engine_loading)
            setTextColor(Color.WHITE)
            textSize = 22f
            gravity = Gravity.CENTER
            setBackgroundColor(Color.BLACK)
        }
        notice = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 16f
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#B0000000"))
            visibility = View.GONE
            setPadding(24, 12, 24, 12)
        }
        container.addView(
            splash,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        container.addView(
            notice,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP
            )
        )

        Log.i(TAG, "startup UA assertion (configured): ${Prefs.userAgent(this)}")
        AdBlockEngine.initializeAsync(this) { ok -> onEngineReady(ok) }
    }

    private fun onEngineReady(ok: Boolean) {
        if (isFinishing || isDestroyed) return
        if (!ok) {
            splash.text = "Shields unavailable — continuing without them"
        }
        createWebView()
        val target = intent.getStringExtra(EXTRA_TEST_URL)
            ?: intent.data?.toString()
            ?: Prefs.homeUrl(this)
        currentUrl = target
        Log.i(TAG, "loading $target (engineReady=$ok)")
        webView?.loadUrl(target)
    }

    private fun createWebView() {
        val wv = WebView(this)
        webView = wv
        container.addView(
            wv, 0,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        configure(wv)

        // Native bridge for shim -> app messages. addJavascriptInterface is
        // available on every frame; top-level navigation is restricted to
        // YouTube hosts above, and no privileged method is exposed.
        wv.addJavascriptInterface(ShieldJsBridge(::handleBridgeMessage), "ShieldTubeNative")

        documentStartScript = InjectedScript.build(this)
        documentStartSupported =
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (documentStartSupported) {
            // ONE script, registered once, BEFORE loadUrl. Origin rules must
            // include BOTH hosts or the shim silently no-ops.
            WebViewCompat.addDocumentStartJavaScript(wv, documentStartScript, ORIGINS)
            Log.i(TAG, "document-start registered for $ORIGINS (${documentStartScript.length} chars)")
        } else {
            Log.w(TAG, "DOCUMENT_START_SCRIPT unsupported; using onPageStarted fallback")
        }

        wv.webViewClient = ShieldWebViewClient(
            this,
            ::confirmExternal,
            ::showActivationNotice,
            ::injectFallback
        )
        wv.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message?
            ): Boolean {
                // target=_blank / popups are routed into the SAME WebView.
                val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
                transport.webView = wv
                resultMsg.sendToTarget()
                return true
            }
        }
    }

    private fun configure(wv: WebView) {
        val settings = wv.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.setSupportZoom(false)
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.allowFileAccess = true // offline instrumented fixture
        settings.userAgentString = Prefs.userAgent(this)

        wv.setBackgroundColor(Color.BLACK)
        wv.isFocusable = true
        wv.isFocusableInTouchMode = true
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(wv, true)
        }
        // Lead condition 4: log the UA ACTUALLY in use at startup.
        Log.i(TAG, "startup UA assertion (actual): ${settings.userAgentString}")
    }

    private fun injectFallback(view: WebView, url: String) {
        if (documentStartSupported) return
        if (!url.startsWith("https://www.youtube.com") &&
            !url.startsWith("https://m.youtube.com")
        ) return
        view.evaluateJavascript(documentStartScript, null)
    }

    private fun handleBridgeMessage(data: String?) {
        if (data.isNullOrBlank()) return
        try {
            val msg = JSONObject(data)
            when (msg.optString("t")) {
                "widevine" -> {
                    val detail = msg.optString("d")
                    if (detail.startsWith("unavailable") ||
                        detail.startsWith("no-EME") ||
                        detail.startsWith("probe-error")
                    ) {
                        main.post {
                            showNotice("Widevine unavailable/L3: HD may cap at 720p or 480p")
                        }
                    }
                }
                "playerResponse", "playerResponseXhr" ->
                    Log.i(TAG, "player ad metadata: ${msg.optString("d")}")
                "ready" -> Log.i(TAG, "shim ready, UA=${msg.optString("ua")}")
                else -> Log.d(TAG, "bridge: $data")
            }
        } catch (e: Exception) {
            Log.w(TAG, "malformed bridge message", e)
        }
    }

    private fun showNotice(text: String) {
        notice.text = text
        notice.visibility = View.VISIBLE
        main.postDelayed({ notice.visibility = View.GONE }, 8000L)
    }

    private fun showActivationNotice() {
        showNotice(getString(R.string.sign_in_hint))
        Log.i(TAG, "embedded OAuth blocked; directing user to youtube.com/activate")
    }

    private fun confirmExternal(url: String) {
        AlertDialog.Builder(this)
            .setTitle(R.string.external_link_blocked)
            .setMessage(url)
            .setPositiveButton("Open") { _, _ -> webView?.loadUrl(url) }
            .setNegativeButton("Stay", null)
            .show()
    }

    fun onPageFinished(url: String?) {
        if (!url.isNullOrBlank()) currentUrl = url
        splash.visibility = View.GONE
        Log.i(TAG, "page finished: $currentUrl | blocks=${BlockLog.totalBlocked}")
    }

    fun onRenderProcessGone(_view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
        Log.w(TAG, "renderer gone (crash=${detail?.didCrash()}); recreating WebView")
        main.post {
            if (isFinishing || isDestroyed) return@post
            webView?.let {
                container.removeView(it)
                it.destroy()
            }
            webView = null
            createWebView()
            webView?.loadUrl(currentUrl)
            Toast.makeText(this, R.string.renderer_restarted, Toast.LENGTH_SHORT).show()
        }
        return true
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        val url = intent?.data?.toString()
        if (!url.isNullOrBlank()) {
            currentUrl = url
            webView?.loadUrl(url)
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                    evalMedia("toggle")
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> {
                    evalMedia("seek", 10.0)
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_REWIND -> {
                    evalMedia("seek", -10.0)
                    return true
                }
                KeyEvent.KEYCODE_BACK -> {
                    // Pop WebView history before finishing: BACK from a video
                    // must return to the grid, never exit the app.
                    if (webView?.canGoBack() == true) {
                        webView?.goBack()
                        return true
                    }
                }
                KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN,
                KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
                KeyEvent.KEYCODE_DPAD_CENTER -> webView?.requestFocus()
            }
        }
        return super.dispatchKeyEvent(event)
    }

    private fun evalMedia(action: String, delta: Double = 0.0) {
        val script = if (action == "toggle") {
            "(function(){var v=document.querySelector('video');if(!v)return;" +
                "if(v.paused){v.play();}else{v.pause();}})();"
        } else {
            "(function(){var v=document.querySelector('video');if(!v)return;" +
                "v.currentTime=Math.max(0,v.currentTime+($delta));})();"
        }
        webView?.evaluateJavascript(script, null)
    }

    override fun onPause() {
        webView?.onPause()
        webView?.pauseTimers()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView?.resumeTimers()
        webView?.onResume()
    }

    override fun onDestroy() {
        webView?.let {
            container.removeView(it)
            it.destroy()
        }
        webView = null
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    private fun hideSystemUi() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            )
    }

    private class ShieldJsBridge(private val onMessage: (String?) -> Unit) {
        @JavascriptInterface
        fun post(message: String?) = onMessage(message)
    }

    companion object {
        private const val TAG = "ShieldTube.Player"
        const val EXTRA_TEST_URL = "shieldtube.test.url"
        private val ORIGINS = setOf("https://www.youtube.com", "https://m.youtube.com")
    }
}
