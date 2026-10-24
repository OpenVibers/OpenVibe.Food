'use strict';

/**
 * What OpenVibe.Food keeps in its own database (migrations/0002_food.sql): the cache in front of the two OpenStreetMap
 * services, saved meal plans and a person's pantry list. Every function takes the store (server/db.js createStore)
 * first; nothing here is a secret, and the cache body is only ever an upstream answer, never a person's data.
 */

const PLAN_LIST_LIMIT = 50;
const RECIPE_SUGGESTION_LIST_LIMIT = 20;

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

// ── food_geo_cache ───────────────────────────────────────────
/** A cached upstream answer that has not expired, or null. */
// An expired answer is kept this long after its TTL, only to stand in when OpenStreetMap is not answering (stale).
const STALE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
async function cacheGet(s, key, { stale = false } = {}) {
    const row = await s.db.maybe('SELECT body, fetched_at, expires_at FROM food_geo_cache WHERE key = $1', [key]);
    if (!row || (!stale && row.expires_at <= s.iso())) return null;
    return { body: parse(row.body), fetched_at: row.fetched_at, expires_at: row.expires_at, stale: row.expires_at <= s.iso() };
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
const cachePrune = (s) => s.db.exec('DELETE FROM food_geo_cache WHERE expires_at <= $1', [new Date(s.now() - STALE_KEEP_MS).toISOString()]);

/**
 * Prune the geo cache now, then hourly: a row 30 days past its TTL goes (until then it only stands in when OSM is down;
 * an expired row is otherwise ignored), which keeps the table small. The
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

// ── Plan together: households (migrations/0005_plan_households.sql) ──
const MEMBERS_MAX = 12;          // people in one household besides its owner
const SHARED_PLANS_MAX = 50;     // households one person may belong to

/** The plan and the viewer's place in it ('owner' or 'member'), or null when it is neither theirs nor shared with them. */
async function planForViewer(s, viewer, id) {
    const row = await s.db.maybe('SELECT * FROM food_plans WHERE id = $1', [id]);
    if (!row) return null;
    if (row.owner === viewer) return { row, role: 'owner' };
    const m = await s.db.maybe('SELECT 1 AS ok FROM food_plan_members WHERE plan_id = $1 AND member = $2', [id, viewer]);
    return m ? { row, role: 'member' } : null;
}
const setChatRoom = (s, owner, id, slug) => s.db.exec('UPDATE food_plans SET chat_room = $3 WHERE owner = $1 AND id = $2', [owner, id, slug]);
const setShareHash = (s, owner, id, hash) => s.db.exec('UPDATE food_plans SET share_hash = $3 WHERE owner = $1 AND id = $2', [owner, id, hash]);
const planByShareHash = (s, hash) => s.db.maybe('SELECT * FROM food_plans WHERE share_hash = $1', [hash]);
const listMembers = (s, planId) => s.db.many('SELECT member, name, joined_at FROM food_plan_members WHERE plan_id = $1 ORDER BY joined_at', [planId]);
const listSharedPlans = (s, member) => s.db.many(
    'SELECT p.*, m.joined_at FROM food_plan_members m JOIN food_plans p ON p.id = m.plan_id WHERE m.member = $1 ORDER BY m.joined_at DESC LIMIT $2',
    [member, SHARED_PLANS_MAX]);

/** Join a household: 'joined', 'already', or a refusal code (food.plan.full, food.plan.too_many). */
async function addMember(s, planId, member, name, at) {
    return s.tx(async () => {
        if (await s.db.maybe('SELECT 1 AS ok FROM food_plan_members WHERE plan_id = $1 AND member = $2', [planId, member])) return 'already';
        const n = await s.db.maybe('SELECT COUNT(*)::int AS n FROM food_plan_members WHERE plan_id = $1', [planId]);
        if (Number(n.n) >= MEMBERS_MAX) return 'food.plan.full';
        const mine = await s.db.maybe('SELECT COUNT(*)::int AS n FROM food_plan_members WHERE member = $1', [member]);
        if (Number(mine.n) >= SHARED_PLANS_MAX) return 'food.plan.too_many';
        await s.db.exec('INSERT INTO food_plan_members (plan_id, member, name, joined_at) VALUES ($1, $2, $3, $4)', [planId, member, name || null, at]);
        return 'joined';
    });
}
const removeMember = (s, planId, member) => s.db.exec('DELETE FROM food_plan_members WHERE plan_id = $1 AND member = $2', [planId, member]);

const listTicks = (s, planId) => s.db.many('SELECT item, ticked_by, name, ticked_at FROM food_plan_ticks WHERE plan_id = $1', [planId]);
const tick = (s, planId, item, by, name, at) => s.db.exec(
    `INSERT INTO food_plan_ticks (plan_id, item, ticked_by, name, ticked_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (plan_id, item) DO UPDATE SET ticked_by = EXCLUDED.ticked_by, name = EXCLUDED.name, ticked_at = EXCLUDED.ticked_at`,
    [planId, item, by, name || null, at]);
const untick = (s, planId, item) => s.db.exec('DELETE FROM food_plan_ticks WHERE plan_id = $1 AND item = $2', [planId, item]);

const planToWire = (row) => ({
    id: row.id, title: row.title || null, people: Number(row.people), days: Number(row.days),
    budget: row.budget == null ? null : Number(row.budget), created_at: row.created_at, plan: parse(row.plan),
});

// ── food_pantry ──────────────────────────────────────────────
const getPantry = async (s, owner) => (await s.db.many('SELECT item, added_at FROM food_pantry WHERE owner = $1 ORDER BY item', [owner])).map((r) => r.item);
const pantryRows = (s, owner) => s.db.many('SELECT item, added_at FROM food_pantry WHERE owner = $1 ORDER BY item', [owner]);
/** Add one item to a person's pantry (pantry by barcode); already there is fine. */
const addPantryItem = (s, owner, item) => s.db.query('INSERT INTO food_pantry (owner, item, added_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [owner, item, s.iso()]);
/** Replace a person's pantry with exactly this list, in one transaction (what PUT means). */
async function setPantry(s, owner, items) {
    const addedAt = s.iso();
    await s.tx(async () => {
        await s.db.query('DELETE FROM food_pantry WHERE owner = $1', [owner]);
        for (const item of items) await s.db.query('INSERT INTO food_pantry (owner, item, added_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [owner, item, addedAt]);
    });
    return items.slice().sort();
}

// ── food_recipe_suggestions ─────────────────────────────────
async function insertRecipeSuggestion(s, r) {
    await s.db.query(
        'INSERT INTO food_recipe_suggestions (id, subject_id, created_at, ask, people, ai_run_id, recipes) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)',
        [r.id, r.subject_id, r.created_at, r.ask || null, r.people == null ? null : r.people, r.ai_run_id || null, JSON.stringify(r.recipes)]);
    // Food keeps the last 20 suggestions per person; the oldest drop out.
    await s.db.exec(
        'DELETE FROM food_recipe_suggestions WHERE subject_id = $1 AND id NOT IN (SELECT id FROM food_recipe_suggestions WHERE subject_id = $1 ORDER BY id DESC LIMIT $2)',
        [r.subject_id, RECIPE_SUGGESTION_LIST_LIMIT]);
    return recipeSuggestionRow(s, r.subject_id, r.id);
}
const recipeSuggestionRow = (s, subjectId, id) => s.db.maybe('SELECT * FROM food_recipe_suggestions WHERE subject_id = $1 AND id = $2', [subjectId, id]);
async function listRecipeSuggestions(s, subjectId, { limit = 20 } = {}) {
    return s.db.many('SELECT * FROM food_recipe_suggestions WHERE subject_id = $1 ORDER BY id DESC LIMIT $2', [subjectId, Math.min(limit, RECIPE_SUGGESTION_LIST_LIMIT)]);
}
/** The number of suggestions a person made on or after `since` (an ISO date, for the daily cap). */
const countRecipeSuggestionsSince = (s, subjectId, since) => s.db.value('SELECT count(*)::int FROM food_recipe_suggestions WHERE subject_id = $1 AND created_at >= $2', [subjectId, since]);

const recipeSuggestionToWire = (row) => ({
    id: row.id, created_at: row.created_at, ask: row.ask || null,
    people: row.people == null ? null : Number(row.people), ai_run_id: row.ai_run_id || null,
    recipes: parse(row.recipes),
});

module.exports = {
    cacheGet, cachePut, cachePrune, startCachePrune,
    insertPlan, planRow, listPlans, deletePlan, planToWire,
    planForViewer, setChatRoom, setShareHash, planByShareHash, listMembers, listSharedPlans, addMember, removeMember, listTicks, tick, untick,
    MEMBERS_MAX, SHARED_PLANS_MAX,
    getPantry, pantryRows, setPantry, addPantryItem,
    insertRecipeSuggestion, recipeSuggestionRow, listRecipeSuggestions, countRecipeSuggestionsSince, recipeSuggestionToWire,
};
