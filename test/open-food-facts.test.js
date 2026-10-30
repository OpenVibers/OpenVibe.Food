'use strict';
/**
 * Open Food Facts (server/food/off.js): products from OpenVibe.Sources as label data beside the food list.
 *   - a product's own name maps to one of the list's foods; chips, juice and flakes do not become the food;
 *   - the pull follows the change feed from its own cursor and keeps the most complete product for a food;
 *   - a food's page shows the product's per-100 g figures with the Open Food Facts (ODbL) credit and link, beside
 *     the list's own nutrition and prices, never instead of them;
 *   - the match survives a restart because it is in food_off_products.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { rowOf, matchSlug, shape, NOTE } = require('../server/food/off');
const { createOff } = require('../server/food/off');

const item = (code, title, fields = {}, over = {}) => ({
    id: `itm_off_${code}`, source_key: 'open-food-facts', category: 'food', kind: 'food_product', identity: code,
    canonical_url: `https://world.openfoodfacts.org/product/${code}`, title, summary: null,
    fields: { brands: 'Example Brand', nutriscore_grade: 'b', ...fields },
    revision: 1, provenance: { retrieved_at: '2026-10-30T06:00:00.000Z' }, removed: null, ...over,
});

function feed(items) {
    return {
        items,
        async listItems({ after = 0, limit = 100 }) {
            const rest = items.filter((x) => x.change_seq > after).sort((a, b) => a.change_seq - b.change_seq);
            const page = rest.slice(0, limit);
            return { items: page, next_after: page.length ? page[page.length - 1].change_seq : after, more: rest.length > limit, sources: {} };
        },
    };
}

(async () => {
    const items = [
        { ...item('0000000000011', 'Large Eggs', { energy_kcal_100g: '143', proteins_100g: '12.6' }), change_seq: 1 },
        { ...item('0000000000012', 'Free Range Large Eggs', { energy_kcal_100g: '140', proteins_100g: '13', fat_100g: '9.5', carbohydrates_100g: '0.7', salt_100g: '0.3' }, { revision: 3 }), change_seq: 2 },
        { ...item('0000000000021', 'Whole Milk', { energy_kcal_100g: '64', proteins_100g: '3.3', fat_100g: '3.6', carbohydrates_100g: '4.8', sugars_100g: '4.8' }), change_seq: 3 },
        { ...item('0000000000031', 'Banana Chips', { energy_kcal_100g: '519' }), change_seq: 4 },          // a snack, not a banana
        { ...item('0000000000041', 'Potato Chips', { energy_kcal_100g: '536' }), change_seq: 5 },          // not the potato on the list
        { ...item('0000000000051', 'Apple Juice', { energy_kcal_100g: '46' }), change_seq: 6 },            // not an apple
        { ...item('0000000000061', 'Mystery Product', {}), change_seq: 7 },                                 // no figures, no match
        { ...item('0000000000071', 'Whole Milk', { proteins_100g: '3.3' }, { kind: 'record' }), change_seq: 8 },
        { ...item('0000000000081', 'Whole Milk', { proteins_100g: '3.3' }, { source_key: 'openfda-food-enforcement' }), change_seq: 9 },
    ];
    const source = feed(items);
    const t = await boot({ offSource: source });
    try {
        await check('names map to the list\'s foods, and a snack, a juice or a chip does not', async () => {
            assert.strictEqual(matchSlug('Peanut Butter, Creamy'), 'peanut-butter', 'peanut butter is not butter');
            assert.strictEqual(matchSlug('Whole Milk'), 'whole-milk');
            assert.strictEqual(matchSlug('Cheddar Cheese Block'), 'cheese-block');
            assert.strictEqual(matchSlug('Dried Pinto Beans'), 'dried-beans');
            assert.strictEqual(matchSlug('Canned Black Beans'), 'canned-beans');
            assert.strictEqual(matchSlug('Banana Chips'), null);
            assert.strictEqual(matchSlug('Potato Chips'), null);
            assert.strictEqual(matchSlug('Apple Juice'), null);
            assert.strictEqual(matchSlug('Corn Flakes'), null);
            const row = rowOf(item('0000000000021', 'Whole Milk', { energy_kcal_100g: '64', proteins_100g: '3.3' }));
            assert.deepStrictEqual([row.slug, row.product_name, row.energy_kcal_100g, row.protein_g], ['whole-milk', 'Whole Milk', 64, 3.3]);
            assert.strictEqual(rowOf(item('0000000000061', 'Mystery Product', {})), null, 'no nutrient and no Nutri-Score = nothing to show');
            assert.strictEqual(rowOf(item('abc', 'Whole Milk')), null, 'a code that is not a product code');
        });

        await check('the pull follows the feed: matches applied, everything else held', async () => {
            const out = await t.ctx.off.pull();
            assert.deepStrictEqual([out.applied, out.hold], [3, 6], 'eggs twice, milk once; the snacks and the two wrong items held');
            assert.strictEqual(Number(await t.ctx.s.db.value("SELECT cursor FROM food_ingest_cursor WHERE name = 'sources.food.off.after'")), 9);
            const eggs = t.ctx.off.forFood('eggs-dozen');
            assert.strictEqual(eggs.code, '0000000000012', 'the more complete product is the one shown');
            assert.deepStrictEqual([eggs.name, eggs.brands, eggs.nutriscore_grade], ['Free Range Large Eggs', 'Example Brand', 'B']);
            assert.deepStrictEqual([eggs.per_100g.energy_kcal, eggs.per_100g.protein_g, eggs.per_100g.salt_g], [140, 13, 0.3]);
            assert.strictEqual(t.ctx.off.forFood('canned-tuna'), null, 'a food no product matched shows none');
        });

        await check('a food\'s page shows the product with the ODbL credit, beside its own nutrition', async () => {
            const page = await t.get('/foods/eggs-dozen');
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('Open Food Facts label'));
            assert.ok(page.text.includes('Open Food Facts (ODbL)'), 'the exact credit');
            assert.ok(page.text.includes('https://world.openfoodfacts.org/product/0000000000012'), 'the product is linked');
            assert.ok(page.text.includes('Free Range Large Eggs'));
            assert.ok(page.text.includes('140 kcal') && page.text.includes('13 g'), 'the label figures');
            assert.ok(page.text.includes('Nutrition') && page.text.includes('A serving'), 'the list\'s own section is still there');
            assert.ok(page.text.includes(NOTE.split('.')[0]), 'the ODbL note');
            const tuna = await t.get('/foods/canned-tuna');
            assert.ok(!tuna.text.includes('Open Food Facts label'), 'a food with no match shows no label section');
        });

        await check('the match is durable: a new instance loads it from food_off_products', async () => {
            const again = createOff({ config: { sources: { internalUrl: '' } }, s: t.ctx.s, log: { log() {}, warn() {} } });
            assert.strictEqual(await again.load(), 2);
            assert.strictEqual(again.forFood('eggs-dozen').code, '0000000000012');
            const shapeOf = shape({ ...rowOf(item('0000000000012', 'Free Range Large Eggs', { energy_kcal_100g: '140' })), retrieved_at: '2026-10-30T06:00:00.000Z' });
            assert.strictEqual(shapeOf.license_url, 'https://opendatacommons.org/licenses/odbl/1-0/');
        });

        await check('a removed product is deleted; an older revision never wins', async () => {
            source.items.push({ ...item('0000000000021', 'Whole Milk', {}, { id: 'itm_off_0000000000021', removed: { at: '2026-10-30T07:00:00.000Z', reason: 'licence' }, revision: 2 }), change_seq: 10 });
            source.items.push({ ...item('0000000000012', 'Free Range Large Eggs', { energy_kcal_100g: '1' }, { id: 'itm_off_0000000000012', revision: 1 }), change_seq: 11 });
            const out = await t.ctx.off.pull();
            assert.strictEqual(out.removed, 1);
            assert.strictEqual(t.ctx.off.forFood('whole-milk'), null);
            assert.strictEqual(t.ctx.off.forFood('eggs-dozen').per_100g.energy_kcal, 140, 'the older revision did not overwrite the label');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
