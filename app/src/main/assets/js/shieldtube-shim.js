/* SPDX-License-Identifier: GPL-3.0-or-later
 * ShieldTube document-start shim. Bundled as an asset (unit-testable), never
 * a Kotlin string literal. Runs in the page world before any YouTube script,
 * via WebViewCompat.addDocumentStartJavaScript.
 *
 * Deferred by the 2026-11-11 priority change: cosmetic MutationObserver and
 * the 500ms ad-state watchdog. This file is the load-bearing Layer 2 only.
 */
(function () {
    'use strict';
    if (window.__shieldtubeInstalled) { return; }
    window.__shieldtubeInstalled = true;

    var PLAYER = '/youtubei/v1/player';
    var AD_KEYS = ['adPlacements', 'playerAds', 'adSlots'];

    function report(type, detail) {
        try {
            if (window.ShieldTubeNative &&
                typeof window.ShieldTubeNative.post === 'function') {
                window.ShieldTubeNative.post(JSON.stringify({
                    t: type,
                    d: String(detail || ''),
                    ua: navigator.userAgent
                }));
            }
        } catch (e) { /* a broken bridge must never wedge playback */ }
    }

    function clean(obj) {
        if (!obj || typeof obj !== 'object') { return false; }
        var changed = false;
        for (var i = 0; i < AD_KEYS.length; i++) {
            if (Object.prototype.hasOwnProperty.call(obj, AD_KEYS[i])) {
                try { delete obj[AD_KEYS[i]]; changed = true; } catch (e) {}
            }
        }
        // Some responses wrap the player payload one level down.
        if (obj.playerResponse && typeof obj.playerResponse === 'object') {
            if (clean(obj.playerResponse)) { changed = true; }
        }
        return changed;
    }

    function scrubJson(text) {
        if (typeof text !== 'string' || text.length === 0) { return text; }
        try {
            var obj = JSON.parse(text);
            return clean(obj) ? JSON.stringify(obj) : text;
        } catch (e) { return text; }
    }

    // ---- window.fetch: POST bodies are unreadable from shouldInterceptRequest,
    // so the player response must be cleaned here, in the page world. ----------
    var nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
        window.fetch = function (input, init) {
            var url = '';
            try {
                url = (typeof input === 'string') ? input :
                    (input && input.url ? input.url : '');
            } catch (e) { url = ''; }
            var pending;
            try { pending = nativeFetch.apply(this, arguments); }
            catch (e) { throw e; }
            if (url.indexOf(PLAYER) === -1) { return pending; }
            return pending.then(function (response) {
                if (!response || typeof response.text !== 'function') { return response; }
                return response.text().then(function (body) {
                    var cleaned = scrubJson(body);
                    report('playerResponse', cleaned !== body ? 'scrubbed' : 'clean');
                    try {
                        return new Response(cleaned, {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers
                        });
                    } catch (e) { return response; }
                });
            });
        };
    }

    // ---- XMLHttpRequest: same endpoint, legacy code paths -------------------
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && XHR.prototype.open) {
        var nativeOpen = XHR.prototype.open;
        var nativeSend = XHR.prototype.send;

        XHR.prototype.open = function (method, url) {
            try { this.__stIsPlayer = String(url).indexOf(PLAYER) !== -1; }
            catch (e) { this.__stIsPlayer = false; }
            return nativeOpen.apply(this, arguments);
        };

        XHR.prototype.send = function () {
            var self = this;
            if (!this.__stIsPlayer) { return nativeSend.apply(this, arguments); }
            try {
                this.addEventListener('readystatechange', function () {
                    if (self.readyState !== 4) { return; }
                    try {
                        var desc = Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');
                        var raw = (desc && desc.get) ? desc.get.call(self) : '';
                        var cleaned = scrubJson(raw);
                        if (cleaned !== raw) {
                            Object.defineProperty(self, 'responseText', {
                                configurable: true,
                                get: function () { return cleaned; }
                            });
                            Object.defineProperty(self, 'response', {
                                configurable: true,
                                get: function () {
                                    try { return JSON.parse(cleaned); } catch (e) { return null; }
                                }
                            });
                            report('playerResponseXhr', 'scrubbed');
                        }
                    } catch (e) {}
                });
            } catch (e) {}
            return nativeSend.apply(this, arguments);
        };
    }

    // ---- ytInitialPlayerResponse: server-rendered initial state -------------
    try {
        var initial = window.ytInitialPlayerResponse;
        Object.defineProperty(window, 'ytInitialPlayerResponse', {
            configurable: true,
            get: function () { return initial; },
            set: function (value) { clean(value); initial = value; }
        });
        if (initial) { window.ytInitialPlayerResponse = initial; }
    } catch (e) { /* property may be non-configurable; JS patch still covers it */ }

    // ---- Widevine probe: L3-only boxes cap at 720p; fail loudly -------------
    function probeWidevine() {
        try {
            var video = document.createElement ? document.createElement('video') : null;
            var h264 = (video && typeof video.canPlayType === 'function')
                ? video.canPlayType('video/mp4; codecs="avc1.42E01E"') : '';
            if (navigator.requestMediaKeySystemAccess) {
                navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
                    initDataTypes: ['cenc'],
                    videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }]
                }]).then(
                    function () { report('widevine', 'available|h264=' + h264); },
                    function (err) {
                        report('widevine', 'unavailable|h264=' + h264 +
                            '|' + ((err && err.name) || 'unknown'));
                    }
                );
            } else {
                report('widevine', 'no-EME|h264=' + h264);
            }
        } catch (e) { report('widevine', 'probe-error'); }
    }

    report('ready', navigator.userAgent);
    probeWidevine();
})();
