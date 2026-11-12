// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.settings

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import io.shieldtube.R
import io.shieldtube.core.AdBlockEngine
import io.shieldtube.core.BlockLog
import io.shieldtube.core.ListUpdater
import io.shieldtube.core.Prefs
import java.text.DateFormat
import java.util.Date

/**
 * D-pad-only settings screen. Every row is focusable; no touchscreen is
 * required. Changes set RESULT_OK so PlayerActivity can recreate with the new
 * UA / fallback / shields state.
 */
class SettingsActivity : Activity() {
    private var changed = false

    private lateinit var shieldsButton: Button
    private lateinit var fallbackButton: Button
    private lateinit var uaEdit: EditText
    private lateinit var counters: TextView
    private lateinit var updateStatus: TextView
    private lateinit var focusables: List<View>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
            setPadding(48, 28, 48, 28)
        }
        val scroll = ScrollView(this).apply {
            isFillViewport = true
            setBackgroundColor(Color.BLACK)
        }
        scroll.addView(root, ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        setContentView(scroll)

        root.addView(label(R.string.settings_title, 26f))
        root.addView(label(R.string.activation_notice, 15f))

        shieldsButton = button("") {
            AdBlockEngine.setEnabled(this, !Prefs.shieldsEnabled(this))
            markChanged()
            refresh()
        }
        fallbackButton = button("") {
            Prefs.setUseMobileFallback(this, !Prefs.useMobileFallback(this))
            markChanged()
            refresh()
        }
        root.addView(shieldsButton)
        root.addView(fallbackButton)

        root.addView(label(R.string.ua_hint, 15f))
        uaEdit = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            isSingleLine = true
            setBackgroundColor(Color.WHITE)
            setTextColor(Color.BLACK)
            setPadding(16, 12, 16, 12)
        }
        root.addView(uaEdit, rowParams())

        val saveUa = button(R.string.save_ua) {
            val value = uaEdit.text?.toString()?.trim().takeUnless { it.isNullOrEmpty() }
            Prefs.setUserAgent(this, value)
            markChanged()
            refresh()
            Toast.makeText(this, R.string.settings_changed, Toast.LENGTH_SHORT).show()
        }
        val resetUa = button(R.string.reset_ua) {
            Prefs.setUserAgent(this, null)
            markChanged()
            refresh()
            Toast.makeText(this, R.string.settings_changed, Toast.LENGTH_SHORT).show()
        }
        root.addView(saveUa)
        root.addView(resetUa)

        counters = label(R.string.counters, 15f)
        updateStatus = label(R.string.update_status, 14f)
        root.addView(counters)
        root.addView(updateStatus)

        val updateButton = button(R.string.update_lists) {
            updateStatus.text = getString(R.string.updating_lists)
            ListUpdater.forceUpdateAsync(this) { updated, message ->
                updateStatus.text = getString(
                    R.string.last_update,
                    DateFormat.getDateTimeInstance().format(Date(System.currentTimeMillis())),
                    Prefs.listUpdateSha(this).takeIf { it.isNotEmpty() }?.take(12)
                        ?: getString(R.string.bundled_baseline)
                ) + "\n" + message + "\n" + getString(R.string.update_status)
                if (updated) {
                    markChanged()
                    refresh()
                }
                Toast.makeText(this, message, Toast.LENGTH_LONG).show()
            }
        }
        val clearButton = button(R.string.clear_data) { confirmClearData() }
        val openSourceButton = button(R.string.open_source) {
            startActivity(Intent(this, OpenSourceActivity::class.java))
        }
        val stockButton = button(R.string.stock_youtube_app_info) { openStockYouTubeAppInfo() }
        val backButton = button(R.string.back_to_player) { finish() }

        root.addView(updateButton)
        root.addView(clearButton)
        root.addView(openSourceButton)
        root.addView(stockButton)
        root.addView(backButton)

        focusables = listOf(
            shieldsButton, fallbackButton, uaEdit, saveUa, resetUa,
            updateButton, clearButton, openSourceButton, stockButton, backButton
        )
        focusables.forEach { it.id = View.generateViewId() }
        focusables.forEachIndexed { i, view ->
            view.nextFocusDownId = focusables.getOrNull(i + 1)?.id ?: view.id
            view.nextFocusUpId = if (i == 0) view.id else focusables[i - 1].id
        }
        shieldsButton.requestFocus()
        refresh()
    }

    override fun onResume() {
        super.onResume()
        if (::shieldsButton.isInitialized) refresh()
    }

    private fun refresh() {
        shieldsButton.text = getString(
            if (Prefs.shieldsEnabled(this)) R.string.shields_on else R.string.shields_off
        )
        fallbackButton.text = getString(
            if (Prefs.useMobileFallback(this)) R.string.mobile_on else R.string.mobile_off
        )
        uaEdit.setText(Prefs.userAgent(this))
        counters.text = getString(
            R.string.counters, BlockLog.totalBlocked, BlockLog.snapshot().size
        )
        val last = Prefs.lastListUpdate(this)
        val whenText = if (last == 0L) {
            getString(R.string.never)
        } else {
            DateFormat.getDateTimeInstance().format(Date(last))
        }
        val sha = Prefs.listUpdateSha(this).takeIf { it.isNotEmpty() }?.take(12)
            ?: getString(R.string.bundled_baseline)
        updateStatus.text = getString(R.string.last_update, whenText, sha) + "\n" +
            getString(R.string.update_status)
    }

    private fun markChanged() {
        changed = true
    }

    private fun confirmClearData() {
        AlertDialog.Builder(this)
            .setTitle(R.string.clear_data)
            .setMessage(R.string.clear_data_confirm)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                CookieManager.getInstance().removeAllCookies(null)
                CookieManager.getInstance().flush()
                WebStorage.getInstance().deleteAllData()
                try {
                    val temp = WebView(this)
                    temp.clearCache(true)
                    temp.destroy()
                } catch (e: Exception) {
                    // Best effort; WebStorage/cookies are already cleared.
                }
                ListUpdater.clearUpdates(this)
                AdBlockEngine.clearRuntimeCaches(this)
                BlockLog.reset()
                markChanged()
                Toast.makeText(this, R.string.settings_changed, Toast.LENGTH_SHORT).show()
                finish()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun openStockYouTubeAppInfo() {
        val candidates = listOf("com.google.android.youtube.tv", "com.google.android.youtube")
        val pkg = candidates.firstOrNull { candidate ->
            try {
                packageManager.getPackageInfo(candidate, 0)
                true
            } catch (e: PackageManager.NameNotFoundException) {
                false
            }
        }
        if (pkg == null) {
            Toast.makeText(this, R.string.stock_youtube_missing, Toast.LENGTH_LONG).show()
            return
        }
        val intent = Intent(
            android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:$pkg")
        )
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.stock_youtube_missing, Toast.LENGTH_LONG).show()
        }
    }

    private fun label(resId: Int, size: Float): TextView = TextView(this).apply {
        text = getString(resId)
        setTextColor(Color.WHITE)
        textSize = size
        gravity = Gravity.START
        layoutParams = rowParams()
    }

    private fun button(resId: Int, onClick: () -> Unit): Button = button(getString(resId), onClick)

    private fun button(text: String, onClick: () -> Unit): Button = Button(this).apply {
        this.text = text
        isFocusable = true
        isFocusableInTouchMode = false
        isAllCaps = false
        setTextColor(Color.WHITE)
        setBackgroundColor(Color.parseColor("#222222"))
        setPadding(16, 12, 16, 12)
        layoutParams = rowParams()
        setOnClickListener { onClick() }
    }

    private fun rowParams(): LinearLayout.LayoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { setMargins(0, 8, 0, 8) }

    override fun finish() {
        if (changed) setResult(RESULT_OK)
        super.finish()
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        finish()
    }
}
