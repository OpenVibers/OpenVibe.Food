'use strict';
/**
 * Overpass servers in order (config osm.overpassUrls): when the first one fails or is too slow, the next answers within
 * the same search; when none answers, the last cached answer for the same area stands in (stale); with none, the
 * answer says in plain words that OpenStreetMap is busy. On 2026-10-24 overpass-api.de took 26 s and returned nothing,
 * so every "food near" search waited the whole 25 s budget and said "the place service answered 502". A query that just
 * failed refuses at once for a while instead of waiting the budget again; the home's cities are warmed in the background
 * (server/food/near-warm.js), past that memory, with a budget of their own. Two stand-in OSMs here; no test calls the
 * real OpenStreetMap.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { startOsm } = require('./helpers/osm');

(async () => {
    const first = await startOsm();
    const second = await startOsm();
    const t = await boot({ env: {
        ...first.env, FOOD_OSM_MIN_INTERVAL_MS: '1', FOOD_OVERPASS_TRY_MS: '1000',
        FOOD_OVERPASS_FALLBACK_URLS: `${second.url}/api/interpreter`,
    } });
    const search = (q = 'Springfield, Illinois') => t.get(`/api/v1/places?q=${encodeURIComponent(q)}&kind=foodbank`);
    // A point search: its own area query, so the failure remembered for Springfield's (just above) does not answer it.
    const point = () => t.get('/api/v1/places?lat=39.79&lon=-89.65&kind=foodbank');
    const overpassCalls = (osm) => osm.requests.filter((r) => r.path === '/api/interpreter').length;
    const clearOverpassCache = () => t.ctx.s.db.query("DELETE FROM food_geo_cache WHERE key LIKE 'overpass:%'");

    try {
        await check('the first Overpass server answers 503: the next one gives the food banks in the same search', async () => {
            first.state.overpassFail = true;
            const r = await search();
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().results.length, 4);
            assert.strictEqual(overpassCalls(first), 1);
            assert.strictEqual(overpassCalls(second), 1, 'the fallback server was asked once');
            first.state.overpassFail = false;
        });

        await check('the server that answered last is asked first: the next search goes straight to it', async () => {
            await clearOverpassCache();
            first.state.overpassFail = false;
            const before = [overpassCalls(first), overpassCalls(second)];
            const r = await search();
            assert.strictEqual(r.status, 200, r.text);
            assert.deepStrictEqual([overpassCalls(first) - before[0], overpassCalls(second) - before[1]], [0, 1], 'the fallback that answered went first');
            second.state.overpassFail = true;
            await clearOverpassCache();
            assert.strictEqual((await search()).status, 200, 'it fails: the others are still tried in order');
            second.state.overpassFail = false;
        });

        await check('the first server is too slow: after its share of the budget the next one answers', async () => {
            await clearOverpassCache();
            first.state.overpassDelayMs = 5000;
            const started = Date.now();
            const r = await search();
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().results.length, 4);
            assert.ok(Date.now() - started < 4000, `answered in ${Date.now() - started} ms, not after the slow server`);
        });

        await check('no server answers: the cached answer for the same area stands in, even past its TTL', async () => {
            await t.ctx.s.db.query("UPDATE food_geo_cache SET expires_at = '2020-01-01T00:00:00.000Z' WHERE key LIKE 'overpass:%'");
            first.state.overpassFail = true;
            second.state.overpassFail = true;
            const r = await search();
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().results.length, 4, 'the stale answer');
        });

        await check('no server answers and nothing is cached: OpenStreetMap is busy, said plainly', async () => {
            await clearOverpassCache();
            const r = await point();
            assert.strictEqual(r.status, 502, r.text);
            assert.match(r.text, /OpenStreetMap's place servers are busy right now \(2 tried\)/);
        });

        await check('asked again at once after that: the same answer without waiting on the servers again', async () => {
            const before = overpassCalls(first) + overpassCalls(second);
            const started = Date.now();
            const r = await point();
            assert.strictEqual(r.status, 502, r.text);
            assert.match(r.text, /were busy a moment ago/);
            assert.strictEqual(overpassCalls(first) + overpassCalls(second), before, 'no server was asked');
            assert.ok(Date.now() - started < 1000, `answered in ${Date.now() - started} ms`);
        });

        await check('the home\'s cities warm in the background, past that memory; then a visitor reads the cache, and fresh ones are left alone', async () => {
            first.state.overpassFail = false;
            second.state.overpassFail = false;
            const { createNearWarm } = require('../server/food/near-warm');
            const warm = createNearWarm({ config: t.ctx.config, upstream: t.ctx.upstream, cities: ['Springfield, Illinois'], log: {} });
            assert.deepStrictEqual(await warm.runOnce(), { warmed: 2, fresh: 0, failed: 0 }, 'food banks and grocery stores, asked again though the food bank query failed a moment ago');
            const before = overpassCalls(first) + overpassCalls(second);
            const r = await search();
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().results.length, 4);
            assert.strictEqual(overpassCalls(first) + overpassCalls(second), before, 'the visitor read the cache');
            assert.deepStrictEqual(await warm.runOnce(), { warmed: 0, fresh: 2, failed: 0 }, 'not asked again while fresh');
        });
    } finally {
        await t.close();
        await first.close();
        await second.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
