'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the home's blocks of the same kind are one pick
 * block, a row of chips picks one of them, and the parts a reader rarely needs are folds. Radio inputs and :has(),
 * no script for the chips; every block stays in the page for crawlers; a wider screen shows them all and no chips.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('the home is one pick block: a chip per block, the first picked, every block in the page', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            const block = page.slice(page.indexOf('<div class="pick" id="pick-food">'), page.indexOf('<details class="home-fold"><summary>Everything food'));
            assert.ok(block.startsWith('<div class="pick" id="pick-food">'), 'the pick block is on the home');
            assert.match(block, /<div class="pick-row" role="radiogroup" aria-label="What to eat, and what it costs">/);
            const chips = [...block.matchAll(/<input type="radio" name="pick-food" id="pk-food-([a-z]+)" value="\1"( checked)?><label for="pk-food-\1">([^<]+)<\/label>/g)];
            assert.ok(chips.length >= 6, `a chip per block (${chips.length})`);
            assert.deepStrictEqual(chips.filter((m) => m[2]).map((m) => m[1]), [chips[0][1]], 'the first block is picked');
            // Every block stays in the page, with its heading.
            for (const h of ['The most food for a dollar', 'The cheapest protein', 'Browse the food list', 'Every delivery app at once', 'Meal kits, side by side', 'Find a food bank']) {
                assert.ok(block.includes(h), `the block "${h}" is in the page`);
            }
            assert.strictEqual((block.match(/<div class="pick-pane"/g) || []).length, chips.length, 'one pane per chip');
        });

        await check('the CSS guard: the chips are hidden and the blocks all show until 640 px and where :has() is understood', async () => {
            const r = await t.get('/');
            const page = r.text;
            assert.match(page, /<style>@supports selector\(:has\(\*\)\)\{@media \(max-width:640px\)\{\.pick:has\(#pk-food-value:checked\) #pp-food-value\{display:block\}/, 'the rule that shows the picked block');
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'home.css'), 'utf8');
            assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
            assert.match(css, /@supports selector\(:has\(\*\)\) \{ @media \(max-width: 640px\) \{/, 'the phone rules are under :has() and 640 px');
            assert.match(css, /\.pick-row label \{[^}]*min-height: 44px/, 'a chip is a 44 px target');
            assert.match(css, /\.pick-pane \{ display: none; \}/, 'the blocks are hidden on a phone');
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
