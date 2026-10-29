'use strict';
/**
 * The recipe library (server/food/library.js, server/http/library-routes.js):
 *   - a theme goes to food.suggest_recipes with an empty cupboard and Food's food list; a recipe with an ingredient not
 *     tied to the list is dropped, the rest are kept with Food's own costs; the same dish is not kept twice;
 *   - themes take turns; a restart does not ask again within six hours; a failure is recorded, nothing is made;
 *   - the pages say AI wrote it; unreviewed recipes are noindex, a reviewed one is indexed with Recipe JSON-LD;
 *   - only staff review, hide and show, and only from openvibe.food itself.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { buildSources } = require('../server/food/recipes');
const { THEMES } = require('../server/food/library');

const SAME = { 'sec-fetch-site': 'same-origin' };
const src = buildSources();
const at = (slug) => src.findIndex((x) => x.source_id === slug);

function aiStub() {
    const calls = [];
    let fail = null;
    const ai = {
        calls,
        failNext(err) { fail = err; },
        async run(workflow, input, opts) {
            calls.push({ workflow, input, opts });
            if (fail) { const e = fail; fail = null; throw e; }
            const i = calls.length;
            return {
                runId: `run_lib_${i}`,
                output: {
                    recipes: [
                        { title: i === 2 ? 'Beans and Rice' : `Beans and rice ${i}`, serves: 4, minutes: 25,
                            // The cupboard is empty: a cited food marked "from the cupboard" is still a food from the list; water is a basic.
                            ingredients: [{ name: 'Rice', amount: '2 cups', from_pantry: false, citations: [at('white-rice')] }, { name: 'Beans', amount: '1 can', from_pantry: true, citations: [at('canned-beans')] }, { name: 'Water (or broth)', amount: '2 cups', from_pantry: false, citations: [] }],
                            steps: ['Cook the rice.', 'Warm the beans.', 'Serve together.'], notes: 'Add hot sauce.' },
                        { title: 'Mystery stew', serves: 2, minutes: 40, ingredients: [{ name: 'Saffron', amount: 'a pinch', from_pantry: true, citations: [] }, { name: 'Rice', amount: '1 cup', from_pantry: false, citations: [at('white-rice')] }], steps: ['Stew it.'] },
                    ],
                    citations: [], gaps: [],
                },
            };
        },
    };
    return ai;
}

(async () => {
    const ai = aiStub();
    const t = await boot({ env: { OV_AI_INTERNAL_URL: 'http://ai.test' }, ai });
    const kim = t.network.addUser('kim');
    const boss = t.network.addUser('boss', { role: 'admin' });
    try {
        await check('a theme becomes costed recipes from the food list and household basics; one with an unlisted ingredient is dropped', async () => {
            assert.ok(at('white-rice') >= 0 && at('canned-beans') >= 0, 'the fixture foods are in the list');
            const kept = await t.ctx.library.tick({ force: true });
            assert.deepStrictEqual(kept.map((x) => x.title), ['Beans and rice 1']);
            const call = ai.calls[0];
            assert.strictEqual(call.workflow, 'food.suggest_recipes');
            assert.deepStrictEqual(call.input.pantry, []);
            assert.ok(call.input.ask.includes(THEMES[0]));
            assert.strictEqual(call.opts.target.type, 'library');
            const row = await t.ctx.library.bySlug('beans-and-rice-1');
            assert.deepStrictEqual(row.to_buy.map((b) => b.slug).sort(), ['canned-beans', 'white-rice']);
            assert.ok(row.cost > 0);
            assert.deepStrictEqual(row.ingredients.map((i) => i.food), ['white-rice', 'canned-beans', null]);
            assert.strictEqual(row.ingredients[2].basic, true);
        });

        await check('themes take turns; a restart does not ask again early; a failure makes nothing', async () => {
            assert.deepStrictEqual(await t.ctx.library.tick(), [], 'within six hours of the last run');
            assert.strictEqual(ai.calls.length, 1);
            assert.strictEqual(await t.ctx.library.nextTheme(), THEMES[1]);
            await t.ctx.library.tick({ force: true });
            assert.ok(ai.calls[1].input.ask.includes(THEMES[1]));
            ai.failNext(new Error('provider down'));
            assert.deepStrictEqual(await t.ctx.library.tick({ force: true }), []);
            const runs = await t.ctx.s.db.many('SELECT theme, made, error FROM food_library_runs ORDER BY id');
            assert.deepStrictEqual(runs.map((r) => [r.made, r.error]), [[1, null], [1, null], [0, 'provider down']]);
        });

        await check('the pages: labelled AI, noindex until reviewed; staff review makes it indexable with Recipe JSON-LD', async () => {
            const list = await t.get('/recipes/library');
            assert.strictEqual(list.status, 200);
            assert.ok(list.text.includes('Written by OpenVibe.AI') && list.text.includes('href="/recipes/library/beans-and-rice-1"'));
            const page = await t.get('/recipes/library/beans-and-rice-1');
            assert.ok(page.text.includes('What to buy') && page.text.includes('href="/foods/white-rice"'));
            assert.match(page.text, /<meta name="robots" content="noindex/);
            assert.ok(!page.text.includes('"@type":"Recipe"'));
            assert.strictEqual((await t.get('/recipes/library/beans-and-rice-1/review', { method: 'POST', as: kim, form: { yes: '1' }, headers: SAME })).status, 403);
            assert.strictEqual((await t.get('/recipes/library/beans-and-rice-1/review', { method: 'POST', as: boss, form: { yes: '1' }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
            assert.strictEqual((await t.get('/recipes/library/beans-and-rice-1/review', { method: 'POST', as: boss, form: { yes: '1' }, headers: SAME })).status, 303);
            const reviewed = await t.get('/recipes/library/beans-and-rice-1');
            assert.match(reviewed.text, /<meta name="robots" content="index/);
            assert.ok(reviewed.text.includes('checked this one'));
            // The node is the page: its title, the ingredients and steps it lists, and nothing the page does not have.
            assert.strictEqual((reviewed.text.match(/application\/ld\+json/g) || []).length, 1, 'one JSON-LD script per page');
            const recipe = [...reviewed.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
                .map((m) => JSON.parse(m[1])).find((x) => x['@type'] === 'Recipe');
            assert.ok(recipe, 'no Recipe JSON-LD on a reviewed recipe');
            assert.strictEqual(recipe.name, 'Beans and rice 1');
            assert.strictEqual(recipe.url, 'https://openvibe.food/recipes/library/beans-and-rice-1');
            assert.deepStrictEqual(recipe.recipeIngredient, ['2 cups Rice', '1 can Beans', '2 cups Water (or broth)']);
            assert.deepStrictEqual(recipe.recipeInstructions.map((s) => s.text), ['Cook the rice.', 'Warm the beans.', 'Serve together.']);
            assert.strictEqual(recipe.recipeYield, '4 servings');
            assert.strictEqual(recipe.totalTime, 'PT25M');
            assert.ok(!('image' in recipe), 'the recipe has no image, so none is claimed');
            assert.ok((await t.get('/sitemap.xml')).text.includes('/recipes/library/beans-and-rice-1</loc>'), 'a reviewed recipe is in the sitemap');
            await t.get('/recipes/library/beans-and-rice-1/hide', { method: 'POST', as: boss, form: {}, headers: SAME });
            assert.strictEqual((await t.get('/recipes/library/beans-and-rice-1')).status, 404);
            assert.ok((await t.get('/recipes/library/beans-and-rice-1', { as: boss })).text.includes('Show it again'));
            await t.get('/recipes/library/beans-and-rice-1/show', { method: 'POST', as: boss, form: {}, headers: SAME });
            assert.strictEqual((await t.get('/recipes/library/beans-and-rice-1')).status, 200);
            assert.ok((await t.get('/recipes')).text.includes('href="/recipes/library"'));
        });

        await check('the JSON feed: published recipes since a time, oldest first; hidden ones never; a bad time is refused', async () => {
            const all = await t.get('/recipes/library.json');
            assert.strictEqual(all.status, 200);
            const recipes = all.json().recipes;
            assert.ok(recipes.length >= 1);
            assert.ok(recipes.every((x) => x.url.endsWith(`/recipes/library/${x.slug}`) && Array.isArray(x.ingredients)));
            const times = recipes.map((x) => x.created_at);
            assert.deepStrictEqual(times, [...times].sort(), 'oldest first');
            assert.strictEqual((await t.get('/recipes/library.json?since=2999-01-01T00:00:00Z')).json().recipes.length, 0);
            assert.strictEqual((await t.get('/recipes/library.json?since=yesterday-ish')).status, 400);
            const one = recipes[0].slug;
            await t.get(`/recipes/library/${one}/hide`, { method: 'POST', as: boss, form: {}, headers: SAME });
            assert.ok(!(await t.get('/recipes/library.json')).json().recipes.some((x) => x.slug === one), 'hidden recipes are not in the feed');
        });

        await check('the home lists the cheapest published recipes per serving, fully priced, each opening its page', async () => {
            const cheap = await t.ctx.library.cheapest(8);
            assert.ok(cheap.length >= 1 && cheap.every((x) => x.status === 'published' && !x.cost_partial && x.serves > 0));
            const per = cheap.map((x) => x.cost / x.serves);
            assert.deepStrictEqual(per, [...per].sort((a, b) => a - b), 'cheapest per serving first');
            const home = await t.get('/');
            assert.ok(home.text.includes('Cheap meals from the recipe library'));
            assert.ok(home.text.includes(`href="/recipes/library/${cheap[0].slug}"`), 'the cheapest recipe opens its page');
            assert.match(home.text, /<strong>\$\d+\.\d\d<\/strong> a serving/);
        });
    } finally { await t.close(); }
    done();
})();
