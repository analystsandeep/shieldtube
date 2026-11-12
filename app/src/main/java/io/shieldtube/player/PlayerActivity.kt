// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.player

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.os.Build
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
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import io.shieldtube.R
import io.shieldtube.core.AdBlockEngine
import io.shieldtube.core.BlockLog
import io.shieldtube.core.CosmeticScript
import io.shieldtube.core.InjectedScript
import io.shieldtube.core.ListUpdater
import io.shieldtube.core.Prefs
import io.shieldtube.settings.SettingsActivity
import org.json.JSONObject

/**
 * Full TV player: native ad blocking, document-start scriptlets, cosmetic
 * filtering, a 500 ms watchdog, settings, activation notice and one-time ToS
 * interstitial. No touchscreen is required; D-pad and media keys are handled.
 */
class PlayerActivity : Activity() {

    private lateinit var container: FrameLayout
    private lateinit var splash: TextView
    private lateinit var notice: TextView
    private var webView: WebView? = null
    private var tosOverlay: View? = null
    private var documentStartScript: String = ""
    private var documentStartSupported = false
    private val main = Handler(Looper.getMainLooper())

    /** Source URL for request matching; updated on every page finish / SPA nav. */
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
        if (Prefs.tosAccepted(this)) startEngine() else showTosInterstitial()
    }

    private fun showTosInterstitial() {
        val overlay = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#E8000000"))
            isClickable = true
            isFocusable = false
        }
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#DD111111"))
            setPadding(64, 48, 64, 48)
        }
        val title = TextView(this).apply {
            text = getString(R.string.tos_title)
            setTextColor(Color.WHITE)
            textSize = 26f
            gravity = Gravity.CENTER
        }
        val body = TextView(this).apply {
            text = getString(R.string.tos_body)
            setTextColor(Color.LTGRAY)
            textSize = 17f
            gravity = Gravity.CENTER
            setPadding(0, 24, 0, 32)
        }
        val accept = Button(this).apply {
            text = getString(R.string.tos_accept)
            isFocusable = true
            isFocusableInTouchMode = false
            isAllCaps = false
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#333333"))
            setPadding(32, 16, 32, 16)
            setOnClickListener {
                Prefs.setTosAccepted(this@PlayerActivity, true)
                container.removeView(overlay)
                tosOverlay = null
                startEngine()
            }
        }
        panel.addView(title, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        panel.addView(body, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        panel.addView(accept, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        overlay.addView(panel, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER
        ))
        container.addView(overlay, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))
        tosOverlay = overlay
        accept.requestFocus()
    }

    private fun startEngine() {
        if (isFinishing || isDestroyed) return
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

        // Opportunistic 24 h update. Bundled lists remain active offline and
        // on failure; no analytics or telemetry is involved.
        ListUpdater.maybeUpdateAsync(applicationContext) { updated, message ->
            Log.i(TAG, "list updater: $message")
            if (updated && !isFinishing && !isDestroyed) {
                showNotice(getString(R.string.lists_updated))
            }
        }
    }

    private fun createWebView() {
        if (isFinishing || isDestroyed) return
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
        // Direct check: Android lint only recognises the feature guard when the
        // support test is itself the branch condition (a cached boolean cannot
        // be proven to cover this call).
        documentStartSupported =
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
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

    /** Inject/replace cosmetic CSS + procedural actions for this URL. */
    fun applyCosmetic(url: String?) {
        if (url.isNullOrBlank() || isFinishing || isDestroyed) return
        val wv = webView ?: return
        if (!AdBlockEngine.isEnabled()) {
            wv.evaluateJavascript(CosmeticScript.buildClear(), null)
            return
        }
        AdBlockEngine.cosmeticAsync(this, url) { json ->
            if (webView === wv && !isFinishing && !isDestroyed && AdBlockEngine.isEnabled()) {
                wv.evaluateJavascript(CosmeticScript.build(this, json), null)
            }
        }
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
                            if (!isFinishing && !isDestroyed) {
                                showNotice("Widevine unavailable/L3: HD may cap at 720p or 480p")
                            }
                        }
                    }
                }
                "playerResponse", "playerResponseXhr" ->
                    Log.i(TAG, "player ad metadata: ${msg.optString("d")}")
                "ready" -> Log.i(TAG, "shim ready, UA=${msg.optString("ua")}")
                "watchdog" -> {
                    val detail = msg.optString("d")
                    Log.i(TAG, "500 ms watchdog: $detail")
                    if (detail == "stalled") {
                        main.post {
                            if (!isFinishing && !isDestroyed) {
                                showNotice(getString(R.string.watchdog_notice))
                            }
                        }
                    }
                }
                "url" -> {
                    val url = msg.optString("d")
                    if (url.startsWith("http://") || url.startsWith("https://")) {
                        main.post {
                            if (!isFinishing && !isDestroyed) {
                                currentUrl = url
                                applyCosmetic(url)
                            }
                        }
                    }
                }
                else -> Log.d(TAG, "bridge: $data")
            }
        } catch (e: Exception) {
            Log.w(TAG, "malformed bridge message", e)
        }
    }

    private fun showNotice(text: String) {
        if (isFinishing || isDestroyed) return
        notice.text = text
        notice.visibility = View.VISIBLE
        main.postDelayed({
            if (!isFinishing && !isDestroyed) notice.visibility = View.GONE
        }, 8000L)
    }

    private fun showActivationNotice() {
        showNotice(getString(R.string.sign_in_hint))
        Log.i(TAG, "embedded OAuth blocked; directing user to youtube.com/activate")
    }

    private fun confirmExternal(url: String) {
        if (isFinishing || isDestroyed) return
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
        applyCosmetic(url)
    }

    fun onRenderProcessGone(_view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
        // The callback itself only exists on API 26+, but didCrash() is also an
        // API 26 method: keep the minSdk 23 code path free of that reference.
        val crashed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            detail?.didCrash()?.toString() ?: "unknown"
        } else {
            "unavailable-before-api-26"
        }
        Log.w(TAG, "renderer gone (crash=$crashed, webView=${_view != null}); recreating WebView")
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

    @Suppress("DEPRECATION")
    private fun openSettings() {
        startActivityForResult(Intent(this, SettingsActivity::class.java), REQ_SETTINGS)
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_SETTINGS && resultCode == RESULT_OK) {
            Log.i(TAG, "settings changed; recreating player")
            recreate()
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (tosOverlay != null) {
            if (event.action == KeyEvent.ACTION_DOWN && event.keyCode == KeyEvent.KEYCODE_BACK) {
                finish()
                return true
            }
            return super.dispatchKeyEvent(event)
        }
        if (event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_MENU -> {
                    openSettings()
                    return true
                }
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
        private const val REQ_SETTINGS = 1001
        const val EXTRA_TEST_URL = "shieldtube.test.url"
        private val ORIGINS = setOf("https://www.youtube.com", "https://m.youtube.com")
    }
}
