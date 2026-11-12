// SPDX-License-Identifier: GPL-3.0-or-later
//
// A deliberately small fake DOM + WebView bridge, enough to run the three
// bundled page-world scripts (watchdog, shim, cosmetic) in plain node with no
// dependencies.
//
// Design rules:
//  * No external packages. Node >= 18 built-ins only.
//  * Time is virtual. setTimeout/setInterval are recorded and fired by the
//    test, so a 500 ms watchdog tick is deterministic.
//  * Everything a test can observe is explicit: posted bridge messages,
//    style contents, which elements were hidden/removed.
//  * Where fidelity would require a real browser, the stub says so in a
//    comment naming the on-device check that covers it.
'use strict';

const vm = require('node:vm');

// ---------------------------------------------------------------- elements --
let elementSeq = 0;

class FakeElement {
    constructor(tagName, doc) {
        this.tagName = String(tagName || 'div').toUpperCase();
        this.nodeType = 1;
        this.ownerDocument = doc;
        this.children = [];
        this.childNodes = this.children;
        this.parentNode = null;
        this.parentElement = null;
        this.attributes = [];
        this.style = makeStyle();
        this.className = '';
        this.id = '';
        this._text = '';
        this._uid = ++elementSeq;
        this._listeners = {};
        this._removed = false;
    }

    get classList() {
        const self = this;
        return {
            add(c) {
                const set = new Set(self.className.split(/\s+/).filter(Boolean));
                set.add(c);
                self.className = [...set].join(' ');
            },
            remove(c) {
                self.className = self.className
                    .split(/\s+/)
                    .filter((x) => x && x !== c)
                    .join(' ');
            },
            contains(c) {
                return self.className.split(/\s+/).includes(c);
            }
        };
    }

    setAttribute(name, value) {
        const v = String(value);
        const doc = this.ownerDocument;
        if (doc && doc.__notifyMutation) { doc.__notifyMutation(this, 'attributes'); }
        const found = this.attributes.find((a) => a.name === name);
        if (found) {
            found.value = v;
        } else {
            this.attributes.push({ name, value: v });
        }
        if (name === 'class') { this.className = v; }
        if (name === 'id') { this.id = v; }
        if (name === 'style') {
            this.style._raw = v;
            for (const decl of v.split(';')) {
                const i = decl.indexOf(':');
                if (i > 0) {
                    this.style._props.set(
                        decl.slice(0, i).trim().toLowerCase(),
                        decl.slice(i + 1).replace(/!important/, '').trim()
                    );
                }
            }
        }
    }

    getAttribute(name) {
        if (name === 'style') { return this.style._raw || null; }
        if (name === 'class') { return this.className || null; }
        if (name === 'id') { return this.id || null; }
        const a = this.attributes.find((x) => x.name === name);
        return a ? a.value : null;
    }

    removeAttribute(name) {
        this.attributes = this.attributes.filter((a) => a.name !== name);
        if (name === 'class') { this.className = ''; }
        if (name === 'style') { this.style._raw = ''; }
    }

    appendChild(child) {
        child.parentNode = this;
        child.parentElement = this.nodeType === 1 ? this : null;
        this.children.push(child);
        const doc = this.ownerDocument || (this.nodeType === 9 ? this : null);
        if (doc && doc.__notifyMutation) { doc.__notifyMutation(this, 'childList'); }
        return child;
    }

    removeChild(child) {
        const i = this.children.indexOf(child);
        if (i === -1) { throw new Error('removeChild: node is not a child'); }
        this.children.splice(i, 1);
        child.parentNode = null;
        child.parentElement = null;
        child._removed = true;
        return child;
    }

    addEventListener(type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
    }

    removeEventListener(type, fn) {
        const l = this._listeners[type] || [];
        const i = l.indexOf(fn);
        if (i > -1) { l.splice(i, 1); }
    }

    dispatch(type, event) {
        for (const fn of this._listeners[type] || []) {
            fn.call(this, event || { type, target: this });
        }
    }

    // Minimal selector support: tag, .class, #id, [attr], [attr=value],
    // comma lists, and the descendant ' ' combinator which is what the bundled
    // scripts actually use. Anything else returns no match rather than
    // throwing, which is what a browser does for :has() in older WebViews.
    matches(selector) {
        return matchSelector(this, selector);
    }
    webkitMatchesSelector(s) { return this.matches(s); }
    msMatchesSelector(s) { return this.matches(s); }

    querySelectorAll(selector) {
        const out = [];
        for (const part of splitSelectors(selector)) {
            collectMatching(this, part.trim(), out);
        }
        return dedupe(out);
    }

    querySelector(selector) {
        const all = this.querySelectorAll(selector);
        return all.length ? all[0] : null;
    }

    contains(node) {
        if (node === this) { return true; }
        for (const c of this.children) {
            if (c.contains(node)) { return true; }
        }
        return false;
    }

    // Real DOM semantics: textContent concatenates every descendant text node.
    // has-text / min-text-length depend on this, so a plain field would make
    // those operators silently never match.
    get textContent() {
        if (this.nodeType === 3) { return this._text; }
        let out = this._text || '';
        for (const c of this.children) { out += c.textContent; }
        return out;
    }
    set textContent(v) {
        this.children.length = 0;
        this._text = v === null || v === undefined ? '' : String(v);
    }

    get innerHTML() { return ''; }
    set innerHTML(v) { this.children.length = 0; this._innerHTML = String(v); }
    get outerHTML() { return `<${this.tagName.toLowerCase()}>`; }
}

function makeStyle() {
    const props = new Map();
    return {
        _props: props,
        _raw: '',
        setProperty(name, value) {
            props.set(String(name).toLowerCase(), String(value));
        },
        removeProperty(name) { props.delete(String(name).toLowerCase()); },
        getPropertyValue(name) { return props.get(String(name).toLowerCase()) || ''; },
        get display() { return props.get('display') || ''; },
        set display(v) { props.set('display', v); },
        get cssText() {
            return [...props.entries()].map(([k, v]) => `${k}: ${v}`).join('; ');
        }
    };
}

function splitSelectors(selector) {
    // Split on commas that are not inside parens or brackets.
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of String(selector)) {
        if (ch === '(' || ch === '[') { depth++; }
        if (ch === ')' || ch === ']') { depth--; }
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) { out.push(cur); }
    return out;
}

function matchSimple(el, simple) {
    if (!el || el.nodeType !== 1) { return false; }
    // Strip pseudo-classes we cannot evaluate; treat them as "does not matter",
    // except :not(...) which the cosmetic style rule uses and which we handle.
    const nots = [];
    let s = simple.replace(/:not\(([^)]*)\)/g, (_, inner) => {
        nots.push(inner);
        return '';
    });
    s = s.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '');

    const parts = s.match(/(\[[^\]]*\]|[.#]?[A-Za-z0-9_-]+|\*)/g) || [];
    for (const p of parts) {
        if (p === '*') { continue; }
        if (p.startsWith('.')) {
            if (!el.className.split(/\s+/).includes(p.slice(1))) { return false; }
        } else if (p.startsWith('#')) {
            if (el.id !== p.slice(1)) { return false; }
        } else if (p.startsWith('[')) {
            const body = p.slice(1, -1);
            const eq = body.indexOf('=');
            if (eq === -1) {
                if (el.getAttribute(body.trim()) === null) { return false; }
            } else {
                const name = body.slice(0, eq).trim();
                const want = body.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
                if (el.getAttribute(name) !== want) { return false; }
            }
        } else if (/^[A-Za-z][A-Za-z0-9-]*$/.test(p)) {
            if (el.tagName !== p.toUpperCase()) { return false; }
        } else {
            return false;
        }
    }
    for (const inner of nots) {
        if (el.matches(inner)) { return false; }
    }
    return true;
}

function matchSelector(el, selector) {
    for (const alt of splitSelectors(selector)) {
        const chain = alt.trim().split(/\s+/).filter(Boolean);
        if (!chain.length) { continue; }
        if (!matchSimple(el, chain[chain.length - 1])) { continue; }
        // Walk the ancestor chain for the remaining descendant parts.
        let i = chain.length - 2;
        let node = el.parentElement;
        while (i >= 0) {
            let found = false;
            while (node) {
                if (matchSimple(node, chain[i])) { found = true; node = node.parentElement; break; }
                node = node.parentElement;
            }
            if (!found) { break; }
            i--;
        }
        if (i < 0) { return true; }
    }
    return false;
}

function collectMatching(root, selector, out) {
    for (const child of root.children) {
        if (child.nodeType === 1) {
            if (child.matches(selector)) { out.push(child); }
            collectMatching(child, selector, out);
        }
    }
}

function dedupe(arr) {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
        if (!seen.has(x._uid)) { seen.add(x._uid); out.push(x); }
    }
    return out;
}

// ---------------------------------------------------------------- document --
class FakeDocument {
    constructor() {
        this.nodeType = 9;
        this.readyState = 'loading';
        this._listeners = {};
        this.documentElement = new FakeElement('html', this);
        this.head = new FakeElement('head', this);
        this.body = new FakeElement('body', this);
        this.documentElement.appendChild(this.head);
        this.documentElement.appendChild(this.body);
        this._elementsById = new Map();
        this.cookie = '';
        this._tagCache = new Map();
    }

    createElement(tag) {
        const el = new FakeElement(tag, this);
        if (tag === 'video') {
            el.currentTime = 0;
            el.duration = NaN;
            el.paused = true;
            el.canPlayType = () => '';
        }
        return el;
    }

    createTextNode(text) { const el = new FakeElement('#text', this); el.nodeType = 3; el.textContent = String(text); return el; }

    getElementById(id) {
        const walk = (node) => {
            for (const c of node.children) {
                if (c.id === id) { return c; }
                const deep = walk(c);
                if (deep) { return deep; }
            }
            return null;
        };
        return walk(this.documentElement);
    }

    querySelectorAll(sel) {
        const out = [];
        collectMatching(this.documentElement, sel, out);
        return out;
    }
    querySelector(sel) { const a = this.querySelectorAll(sel); return a.length ? a[0] : null; }

    addEventListener(type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
    }
    removeEventListener(type, fn) {
        const l = this._listeners[type] || [];
        const i = l.indexOf(fn);
        if (i > -1) { l.splice(i, 1); }
    }
    dispatch(type) {
        for (const fn of [...(this._listeners[type] || [])]) {
            fn.call(this, { type });
        }
        // In a browser these events are dispatched at the document and bubble
        // to window, which is why the shim can listen for DOMContentLoaded on
        // window. Model the bubble so listeners attached either way both run.
        const view = this.defaultView;
        if (view && typeof view.dispatch === 'function') {
            view.dispatch(type, { type, target: this });
        }
    }

    getComputedStyle(el) {
        return el.style || makeStyle();
    }

    evaluate() { throw new Error('document.evaluate is not implemented in the stub'); }
}

// ---------------------------------------------------------- virtual clock ---
class VirtualClock {
    constructor() {
        this.now = 1_600_000_000_000;
        this.timers = [];
        this.seq = 0;
    }

    setTimeout(fn, ms) {
        const id = ++this.seq;
        this.timers.push({ id, at: this.now + (ms || 0), fn, interval: null });
        return id;
    }
    setInterval(fn, ms) {
        const id = ++this.seq;
        this.timers.push({ id, at: this.now + (ms || 0), fn, interval: ms || 1 });
        return id;
    }
    clear(id) { this.timers = this.timers.filter((t) => t.id !== id); }
    clearTimeout(id) { this.clear(id); }

    /** Fire every timer due within `ms`, in order, without real waiting. */
    advance(ms) {
        const target = this.now + ms;
        let guard = 0;
        for (;;) {
            this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
            const next = this.timers[0];
            if (!next || next.at > target) { break; }
            this.now = next.at;
            if (next.interval) {
                next.at = this.now + next.interval;
            } else {
                this.timers.shift();
            }
            try { next.fn(); } catch (e) { this.onError && this.onError(e); }
            if (++guard > 100000) { throw new Error('virtual clock: too many timers'); }
        }
        this.now = target;
    }

    pending() { return this.timers.length; }
    reset() { this.timers = []; this.now = 1_600_000_000_000; }
}

// ------------------------------------------------------------- environment --
function createEnvironment(options = {}) {
    const opts = Object.assign({
        href: 'https://www.youtube.com/tv#/watch?v=abc',
        userAgent: 'Mozilla/5.0 (Linux; Android 11; SHIELD) AppleWebKit/537.36 Chrome/120 Safari/537.36 ShieldTube',
        document: true,          // false reproduces DOCUMENT_START before any node exists
        eme: 'absent',           // absent | available | rejected | throws
        fetch: true,
        mutationObserver: true,
        // A document-start script really does see 'loading'. Fixtures that are
        // not testing that path start interactive so the scripts run at once.
        readyState: 'interactive'
    }, options);

    const clock = new VirtualClock();
    const posted = [];
    const doc = opts.document ? new FakeDocument() : null;
    if (doc) { doc.readyState = opts.readyState; }

    const location = {
        href: opts.href,
        pathname: (() => { try { return new URL(opts.href).pathname; } catch (e) { return '/'; } })(),
        search: (() => { try { return new URL(opts.href).search; } catch (e) { return ''; } })(),
        hash: (() => { try { return new URL(opts.href).hash; } catch (e) { return ''; } })()
    };

    const history = {
        _state: [],
        pushState(state, title, url) {
            history._state.push(['pushState', url]);
            if (url) { setUrl(String(url)); }
        },
        replaceState(state, title, url) {
            history._state.push(['replaceState', url]);
            if (url) { setUrl(String(url)); }
        }
    };

    function setUrl(href) {
        const u = new URL(href, location.href);
        const old = location.href;
        location.href = u.href;
        location.pathname = u.pathname;
        location.search = u.search;
        location.hash = u.hash;
        return old;
    }

    const windowListeners = {};
    const messages = [];

    const window = {
        document: doc,
        location,
        history,
        navigator: { userAgent: opts.userAgent },
        innerWidth: 1920,
        innerHeight: 1080,
        setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
        clearTimeout: (id) => clock.clearTimeout(id),
        setInterval: (fn, ms) => clock.setInterval(fn, ms),
        clearInterval: (id) => clock.clear(id),
        addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn); },
        removeEventListener(type, fn) {
            const l = windowListeners[type] || [];
            const i = l.indexOf(fn);
            if (i > -1) { l.splice(i, 1); }
        },
        dispatch(type, ev) {
            for (const fn of [...(windowListeners[type] || [])]) { fn.call(window, ev || { type }); }
        },
        getComputedStyle: (el) => (el && el.style) || makeStyle(),
        fetch: null,
        XMLHttpRequest: null,
        MutationObserver: null,
        XPathResult: null,
        Response: globalThis.Response,
        Request: globalThis.Request,
        Headers: globalThis.Headers,
        JSON,
        String,
        Object,
        Array,
        Math,
        Date: makeFakeDate(clock),
        isFinite,
        parseInt,
        parseInt10: (v) => parseInt(v, 10),
        console,
        ShieldTubeNative: {
            post(payload) {
                let parsed = null;
                try { parsed = JSON.parse(payload); } catch (e) { parsed = { raw: payload }; }
                posted.push(parsed);
            }
        },
        __internals: { clock, posted, messages, windowListeners, setUrl }
    };

    // AudioStream / Tizen helper the real page has; the scripts do not need it,
    // but its absence must not matter. Left undefined on purpose.

    if (opts.eme !== 'absent') {
        window.navigator.requestMediaKeySystemAccess = (type) => {
            if (opts.eme === 'throws') { throw new Error('boom'); }
            if (opts.eme === 'available') { return Promise.resolve({ keySystem: type }); }
            const err = new Error('no widevine');
            err.name = 'NotSupportedError';
            return Promise.reject(err);
        };
    }

    if (opts.mutationObserver && doc) {
        const observers = [];
        window.MutationObserver = class {
            constructor(fn) { this.fn = fn; this.records = []; }
            observe(target, options) {
                this.target = target;
                this.options = options || {};
                observers.push(this);
                window.__internals.observers = observers;
            }
            disconnect() {
                const i = observers.indexOf(this);
                if (i > -1) { observers.splice(i, 1); }
            }
            takeRecords() {
                const r = this.records;
                this.records = [];
                return r;
            }
        };
        // Delivered asynchronously in a browser; the virtual clock fires it.
        doc.__notifyMutation = (target, kind) => {
            for (const o of observers.slice()) {
                o.records.push({ type: kind, target });
                window.setTimeout(() => {
                    const records = o.takeRecords();
                    if (records.length && typeof o.fn === 'function') { o.fn(records, o); }
                }, 0);
            }
        };
        window.__internals.observer = null;
    }

    if (doc) {
        doc.defaultView = window;
        doc.location = location;
        doc.evaluate = () => { throw new Error('document.evaluate not implemented in stub'); };
    }

    // ---- fetch stub: records calls, returns a scripted Response ------------
    const fetchCalls = [];
    if (opts.fetch) {
        window.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const call = {
                url,
                init,
                respond(body, extra = {}) {
                    const text = String(body);
                    const res = new Response(text, Object.assign({ status: 200, headers: { 'content-type': 'application/json' } }, extra));
                    Object.defineProperty(res, 'url', { value: extra.url || url });
                    Object.defineProperty(res, 'redirected', { value: !!extra.redirected });
                    Object.defineProperty(res, 'type', { value: extra.type || 'basic' });
                    // Deliberately NOT made replayable: a real Response body is
                    // single-use, and keeping that property is what lets the
                    // suite catch a wrapper that consumes the body and then
                    // hands the same response on to the page.
                    return res;
                }
            };
            fetchCalls.push(call);
            return new Promise((resolve, reject) => {
                call._resolve = resolve;
                call._reject = reject;
                if (opts.autoResolveFetch) { resolve(call.respond(opts.autoResolveFetch)); }
            });
        };
        window.fetch._calls = fetchCalls;
    }

    // ---- XHR stub ----------------------------------------------------------
    class FakeXHR {
        constructor() {
            this.readyState = 0;
            this._responseText = '';
            this._listeners = {};
        }
        open(method, url) {
            this._url = url;
            this.readyState = 1;
        }
        addEventListener(type, fn) {
            (this._listeners[type] = this._listeners[type] || []).push(fn);
        }
        send() {
            FakeXHR.last = this;
        }
        _finish(body) {
            this.readyState = 4;
            this._responseText = body;
            for (const fn of this._listeners.readystatechange || []) { fn.call(this, {}); }
        }
    }
    // Mirrors XMLHttpRequest in a browser: both are accessors on the prototype,
    // so a wrapper can read the original through the descriptor's getter (which
    // is exactly how the shim reads the untampered body) and can shadow them
    // per instance without touching the prototype.
    Object.defineProperty(FakeXHR.prototype, 'responseText', {
        configurable: true,
        get() { return this._responseText; }
    });
    Object.defineProperty(FakeXHR.prototype, 'response', {
        configurable: true,
        get() {
            if (this.responseType !== 'json') { return this._responseText; }
            try { return JSON.parse(this._responseText); } catch (e) { return null; }
        }
    });
    window.XMLHttpRequest = FakeXHR;
    window.__internals.FakeXHR = FakeXHR;

    // Run scripts with `window` as the global and `self` aliasing it, which is
    // how a page-world script sees the world. strict mode inside an IIFE still
    // resolves free identifiers against this object.
    const sandbox = { };
    Object.assign(sandbox, globalThis);
    sandbox.window = window;
    sandbox.self = window;
    sandbox.document = doc;
    sandbox.location = location;
    sandbox.history = history;
    sandbox.navigator = window.navigator;
    sandbox.setTimeout = window.setTimeout;
    sandbox.clearTimeout = window.clearTimeout;
    sandbox.setInterval = window.setInterval;
    sandbox.clearInterval = window.clearInterval;
    sandbox.MutationObserver = window.MutationObserver;
    sandbox.fetch = window.fetch;
    sandbox.XMLHttpRequest = window.XMLHttpRequest;
    sandbox.Response = globalThis.Response;
    sandbox.Request = globalThis.Request;
    sandbox.Headers = globalThis.Headers;
    sandbox.ShieldTubeNative = window.ShieldTubeNative;
    sandbox.Date = window.Date;
    sandbox.console = console;

    return {
        window,
        document: doc,
        clock,
        posted,
        fetchCalls,
        location,
        history,
        sandbox,
        setUrl,
        message(kind, value) {
            messages.push({ kind, value });
        },
        snapMessages() { return messages.slice(); },
        /** Evaluate a bundled script file in this environment. */
        run(filename, source) {
            const ctx = vm.createContext(sandbox);
            vm.runInContext(source, ctx, { filename });
            return ctx;
        }
    };
}

function makeFakeDate(clock) {
    class FakeDate extends Date {
        constructor(...args) {
            if (args.length === 0) { super(clock.now); } else { super(...args); }
        }
        static now() { return clock.now; }
    }
    return FakeDate;
}

// Small DOM builders so tests read like fixtures, not like DOM plumbing.
function buildDom(doc, spec) {
    // spec: { tag, id, class, attrs, text, children: [...] }
    function make(node) {
        const el = doc.createElement(node.tag || 'div');
        if (node.id) { el.id = node.id; }
        if (node.class) { el.className = node.class; }
        if (node.text) { el.textContent = node.text; }
        for (const [k, v] of Object.entries(node.attrs || {})) { el.setAttribute(k, v); }
        for (const child of node.children || []) { el.appendChild(make(child)); }
        return el;
    }
    for (const node of Array.isArray(spec) ? spec : [spec]) {
        doc.body.appendChild(make(node));
    }
    return doc;
}

module.exports = { createEnvironment, buildDom, FakeElement, FakeDocument, VirtualClock };
