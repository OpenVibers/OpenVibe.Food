'use strict';
/**
 * Sharing a saved meal plan (design 2026-11-06, visibility step 3): the one Share sheet (openvibe-sdk/share) and the
 * one check, canView, on the plan page and the plans API. The meal plan and its shopping list are one thing.
 *
 *   - a new plan is Only me; its page carries the Share button for its owner;
 *   - Anyone with the link is readable signed out, and a reader cannot tick;
 *   - Specific people shows the gate, never the plan's name or list, to somebody not on the list;
 *   - Can edit really ticks the shopping list; Can view only reads;
 *   - the person's default for new plans, and "apply to all", work;
 *   - a plan is never on a gathered page: not the sitemap, not llms.txt. A recipe, which is Everyone by nature, is.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const SAME = { 'sec-fetch-site': 'same-origin' };
    try {
        const kim = t.network.addUser('kim');
        const bo = t.network.addUser('bo');
        const cy = t.network.addUser('cy');
        const di = t.network.addUser('di');

        const call = (pathname, o = {}) => {
            const { headers, ...rest } = o;
            return t.get(pathname, { ...rest, headers: { 'x-requested-with': 'ov-share', ...(headers || {}) } });
        };
        const share = (id, o = {}) => call(`/api/v1/plan/${encodeURIComponent(id)}/share`, o);
        const setShare = async (id, body, as) => {
            const first = await share(id, { as });
            assert.strictEqual(first.status, 200, first.text);
            const etag = first.headers.get('etag');
            assert.ok(etag);
            return await share(id, { as, method: 'PUT', json: body, headers: { 'if-match': etag } });
        };
        const audienceRow = async (id) => await t.ctx.s.db.maybe(
            'SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', ['food', 'plan', id]);
        const newPlan = async (as, title) => {
            const posted = await t.get('/plan', { as, method: 'POST', form: { people: '3', days: '2', title }, headers: SAME });
            assert.strictEqual(posted.status, 303, posted.text);
            return new URL(posted.headers.get('location'), t.base).searchParams.get('saved');
        };
        const firstItem = (text) => (/name="item" value="([a-z0-9-]+)"/.exec(text) || [])[1];

        let id;
        await check('a new plan is Only me, and its page carries the Share button for its owner', async () => {
            id = await newPlan(kim, 'Our week');
            assert.deepStrictEqual(await audienceRow(id), { audience: 'private' });
            const mine = await t.get(`/plan/p/${id}`, { as: kim });
            assert.strictEqual(mine.status, 200, mine.text);
            assert.ok(mine.text.includes('data-ov-share-sheet') && mine.text.includes('data-kind="plan"'));
            assert.ok(mine.text.includes('ov-share.js'));
            assert.ok(mine.text.includes('Only me'));
            assert.strictEqual((await t.get(`/plan/p/${id}`, { as: bo })).status, 404, 'not shared: not found');
            const anon = await t.get(`/plan/p/${id}`);
            assert.strictEqual(anon.status, 303, 'a private plan asks a visitor to sign in');
            assert.match(anon.headers.get('location'), /^\/auth\/login\?next=/);
        });

        await check('Anyone with the link reads the plan signed out, and cannot tick', async () => {
            const saved = await setShare(id, { audience: 'link' }, kim);
            assert.strictEqual(saved.status, 200, saved.text);
            assert.strictEqual(saved.json().audience, 'link');
            const guest = await t.get(`/plan/p/${id}`);
            assert.strictEqual(guest.status, 200, guest.text);
            assert.ok(guest.text.includes('Our week'));
            assert.ok(guest.text.includes('Anyone with the link'));
            const item = firstItem(guest.text);
            assert.ok(!item, 'a reader gets no tick form');
            const api = await t.get(`/api/v1/plans/${id}`, { as: bo });
            assert.strictEqual(api.status, 200, api.text);
            assert.strictEqual(api.json().canEdit, false);
            assert.strictEqual((await t.get(`/plan/p/${id}/tick`, { as: bo, method: 'POST', form: { item: 'rice', done: '1' }, headers: SAME })).status, 403);
        });

        await check('Specific people: an editor ticks, a viewer only reads, a stranger gets the gate', async () => {
            const saved = await setShare(id, { audience: 'people', members: [{ name: 'bo', role: 'editor' }, { name: 'cy', role: 'viewer' }] }, kim);
            assert.strictEqual(saved.status, 200, saved.text);
            assert.strictEqual(saved.json().audience, 'people');
            const editor = await t.get(`/plan/p/${id}`, { as: bo });
            assert.strictEqual(editor.status, 200, editor.text);
            const item = firstItem(editor.text);
            assert.ok(item, 'Can edit opens the tick buttons');
            assert.strictEqual((await t.get(`/plan/p/${id}/tick`, { as: bo, method: 'POST', form: { item, done: '1' }, headers: SAME })).status, 303);
            assert.ok(/<li class="got">/.test((await t.get(`/plan/p/${id}`, { as: kim })).text), 'the owner sees the tick');
            const viewer = await t.get(`/plan/p/${id}`, { as: cy });
            assert.strictEqual(viewer.status, 200);
            assert.ok(!firstItem(viewer.text), 'Can view cannot tick');
            assert.strictEqual((await t.get(`/plan/p/${id}/tick`, { as: cy, method: 'POST', form: { item, done: '0' }, headers: SAME })).status, 403);
            const stranger = await t.get(`/plan/p/${id}`, { as: di });
            assert.strictEqual(stranger.status, 404);
            assert.ok(stranger.text.includes('shared with specific people'));
            assert.ok(!stranger.text.includes('Our week'), 'the gate never shows the plan name');
            assert.strictEqual((await t.get(`/api/v1/plans/${id}`, { as: di })).status, 404);
        });

        await check('the default applies to the next plan, and "apply to all" moves the existing one', async () => {
            const saved = await t.get('/plan/saved/defaults', { as: kim, method: 'POST', form: { audience: 'link', apply_all: '1' }, headers: SAME });
            assert.strictEqual(saved.status, 303, saved.text);
            assert.deepStrictEqual(await audienceRow(id), { audience: 'link' });
            const next = await newPlan(kim, 'Next week');
            assert.deepStrictEqual(await audienceRow(next), { audience: 'link' });
            const page = await t.get('/plan/saved', { as: kim });
            assert.ok(page.text.includes('New plans'), 'the default is on the plans page');
        });

        await check('gathered pages: a plan is never in the sitemap or llms.txt; a recipe is Everyone', async () => {
            const next = await newPlan(kim, 'A public plan');
            await setShare(next, { audience: 'public' }, kim);
            const sitemap = await t.get('/sitemap.xml');
            assert.strictEqual(sitemap.status, 200);
            assert.ok(!sitemap.text.includes(next), 'a plan is not in the sitemap, even Everyone');
            const llms = await t.get('/llms.txt');
            assert.ok(!llms.text.includes(next), 'a plan is not in llms.txt');
            assert.ok(/Disallow: \/plan\/p\//.test((await t.get('/robots.txt')).text));
            // The recipe library is OpenVibe's own, Everyone by nature, and keeps the sheet's send part.
            const recipe = await t.ctx.s.db.maybe('SELECT slug FROM food_library_recipes LIMIT 1');
            if (recipe) {
                const r = await t.get(`/recipes/library/${recipe.slug}`);
                assert.strictEqual(r.status, 200);
                assert.ok(r.text.includes('data-ov-share-sheet'));
                assert.ok(!r.text.includes('data-kind="recipe"'), 'a recipe is public by nature: no audience part');
            }
        });
    } finally {
        await t.close();
        done();
    }
})();
