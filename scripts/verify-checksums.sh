#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
DIR="${1:-app/src/main/assets/lists}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Accept both absolute paths (from fetch-lists.sh) and repo-relative paths.
if [[ "$DIR" = /* ]]; then ABS="$DIR"; else ABS="$REPO/$DIR"; fi
cd "$ABS"
[ -f CHECKSUMS.sha256 ] || { echo "missing CHECKSUMS.sha256" >&2; exit 1; }
sha256sum --check CHECKSUMS.sha256
echo "[shieldtube] all bundled list checksums verified"
