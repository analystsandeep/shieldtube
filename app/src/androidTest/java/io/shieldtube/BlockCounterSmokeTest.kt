// SPDX-License-Identifier: GPL-3.0-or-later
package io.shieldtube

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.shieldtube.core.BlockLog
import io.shieldtube.player.PlayerActivity
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented smoke test: load a page with a <video> and a known ad URL, then
 * assert the ad-block counter increments. Fully offline — the blocked request
 * is answered locally by shouldInterceptRequest.
 *
 * Run: ./gradlew connectedDebugAndroidTest (real ARM TV box required).
 */
@RunWith(AndroidJUnit4::class)
class BlockCounterSmokeTest {

    @Test
    fun loadingVideoPageIncrementsBlockCounter() {
        BlockLog.reset()
        val context = ApplicationProvider.getApplicationContext<Context>()
        val intent = Intent(context, PlayerActivity::class.java).apply {
            putExtra(
                PlayerActivity.EXTRA_TEST_URL,
                "file:///android_asset/test/fixture.html"
            )
        }

        ActivityScenario.launch<PlayerActivity>(intent).use { scenario ->
            val deadline = SystemClock.uptimeMillis() + 20_000L
            while (SystemClock.uptimeMillis() < deadline && BlockLog.totalBlocked == 0L) {
                Thread.sleep(100L)
            }
            assertTrue(
                "expected at least one blocked ad request, log=${BlockLog.snapshot()}",
                BlockLog.totalBlocked > 0L
            )
            scenario.onActivity { activity ->
                assertTrue(activity.currentUrl.contains("fixture.html"))
            }
        }
    }
}
