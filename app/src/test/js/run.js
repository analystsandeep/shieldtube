#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Entry point for the page-world JS suites. Usage:
//     node app/src/test/js/run.js               # every suite
//     node app/src/test/js/run.js watchdog      # suites whose file matches
//
// Exit code 0 only if every assertion passed. CI runs this as its own step.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runAll } = require('./harness');

const filter = process.argv[2] || '';
const dir = __dirname;
const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => !filter || f.includes(filter))
    .sort();

if (files.length === 0) {
    console.error(`no suites matched ${JSON.stringify(filter)} in ${dir}`);
    process.exit(2);
}

for (const f of files) {
    require(path.join(dir, f));
}

runAll()
    .then((results) => {
        const total = results.pass + results.fail;
        console.log(`\n${results.pass}/${total} assertions passed, ${results.fail} failed`);
        if (results.fail > 0) {
            console.log('\nfailures:');
            for (const f of results.failures) {
                console.log(`  [${f.suite}] ${f.name}`);
                console.log(`    ${String(f.error && f.error.message).split('\n').join('\n    ')}`);
            }
            process.exit(1);
        }
        process.exit(0);
    })
    .catch((e) => {
        console.error('harness crashed:', e);
        process.exit(3);
    });
