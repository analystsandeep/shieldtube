// SPDX-License-Identifier: GPL-3.0-or-later
//
// document-start shim: player-response scrubbing over fetch/XHR and the
// ytInitialPlayerResponse accessor, plus the Widevine probe verdict.
//
// The shim is async by nature (fetch returns a promise), so these tests use a
// scripted fetch whose response body the test supplies, and flush microtasks.
'use strict';

const { createEnvironment } = require('./dom_stub');
const { suite, test, eq, ok, contains, SCRIPTS } = require('./harness');

const SHIM = SCRIPTS.shim;

// The shim's fetch path is promise-based; the runner awaits each test, so an
// async test body is all that is needed. No timers, no polling, no timeouts.

const PLAYER = 'https://www.youtube.com/youtubei/v1/player?key=abc';

function env(opts = {}) {
    const e = createEnvironment(
        Object.assign({ eme: 'absent', readyState: 'interactive' }, opts.env || {})
    );
    if (opts.initial !== undefined) { e.window.ytInitialPlayerResponse = opts.initial; }
    e.run('shieldtube-shim.js', SHIM);
    return e;
}

function lastFetch(e) {
    const calls = e.fetchCalls || [];
    return calls[calls.length - 1];
}

// ---------------------------------------------------------------------------
suite('shim / fetch player-response scrubbing');
// ---------------------------------------------------------------------------

test('a player response with ads is scrubbed and reports "scrubbed"', async () => {
    const e = env({});
    const pending = e.window.fetch(PLAYER, { method: 'POST', body: '{}' });
    const body = JSON.stringify({ adPlacements: [{ a: 1 }], streamingData: { ok: true } });
    const call = lastFetch(e);
    call._resolve(call.respond(body));
    const res = await pending;
    const text = await res.text();
    eq(JSON.parse(text).adPlacements, undefined, 'adPlacements must be removed');
    eq(JSON.parse(text).streamingData.ok, true, 'payload must survive');
    const rep = e.posted.find((m) => m.t === 'playerResponse');
    eq(rep.d, 'scrubbed');
});

test('a clean player response is passed through untouched and reports "clean"', async () => {
    const e = env({});
    const pending = e.window.fetch(PLAYER, { method: 'POST' });
    const body = JSON.stringify({ streamingData: { ok: true } });
    const call = lastFetch(e);
    call._resolve(call.respond(body));
    const res = await pending;
    eq(await res.text(), body, 'body must be byte-identical');
    eq(e.posted.find((m) => m.t === 'playerResponse').d, 'clean');
});

test('scrubbed Response keeps url, redirected and type', async () => {
    const e = env({});
    const url = PLAYER + '&alt=json';
    const pending = e.window.fetch(url, { method: 'POST' });
    const call = lastFetch(e);
    call._resolve(
        call.respond(JSON.stringify({ adPlacements: [1] }), {
            url,
            redirected: true,
            type: 'cors'
        })
    );
    const res = await pending;
    eq(res.url, url, 'response.url must be preserved: the player derives the video id from it');
    eq(res.redirected, true);
    eq(res.type, 'cors');
    eq(res.status, 200);
});

test('clean response is still readable by the page (clone-on-read regression)', async () => {
    // REAL BUG, measured before the fix: the shim called response.text() on the
    // original response and then returned that same object to the page. A
    // Response body is single-use, so the player's own response.json() threw
    // "Body is unusable: Body has already been read" for every clean /player
    // response. The shim now reads through response.clone().
    const e = env({});
    const pending = e.window.fetch(PLAYER, { method: 'POST' });
    const body = JSON.stringify({ streamingData: { ok: true } });
    const call = lastFetch(e);
    call._resolve(call.respond(body));
    const res = await pending;
    const text = await res.text();            // must not throw
    eq(JSON.parse(text).streamingData.ok, true);
});

test('non-player requests are not touched at all', async () => {
    const e = env({});
    const url = 'https://i.ytimg.com/vi/abc/hq.jpg';
    const pending = e.window.fetch(url);
    const call = lastFetch(e);
    const original = call.respond('not json');
    call._resolve(original);
    const res = await pending;
    ok(res === original, 'the original Response object must be returned as-is');
    eq(e.posted.filter((m) => m.t === 'playerResponse').length, 0);
});

test('a fetch rejection is propagated, not swallowed', async () => {
    const e = env({});
    const pending = e.window.fetch(PLAYER, { method: 'POST' });
    const boom = new Error('network down');
    lastFetch(e)._reject(boom);
    let caught = null;
    try { await pending; } catch (err) { caught = err; }
    ok(caught === boom, 'the original rejection must reach the caller');
});

test('non-JSON player body is returned unchanged (fails open)', async () => {
    const e = env({});
    const pending = e.window.fetch(PLAYER, { method: 'POST' });
    const body = '<html>not json</html>';
    const call = lastFetch(e);
    call._resolve(call.respond(body));
    const res = await pending;
    eq(await res.text(), body);
    eq(e.posted.find((m) => m.t === 'playerResponse').d, 'clean');
});

test('empty player body is handled without touching Response', async () => {
    const e = env({});
    const pending = e.window.fetch(PLAYER, { method: 'POST' });
    const call = lastFetch(e);
    call._resolve(call.respond(''));
    const res = await pending;
    eq(await res.text(), '');
});

test('Request objects (not strings) are recognised by url', async () => {
    const e = env({});
    const req = { url: PLAYER };
    const pending = e.window.fetch(req, { method: 'POST' });
    const call = lastFetch(e);
    call._resolve(call.respond(JSON.stringify({ playerAds: [1] })));
    const res = await pending;
    eq(JSON.parse(await res.text()).playerAds, undefined);
});

test('playerResponse wrapped one level down is scrubbed as well', async () => {
    const e = env({});
    const pending = e.window.fetch(PLAYER, { method: 'POST' });
    const body = JSON.stringify({ playerResponse: { adSlots: [1], streamingData: {} } });
    const call = lastFetch(e);
    call._resolve(call.respond(body));
    const res = await pending;
    eq(JSON.parse(await res.text()).playerResponse.adSlots, undefined);
});

// ---------------------------------------------------------------------------
suite('shim / ytInitialPlayerResponse accessor');
// ---------------------------------------------------------------------------

test('value assigned after install is scrubbed by the setter', () => {
    const e = env({});
    const assigned = { adPlacements: [{ a: 1 }], streamingData: {} };
    e.window.ytInitialPlayerResponse = assigned;
    eq(e.window.ytInitialPlayerResponse.adPlacements, undefined, 'setter must clean');
    eq(e.window.ytInitialPlayerResponse.streamingData !== undefined, true, 'payload survives');
});

test('value present before install is scrubbed immediately', () => {
    const initial = { adPlacements: [1], videoDetails: { videoId: 'abc' } };
    const e = env({ initial });
    eq(e.window.ytInitialPlayerResponse.adPlacements, undefined);
    eq(e.window.ytInitialPlayerResponse.videoDetails.videoId, 'abc');
});

test('re-declaration (shadowing) is re-scrubbed and re-sealed at DOMContentLoaded', () => {
    const e = env({});
    const shadow = { adPlacements: [{ x: 1 }], videoDetails: {} };
    // Simulate a later `var ytInitialPlayerResponse = {...}` in page code, which
    // replaces the accessor with an own data property.
    Object.defineProperty(e.window, 'ytInitialPlayerResponse', {
        value: shadow, writable: true, configurable: true, enumerable: true
    });
    eq(e.window.ytInitialPlayerResponse.adPlacements !== undefined, true, 'precondition: ads are back');
    e.document.dispatch('DOMContentLoaded');
    eq(e.window.ytInitialPlayerResponse.adPlacements, undefined, 'reseal at DOMContentLoaded');
    const desc = Object.getOwnPropertyDescriptor(e.window, 'ytInitialPlayerResponse');
    eq(desc.writable, true, 'resealed as a writable data property');
    eq(desc.configurable, true);
    eq(desc.enumerable, true);
});

test('reseal at load fires again (covers late page scripts)', () => {
    const e = env({});
    Object.defineProperty(e.window, 'ytInitialPlayerResponse', {
        value: { adPlacements: [1] }, writable: true, configurable: true
    });
    e.window.dispatch('load');
    eq(e.window.ytInitialPlayerResponse.adPlacements, undefined);
});

test('non-object ytInitialPlayerResponse is left alone and does not throw', () => {
    const e = env({});
    e.window.ytInitialPlayerResponse = 'a string';
    eq(e.window.ytInitialPlayerResponse, 'a string');
    e.window.ytInitialPlayerResponse = null;
    eq(e.window.ytInitialPlayerResponse, null);
    e.document.dispatch('DOMContentLoaded');
});

// ---------------------------------------------------------------------------
suite('shim / XHR path');
// ---------------------------------------------------------------------------

test('XHR to the player endpoint is scrubbed via a responseText getter', () => {
    const e = env({});
    const XHR = e.window.XMLHttpRequest;
    const xhr = new XHR();
    xhr.open('POST', PLAYER);
    xhr.send();
    xhr._finish(JSON.stringify({ adPlacements: [{ a: 1 }], streamingData: { ok: 1 } }));
    eq(JSON.parse(xhr.responseText).adPlacements, undefined, 'responseText scrubbed');
    // The shim's own `response` getter returns a parsed object, matching what
    // XHR exposes when responseType is not set by the page.
    eq(xhr.response.streamingData.ok, 1, 'response object is consistent');
    eq(e.posted.some((m) => m.t === 'playerResponseXhr'), true, 'reported');
});

test('XHR to another endpoint is untouched', () => {
    const e = env({});
    const XHR = e.window.XMLHttpRequest;
    const xhr = new XHR();
    xhr.open('GET', 'https://www.youtube.com/api/stats/watchtime');
    xhr.send();
    const body = JSON.stringify({ adPlacements: [1] });
    xhr._finish(body);
    eq(xhr.responseText, body, 'non-player XHR must not be rewritten');
});

test('XHR that never completes does not hang anything', () => {
    const e = env({});
    const XHR = e.window.XMLHttpRequest;
    const xhr = new XHR();
    xhr.open('POST', PLAYER);
    xhr.send();
    eq(xhr.responseText, '', 'still empty, no throw');
});

// ---------------------------------------------------------------------------
suite('shim / Widevine probe');
// ---------------------------------------------------------------------------

test('no EME at all: verdict is no-EME, never probe-error', () => {
    const e = env({});
    const rep = e.posted.find((m) => m.t === 'widevine');
    ok(rep, 'a widevine message must always be posted');
    ok(rep.d.indexOf('no-EME') === 0, `expected no-EME, got ${rep.d}`);
});

test('EME available: verdict is available', async () => {
    const e = env({ env: { eme: 'available' } });
    await new Promise((r) => setImmediate(r));
    const rep = e.posted.find((m) => m.t === 'widevine');
    ok(rep.d.indexOf('available') === 0, `expected available, got ${rep.d}`);
});

test('EME rejected: verdict is unavailable with the error name', async () => {
    const e = env({ env: { eme: 'rejected' } });
    await new Promise((r) => setImmediate(r));
    const rep = e.posted.find((m) => m.t === 'widevine');
    contains(rep.d, 'unavailable', 'verdict');
    contains(rep.d, 'NotSupportedError', 'error name must be included');
});

test('EME that throws synchronously is reported as probe-error, not silently lost', () => {
    const e = env({ env: { eme: 'throws' } });
    const rep = e.posted.find((m) => m.t === 'widevine');
    eq(rep.d, 'probe-error');
});

test('DOCUMENT_START with no document at all still yields a real verdict', () => {
    // This is the exact regression from 2026-11-11: document is null at
    // document-start, the old code threw TypeError and reported probe-error
    // for every page, masking the real EME answer.
    const e = env({ env: { document: false } });
    const rep = e.posted.find((m) => m.t === 'widevine');
    ok(rep, 'verdict posted');
    eq(rep.d.indexOf('probe-error'), -1, 'null document must NOT masquerade as a probe error');
    eq(rep.d.indexOf('no-EME'), 0, 'with no EME exposed, the honest verdict is no-EME');
});

test('h264 capability string is included so the box model can be identified', () => {
    const e = env({});
    contains(e.posted.find((m) => m.t === 'widevine').d, 'h264=', 'probe detail');
});

// ---------------------------------------------------------------------------
suite('shim / robustness');
// ---------------------------------------------------------------------------

test('ready is posted with the user agent', () => {
    const e = env({});
    const ready = e.posted.find((m) => m.t === 'ready');
    ok(ready);
    contains(ready.d || ready.ua || '', 'ShieldTube');
});

test('installing twice is a no-op', () => {
    const e = env({});
    const before = e.posted.length;
    e.run('shieldtube-shim.js', SHIM);
    eq(e.posted.length, before, 'second install must not post again');
});

test('a broken bridge does not break fetch', async () => {
    const e = env({});
    e.window.ShieldTubeNative.post = () => { throw new Error('bridge dead'); };
    const pending = e.window.fetch(PLAYER, { method: 'POST' });
    const call = lastFetch(e);
    call._resolve(call.respond(JSON.stringify({ adPlacements: [1] })));
    const res = await pending;
    eq(JSON.parse(await res.text()).adPlacements, undefined, 'scrubbing still happens');
});

test('window.fetch missing entirely: shim still installs and posts verdicts', () => {
    const e = env({ env: { fetch: false } });
    ok(e.posted.some((m) => m.t === 'ready'));
    ok(e.posted.some((m) => m.t === 'widevine'));
});

test('a non-configurable ytInitialPlayerResponse does not throw out of the shim', () => {
    const e = createEnvironment({ eme: 'absent' });
    Object.defineProperty(e.window, 'ytInitialPlayerResponse', {
        value: { adPlacements: [1] }, writable: false, configurable: false
    });
    e.run('shieldtube-shim.js', SHIM);   // must not throw
    ok(e.posted.some((m) => m.t === 'ready'));
});
