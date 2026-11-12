<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# uBlock Origin scriptlet source

This directory contains the **complete corresponding source** for the uBO
scriptlets and web-accessible redirect resources compiled into
`assets/lists/resources.json`.

* Upstream: `https://github.com/gorhill/uBlock`
* Pinned commit: `2bc679d99afe5bddd8fe3ab60137966a12123f41`
* `resources/` — `src/js/resources/*.js` plus the three parent modules they import.
* `war/` — `src/web_accessible_resources/*` redirect stand-ins.
* `ubo-registry.js` — deterministic minified bundle produced by esbuild 0.25.10.
* `SHA256SUMS` — checksums for every source file and the generated bundle.

All upstream files are GPL-3.0-or-later. Our build script is
`scripts/build_ubo_resources.py`; the app itself is GPL-3.0-or-later. See
`docs/LICENSING.md` and `docs/SPEC-DEVIATIONS.md` §7b.
