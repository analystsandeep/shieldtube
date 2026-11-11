#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Host cdylib for JVM unit tests that call the JNI surface.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO/rust"
cargo build
echo "[shieldtube] host lib: $REPO/rust/target/debug/libshieldtube.so"
