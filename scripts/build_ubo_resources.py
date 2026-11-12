#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Deterministically build adblock-rust resources from pinned uBlock Origin JS.

This closes the §7b scriptlet-coverage gap. It vendors the complete GPLv3
source of uBO's scriptlet registry and web-accessible redirect resources at a
pinned commit, bundles the registry with a pinned esbuild, and emits
function-style adblock-rust `Resource` records. No hand-maintained scriptlet
implementations: the generated wrappers call the real uBO functions.

Inputs:  --refs JSON {"scriptlets":[...], "redirects":[...]}
Outputs: --out JSON array of Resource records, plus GPLv3 source under
         --source-dir and a checksummed generated bundle.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

UBO_SHA = "2bc679d99afe5bddd8fe3ab60137966a12123f41"
ESBUILD_VERSION = "0.25.10"

RESOURCE_FILES = [
    "abort-current-script.js", "attribute.js", "base.js", "cookie.js",
    "create-html.js", "href-sanitizer.js", "json-edit.js", "json-prune.js",
    "localstorage.js", "noeval.js", "object-prune.js", "parse-replace.js",
    "prevent-addeventlistener.js", "prevent-bab.js",
    "prevent-clipboard-write.js", "prevent-dialog.js", "prevent-fetch.js",
    "prevent-innerHTML.js", "prevent-navigation.js", "prevent-settimeout.js",
    "replace-argument.js", "scriptlets.js", "set-constant.js",
    "shared.js", "spoof-css.js", "stack-trace.js", "utils.js", "vod.js",
    "run-at.js", "safe-self.js", "proxy-apply.js", "prevent-xhr.js",
]
PARENT_FILES = ["arglist-parser.js", "jsonpath.js", "urlskip.js"]
WAR_FILES = [
    "1x1.gif", "2x2.png", "32x32.png", "3x2.png", "README.txt",
    "adthrive_abd.js", "amazon_ads.js", "amazon_apstag.js",
    "ampproject_v0.js", "chartbeat.js", "click2load.html",
    "dom-inspector.html", "doubleclick_instream_ad_status.js", "empty",
    "epicker-ui.html", "fingerprint2.js", "fingerprint3.js",
    "freestar_pubfig.js", "google-analytics_analytics.js",
    "google-analytics_cx_api.js", "google-analytics_ga.js",
    "google-analytics_inpage_linkid.js", "google-ima-dai.js",
    "google-ima.js", "googlesyndication_adsbygoogle.js",
    "googletagmanager_gtm.js", "googletagservices_gpt.js", "hd-main.js",
    "nitropay_ads.js", "nobab2.js", "noeval-silent.js", "noeval.js",
    "nofab.js", "noop-0.1s.mp3", "noop-0.5s.mp3", "noop-1s.mp4",
    "noop-vast2.xml", "noop-vast3.xml", "noop-vast4.xml",
    "noop-vmap1.xml", "noop.css", "noop.html", "noop.js", "noop.json",
    "noop.txt", "outbrain-widget.js", "piano-analytics.js",
    "popads-dummy.js", "popads.js", "prebid-ads.js",
    "scorecardresearch_beacon.js", "sensors-analytics.js",
]

# Legacy filter-list names -> upstream web-accessible-resource file.
WAR_MAP = {
    "amazon-adsystem.com/aax2/amzn_ads.js": "amazon_ads.js",
    "google-analytics.com/analytics.js": "google-analytics_analytics.js",
    "fingerprint2": "fingerprint2.js",
    "noopframe": "noop.html",
    "noopjs": "noop.js",
    "noopmp3-0.1s": "noop-0.1s.mp3",
    "noopmp4-1s": "noop-1s.mp4",
    "nooptext": "noop.txt",
    "popads-dummy": "popads-dummy.js",
    "popads.net": "popads-dummy.js",
    "noeval": "noeval.js",
    "nofab": "nofab.js",
}

MIME_BY_EXT = {
    "css": "text/css", "gif": "image/gif", "html": "text/html",
    "js": "application/javascript", "json": "application/json",
    "mp3": "audio/mp3", "mp4": "video/mp4", "png": "image/png",
    "txt": "text/plain", "xml": "text/xml",
}

LICENSE_HEADER = """/*
 * ShieldTube uBO scriptlet registry — generated from gorhill/uBlock
 * Copyright (C) 2019-present Raymond Hill
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See LICENSE and docs/LICENSING.md.
 *
 * Pinned upstream commit: %s
 * Bundler: esbuild %s. Corresponding source is in resources/ and war/.
 */
""" % (UBO_SHA, ESBUILD_VERSION)

README = """<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# uBlock Origin scriptlet source

This directory contains the **complete corresponding source** for the uBO
scriptlets and web-accessible redirect resources compiled into
`assets/lists/resources.json`.

* Upstream: `https://github.com/gorhill/uBlock`
* Pinned commit: `%s`
* `resources/` — `src/js/resources/*.js` plus the three parent modules they import.
* `war/` — `src/web_accessible_resources/*` redirect stand-ins.
* `ubo-registry.js` — deterministic minified bundle produced by esbuild %s.
* `SHA256SUMS` — checksums for every source file and the generated bundle.

All upstream files are GPL-3.0-or-later. Our build script is
`scripts/build_ubo_resources.py`; the app itself is GPL-3.0-or-later. See
`docs/LICENSING.md` and `docs/SPEC-DEVIATIONS.md` §7b.
""" % (UBO_SHA, ESBUILD_VERSION)


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "ShieldTube-vendor/1.0"})
    last = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001 - deterministic retry
            last = exc
    raise RuntimeError(f"failed to fetch {url}: {last}")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def resource(name: str, aliases: list[str], kind: dict, content: bytes,
             dependencies: list[str] | None = None,
             permission: int | None = None) -> dict:
    out = {
        "name": name,
        "aliases": sorted(set(a for a in aliases if a and a != name)),
        "kind": kind,
        "content": b64(content),
    }
    if dependencies:
        out["dependencies"] = sorted(set(dependencies))
    if permission is not None:
        out["permission"] = permission
    return out


def canonical_redirect(ref: str) -> str | None:
    base = re.sub(r":\d+$", "", ref).strip()
    if not base or base == ")":
        return None
    if base in WAR_MAP:
        return WAR_MAP[base]
    if base in WAR_FILES:
        return base
    if base + ".js" in WAR_FILES:
        return base + ".js"
    if base.removesuffix(".js") + ".js" in WAR_FILES:
        return base.removesuffix(".js") + ".js"
    return base + ".js" if "." not in base else base


def strip_js(name: str) -> str:
    return name[:-3] if name.endswith(".js") else name


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-dir", required=True, type=Path)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--refs", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--metadata-out", required=True, type=Path)
    args = ap.parse_args()

    if shutil.which("node") is None or shutil.which("npx") is None:
        print("[ubo] FATAL: Node.js and npx are required", file=sys.stderr)
        return 2

    src = args.source_dir
    work = args.work
    res_dir = src / "resources"
    war_dir = src / "war"
    for d in (src, res_dir, war_dir, work):
        d.mkdir(parents=True, exist_ok=True)

    # 1. Vendor complete GPLv3 source at the pinned SHA.
    raw_base = f"https://raw.githubusercontent.com/gorhill/uBlock/{UBO_SHA}"
    for name in RESOURCE_FILES:
        (res_dir / name).write_bytes(fetch(f"{raw_base}/src/js/resources/{name}"))
    for name in PARENT_FILES:
        (src / name).write_bytes(fetch(f"{raw_base}/src/js/{name}"))
    for name in WAR_FILES:
        (war_dir / name).write_bytes(fetch(f"{raw_base}/src/web_accessible_resources/{name}"))

    # 2. Bundle the real uBO registry with a pinned esbuild.
    entry = work / "entry.js"
    rel = "../../app/src/main/assets/legal/ubo/resources/scriptlets.js"
    # Compute an absolute-ish relative path from work to source; esbuild resolves
    # imports relative to the entry file.
    try:
        import os
        rel = os.path.relpath(res_dir / "scriptlets.js", work)
    except ValueError:
        pass
    entry.write_text(
        f"import {{ builtinScriptlets }} from './{rel}';\n"
        "globalThis.ShieldTubeUboRegistry = builtinScriptlets;\n",
        encoding="utf-8",
    )
    raw_bundle = work / "ubo-registry.raw.js"
    subprocess.run(
        ["npx", "--yes", f"esbuild@{ESBUILD_VERSION}", str(entry),
         "--bundle", "--format=iife", "--platform=browser", "--target=es2018",
         "--minify", "--legal-comments=none", f"--outfile={raw_bundle}"],
        check=True,
    )
    bundle = (LICENSE_HEADER + "\n"
              "globalThis.scriptletGlobals = globalThis.scriptletGlobals || {};\n"
              + raw_bundle.read_text(encoding="utf-8")).encode("utf-8")
    (src / "ubo-registry.js").write_bytes(bundle)
    (src / "README.md").write_text(README, encoding="utf-8")

    # 3. Read registry metadata without executing scriptlets in a browser.
    node_reader = work / "read-registry.cjs"
    node_reader.write_text("""\
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.document = { documentElement: {}, createElement: () => ({ style: {} }) };
globalThis.navigator = { userAgent: 'node' };
globalThis.location = { href: 'https://www.youtube.com/' };
require(process.argv[2]);
const r = globalThis.ShieldTubeUboRegistry || [];
process.stdout.write(JSON.stringify(r.map(x => ({
  name: x && x.name || '',
  aliases: Array.isArray(x && x.aliases) ? x.aliases : [],
  requiresTrust: !!(x && x.requiresTrust),
  hasFn: typeof (x && x.fn) === 'function',
}))));
""", encoding="utf-8")
    meta_text = subprocess.check_output(
        ["node", str(node_reader), str(src / "ubo-registry.js")], text=True
    )
    meta = json.loads(meta_text)

    by_key: dict[str, dict] = {}
    for m in meta:
        keys = [m["name"], *m["aliases"]]
        for key in keys:
            by_key[key] = m
            by_key[strip_js(key)] = m
            by_key[key.removesuffix(".fn")] = m

    refs = json.loads(args.refs.read_text(encoding="utf-8"))
    scriptlet_refs = sorted({r for r in refs.get("scriptlets", []) if r and r != ")"})
    redirect_refs = sorted({r for r in refs.get("redirects", []) if r and r != ")"})

    generated: list[dict] = []
    registry_name = "shieldtube-ubo-registry.js"
    generated.append(resource(
        registry_name, [], {"mime": "application/javascript"}, bundle
    ))

    # 4. Function-style wrappers for every scriptlet name resolvable in uBO.
    scriptlet_count = 0
    wrapper_by_name: dict[str, dict] = {}
    for idx, ref in enumerate(scriptlet_refs):
        m = by_key.get(ref) or by_key.get(ref + ".js") or by_key.get(strip_js(ref))
        if m is None or not m["hasFn"]:
            continue
        canonical = m["name"] if m["name"].endswith(".js") else m["name"] + ".js"
        fn_name = f"shieldtube_ubo_{idx}"
        body = (
            f"function {fn_name}() {{\n"
            "  var r = globalThis.ShieldTubeUboRegistry || [];\n"
            "  var e = null;\n"
            "  for (var i = 0; i < r.length; i++) {\n"
            "    var x = r[i];\n"
            f"    if (x && (x.name === {json.dumps(m['name'])} || "
            "(x.aliases || []).indexOf(" + json.dumps(m["name"]) + ") !== -1)) { e = x; break; }\n"
            "  }\n"
            "  if (!e || typeof e.fn !== 'function') { return; }\n"
            "  return e.fn.apply(null, arguments);\n"
            "}\n"
        )
        aliases = {ref, strip_js(ref), canonical, strip_js(canonical)}
        aliases.update(m["aliases"])
        for a in list(m["aliases"]):
            aliases.add(strip_js(a))
        rec = resource(
            canonical, sorted(aliases), {"mime": "application/javascript"},
            body.encode("utf-8"), [registry_name],
            255 if m["requiresTrust"] else None,
        )
        if canonical in wrapper_by_name:
            prev = wrapper_by_name[canonical]
            prev["aliases"] = sorted(set(prev["aliases"] + rec["aliases"]))
            prev["permission"] = max(prev.get("permission", 0), rec.get("permission", 0))
        else:
            wrapper_by_name[canonical] = rec
            generated.append(rec)
            scriptlet_count += 1

    # 5. Redirect / legacy stand-in resources from upstream WAR files.
    redirect_count = 0
    redirect_by_name: dict[str, dict] = {}
    for ref in redirect_refs:
        canonical = canonical_redirect(ref)
        if canonical is None:
            continue
        path = war_dir / canonical
        if path.is_file():
            data = path.read_bytes()
        else:
            data = b"(function(){})();\n"
        ext = canonical.rsplit(".", 1)[-1].lower() if "." in canonical else ""
        mime = MIME_BY_EXT.get(ext, "application/javascript")
        aliases = {ref, re.sub(r":\d+$", "", ref), canonical, strip_js(canonical)}
        rec = resource(canonical, sorted(aliases), {"mime": mime}, data)
        if canonical in redirect_by_name:
            redirect_by_name[canonical]["aliases"] = sorted(
                set(redirect_by_name[canonical]["aliases"] + rec["aliases"])
            )
        else:
            redirect_by_name[canonical] = rec
            generated.append(rec)
            redirect_count += 1

    # Also expose legacy +js() aliases that are WAR stand-ins, not registry fns.
    for ref in scriptlet_refs:
        if ref in by_key or (ref + ".js") in by_key or strip_js(ref) in by_key:
            continue
        canonical = canonical_redirect(ref)
        if canonical is None:
            continue
        aliases = {ref, strip_js(ref), canonical, strip_js(canonical)}
        if canonical in redirect_by_name:
            rec = redirect_by_name[canonical]
            rec["aliases"] = sorted(set(rec["aliases"] + list(aliases)))
            continue
        path = war_dir / canonical
        data = path.read_bytes() if path.is_file() else b"(function(){})();\n"
        ext = canonical.rsplit(".", 1)[-1].lower() if "." in canonical else ""
        mime = MIME_BY_EXT.get(ext, "application/javascript")
        rec = resource(canonical, sorted(aliases), {"mime": mime}, data)
        redirect_by_name[canonical] = rec
        generated.append(rec)
        redirect_count += 1

    args.out.write_text(
        json.dumps(generated, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    # 6. Checksum every corresponding-source file. Abort on pin drift.
    files: list[Path] = []
    for d in (res_dir, war_dir):
        files.extend(sorted(p for p in d.iterdir() if p.is_file()))
    files.extend(sorted(src / n for n in PARENT_FILES))
    files.extend([src / "README.md", src / "ubo-registry.js"])
    sums = []
    for p in files:
        rel = p.relative_to(src).as_posix()
        sums.append(f"{sha256(p.read_bytes())}  {rel}\n")
    manifest = src / "SHA256SUMS"
    previous = manifest.read_text(encoding="utf-8") if manifest.is_file() else None
    new_sums = "".join(sums)
    if previous is not None and previous != new_sums:
        print("[ubo] FATAL: pinned uBO source or generated bundle changed", file=sys.stderr)
        print("[ubo] previous:\n" + previous, file=sys.stderr)
        print("[ubo] current:\n" + new_sums, file=sys.stderr)
        return 3
    manifest.write_text(new_sums, encoding="utf-8")

    metadata = {
        "uboSha": UBO_SHA,
        "esbuildVersion": ESBUILD_VERSION,
        "registryEntries": len(meta),
        "trustedRegistryEntries": sum(1 for m in meta if m["requiresTrust"]),
        "generatedScriptletResources": scriptlet_count,
        "generatedRedirectResources": redirect_count,
        "sourceFiles": len(files),
        "sourceBytes": sum(p.stat().st_size for p in files),
        "bundleBytes": len(bundle),
        "checksumManifest": sha256(new_sums.encode("utf-8")),
    }
    args.metadata_out.write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"[ubo] registry entries={len(meta)} wrappers={scriptlet_count} "
          f"redirects={redirect_count} bundle={len(bundle)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
