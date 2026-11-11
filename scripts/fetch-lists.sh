#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Deterministic, checksummed filter-list vendor.
#
# Every upstream file is fetched at a PINNED COMMIT SHA (never a moving branch),
# pruned by scripts/prune_lists.py, and written to
# app/src/main/assets/lists/ together with SOURCES.json and CHECKSUMS.sha256.
# Re-running with the same pins reproduces byte-identical output; if an upstream
# blob changes at a pinned SHA, prune_lists.py aborts instead of shipping it.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO/app/src/main/assets/lists"
LEGAL="$REPO/app/src/main/assets/legal"
WORK="${SHIELDTUBE_VENDOR_WORK:-$REPO/.cache/list-vendor}"
RAW="$WORK/raw"

BRAVE_LISTS_SHA="a190fe07fe27b697dc796d54a54b58dfd75e7b1c"
UASSETS_SHA="9f1bcde83a6a6abd0c90a645aaba0cca5efc0235"
EASYLIST_SHA="6282f2d26c22d416d33740febd58ad6908b94f1d"
ADBLOCK_RESOURCES_SHA="6da9b247c3368baa8b4f24cd02046e18702a6527"
UBLOCK_SHA="2bc679d99afe5bddd8fe3ab60137966a12123f41"

mkdir -p "$RAW" "$OUT" "$LEGAL"
fetch() { # url  destination
  printf '  %-38s <- %s\n' "$2" "$1"
  curl --fail --location --silent --show-error --retry 3 --retry-delay 2 -o "$RAW/$2" "$1"
}

echo "[shieldtube] fetching pinned upstream blobs"
BR="https://raw.githubusercontent.com/brave/adblock-lists/$BRAVE_LISTS_SHA"
UA="https://raw.githubusercontent.com/uBlockOrigin/uAssets/$UASSETS_SHA"
EL="https://raw.githubusercontent.com/easylist/easylist/$EASYLIST_SHA"
AR="https://raw.githubusercontent.com/brave/adblock-resources/$ADBLOCK_RESOURCES_SHA"
UB="https://raw.githubusercontent.com/gorhill/uBlock/$UBLOCK_SHA"

fetch "$BR/brave-lists/brave-specific.txt"                 brave-specific.txt
fetch "$BR/brave-unbreak.txt"                              brave-unbreak.txt
fetch "$UA/filters/filters.txt"                           ubo-filters.txt
fetch "$UA/filters/filters-2026.txt"                      ubo-filters-2026.txt
fetch "$UA/filters/quick-fixes.txt"                       ubo-quick-fixes.txt
fetch "$UA/filters/unbreak.txt"                           ubo-unbreak.txt
fetch "$EL/easylist/easylist_adservers.txt"               easylist-adservers.txt
fetch "$EL/easylist/easylist_general_block.txt"           easylist-general-block.txt
fetch "$EL/easylist/easylist_specific_block.txt"          easylist-specific-block.txt
fetch "$EL/easylist/easylist_thirdparty.txt"              easylist-thirdparty.txt
fetch "$EL/easylist/easylist_allowlist.txt"               easylist-allowlist.txt
fetch "$EL/easyprivacy/easyprivacy_general.txt"           easyprivacy-general.txt
fetch "$EL/easyprivacy/easyprivacy_thirdparty.txt"        easyprivacy-thirdparty.txt
fetch "$EL/easyprivacy/easyprivacy_specific_uBO.txt"      easyprivacy-specific-ubo.txt
fetch "$EL/easyprivacy/easyprivacy_allowlist.txt"         easyprivacy-allowlist.txt
fetch "$AR/dist/resources.json"                           resources.json
fetch "$UB/src/js/resources/scriptlets.js"                ubo-scriptlets.js

cat > "$RAW/sources.json" <<EOF
[
  {"file":"brave-specific.txt","repo":"brave/adblock-lists","sha":"$BRAVE_LISTS_SHA","path":"brave-lists/brave-specific.txt","license":"MPL-2.0"},
  {"file":"brave-unbreak.txt","repo":"brave/adblock-lists","sha":"$BRAVE_LISTS_SHA","path":"brave-unbreak.txt","license":"MPL-2.0"},
  {"file":"ubo-filters.txt","repo":"uBlockOrigin/uAssets","sha":"$UASSETS_SHA","path":"filters/filters.txt","license":"GPL-3.0"},
  {"file":"ubo-filters-2026.txt","repo":"uBlockOrigin/uAssets","sha":"$UASSETS_SHA","path":"filters/filters-2026.txt","license":"GPL-3.0"},
  {"file":"ubo-quick-fixes.txt","repo":"uBlockOrigin/uAssets","sha":"$UASSETS_SHA","path":"filters/quick-fixes.txt","license":"GPL-3.0"},
  {"file":"ubo-unbreak.txt","repo":"uBlockOrigin/uAssets","sha":"$UASSETS_SHA","path":"filters/unbreak.txt","license":"GPL-3.0"},
  {"file":"easylist-adservers.txt","repo":"easylist/easylist","sha":"$EASYLIST_SHA","path":"easylist/easylist_adservers.txt","license":"GPL-3.0"},
  {"file":"easylist-general-block.txt","repo":"easylist/easylist","sha":"$EASYLIST_SHA","path":"easylist/easylist_general_block.txt","license":"GPL-3.0"},
  {"file":"easylist-specific-block.txt","repo":"easylist/easylist","sha":"$EASYLIST_SHA","path":"easylist/easylist_specific_block.txt","license":"GPL-3.0"},
  {"file":"easylist-thirdparty.txt","repo":"easylist/easylist","sha":"$EASYLIST_SHA","path":"easylist/easylist_thirdparty.txt","license":"GPL-3.0"},
  {"file":"easylist-allowlist.txt","repo":"easylist/easylist","sha":"$EASYLIST_SHA","path":"easylist/easylist_allowlist.txt","license":"GPL-3.0"},
  {"file":"easyprivacy-general.txt","repo":"easylist/easylist","sha":"$EASYLIST_SHA","path":"easyprivacy/easyprivacy_general.txt","license":"GPL-3.0"},
  {"file":"easyprivacy-thirdparty.txt","repo":"easylist/easylist","sha":"$EASYLIST_SHA","path":"easyprivacy/easyprivacy_thirdparty.txt","license":"GPL-3.0"},
  {"file":"easyprivacy-specific-ubo.txt","repo":"easylist/easylist","sha":"$EASYLIST_SHA","path":"easyprivacy/easyprivacy_specific_uBO.txt","license":"GPL-3.0"},
  {"file":"easyprivacy-allowlist.txt","repo":"easylist/easylist","sha":"$EASYLIST_SHA","path":"easyprivacy/easyprivacy_allowlist.txt","license":"GPL-3.0"},
  {"file":"resources.json","repo":"brave/adblock-resources","sha":"$ADBLOCK_RESOURCES_SHA","path":"dist/resources.json","license":"MPL-2.0 (contains GPL-3.0 uBO-derived scriptlets)"},
  {"file":"ubo-scriptlets.js","repo":"gorhill/uBlock","sha":"$UBLOCK_SHA","path":"src/js/resources/scriptlets.js","license":"GPL-3.0"}
]
EOF

echo "[shieldtube] pruning (English + generic only) and writing checksums"
python3 "$REPO/scripts/prune_lists.py" \
  --raw "$RAW" \
  --out "$OUT" \
  --legal "$LEGAL" \
  --previous "$OUT/SOURCES.json"

echo "[shieldtube] verifying checksums"
bash "$REPO/scripts/verify-checksums.sh" "$OUT"

echo "[shieldtube] vendored size:"
du -ch "$OUT"/* | tail -1
