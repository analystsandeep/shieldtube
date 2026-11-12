#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Cross-compile the engine for all four Android ABIs into app/src/main/jniLibs.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JNI="$REPO/app/src/main/jniLibs"

: "${ANDROID_NDK_HOME:?source the env.sh produced by bootstrap-toolchain.sh first}"
export ANDROID_NDK_ROOT="${ANDROID_NDK_ROOT:-$ANDROID_NDK_HOME}"
export ANDROID_NDK_HOME

echo "[shieldtube] NDK: $ANDROID_NDK_HOME"
echo "[shieldtube] building arm64-v8a, armeabi-v7a, x86_64, x86 (minApi 23)"
cd "$REPO/rust"
cargo ndk \
  -P 23 \
  -t arm64-v8a -t armeabi-v7a -t x86_64 -t x86 \
  -o "$JNI" \
  build --release

echo "[shieldtube] jniLibs:"
find "$JNI" -name 'libshieldtube.so' -printf '%P %s bytes\n' | sort
