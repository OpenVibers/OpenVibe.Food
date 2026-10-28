'use strict';

/**
 * What OpenVibe.Coupons and OpenVibe.Reviews know about a food box, read from their public APIs when a box is shown
 * (./boxes.js): the shop's active codes and its best one, and the service's score with how many it rests on. Each
 * answer is kept ten minutes (a miss too, so a box nobody lists asks once), and a slow or absent neighbour never holds
 * the page: after 1.5 s the box shows without it. Off (null, no requests) when the service's address is not set, as in
 * tests and development.
 *
 *   createBoxLinks({ couponsUrl, reviewsUrl, fetch })  → { forBox(box) → { coupons, reviews }, clear() }
 *     coupons  { url, active, best: { code, title } | null } | null   (null: no shop for the box's site, or off)
 *     reviews  { url, name, percent, total, line } | null             (null: no entry for it yet, or off)
 */

const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 1500;

function createBoxLinks({ couponsUrl = '', reviewsUrl = '', fetch: fetchImpl = globalThis.fetch } = {}) {
    const cache = new Map();   // key → { at, value }
    const getJson = async (url, init = {}) => {
        const res = await fetchImpl(url, { ...init, headers: { accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (res.status === 404 || res.status === 422) return null;
        if (!res.ok) throw new Error(`${res.status}`);
        return await res.json();
    };
    const cached = async (key, fn) => {
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
        let value = null;
        try { value = await fn(); } catch { value = hit ? hit.value : null; }   // a failed read keeps the last answer
        cache.set(key, { at: Date.now(), value });
        return value;
    };

    async function coupons(box) {
        if (!couponsUrl) return null;
        return await cached(`c:${box.host}`, async () => {
            const found = await getJson(`${couponsUrl}/api/v1/merchants/resolve?host=${encodeURIComponent(box.host)}`);
            if (!found || !found.merchant) return null;
            const list = await getJson(`${couponsUrl}/api/v1/merchants/${encodeURIComponent(found.merchant.id)}/coupons`);
            const codes = (list && list.coupons) || [];
            const working = codes.filter((c) => c.status === 'reported_working').sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
            return { url: found.merchant.url, active: codes.length, best: working ? { code: String(working.code).slice(0, 40), title: String(working.title || '').slice(0, 120) } : null };
        });
    }

    async function reviews(box) {
        if (!reviewsUrl) return null;
        return await cached(`r:${box.slug}`, async () => {
            const found = await getJson(`${reviewsUrl}/api/v1/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: box.name, url: box.url }) });
            const entity = found && (found.entity || (found.candidates && found.candidates.length === 1 ? found.candidates[0].entity : null));
            if (!entity) return null;
            const agg = await getJson(`${reviewsUrl}/api/v1/entities/${encodeURIComponent(entity.slug || entity.id)}/aggregate`);
            const rec = agg && agg.aggregate && agg.aggregate.result && agg.aggregate.result.components && agg.aggregate.result.components.recommendation;
            const percent = rec && Number.isFinite(Number(rec.percent)) ? Number(rec.percent) : null;
            const total = rec && Number.isFinite(Number(rec.total)) ? Number(rec.total) : null;
            return { url: entity.url, name: entity.name, percent, total, line: percent != null ? `${percent}% recommend (${total})` : null };
        });
    }

    return {
        async forBox(box) {
            const [c, r] = await Promise.all([coupons(box), reviews(box)]);
            return { coupons: c, reviews: r };
        },
        clear: () => cache.clear(),
    };
}

module.exports = { createBoxLinks };
