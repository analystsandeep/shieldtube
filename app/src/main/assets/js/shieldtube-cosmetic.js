// SPDX-License-Identifier: GPL-3.0-or-later
// Cosmetic layer for adblock-rust 0.13.5 UrlSpecificResources JSON.
// Injected on onPageFinished and on SPA URL changes. Re-applies procedural
// actions on a 250 ms debounced MutationObserver.
(function () {
    'use strict';
    if (window.__shieldtubeCosmetic) { return; }

    var STYLE_ID = 'shieldtube-cosmetic-style';
    var MARK_ATTR = 'data-shieldtube-cosmetic';
    var current = {
        hide_selectors: [], procedural_actions: [], exceptions: [],
        generichide: false, parsedActions: []
    };
    var observer = null;
    var timer = null;

    function parsePattern(arg) {
        if (typeof arg !== 'string') { return String(arg || ''); }
        var m = /^\/(.+)\/([gimsuy]*)$/.exec(arg);
        if (m) {
            try { return new RegExp(m[1], m[2]); } catch (e) { return arg; }
        }
        return arg;
    }

    function matchesPattern(value, arg) {
        var p = parsePattern(arg);
        if (p instanceof RegExp) { return p.test(String(value || '')); }
        return String(value || '').indexOf(String(p)) !== -1;
    }

    function parsePropPattern(arg) {
        var s = String(arg || '');
        var i = s.indexOf(':');
        if (i < 0) { return { prop: 'content', pattern: s.trim() }; }
        return { prop: s.slice(0, i).trim(), pattern: s.slice(i + 1).trim() };
    }

    function cssValue(el, pseudo, prop) {
        try {
            var cs = window.getComputedStyle(el, pseudo || null);
            return cs ? cs.getPropertyValue(prop) : '';
        } catch (e) { return ''; }
    }

    function matchesSelector(el, selector) {
        if (!el || el.nodeType !== 1 || !selector) { return false; }
        var fn = el.matches || el.msMatchesSelector || el.webkitMatchesSelector;
        try { return fn ? fn.call(el, selector) : false; } catch (e) { return false; }
    }

    function isException(el) {
        var list = current.exceptions || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && matchesSelector(el, list[i])) { return true; }
        }
        return false;
    }

    function isGeneric(selector) {
        if (!/^[.#][A-Za-z0-9_\-]+$/.test(selector)) { return false; }
        return !/ytd|ytp|yt-|ad|sponsor|promoted|player|masthead|video|overlay/i.test(selector);
    }

    function unique(nodes) {
        var out = [];
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i] && out.indexOf(nodes[i]) === -1) { out.push(nodes[i]); }
        }
        return out;
    }

    function queryFrom(node, selector) {
        try { return node.querySelectorAll ? node.querySelectorAll(selector) : []; }
        catch (e) { return []; }
    }

    function applyStyle() {
        var style = document.getElementById(STYLE_ID);
        if (!style) {
            style = document.createElement('style');
            style.id = STYLE_ID;
            (document.head || document.documentElement).appendChild(style);
        }
        var suffix = '';
        var exceptions = current.exceptions || [];
        for (var i = 0; i < exceptions.length; i++) {
            if (exceptions[i]) { suffix += ':not(' + exceptions[i] + ')'; }
        }
        var rules = [];
        var selectors = current.hide_selectors || [];
        for (var j = 0; j < selectors.length; j++) {
            var sel = selectors[j];
            if (!sel) { continue; }
            if (current.generichide && isGeneric(sel)) { continue; }
            rules.push(sel + suffix + '{display:none!important}');
        }
        style.textContent = rules.join('\n');
    }

    function selectNodes(ops) {
        var nodes = [document.documentElement || document.body || document];
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i] || {};
            var type = op.type;
            var arg = op.arg;
            var next = [];
            var n, j, k, found, child;

            if (type === 'css-selector') {
                for (n = 0; n < nodes.length; n++) {
                    found = queryFrom(nodes[n], arg);
                    for (j = 0; j < found.length; j++) { next.push(found[j]); }
                }
            } else if (type === 'has-text') {
                for (n = 0; n < nodes.length; n++) {
                    if (matchesPattern(nodes[n].textContent, arg)) { next.push(nodes[n]); }
                }
            } else if (type === 'min-text-length') {
                var min = parseInt(arg, 10);
                if (isNaN(min)) { return []; }
                for (n = 0; n < nodes.length; n++) {
                    if ((nodes[n].textContent || '').length >= min) { next.push(nodes[n]); }
                }
            } else if (type === 'matches-path') {
                if (!matchesPattern(location.pathname + location.search, arg)) { return []; }
                next = nodes.slice(0);
            } else if (type === 'matches-attr') {
                var spec = String(arg || '');
                var eq = spec.indexOf('=');
                var attrName = eq >= 0 ? spec.slice(0, eq).trim() : '';
                var pattern = eq >= 0 ? spec.slice(eq + 1).trim() : spec;
                for (n = 0; n < nodes.length; n++) {
                    var el = nodes[n];
                    if (!el || !el.attributes) { continue; }
                    for (j = 0; j < el.attributes.length; j++) {
                        var a = el.attributes[j];
                        if (attrName && a.name !== attrName) { continue; }
                        if (matchesPattern(a.value, pattern) || matchesPattern(a.name, pattern)) {
                            next.push(el);
                            break;
                        }
                    }
                }
            } else if (type === 'matches-css' || type === 'matches-css-before' || type === 'matches-css-after') {
                var parsed = parsePropPattern(arg);
                var pseudo = type === 'matches-css-before' ? '::before' :
                    (type === 'matches-css-after' ? '::after' : null);
                for (n = 0; n < nodes.length; n++) {
                    if (matchesPattern(cssValue(nodes[n], pseudo, parsed.prop), parsed.pattern)) {
                        next.push(nodes[n]);
                    }
                }
            } else if (type === 'upward') {
                var count = parseInt(arg, 10);
                for (n = 0; n < nodes.length; n++) {
                    var node = nodes[n];
                    if (!isNaN(count)) {
                        for (j = 0; j < count && node.parentElement; j++) { node = node.parentElement; }
                        next.push(node);
                    } else {
                        var parent = node.parentElement;
                        while (parent) {
                            if (matchesSelector(parent, arg)) { next.push(parent); break; }
                            parent = parent.parentElement;
                        }
                    }
                }
            } else if (type === 'xpath') {
                if (typeof document.evaluate !== 'function' || !window.XPathResult) { return []; }
                for (n = 0; n < nodes.length; n++) {
                    try {
                        found = document.evaluate(
                            String(arg || ''), nodes[n], null,
                            XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE, null
                        );
                        for (k = 0; k < found.snapshotLength; k++) { next.push(found.snapshotItem(k)); }
                    } catch (e) { }
                }
            } else {
                return [];
            }
            nodes = unique(next);
        }
        return nodes;
    }

    function applyAction(el, action) {
        if (!action || !action.type) {
            el.style.setProperty('display', 'none', 'important');
            return;
        }
        if (action.type === 'remove') {
            if (el.parentNode) { el.parentNode.removeChild(el); }
        } else if (action.type === 'style') {
            var existing = el.getAttribute('style') || '';
            el.setAttribute('style', existing + String(action.arg || ''));
        } else if (action.type === 'remove-attr') {
            el.removeAttribute(String(action.arg || ''));
        } else if (action.type === 'remove-class') {
            var cls = String(action.arg || '');
            if (el.classList) { el.classList.remove(cls); }
            else {
                var parts = (el.className || '').split(/\s+/);
                var out = [];
                for (var i = 0; i < parts.length; i++) { if (parts[i] && parts[i] !== cls) { out.push(parts[i]); } }
                el.className = out.join(' ');
            }
        } else {
            el.style.setProperty('display', 'none', 'important');
        }
    }

    function applyProcedural() {
        var actions = current.parsedActions || [];
        for (var i = 0; i < actions.length; i++) {
            var action = actions[i];
            var nodes = selectNodes(action.selector || []);
            for (var j = 0; j < nodes.length; j++) {
                var el = nodes[j];
                if (!el || el.nodeType !== 1 || isException(el)) { continue; }
                if (el.getAttribute(MARK_ATTR)) { continue; }
                try { el.setAttribute(MARK_ATTR, '1'); } catch (e) { }
                applyAction(el, action.action);
            }
        }
    }

    function run() {
        applyStyle();
        applyProcedural();
    }

    function schedule(mutations) {
        var style = document.getElementById(STYLE_ID);
        if (style && mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var target = mutations[i].target;
                if (target === style || (style.contains && style.contains(target))) { return; }
            }
        }
        if (timer) { clearTimeout(timer); }
        timer = setTimeout(function () { timer = null; run(); }, 250);
    }

    function start() {
        if (observer || typeof MutationObserver !== 'function') { return; }
        observer = new MutationObserver(schedule);
        observer.observe(document.documentElement || document, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ['class', 'id', 'style']
        });
    }

    window.__shieldtubeCosmetic = {
        update: function (data) {
            try {
                var parsed = typeof data === 'string' ? JSON.parse(data) : data;
                current.hide_selectors = parsed.hide_selectors || [];
                current.procedural_actions = parsed.procedural_actions || [];
                current.exceptions = parsed.exceptions || [];
                current.generichide = !!parsed.generichide;
                current.parsedActions = [];
                for (var i = 0; i < current.procedural_actions.length; i++) {
                    try { current.parsedActions.push(JSON.parse(current.procedural_actions[i])); }
                    catch (e) { }
                }
                start();
                run();
            } catch (e) { }
        },
        clear: function () {
            var style = document.getElementById(STYLE_ID);
            if (style && style.parentNode) { style.parentNode.removeChild(style); }
            var marked = document.querySelectorAll('[' + MARK_ATTR + ']');
            for (var i = 0; i < marked.length; i++) { marked[i].removeAttribute(MARK_ATTR); }
            current.hide_selectors = [];
            current.procedural_actions = [];
            current.exceptions = [];
            current.parsedActions = [];
            current.generichide = false;
        },
        run: run
    };
})();
