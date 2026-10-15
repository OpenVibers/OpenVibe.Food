'use strict';
/**
 * Delivery and meal kits, compared (server/food/delivery.js, /delivery): one query opens every delivery app's own
 * search (the URL forms checked in a real browser on 2026-10-15), encoded and bounded; the page lists the meal kits
 * by tier with their plans pages and a Watch link; Food never fetches the apps; the home and the navbar link it.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const delivery = require('../server/food/delivery');

(async () => {
    await check('one query, every app\'s own search, encoded; nothing for an empty query', () => {
        const links = delivery.linksFor('  pad thai & spring rolls ');
        assert.deepStrictEqual(links.map((l) => l.id), ['doordash', 'ubereats', 'grubhub', 'seamless', 'caviar', 'instacart']);
        const u = Object.fromEntries(links.map((l) => [l.id, l.url]));
        assert.strictEqual(u.doordash, 'https://www.doordash.com/search/store/pad%20thai%20%26%20spring%20rolls/');
        assert.strictEqual(u.ubereats, 'https://www.ubereats.com/search?q=pad%20thai%20%26%20spring%20rolls');
        assert.strictEqual(u.grubhub, 'https://www.grubhub.com/search?queryText=pad%20thai%20%26%20spring%20rolls');
        assert.strictEqual(u.instacart, 'https://www.instacart.com/store/s?k=pad%20thai%20%26%20spring%20rolls');
        assert.deepStrictEqual(delivery.linksFor('   '), []);
        assert.strictEqual(delivery.cleanQuery('x'.repeat(300)).length, 120);
        assert.ok(links.every((l) => /^https:\/\//.test(l.url) && l.best));
        assert.ok(delivery.KITS.every((k) => /^https:\/\//.test(k.plans) && delivery.TIER_TEXT[k.tier]));
    });

    const t = await boot();
    try {
        await check('/delivery: the apps for a query, in new tabs, the kits by tier, and a Watch link per kit', async () => {
            const r = await t.get('/delivery?q=pad+thai');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('href="https://www.doordash.com/search/store/pad%20thai/" target="_blank" rel="noopener nofollow"'));
            assert.ok(r.text.includes('noindex'), 'a search result is not indexed');
            assert.ok(r.text.includes('EveryPlate') && r.text.includes('Factor') && r.text.includes('Budget'));
            assert.ok(r.text.includes('https://openvibe.watch/watches/new?template=page&amp;url=https%3A%2F%2Fwww.hellofresh.com%2Fplans'));
            const blank = await t.get('/delivery');
            assert.ok(blank.status === 200 && !blank.text.includes('doordash.com/search') && !blank.text.includes('noindex'));
            const home = await t.get('/');
            assert.ok(home.text.includes('href="/delivery"') && home.text.includes('Delivery, compared'));
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
