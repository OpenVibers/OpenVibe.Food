'use strict';

/**
 * /api/v1 — OpenVibe.Food's API.
 *
 *   GET  /places?q=&kind=foodbank|grocery|both[&lat=&lon=&radius=&limit=]   public   food near a place (OpenStreetMap)
 *   GET  /foods[?group=&q=]                                                 public   the food list
 *   GET  /foods/:slug                                                       public   one food
 *   GET  /boxes[?kind=&diet=&q=]                                            public   every food box (server/food/boxes.js)
 *   GET  /boxes/:slug                                                       public   one box, with its codes and score
 *   GET  /boxes/:slug/cost?people=&meals=&weeks=                            public   what its stated price comes to
 *   POST /plans                                                             signed in  plan a shop and save it
 *   GET  /plans                                                             signed in  the plans you saved
 *   GET  /plans/:id                                                         signed in  one of yours
 *   GET  /pantry                                                            signed in  what you say is in your cupboard
 *   PUT  /pantry                                                            signed in  replace it
 *
 * Public reads need no token: the food list and the place search are the same for everyone. Anything a person owns
 * (a plan, a pantry) needs a signed-in caller, named with its capability in ./principal.js. The place search is the
 * expensive route (it spends OpenStreetMap's shared one-request-a-second budget) and takes its own numbers from
 * ./caller-limits.js. Errors are RFC 9457 problem+json with a stable code.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const foods = require('../food/foods');
const boxes = require('../food/boxes');
const { planMeals } = require('../food/planner');
const { searchPlaces } = require('../food/places');
const { matchPantry } = require('../food/pantry-match');
const { suggestRecipes } = require('../food/recipes');
const store = require('../food/store');

const PLAN_ID = /^pln_[0-9A-HJKMNP-TV-Z]{26}$/;
// The food list is not fetched from anywhere: it is carried over from OpenVibe.Tools' grocery source, and says so.
const FOOD_SOURCE = {
    name: 'OpenVibe.Tools grocery dataset',
    carried_from: 'OpenVibe.Tools/apps/maps/server/sources/grocery.js',
    note: 'Typical 2025 US (Washington) prices, carried over unchanged. Not a live price.',
};

function createApi(ctx) {
    const { config, s, principal, limits } = ctx;
    const r = asyncRouter();
    const fail = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });

    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    // ── Liveness ─────────────────────────────────────────────
    r.get('/ping', limits.reads('food.api.read'), (_req, res) => res.json({ ok: true, service: config.service }));

    // ── Food near you (public) ───────────────────────────────
    r.get('/places', limits.budget('food.place.search'), async (req, res) => {
        const one = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
        const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
        const out = await searchPlaces(ctx.upstream, {
            kind: one(req.query.kind) || 'foodbank',
            q: one(req.query.q),
            lat: num(req.query.lat),
            lon: num(req.query.lon),
            radiusKm: num(req.query.radius),
            limit: num(req.query.limit),
        }, config).catch((err) => {
            if (err && err.code) { fail(req, res, err.status || 502, err.code, err.message); return null; }
            throw err;
        });
        if (!out) return;
        // OpenStreetMap answers are public and change slowly; a short shared cache keeps repeat searches off OSM.
        res.set('Cache-Control', 'public, max-age=300');
        res.json(out);
    });

    // ── The food list (public) ───────────────────────────────
    r.get('/foods', limits.reads('food.food.read'), (req, res) => {
        const group = typeof req.query.group === 'string' && req.query.group ? req.query.group : null;
        if (group && !foods.GROUPS[group]) return fail(req, res, 422, 'food.food.invalid', `group: one of ${Object.keys(foods.GROUPS).join(', ')}`);
        const q = typeof req.query.q === 'string' && req.query.q ? req.query.q.slice(0, 80) : null;
        const list = foods.listFoods({ group, q });
        res.set('Cache-Control', 'public, max-age=3600');
        res.json({
            foods: list.map(foods.toWire),
            count: list.length,
            groups: Object.entries(foods.GROUPS).map(([id, g]) => ({ group: id, name: g.name, daily_min_g: g.dailyMin })),
            source: FOOD_SOURCE,
        });
    });

    // ── Food boxes: every fact with the service's own page and the day it was read; codes and scores live ──
    r.get('/boxes', limits.reads('food.food.read'), (req, res) => {
        const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : null;
        if (kind && !boxes.KIND[kind]) return fail(req, res, 422, 'food.box.invalid', `kind: one of ${boxes.KINDS.map((x) => x.kind).join(', ')}`);
        const diet = typeof req.query.diet === 'string' && req.query.diet ? req.query.diet : null;
        if (diet && !boxes.DIETS[diet]) return fail(req, res, 422, 'food.box.invalid', `diet: one of ${Object.keys(boxes.DIETS).join(', ')}`);
        const q = typeof req.query.q === 'string' && req.query.q ? req.query.q.slice(0, 60) : null;
        const list = boxes.list({ kind, diet, q });
        res.set('Cache-Control', 'public, max-age=3600');
        res.json({ boxes: list.map(boxes.toWire), count: list.length, kinds: boxes.KINDS, diets: boxes.DIETS,
            method: 'Each fact was read on the service\'s own public pages by a person (sources, checked); nothing is fetched from the services. A null fact was not checked.' });
    });

    r.get('/boxes/:slug', limits.reads('food.food.read'), async (req, res) => {
        const b = boxes.get(req.params.slug);
        if (!b) return fail(req, res, 404, 'food.box.not_found', `no box "${String(req.params.slug).slice(0, 64)}"; GET /api/v1/boxes lists them`);
        const links = ctx.boxLinks ? await ctx.boxLinks.forBox(b) : { coupons: null, reviews: null };
        res.set('Cache-Control', 'public, max-age=300');
        res.json({ box: boxes.toWire(b), coupons: links.coupons, reviews: links.reviews });
    });

    r.get('/boxes/:slug/cost', limits.reads('food.food.read'), (req, res) => {
        const b = boxes.get(req.params.slug);
        if (!b) return fail(req, res, 404, 'food.box.not_found', `no box "${String(req.params.slug).slice(0, 64)}"`);
        const c = boxes.cost(b, { people: req.query.people || 2, meals: req.query.meals || 3, weeks: req.query.weeks || 1 });
        if (!c) return fail(req, res, 422, 'food.box.no_cost', b.price && ['serving', 'meal'].includes(b.price.unit) ? `a plan size ${b.name} states: people ${b.people.join('/') || 'any'}, meals ${b.meals.join('/') || 'any'}` : `${b.name} has no stated price per serving or meal`);
        res.set('Cache-Control', 'public, max-age=3600');
        res.json({ box: b.slug, cost: c });
    });

    r.get('/foods/:slug', limits.reads('food.food.read'), (req, res) => {
        const food = foods.getFood(req.params.slug);
        if (!food) return fail(req, res, 404, 'food.food.not_found', `no food "${String(req.params.slug).slice(0, 64)}" in the list; GET /api/v1/foods lists them`);
        res.set('Cache-Control', 'public, max-age=3600');
        res.json({ food: { ...foods.toWire(food), prices: food.prices, per_100g_note: food.per_100g ? 'Derived from the pack size in the item\'s name and the typical values per serving; approximate.' : 'The pack size in this item\'s name is not a weight, so no per-100 g figure is given.' }, source: FOOD_SOURCE });
    });

    // ── Plans (a person's own) ───────────────────────────────
    r.post('/plans', principal.requireCapability('food.plan.write'), limits.budget('food.plan.create'), async (req, res) => {
        const b = req.body || {};
        let plan;
        try { plan = planMeals({ people: b.people, days: b.days, budget: b.budget }); } catch (err) {
            if (err && err.code === 'food.plan.invalid') return fail(req, res, 422, err.code, err.message);
            throw err;
        }
        const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 120) : null;
        const row = await store.insertPlan(s, {
            id: s.newId('pln'), owner: req.principal.requester, title,
            people: plan.spec.people, days: plan.spec.days, budget: plan.spec.budget, plan, created_at: s.iso(),
        });
        res.set('Location', `/api/v1/plans/${row.id}`);
        return res.status(201).json(store.planToWire(row));
    });

    r.get('/plans', principal.requireCapability('food.plan.read'), limits.reads('food.plan.read'), async (req, res) => {
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const rows = await store.listPlans(s, req.principal.requester, { limit });
        res.json({ plans: rows.map(store.planToWire) });
    });

    r.get('/plans/:id', principal.requireCapability('food.plan.read'), limits.reads('food.plan.read'), async (req, res) => {
        const row = PLAN_ID.test(req.params.id) ? await store.planRow(s, req.principal.requester, req.params.id) : null;
        if (!row) return fail(req, res, 404, 'food.plan.not_found', 'No such plan.');
        res.json(store.planToWire(row));
    });

    // ── Pantry (a person's own) ──────────────────────────────
    const pantryWire = (items) => {
        const match = matchPantry(items);
        return {
            items,
            foods: items.map((slug) => foods.toWire(foods.getFood(slug))),
            // "What can I make" is deterministic matching against the basic recipes; the page says plainly what it is.
            suggestions: {
                can_make: match.can_make.map((x) => ({ slug: x.slug, name: x.name, serves: x.serves, minutes: x.minutes })),
                almost: match.almost.map((x) => ({ slug: x.slug, name: x.name, serves: x.serves, minutes: x.minutes, missing: x.missing.map((m) => m.name) })),
            },
            note: 'Basic suggestions: simple combinations written by OpenVibe, matched against your list. Not dietary advice.',
        };
    };

    r.get('/pantry', principal.requireCapability('food.pantry.read'), limits.reads('food.pantry.read'), async (req, res) => {
        res.json(pantryWire(await store.getPantry(s, req.principal.requester)));
    });

    r.put('/pantry', principal.requireCapability('food.pantry.write'), limits.budget('food.pantry.write'), async (req, res) => {
        const b = req.body || {};
        if (!Array.isArray(b.items)) return fail(req, res, 422, 'food.pantry.invalid', 'items: an array of food slugs (GET /api/v1/foods lists them)');
        if (b.items.length > 200) return fail(req, res, 422, 'food.pantry.invalid', 'items: at most 200');
        const items = [...new Set(b.items.map((x) => String(x)))];
        const unknown = items.filter((slug) => !foods.getFood(slug));
        if (unknown.length) return fail(req, res, 422, 'food.pantry.unknown_item', `not in the food list: ${unknown.slice(0, 5).join(', ')}`);
        res.json(pantryWire(await store.setPantry(s, req.principal.requester, items)));
    });

    // ── Recipe ideas from the network's AI (a person's own) ──
    const recipesDailyLimit = async (req, res, next) => {
        const today = new Date(s.now()).toISOString().slice(0, 10);
        const made = await store.countRecipeSuggestionsSince(s, req.principal.requester, today);
        if (made >= 10) {
            res.set('Retry-After', String(86400 - (Math.floor(s.now() / 1000) % 86400)));
            return fail(req, res, 429, 'food.recipes_daily_limit', 'At most 10 recipe suggestions a day.');
        }
        return next();
    };

    r.post('/recipes/suggest', principal.requireCapability('food.recipes.suggest'), recipesDailyLimit, async (req, res) => {
        if (!config.aiUrl) return fail(req, res, 503, 'food.ai_off', 'Recipe ideas are not available: OpenVibe.AI is not configured for this service.');
        const b = req.body || {};
        const ask = typeof b.ask === 'string' && b.ask.trim() ? b.ask.trim().slice(0, 500) : null;
        let people = null;
        if (b.people != null && b.people !== '') {
            people = Number(b.people);
            if (!Number.isInteger(people) || people < 1 || people > 12) return fail(req, res, 422, 'food.recipes.invalid', 'people: a whole number from 1 to 12');
        }
        const owner = req.principal.requester;
        const pantry = await store.getPantry(s, owner);
        if (!pantry.length) return fail(req, res, 422, 'food.pantry_empty', 'Your pantry is empty; add what you have before asking for recipe ideas.');
        let suggestion;
        try {
            suggestion = await suggestRecipes(ctx.ai, { pantry, ask, people, subject: owner.replace(/^user:/, '') });
        } catch (err) {
            if (err && err.name === 'AiRunError') return fail(req, res, err.status || 502, err.code || 'ai.run_failed', err.message);
            throw err;
        }
        const row = await store.insertRecipeSuggestion(s, {
            id: s.newId('rcp'), subject_id: owner, created_at: s.iso(),
            ask, people, ai_run_id: suggestion.runId, recipes: suggestion.recipes,
        });
        return res.status(201).json(store.recipeSuggestionToWire(row));
    });

    r.get('/recipes', principal.requireCapability('food.recipes.suggest'), limits.reads('food.recipes.read'), async (req, res) => {
        const rows = await store.listRecipeSuggestions(s, req.principal.requester, { limit: 20 });
        res.json({ recipes: rows.map(store.recipeSuggestionToWire) });
    });

    return r;
}

module.exports = { createApi, FOOD_SOURCE };
