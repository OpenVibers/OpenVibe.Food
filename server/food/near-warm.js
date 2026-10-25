'use strict';

/**
 * The home's "food near" cities, kept warm. The home links each of NEAR_CITIES as /near?q=<city>; a visitor who follows
 * one should read the cache, not wait on OpenStreetMap's public Overpass servers, which are often overloaded (2026-10-25:
 * every one of these searches failed after 25 s, so each link showed "busy").
 *
 * Every osm.nearWarmMs (6 hours; 0 turns it off), each city is geocoded (cached like any search) and its food bank and
 * grocery area queries are asked again in the background, one at a time and paced like every other call
 * (server/food/upstream.js), when their cached answer is missing or expires within a day. There the budget is
 * osm.nearWarmBudgetMs per query, off any visitor's path. A query that still fails keeps its last answer, which the
 * page shows as it does whenever OSM is down.
 *
 *   createNearWarm({ config, upstream, log, now }) → { start(), stop(), runOnce() → { warmed, fresh, failed } }
 */
const { KINDS, NEAR_CITIES, queryFor, radiusMetres } = require('./places');

const REFRESH_BEFORE_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_MS = 2 * 60_000;

function createNearWarm({ config, upstream, log = console, now = () => Date.now(), cities = NEAR_CITIES }) {
    const osm = config.osm;
    let timer = null;
    let first = null;
    let running = false;

    async function runOnce() {
        const out = { warmed: 0, fresh: 0, failed: 0 };
        if (running) return out;
        running = true;
        try {
            for (const city of cities) {
                let hit;
                try {
                    const g = await upstream.geocode(city, { limit: 1 });
                    hit = Array.isArray(g.body) ? g.body[0] : null;
                } catch { hit = null; }
                const lat = hit && Number(hit.lat);
                const lon = hit && Number(hit.lon);
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) { out.failed += KINDS.length; continue; }
                for (const kind of KINDS) {
                    const query = queryFor(kind, lat, lon, radiusMetres(null, config));
                    const until = await upstream.cachedUntil(query);
                    if (until && Date.parse(until) - now() > REFRESH_BEFORE_MS) { out.fresh++; continue; }
                    try {
                        const r = await upstream.overpass(query, { force: true, budgetMs: osm.nearWarmBudgetMs, tryMs: Math.ceil(osm.nearWarmBudgetMs / 3) });
                        if (r.stale) out.failed++; else out.warmed++;
                    } catch { out.failed++; }
                }
            }
        } finally { running = false; }
        if (out.warmed || out.failed) log.log && log.log(`[OpenVibe.Food] near cities: ${out.warmed} warmed, ${out.fresh} fresh, ${out.failed} not reached`);
        return out;
    }

    return {
        runOnce,
        start() {
            if (!osm.nearWarmMs || timer) return;
            timer = setInterval(() => { runOnce().catch(() => {}); }, osm.nearWarmMs);
            timer.unref();
            first = setTimeout(() => { runOnce().catch(() => {}); }, FIRST_RUN_MS);
            first.unref();
        },
        stop() { clearInterval(timer); clearTimeout(first); timer = null; first = null; },
    };
}

module.exports = { createNearWarm, REFRESH_BEFORE_MS };
