'use strict';
/**
 * "Find food near you" end to end against a stand-in OSM (test/helpers/osm.js): the API and the page, the ODbL
 * attribution and the link back, the escaping of a hostile name from OSM, and the three rules this route lives
 * under — one upstream request a second per host, every answer cached for a week, and a per-caller budget on the
 * search itself. No test here ever calls the real OpenStreetMap.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { startOsm } = require('./helpers/osm');
const { createPacer } = require('../server/food/upstream');
const geo = require('../server/food/store');

const OVERPASS = '/api/interpreter';

(async () => {
    await check('the pace is a queue: concurrent callers are serialised, and a failure does not stall it', async () => {
        const started = [];
        const pacer = createPacer({ minIntervalMs: 50 });
        await Promise.all([1, 2, 3, 4].map(() => pacer.run(async () => { started.push(Date.now()); })));
        assert.strictEqual(started.length, 4);
        for (let i = 1; i < started.length; i++) assert.ok(started[i] - started[i - 1] >= 45, `calls ${started[i] - started[i - 1]} ms apart`);
        await assert.rejects(pacer.run(() => Promise.reject(new Error('boom'))));
        const after = [];
        await pacer.run(async () => after.push(Date.now()));
        assert.strictEqual(after.length, 1, 'the queue kept going after a failure');
    });

    const osm = await startOsm();
    const t = await boot({ env: { ...osm.env, FOOD_OSM_MIN_INTERVAL_MS: '1' } });

    try {
        await check('a cached answer is kept for the TTL and an expired one is ignored', async () => {
            const s = t.ctx.s;
            const written = await geo.cachePut(s, 'nominatim:test ttl:1', [], 7 * 24 * 60 * 60 * 1000);
            const days = (Date.parse(written.expires_at) - Date.parse(written.fetched_at)) / 86_400_000;
            assert.ok(days > 6.9 && days < 7.1, `${days} days`);
            assert.ok(await geo.cacheGet(s, 'nominatim:test ttl:1'), 'a fresh row is a hit');
            await s.db.query(
                `INSERT INTO food_geo_cache (key, body, fetched_at, expires_at) VALUES ($1, $2::jsonb, $3, $4)
                 ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, expires_at = EXCLUDED.expires_at`,
                ['nominatim:stale:1', JSON.stringify([]), '2020-01-01T00:00:00.000Z', '2020-01-08T00:00:00.000Z']);
            assert.strictEqual(await geo.cacheGet(s, 'nominatim:stale:1'), null, 'a row past its TTL is not a hit');
        });

        await check('the place search geocodes a name, lists food banks nearest first, and carries the ODbL attribution', async () => {
            const r = await t.get(`/api/v1/places?q=${encodeURIComponent('Springfield, Illinois')}&kind=foodbank`);
            assert.strictEqual(r.status, 200, r.text);
            const b = r.json();
            assert.strictEqual(b.location.from, 'geocode');
            assert.strictEqual(b.location.lat, 39.7817);
            assert.strictEqual(b.kind, 'foodbank');
            assert.strictEqual(b.results.length, 4, JSON.stringify(b.results.map((x) => x.name)));
            assert.strictEqual(b.results[0].name, 'Springfield Food Pantry');
            assert.ok(b.results[0].distance_km < b.results[1].distance_km, 'nearest first');
            assert.strictEqual(b.results[0].address, '12, Main Street, Springfield, IL');
            assert.match(b.results[0].opening_hours, /Mo-Fr 09:00-16:00/);
            assert.strictEqual(b.results[0].wheelchair, true);
            assert.strictEqual(b.results[0].osm_url, 'https://www.openstreetmap.org/node/101');
            assert.ok(b.results.some((x) => x.type_label === 'Soup kitchen'), 'a soup kitchen is labelled as one');
            assert.ok(b.results.some((x) => x.name === 'Free pantry box'), 'an unnamed one falls back to its type label');
            assert.strictEqual(b.counts.total, 4);
            assert.strictEqual(b.attribution.text, '© OpenStreetMap contributors');
            assert.strictEqual(b.attribution.url, 'https://www.openstreetmap.org/copyright');
            assert.strictEqual(b.attribution.license, 'ODbL 1.0');
            assert.match(b.fetched_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
            assert.strictEqual(b.cached, false, 'the first search fetched');
            // One geocode and one area query: never a bulk download, and nothing else.
            assert.deepStrictEqual(osm.requests.map((q) => q.path).sort(), ['/search', OVERPASS].sort());
            assert.match(osm.requests.find((q) => q.path === OVERPASS).body, /around%3A\d+%2C39\.7817/);
        });

        await check('the same place is not asked of OpenStreetMap twice: the second search is served from the cache', async () => {
            const before = osm.requests.length;
            const r = await t.get('/api/v1/places?lat=39.7817&lon=-89.6501&kind=foodbank');
            assert.strictEqual(r.status, 200, r.text);
            const b = r.json();
            assert.strictEqual(b.cached, true);
            assert.strictEqual(osm.requests.length, before, 'a cache hit makes no upstream request');
            assert.strictEqual(b.results.length, 4);
            assert.strictEqual(b.fetched_at, (await t.get('/api/v1/places?lat=39.7817&lon=-89.6501&kind=foodbank')).json().fetched_at, 'the cached fetched_at is kept');
        });

        await check('grocery stores come with the budget mark, and a page shows the results and the attribution link', async () => {
            const r = await t.get('/api/v1/places?lat=39.7817&lon=-89.6501&kind=grocery');
            assert.strictEqual(r.status, 200, r.text);
            const b = r.json();
            const aldi = b.results.find((x) => x.name === 'Aldi');
            assert.ok(aldi, 'Aldi is listed');
            assert.strictEqual(aldi.budget, true, 'a discount chain is marked budget');
            assert.strictEqual(b.results.find((x) => x.name === 'Corner Market').budget, false);
            assert.strictEqual(b.results.find((x) => x.name === 'Dollar Tree').budget, true, 'a variety store is a budget store');
            assert.strictEqual(b.counts.budget_grocery, 2);

            const pageRes = await t.get('/near?q=Springfield%2C%20Illinois&kind=grocery');
            assert.strictEqual(pageRes.status, 200);
            assert.match(pageRes.text, /Aldi/);
            assert.match(pageRes.text, /OpenStreetMap contributors/);
            assert.match(pageRes.text, /https:\/\/www\.openstreetmap\.org\/copyright/, 'the attribution is linked back');
            assert.match(pageRes.text, /https:\/\/opendatacommons\.org\/licenses\/odbl\/1-0\//, 'the ODbL is linked');
            assert.match(pageRes.text, /class="badge ok">budget</, 'the budget badge is shown');
        });

        await check('a name from OpenStreetMap is escaped on the page, never taken as markup', async () => {
            osm.state.overpass = { ...osm.state.overpass, foodbank: { elements: [
                { type: 'node', id: 301, lat: 40.0, lon: -90.0, tags: { amenity: 'social_facility', social_facility: 'food_bank', name: '<script>alert(1)</script> Pantry', 'addr:city': 'Riverton' } },
            ] } };
            const api = await t.get('/api/v1/places?lat=40&lon=-90&kind=foodbank');
            assert.strictEqual(api.status, 200, api.text);
            assert.strictEqual(api.json().results[0].name, '<script>alert(1)</script> Pantry', 'the API hands back what OSM said');

            const page = await t.get('/near?lat=40&lon=-90&kind=foodbank');
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('&lt;script&gt;alert(1)&lt;/script&gt; Pantry'), 'the name is escaped on the page');
            assert.ok(!page.text.includes('<script>alert(1)</script>'), 'no live script reaches the page');
        });

        await check('public reads need no token, and bad input is refused with a stable code', async () => {
            assert.strictEqual((await t.get('/api/v1/places?kind=foodbank')).status, 422, 'no q and no coordinates');
            const bad = await t.get('/api/v1/places?q=Springfield&kind=restaurants');
            assert.strictEqual(bad.status, 422);
            assert.match(bad.headers.get('content-type'), /application\/problem\+json/);
            assert.strictEqual(bad.json().code, 'food.place.invalid');
            const missing = await t.get('/api/v1/places?q=Nowhere%20At%20All');
            assert.strictEqual(missing.status, 404, 'a place Nominatim does not know');
            assert.strictEqual(missing.json().code, 'food.place.not_found');
        });

        await check('when OSM cannot be reached the route says so and does not hang', async () => {
            osm.state.fail = true;
            const r = await t.get('/api/v1/places?lat=41&lon=-91&kind=foodbank');
            assert.strictEqual(r.status, 502);
            assert.strictEqual(r.json().code, 'food.place.upstream');
            const page = await t.get('/near?lat=41&lon=-91');
            assert.strictEqual(page.status, 200, 'the page still renders');
            assert.match(page.text, /the place service answered 503/, 'the page says what went wrong');
            osm.state.fail = false;
        });
    } finally {
        await t.close();
        await osm.close();
    }

    // ── The pace: a boot of its own, with the policy's real one second ──
    const osm2 = await startOsm();
    const t2 = await boot({ env: { ...osm2.env, FOOD_OSM_MIN_INTERVAL_MS: '1000' } });
    try {
        await check('no two requests to the same OSM host start less than a second apart', async () => {
            const r = await t2.get(`/api/v1/places?q=${encodeURIComponent('Springfield, Illinois')}&kind=foodbank`);
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(osm2.requests.length, 2, JSON.stringify(osm2.requests));
            const gaps = osm2.gaps();
            assert.ok(gaps.length === 1 && gaps[0] >= 950, `the two calls were ${gaps[0]} ms apart`);
        });

        await check('with no stand-in named, the service never reaches the real OpenStreetMap', async () => {
            // test/helpers/boot.js points both hosts at a closed local port; the call fails at once and says so.
            const offline = await boot();
            try {
                const r = await offline.get('/api/v1/places?lat=51.5&lon=-0.1&kind=foodbank');
                assert.strictEqual(r.status, 502);
                assert.strictEqual(r.json().code, 'food.place.upstream');
                assert.match(r.json().detail, /could not be reached/);
            } finally { await offline.close(); }
        });

        await check('a caller cannot spend OpenStreetMap\'s budget: the place search is limited per caller', async () => {
            const limited = await boot({ env: { ...osm2.env, FOOD_OSM_MIN_INTERVAL_MS: '1' }, callerLimits: true, limitsNow: () => Date.UTC(2026, 9, 8, 12, 0, 0) });
            try {
                const from = { headers: { 'x-forwarded-for': '203.0.113.44' } };
                let refused = null;
                for (let i = 0; i < 11 && !refused; i++) refused = (await limited.get('/api/v1/places?lat=39.7817&lon=-89.6501&kind=foodbank', from)).status === 429 ? i + 1 : null;
                assert.strictEqual(refused, 11, 'the eleventh search in the minute is refused');
                const r = await limited.get('/api/v1/places?lat=39.7817&lon=-89.6501&kind=foodbank', from);
                assert.strictEqual(r.status, 429);
                assert.strictEqual(r.json().code, 'rate_limited');
                assert.ok(Number(r.headers.get('retry-after')) > 0);
                // Another caller is unaffected, and the food list is not part of the place budget.
                assert.strictEqual((await limited.get('/api/v1/places?lat=39.7817&lon=-89.6501&kind=foodbank', { headers: { 'x-forwarded-for': '203.0.113.45' } })).status, 200);
                assert.strictEqual((await limited.get('/api/v1/foods', from)).status, 200);
            } finally { await limited.close(); }
        });
    } finally {
        await t2.close();
        await osm2.close();
    }
    done();
})();
