'use strict';
/**
 * Plan together (migrations/0005_plan_households.sql, server/http/pages.js): a saved plan has its own page; its
 * owner makes a share link (shown once, only its hash kept); someone signed in who opens it and says yes joins the
 * household, sees the plan and ticks the shopping list off for everyone; only the owner shares, rotates, turns the
 * link off, removes people or deletes the plan; a member can leave; every change is a same-origin POST; nobody else
 * sees the plan; and the private pages stay out of robots.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin' };
const CROSS = { 'sec-fetch-site': 'cross-site' };

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    const ana = t.network.addUser('ana');
    let id = null;
    let secret = null;
    let item = null;
    const linkOf = (text) => (/https:\/\/openvibe\.food\/plan\/join\/([A-Za-z0-9_-]{43})/.exec(text) || [])[1] || null;
    try {
        await check('a saved plan has its own page, for its owner only', async () => {
            const posted = await t.get('/plan', { as: kim, method: 'POST', form: { people: '3', days: '2', title: 'Our week' }, headers: SAME });
            assert.strictEqual(posted.status, 303);
            id = new URL(posted.headers.get('location'), t.base).searchParams.get('saved');
            assert.match(id, /^pln_[0-9A-Z]{26}$/);
            const back = await t.get(posted.headers.get('location'), { as: kim });
            assert.ok(back.text.includes(`href="/plan/p/${id}"`), 'the saved notice links the plan');

            const mine = await t.get(`/plan/p/${id}`, { as: kim });
            assert.strictEqual(mine.status, 200);
            assert.match(mine.headers.get('cache-control'), /private/);
            assert.ok(mine.text.includes('Our week') && mine.text.includes('The household') && mine.text.includes('Make a share link'));
            item = (/name="item" value="([a-z0-9-]+)"/.exec(mine.text) || [])[1];
            assert.ok(item, 'the shopping list has tick buttons');
            assert.ok(mine.text.includes('css/plan.css') || mine.text.includes('plan.css'), 'its own stylesheet');

            assert.strictEqual((await t.get(`/plan/p/${id}`, { as: lee })).status, 404, 'not shared: not found');
            const out = await t.get(`/plan/p/${id}`);
            assert.strictEqual(out.status, 303);
            assert.match(out.headers.get('location'), /^\/auth\/login\?next=%2Fplan%2Fp%2F/);
            const listed = await t.get('/plan/saved', { as: kim });
            assert.ok(listed.text.includes(`/plan/p/${id}`), 'the saved list links it');
        });

        await check('the owner makes a share link, shown once; someone signed in joins with it', async () => {
            assert.strictEqual((await t.get(`/plan/p/${id}/share`, { as: kim, method: 'POST', form: {}, headers: CROSS })).status, 403, 'not from another site');
            const shared = await t.get(`/plan/p/${id}/share`, { as: kim, method: 'POST', form: {}, headers: SAME });
            assert.strictEqual(shared.status, 200);
            secret = linkOf(shared.text);
            assert.ok(secret, 'the link is on the page');
            assert.ok(!(await t.dbDump()).includes(secret), 'only its hash is stored');
            assert.ok(!linkOf((await t.get(`/plan/p/${id}`, { as: kim })).text), 'shown once');

            const ask = await t.get(`/plan/join/${secret}`, { as: lee });
            assert.strictEqual(ask.status, 200);
            assert.ok(ask.text.includes('Join “Our week”?') && ask.text.includes('Join the household'));
            const joined = await t.get(`/plan/join/${secret}`, { as: lee, method: 'POST', form: {}, headers: SAME });
            assert.strictEqual(joined.status, 303);
            assert.strictEqual(joined.headers.get('location'), `/plan/p/${id}`);
            const theirs = await t.get(`/plan/p/${id}`, { as: lee });
            assert.strictEqual(theirs.status, 200);
            assert.ok(theirs.text.includes('Shared with you') && theirs.text.includes('Leave this household'));
            assert.ok(!theirs.text.includes('Make a new share link'), 'a member does not share');
            assert.ok((await t.get('/plan/saved', { as: lee })).text.includes('Shared with you'));
            const again = await t.get(`/plan/join/${secret}`, { as: lee });
            assert.strictEqual(again.status, 303, 'a member opening the link goes to the plan');
        });

        await check('a tick shows for everyone; only items on the list; a member cannot change the household', async () => {
            const ticked = await t.get(`/plan/p/${id}/tick`, { as: lee, method: 'POST', form: { item, done: '1' }, headers: SAME });
            assert.strictEqual(ticked.status, 303);
            const seen = await t.get(`/plan/p/${id}`, { as: kim });
            assert.ok(/<li class="got">/.test(seen.text) && seen.text.includes('got by'), 'the owner sees the tick');
            assert.ok(seen.text.includes('1 of '), 'and the count');
            assert.strictEqual((await t.get(`/plan/p/${id}/tick`, { as: lee, method: 'POST', form: { item: 'not-on-the-list', done: '1' }, headers: SAME })).status, 400);
            await t.get(`/plan/p/${id}/tick`, { as: kim, method: 'POST', form: { item, done: '0' }, headers: SAME });
            assert.ok(!/<li class="got">/.test((await t.get(`/plan/p/${id}`, { as: lee })).text), 'untick shows for everyone too');
            for (const action of ['share', 'unshare', 'remove', 'delete']) {
                assert.strictEqual((await t.get(`/plan/p/${id}/${action}`, { as: lee, method: 'POST', form: { member: 'x' }, headers: SAME })).status, 403, action);
            }
            assert.strictEqual((await t.get(`/plan/p/${id}/tick`, { as: ana, method: 'POST', form: { item, done: '1' }, headers: SAME })).status, 404, 'an outsider ticks nothing');
        });

        await check('a new link replaces the old one; turning it off stops joins; removed and leaving people lose the plan', async () => {
            const fresh = linkOf((await t.get(`/plan/p/${id}/share`, { as: kim, method: 'POST', form: {}, headers: SAME })).text);
            assert.ok(fresh && fresh !== secret);
            assert.strictEqual((await t.get(`/plan/join/${secret}`, { as: ana })).status, 404, 'the old link is dead');
            assert.strictEqual((await t.get(`/plan/join/${fresh}`, { as: ana, method: 'POST', form: {}, headers: SAME })).status, 303);
            assert.strictEqual((await t.get(`/plan/p/${id}`, { as: ana })).status, 200);
            await t.get(`/plan/p/${id}/unshare`, { as: kim, method: 'POST', form: {}, headers: SAME });
            assert.strictEqual((await t.get(`/plan/join/${fresh}`, { as: ana })).status, 404, 'turned off');
            assert.strictEqual((await t.get(`/plan/join/${'x'.repeat(43)}`, { as: ana })).status, 404);

            const page = (await t.get(`/plan/p/${id}`, { as: kim })).text;
            const lees = (/name="member" value="(user:[^"]+)"/.exec(page) || [])[1];
            assert.ok(lees);
            await t.get(`/plan/p/${id}/remove`, { as: kim, method: 'POST', form: { member: lees }, headers: SAME });
            const both = [(await t.get(`/plan/p/${id}`, { as: lee })).status, (await t.get(`/plan/p/${id}`, { as: ana })).status].sort();
            assert.deepStrictEqual(both, [200, 404], 'one removed, one still in');
            const stay = (await t.get(`/plan/p/${id}`, { as: lee })).status === 200 ? lee : ana;
            assert.strictEqual((await t.get(`/plan/p/${id}/leave`, { as: stay, method: 'POST', form: {}, headers: SAME })).headers.get('location'), '/plan/saved');
            assert.strictEqual((await t.get(`/plan/p/${id}`, { as: stay })).status, 404, 'left');
        });

        await check('deleting the plan deletes its household and ticks; the private pages stay out of robots.txt', async () => {
            const link = linkOf((await t.get(`/plan/p/${id}/share`, { as: kim, method: 'POST', form: {}, headers: SAME })).text);
            await t.get(`/plan/join/${link}`, { as: lee, method: 'POST', form: {}, headers: SAME });
            await t.get(`/plan/p/${id}/tick`, { as: lee, method: 'POST', form: { item, done: '1' }, headers: SAME });
            const del = await t.get(`/plan/p/${id}/delete`, { as: kim, method: 'POST', form: {}, headers: SAME });
            assert.strictEqual(del.headers.get('location'), '/plan/saved');
            assert.strictEqual(await t.ctx.s.db.value('SELECT count(*)::int FROM food_plan_members WHERE plan_id = $1', [id]), 0);
            assert.strictEqual(await t.ctx.s.db.value('SELECT count(*)::int FROM food_plan_ticks WHERE plan_id = $1', [id]), 0);
            assert.strictEqual((await t.get(`/plan/p/${id}`, { as: lee })).status, 404);
            const robots = (await t.get('/robots.txt')).text;
            assert.ok(robots.includes('Disallow: /plan/p/') && robots.includes('Disallow: /plan/join/'));
        });
    } finally { await t.close(); }
    done();
})();
