'use strict';

/**
 * A household's chat (the owner's Q15: a household with a shared pantry and a group chat with an AI member that knows
 * it). A household is a saved plan shared with its members (migrations/0005). Its owner can open a private room on
 * OpenVibe.Chat for it: Food calls Chat's room API as the owner (their own Network token from this site's session),
 * makes the room, adds every member by account subject, and adds an AI member, Pantry, linked to this plan. When
 * someone writes @pantry there, Chat reads contextOf() through GET /internal/households/:planId/chat-context with its
 * service token (food.household.read) and the AI answers knowing the plan, what is still to buy and every member's
 * cupboard.
 *
 *   contextOf(s, planId)                          → { text, source, updated_at } | null
 *   openRoom(deps, s, row, members)               → { ok, slug } | { ok: false, detail }
 *   syncMembers(deps, row, members)               adds members who joined since (the owner's page view, at most every
 *                                                 ten minutes a plan)
 *
 * deps: { config, token, fetchImpl, log }. Food stores only the room's slug (food_plans.chat_room).
 */
const foods = require('./foods');
const store = require('./store');

const AI_NAME = 'Pantry';
const PERSONA = 'A friendly, practical cook for this household. Suggest cheap, simple meals from what is already in our cupboards and on our plan, say what we would still need to buy, and keep answers short.';
const SOURCE = 'OpenVibe.Food household';
const synced = new Map();   // plan id → last member sync (ms)

const nameOfFood = (slug) => { const f = foods.getFood(slug); return f ? f.name : slug; };
const list = (items, empty = 'nothing') => (items.length ? items.join(', ') : empty);

/** The household as text for the AI member: who, the plan, what is left to buy, and every cupboard. */
async function contextOf(s, planId) {
    const row = await s.db.maybe('SELECT * FROM food_plans WHERE id = $1', [planId]);
    if (!row) return null;
    const plan = typeof row.plan === 'string' ? JSON.parse(row.plan) : row.plan;
    const [members, ticks] = await Promise.all([store.listMembers(s, row.id), store.listTicks(s, row.id)]);
    const ticked = new Set(ticks.map((t) => t.item));
    const people = [{ who: row.owner, name: 'the plan\'s owner' }, ...members.map((m) => ({ who: m.member, name: m.name || 'a member' }))];
    const lines = [];
    lines.push(`Household: ${people.map((p) => p.name).join(', ')} (${people.length} ${people.length === 1 ? 'person' : 'people'}).`);
    lines.push(`Plan "${row.title || 'Meal plan'}": ${plan.spec.people} ${plan.spec.people === 1 ? 'person' : 'people'}, ${plan.spec.days} ${plan.spec.days === 1 ? 'day' : 'days'}${plan.spec.budget != null ? `, budget ${plan.spec.budget} USD` : ''}, estimated ${plan.totals.cost} USD.`);
    const toBuy = plan.shopping_list.filter((i) => !ticked.has(i.slug)).map((i) => `${i.name} ×${i.packs}`);
    const got = plan.shopping_list.filter((i) => ticked.has(i.slug)).map((i) => i.name);
    lines.push(`Still to buy: ${list(toBuy)}.`);
    if (got.length) lines.push(`Already bought: ${list(got)}.`);
    const menu = (plan.menu || []).slice(0, 7).map((d) => `Day ${d.day}: ${['breakfast', 'lunch', 'dinner', 'snack'].map((k) => `${k} ${list(d[k] || [], '-')}`).join('; ')}`);
    if (menu.length) lines.push(`The plan's meals:\n${menu.join('\n')}`);
    for (const p of people) {
        const items = await store.getPantry(s, p.who);
        lines.push(`${p.name === 'the plan\'s owner' ? 'The owner\'s' : `${p.name}'s`} cupboard: ${list(items.map(nameOfFood), 'empty (nothing listed on OpenVibe.Food)')}.`);
    }
    return { text: lines.join('\n').slice(0, 4000), source: SOURCE, updated_at: new Date(s.now()).toISOString() };
}

async function chatCall(deps, method, path, body) {
    const res = await (deps.fetchImpl || globalThis.fetch)(`${deps.config.chat.internalUrl}/api/chat/rooms${path}`, {
        method,
        headers: { Authorization: `Bearer ${deps.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body: json };
}

const subjectOf = (requester) => String(requester || '').replace(/^user:/, '');

/** Make the household's room on Chat (private), add its members and Pantry. */
async function openRoom(deps, s, row, members) {
    if (!deps.token) return { ok: false, detail: 'Sign in again, then start the chat.' };
    const slug = `household-${row.id.slice(-10).toLowerCase()}`;
    const name = `${String(row.title || 'Our household').slice(0, 30)} household`.replace(/\s+/g, ' ').trim();
    let made = await chatCall(deps, 'POST', '/', { name, slug, topic: 'Our meal plan, our shopping and what to cook. Write @pantry to ask the AI.', visibility: 'private' });
    if (!made.ok && made.status !== 409) {
        (deps.log || console).warn(`[Food] household chat for ${row.id}: Chat answered ${made.status}`);
        return { ok: false, detail: made.status === 401 ? 'Sign in again, then start the chat.' : 'OpenVibe.Chat did not make the room just now. Try again in a minute.' };
    }
    if (!made.ok) {
        // 409: the address exists. It is this household's room only if this person owns it.
        const mine = await chatCall(deps, 'GET', `/${slug}`);
        if (!mine.ok || !mine.body || !mine.body.room || mine.body.room.role !== 'owner') return { ok: false, detail: 'A room with this household\'s address already exists on OpenVibe.Chat.' };
        made = mine;
    }
    await addMembers(deps, slug, members);
    const ai = await chatCall(deps, 'POST', `/${slug}/ai-members`, { name: AI_NAME, persona: PERSONA, link_service: 'food', link_resource: row.id });
    if (!ai.ok && ai.status !== 409) (deps.log || console).warn(`[Food] household chat ${slug}: adding ${AI_NAME} answered ${ai.status}`);
    await store.setChatRoom(s, row.owner, row.id, slug);
    synced.set(row.id, Date.now());
    return { ok: true, slug };
}

async function addMembers(deps, slug, members) {
    for (const m of members) {
        const r = await chatCall(deps, 'POST', `/${slug}/members`, { subject: subjectOf(m.member), role: 'member' });
        if (!r.ok) (deps.log || console).warn(`[Food] household chat ${slug}: a member could not be added (${r.status})`);
    }
}

/** On the owner's page view: add anyone who joined the household since the last sync (every ten minutes at most). */
async function syncMembers(deps, row, members, { now = Date.now() } = {}) {
    if (!row.chat_room || !deps.token) return;
    const last = synced.get(row.id) || 0;
    if (now - last < 600_000) return;
    synced.set(row.id, now);
    if (synced.size > 2000) synced.delete(synced.keys().next().value);
    await addMembers(deps, row.chat_room, members);
}

function _reset() { synced.clear(); }

module.exports = { AI_NAME, contextOf, openRoom, syncMembers, _reset };
