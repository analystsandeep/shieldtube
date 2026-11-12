<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Built APKs

`app-debug.apk` and `app-release.apk` are regenerated build artefacts, not
source files. They are ignored by Git via `*.apk` and copied here because
Gradle's `app/build/` directory is not persisted in this workspace snapshot.
Regenerate with:

```bash
. "$HOME/.cache/shieldtube-tc/env.sh"
./gradlew assembleDebug assembleRelease
cp app/build/outputs/apk/debug/app-debug.apk apks/app-debug.apk
cp app/build/outputs/apk/release/app-release.apk apks/app-release.apk
```

The release APK is **debug-signed** by default and is not distributable. See
`docs/BUILD.md` for real release signing.
