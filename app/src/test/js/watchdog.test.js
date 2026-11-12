// SPDX-License-Identifier: GPL-3.0-or-later
//
// Watchdog behaviour matrix. The watchdog is the last line of defence on a TV
// box where the DOM cleanup may not fire, so each case states an expected
// action or an explicit expected NO-ACTION. "No action" cases are tests too:
// the bug this file guards against (docs/SPEC-DEVIATIONS.md §10) was the
// watchdog seeking CONTENT to its end when the response merely had an empty
// adPlacements array.
'use strict';

const { createEnvironment, buildDom } = require('./dom_stub');
const { suite, test, eq, ok } = require('./harness');
const { SCRIPTS } = require('./harness');

const WATCHDOG = SCRIPTS.watchdog;

// Builds an environment with a <video> and runs the watchdog once.
function env(opts = {}) {
    const e = createEnvironment(opts.env || {});
    const doc = e.document;
    const video = doc.createElement('video');
    video.duration = opts.duration === undefined ? 30 : opts.duration;
    video.currentTime = opts.currentTime === undefined ? 0 : opts.currentTime;
    video.paused = opts.paused === undefined ? false : opts.paused;
    if (opts.overlay) {
        const ad = doc.createElement('div');
        ad.className = opts.overlay;
        doc.body.appendChild(ad);
    }
    if (opts.content) {
        buildDom(doc, opts.content);
    }
    doc.body.appendChild(video);
    if (opts.response !== undefined) {
        e.window.ytInitialPlayerResponse = opts.response;
    }
    e.video = video;
    e.run('shieldtube-watchdog.js', WATCHDOG);
    return e;
}

/** Tick the watchdog `n` times, 500 ms apart, and return posted messages. */
function tick(e, n = 1) {
    e.clock.advance(500 * n);
    return e.posted.slice();
}

function kinds(e) {
    return e.posted.map((m) => m.t);
}

function details(e, kind) {
    return e.posted.filter((m) => m.t === kind).map((m) => m.d);
}

// ---------------------------------------------------------------------------
suite('watchdog / ad overlay matrix');
// ---------------------------------------------------------------------------

test('skippable mid-roll (overlay + 15 s clip) is skipped to the end', () => {
    const e = env({ overlay: 'ytp-ad-player-overlay', duration: 15, currentTime: 3 });
    tick(e);
    ok(e.video.currentTime > 14, `expected seek near 15, got ${e.video.currentTime}`);
    eq(details(e, 'watchdog'), ['skipped-ad-segment'], 'watchdog messages');
});

test('unskippable 2-minute ad is still skipped (within AD_MAX_SECONDS)', () => {
    const e = env({ overlay: 'ad-showing', duration: 120, currentTime: 5 });
    tick(e);
    ok(e.video.currentTime > 119, `expected seek near 120, got ${e.video.currentTime}`);
    eq(details(e, 'watchdog'), ['skipped-ad-segment']);
});

test('banner-only overlay is NOT an ad segment and must not move the playhead', () => {
    // .ytp-ad-overlay-banner is a static banner; the player is not playing an
    // ad, so seeking here would jump the CONTENT forward. Must be a no-op.
    const e = env({ overlay: 'ytp-ad-overlay-banner', duration: 15, currentTime: 3 });
    tick(e);
    eq(e.video.currentTime, 3, 'playhead must not move for a banner');
    eq(details(e, 'watchdog'), [], 'no watchdog messages');
});

test('no ad class at all: content keeps playing untouched', () => {
    const e = env({ duration: 600, currentTime: 100 });
    tick(e, 5);
    eq(e.video.currentTime, 100);
    eq(details(e, 'watchdog'), []);
});

test('>20-minute content regression: long video is never forwarded even if an ad class lingers',
    () => {
        // 1,225 s = 20 min 25 s. This is the exact shape of the original bug
        // (content 12.0 s of a 3725 s video jumped to the end).
        const e = env({ overlay: 'ad-showing', duration: 1225, currentTime: 12 });
        tick(e, 4);
        eq(e.video.currentTime, 12, 'a 20-minute video must never be fast-forwarded by the watchdog');
        eq(details(e, 'watchdog'), []);
    });

test('exactly AD_MAX_SECONDS (180 s) is the boundary: skipped', () => {
    const e = env({ overlay: 'ad-showing', duration: 180, currentTime: 1 });
    tick(e);
    ok(e.video.currentTime > 179, `180 s ad must be skipped, got ${e.video.currentTime}`);
    eq(details(e, 'watchdog'), ['skipped-ad-segment']);
});

test('AD_MAX_SECONDS + 0.5 s is content: not skipped', () => {
    const e = env({ overlay: 'ad-showing', duration: 180.5, currentTime: 1 });
    tick(e);
    eq(e.video.currentTime, 1, '180.5 s must be treated as content');
    eq(details(e, 'watchdog'), []);
});

test('duration NaN (metadata not loaded) must not be treated as a short ad', () => {
    const e = env({ overlay: 'ad-showing', duration: NaN, currentTime: 0 });
    tick(e);
    eq(details(e, 'watchdog'), []);
});

test('duration Infinity (live / premiere) is never skipped', () => {
    const e = env({ overlay: 'ad-showing', duration: Infinity, currentTime: 0 });
    tick(e, 6);
    eq(details(e, 'watchdog'), []);
});

test('live stream with an ad overlay: no seek, but the response is still scrubbed', () => {
    const response = { adPlacements: [{ id: 'ad1' }], streamingData: {} };
    const e = env({ overlay: 'ad-showing', duration: Infinity, response });
    tick(e);
    eq(details(e, 'watchdog'), [], 'must not seek on a live stream');
    eq(Object.prototype.hasOwnProperty.call(response, 'adPlacements'), false,
        'ad metadata must still be deleted');
});

test('premiere (adSlots) with a short clip: skipped', () => {
    const response = { adSlots: [{ slot: 1 }] };
    const e = env({ overlay: 'ad-showing', duration: 20, currentTime: 2, response });
    tick(e);
    ok(e.video.currentTime > 19);
    eq(Object.prototype.hasOwnProperty.call(response, 'adSlots'), false, 'adSlots removed');
});

test('re-seek is rate limited to once per 2 s while the ad lingers', () => {
    const e = env({ overlay: 'ad-showing', duration: 15, currentTime: 0 });
    // First tick: seek. Force the player to move the playhead back (ad still on).
    tick(e);
    eq(details(e, 'watchdog').length, 1, 'one skip');
    e.video.currentTime = 0.5;
    tick(e, 1); // +0.5 s
    eq(details(e, 'watchdog').length, 1, 'second tick within 2 s must not seek again');
    tick(e, 1); // +1.0 s
    tick(e, 1); // +1.5 s
    eq(details(e, 'watchdog').length, 1, 'still rate limited at 1.5 s');
    // The guard is strict (`now - lastAdSkipAt > 2000`) and ticks land exactly
    // on 500 ms boundaries, so at +2,000 ms the difference is exactly 2,000 and
    // the seek is still refused. Measured: the second skip happens at +2,500 ms.
    tick(e, 1); // +2.0 s -> delta exactly 2000, not > 2000
    eq(details(e, 'watchdog').length, 1, 'strictly-greater guard: +2.0 s is still blocked');
    tick(e, 1); // +2.5 s
    eq(details(e, 'watchdog').length, 2, 'the next 500 ms tick allows the second skip');
});

test('late ad module (appears after the first tick) is caught on the next tick', () => {
    const e = env({ duration: 12, currentTime: 2 });
    tick(e);
    eq(details(e, 'watchdog'), [], 'nothing to do before the ad module exists');
    const ad = e.document.createElement('div');
    ad.className = 'ytp-ad-module';
    e.document.body.appendChild(ad);
    tick(e);
    eq(details(e, 'watchdog'), ['skipped-ad-segment'], 'late module must be handled');
});

// ---------------------------------------------------------------------------
suite('watchdog / adPlacements response variants');
// ---------------------------------------------------------------------------

test('adPlacements null: not an ad, nothing scrubbed, no seek', () => {
    const response = { adPlacements: null };
    const e = env({ duration: 15, response });
    tick(e);
    eq(e.posted.filter((m) => m.t !== 'url').length, 0, 'no scrub messages');
    eq(e.video.currentTime, 0);
});

test('adPlacements missing entirely: unchanged response, no seek', () => {
    const response = { streamingData: { x: 1 } };
    const before = JSON.stringify(response);
    const e = env({ duration: 15, response });
    tick(e);
    eq(JSON.stringify(response), before, 'response must be untouched');
});

test('adPlacements [] is NOT an ad and must not move the playhead (regression §10)', () => {
    const response = { adPlacements: [] };
    const e = env({ overlay: 'ad-showing', duration: 600, currentTime: 50, response });
    tick(e, 3);
    eq(e.video.currentTime, 50, 'empty array must never authorise a seek');
});

test('real adPlacements: scrubbed, and a short clip is skipped', () => {
    const response = { adPlacements: [{ adBreakParams: { a: 1 } }], playerAds: [{ x: 1 }] };
    const e = env({ overlay: 'ad-showing', duration: 10, currentTime: 1, response });
    tick(e);
    eq(Object.prototype.hasOwnProperty.call(response, 'adPlacements'), false);
    eq(Object.prototype.hasOwnProperty.call(response, 'playerAds'), false);
    ok(e.video.currentTime > 9);
});

test('nested ad keys (one level down) are scrubbed too', () => {
    const response = { playerResponse: { adPlacements: [{ a: 1 }] }, streamingData: { deep: { adSlots: [1] } } };
    const e = env({ duration: 600, response });
    tick(e);
    eq(Object.prototype.hasOwnProperty.call(response.playerResponse, 'adPlacements'), false);
    eq(Object.prototype.hasOwnProperty.call(response.streamingData.deep, 'adSlots'), false);
});

test('scrubbing is bounded: a cyclic response does not hang the watchdog', () => {
    const response = { adPlacements: [1] };
    response.self = response;          // cycle
    response.deep = { self: response };
    const e = env({ duration: 600, response, overlay: 'ytp-ad-player-overlay' });
    tick(e, 3);                        // must return, no stack overflow
    eq(Object.prototype.hasOwnProperty.call(response, 'adPlacements'), false);
});

// ---------------------------------------------------------------------------
suite('watchdog / stall reporting and SPA navigation');
// ---------------------------------------------------------------------------

test('stall is reported after ~10 s of no progress, at most once per 10 s', () => {
    // MEASURED CONTRACT, not an assumption: while the video is still stalled the
    // script re-posts 'stalled' roughly every 10 s (the report interval doubles
    // as the guard against a dropped bridge message). It never posts once per
    // 500 ms tick, and it never posts before 10 s.
    const e = env({ duration: 600, currentTime: 7, paused: false });
    tick(e);                            // baseline, ticks at +0.5 s
    tick(e, 19);                        // up to +10.0 s
    eq(details(e, 'watchdog'), [], 'must not report before 10 s');
    tick(e, 3);                         // past 10 s
    eq(details(e, 'watchdog'), ['stalled'], 'one stall report');
    tick(e, 19);                        // +9.5 s more
    eq(details(e, 'watchdog'), ['stalled'], 'must not repeat within 10 s');
    tick(e, 2);                         // crosses the next 10 s mark
    eq(details(e, 'watchdog'), ['stalled', 'stalled'],
        'a still-stalled video is re-reported once per ~10 s, never per tick');
    // 40 ticks = 20 s: at most two more reports, i.e. sparse, not spam.
    const before = details(e, 'watchdog').length;
    tick(e, 40);
    const after = details(e, 'watchdog').length;
    ok(after - before <= 2, `expected <= 2 reports in 20 s, got ${after - before}`);
});

test('progress resets the stall timer so a later stall reports again', () => {
    const e = env({ duration: 600, currentTime: 7, paused: false });
    tick(e, 24);                        // stall reported
    eq(details(e, 'watchdog').length, 1);
    e.video.currentTime = 8;            // progress
    tick(e, 1);
    e.video.currentTime = 8;            // stall again from a fresh baseline
    tick(e, 24);
    eq(details(e, 'watchdog').length, 2, 'a new stall episode reports again');
});

test('paused video is not reported as stalled', () => {
    const e = env({ duration: 600, currentTime: 7, paused: true });
    tick(e, 40);
    eq(details(e, 'watchdog'), []);
});

test('pushState SPA navigation is reported once per distinct URL', () => {
    const e = env({ duration: 600 });
    tick(e);
    eq(details(e, 'url'), ['https://www.youtube.com/tv#/watch?v=abc'], 'initial url');
    e.window.history.pushState({}, '', 'https://www.youtube.com/tv#/watch?v=def');
    eq(details(e, 'url').length, 2, 'pushState reported');
    e.window.history.pushState({}, '', 'https://www.youtube.com/tv#/watch?v=def');
    eq(details(e, 'url').length, 2, 'same URL must not be re-reported');
    e.window.history.replaceState({}, '', 'https://www.youtube.com/tv#/watch?v=ghi');
    eq(details(e, 'url').length, 3, 'replaceState reported');
    eq(details(e, 'url')[2], 'https://www.youtube.com/tv#/watch?v=ghi');
});

test('hashchange and popstate are reported', () => {
    const e = env({ duration: 600 });
    tick(e);
    e.setUrl('https://www.youtube.com/tv#/watch?v=xyz');
    e.window.dispatch('hashchange');
    eq(details(e, 'url').slice(-1)[0], 'https://www.youtube.com/tv#/watch?v=xyz');
    e.setUrl('https://www.youtube.com/tv#/watch?v=pop');
    e.window.dispatch('popstate');
    eq(details(e, 'url').slice(-1)[0], 'https://www.youtube.com/tv#/watch?v=pop');
});

test('idempotent: evaluating the script twice does not double-report', () => {
    const e = env({ duration: 600 });
    tick(e);
    const before = e.posted.length;
    e.run('shieldtube-watchdog.js', WATCHDOG);   // second evaluation
    tick(e, 3);
    eq(e.posted.length, before, 'second evaluation must be a no-op');
});

test('a throwing bridge does not stop the loop', () => {
    const e = env({ duration: 15, overlay: 'ytp-ad-player-overlay', currentTime: 1 });
    e.window.ShieldTubeNative.post = () => { throw new Error('bridge dead'); };
    tick(e, 4);                                  // must not throw out of tick
    ok(e.video.currentTime > 14, 'playback logic must continue after a bridge failure');
});

test('no <video> element: no crash, URL reporting still works', () => {
    const e = createEnvironment({});
    e.run('shieldtube-watchdog.js', WATCHDOG);
    e.clock.advance(2000);
    eq(e.posted.map((m) => m.t), ['url']);
});

test('document still loading: start is deferred to DOMContentLoaded', () => {
    const e2 = createEnvironment({ readyState: 'loading' });
    const video = e2.document.createElement('video');
    video.duration = 15;
    video.currentTime = 1;
    const ad = e2.document.createElement('div');
    ad.className = 'ad-showing';
    e2.document.body.appendChild(ad);
    e2.document.body.appendChild(video);
    e2.run('shieldtube-watchdog.js', WATCHDOG);
    e2.clock.advance(1000);
    eq(e2.posted.length, 0, 'nothing may run before DOMContentLoaded');
    e2.document.readyState = 'interactive';
    e2.document.dispatch('DOMContentLoaded');
    e2.clock.advance(500);
    ok(video.currentTime > 14, 'after DOMContentLoaded the tick runs');
    ok(e2.posted.some((m) => m.t === 'watchdog'), 'skip reported');
});
