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
                    if (cleaned === body) { return response; }
                    // Building a bare `new Response(...)` throws away `url`,
                    // `redirected` and `type`. The player reads response.url to
                    // derive the video id, so the wrapper below copies every
                    // observable field of the original response back on.
                    var rebuilt;
                    try {
                        rebuilt = new Response(cleaned, {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers
                        });
                        try {
                            Object.defineProperty(rebuilt, 'url',
                                { value: response.url });
                            Object.defineProperty(rebuilt, 'redirected',
                                { value: response.redirected });
                            Object.defineProperty(rebuilt, 'type',
                                { value: response.type });
                        } catch (e) { }
                    } catch (e) {
                        // Response() is not constructible in every engine.
                        rebuilt = {
                            ok: response.ok, status: response.status,
                            statusText: response.statusText,
                            headers: response.headers,
                            url: response.url, redirected: response.redirected,
                            type: response.type,
                            text: function () { return Promise.resolve(cleaned); },
                            json: function () { return Promise.resolve(JSON.parse(cleaned)); },
                            clone: function () { return rebuilt; }
                        };
                    }
                    return rebuilt;
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
    // The getter/setter pair alone is not enough: the page declares
    // `var ytInitialPlayerResponse = ...`, and a later global declaration can
    // shadow an accessor defined earlier. So the value is also re-scrubbed and
    // re-installed as an OWN data property once the document has parsed.
    try {
        var initial = window.ytInitialPlayerResponse;
        Object.defineProperty(window, 'ytInitialPlayerResponse', {
            configurable: true,
            get: function () { return initial; },
            set: function (value) { clean(value); initial = value; }
        });
        if (initial) { clean(initial); }

        var reseal = function () {
            var v = window.ytInitialPlayerResponse;
            if (!v || typeof v !== 'object') { return; }
            clean(v);
            try {
                Object.defineProperty(window, 'ytInitialPlayerResponse', {
                    value: v, writable: true, configurable: true, enumerable: true
                });
            } catch (e) { }
        };
        window.addEventListener('DOMContentLoaded', reseal);
        window.addEventListener('load', reseal);
    } catch (e) { /* property may be non-configurable; JS patch still covers it */ }

    // ---- Widevine probe: L3-only boxes cap at 720p; fail loudly -------------
    function probeWidevine() {
        try {
            // DOCUMENT_START_SCRIPT runs before the document element exists, so
            // `document` can be null here. The unguarded call threw, was caught
            // by the outer catch, and every page reported a fabricated
            // "probe-error" instead of the real Widevine verdict.
            var doc = window.document;
            var video = (doc && doc.createElement) ? doc.createElement('video') : null;
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
