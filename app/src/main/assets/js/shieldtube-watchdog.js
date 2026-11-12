// SPDX-License-Identifier: GPL-3.0-or-later
// 500 ms playback/ad-state watchdog + SPA URL observer. Injected as part of the
// single document-start script; safe to re-evaluate (idempotent).
(function () {
    'use strict';
    if (window.__shieldtubeWatchdogStarted) { return; }
    window.__shieldtubeWatchdogStarted = true;

    function post(type, detail) {
        try {
            if (window.ShieldTubeNative && typeof window.ShieldTubeNative.post === 'function') {
                window.ShieldTubeNative.post(JSON.stringify({ t: type, d: String(detail || '') }));
            }
        } catch (e) { }
    }

    function clean(value, depth, seen) {
        if (!value || typeof value !== 'object' || depth > 8) { return; }
        if (seen.indexOf(value) !== -1) { return; }
        seen.push(value);
        var keys = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'];
        for (var i = 0; i < keys.length; i++) {
            if (Object.prototype.hasOwnProperty.call(value, keys[i])) {
                try { delete value[keys[i]]; } catch (e) { }
            }
        }
        for (var key in value) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                clean(value[key], depth + 1, seen);
            }
        }
    }

    function adStatePresent() {
        var node = null;
        try {
            node = document.querySelector('.ad-showing, .ytp-ad-player-overlay, .ytp-ad-module');
        } catch (e) { }
        var response = window.ytInitialPlayerResponse || window.playerResponse || {};
        var fields = !!(response.adPlacements || response.playerAds || response.adSlots);
        return !!node || fields;
    }

    var lastUrl = '';
    function notifyUrl() {
        var url = location.href;
        if (url && url !== lastUrl) {
            lastUrl = url;
            post('url', url);
        }
    }

    function wrapHistory(method) {
        var original = history[method];
        if (typeof original !== 'function') { return; }
        history[method] = function () {
            var result = original.apply(this, arguments);
            notifyUrl();
            return result;
        };
    }

    var lastTime = -1;
    var lastProgressAt = 0;
    var lastAdSkipAt = 0;
    var stallReportedAt = 0;

    function tick() {
        try {
            clean(window.ytInitialPlayerResponse, 0, []);
            clean(window.playerResponse, 0, []);
            var video = document.querySelector('video');
            var now = Date.now();
            if (video) {
                if (video.currentTime !== lastTime) {
                    lastTime = video.currentTime;
                    lastProgressAt = now;
                } else if (!video.paused && now - lastProgressAt > 10000 && now - stallReportedAt > 10000) {
                    stallReportedAt = now;
                    post('watchdog', 'stalled');
                }
            }
            if (adStatePresent()) {
                clean(window.ytInitialPlayerResponse, 0, []);
                clean(window.playerResponse, 0, []);
                if (video && isFinite(video.duration) && video.duration > 0 &&
                    video.currentTime < video.duration - 0.25 && now - lastAdSkipAt > 2000) {
                    try {
                        video.currentTime = video.duration - 0.05;
                        lastAdSkipAt = now;
                        post('watchdog', 'skipped-ad-segment');
                    } catch (e) { }
                }
            }
        } catch (e) { }
        setTimeout(tick, 500);
    }

    function start() {
        wrapHistory('pushState');
        wrapHistory('replaceState');
        window.addEventListener('popstate', notifyUrl);
        window.addEventListener('hashchange', notifyUrl);
        notifyUrl();
        setTimeout(tick, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
