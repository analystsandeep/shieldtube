#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ShieldTube reproducible toolchain bootstrap.
#
# Installs, into an isolated directory, everything needed to build the Rust
# engine for four Android ABIs and to run ./gradlew assembleDebug:
#   * Rust (pinned, default 1.99.1) + four Android std targets + cargo-ndk
#   * Temurin JDK 17
#   * Android SDK: platform 34, build-tools 34.0.0, platform-tools
#   * Android NDK 27.0.12077973 (r27c)
#
# All overrides are environment variables; nothing is installed system-wide.
# Source the generated env.sh before building:
#     . "$SHIELDTUBE_TC_DIR/env.sh"
#
set -euo pipefail

# Fix (lead direction, 2026-11-11): default MUST match rust-toolchain.toml.
SHIELDTUBE_RUST_TOOLCHAIN="${SHIELDTUBE_RUST_TOOLCHAIN:-1.99.1}"

SHIELDTUBE_TC_DIR="${SHIELDTUBE_TC_DIR:-$HOME/.cache/shieldtube-tc}"
SHIELDTUBE_NDK_VERSION="${SHIELDTUBE_NDK_VERSION:-27.0.12077973}"
SHIELDTUBE_NDK_ZIP="${SHIELDTUBE_NDK_ZIP:-android-ndk-r27c-linux.zip}"
SHIELDTUBE_CMDLINE_ZIP="${SHIELDTUBE_CMDLINE_ZIP:-commandlinetools-linux-11076708_latest.zip}"
SHIELDTUBE_COMPILE_SDK="${SHIELDTUBE_COMPILE_SDK:-34}"
SHIELDTUBE_BUILD_TOOLS="${SHIELDTUBE_BUILD_TOOLS:-34.0.0}"
SHIELDTUBE_MIN_API="${SHIELDTUBE_MIN_API:-23}"

TC="$SHIELDTUBE_TC_DIR"
SDK="$TC/android-sdk"
CARGO="$TC/cargo"
RUSTUP="$TC/rustup"
JDK="$TC/jdk17"
DL="$TC/downloads"

export CARGO_HOME="$CARGO"
export RUSTUP_HOME="$RUSTUP"
export ANDROID_SDK_ROOT="$SDK"
export ANDROID_HOME="$SDK"
export JAVA_HOME="$JDK"
export PATH="$JDK/bin:$CARGO/bin:$SDK/platform-tools:$PATH"

log() { printf '\n[shieldtube/bootstrap] %s\n' "$*"; }
fetch() { curl --fail --location --silent --show-error --retry 3 --retry-delay 2 --output "$2" "$1"; }

mkdir -p "$DL" "$SDK/ndk" "$SDK/cmdline-tools"

# Preflight: four Rust targets + SDK + NDK need ~6 GB. Catch tmpfs/RAM-backed
# toolchain directories early instead of failing halfway through rustup.
AVAIL_KB=$(df -Pk "$TC" | awk 'NR==2 {print $4}')
AVAIL_GB=$((AVAIL_KB / 1024 / 1024))
log "toolchain dir $TC has ${AVAIL_GB} GiB free"
if [ "$AVAIL_KB" -lt $((6 * 1024 * 1024)) ]; then
  echo "ERROR: need at least 6 GiB free for Rust targets + Android SDK/NDK." >&2
  echo "       Set SHIELDTUBE_TC_DIR to a disk-backed path (not /tmp on tmpfs)." >&2
  exit 1
fi

# ---------------------------------------------------------------- Rust ------
if [ ! -x "$CARGO/bin/rustup" ]; then
  log "installing rustup (toolchain $SHIELDTUBE_RUST_TOOLCHAIN)"
  curl --fail --location --silent --show-error https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --profile minimal --default-toolchain "$SHIELDTUBE_RUST_TOOLCHAIN"
else
  log "rustup already present; ensuring $SHIELDTUBE_RUST_TOOLCHAIN is installed"
  "$CARGO/bin/rustup" toolchain install "$SHIELDTUBE_RUST_TOOLCHAIN" --profile minimal
fi
"$CARGO/bin/rustup" default "$SHIELDTUBE_RUST_TOOLCHAIN"
for t in aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android; do
  log "rustup target add $t"
  "$CARGO/bin/rustup" target add --toolchain "$SHIELDTUBE_RUST_TOOLCHAIN" "$t"
done
if ! "$CARGO/bin/cargo" ndk --version >/dev/null 2>&1; then
  log "cargo install cargo-ndk --locked"
  "$CARGO/bin/cargo" install cargo-ndk --locked
else
  log "cargo-ndk already installed: $("$CARGO/bin/cargo" ndk --version)"
fi

# ----------------------------------------------------------------- JDK -------
if [ ! -x "$JDK/bin/java" ]; then
  log "downloading Temurin JDK 17"
  fetch 'https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse' "$DL/jdk17.tar.gz"
  rm -rf "$TC/jdk17-unpacked" && mkdir -p "$TC/jdk17-unpacked"
  tar -xzf "$DL/jdk17.tar.gz" -C "$TC/jdk17-unpacked" --strip-components=1
  rm -rf "$JDK" && mv "$TC/jdk17-unpacked" "$JDK"
else
  log "JDK 17 already present: $("$JDK/bin/java" -version 2>&1 | head -1)"
fi

# ------------------------------------------------------- SDK cmdline tools ---
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  log "downloading Android command-line tools"
  fetch "https://dl.google.com/android/repository/$SHIELDTUBE_CMDLINE_ZIP" "$DL/cmdline-tools.zip"
  rm -rf "$TC/cmdline-unpacked" && mkdir -p "$TC/cmdline-unpacked"
  unzip -q "$DL/cmdline-tools.zip" -d "$TC/cmdline-unpacked"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$TC/cmdline-unpacked/cmdline-tools" "$SDK/cmdline-tools/latest"
fi
SDKM="$SDK/cmdline-tools/latest/bin/sdkmanager"
log "accepting SDK licenses"
yes | "$SDKM" --licenses >/dev/null 2>&1 || true
log "installing platforms;android-$SHIELDTUBE_COMPILE_SDK / build-tools;$SHIELDTUBE_BUILD_TOOLS / platform-tools"
"$SDKM" --install \
  "platforms;android-$SHIELDTUBE_COMPILE_SDK" \
  "build-tools;$SHIELDTUBE_BUILD_TOOLS" \
  "platform-tools" >/dev/null

# ----------------------------------------------------------------- NDK -------
NDK_DIR="$SDK/ndk/$SHIELDTUBE_NDK_VERSION"
if [ ! -d "$NDK_DIR/toolchains/llvm/prebuilt" ]; then
  log "downloading NDK $SHIELDTUBE_NDK_VERSION"
  fetch "https://dl.google.com/android/repository/$SHIELDTUBE_NDK_ZIP" "$DL/$SHIELDTUBE_NDK_ZIP"
  rm -rf "$TC/ndk-unpacked" && mkdir -p "$TC/ndk-unpacked"
  unzip -q "$DL/$SHIELDTUBE_NDK_ZIP" -d "$TC/ndk-unpacked"
  NDK_SRC=$(find "$TC/ndk-unpacked" -maxdepth 1 -mindepth 1 -type d -name 'android-ndk-*' | head -1)
  [ -n "$NDK_SRC" ] || { echo 'NDK archive has unexpected layout' >&2; exit 1; }
  rm -rf "$NDK_DIR" && mv "$NDK_SRC" "$NDK_DIR"
fi
export ANDROID_NDK_HOME="$NDK_DIR"

# --------------------------------------------------------------- env.sh ------
cat > "$TC/env.sh" <<EOF
# Generated by scripts/bootstrap-toolchain.sh. Source this file before building.
export SHIELDTUBE_TC_DIR="$TC"
export SHIELDTUBE_RUST_TOOLCHAIN="$SHIELDTUBE_RUST_TOOLCHAIN"
export CARGO_HOME="$CARGO"
export RUSTUP_HOME="$RUSTUP"
export JAVA_HOME="$JDK"
export ANDROID_SDK_ROOT="$SDK"
export ANDROID_HOME="$SDK"
export ANDROID_NDK_HOME="$NDK_DIR"
export PATH="\$JAVA_HOME/bin:\$CARGO_HOME/bin:\$ANDROID_SDK_ROOT/platform-tools:\$PATH"
EOF

log "TOOLCHAIN READY"
printf '  rust          : %s\n' "$("$CARGO/bin/rustc" --version)"
printf '  java          : %s\n' "$("$JDK/bin/java" -version 2>&1 | head -1)"
printf '  cargo-ndk     : %s\n' "$("$CARGO/bin/cargo" ndk --version 2>&1 | head -1)"
printf '  ANDROID_SDK   : %s\n' "$SDK"
printf '  ANDROID_NDK   : %s\n' "$NDK_DIR"
printf '  minApi        : %s\n' "$SHIELDTUBE_MIN_API"
printf '\n  next: . %s/env.sh && bash scripts/build-rust.sh && ./gradlew assembleDebug\n' "$TC"
