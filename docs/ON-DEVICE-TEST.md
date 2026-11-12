<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# On-device test checklist (Android TV)

For a real ARM TV box. Every step has an **observable** result and an explicit
PASS/FAIL. Fill the result column; a single FAIL is enough to reject the build.

Build under test: `app/build/outputs/apk/debug/app-debug.apk`
(`assembleDebug` keeps the full GPLv3 source tree and is debuggable; use the
release APK only for the signing/size checks).

Prerequisites: TV box reachable over ADB, a phone/PC for the activation flow,
and a network connection. `adb` from platform-tools 34.0.0.

---

## 0. Sideload

| # | Do | Observe | Pass condition | R |
|---|---|---|---|---|
| 0.1 | `adb connect <TV-IP>:5555` | `connected to <TV-IP>:5555` | not `failed to connect` | ☐ |
| 0.2 | `adb install -r app-debug.apk` | `Success` | `Success` (not `INSTALL_FAILED_*`) | ☐ |
| 0.3 | `adb shell pm list packages \| grep shieldtube` | `package:io.shieldtube` | present exactly once | ☐ |
| 0.4 | `adb logcat -c` then start the app from the TV launcher | app icon labelled **ShieldTube** on the Leanback row | launcher shows it without a restart | ☐ |

**FAIL sign for 0.2:** `INSTALL_FAILED_NO_MATCHING_ABIS` means the APK was built
without the box's ABI. Check with
`adb shell getprop ro.product.cpu.abi` (expected `arm64-v8a` or `armeabi-v7a`)
and confirm the APK contains that directory:
`unzip -l app-debug.apk | grep lib/`.

---

## 1. First run

Capture logs in a second terminal for the whole session:

```bash
adb logcat -s ShieldTube.Player ShieldTube.Engine ShieldTube.WebViewClient ShieldTube.Inject ShieldTube.Cosmetic ShieldTube.Updater
```

| # | Do | Observe | Pass condition | R |
|---|---|---|---|---|
| 1.1 | Launch the app | "Before you continue" panel with an **I understand — continue** button | the panel is focused (button has focus ring) and D-pad CENTER activates it | ☐ |
| 1.2 | Press the accept button | black screen, then the YouTube TV home grid | grid loads, no infinite spinner | ☐ |
| 1.3 | Watch logcat | `ShieldTube.App  ShieldTube started; no telemetry, no analytics` | line present | ☐ |
| 1.4 | Watch logcat | `ShieldTube.Engine  startup UA assertion (configured): Mozilla/5.0 (PS4; Leanback Shell) Cobalt/25...` | UA contains **Cobalt/25**, not Cobalt/26 | ☐ |
| 1.5 | Watch logcat | `ShieldTube.Player  startup UA assertion (actual): Mozilla/5.0 (PS4; Leanback Shell) Cobalt/25...` | **actual == configured** (this is the UA the WebView really sends) | ☐ |
| 1.6 | Watch logcat | `ShieldTube.Player  document-start registered for [https://www.youtube.com, https://m.youtube.com] (<N> chars)` | both origins listed, N > 20000 | ☐ |
| 1.7 | Watch logcat | `ShieldTube.Player  shim ready, UA=...` | shim reported ready (proves document-start ran in the page) | ☐ |
| 1.8 | Watch logcat | `ShieldTube.Engine  nativeCreate` verbose; no `nativeCreate returned 0` | **no** `nativeCreate returned 0` and **no** `engine construction failed` | ☐ |
| 1.9 | Watch logcat | `ShieldTube.Player  loading https://www.youtube.com/tv (engineReady=true)` | `engineReady=true` | ☐ |

**FAIL sign for 1.7:** if `DOCUMENT_START_SCRIPT unsupported; using onPageStarted
fallback` appears instead, the WebView is older than the feature; the shim still
runs but not before page scripts. Record the WebView version:
`adb shell dumpsys webviewupdate | grep "Current WebView package"`.

**FAIL sign for 1.8:** `nativeCreate returned 0` means the Rust engine refused
the bundled lists. Capture the preceding `st_engine_create failed:` /
`nativeCreate failed:` line verbatim.

---

## 2. Sign-in by activation code (the only supported path)

Google blocks OAuth inside a WebView (`403 disallowed_useragent`), so the app
never attempts embedded OAuth.

| # | Do | Observe | Pass condition | R |
|---|---|---|---|---|
| 2.1 | On the TV, open the account/sign-in entry in the YouTube TV UI | a **TV code** (8–9 characters) is shown and the page says to visit youtube.com/activate | a code is displayed and does not refresh away | ☐ |
| 2.2 | If anything navigates to `accounts.google.com`, watch the TV | banner: "To sign in, visit youtube.com/activate on your phone or computer…" | the app blocks the page and shows the notice | ☐ |
| 2.3 | Watch logcat | `ShieldTube.Player  embedded OAuth blocked; directing user to youtube.com/activate` | line present | ☐ |
| 2.4 | On a phone/PC open **https://www.youtube.com/activate**, enter the code | phone shows account confirmation | YouTube accepts the code | ☐ |
| 2.5 | Back on the TV | account avatar / signed-in state appears without relaunching | signed in | ☐ |
| 2.6 | `adb shell am force-stop io.shieldtube`, relaunch the app | still signed in | cookies survived the process restart | ☐ |
| 2.7 | Reboot the TV box, relaunch | still signed in | cookies survived a reboot | ☐ |

**FAIL sign for 2.4:** "code expired" repeatedly. Re-read the code from the TV
(codes expire in minutes) before recording a FAIL.
**FAIL sign for 2.6:** signed out after restart → the WebView data directory
suffix changed (`ShieldTubeApp.onCreate`) or cookies were not flushed.

---

## 3. Ad-block spot checks (three known-heavy channels)

Use channels known to preroll/midroll heavily (music labels, large news
channels). For each video record preroll and midroll behaviour separately.

Preparation: note the counter shown by **Settings → Blocked requests: N**.

| # | Do | Observe | Pass condition | R |
|---|---|---|---|---|
| 3.1 | Open **Channel A**, start a long video | player starts | video plays | ☐ |
| 3.2 | Watch the first 30 s | no pre-roll ad and no yellow ad-progress bar | content plays within ~10 s of selection | ☐ |
| 3.3 | Seek to ~50 % and let it run 60 s | no mid-roll ad break | playback continues uninterrupted | ☐ |
| 3.4 | `adb logcat -d \| grep "BLOCK"` | `BLOCK <type> https://...` lines exist | ≥ 1 block for this session | ☐ |
| 3.5 | Settings → counters | Blocked requests increased vs the prep value | strictly increased | ☐ |
| 3.6 | Repeat 3.1–3.5 for **Channel B** | same | same | ☐ |
| 3.7 | Repeat 3.1–3.5 for **Channel C** | same | same | ☐ |

**Honest expectation:** if an ad still plays, this is a FAIL to record, not to
explain away. Attach the `BLOCK` lines and the channel name.

---

## 4. Watchdog — the content video must NOT seek

This is the regression test for the bug fixed in `2210830`: an empty
`adPlacements` array used to fast-forward the **content** video to its end.

| # | Do | Observe | Pass condition | R |
|---|---|---|---|---|
| 4.1 | Play a video **longer than 20 minutes** | note the timestamp after 10 s | timestamp advances ~1 s per second | ☐ |
| 4.2 | Watch for 60 s without touching the remote | no jump to the end, no skip to the final seconds | position advances monotonically | ☐ |
| 4.3 | `adb logcat -d \| grep "skipped-ad-segment"` | **no** line while content is playing | zero occurrences during content | ☐ |
| 4.4 | Watch logcat for `ShieldTube.Player  500 ms watchdog: stalled` | only if playback genuinely freezes | absent during normal playback | ☐ |
| 4.5 | Seek to the middle, pause 10 s, resume | playback resumes at the same position | no seek-to-end | ☐ |
| 4.6 | Start a *different* long video and leave it 2 min | position drift ≤ 2 s over the interval | no auto-skip | ☐ |

**FAIL for 4.2/4.3:** the video jumps to its last seconds or the log shows
`skipped-ad-segment` during content → the watchdog regressed. Capture:
`adb logcat -d | grep -E "watchdog|skipped"` plus the video id from the URL.

**Permitted** `skipped-ad-segment` only while an ad is visibly on screen and the
ad clip is ≤ 180 s (the `AD_MAX_SECONDS` guard).

---

## 5. Remote / D-pad

| # | Do | Observe | Pass condition | R |
|---|---|---|---|---|
| 5.1 | D-pad up/down/left/right on the home grid | focus moves between tiles | focus visibly moves | ☐ |
| 5.2 | Press **MENU** (or the remote's settings key) | the ShieldTube settings screen opens | opens, all rows reachable by D-pad | ☐ |
| 5.3 | Press **BACK** while watching a video | returns to the grid, app stays open | does **not** exit the app | ☐ |
| 5.4 | Press **BACK** on the grid | app closes | exits cleanly, no crash dialog | ☐ |
| 5.5 | Play/Pause and FF/RW media keys | playback toggles / seeks ±10 s | both work | ☐ |

---

## 6. Settings screen

| # | Do | Observe | Pass condition | R |
|---|---|---|---|---|
| 6.1 | Toggle **Shields** OFF, play a video | ads return; logcat shows no new `BLOCK` lines | behaviour changes as expected | ☐ |
| 6.2 | Toggle **Shields** back ON | blocking resumes, counter increases | resumes | ☐ |
| 6.3 | Press **Update filter lists now** | status line updates + toast | either "Lists updated (N KiB, sha256 …)" or "Update unavailable; bundled lists remain active" — both are PASS; a crash or empty status is FAIL | ☐ |
| 6.4 | After a successful update, Settings shows the new sha256 (12 chars) | not `bundled` | value changed | ☐ |
| 6.5 | Press **Open source & licenses** | GPLv3 text + source repo row | text renders; row shows the placeholder in **yellow** until `SOURCE_URL` is set | ☐ |
| 6.6 | Press **Clear cookies, data and settings** → OK | returns to player, signed out | activation code required again | ☐ |

---

## 7. Robustness (run once)

| # | Do | Observe | Pass condition | R |
|---|---|---|---|---|
| 7.1 | `adb shell am kill io.shieldtube` mid-playback, relaunch | app returns to the player | no crash loop | ☐ |
| 7.2 | Play 3 videos back-to-back for 15 min | memory stays stable, no "renderer gone" churn | logcat shows at most one `renderer gone ... recreating WebView` | ☐ |
| 7.3 | Turn Wi-Fi off, launch the app | splash then an error page, app does not crash | app stays alive; bundled lists still loaded (`engineReady=true`) | ☐ |
| 7.4 | Turn Wi-Fi on, relaunch | home grid loads | recovers without reinstall | ☐ |

---

## 8. Report back

Attach:

1. this table with every **R** filled,
2. `adb shell getprop ro.product.model`, `ro.build.version.release`,
   `ro.product.cpu.abi`,
3. `adb logcat -d -s ShieldTube.* > shieldtube.log`,
4. for each ad FAIL: the channel name, video URL and the surrounding `BLOCK`
   lines.

A build is accepted only with **zero FAILs** in sections 0, 1, 2, 4 and 5.
Section 3 ad-blocking FAILs are recorded as known defeats (they identify list
gaps, not app crashes) but block a "ready" claim.
