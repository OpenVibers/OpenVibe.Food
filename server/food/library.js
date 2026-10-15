'use strict';
/**
 * The recipe library (the owner's ask: "an AI recipe system" for OpenVibe.Food). Every few hours the next theme in THEMES
 * goes to OpenVibe.AI's food.suggest_recipes with an empty cupboard, so every ingredient has to be a food from Food's own
 * list (server/food/recipes.js validates that strictly; an ingredient the AI could not tie to the list drops the whole
 * recipe here, so a recipe never quietly misses something). Food prices what there is to buy from its typical prices,
 * never from anything the model said. Recipes are labelled as AI and stay noindex until a member of staff marks one
 * reviewed; staff may hide one.
 *
 *   tick()          the next theme (the one asked least recently), when AI is configured
 *   list(), bySlug(), review(), setHidden()
 */
const crypto = require('crypto');
const { buildSources, validateSuggestions } = require('./recipes');

const THEMES = [
    'a one-pot dinner for four', 'a quick breakfast with eggs', 'a vegetarian chili', 'a packed lunch for work or school',
    'a rice bowl', 'a pasta dinner', 'a soup for a cold day', 'a meal with no cooking', 'a dinner made from canned food',
    'a high-protein meal on a budget', 'a sweet snack', 'something with potatoes', 'a bean dish', 'a breakfast without eggs',
    'a weeknight stir-fry', 'a sandwich that fills you up', 'a dinner children will eat', 'a meal from frozen vegetables',
    'tacos or burritos', 'a filling salad', 'something with bananas', 'a slow-simmered stew', 'a batch-cooked meal for the week',
    'a dairy-free dinner', 'something with peanut butter', 'a cheap dinner for two', 'a one-pan camping meal',
    'a microwave meal for a dorm room', 'something with oats', 'a tomato pasta sauce from scratch', 'fried rice',
    'a breakfast burrito', 'a chicken dinner', 'a dinner from canned fish', 'a dessert from pantry staples',
];
const EVERY_MS = 6 * 3_600_000;

const clean = (v, n) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, n) || null);
const slugify = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/, '');
const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const intIn = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

function shape(r) {
    return r ? {
        ...r, ingredients: parse(r.ingredients, []), steps: parse(r.steps, []), to_buy: parse(r.to_buy, []),
        cost: r.cost == null ? null : Number(r.cost), reviewed: Boolean(r.reviewed_by),
    } : null;
}

function createLibrary({ s, ai, log = console }) {
    const enabled = Boolean(ai && (ai.enabled === undefined || ai.enabled));

    /** The theme asked least recently (never-asked first, in list order). */
    async function nextTheme() {
        const rows = await s.db.many('SELECT theme, max(created_at) AS last FROM food_library_runs GROUP BY theme');
        const last = new Map(rows.map((r) => [r.theme, r.last]));
        const never = THEMES.find((t) => !last.has(t));
        if (never) return never;
        return [...THEMES].sort((a, b) => (last.get(a) < last.get(b) ? -1 : 1))[0];
    }

    async function save(theme, runId, r) {
        // Everything comes from the food list: a recipe the validator kept only through "from your cupboard" is dropped.
        if (r.ingredients.some((i) => i.from_pantry || !i.citations.length)) return null;
        const sources = buildSources();
        const title = clean(r.title, 120);
        const base = slugify(title);
        if (!title || !base) return null;
        if (await s.db.maybe('SELECT 1 FROM food_library_recipes WHERE slug = $1', [base])) return null;   // the same dish again
        const ingredients = r.ingredients.map((i) => ({ name: clean(i.name, 120) || '', amount: clean(i.amount, 60), food: (sources[i.citations[0]] || {}).source_id || null }));
        const steps = r.steps.map((x) => clean(x, 600)).filter(Boolean).slice(0, 20);
        const row = {
            id: `lib_${crypto.randomBytes(8).toString('hex')}`, slug: base, title, theme, serves: intIn(r.serves, 1, 12), minutes: intIn(r.minutes, 1, 600),
            ingredients, steps, notes: clean(r.notes, 600), to_buy: r.to_buy, cost: r.to_buy_cost, cost_partial: Boolean(r.to_buy_cost_partial),
        };
        await s.db.query(`INSERT INTO food_library_recipes (id, slug, title, theme, serves, minutes, ingredients, steps, notes, to_buy, cost, cost_partial, ai_run_id, created_at)
                          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11, $12, $13, $14) ON CONFLICT (slug) DO NOTHING`,
        [row.id, row.slug, row.title, theme, row.serves, row.minutes, JSON.stringify(ingredients), JSON.stringify(steps), row.notes, JSON.stringify(row.to_buy), row.cost, row.cost_partial, runId || null, s.iso()]);
        return row;
    }

    /** One theme: ask, validate, cost, keep. Returns the recipes kept. */
    async function make(theme) {
        const input = { pantry: [], ask: `A budget recipe idea: ${theme}. Use only foods from the list.`, people: 4, sources: buildSources() };
        let run = null;
        try {
            run = await ai.run('food.suggest_recipes', input, { target: { service: 'food', type: 'library', id: slugify(theme) } });
            const out = validateSuggestions(run && run.output, { sources: input.sources, pantry: [] });
            const kept = [];
            for (const r of out.recipes) { const row = await save(theme, run && run.runId, r); if (row) kept.push(row); }
            await s.db.query('INSERT INTO food_library_runs (theme, ai_run_id, made, created_at) VALUES ($1, $2, $3, $4)', [theme, (run && run.runId) || null, kept.length, s.iso()]);
            return kept;
        } catch (err) {
            log.warn(`[OpenVibe.Food] recipe library (${theme}):`, err.message);
            await s.db.query('INSERT INTO food_library_runs (theme, ai_run_id, made, error, created_at) VALUES ($1, $2, 0, $3, $4)', [theme, (run && run.runId) || null, clean(err.message, 300), s.iso()]);
            return [];
        }
    }

    let busy = false;
    /** The next theme, unless one was asked less than six hours ago (a restart does not ask again early). */
    async function tick({ force = false } = {}) {
        if (!enabled || busy) return [];
        busy = true;
        try {
            const last = await s.db.value('SELECT max(created_at) FROM food_library_runs');
            if (!force && last && s.now() - Date.parse(last) < EVERY_MS - 10 * 60_000) return [];
            return await make(await nextTheme());
        } finally { busy = false; }
    }

    let timer = null;
    let first = null;
    return {
        enabled, THEMES, tick, make, nextTheme,
        async list({ limit = 24, offset = 0, staff = false } = {}) {
            const states = staff ? ['published', 'hidden'] : ['published'];
            const total = Number(await s.db.value('SELECT count(*) FROM food_library_recipes WHERE status = ANY($1::text[])', [states])) || 0;
            const rows = await s.db.many('SELECT * FROM food_library_recipes WHERE status = ANY($1::text[]) ORDER BY created_at DESC, id LIMIT $2 OFFSET $3', [states, limit, offset]);
            return { total, recipes: rows.map(shape) };
        },
        async reviewed() {
            return (await s.db.many("SELECT * FROM food_library_recipes WHERE status = 'published' AND reviewed_by IS NOT NULL ORDER BY created_at DESC")).map(shape);
        },
        async bySlug(slug) { return shape(await s.db.maybe('SELECT * FROM food_library_recipes WHERE slug = $1', [String(slug)])); },
        /** Staff: a person checked the recipe (it may now be indexed), or takes that back. */
        async review(recipe, by, yes = true) {
            await s.db.query('UPDATE food_library_recipes SET reviewed_by = $2, reviewed_at = $3 WHERE id = $1', [recipe.id, yes ? by : null, yes ? s.iso() : null]);
        },
        async setHidden(recipe, hidden, reason = null) {
            await s.db.query('UPDATE food_library_recipes SET status = $2, hidden_reason = $3 WHERE id = $1', [recipe.id, hidden ? 'hidden' : 'published', hidden ? clean(reason, 300) : null]);
        },
        start() {
            if (!enabled || timer) return;
            timer = setInterval(() => { tick().catch(() => {}); }, EVERY_MS);
            timer.unref();
            first = setTimeout(() => { tick().catch(() => {}); }, 5 * 60_000);
            first.unref();
        },
        stop() { clearInterval(timer); clearTimeout(first); timer = null; },
    };
}

module.exports = { createLibrary, THEMES, slugify };
