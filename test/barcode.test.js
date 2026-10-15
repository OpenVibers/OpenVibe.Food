'use strict';
/**
 * Pantry by barcode (server/food/barcode.js, GET /pantry/barcode, POST /pantry/items):
 *   - only real product barcodes (8, 12, 13 or 14 digits with a valid GS1 check digit) are looked up;
 *   - Open Food Facts gets the barcode alone, with Food's own User-Agent, and an answer is cached;
 *   - a product is matched to the item on Food's list it is, not to what is made from it (peanut butter is not butter,
 *     apple juice is not apples), and an unknown one matches nothing;
 *   - the page asks before adding, with the match preselected; adding needs a signed-in person on Food's own page.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { normalize, matchFood, createBarcodes } = require('../server/food/barcode');

const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    await check('barcodes: lengths and the check digit', () => {
        assert.strictEqual(normalize('0 41250 00237 3'), null, 'a wrong check digit');
        assert.strictEqual(normalize('4006381333931'), '4006381333931', 'EAN-13');
        assert.strictEqual(normalize('036000291452'), '036000291452', 'UPC-A');
        assert.strictEqual(normalize('96385074'), '96385074', 'EAN-8');
        for (const bad of ['', '123', 'abcdefghijkl', '12345678901', '4006381333932', null]) assert.strictEqual(normalize(bad), null, String(bad));
    });

    await check('a product matches the item it is, never what is made from it', () => {
        const m = (name, cats = []) => matchFood({ product_name: name, categories_tags: cats });
        assert.strictEqual(m('Creamy Peanut Butter'), 'peanut-butter');
        assert.strictEqual(m('Salted Butter'), 'butter');
        assert.strictEqual(m('Large Grade A Eggs'), 'eggs-dozen');
        assert.strictEqual(m('Organic Whole Milk'), 'whole-milk');
        assert.strictEqual(m('Chunk Light Tuna in Water'), 'canned-tuna');
        assert.strictEqual(m('Original Ramen Noodle Soup', ['en:instant-noodles']), 'ramen-12pk', 'ramen sold as noodle soup is ramen');
        assert.strictEqual(m('Chicken Noodle Soup'), 'canned-soup');
        assert.strictEqual(m('Black Beans', ['en:canned-foods']), 'canned-beans');
        assert.strictEqual(m('Cut Green Beans'), 'canned-green-beans');
        assert.strictEqual(m('Apple Juice'), null, 'juice is not apples');
        assert.strictEqual(m('Strawberry Jam'), null);
        assert.strictEqual(m('Gala Apples'), 'apples-3lb');
        assert.strictEqual(m('Long Grain Enriched Rice'), 'white-rice');
        assert.strictEqual(m('Sparkling Water'), null);
        assert.strictEqual(matchFood({ product_name: '', categories_tags: ['en:peanut-butters'] }), 'peanut-butter', 'from the categories alone');
    });

    await check('the lookup sends the barcode alone, with Food\'s User-Agent, and caches the answer', async () => {
        const calls = [];
        const fetchImpl = async (url, o) => {
            calls.push({ url, ua: o.headers['User-Agent'] });
            return { status: 200, json: async () => ({ status: 1, product: { product_name: 'Creamy Peanut Butter', brands: 'Acme, Acme Foods', quantity: '16 oz', categories_tags: ['en:spreads'] } }) };
        };
        const b = createBarcodes({ config: { barcode: { userAgent: 'OpenVibeFood/0.1 (+https://openvibe.food; Contact@OpenVibe.Network)', perMinute: 60 } }, fetchImpl });
        const r = await b.lookup('4006381333931');
        assert.deepStrictEqual(r, { code: '4006381333931', found: true, name: 'Creamy Peanut Butter', brand: 'Acme', quantity: '16 oz', match: 'peanut-butter', url: 'https://world.openfoodfacts.org/product/4006381333931' });
        await b.lookup('4006381333931');
        assert.strictEqual(calls.length, 1, 'cached');
        assert.match(calls[0].url, /^https:\/\/world\.openfoodfacts\.org\/api\/v2\/product\/4006381333931\.json\?fields=/);
        assert.match(calls[0].ua, /^OpenVibeFood\/.*Contact@OpenVibe\.Network/);
        await assert.rejects(b.lookup('12345'), (e) => e.code === 'food.barcode.invalid');
    });

    const products = {
        '4006381333931': { status: 1, product: { product_name: 'Large Grade A Eggs', brands: 'Farm', quantity: '12' } },
        '036000291452': { status: 0 },
    };
    const barcodes = createBarcodes({
        config: { barcode: { userAgent: 'test', perMinute: 60 } },
        fetchImpl: async (url) => { const code = url.match(/product\/(\d+)\.json/)[1]; return { status: products[code] && products[code].status ? 200 : 404, json: async () => products[code] || { status: 0 } }; },
    });
    const t = await boot({ barcodes });
    const kim = t.network.addUser('kim');
    try {
        await check('the page asks before adding, with the match preselected; adding needs a signed-in person on Food', async () => {
            const anon = await t.get('/pantry/barcode?code=4006381333931');
            assert.strictEqual(anon.status, 303);
            const page = await t.get('/pantry/barcode?code=4006381333931', { as: kim });
            assert.strictEqual(page.status, 200, page.text.slice(0, 200));
            assert.ok(page.text.includes('Large Grade A Eggs'));
            assert.ok(page.text.includes('<option value="eggs-dozen" selected>'), 'the match is preselected');
            assert.ok(page.text.includes('Open Food Facts'));
            const unknown = await t.get('/pantry/barcode?code=036000291452', { as: kim });
            assert.ok(unknown.text.includes('does not know barcode 036000291452'));
            const bad = await t.get('/pantry/barcode?code=123', { as: kim });
            assert.ok(bad.text.includes('not a product barcode'));

            const cross = await t.get('/pantry/items', { form: { item: 'eggs-dozen' }, method: 'POST', as: kim, headers: { 'sec-fetch-site': 'cross-site' } });
            assert.strictEqual(cross.status, 403);
            const add = await t.get('/pantry/items', { form: { item: 'eggs-dozen' }, method: 'POST', as: kim, headers: SAME });
            assert.strictEqual(add.status, 303);
            assert.strictEqual(add.headers.get('location'), '/pantry?added=eggs-dozen');
            assert.deepStrictEqual((await t.get('/api/v1/pantry', { as: kim })).json().items, ['eggs-dozen']);
            await t.get('/pantry/items', { form: { item: 'eggs-dozen' }, method: 'POST', as: kim, headers: SAME });
            assert.deepStrictEqual((await t.get('/api/v1/pantry', { as: kim })).json().items, ['eggs-dozen'], 'twice is once');
            const nope = await t.get('/pantry/items', { form: { item: 'unicorn-steak' }, method: 'POST', as: kim, headers: SAME });
            assert.strictEqual(nope.headers.get('location'), '/pantry');
            const pantry = await t.get('/pantry?added=eggs-dozen', { as: kim });
            assert.ok(pantry.text.includes('Added <b>Large Eggs (1 dozen)</b> to your cupboard.'));
            assert.ok(pantry.text.includes('action="/pantry/barcode"') && pantry.text.includes('js/barcode-scan.js'));
        });
    } finally { await t.close(); }
    done();
})();
