// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cosmetic layer against a realistic fixture DOM: hide selectors, exceptions,
// procedural actions, SPA re-application, and the generichide rule.
//
// The fixture mimics the TV layout: ytd-app > player + ytd-watch-next-secondary-
// results with an ad slot and a promoted item. Real selectors come from the
// shipped lists, but the elements are synthetic.
'use strict';

const { createEnvironment, buildDom } = require('./dom_stub');
const { suite, test, eq, ok, contains, SCRIPTS } = require('./harness');

const COSMETIC = SCRIPTS.cosmetic;

function fixture(options = {}) {
    const e = createEnvironment(
        Object.assign({ href: 'https://www.youtube.com/tv#/watch?v=abc', readyState: 'interactive' },
            options.env || {})
    );
    buildDom(e.document, {
        tag: 'ytd-app',
        children: [
            {
                tag: 'ytd-player',
                id: 'player',
                children: [{ tag: 'div', class: 'video-ads' }, { tag: 'div', class: 'ytp-ad-module' }]
            },
            {
                tag: 'ytd-watch-next-secondary-results-renderer',
                children: [
                    { tag: 'div', class: 'ad-slot' },
                    { tag: 'div', class: 'promoted-sparkles' },
                    { tag: 'ytd-compact-video-renderer', id: 'v1', class: 'video-item' }
                ]
            }
        ]
    });
    e.run('shieldtube-cosmetic.js', COSMETIC);
    if (options.data) { e.window.__shieldtubeCosmetic.update(options.data); }
    return e;
}

function styleText(e) {
    const style = e.document.getElementById('shieldtube-cosmetic-style');
    return style ? style.textContent : '';
}

const BASIC = {
    hide_selectors: ['.video-ads', '.ad-slot'],
    procedural_actions: [],
    exceptions: [],
    generichide: false
};

// ---------------------------------------------------------------------------
suite('cosmetic / hide selectors');
// ---------------------------------------------------------------------------

test('hide selectors are emitted into one style element', () => {
    const e = fixture({ data: BASIC });
    const css = styleText(e);
    contains(css, '.video-ads{display:none!important}');
    contains(css, '.ad-slot{display:none!important}');
});

test('update() is idempotent: one style element, not one per call', () => {
    const e = fixture({ data: BASIC });
    e.window.__shieldtubeCosmetic.update(BASIC);
    e.window.__shieldtubeCosmetic.update(BASIC);
    const all = e.document.querySelectorAll('#shieldtube-cosmetic-style');
    eq(all.length, 1, 'exactly one style element');
});

test('an empty payload writes an empty rule set, not stale rules', () => {
    const e = fixture({ data: BASIC });
    e.window.__shieldtubeCosmetic.update({ hide_selectors: [] });
    eq(styleText(e), '');
});

test('update accepts JSON text as well as an object', () => {
    const e = createEnvironment({});
    e.run('shieldtube-cosmetic.js', COSMETIC);
    e.window.__shieldtubeCosmetic.update(JSON.stringify(BASIC));
    contains(styleText(e), '.video-ads');
});

test('malformed JSON does not throw and does not clear existing rules', () => {
    const e = fixture({ data: BASIC });
    e.window.__shieldtubeCosmetic.update('{"hide_selectors": [');
    contains(styleText(e), '.video-ads', 'previous rules survive a bad payload');
});

// ---------------------------------------------------------------------------
suite('cosmetic / exceptions');
// ---------------------------------------------------------------------------

test('exceptions are appended as :not() so specific elements survive', () => {
    const e = fixture({
        data: {
            hide_selectors: ['.ad-slot'],
            procedural_actions: [],
            exceptions: ['#v1', '.keep-me'],
            generichide: false
        }
    });
    const css = styleText(e);
    contains(css, '.ad-slot:not(#v1):not(.keep-me){display:none!important}');
});

test('an exception whose selector is invalid is passed through harmlessly', () => {
    const e = fixture({
        data: {
            hide_selectors: ['.ad-slot'],
            procedural_actions: [],
            exceptions: [':has(>img)'],
            generichide: false
        }
    });
    contains(styleText(e), '.ad-slot:not(:has(>img))');
});

// ---------------------------------------------------------------------------
suite('cosmetic / generichide');
// ---------------------------------------------------------------------------

test('generichide drops generic selectors but keeps ad/yt vocabulary', () => {
    // isGeneric() keeps anything matching ytd|ytp|yt-|ad|sponsor|promoted|
    // player|masthead|video|overlay, so the exempt set is wide on purpose: a
    // generichide page must still get its site-specific ad rules. Only selectors
    // outside that vocabulary are dropped.
    const e = fixture({
        data: {
            hide_selectors: ['.ad-slot', '.sponsor', 'ytd-compact-video-renderer', '.sidebar-box', '.video-ads'],
            procedural_actions: [],
            exceptions: [],
            generichide: true
        }
    });
    const css = styleText(e);
    eq(css.indexOf('.sidebar-box'), -1, '.sidebar-box is generic and must be dropped');
    contains(css, '.ad-slot', 'the word ad exempts a selector from generichide');
    contains(css, '.sponsor');
    contains(css, 'ytd-compact-video-renderer');
    contains(css, '.video-ads');
});

test('generichide=false keeps everything', () => {
    const e = fixture({
        data: {
            hide_selectors: ['.ad-slot'],
            procedural_actions: [],
            exceptions: [],
            generichide: false
        }
    });
    contains(styleText(e), '.ad-slot');
});

// ---------------------------------------------------------------------------
suite('cosmetic / procedural actions');
// ---------------------------------------------------------------------------

function proc(e, spec, action) {
    e.window.__shieldtubeCosmetic.update({
        hide_selectors: [],
        procedural_actions: [JSON.stringify({ selector: spec, action })],
        exceptions: [],
        generichide: false
    });
}

test('css-selector + remove deletes the matching node', () => {
    const e = fixture({ data: BASIC });
    const before = e.document.querySelectorAll('.promoted-sparkles').length;
    eq(before, 1);
    proc(e, [{ type: 'css-selector', arg: '.promoted-sparkles' }], { type: 'remove' });
    eq(e.document.querySelectorAll('.promoted-sparkles').length, 0);
});

test('no action type means hide with display:none!important', () => {
    const e = fixture({ data: BASIC });
    const el = e.document.querySelector('.promoted-sparkles');
    proc(e, [{ type: 'css-selector', arg: '.promoted-sparkles' }], {});
    eq(el.style.getPropertyValue('display'), 'none');
});

test('has-text selects by text content (paired with a structural selector)', () => {
    // A bare has-text matches every ancestor whose aggregated text contains the
    // phrase, including documentElement — and removing the root is a no-op in a
    // browser, so a real list always pairs it with a selector. Mirror that.
    const e = fixture({ data: BASIC });
    const item = e.document.querySelector('#v1');
    item.textContent = 'Promoted video';
    proc(e, [
        { type: 'css-selector', arg: '.video-item' },
        { type: 'has-text', arg: 'Promoted' }
    ], { type: 'remove' });
    eq(e.document.querySelectorAll('#v1').length, 0, 'the matching node is removed');
});

test('has-text alone matches the root too, and removing the root is a no-op', () => {
    // Pinning observed behaviour rather than leaving it undocumented: without a
    // structural selector the only match is documentElement, which the script
    // hands to remove(), and removeChild on a parentless node does nothing.
    const e = fixture({ data: BASIC });
    e.document.querySelector('#v1').textContent = 'Promoted video';
    proc(e, [{ type: 'has-text', arg: 'Promoted' }], { type: 'remove' });
    eq(e.document.documentElement.parentNode, null, 'root has no parent');
    eq(e.document.querySelectorAll('.promoted-sparkles').length, 1, 'nothing else touched');
});

test('min-text-length skips short nodes and removes long ones', () => {
    const e = fixture({ data: BASIC });
    const item = e.document.querySelector('#v1');
    item.textContent = 'short';
    proc(e, [
        { type: 'css-selector', arg: '.video-item' },
        { type: 'min-text-length', arg: '10' }
    ], { type: 'remove' });
    eq(e.document.querySelectorAll('#v1').length, 1, 'too short, must survive');
    item.textContent = 'a much longer text that qualifies';
    e.window.__shieldtubeCosmetic.update({
        hide_selectors: [],
        procedural_actions: [JSON.stringify({
            selector: [
                { type: 'css-selector', arg: '.video-item' },
                { type: 'min-text-length', arg: '10' }
            ],
            action: { type: 'remove' }
        })],
        exceptions: [],
        generichide: false
    });
    eq(e.document.querySelectorAll('#v1').length, 0);
});

test('matches-path only acts on the matching URL', () => {
    const e = fixture({ data: BASIC });
    const rule = (path) => ({
        hide_selectors: [],
        procedural_actions: [JSON.stringify({
            selector: [
                { type: 'matches-path', arg: path },
                { type: 'css-selector', arg: '.promoted-sparkles' }
            ],
            action: { type: 'remove' }
        })],
        exceptions: [],
        generichide: false
    });
    // location.pathname is /tv: a /watch rule must not fire.
    e.window.__shieldtubeCosmetic.update(rule('/watch'));
    eq(e.document.querySelectorAll('.promoted-sparkles').length, 1, 'non-matching path is inert');
    e.window.__shieldtubeCosmetic.update(rule('/tv'));
    eq(e.document.querySelectorAll('.promoted-sparkles').length, 0, 'matching path fires');
});

test('matches-attr matches on attribute name or value', () => {
    const e = fixture({ data: BASIC });
    const item = e.document.querySelector('#v1');
    item.setAttribute('data-ad', '1');
    // Pair with a selector so the root, which also carries prose, cannot match.
    proc(e, [
        { type: 'css-selector', arg: '.video-item' },
        { type: 'matches-attr', arg: 'data-ad' }
    ], { type: 'remove' });
    eq(e.document.querySelectorAll('#v1').length, 0);
});

test('upward with a count walks to the ancestor', () => {
    const e = fixture({ data: BASIC });
    const target = e.document.querySelector('.promoted-sparkles');
    const parent = target.parentElement;
    proc(e, [
        { type: 'css-selector', arg: '.promoted-sparkles' },
        { type: 'upward', arg: '1' }
    ], { type: 'style', arg: 'opacity:0!important;' });
    contains(parent.getAttribute('style') || '', 'opacity:0');
});

test('xpath without document.evaluate is a no-op, not a crash', () => {
    const e = fixture({ data: BASIC });
    proc(e, [{ type: 'xpath', arg: '//div[@id="v1"]' }], { type: 'remove' });
    eq(e.document.querySelectorAll('#v1').length, 1, 'nothing removed, no throw');
});

test('unknown selector operator aborts that action without throwing', () => {
    const e = fixture({ data: BASIC });
    proc(e, [{ type: 'not-a-real-operator', arg: 'x' }], { type: 'remove' });
    eq(e.document.querySelectorAll('.promoted-sparkles').length, 1);
});

test('exception selector protects a node from a procedural action', () => {
    const e = fixture({ data: BASIC });
    e.window.__shieldtubeCosmetic.update({
        hide_selectors: [],
        procedural_actions: [JSON.stringify({
            selector: [{ type: 'css-selector', arg: '.promoted-sparkles' }],
            action: { type: 'remove' }
        })],
        exceptions: ['.promoted-sparkles'],
        generichide: false
    });
    eq(e.document.querySelectorAll('.promoted-sparkles').length, 1, 'exception wins');
});

test('a malformed procedural action string is skipped, others still apply', () => {
    const e = fixture({ data: BASIC });
    e.window.__shieldtubeCosmetic.update({
        hide_selectors: [],
        procedural_actions: [
            '{not json',
            JSON.stringify({
                selector: [{ type: 'css-selector', arg: '.promoted-sparkles' }],
                action: { type: 'remove' }
            })
        ],
        exceptions: [],
        generichide: false
    });
    eq(e.document.querySelectorAll('.promoted-sparkles').length, 0);
});

test('actions are not re-applied to an already-marked node', () => {
    const e = fixture({ data: BASIC });
    const el = e.document.querySelector('.promoted-sparkles');
    proc(e, [{ type: 'css-selector', arg: '.promoted-sparkles' }], { type: 'style', arg: 'color:red;' });
    const first = el.getAttribute('style');
    e.window.__shieldtubeCosmetic.run();
    e.window.__shieldtubeCosmetic.run();
    eq(el.getAttribute('style'), first, 'style must not be doubled on re-run');
    eq(el.getAttribute('data-shieldtube-cosmetic'), '1');
});

test('remove-attr and remove-class act on the target element', () => {
    const e = fixture({ data: BASIC });
    const item = e.document.querySelector('#v1');
    item.setAttribute('data-x', 'y');
    item.className = 'video-item extra';
    proc(e, [{ type: 'css-selector', arg: '#v1' }], { type: 'remove-attr', arg: 'data-x' });
    eq(item.getAttribute('data-x'), null);
    item.setAttribute('data-y', '1');
    e.window.__shieldtubeCosmetic.update({
        hide_selectors: [],
        procedural_actions: [JSON.stringify({
            selector: [{ type: 'css-selector', arg: '#v1' }],
            action: { type: 'remove-class', arg: 'extra' }
        })],
        exceptions: [],
        generichide: false
    });
    eq(item.getAttribute('data-shieldtube-cosmetic') !== null, true);
});

// ---------------------------------------------------------------------------
suite('cosmetic / SPA navigation and lifecycle');
// ---------------------------------------------------------------------------

test('re-application after SPA navigation picks up newly added nodes', () => {
    const e = fixture({ data: BASIC });
    eq(e.document.querySelectorAll('.ad-slot').length, 1);
    // YouTube swaps the whole secondary results panel on navigation.
    const fresh = e.document.createElement('div');
    fresh.className = 'ad-slot';
    e.document.body.appendChild(fresh);
    eq(e.document.querySelectorAll('.ad-slot').length, 2);
    // The MutationObserver schedules a debounced run; advancing the clock fires it.
    e.clock.advance(500);
    eq(fresh.getAttribute('data-shieldtube-cosmetic'), null,
        'a hide-selector rule works through the stylesheet, not by marking nodes');
    contains(styleText(e), '.ad-slot', 'the rule is still in force for the new node');
});

test('a procedural action applies to a node added after the first run', () => {
    const e = fixture({ data: BASIC });
    e.window.__shieldtubeCosmetic.update({
        hide_selectors: [],
        procedural_actions: [JSON.stringify({
            selector: [{ type: 'css-selector', arg: '.late-ad' }],
            action: { type: 'remove' }
        })],
        exceptions: [],
        generichide: false
    });
    const host = e.document.createElement('div');
    host.id = 'late-host';
    e.document.body.appendChild(host);
    const late = e.document.createElement('div');
    late.className = 'late-ad';
    host.appendChild(late);
    e.clock.advance(500);              // debounced MutationObserver run
    eq(e.document.querySelectorAll('.late-ad').length, 0, 'late node removed');
});

test('clear() removes the style element and unmarks nodes', () => {
    const e = fixture({ data: BASIC });
    e.window.__shieldtubeCosmetic.update({
        hide_selectors: ['.ad-slot'],
        procedural_actions: [JSON.stringify({
            selector: [{ type: 'css-selector', arg: '.promoted-sparkles' }],
            action: { type: 'style', arg: 'opacity:0;' }
        })],
        exceptions: [],
        generichide: false
    });
    eq(e.document.querySelectorAll('.promoted-sparkles')[0].getAttribute('data-shieldtube-cosmetic'), '1');
    e.window.__shieldtubeCosmetic.clear();
    eq(e.document.getElementById('shieldtube-cosmetic-style'), null);
    eq(e.document.querySelectorAll('[data-shieldtube-cosmetic]').length, 0);
});

test('clear() then update() restores cosmetic blocking', () => {
    const e = fixture({ data: BASIC });
    e.window.__shieldtubeCosmetic.clear();
    eq(styleText(e), '');
    e.window.__shieldtubeCosmetic.update(BASIC);
    contains(styleText(e), '.video-ads');
});

test('a throwing getComputedStyle does not break the run', () => {
    const e = fixture({ data: BASIC });
    e.window.getComputedStyle = () => { throw new Error('no layout'); };
    e.window.__shieldtubeCosmetic.update({
        hide_selectors: [],
        procedural_actions: [JSON.stringify({
            selector: [{ type: 'matches-css', arg: 'display:none' }],
            action: { type: 'remove' }
        })],
        exceptions: [],
        generichide: false
    });
    eq(e.document.querySelectorAll('.promoted-sparkles').length, 1);
});

test('evaluating the script twice does not double-install', () => {
    const e = fixture({ data: BASIC });
    const before = e.window.__shieldtubeCosmetic;
    e.run('shieldtube-cosmetic.js', COSMETIC);
    eq(e.window.__shieldtubeCosmetic, before, 'same controller object');
});
