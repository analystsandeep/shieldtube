#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Artifact audits for the two APKs. Every check here is one the lead asked for
# in the turn-4 brief, and every failure is a real defect -- there is no
# allow-failure path.
#
#   bash scripts/audit-apks.sh [debug.apk] [release.apk]
#
# Checks:
#   1. Permissions in the release manifest are a known, minimal set.
#   2. Every exported component is accounted for by name; nothing else may be
#      exported.
#   3. allowBackup=false and usesCleartextTraffic=false.
#   4. The debug-vs-release content delta is exactly the expected set, given
#      R8 shrinking + resource shrinking in release and the uBO tree that is
#      deliberately kept out of release.
#   5. Two given APKs of the SAME variant have identical content listings
#      (name + size). Byte equality is NOT required and must not be required:
#      measured, the signer and R8 emit non-deterministic bytes (see BUILD.md).
#
# Requires: unzip, aapt2 (from the Android SDK build-tools on PATH or
# $ANDROID_HOME/build-tools/*/aapt2).
set -euo pipefail

DEBUG_APK="${1:-app/build/outputs/apk/debug/app-debug.apk}"
RELEASE_APK="${2:-app/build/outputs/apk/release/app-release.apk}"
EXTRA_DEBUG_APK="${3:-}"   # optional: a second build of the same variant

fail=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=$((fail + 1)); }
note() { printf '        %s\n' "$*"; }

AAPT2=""
for cand in \
    "${ANDROID_HOME:-/nonexistent}/build-tools/34.0.0/aapt2" \
    "${ANDROID_SDK_ROOT:-/nonexistent}/build-tools/34.0.0/aapt2"; do
    [ -x "$cand" ] && AAPT2="$cand" && break
done
[ -n "$AAPT2" ] || AAPT2="$(command -v aapt2 || true)"
[ -n "$AAPT2" ] || { echo "ERROR: aapt2 not found (set ANDROID_HOME)" >&2; exit 2; }
for f in "$DEBUG_APK" "$RELEASE_APK"; do
    [ -f "$f" ] || { echo "ERROR: missing $f" >&2; exit 2; }
done

echo "debug   : $DEBUG_APK ($(stat -c%s "$DEBUG_APK") bytes)"
echo "release : $RELEASE_APK ($(stat -c%s "$RELEASE_APK") bytes)"
echo "aapt2   : $AAPT2"

# ------------------------------------------------------------------ 1. perms -
echo
echo "== permissions =="
PERMS=$("$AAPT2" dump badging "$RELEASE_APK" 2>/dev/null \
    | sed -n "s/^uses-permission: name='\(.*\)'$/\1/p" | sort)
echo "$PERMS" | sed 's/^/        /'
EXPECTED_PERMS=$(printf 'android.permission.INTERNET\nio.shieldtube.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION\n' | sort)
if [ "$PERMS" = "$EXPECTED_PERMS" ]; then
    ok "permission set is exactly {INTERNET, DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION}"
else
    bad "unexpected permission set"
    diff <(echo "$EXPECTED_PERMS") <(echo "$PERMS") | sed 's/^/        /' || true
fi

# ------------------------------------------------------- 2. exported pieces -
echo
echo "== exported components (release) =="
# Only these may be exported, and each for a stated reason:
#   PlayerActivity            launcher + VIEW intent filter (must be exported)
#   ProfileInstallReceiver    AndroidX profileinstaller, gated by
#                             android.permission.DUMP (signature|privileged), which
#                             only shell/root or a privileged app can hold
EXPORTED=$("$AAPT2" dump xmltree --file AndroidManifest.xml "$RELEASE_APK" 2>/dev/null \
    | awk '
        /^ *E: (activity|service|receiver|provider)/ { kind=$2; name=""; next }
        /android:name\(0x[0-9a-f]+\)=/ && name == "" {
            if (match($0, /"([^"]*)"/)) name = substr($0, RSTART + 1, RLENGTH - 2)
        }
        /android:exported\(0x01010010\)=true/ { if (name != "") print kind " " name }
      ' | sort -u)
echo "$EXPORTED" | sed 's/^/        /'
EXPECTED_EXPORTED=$(printf '%s\n' \
    "activity io.shieldtube.player.PlayerActivity" \
    "receiver androidx.profileinstaller.ProfileInstallReceiver" | sort -u)
if [ "$EXPORTED" = "$EXPECTED_EXPORTED" ]; then
    ok "exported set is exactly the launcher activity + the DUMP-gated profileinstaller receiver"
else
    bad "unexpected exported component set"
    diff <(echo "$EXPECTED_EXPORTED") <(echo "$EXPORTED") | sed 's/^/        /' || true
fi

# The profileinstaller receiver must be permission-gated, or it is a real hole.
if "$AAPT2" dump xmltree --file AndroidManifest.xml "$RELEASE_APK" 2>/dev/null \
    | grep -A4 'androidx.profileinstaller.ProfileInstallReceiver' \
    | grep -q 'android.permission.DUMP'; then
    ok "ProfileInstallReceiver is gated by android.permission.DUMP"
else
    bad "ProfileInstallReceiver is exported WITHOUT a permission gate"
fi

# ------------------------------------------------- 3. hardening attributes --
echo
echo "== manifest hardening =="
MANIFEST=$("$AAPT2" dump xmltree --file AndroidManifest.xml "$RELEASE_APK" 2>/dev/null)
if echo "$MANIFEST" | grep -q 'android:allowBackup(0x01010280)=false'; then
    ok "allowBackup=false"
else
    bad "allowBackup is not false"
fi
if echo "$MANIFEST" | grep -q 'android:usesCleartextTraffic(0x010104ec)=false'; then
    ok "usesCleartextTraffic=false"
else
    bad "usesCleartextTraffic is not false"
fi
if echo "$MANIFEST" | grep -q 'android:debuggable(0x0101000f)=true'; then
    bad "release manifest is debuggable"
else
    ok "release manifest is not debuggable"
fi

# --------------------------------------------- 4. debug vs release content -
echo
echo "== debug vs release content delta =="
unzip -l "$DEBUG_APK"   | awk 'NR>3 && NF>=4 {print $4}' | grep -v '^$' | sort -u > /tmp/audit_dbg.txt
unzip -l "$RELEASE_APK" | awk 'NR>3 && NF>=4 {print $4}' | grep -v '^$' | sort -u > /tmp/audit_rel.txt
ONLY_REL=$(comm -13 /tmp/audit_dbg.txt /tmp/audit_rel.txt)
ONLY_DBG=$(comm -23 /tmp/audit_dbg.txt /tmp/audit_rel.txt)
UBO=$(echo "$ONLY_DBG" | grep -c '^assets/legal/ubo' || true)
OTHER=$(echo "$ONLY_DBG" | grep -v '^assets/legal/ubo' | grep -v '^$' || true)

note "debug entries=$(wc -l < /tmp/audit_dbg.txt) release entries=$(wc -l < /tmp/audit_rel.txt)"
note "uBO tree present only in debug: $UBO entries (must be >0: release must drop it)"
if [ "$UBO" -gt 0 ]; then
    ok "release excludes the uBO scriptlet tree"
else
    bad "release still contains assets/legal/ubo (the mergeReleaseAssets delete did not run)"
fi

# Release-only entries: R8/resource shrinking outputs plus the baseline profile.
# Anything else must be reviewed. This list is asserted, not just printed, so a
# new release-only entry cannot slip through unnoticed.
EXPECTED_ONLY_REL=$(printf '%s\n' \
    "META-INF/version-control-info.textproto" \
    "assets/dexopt/baseline.prof" \
    "assets/dexopt/baseline.profm" \
    "kotlin-tooling-metadata.json" \
    "res/dN.png" \
    "res/yn.png" | sort)
if [ "$ONLY_REL" = "$EXPECTED_ONLY_REL" ]; then
    ok "the only release-only entries are the baseline profile, kotlin metadata and version-control-info"
else
    bad "unexpected release-only entries"
    diff <(echo "$EXPECTED_ONLY_REL") <(echo "$ONLY_REL") | sed 's/^/        /' || true
fi

# The remaining debug-only entries are R8/resource-shrinker removals. Report the
# categories so the delta is legible in CI logs, and fail only if something
# outside the known categories appears.
note "debug-only entries outside the uBO tree: $(echo "$OTHER" | grep -c . || true)"
UNEXPECTED_OTHER=$(echo "$OTHER" | grep -vE '^(classes[0-9]*\.dex|META-INF/services/kotlinx\.coroutines.*|res/(drawable|layout|mipmap)[^/]*/.*|kotlin/.*)$' || true)
if [ -z "$UNEXPECTED_OTHER" ]; then
    ok "all other debug-only entries are dex splits, coroutine service files or shrinker-removed resources"
else
    bad "unexpected debug-only entries"
    echo "$UNEXPECTED_OTHER" | sed 's/^/        /'
fi

# ------------------------------------- 5. two builds of one variant agree --
if [ -n "$EXTRA_DEBUG_APK" ]; then
    echo
    echo "== two builds of the same variant: content listing =="
    [ -f "$EXTRA_DEBUG_APK" ] || { echo "ERROR: missing $EXTRA_DEBUG_APK" >&2; exit 2; }
    unzip -l "$DEBUG_APK"       | awk 'NR>3 && NF>=4 {print $1, $4}' | grep -v '^$' | sort > /tmp/audit_a.list
    unzip -l "$EXTRA_DEBUG_APK" | awk 'NR>3 && NF>=4 {print $1, $4}' | grep -v '^$' | sort > /tmp/audit_b.list
    if diff -q /tmp/audit_a.list /tmp/audit_b.list >/dev/null; then
        ok "content listings identical (name and size) across two builds"
    else
        bad "content listings differ across two builds"
        diff /tmp/audit_a.list /tmp/audit_b.list | head -40 | sed 's/^/        /' || true
    fi
    # Byte equality is expected to FAIL; record the hashes so the report can
    # state the fact rather than assert it.
    note "sha256 a: $(sha256sum "$DEBUG_APK" | cut -d' ' -f1)"
    note "sha256 b: $(sha256sum "$EXTRA_DEBUG_APK" | cut -d' ' -f1)"
fi

echo
if [ "$fail" -eq 0 ]; then
    echo "AUDIT PASS: all checks green"
    exit 0
fi
echo "AUDIT FAIL: $fail check(s) failed"
exit 1
