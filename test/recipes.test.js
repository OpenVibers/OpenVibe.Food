'use strict';
/**
 * Recipe ideas: the request Food builds for OpenVibe.AI, the strict validation of what comes back, the cost Food
 * computes from its own food list (never from the AI), the last-20 store, the daily cap, the AI-off and empty-pantry
 * problems, AiRunError pass-through, app tokens needing the capability, and the page signed in and out.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/boot');
const { buildSources, buildRequest, validateSuggestions, COST_NOTE } = require('../server/food/recipes');
const { getFood } = require('../server/food/foods');
const { AiRunError } = require('openvibe-publishing/ai');
const { serviceAuth, ids } = require('openvibe-contracts');
const foodStore = require('../server/food/store');

const SAME = { 'sec-fetch-site': 'same-origin' };

/** A stand-in OpenVibe.AI client: records what it was asked and answers with a fixed output (or a failure). */
function aiStub(output, { fail = null } = {}) {
    const calls = [];
    return {
        calls,
        async run(workflow, input, opts) {
            calls.push({ workflow, input, opts });
            if (fail) throw fail;
            return { runId: 'run_01JTEST0000000000000000RUN', output };
        },
    };
}

const SAMPLE_OUTPUT = {
    recipes: [
        {
            title: 'Beans and rice bowl', serves: 2, minutes: 20,
            ingredients: [
                { name: 'Eggs', amount: '2', from_pantry: true, citations: [] },
                { name: 'Black beans', amount: '1 can', from_pantry: false, citations: [0] },
            ],
            steps: ['Cook the rice.', 'Add the beans.'],
            notes: 'Season to taste.',
        },
    ],
    citations: [0],
    gaps: ['an onion would help'],
};

/** An app token for openvibe.food, signed by the mock Network's key. */
function appToken(t, cap) {
    const now = Math.floor(Date.now() / 1000);
    const projectId = ids.newId('project');
    return serviceAuth.signServiceToken({
        iss: t.network.url, sub: `app:${ids.newId('app')}`, actor_type: 'app', aud: ['openvibe.food'], cap,
        ns: [projectId], project_id: projectId, env: 'production', iat: now, exp: now + 300, jti: `tok_${crypto.randomUUID()}`,
    }, t.network.privatePem);
}

(async () => {
    await check('the request is built from the pantry and Food\'s own food list, capped at 60 sources', () => {
        const sources = buildSources();
        assert.ok(sources.length >= 1 && sources.length <= 60, `sources ${sources.length}`);
        for (const src of sources) {
            assert.strictEqual(src.source_type, 'food.food');
            assert.ok(getFood(src.source_id), `${src.source_id} is in the food list`);
            assert.strictEqual(src.title, getFood(src.source_id).name);
            const content = JSON.parse(src.content);
            assert.strictEqual(content.name, getFood(src.source_id).name);
            assert.ok('price' in content && 'unit' in content, 'source carries the unit and typical price');
        }

        const req = buildRequest({ pantry: Array.from({ length: 70 }, (_, i) => `food-${i}`), ask: 'x'.repeat(600), people: 3 });
        assert.strictEqual(req.pantry.length, 60);
        assert.strictEqual(req.ask.length, 500);
        assert.strictEqual(req.people, 3);
        assert.deepStrictEqual(req.sources, sources);
    });

    await check('the AI output is validated: bad citations and empty recipes are dropped, cost is Food\'s own', () => {
        const sources = [
            { source_type: 'food.food', source_id: 'canned-beans', title: 'Beans', content: JSON.stringify({ price: 999 }) },
            { source_type: 'food.food', source_id: 'white-rice', title: 'Rice', content: '{}' },
        ];
        const out = validateSuggestions({
            recipes: [
                {
                    title: 'A', serves: 1, minutes: 5,
                    ingredients: [
                        { name: 'Rice', amount: '1 cup', from_pantry: true, citations: [] },
                        { name: 'Beans', amount: '1 can', from_pantry: false, citations: [0] },
                        { name: 'Bad', from_pantry: false, citations: [9] },
                    ],
                    steps: ['Cook it.'],
                },
                { title: 'Empty', serves: 1, minutes: 5, ingredients: [{ name: 'Bad', from_pantry: false, citations: [9] }], steps: ['Cook it.'] },
                { title: 'No steps', serves: 1, minutes: 5, ingredients: [{ name: 'Rice', from_pantry: true, citations: [] }], steps: [] },
            ],
            citations: [0, 9],
            gaps: ['salt'],
        }, { sources, pantry: [] });

        assert.strictEqual(out.recipes.length, 1, 'the empty and stepless recipes are dropped');
        assert.strictEqual(out.recipes[0].ingredients.length, 2, 'the uncited ingredient is dropped');
        assert.deepStrictEqual(out.recipes[0].ingredients[1].citations, [0]);
        assert.deepStrictEqual(out.recipes[0].to_buy, [{ slug: 'canned-beans', name: getFood('canned-beans').name, price: getFood('canned-beans').price }]);
        assert.strictEqual(out.recipes[0].to_buy_cost, getFood('canned-beans').price, 'cost comes from the food list, not the source content the AI could have seen');
        assert.strictEqual(out.recipes[0].cost_note, COST_NOTE);
        assert.deepStrictEqual(out.citations, [0]);
        assert.deepStrictEqual(out.gaps, ['salt']);
    });

    const ai = aiStub(SAMPLE_OUTPUT);
    const t = await boot({ env: { OV_AI_INTERNAL_URL: 'http://ai.test' }, ai });
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    try {
        await check('a signed-in person asks for recipes, Food stores its validated, costed answer', async () => {
            await t.get('/api/v1/pantry', { json: { items: ['eggs-dozen'] }, method: 'PUT', as: kim, headers: SAME });
            const created = await t.get('/api/v1/recipes/suggest', { as: kim, method: 'POST', json: { ask: 'quick dinner', people: 2 }, headers: SAME });
            assert.strictEqual(created.status, 201, created.text);
            const body = created.json();
            assert.match(body.id, /^rcp_/);
            assert.strictEqual(body.ask, 'quick dinner');
            assert.strictEqual(body.people, 2);
            assert.strictEqual(body.ai_run_id, 'run_01JTEST0000000000000000RUN');
            assert.strictEqual(body.recipes.length, 1);
            assert.strictEqual(body.recipes[0].title, 'Beans and rice bowl');

            const call = ai.calls[0];
            assert.strictEqual(call.workflow, 'food.suggest_recipes');
            assert.deepStrictEqual(call.input.pantry, ['Large Eggs (1 dozen)']);
            assert.ok(call.input.sources.length <= 60);
            assert.strictEqual(call.opts.onBehalfOf.id, kim.subject);
            assert.strictEqual(call.opts.target.id, kim.subject);
            assert.strictEqual(call.opts.target.service, 'food');

            const cited = call.input.sources[0].source_id;
            assert.strictEqual(body.recipes[0].to_buy[0].slug, cited);
            assert.strictEqual(body.recipes[0].to_buy_cost, getFood(cited).price);
            assert.strictEqual(body.recipes[0].ingredients[0].from_pantry, true);

            const list = await t.get('/api/v1/recipes', { as: kim });
            assert.strictEqual(list.status, 200);
            assert.deepStrictEqual(list.json().recipes.map((r) => r.id), [body.id]);
        });

        await check('an app token needs the recipes capability', async () => {
            const without = await t.get('/api/v1/recipes/suggest', { bearer: appToken(t, []), method: 'POST', json: { ask: 'x' } });
            assert.strictEqual(without.status, 403);
            assert.match(without.json().code, /capability/);
            // The capability is proposed but not yet in openvibe-contracts, so even a granted token is refused here.
            const withCap = await t.get('/api/v1/recipes/suggest', { bearer: appToken(t, ['food.recipes.suggest']), method: 'POST', json: { ask: 'x' } });
            assert.strictEqual(withCap.status, 403);
            assert.match(withCap.json().code, /capability/);
        });

        await check('an empty pantry is a 422 food.pantry_empty', async () => {
            const res = await t.get('/api/v1/recipes/suggest', { as: lee, method: 'POST', json: { ask: 'anything' }, headers: SAME });
            assert.strictEqual(res.status, 422);
            assert.strictEqual(res.json().code, 'food.pantry_empty');
        });

        await check('the page asks a signed-out person to sign in, and a signed-in one shows the idea and its cost', async () => {
            const out = await t.get('/recipes');
            assert.strictEqual(out.status, 200);
            assert.match(out.text, /Sign in to get recipe ideas/);

            const page = await t.get('/recipes', { as: kim });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /Beans and rice bowl/);
            assert.match(page.text, /in your cupboard/);
            assert.match(page.text, /Still to buy/);
            assert.match(page.text, /Typical total/);
            assert.match(page.text, /Check a recipe before you cook it/);
        });

        await check('the daily limit is 10 suggestions a person', async () => {
            const s = t.ctx.s;
            const subject = `user:${kim.subject}`;
            for (let i = 0; i < 9; i++) await foodStore.insertRecipeSuggestion(s, { id: `rcp_d${i}`, subject_id: subject, created_at: s.iso(), ask: null, people: null, ai_run_id: 'run', recipes: [{ title: 'filler' }] });
            const res = await t.get('/api/v1/recipes/suggest', { as: kim, method: 'POST', json: { ask: 'one more' }, headers: SAME });
            assert.strictEqual(res.status, 429);
            assert.strictEqual(res.json().code, 'food.recipes_daily_limit');
        });

        await check('only the last 20 suggestions are kept per person', async () => {
            const s = t.ctx.s;
            const subject = `user:${lee.subject}`;
            for (let i = 1; i <= 21; i++) await foodStore.insertRecipeSuggestion(s, { id: `rcp_c${String(i).padStart(4, '0')}`, subject_id: subject, created_at: s.iso(), ask: null, people: null, ai_run_id: 'run', recipes: [{ title: `r${i}` }] });
            const rows = await foodStore.listRecipeSuggestions(s, subject, { limit: 50 });
            assert.strictEqual(rows.length, 20);
            assert.ok(rows.every((r) => r.id !== 'rcp_c0001'), 'the oldest is dropped');
            assert.ok(rows.some((r) => r.id === 'rcp_c0021'), 'the newest is kept');
        });

        await check('recipe suggestions are exported and erased with the account', async () => {
            const subject = `user:${kim.subject}`;
            assert.strictEqual(await t.ctx.s.db.value('SELECT count(*)::int FROM food_recipe_suggestions WHERE subject_id = $1', [subject]) > 0, true);
            const part = await t.ctx.accountData.exportPart(kim.subject);
            assert.ok(part.files.some((f) => f.name === 'recipe-suggestions.json'), 'the export carries recipe suggestions');
            await t.ctx.accountData.erase([kim.subject]);
            assert.strictEqual(await t.ctx.s.db.value('SELECT count(*)::int FROM food_recipe_suggestions WHERE subject_id = $1', [subject]), 0, 'erased with the account');
        });
    } finally { await t.close(); }

    await check('with OV_AI_INTERNAL_URL unset the route answers 503 food.ai_off', async () => {
        const off = await boot();
        const u = off.network.addUser('kim');
        try {
            const res = await off.get('/api/v1/recipes/suggest', { as: u, method: 'POST', json: { ask: 'x' }, headers: SAME });
            assert.strictEqual(res.status, 503);
            assert.strictEqual(res.json().code, 'food.ai_off');
        } finally { await off.close(); }
    });

    await check('an AiRunError passes through its status and code', async () => {
        const failing = aiStub(null, { fail: new AiRunError('ai.run_failed', 'the model failed', { status: 502 }) });
        const t2 = await boot({ env: { OV_AI_INTERNAL_URL: 'http://ai.test' }, ai: failing });
        const u = t2.network.addUser('kim');
        try {
            await t2.get('/api/v1/pantry', { json: { items: ['eggs-dozen'] }, method: 'PUT', as: u, headers: SAME });
            const res = await t2.get('/api/v1/recipes/suggest', { as: u, method: 'POST', json: { ask: 'x' }, headers: SAME });
            assert.strictEqual(res.status, 502);
            assert.strictEqual(res.json().code, 'ai.run_failed');
        } finally { await t2.close(); }
    });

    done();
})();
