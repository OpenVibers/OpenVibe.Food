'use strict';
/**
 * USDA ERS prices (server/food/usda-prices.js): the Economic Research Service's annual fruit and vegetable prices from
 * OpenVibe.Sources.
 *   - a usda-ers-fruit-vegetable-prices item for a mapped product and form becomes one row; another identity, unit,
 *     kind or source is held;
 *   - the pull follows the change feed from its own cursor (BLS and the recalls keep theirs), a removed item is
 *     deleted, an older revision never wins;
 *   - a food's page shows the figure beside the BLS one with its data year and the ERS note; a food ERS does not price
 *     shows none.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const foods = require('../server/food/foods');
const { rowOf, shape, PRODUCTS, VINTAGE } = require('../server/food/usda-prices');

const usdaItem = (identity, value, n, over = {}) => ({
    id: `itm_u${n}`, source_key: 'usda-ers-fruit-vegetable-prices', category: 'food', kind: 'price', identity,
    canonical_url: null, title: identity.split(' | ')[0], summary: null,
    fields: { name: identity.split(' | ')[0], form: identity.split(' | ')[1], price: String(value), unit: 'per pound' },
    revision: 1, provenance: { retrieved_at: '2026-11-05T06:00:00.000Z' }, removed: null, change_seq: n, ...over,
});

const blsItem = (series, value, n) => ({
    id: 'itm_b1', source_key: 'bls-average-prices', category: 'food', kind: 'price', identity: series, canonical_url: null,
    title: series, summary: null, fields: { value: String(value), year: '2026', period: 'M09' }, revision: 1,
    provenance: { retrieved_at: '2026-11-05T06:00:00.000Z' }, removed: null, change_seq: n,
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
    const usda = feed([
        usdaItem('Apples | Fresh', 1.86093095, 1),
        usdaItem('Bananas | Fresh', 0.609594742, 2),
        usdaItem('Strawberries | Fresh', 3.078734363, 3),
        usdaItem('Avocados | Fresh', 2.262402684, 4),
        usdaItem('Kale | Fresh', 3.57, 5),                                  // a row Food does not map
        { ...usdaItem('Oranges | Fresh', 1.44, 6), source_key: 'bls-average-prices' },   // another source
    ]);
    const bls = feed([blsItem('APU0000711211', 0.633, 1)]);
    const t = await boot({ priceSource: bls, usdaPriceSource: usda });
    try {
        await check('every mapped identity prices a food on the list; a row is the item as ERS states it', async () => {
            for (const [identity, def] of Object.entries(PRODUCTS)) assert.ok(foods.getFood(def.slug), `${identity} → ${def.slug}`);
            const row = rowOf(usdaItem('Apples | Fresh', 1.86093095, 1));
            assert.deepStrictEqual([row.identity, row.value, row.unit, row.vintage], ['Apples | Fresh', 1.8609, 'lb', VINTAGE]);
            assert.strictEqual(rowOf(usdaItem('Kale | Fresh', 3.57, 1)), null, 'a row nobody maps');
            assert.strictEqual(rowOf(usdaItem('Apples | Fresh', 1.86, 1, { fields: { name: 'Apples', form: 'Fresh', price: '1.86', unit: 'per pint' } })), null, 'per pint would make the pack arithmetic wrong');
            assert.strictEqual(rowOf(usdaItem('Apples | Fresh', -1, 1)), null);
            const apples = shape({ identity: 'Apples | Fresh', value: '1.8609', unit: 'lb', vintage: '2023' });
            assert.deepStrictEqual([apples.slug, apples.item, apples.form, apples.pack_price, apples.year], ['apples-3lb', 'apples', 'fresh', 5.58, '2023'], 'a 3 lb bag');
            assert.strictEqual(shape({ identity: 'Strawberries | Fresh', value: '3.0787', unit: 'lb', vintage: '2023' }).pack_price, 3.08, 'a 1 lb pack');
            assert.strictEqual(shape({ identity: 'Grapes (raisins) | Dried', value: '4.3283', unit: 'lb', vintage: '2023' }).pack_price, 1.62, 'a 6 oz box is 0.375 lb');
            assert.strictEqual(shape({ identity: 'Avocados | Fresh', value: '2.2624', unit: 'lb', vintage: '2023' }).pack_price, null, 'a pack that states no weight gets no pack price');
        });

        await check('the pull follows its own cursor; anything else is held; BLS keeps its own cursor', async () => {
            assert.strictEqual((await t.get('/foods/apples-3lb')).text.includes('USDA average price'), false, 'nothing before the first pull');
            const out = await t.ctx.usdaPrices.pull();
            assert.deepStrictEqual([out.applied, out.hold], [4, 2]);
            assert.strictEqual(Number(await t.ctx.s.db.value("SELECT cursor FROM food_ingest_cursor WHERE name = 'sources.food.usda.after'")), 6);
            assert.strictEqual(await t.ctx.s.db.value("SELECT cursor FROM food_ingest_cursor WHERE name = 'sources.food.prices.after'"), null, 'the BLS cursor is theirs');
            assert.deepStrictEqual([t.ctx.usdaPrices.forFood('apples-3lb').value, t.ctx.usdaPrices.forFood('apples-3lb').year], [1.8609, '2023']);
            assert.strictEqual(t.ctx.usdaPrices.forFood('white-rice'), null, 'a food ERS does not price');
            const blsOut = await t.ctx.officialPrices.pull();
            assert.strictEqual(blsOut.applied, 1);
            assert.strictEqual(Number(await t.ctx.s.db.value("SELECT cursor FROM food_ingest_cursor WHERE name = 'sources.food.prices.after'")), 1);
            assert.strictEqual(Number(await t.ctx.s.db.value("SELECT cursor FROM food_ingest_cursor WHERE name = 'sources.food.usda.after'")), 6);
        });

        await check('a new value replaces the old; an older revision arriving late and a removed item behave', async () => {
            usda.items.push(usdaItem('Apples | Fresh', 2.0, 7, { id: 'itm_u1', revision: 3 }));      // the same Sources item, a new value
            usda.items.push(usdaItem('Apples | Fresh', 9.99, 8, { id: 'itm_u1', revision: 2 }));     // a replayed older revision
            usda.items.push({ ...usdaItem('Strawberries | Fresh', 3.0787, 9), id: 'itm_u3', removed: { at: '2026-11-05T07:00:00.000Z', reason: 'replaced' }, revision: 2 });
            const out = await t.ctx.usdaPrices.pull();
            assert.strictEqual(out.removed, 1);
            assert.strictEqual(t.ctx.usdaPrices.forFood('apples-3lb').value, 2);
            assert.strictEqual(t.ctx.usdaPrices.forFood('strawberries'), null);
        });

        await check('a food\'s page shows the USDA figure with its data year and the ERS note beside BLS', async () => {
            const apples = await t.get('/foods/apples-3lb');
            assert.strictEqual(apples.status, 200);
            assert.ok(apples.text.includes('USDA average price'));
            assert.ok(apples.text.includes('$6.00</b> for this pack at the USDA ERS national average for 2023: $2.00 per lb of apples (fresh)'), apples.text.slice(apples.text.indexOf('USDA average'), apples.text.indexOf('USDA average') + 400));
            assert.ok(apples.text.includes('https://www.ers.usda.gov/data-products/fruit-and-vegetable-prices/'));
            assert.ok(apples.text.includes('a snapshot of one year, not a price trend'), 'ERS: no inference about change over time');
            assert.ok(!/Circana/.test(apples.text), 'ERS: the findings are not attributed to Circana (the page never names it)');
            assert.ok(!apples.text.includes('US average price'), 'BLS prices no apples');
            const bananas = await t.get('/foods/bananas');
            assert.ok(bananas.text.includes('US average price'), 'BLS on the same page');
            assert.ok(bananas.text.includes('September 2026'), 'BLS month');
            assert.ok(bananas.text.includes('USDA average price'));
            assert.ok(bananas.text.includes('for 2023'), 'USDA data year');
            assert.ok(bananas.text.includes('per lb of bananas (fresh)'));
            const avocado = await t.get('/foods/avocado');
            assert.ok(avocado.text.includes('$2.26</b> per lb of avocados (fresh)'), 'no pack weight, so no pack price');
            assert.ok(!avocado.text.includes('for this pack at the USDA'), 'no invented pack weight');
            const tuna = await t.get('/foods/canned-tuna');
            assert.ok(!tuna.text.includes('USDA average price'));
            assert.ok(!tuna.text.includes('US average price'));
        });
    } finally {
        await t.close();
    }
    done();
})();
