'use strict';
/**
 * The food list and its pages: the API hands out the nutrition and the price band, /foods and /foods/:slug render
 * them server-side, and the sitemap and llms-full.txt carry every food page. The per-100 g figure is arithmetic on
 * the pack size in the item's own name, so a pack that states no weight says so instead of guessing.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const foods = require('../server/food/foods');

(async () => {
    const t = await boot();
    try {
        await check('the food list: every group, real nutrition, a typical price band and no invented numbers', async () => {
            const r = await t.get('/api/v1/foods');
            assert.strictEqual(r.status, 200, r.text);
            const b = r.json();
            assert.ok(b.count >= 40, `only ${b.count} foods`);
            assert.strictEqual(b.groups.length, 6);
            assert.deepStrictEqual(b.groups.map((g) => g.group).sort(), ['dairy', 'fats', 'fruits', 'grains', 'protein', 'vegetables']);
            for (const f of b.foods) {
                assert.ok(f.name && f.group && f.serving_size, JSON.stringify(f));
                assert.ok(f.nutrition_per_serving.kcal >= 0 && f.nutrition_per_serving.protein_g >= 0);
                assert.ok(f.price > 0 && f.price_max >= f.price, `${f.slug} price`);
                assert.ok(['low', 'medium', 'higher', 'high'].includes(f.price_band));
                assert.strictEqual(f.url, `/foods/${f.slug}`);
                // per 100 g is there exactly when the pack size in the name is a weight
                assert.strictEqual(f.nutrition_per_100g != null, foods.packGrams(f.name) != null, `${f.slug} per-100 g`);
            }
            assert.strictEqual(b.source.name, 'OpenVibe.Tools grocery dataset', 'the provenance is stated');
            assert.strictEqual(b.foods.find((f) => f.slug === 'canned-tuna').nutrition_per_100g.kcal, 106);
            assert.strictEqual(b.foods.find((f) => f.slug === 'eggs-dozen').nutrition_per_100g, null, 'a dozen eggs states no weight');
        });

        await check('filtering by group and by word; an unknown group is refused', async () => {
            const protein = (await t.get('/api/v1/foods?group=protein')).json();
            assert.ok(protein.count > 0 && protein.foods.every((f) => f.group === 'protein'));
            const oats = (await t.get('/api/v1/foods?q=oats')).json();
            assert.deepStrictEqual(oats.foods.map((f) => f.slug), ['oatmeal']);
            const bad = await t.get('/api/v1/foods?group=pizza');
            assert.strictEqual(bad.status, 422);
            assert.strictEqual(bad.json().code, 'food.food.invalid');
        });

        await check('one food by slug, and a 404 with a stable code for one that is not in the list', async () => {
            const r = await t.get('/api/v1/foods/canned-tuna');
            assert.strictEqual(r.status, 200);
            const f = r.json().food;
            assert.strictEqual(f.name, 'Canned Tuna (5 oz)');
            assert.strictEqual(f.prices[0].store_name, 'Grocery Outlet', 'the cheapest chain first');
            assert.ok(f.prices.length >= 4);
            const missing = await t.get('/api/v1/foods/caviar');
            assert.strictEqual(missing.status, 404);
            assert.strictEqual(missing.json().code, 'food.food.not_found');
        });

        await check('the /foods page and one food page render server-side, per serving and per 100 g', async () => {
            const list = await t.get('/foods');
            assert.strictEqual(list.status, 200);
            assert.match(list.headers.get('content-type'), /^text\/html/);
            assert.ok(list.text.includes('href="/foods/eggs-dozen"'), 'the list links to a food page');
            assert.ok(list.text.includes('Protein'), 'the groups are shown');
            assert.match(list.text, /<meta name="robots" content="index, follow">/);

            const one = await t.get('/foods/canned-tuna');
            assert.strictEqual(one.status, 200);
            assert.ok(one.text.includes('Canned Tuna (5 oz)'));
            assert.ok(one.text.includes('Per 100 g'));
            assert.ok(one.text.includes('106 kcal'), 'the per-100 g energy is rendered');
            assert.ok(/Grocery Outlet/.test(one.text), 'the price table by chain');
            assert.ok(one.text.includes('Not a live price') || one.text.includes('not a live price'));

            const bad = await t.get('/foods/caviar');
            assert.strictEqual(bad.status, 404);
            assert.match(bad.text, /No such food/);
        });

        await check('the sitemap and llms-full.txt carry every food page', async () => {
            const sitemap = (await t.get('/sitemap.xml')).text;
            for (const slug of ['eggs-dozen', 'canned-tuna', 'white-rice']) {
                assert.ok(sitemap.includes(`<loc>https://openvibe.food/foods/${slug}</loc>`), `no /foods/${slug} in the sitemap`);
            }
            assert.ok(sitemap.includes('<loc>https://openvibe.food/near</loc>'));
            assert.ok(!sitemap.includes('/pantry'), 'a personal page is never in the sitemap');
            const full = (await t.get('/llms-full.txt')).text;
            assert.ok(full.includes('https://openvibe.food/foods/canned-tuna'), 'the food page is in llms-full.txt');
            assert.ok(!full.includes('(truncated:'), 'llms-full.txt holds every page');
        });

        await check('the home page offers the search box and the three ways in', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('action="/near"'), 'the search form posts to /near');
            assert.ok(r.text.includes('name="q"'));
            for (const href of ['/near', '/plan', '/foods', '/pantry']) assert.ok(r.text.includes(`href="${href}"`), `no link to ${href}`);
        });
    } finally { await t.close(); }
    done();
})();
