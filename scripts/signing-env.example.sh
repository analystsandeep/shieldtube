#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Optional real release signing. Without these variables, assembleRelease uses
# the debug key (lead decision 2026-11-11) and is NOT distributable.
#
# Generate a key with:
#   keytool -genkeypair -v -keystore shieldtube-release.jks \
#     -alias shieldtube -keyalg RSA -keysize 4096 -validity 10000
# then export:
export SHIELDTUBE_RELEASE_STORE_FILE="$HOME/.shieldtube/shieldtube-release.jks"
export SHIELDTUBE_RELEASE_STORE_PASSWORD="change-me"
export SHIELDTUBE_RELEASE_KEY_ALIAS="shieldtube"
export SHIELDTUBE_RELEASE_KEY_PASSWORD="change-me"
