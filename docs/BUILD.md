<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Building ShieldTube

Verified end-to-end on 2026-11-11 in a clean Linux sandbox.

## Exact toolchain

| Component | Version |
|---|---|
| Rust | **1.99.1** (`rust-toolchain.toml`, `SHIELDTUBE_RUST_TOOLCHAIN` default) |
| Rust targets | `aarch64-linux-android`, `armv7-linux-androideabi`, `x86_64-linux-android`, `i686-linux-android` |
| cargo-ndk | 4.1.2 (installed with `--locked`) |
| NDK | **27.0.12077973** (r27c), minApi `-P 23` |
| JDK | Temurin **17.0.21** |
| Android SDK | platform `android-34`, build-tools `34.0.0`, platform-tools |
| Gradle | **8.9** (`gradle-wrapper.properties`) |
| AGP | **8.5.2** |
| Kotlin | **1.9.24** |
| compileSdk / targetSdk / minSdk | 34 / 34 / 23 |
| adblock-rust | `=0.13.5`, sha256 `7a4c8558f27608dec74695c866f9a8ef897ec7a77cb826f8a5baf0b8ba461d2a` |

## Reproduce from scratch

```bash
git clone <SOURCE_URL> shieldtube && cd shieldtube

# 1. Toolchain (idempotent; defaults to $HOME/.cache/shieldtube-tc)
bash scripts/bootstrap-toolchain.sh
. "$HOME/.cache/shieldtube-tc/env.sh"

# 2. Pin the Android SDK for Gradle
printf 'sdk.dir=%s\n' "$ANDROID_SDK_ROOT" > local.properties

# 3. Vendor the lists (already committed; re-run is deterministic)
bash scripts/fetch-lists.sh          # blobs pinned by commit SHA
bash scripts/verify-checksums.sh app/src/main/assets/lists

# 4. Prove the engine before any UI
cargo test --manifest-path rust/Cargo.toml -- --nocapture       # 9 tests
./gradlew testDebugUnitTest                                     # JNI/JVM, 2 tests

# 5. Build the four cdylibs
bash scripts/build-rust.sh
ls app/src/main/jniLibs/

# 6. Build the APKs
./gradlew assembleDebug
./gradlew assembleRelease
```

`./gradlew assembleDebug` also runs `buildRustForAndroid` automatically via
`preBuild` whenever any of the four `.so` files is missing.

## Rust cross-compilation, exactly

`scripts/build-rust.sh` runs:

```bash
cd rust
ANDROID_NDK_HOME="$ANDROID_SDK_ROOT/ndk/27.0.12077973" \
ANDROID_NDK_ROOT="$ANDROID_SDK_ROOT/ndk/27.0.12077973" \
cargo ndk -P 23 \
  -t arm64-v8a -t armeabi-v7a -t x86_64 -t x86 \
  -o ../app/src/main/jniLibs \
  build --release
```

cargo-ndk sets `CC_<triple>`, `AR_<triple>`, `CARGO_TARGET_<TRIPLE>_LINKER`
to the NDK 27 LLVM clang for each target. Manual equivalent (no cargo-ndk):

```bash
NDK="$ANDROID_SDK_ROOT/ndk/27.0.12077973"
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
export CC_aarch64_linux_android="$TOOLCHAIN/aarch64-linux-android23-clang"
export AR_aarch64_linux_android="$TOOLCHAIN/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC_aarch64_linux_android"
cargo build --target aarch64-linux-android --release
# ...repeat for armv7-linux-androideabi (…eabi23-clang),
#    x86_64-linux-android (…23-clang), i686-linux-android (…23-clang)
```

`rust/build.rs` regenerates `rust/include/shieldtube.h` with cbindgen 0.29 on
every build (parsing `src/ffi_c.rs` only). The header compiles as C11 and C++17
(both verified with `-Wall -Wextra -Werror`).

Panic policy: `[profile.dev]` and `[profile.release]` both use
`panic = "unwind"`; `catch_unwind` at every FFI boundary. Do **not** set
`panic = "abort"` (the archived Brave FFI fork does, which is one reason it is
not used).

## Release signing

Lead decision 2026-11-11: **debug-sign release** so the APK is installable
today; it is labelled NON-DISTRIBUTABLE. For a real release:

```bash
keytool -genkeypair -v -keystore shieldtube-release.jks \
  -alias shieldtube -keyalg RSA -keysize 4096 -validity 10000
source scripts/signing-env.example.sh   # edit the four variables first
./gradlew assembleRelease
```

`app/build.gradle.kts` switches to `signingConfigs.release` automatically when
`SHIELDTUBE_RELEASE_STORE_FILE` is set.

Verified: `apksigner verify` on `app-release.apk` →
`Verifies`, v1 = true, v2 = true, 1 signer.

## Verified build outputs (2026-11-11)

```
cargo test ......................... 9 passed; 0 failed
assembleDebug ...................... BUILD SUCCESSFUL in 57s
assembleRelease .................... BUILD SUCCESSFUL in 38s
testDebugUnitTest .................. BUILD SUCCESSFUL in 20s
app/src/main/jniLibs/arm64-v8a/libshieldtube.so    4216248
app/src/main/jniLibs/armeabi-v7a/libshieldtube.so  2990772
app/src/main/jniLibs/x86/libshieldtube.so          3828336
app/src/main/jniLibs/x86_64/libshieldtube.so       4042800
app/build/outputs/apk/debug/app-debug.apk          17626527
app/build/outputs/apk/release/app-release.apk      15522299
```

Known non-fatal build warning: `stripDebugDebugSymbols` reports "Unable to
strip … libshieldtube.so" because AGP's default NDK path is not configured;
the `.so` files are packaged unstripped. They are already `strip =
"debuginfo"` in Cargo, so the APK cost is small. Set `android.ndkPath` to the
r27c dir to silence it.

## Real-device testing (lead confirmed a real ARM TV box)

```bash
adb connect <tv-ip>:5555
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb logcat -s ShieldTube.Player ShieldTube.Client ShieldTube.Engine
./gradlew connectedDebugAndroidTest     # offline fixture smoke test
```

The emulator is not representative (§8). Widevine L3 caps are expected.
