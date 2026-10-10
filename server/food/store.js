'use strict';

/**
 * What OpenVibe.Food keeps in its own database (migrations/0002_food.sql): the cache in front of the two OpenStreetMap
 * services, saved meal plans and a person's pantry list. Every function takes the store (server/db.js createStore)
 * first; nothing here is a secret, and the cache body is only ever an upstream answer, never a person's data.
 */

const PLAN_LIST_LIMIT = 50;

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

// ── food_geo_cache ───────────────────────────────────────────
/** A cached upstream answer that has not expired, or null. */
async function cacheGet(s, key) {
    const row = await s.db.maybe('SELECT body, fetched_at, expires_at FROM food_geo_cache WHERE key = $1', [key]);
    if (!row || row.expires_at <= s.iso()) return null;
    return { body: parse(row.body), fetched_at: row.fetched_at, expires_at: row.expires_at };
}
async function cachePut(s, key, body, ttlMs) {
    const fetchedAt = s.iso();
    const expiresAt = new Date(s.now() + ttlMs).toISOString();
    await s.db.query(
        `INSERT INTO food_geo_cache (key, body, fetched_at, expires_at) VALUES ($1, $2::jsonb, $3, $4)
         ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
        [key, JSON.stringify(body), fetchedAt, expiresAt]);
    return { fetched_at: fetchedAt, expires_at: expiresAt };
}
/** Drop expired rows (called at boot; the table stays small because every answer is bounded). */
const cachePrune = (s) => s.db.exec('DELETE FROM food_geo_cache WHERE expires_at <= $1', [s.iso()]);

/**
 * Prune the geo cache now, then hourly: an expired row is ignored anyway, this only keeps the table small. The
 * interval is unref'd so it never holds the process open; the returned timer is what the entry point clears on
 * shutdown (server/index.js). This repository has no restore-drill mode; if one is added it must skip this timer,
 * because a drill reads a restored database and must not write to it.
 */
function startCachePrune(s, { intervalMs = 60 * 60 * 1000, log = console } = {}) {
    const tick = () => Promise.resolve(cachePrune(s)).catch((err) => log.warn('[OpenVibe.Food] geo cache prune:', err && err.message));
    tick();
    const timer = setInterval(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
}

// ── food_plans ───────────────────────────────────────────────
async function insertPlan(s, p) {
    await s.db.query(
        'INSERT INTO food_plans (id, owner, title, people, days, budget, plan, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)',
        [p.id, p.owner, p.title || null, p.people, p.days, p.budget, JSON.stringify(p.plan), p.created_at]);
    return planRow(s, p.owner, p.id);
}
const planRow = (s, owner, id) => s.db.maybe('SELECT * FROM food_plans WHERE owner = $1 AND id = $2', [owner, id]);
async function listPlans(s, owner, { limit = 20 } = {}) {
    return s.db.many('SELECT * FROM food_plans WHERE owner = $1 ORDER BY id DESC LIMIT $2', [owner, Math.min(limit, PLAN_LIST_LIMIT)]);
}
const deletePlan = (s, owner, id) => s.db.exec('DELETE FROM food_plans WHERE owner = $1 AND id = $2', [owner, id]);

const planToWire = (row) => ({
    id: row.id, title: row.title || null, people: Number(row.people), days: Number(row.days),
    budget: row.budget == null ? null : Number(row.budget), created_at: row.created_at, plan: parse(row.plan),
});

// ── food_pantry ──────────────────────────────────────────────
const getPantry = async (s, owner) => (await s.db.many('SELECT item, added_at FROM food_pantry WHERE owner = $1 ORDER BY item', [owner])).map((r) => r.item);
const pantryRows = (s, owner) => s.db.many('SELECT item, added_at FROM food_pantry WHERE owner = $1 ORDER BY item', [owner]);
/** Replace a person's pantry with exactly this list, in one transaction (what PUT means). */
async function setPantry(s, owner, items) {
    const addedAt = s.iso();
    await s.tx(async () => {
        await s.db.query('DELETE FROM food_pantry WHERE owner = $1', [owner]);
        for (const item of items) await s.db.query('INSERT INTO food_pantry (owner, item, added_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [owner, item, addedAt]);
    });
    return items.slice().sort();
}

module.exports = {
    cacheGet, cachePut, cachePrune, startCachePrune,
    insertPlan, planRow, listPlans, deletePlan, planToWire,
    getPantry, pantryRows, setPantry,
};
