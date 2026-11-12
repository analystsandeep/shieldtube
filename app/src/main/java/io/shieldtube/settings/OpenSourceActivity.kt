// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube.settings

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import io.shieldtube.BuildConfig
import io.shieldtube.R

/**
 * GPLv3 attribution and source-link screen. The public repository is supplied
 * tomorrow; until SHIELDTUBE_SOURCE_URL is set at build time, the placeholder
 * is visible and deliberately non-navigable.
 */
class OpenSourceActivity : Activity() {
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

        val title = TextView(this).apply {
            text = getString(R.string.open_source_title)
            setTextColor(Color.WHITE)
            textSize = 26f
            gravity = Gravity.START
            layoutParams = rowParams()
        }
        val body = TextView(this).apply {
            text = getString(R.string.open_source_body)
            setTextColor(Color.LTGRAY)
            textSize = 15f
            layoutParams = rowParams()
        }
        val sourceLabel = TextView(this).apply {
            text = getString(R.string.source_url_label)
            setTextColor(Color.WHITE)
            textSize = 15f
            layoutParams = rowParams()
        }
        val sourceUrl = BuildConfig.SOURCE_URL
        val isUrl = sourceUrl.startsWith("http://") || sourceUrl.startsWith("https://")
        val sourceText = TextView(this).apply {
            text = if (isUrl) {
                sourceUrl
            } else {
                getString(R.string.source_url_pending, sourceUrl)
            }
            setTextColor(if (isUrl) Color.CYAN else Color.YELLOW)
            textSize = 14f
            layoutParams = rowParams()
        }
        val openButton = Button(this).apply {
            text = getString(R.string.view_source)
            isFocusable = true
            isFocusableInTouchMode = false
            isAllCaps = false
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#222222"))
            layoutParams = rowParams()
            setOnClickListener {
                if (!isUrl) {
                    Toast.makeText(this@OpenSourceActivity, R.string.source_link_unavailable, Toast.LENGTH_LONG).show()
                    return@setOnClickListener
                }
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(sourceUrl)))
                } catch (e: ActivityNotFoundException) {
                    Toast.makeText(this@OpenSourceActivity, R.string.source_link_unavailable, Toast.LENGTH_LONG).show()
                }
            }
        }
        val licenseTitle = TextView(this).apply {
            text = getString(R.string.license_title)
            setTextColor(Color.WHITE)
            textSize = 18f
            layoutParams = rowParams()
        }
        val license = TextView(this).apply {
            text = readLicense()
            setTextColor(Color.LTGRAY)
            textSize = 11f
            typeface = Typeface.MONOSPACE
            layoutParams = rowParams()
        }
        val back = Button(this).apply {
            text = getString(R.string.back_to_player)
            isFocusable = true
            isFocusableInTouchMode = false
            isAllCaps = false
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#222222"))
            layoutParams = rowParams()
            setOnClickListener { finish() }
        }

        root.addView(title)
        root.addView(body)
        root.addView(sourceLabel)
        root.addView(sourceText)
        root.addView(openButton)
        root.addView(licenseTitle)
        root.addView(license)
        root.addView(back)

        val focusables = listOf<View>(openButton, back)
        focusables.forEach { it.id = View.generateViewId() }
        openButton.nextFocusDownId = back.id
        back.nextFocusUpId = openButton.id
        openButton.requestFocus()
    }

    private fun readLicense(): String = try {
        assets.open("legal/LICENSE.txt").bufferedReader().use { it.readText() }
    } catch (e: Exception) {
        "LICENSE.txt is missing from assets; see the repository root LICENSE."
    }

    private fun rowParams(): LinearLayout.LayoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { setMargins(0, 8, 0, 8) }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        finish()
    }
}
