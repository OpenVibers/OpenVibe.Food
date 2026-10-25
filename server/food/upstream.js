'use strict';

/**
 * The only two hosts OpenVibe.Food fetches from: Nominatim (a place name → coordinates) and Overpass (the
 * OpenStreetMap database, for food banks and grocery stores). Both are community services with published usage
 * policies, and this module is what keeps us inside them:
 *
 *   - identify   every request carries FOOD_OSM_USER_AGENT (an OpenVibe.Food contact URL), never a browser's
 *   - pace       one request a second to a host, at most: calls to the same host queue behind each other, so the
 *                service as a whole cannot burst at Nominatim however many visitors arrive at once
 *   - cache      every answer is kept in food_geo_cache for FOOD_GEO_CACHE_TTL_MS (7 days): a place is geocoded once,
 *                an area is queried once, not once per visitor
 *   - bound      area queries are a small `around:` radius and a single kind of tag, never a bulk download
 *
 * Only a URL built from the configured base is ever fetched; nothing a caller sends becomes a URL. There are no
 * other outbound calls in this service.
 */

const crypto = require('crypto');
const geo = require('./store');

class UpstreamError extends Error {
    constructor(code, detail, { status = 502 } = {}) { super(detail); this.code = code; this.status = status; }
}

/** Serialises calls to one host and keeps at least `minIntervalMs` between the moments they start. */
function createPacer({ minIntervalMs, now = () => Date.now() }) {
    let chain = Promise.resolve();
    let last = -Infinity;
    return {
        run(fn) {
            const p = chain.then(async () => {
                const wait = last + minIntervalMs - now();
                if (wait > 0) await new Promise((r) => setTimeout(r, wait));
                last = now();
                return fn();
            });
            chain = p.then(() => undefined, () => undefined);
            return p;
        },
    };
}

const keyOf = (q) => String(q).trim().toLowerCase().replace(/\s+/g, ' ');

function createUpstream({ config, s, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const osm = config.osm;
    const failed = new Map();   // area query key → when it last failed (this process)
    const pacers = new Map();
    const pacerFor = (rawUrl) => {
        const host = new URL(rawUrl).host;
        if (!pacers.has(host)) pacers.set(host, createPacer({ minIntervalMs: osm.minIntervalMs, now }));
        return pacers.get(host);
    };

    /** Fetch a URL built from `base` (never from caller input), with the OSM User-Agent and a hard timeout. */
    async function fetchJson(url, init = {}, { timeoutMs = osm.timeoutMs } = {}) {
        let res;
        try {
            res = await fetchImpl(url.toString(), {
                ...init,
                headers: { 'User-Agent': osm.userAgent, Accept: 'application/json', ...(init.headers || {}) },
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            throw new UpstreamError('food.place.upstream', `the place service could not be reached (${err && err.name === 'TimeoutError' ? 'timed out' : 'network error'})`);
        }
        if (!res.ok) throw new UpstreamError('food.place.upstream', `the place service answered ${res.status}`);
        try { return await res.json(); } catch { throw new UpstreamError('food.place.upstream', 'the place service answered something that is not JSON'); }
    }

    async function cached(key, fn, { failedWithinMs = 0, force = false } = {}) {
        const hit = force ? null : await geo.cacheGet(s, key);
        if (hit) return { body: hit.body, cached: true, fetched_at: hit.fetched_at };
        // The same question failed a moment ago: its last answer if there is one, else the refusal at once.
        if (failedWithinMs && !force && now() - (failed.get(key) || -Infinity) < failedWithinMs) {
            const old = await geo.cacheGet(s, key, { stale: true });
            if (old) return { body: old.body, cached: true, stale: true, fetched_at: old.fetched_at };
            throw new UpstreamError('food.place.upstream', 'OpenStreetMap\'s place servers were busy a moment ago. Try again in a few minutes.');
        }
        let body;
        try { body = await fn(); failed.delete(key); } catch (err) {
            if (failedWithinMs) {
                if (failed.size > 1000) failed.clear();
                failed.set(key, now());
            }
            // OSM not answering: the last answer for the same question, however old (kept 30 days past its TTL).
            const old = await geo.cacheGet(s, key, { stale: true });
            if (old) return { body: old.body, cached: true, stale: true, fetched_at: old.fetched_at };
            throw err;
        }
        const written = await geo.cachePut(s, key, body, osm.cacheTtlMs);
        return { body, cached: false, fetched_at: written.fetched_at };
    }

    /** A place name → up to `limit` matches (Nominatim search), cached for the TTL. */
    function geocode(q, { limit = 1 } = {}) {
        const query = String(q || '').trim().slice(0, 200);
        if (!query) return Promise.reject(new UpstreamError('food.place.invalid', 'q: a place to search for', { status: 422 }));
        const url = new URL(osm.nominatimUrl);
        url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`;
        url.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: String(Math.min(Math.max(limit, 1), 5)), addressdetails: '1' }).toString();
        return cached(`nominatim:${keyOf(query)}:${limit}`, () => pacerFor(osm.nominatimUrl).run(() => fetchJson(url)));
    }

    const overpassKey = (query) => `overpass:${crypto.createHash('sha256').update(query).digest('hex')}`;

    /**
     * One bounded Overpass query → its elements. Cached by the query text, so the same area is asked once. The servers
     * in osm.overpassUrls are tried in order, each for `tryMs` (the last one for what is left of `budgetMs`), so one
     * overloaded server no longer holds the page for the whole budget. A query that just failed refuses at once for
     * osm.retryAfterMs. `force` (the background warmer) asks again even when a cached answer is still fresh.
     */
    function overpass(query, { budgetMs = osm.timeoutMs, tryMs = osm.overpassTryMs, force = false } = {}) {
        const body = `data=${encodeURIComponent(query)}`;
        const urls = osm.overpassUrls && osm.overpassUrls.length ? osm.overpassUrls : [osm.overpassUrl];
        return cached(overpassKey(query), async () => {
            const started = now();
            let tried = 0;
            for (const [i, base] of urls.entries()) {
                const left = budgetMs - (now() - started);
                if (left < 1000) break;
                const timeoutMs = i === urls.length - 1 ? left : Math.min(left, tryMs);
                tried++;
                try {
                    return await pacerFor(base).run(() => fetchJson(new URL(base), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body,
                    }, { timeoutMs }));
                } catch (err) {
                    log.warn && log.warn(`[OpenVibe.Food] Overpass ${new URL(base).host}: ${err.message}`);
                }
            }
            throw new UpstreamError('food.place.upstream', `OpenStreetMap's place servers are busy right now (${tried} tried). Try again in a few minutes.`);
        }, { failedWithinMs: osm.retryAfterMs, force });
    }

    /** When an area query's cached answer expires (an ISO time), or null when there is none or it already has. */
    async function cachedUntil(query) {
        const hit = await geo.cacheGet(s, overpassKey(query));
        return hit ? hit.expires_at : null;
    }

    return { geocode, overpass, cachedUntil, fetchJson, UpstreamError };
}

module.exports = { createUpstream, createPacer, UpstreamError };
