'use strict';
/**
 * Official prices (server/food/official-prices.js): BLS's US city average prices from OpenVibe.Sources.
 *   - a bls-average-prices item for a series on the list becomes one row; another series, kind or source is held;
 *   - the pull follows the change feed from its own cursor (the recalls keep theirs), a removed item is deleted, an
 *     older revision never wins;
 *   - a food's page shows the figure, its month, the price worked out for its pack and BLS's note; a food BLS does not
 *     price shows none.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const foods = require('../server/food/foods');
const { rowOf, shape, SERIES } = require('../server/food/official-prices');

const item = (series, n, over = {}, fields = {}) => ({
    id: `itm_p${n}`, source_key: 'bls-average-prices', category: 'food', kind: 'price', identity: series, canonical_url: null, title: series, summary: null,
    fields: { value: '2.272', year: '2026', period: 'M09', ...fields },
    revision: 1, provenance: { retrieved_at: '2026-10-24T06:00:00.000Z' }, removed: null, change_seq: n, ...over,
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
        item('APU0000708111', 1),
        item('APU0000702111', 2, {}, { value: '1.830' }),
        item('APU0000711415', 3, {}, { value: '2.840' }),
        item('APU0000799999', 4),                                         // a series the list does not price
        { ...item('APU0000709112', 5), kind: 'record' },                  // another kind
        { ...item('APU0000709112', 6), source_key: 'openfda-food-enforcement' },
    ];
    const source = feed(items);
    const t = await boot({ priceSource: source });
    try {
        await check('every series prices a food on the list; a row is the item as BLS states it', async () => {
            for (const [series, def] of Object.entries(SERIES)) assert.ok(foods.getFood(def.slug), `${series} → ${def.slug}`);
            const row = rowOf(item('APU0000708111', 1));
            assert.deepStrictEqual([row.series_id, row.value, row.year, row.period], ['APU0000708111', 2.272, 2026, 'M09']);
            assert.strictEqual(rowOf(item('APU0000799999', 1)), null, 'a series nobody maps');
            assert.strictEqual(rowOf(item('APU0000708111', 1, {}, { value: '-1' })), null);
            assert.strictEqual(rowOf(item('APU0000708111', 1, {}, { period: 'M13' })), null, 'M13 is BLS\'s annual average, not a month');
            const bread = shape({ series_id: 'APU0000702111', value: '1.830', year: 2026, period: 'M09' });
            assert.deepStrictEqual([bread.slug, bread.month, bread.pack_price, bread.unit], ['bread-white', 'September 2026', 2.29, 'lb'], 'a 20 oz loaf is 1.25 lb');
            assert.strictEqual(shape({ series_id: 'APU0000711415', value: '2.840', year: 2026, period: 'M09' }).pack_price, 3.79, 'strawberries: 12 oz → 1 lb');
        });

        await check('the pull follows the feed on its own cursor; anything else is held', async () => {
            assert.strictEqual((await t.get('/foods/eggs-dozen')).text.includes('US average price'), false, 'nothing before the first pull');
            const out = await t.ctx.officialPrices.pull();
            assert.deepStrictEqual([out.applied, out.hold], [3, 3]);
            assert.strictEqual(Number(await t.ctx.s.db.value("SELECT cursor FROM food_ingest_cursor WHERE name = 'sources.food.prices.after'")), 6);
            assert.strictEqual(await t.ctx.s.db.value("SELECT cursor FROM food_ingest_cursor WHERE name = 'sources.food.after'"), null, 'the recalls\' cursor is theirs');
            assert.strictEqual(t.ctx.officialPrices.forFood('eggs-dozen').value, 2.272);
        });

        await check('a new month replaces the old; an older revision arriving late and a removed item behave', async () => {
            source.items.push(item('APU0000708111', 7, { id: 'itm_p1', revision: 3 }, { value: '2.301', period: 'M10' }));   // the same Sources item, a new month
            source.items.push(item('APU0000708111', 8, { id: 'itm_p1', revision: 2 }, { value: '9.999', period: 'M08' }));   // a replayed older revision
            source.items.push({ ...item('APU0000711415', 9), id: 'itm_p3', removed: { at: '2026-10-24T07:00:00.000Z', reason: 'licence' }, revision: 2 });
            const out = await t.ctx.officialPrices.pull();
            assert.strictEqual(out.removed, 1);
            const eggs = t.ctx.officialPrices.forFood('eggs-dozen');
            assert.deepStrictEqual([eggs.value, eggs.month], [2.301, 'October 2026']);
            assert.strictEqual(t.ctx.officialPrices.forFood('strawberries'), null);
        });

        await check('a food\'s page shows the BLS figure for its pack with the note; one BLS does not price shows none', async () => {
            const bread = await t.get('/foods/bread-white');
            assert.strictEqual(bread.status, 200);
            assert.ok(bread.text.includes('US average price'));
            assert.ok(bread.text.includes('$2.29</b> for this pack at the US city average for September 2026: $1.83 per lb'), bread.text.slice(bread.text.indexOf('US average'), bread.text.indexOf('US average') + 300));
            assert.ok(bread.text.includes('https://data.bls.gov/timeseries/APU0000702111'));
            assert.ok(bread.text.includes('BLS.gov cannot vouch for the data'));
            const tuna = await t.get('/foods/canned-tuna');
            assert.ok(!tuna.text.includes('US average price'));
        });
    } finally {
        await t.close();
    }
    done();
})();
