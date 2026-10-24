'use strict';
/**
 * Overpass servers in order (config osm.overpassUrls): when the first one fails or is too slow, the next answers within
 * the same search; when none answers, the last cached answer for the same area stands in (stale); with none, the
 * answer says in plain words that OpenStreetMap is busy. On 2026-10-24 overpass-api.de took 26 s and returned nothing,
 * so every "food near" search waited the whole 25 s budget and said "the place service answered 502". Two stand-in
 * OSMs here; no test calls the real OpenStreetMap.
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
            const r = await search();
            assert.strictEqual(r.status, 502, r.text);
            assert.match(r.text, /OpenStreetMap's place servers are busy right now \(2 tried\)/);
        });
    } finally {
        await t.close();
        await first.close();
        await second.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
