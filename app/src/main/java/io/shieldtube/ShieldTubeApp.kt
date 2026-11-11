// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube

import android.app.Application
import android.os.Build
import android.util.Log
import android.webkit.WebView

class ShieldTubeApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // MUST happen before the first WebView instance exists, otherwise
        // WebView throws. Gives sign-in cookies a private, persistent profile.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WebView.setDataDirectorySuffix("shieldtube")
        }
        Log.i(TAG, "ShieldTube started; no telemetry, no analytics")
    }

    private companion object {
        const val TAG = "ShieldTube.App"
    }
}
