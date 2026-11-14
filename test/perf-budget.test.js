'use strict';
// Size budgets for openvibe.food's home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the
// server as it runs (a fresh database), measured without a browser. Budgets sit about 10% above the
// 2026-10-08 measurement (see below); raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

// Budgets are set from the numbers measured on 2026-10-08 (the real ones, fresh database), rounded up with about 10%
// headroom; file counts are the measured counts and external files stay at 0.
// 2026-11-08: openvibe-shared v4.152.0; CI measured JS 356.6 KB raw / 85.0 KB brotli.
// 2026-11-08: openvibe-shared v4.150.0; CI measured JS 353.9 KB raw / 84.4 KB brotli.
// 2026-11-08: openvibe-shared v4.149.0; CI measured JS 352.9 KB raw / 84.2 KB brotli.
const BUDGETS = {
    // Raised 2026-10-22 for the curated home (the owner's "rich content on the home page"): the most food for a dollar,
    // the cheapest protein, the food groups, every delivery app with a search, the meal kits, food banks by city, the
    // questions, ItemList + FAQPage JSON-LD, and css/home.css. Measured 43.3/9.8 KB HTML (empty library) and 22.2/5.3 KB CSS.
    htmlRawKB: 64, // 64 openvibe-shared v4.228.0 (2026-11-12: the phone tabs, ov-parts.css; budgets grow for a feature); 62.5 openvibe-shared v4.202.0 (2026-11-11: measured 62.1, raised by pin-bump from 60.5); 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 56.1 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 54.1 with the home's pick block (the owner's short-pages rule, 2026-10-30: the chips and the blocks' wrappers); 49.2 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 43.3 on 2026-10-22; measured 28.7 with plan together as the sixth feature (2026-10-15); 27.6 with Shared 4.1.0's manifest + apple-touch-icon links (24.9 before; the home page: hero, features, steps, cta, JSON-LD)
    htmlBrotliKB: 13.5, // 13.5 openvibe-shared v4.202.0 (2026-11-11: measured 13.1, raised by pin-bump from 13); 11.1 Shared 4.15.1 footer; 9.8 on 2026-10-22; 7.0 (6.2 before 4.1.0)
    jsFiles: 5,   // 5 (theme-loader, web-runtime, navbar, footer, boost: openvibe-shared/shell)
    jsRawKB: 394.5, // 394.5: measured 394.1 with openvibe-shared 4.197.0 (2026-11-10: the menu's row of places, the You tab's row, the Sign in mark, the tooltip); 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 376.4: measured 376.3 KB raw with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 375.1: measured 367.1 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsBrotliKB: 94, // 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 89.8: measured 89.7 KB brotli with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 89.5: measured 87.5 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssFiles: 4,   // 4 openvibe-shared v4.228.0 (2026-11-12: the phone tabs, ov-parts.css; budgets grow for a feature); 3 (app.css, the cached /shared/showcase.css and css/home.css)
    // 16.4 since the product's own pages brought their stylesheet with them (the search and plan forms, the place
    // cards, the pantry's tick list); app.css itself stayed within a few lines.
    cssRawKB: 67.5, // 67.5 openvibe-shared v4.248.0 (2026-11-14: measured 67.1, raised by pin-bump from 65); 65 openvibe-shared v4.228.0 (2026-11-12: the phone tabs, ov-parts.css; budgets grow for a feature); 55.5 openvibe-shared v4.228.0 (2026-11-12: measured 55.4, raised by pin-bump from 51.5); 51.5: measured 46.5 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssBrotliKB: 12, // 12 openvibe-shared v4.248.0 (2026-11-14: measured 11.8, raised by pin-bump from 11.5); 11.5 openvibe-shared v4.228.0 (2026-11-12: the phone tabs, ov-parts.css; budgets grow for a feature); 9.9 with 2026-11-01: phone table cards (2026-11-01); 8.9 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 8.6 with 11 touch targets (2026-10-29: the chips and the food search's fields at 44 px); 8.2 the home's phone limits and fold (2026-10-29); 6.4 with Shared 4.13.0 (2026-10-26: account links); 5.3 with css/home.css; 4.3 with the hero search panel
    externalFiles: 0,   // 0
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    // A database of its own (not the shared dev PGlite in data/pglite, and not whatever the caller's
    // DATABASE_URL names), so the measurement is the server on a fresh database and the run leaves nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-budget-'));
    const pgliteDir = path.join(dir, 'pglite');
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
            DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '', FOOD_PGLITE_DIR: pgliteDir,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 600 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        assert.ok(fs.existsSync(pgliteDir), 'the server did not use the isolated database (FOOD_PGLITE_DIR)');
        const m = await measure({ base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
