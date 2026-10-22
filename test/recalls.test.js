'use strict';
/**
 * Food recalls (server/food/recalls.js, server/http/recall-pages.js):
 *   - a Sources item of openfda-food-enforcement becomes one row, as the report states it; anything else is held;
 *   - the pull follows the change feed from the cursor, a removed item is deleted, an older revision never wins;
 *   - /recalls lists, filters and pages them with openFDA's note; /recalls/:number shows one (noindex); the home shows
 *     the newest; the sitemap lists /recalls and no single recall.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { rowOf, day } = require('../server/food/recalls');

const item = (n, over = {}, fields = {}) => ({
    id: `itm_${n}`, source_key: 'openfda-food-enforcement', category: 'food', kind: 'recall', identity: `F-${String(n).padStart(4, '0')}-2027`,
    canonical_url: null, title: `Frozen pepperoni pizza ${n}, Net Weight 17 oz, UPC 6 66186 27762 ${n}`, summary: `Undeclared milk (${n}).`,
    fields: { recalling_firm: `Firm ${n}`, classification: n % 3 === 0 ? 'Class I' : 'Class II', status: 'Ongoing', state: n % 2 ? 'OH' : 'TX', distribution_pattern: 'KY, OH', voluntary_mandated: 'Voluntary: Firm initiated', recall_initiation_date: '20261001', report_date: `202610${String(10 + (n % 20)).padStart(2, '0')}`, ...fields },
    revision: 1, provenance: { retrieved_at: '2026-10-22T10:00:00.000Z' }, removed: null, change_seq: n, ...over,
});

/** A stand-in for OpenVibe.Sources' change feed: items in change_seq order after the cursor. */
function feed(items) {
    const calls = [];
    return {
        calls,
        items,
        async listItems({ after = 0, limit = 100 }) {
            calls.push(after);
            const rest = items.filter((x) => x.change_seq > after).sort((a, b) => a.change_seq - b.change_seq);
            const page = rest.slice(0, limit);
            return { items: page, next_after: page.length ? page[page.length - 1].change_seq : after, more: rest.length > limit, sources: {} };
        },
    };
}

(async () => {
    const items = Array.from({ length: 34 }, (_, i) => item(i + 1));
    items.push({ ...item(90), kind: 'record', identity: 'not-a-recall', change_seq: 90 });
    items.push({ ...item(91), source_key: 'fda-food-recalls', change_seq: 91 });
    const source = feed(items);
    const t = await boot({ recallSource: source });
    try {
        await check('a report becomes one row as stated; a bad number, another kind or another source is not a recall', async () => {
            assert.strictEqual(day('20261014'), '2026-10-14');
            assert.strictEqual(day('2026-10-14'), null);
            assert.strictEqual(day('20261340'), null);
            const row = rowOf(item(3));
            assert.strictEqual(row.recall_number, 'F-0003-2027');
            assert.strictEqual(row.classification, 'Class I');
            assert.strictEqual(row.firm, 'Firm 3');
            assert.strictEqual(row.reported_on, '2026-10-13');
            assert.strictEqual(rowOf({ ...item(4), identity: 'javascript:alert(1)' }), null);
            assert.strictEqual(rowOf({ ...item(4), title: '' }), null);
            assert.strictEqual(rowOf(item(5, {}, { classification: 'Class IV' })).classification, null);
        });

        await check('the pull follows the change feed to its end and keeps the cursor', async () => {
            const page = await t.get('/recalls');
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('once OpenVibe.Sources has read them'), 'before the first pull the page says where recalls come from');
            const out = await t.ctx.recalls.pull();
            assert.strictEqual(out.applied, 34);
            assert.strictEqual(out.hold, 2);
            assert.strictEqual(await t.ctx.recalls.count(), 34);
            assert.strictEqual(Number(await t.ctx.s.db.value("SELECT cursor FROM food_ingest_cursor WHERE name = 'sources.food.after'")), 91);
            const again = await t.ctx.recalls.pull();
            assert.strictEqual(again.applied, 0, 'nothing new after the cursor');
        });

        await check('a removed item is deleted; an older revision arriving late changes nothing', async () => {
            source.items.push({ ...item(2), removed: { at: '2026-10-22T11:00:00.000Z', reason: 'takedown' }, revision: 2, change_seq: 100 });
            source.items.push({ ...item(5, { revision: 3, summary: 'Undeclared milk and egg.' }), change_seq: 101 });
            source.items.push({ ...item(5, { revision: 2, summary: 'stale' }), change_seq: 102 });
            const out = await t.ctx.recalls.pull();
            assert.strictEqual(out.removed, 1);
            assert.strictEqual(await t.ctx.recalls.get('F-0002-2027'), null);
            assert.strictEqual((await t.ctx.recalls.get('F-0005-2027')).reason, 'Undeclared milk and egg.');
            assert.strictEqual(await t.ctx.recalls.count(), 33);
        });

        await check('/recalls lists the newest report first with openFDA\'s note, and filters by words, class and state', async () => {
            const all = await t.get('/recalls');
            assert.strictEqual(all.status, 200);
            assert.ok(all.text.includes('33 recalls so far'));
            assert.ok(all.text.includes('not for medical decisions') && all.text.includes('not endorsed by the FDA'));
            assert.ok(!/noindex/.test(all.text), 'the list is indexed');
            assert.ok(all.text.includes('Page 1 of 2'));
            assert.ok(all.text.indexOf('F-0029-2027') < all.text.indexOf('F-0028-2027'), 'newest report first');
            const classI = await t.get('/recalls?class=Class+I');
            const shown = classI.text.match(/\/recalls\/F-\d{4}-2027/g) || [];
            assert.ok(shown.length && shown.every((h) => Number(h.slice(11, 15)) % 3 === 0), 'only Class I');
            assert.ok(/noindex/.test(classI.text), 'a filtered list is not indexed');
            const tx = await t.get('/recalls?state=TX&q=firm+1');
            assert.ok((tx.text.match(/\/recalls\/F-\d{4}-2027/g) || []).every((h) => Number(h.slice(11, 15)) % 2 === 0));
            const none = await t.get('/recalls?q=%3Cscript%3E');
            assert.ok(none.text.includes('Nothing matched') && !none.text.includes('<script>alert'));
            const odd = await t.get('/recalls?state=%27%3B--&class=Class+IV&page=-3');
            assert.strictEqual(odd.status, 200);
        });

        await check('/recalls/:number shows the report in full and is noindex; an unknown number is a 404', async () => {
            const one = await t.get('/recalls/F-0003-2027');
            assert.strictEqual(one.status, 200);
            assert.ok(one.text.includes('Firm 3') && one.text.includes('Undeclared milk (3).') && one.text.includes('Class I'));
            assert.ok(one.text.includes('serious adverse health consequences or death'), 'the class is explained in the FDA\'s words');
            assert.ok(/noindex/.test(one.text));
            assert.ok(one.text.includes('not for medical decisions'));
            assert.strictEqual((await t.get('/recalls/F-9999-2027')).status, 404);
            assert.strictEqual((await t.get('/recalls/..%2F..%2Fetc')).status, 404);
        });

        await check('the home shows the newest recalls and the count; the sitemap lists /recalls only', async () => {
            const home = await t.get('/');
            assert.ok(home.text.includes('id="h-recalls"'));
            assert.ok(home.text.includes('All 33 recalls'));
            assert.ok(home.text.includes('FDA food recalls, newest first'));
            const map = await t.get('/sitemap.xml');
            assert.ok(map.text.includes('https://openvibe.food/recalls</loc>'));
            assert.ok(!map.text.includes('/recalls/F-'));
            const llms = await t.get('/llms.txt');
            assert.ok(llms.text.includes('https://openvibe.food/recalls'));
        });
    } finally {
        await t.close();
    }
    done();
})();
