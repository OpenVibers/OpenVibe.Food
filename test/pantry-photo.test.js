'use strict';
/**
 * Pantry by photo or receipt (POST /pantry/photo → OpenVibe.AI food.read_pantry_photo → the person ticks what to add):
 *   - the model gets the photo (a data URL the page made smaller), the kind and Food's list by name, as the person;
 *   - list numbers come back as Food's items, sure ones ticked and unsure ones not, plus what it saw off the list;
 *   - a bad photo, a cross-site post, an AI failure and the eleventh photo of the day are refused politely;
 *   - several ticked items are added in one post.
 */
const assert = require('assert');
const { AiRunError } = require('openvibe-publishing/ai');
const { boot, check, done } = require('./helpers/boot');
const foods = require('../server/food/foods');

const SAME = { 'sec-fetch-site': 'same-origin' };
const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('not really a jpeg, the stub does not look').toString('base64');
const idx = (slug) => foods.FOODS.findIndex((f) => f.slug === slug);

(async () => {
    const calls = [];
    let fail = null;
    const ai = {
        async run(workflow, input, opts) {
            calls.push({ workflow, input, opts });
            if (fail) throw fail;
            return { runId: 'run_1', output: {
                items: [
                    { food: idx('eggs-dozen'), seen: 'receipt line: LG EGGS 12CT', confidence: 'high' },
                    { food: idx('whole-milk'), seen: 'receipt line: WHL MILK GAL', confidence: 'medium' },
                    { food: idx('avocado'), seen: 'receipt line: AVO', confidence: 'low' },
                    { food: 999, seen: 'out of range', confidence: 'high' },
                    { food: idx('eggs-dozen'), seen: 'twice', confidence: 'high' },
                ],
                unlisted: ['sparkling water'], gaps: [],
            } };
        },
    };
    const t = await boot({ env: { OV_AI_INTERNAL_URL: 'http://ai.test' }, ai });
    const kim = t.network.addUser('kim');
    const post = (form, headers = SAME) => t.get('/pantry/photo', { form, method: 'POST', as: kim, headers });
    try {
        await check('the photo goes to OpenVibe.AI as the person, with the kind and the list by name', async () => {
            const r = await post({ kind: 'receipt', image: PHOTO });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].workflow, 'food.read_pantry_photo');
            assert.deepStrictEqual(Object.keys(calls[0].input).sort(), ['foods', 'image', 'kind']);
            assert.strictEqual(calls[0].input.kind, 'receipt');
            assert.strictEqual(calls[0].input.image.data_url, PHOTO);
            assert.strictEqual(calls[0].input.foods.length, foods.FOODS.length);
            assert.strictEqual(calls[0].opts.onBehalfOf.id, kim.subject);
            assert.ok(r.text.includes('From your receipt'));
            assert.ok(r.text.includes('<input type="checkbox" name="item" value="eggs-dozen" checked>'), 'sure: ticked');
            assert.ok(r.text.includes('<input type="checkbox" name="item" value="whole-milk" checked>'));
            assert.ok(r.text.includes('<input type="checkbox" name="item" value="avocado">'), 'unsure: not ticked');
            assert.strictEqual((r.text.match(/value="eggs-dozen"/g) || []).length, 1, 'an item is listed once');
            assert.ok(r.text.includes('sparkling water'), 'what it saw off the list');
        });

        await check('several ticked items are added in one post', async () => {
            const r = await t.get('/pantry/items', { body: 'item=eggs-dozen&item=whole-milk&item=nope', method: 'POST', as: kim, headers: { ...SAME, 'content-type': 'application/x-www-form-urlencoded' } });
            assert.strictEqual(r.status, 303);
            assert.strictEqual(r.headers.get('location'), '/pantry?added_count=2');
            assert.deepStrictEqual((await t.get('/api/v1/pantry', { as: kim })).json().items, ['eggs-dozen', 'whole-milk']);
            assert.ok((await t.get('/pantry?added_count=2', { as: kim })).text.includes('Added 2 items to your cupboard.'));
        });

        await check('a bad photo, a cross-site post and an AI failure are refused politely; ten photos a day', async () => {
            assert.match((await post({ kind: 'shelf', image: 'data:text/html;base64,PHNjcmlwdD4=' })).text, /That photo did not arrive/);
            assert.strictEqual((await post({ kind: 'shelf', image: PHOTO }, { 'sec-fetch-site': 'cross-site' })).status, 403);
            fail = new AiRunError('ai.run_failed', 'the model failed', { status: 502 });
            assert.match((await post({ kind: 'shelf', image: PHOTO })).text, /could not read that photo just now/);
            fail = null;
            let last = null;
            for (let i = 0; i < 8; i++) last = await post({ kind: 'shelf', image: PHOTO });
            assert.ok(last.text.includes('From your photo'), 'the tenth still runs');
            const n = calls.length;
            assert.match((await post({ kind: 'shelf', image: PHOTO })).text, /That is ten photos today/);
            assert.strictEqual(calls.length, n, 'the eleventh never reaches OpenVibe.AI');
        });

        await check('the cupboard page offers the photo form', async () => {
            const page = await t.get('/pantry', { as: kim });
            assert.ok(page.text.includes('action="/pantry/photo"') && page.text.includes('js/pantry-photo.js') && page.text.includes('capture="environment"'));
        });
    } finally { await t.close(); }
    done();
})();
