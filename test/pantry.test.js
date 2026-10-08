'use strict';
/**
 * The cupboard: what a person says they have, kept per account, and the deterministic "what can I make" that matches
 * it against the basic recipes. No model call anywhere near it. Anonymous callers are refused every read and write of
 * a personal list, an unknown food is refused rather than stored, and a PUT replaces the list.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { matchPantry } = require('../server/food/pantry-match');

const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    await check('the match is deterministic and says what is missing', () => {
        const full = matchPantry(['white-rice', 'canned-beans', 'onion-3lb']);
        assert.deepStrictEqual(full.can_make.map((r) => r.slug), ['beans-and-rice']);
        assert.deepStrictEqual(full.can_make[0].missing, []);
        assert.deepStrictEqual(full.can_make[0].steps.length > 0, true);

        const empty = matchPantry([]);
        assert.deepStrictEqual(empty.can_make, []);
        assert.strictEqual(empty.all.length, require('../server/food/recipes').RECIPES.length);
        assert.ok(empty.all.every((r) => !r.can_make && r.missing_count === r.ingredients.length));

        const close = matchPantry(['bread-white', 'canned-tuna']);
        assert.ok(close.can_make.some((r) => r.slug === 'tuna-sandwich'));
        const almost = close.almost.find((r) => r.slug === 'eggs-on-toast');
        assert.ok(almost, 'eggs on toast is one item away');
        assert.deepStrictEqual(almost.missing.map((m) => m.name), ['Large Eggs (1 dozen)']);
        assert.strictEqual(almost.coverage, 0.5);

        // every recipe names only foods the list knows
        const { RECIPES } = require('../server/food/recipes');
        const { getFood } = require('../server/food/foods');
        for (const r of RECIPES) for (const slug of [...r.ingredients, ...(r.optional || [])]) assert.ok(getFood(slug), `${r.slug} names ${slug}, which is not in the food list`);
    });

    const t = await boot();
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    try {
        await check('an anonymous caller can neither read nor write a pantry', async () => {
            assert.strictEqual((await t.get('/api/v1/pantry')).status, 401);
            assert.strictEqual((await t.get('/api/v1/pantry', { json: { items: [] }, method: 'PUT', headers: SAME })).status, 401);
            const page = await t.get('/pantry');
            assert.strictEqual(page.status, 200, 'the page itself is public: it just asks you to sign in');
            assert.match(page.text, /Sign in to keep a cupboard/);
        });

        await check('PUT replaces the list; GET gives it back with the foods and the suggestions', async () => {
            const first = await t.get('/api/v1/pantry', { json: { items: ['white-rice', 'canned-beans', 'onion-3lb'] }, method: 'PUT', as: kim, headers: SAME });
            assert.strictEqual(first.status, 200, first.text);
            const body = first.json();
            assert.deepStrictEqual(body.items, ['canned-beans', 'onion-3lb', 'white-rice'], 'sorted');
            assert.deepStrictEqual(body.foods.map((f) => f.slug), body.items);
            assert.deepStrictEqual(body.suggestions.can_make.map((r) => r.slug), ['beans-and-rice']);
            assert.match(body.note, /Basic suggestions/);

            const replaced = await t.get('/api/v1/pantry', { json: { items: ['bread-white', 'canned-tuna'] }, method: 'PUT', as: kim, headers: SAME });
            assert.deepStrictEqual(replaced.json().items, ['bread-white', 'canned-tuna'], 'a PUT is the whole list, not a merge');

            const read = await t.get('/api/v1/pantry', { as: kim });
            assert.deepStrictEqual(read.json().items, ['bread-white', 'canned-tuna']);
            assert.deepStrictEqual((await t.get('/api/v1/pantry', { as: lee })).json().items, [], 'another person has their own');
            const cleared = await t.get('/api/v1/pantry', { json: { items: [] }, method: 'PUT', as: kim, headers: SAME });
            assert.deepStrictEqual(cleared.json().items, []);
        });

        await check('an item that is not in the food list is refused, and a cleared list is a real answer', async () => {
            const bad = await t.get('/api/v1/pantry', { json: { items: ['white-rice', 'unicorn-steak'] }, method: 'PUT', as: kim, headers: SAME });
            assert.strictEqual(bad.status, 422);
            assert.strictEqual(bad.json().code, 'food.pantry.unknown_item');
            assert.match(bad.json().detail, /unicorn-steak/);
            assert.deepStrictEqual((await t.get('/api/v1/pantry', { as: kim })).json().items, [], 'nothing was stored');
            const notArray = await t.get('/api/v1/pantry', { json: { items: 'eggs-dozen' }, method: 'PUT', as: kim, headers: SAME });
            assert.strictEqual(notArray.status, 422);
            assert.strictEqual(notArray.json().code, 'food.pantry.invalid');
        });

        await check('the cupboard page ticks what you have, saves without JavaScript, and shows what you can make', async () => {
            await t.get('/api/v1/pantry', { json: { items: ['white-rice', 'canned-beans', 'onion-3lb'] }, method: 'PUT', as: kim, headers: SAME });
            const page = await t.get('/pantry', { as: kim });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /name="items" value="white-rice" checked/);
            assert.match(page.text, /What can I make\?/);
            assert.match(page.text, /Beans and rice/);
            assert.match(page.text, /Basic suggestions/);

            // A real checkbox form sends the field once per ticked box.
            const saved = await t.get('/pantry', {
                as: kim, method: 'POST', headers: { ...SAME, 'content-type': 'application/x-www-form-urlencoded' },
                body: 'items=bread-white&items=canned-tuna&items=butter',
            });
            assert.strictEqual(saved.status, 303, saved.text.slice(0, 200));
            assert.strictEqual(saved.headers.get('location'), '/pantry?saved=1');
            assert.deepStrictEqual((await t.get('/api/v1/pantry', { as: kim })).json().items, ['bread-white', 'butter', 'canned-tuna']);

            const back = await t.get('/pantry?saved=1', { as: kim });
            assert.match(back.text, /Cupboard saved\./);
            assert.match(back.text, /Tuna sandwich/);
        });

        await check('another site cannot change a signed-in visitor\'s cupboard', async () => {
            const cross = await t.get('/pantry', { as: kim, method: 'POST', body: 'items=eggs-dozen', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' } });
            assert.strictEqual(cross.status, 403);
        });
    } finally { await t.close(); }
    done();
})();
