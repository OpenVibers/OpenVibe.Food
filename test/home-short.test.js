'use strict';
/**
 * The home on a phone (the owner's rule, 2026-10-31: never hide content to shorten): the home's blocks of the same
 * kind are one pick block, every block is shown, stacked, with its own heading, and the chips are a row of links that
 * jump to a block. The parts a reader rarely needs are folds.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('the home is one pick block: a link per block, every block in the page and showing', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            const block = page.slice(page.indexOf('<div class="pick" id="pick-food">'), page.indexOf('<details class="home-fold"><summary>Everything food'));
            assert.ok(block.startsWith('<div class="pick" id="pick-food">'), 'the pick block is on the home');
            assert.ok(/<input type=\"radio\" class=\"ov-parts-r\"[^>]* checked>/.test(block), 'the first part is open on a phone (Shared pick(): tabs, 11-12)');
            assert.match(block, /<div class=\"ov-parts ov-parts--front\" data-parts=\"\d+\">/, 'its parts are tabs on a phone');
            const chips = [...block.matchAll(/<label for="ovp-[a-z0-9]+-(pp-food-[a-z]+)">[^<]+(?: <span class="ov-parts-n">[^<]*<\/span>)?<\/label>/g)];
            assert.ok(chips.length >= 6, `a link per block (${chips.length})`);
            // Every block stays in the page, with its heading, and every link points at one of them.
            for (const h of ['The most food for a dollar', 'The cheapest protein', 'Browse the food list', 'Every delivery app at once', 'Meal kits, side by side', 'Find a food bank']) {
                assert.ok(block.includes(h), `the block "${h}" is in the page`);
            }
            const panes = [...block.matchAll(/<div class="pick-pane" id="(pp-food-[a-z]+)">/g)].map((m) => m[1]);
            assert.strictEqual(panes.length, chips.length, 'one pane per link');
            assert.deepStrictEqual(panes, chips.map((m) => m[1]), 'every link points at a pane in the page');
        });

        await check('the CSS shows every pane on a phone; the chips are links, not a picker', async () => {
            const r = await t.get('/');
            const page = r.text;
            assert.ok(!page.includes('.pick:has('), 'no inline rule picks a block');
            assert.ok(!page.includes('pk-food'), 'no radio ids on the page');
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'home.css'), 'utf8');
            assert.match(css, /\.pick-head, \.pick-row \{ display: none; \}/, 'the chips are hidden by default');
            assert.match(css, /@media \(max-width: 640px\) \{/, 'the phone rules are under 640 px');
            assert.match(css, /\.pick-row \{ display: flex/, 'the chips are a row on a phone');
            assert.match(css, /\.pick-chip \{[^}]*min-height: 44px/, 'a chip is a 44 px link target');
            assert.ok(!/\.pick[^{}]*\.pick-pane[^{}]*\{[^}]*display:\s*none/.test(css), 'no rule hides a pane');
            assert.ok(!/\.pick[^{}]*:target/.test(css), 'no :target pane rule');
            assert.ok(!/\.pick[^{}]*\.pick-pane[^{}]*h2[^{}]*\{[^}]*display:\s*none/.test(css), 'a pane keeps its heading on a phone');
        });

        await check('the parts a reader rarely needs are folds, open in the page and closed on a phone', async () => {
            const r = await t.get('/');
            const page = r.text;
            for (const id of ['faq', 'network', 'shipped']) {
                assert.ok(page.includes(`<details class="home-fold home-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
                assert.ok(page.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
            }
            // The content of the folds stays in the page.
            assert.match(page, /<h2 id="h-faq">Questions people ask<\/h2>/);
            assert.match(page, /<h2 id="h-network">Part of OpenVibe<\/h2>/);
            assert.match(page, /One account across every OpenVibe site/, 'the other OpenVibe places are still in the page');
        });
    } finally {
        await done(t);
    }
})().catch((e) => { console.error(e); process.exit(1); });
