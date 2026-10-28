'use strict';
// Food boxes (server/food/boxes.js, server/http/box-pages.js, the /api/v1/boxes routes): every box well-formed with
// its facts sourced, the cost honest (only from a stated per-serving or per-meal price, a range stays a range), the
// pages and the API answering, and the Coupons and Reviews joins read when set and never when not.
const assert = require('assert');
const boxes = require('../server/food/boxes');
const { createBoxLinks } = require('../server/food/box-links');

// ── The data: every box complete, every stated fact sourced ──
const slugs = new Set();
boxes.BOXES.forEach((b) => {
    assert.ok(/^[a-z0-9-]+$/.test(b.slug) && !slugs.has(b.slug), `slug ${b.slug}`);
    slugs.add(b.slug);
    assert.ok(boxes.KIND[b.kind], `${b.slug}: kind`);
    assert.ok(/^https:\/\//.test(b.url) && b.url.includes(b.host), `${b.slug}: its url is on its host`);
    assert.ok(b.what && b.what.length < 140, `${b.slug}: what`);
    b.diets.forEach((d) => assert.ok(boxes.DIETS[d], `${b.slug}: diet ${d}`));
    const stated = b.price || b.shipping || b.ships_to || b.cancel || b.people.length || b.meals.length || b.cadence.length || b.diets.length || b.notes.length;
    if (stated) assert.ok(b.sources.length, `${b.slug}: a stated fact has its source page`);
    b.sources.forEach((s) => assert.ok(/^https:\/\//.test(s), `${b.slug}: source ${s}`));
    if (b.price) assert.ok(b.price.text && ['serving', 'meal', 'box', 'month', 'delivery', 'day', 'membership'].includes(b.price.unit), `${b.slug}: price`);
});
assert.ok(boxes.BOXES.length >= 35, 'every kind has its boxes');
boxes.KINDS.forEach((k) => assert.ok(boxes.list({ kind: k.kind }).length >= 3, `${k.kind}: at least three`));

// ── Listing and search ──
assert.ok(boxes.list({ diet: 'keto' }).every((b) => b.diets.includes('keto')));
assert.deepStrictEqual(boxes.list({ q: 'hellofresh' }).map((b) => b.slug), ['hellofresh']);
assert.strictEqual(boxes.get('nope'), null);
assert.strictEqual(boxes.priceLine({ from: 5.99, to: null, unit: 'serving' }), 'from $5.99 a serving');
assert.strictEqual(boxes.priceLine({ from: 10.39, to: 12.69, unit: 'meal' }), '$10.39–$12.69 a meal');
assert.strictEqual(boxes.priceLine({ from: null, to: 5, unit: 'meal' }), 'under $5 a meal');

// ── Cost: only from what the box states ──
const ep = boxes.get('everyplate');
const c = boxes.cost(ep, { people: 2, meals: 3 });
assert.deepStrictEqual([c.servings, c.food, c.shipping, c.total], [6, { from: 35.94, to: 35.94 }, { from: 10.99, to: 10.99 }, { from: 46.93, to: 46.93 }]);
assert.ok(c.basis.includes('Plans from $5.99 a serving') && c.basis.includes(boxes.CHECKED), 'it says what it rests on');
assert.strictEqual(boxes.cost(ep, { people: 3, meals: 3 }), null, 'a plan size EveryPlate does not state');
const cu = boxes.cost(boxes.get('cookunity'), { meals: 6 });
assert.deepStrictEqual([cu.servings, cu.food, cu.shipping], [6, { from: 62.34, to: 76.14 }, { from: 9.99, to: 11.99 }], 'a ready meal counts meals; a range stays a range');
assert.strictEqual(boxes.cost(boxes.get('butcherbox'), {}), null, 'a price per box is not per serving');
assert.strictEqual(boxes.cost(boxes.get('dinnerly'), {}), null, 'nothing stated, nothing worked out');
assert.strictEqual(boxes.cost(ep, { people: 2, meals: 3, weeks: 99 }), null);

// ── The wire shape ──
const w = boxes.toWire(ep);
assert.strictEqual(w.price.line, 'from $5.99 a serving');
assert.strictEqual(w.checked, boxes.CHECKED);
assert.strictEqual(boxes.toWire(boxes.get('dinnerly')).checked, null, 'nothing checked: no date');
assert.ok(w.links.coupons.includes('everyplate.com') && w.links.reviews.includes('EveryPlate'));

(async () => {
    // ── The joins: off without addresses; read, cached and given up on cleanly when set ──
    const off = createBoxLinks({});
    assert.deepStrictEqual(await off.forBox(ep), { coupons: null, reviews: null });
    const calls = [];
    const fake = async (url, init = {}) => {
        calls.push(url);
        const ok = (body) => ({ ok: true, status: 200, json: async () => body });
        if (url.includes('/merchants/resolve')) return ok({ merchant: { id: 'mer_1', url: 'https://openvibe.coupons/m/everyplate' } });
        if (url.includes('/merchants/mer_1/coupons')) return ok({ coupons: [{ code: 'A1', title: '10% off', status: 'unknown' }, { code: 'PLATE70', title: '70% off your first box', status: 'reported_working', confidence: 0.8 }] });
        if (url.endsWith('/api/v1/resolve')) { assert.strictEqual(init.method, 'POST'); return ok({ entity: { slug: 'everyplate', name: 'EveryPlate', url: 'https://openvibe.reviews/e/everyplate' } }); }
        if (url.includes('/entities/everyplate/aggregate')) return ok({ aggregate: { result: { components: { recommendation: { percent: 81.2, total: 48 } } } } });
        return { ok: false, status: 404, json: async () => ({}) };
    };
    const links = createBoxLinks({ couponsUrl: 'http://coupons.test', reviewsUrl: 'http://reviews.test', fetch: fake });
    const got = await links.forBox(ep);
    assert.deepStrictEqual(got.coupons, { url: 'https://openvibe.coupons/m/everyplate', active: 2, best: { code: 'PLATE70', title: '70% off your first box' } });
    assert.deepStrictEqual(got.reviews, { url: 'https://openvibe.reviews/e/everyplate', name: 'EveryPlate', percent: 81.2, total: 48, line: '81.2% recommend (48)' });
    const n = calls.length;
    await links.forBox(ep);
    assert.strictEqual(calls.length, n, 'kept ten minutes');
    const down = createBoxLinks({ couponsUrl: 'http://c', reviewsUrl: 'http://r', fetch: async () => { throw new Error('down'); } });
    assert.deepStrictEqual(await down.forBox(ep), { coupons: null, reviews: null }, 'a neighbour that is down: the box shows without it');
    const none = createBoxLinks({ couponsUrl: 'http://c', reviewsUrl: 'http://r', fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
    assert.deepStrictEqual(await none.forBox(ep), { coupons: null, reviews: null }, 'not listed: null, not an error');
    console.log('boxes: data, listing, cost, wire shape and the Coupons/Reviews joins ok');
})().catch((e) => { console.error(e); process.exit(1); });
