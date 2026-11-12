#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Minimal assertion harness. Tests may be synchronous or return a promise; the
// runner awaits them in declaration order, so an async test can assert on the
// settled state of the shim's fetch path without racing anything.
//
// Registration is deferred: `test()` only records the case. run.js then calls
// runAll(), which awaits each case in order and reports.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ASSETS = path.join(__dirname, '..', '..', 'main', 'assets', 'js');
const SCRIPTS = {
    watchdog: fs.readFileSync(path.join(ASSETS, 'shieldtube-watchdog.js'), 'utf8'),
    shim: fs.readFileSync(path.join(ASSETS, 'shieldtube-shim.js'), 'utf8'),
    cosmetic: fs.readFileSync(path.join(ASSETS, 'shieldtube-cosmetic.js'), 'utf8')
};

const cases = [];
let currentSuite = '(no suite)';

function suite(name) {
    currentSuite = name;
}

function test(name, fn) {
    cases.push({ suite: currentSuite, name, fn });
}

async function runAll() {
    const results = { pass: 0, fail: 0, failures: [], suites: [] };
    let lastSuite = null;
    for (const c of cases) {
        if (c.suite !== lastSuite) {
            lastSuite = c.suite;
            results.suites.push(c.suite);
            console.log(`\n=== ${c.suite} ===`);
        }
        try {
            await c.fn();
            results.pass++;
            console.log(`  ok   ${c.name}`);
        } catch (e) {
            results.fail++;
            results.failures.push({ suite: c.suite, name: c.name, error: e });
            console.log(`  FAIL ${c.name}`);
            const msg = String((e && e.stack) || e).split('\n');
            console.log(`       ${msg.slice(0, 4).join('\n       ')}`);
        }
    }
    return results;
}

function eq(actual, expected, what) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        throw new Error(`${what || 'value'}: expected ${e}, got ${a}`);
    }
}

function ok(cond, what) {
    if (!cond) { throw new Error(what || 'expected truthy'); }
}

function contains(haystack, needle, what) {
    if (String(haystack).indexOf(needle) === -1) {
        throw new Error(
            `${what || 'value'}: ${JSON.stringify(String(haystack))} does not contain ${JSON.stringify(needle)}`
        );
    }
}

module.exports = { suite, test, runAll, eq, ok, contains, SCRIPTS, cases };
