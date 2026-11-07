'use strict';
/**
 * The "not on the list" gate in a real headless Chrome (openvibe-shared 4.123.0's [data-ov-share-gate]): the plan page
 * carries markup only, ov-share.js draws the gate when it loads, signed out it offers Sign in, and a signed-in person
 * who is not on the list is offered Ask for access — with no console error and no CSP refusal.
 *
 * Skipped (exit 0) without Chrome, or with OV_SKIP_BROWSER=1. The page is served by this repo's own app on a
 * temporary database, so the CSP headers the browser sees are Food's.
 */
const assert = require('assert');
const fs = require('fs');
const { boot, check, done } = require('./helpers/boot');

let playwright = null;
try { playwright = require('playwright'); } catch {
    try { playwright = require(process.env.PLAYWRIGHT_MODULE || '/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright'); } catch { playwright = null; }
}
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
if (process.env.OV_SKIP_BROWSER === '1' || !playwright || !fs.existsSync(CHROME)) {
    console.log('share-gate-chrome: skipped (no Chrome; set CHROME_BIN)');
    process.exit(0);
}

const REFUSED = /Content Security Policy|Refused to (?:load|execute|apply)|Uncaught SyntaxError/i;

(async () => {
    const t = await boot();
    const SAME = { 'sec-fetch-site': 'same-origin' };
    const ada = t.network.addUser('ada');
    const cy = t.network.addUser('cy');
    const cookieOf = (user) => {
        const [name, ...rest] = t.signIn(user).split('=');
        return { name, value: rest.join('='), url: t.base };
    };

    let browser;
    const errors = [];
    const watch = (page) => {
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', (e) => errors.push(String(e)));
    };
    const settled = async (page) => {
        await page.waitForSelector('#share-gate .ov-share-gate', { timeout: 8000 });
        return await page.$eval('#share-gate', (el) => el.textContent.replace(/\s+/g, ' ').trim());
    };

    try {
        let id;
        await check('a plan shared with Specific people, with nobody on the list yet', async () => {
            const posted = await t.get('/plan', { as: ada, method: 'POST', form: { people: '3', days: '2', title: 'Our week' }, headers: SAME });
            assert.strictEqual(posted.status, 303, posted.text);
            id = new URL(posted.headers.get('location'), t.base).searchParams.get('saved');
            assert.match(id, /^pln_[0-9A-Z]{26}$/);
            await t.ctx.sharing.setAudience(`user:${ada.subject}`, id, 'people');
        });

        await check('headless Chrome: the gate draws itself, signed out, with Sign in', async () => {
            browser = await playwright.chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            watch(page);
            const res = await page.goto(`${t.base}/plan/p/${id}`, { waitUntil: 'load', timeout: 15000 });
            assert.strictEqual(res.status(), 404, 'the gate answers 404, never the plan');
            const text = await settled(page);
            assert.ok(/Sign in/.test(text), `signed out the gate offers Sign in, got: ${text}`);
            const href = await page.$eval('#share-gate .ov-share-gate a', (a) => a.getAttribute('href'));
            assert.match(href, /^\/auth\/login\?next=/);
            await ctx.close();
        });

        await check('headless Chrome: signed in as somebody not on the list, Ask for access', async () => {
            const ctx = await browser.newContext();
            await ctx.addCookies([cookieOf(cy)]);
            const page = await ctx.newPage();
            watch(page);
            await page.goto(`${t.base}/plan/p/${id}`, { waitUntil: 'load', timeout: 15000 });
            const text = await settled(page);
            assert.ok(/Ask for access/.test(text), `a stranger is offered Ask for access, got: ${text}`);
            assert.ok(/@cy/.test(text), 'the gate names the account it is signed in as');
            await ctx.close();
        });

        await check('headless Chrome: no console error and no CSP refusal on the gate page', async () => {
            const refused = errors.filter((e) => REFUSED.test(e));
            assert.deepStrictEqual(refused, [], `the gate page was refused: ${refused.join(' | ')}`);
        });
    } finally {
        if (browser) await browser.close().catch(() => {});
        await t.close();
        done();
    }
})();
