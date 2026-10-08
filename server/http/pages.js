'use strict';

/**
 * Public pages, every one server-rendered and complete without JavaScript:
 *
 *   /                 home: find food near you, plan a week, what is in your cupboard
 *   /near             food banks, pantries and budget grocery stores near a place (OpenStreetMap)
 *   /plan             a meal plan, a shopping list and what it costs; signed-in people can save it
 *   /foods            the food list, grouped
 *   /foods/:slug      one food: nutrition per serving and per 100 g, typical prices
 *   /pantry           what is in your cupboard, and what you can make from it (signed in)
 *   /updates          the update log
 *
 * Crawl artifacts (robots.txt, sitemap.xml, llms.txt, llms-full.txt, JSON-LD) are http/discovery.js.
 * Every page that shows OpenStreetMap data carries the attribution ODbL requires, linked back.
 */
const express = require('express');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { html, raw, table, notice, time, badge } = require('../render/html');
const { send } = require('../render/layout');
const foods = require('../food/foods');
const { planMeals } = require('../food/planner');
const { searchPlaces, ATTRIBUTION } = require('../food/places');
const { matchPantry } = require('../food/pantry-match');
const store = require('../food/store');

const SITE_NAME = 'OpenVibe.Food';
const TAGLINE = 'What should we eat?';
const KINDS = { foodbank: 'Food banks and pantries', grocery: 'Budget grocery stores', both: 'Both' };

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const km = (n) => `${Number(n).toFixed(1)} km`;
const str = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function createPageRoutes(ctx) {
    const { config, s } = ctx;
    const r = asyncRouter();
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 300 });
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const ownerOf = (req) => `user:${req.viewer.subject}`;

    // ── Small pieces ─────────────────────────────────────────
    // ODbL requires attribution wherever OSM data is shown; every result page carries it, linked back.
    const osmNote = (fetchedAt) => html`<p class="attribution small muted">Food bank and store data © <a href="${ATTRIBUTION.url}" rel="noopener">OpenStreetMap contributors</a>, available under the <a href="${ATTRIBUTION.license_url}" rel="noopener">Open Database License</a>. ${fetchedAt ? html`Fetched ${time(fetchedAt)}.` : ''} OpenVibe.Food asks OSM at most once a second and caches answers for 7 days.</p>`;

    function searchForm({ q = '', kind = 'foodbank' } = {}) {
        const opt = (value, label) => html`<option value="${value}"${value === kind ? raw(' selected') : ''}>${label}</option>`;
        return html`<form class="ov-form food-search" method="get" action="/near">
<label for="q">Where are you?</label>
<input id="q" name="q" type="search" placeholder="Town, city or postcode" value="${q}" maxlength="120">
<label for="kind">Looking for</label>
<select id="kind" name="kind">${Object.entries(KINDS).map(([v, l]) => opt(v, l))}</select>
<button class="sc-btn sc-primary" type="submit">Find food</button>
</form>`;
    }

    function placeRow(res_) {
        return html`<li class="place" id="${res_.id}">
<p class="place-name"><b>${res_.name}</b> ${badge(res_.type_label)} ${res_.budget === true ? badge('budget', 'ok') : ''}</p>
<p class="muted small">${km(res_.distance_km)} away${res_.address ? html` · ${res_.address}` : ''}${res_.operator ? html` · run by ${res_.operator}` : ''}</p>
${res_.opening_hours ? html`<p class="small">Opening hours: ${res_.opening_hours}</p>` : ''}
${res_.phone ? html`<p class="small">Phone: <a href="tel:${String(res_.phone).replace(/[^\d+]/g, '')}">${res_.phone}</a></p>` : ''}
<p class="small">${res_.website ? html`<a href="${res_.website}" rel="noopener nofollow">Their website</a> · ` : ''}<a href="${res_.osm_url}" rel="noopener nofollow">View on OpenStreetMap</a>${res_.wheelchair === true ? html` · wheelchair accessible` : ''}</p>
</li>`;
    }

    function resultsBlock(out) {
        if (!out.results.length) {
            return html`<p class="muted">Nothing was found within ${out.radius_km} km. OpenStreetMap does not know every food bank — try a wider area, or ask your local council.</p>`;
        }
        return html`<ul class="places">${out.results.map(placeRow)}</ul>`;
    }

    // ── Home ─────────────────────────────────────────────────
    r.get('/', (req, res) => {
        const hero = showcase.hero({
            eyebrow: `${SITE_NAME} · ${TAGLINE}`,
            title: 'Eat well.', accent: 'Spend less.',
            lede: 'Find the food banks, pantries and budget grocery stores near you on a map anyone can edit. Plan meals for one person, a couple or a household for the days ahead, with the shopping list and what it costs. Tell it what is already in your cupboard and see what you can make.',
            actions: [
                { label: 'Find food near you', href: '/near', primary: true },
                { label: 'Plan a week', href: '/plan' },
                { label: 'The food list', href: '/foods' },
            ],
            note: 'Open source (AGPL-3.0). Places come from OpenStreetMap © contributors (ODbL); prices are typical, not live.',
            aside: { html: String(searchForm()) },
        });
        page(req, res, {
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            jsonLd: homeJsonLd(config),
            styles: [showcase.STYLESHEET],
            body: html`${raw(hero)}
${raw(showcase.features({
                title: 'Everything food',
                lede: 'Four things, all working today: no card, no account needed to look around.',
                items: [
                    { icon: 'ov:location', title: 'Food near you', text: 'Food banks, soup kitchens, community fridges and free pantry boxes, plus the budget grocery stores, with distance, address and opening hours.', href: '/near' },
                    { icon: 'ov:page', title: 'A meal planner', text: 'One person, a couple or a group, for up to fourteen days. It covers all six food groups, writes the shopping list and estimates what it costs.', href: '/plan' },
                    { icon: 'ov:tools', title: 'A food list you can read', text: 'Every item with its nutrition per serving and per 100 g, the typical price band and the cheapest of the five budget chains.', href: '/foods' },
                    { icon: 'ov:account', title: 'Your cupboard', text: 'Keep a list of what you have. Sign in and it says plainly which simple things you can already make, and what one item would unlock.', href: '/pantry' },
                ],
            }))}
${raw(showcase.cta({
                title: 'Start where you are',
                text: 'Search your town for a food bank, plan the next three days for what you can spend, or look up what is in the tin before you open it.',
                actions: [{ label: 'Find food near you', href: '/near', primary: true }, { label: 'Plan meals', href: '/plan' }, { label: 'The food list', href: '/foods' }],
            }))}`,
        });
    });

    // ── Food near you ────────────────────────────────────────
    r.get('/near', async (req, res) => {
        const q = str(req.query.q);
        const kind = KINDS[req.query.kind] ? req.query.kind : 'foodbank';
        const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
        let out = null;
        let problem = null;
        if (q || (num(req.query.lat) != null && num(req.query.lon) != null)) {
            try {
                out = await searchPlaces(ctx.upstream, { kind, q, lat: num(req.query.lat), lon: num(req.query.lon), radiusKm: num(req.query.radius) }, config);
            } catch (err) {
                problem = err && err.code ? err.message : 'The place search is unavailable right now. Try again in a few minutes.';
            }
        }
        const title = out && out.location.name ? `Food near ${out.location.name.split(',').slice(0, 2).join(',')}` : 'Food near you';
        page(req, res, {
            title, description: 'Food banks, pantries and budget grocery stores near a place, from OpenStreetMap.',
            crumbs: [{ label: 'Food near you' }], styles: [showcase.STYLESHEET],
            body: html`<h1>Food near you</h1>
<p class="lede">Food banks, soup kitchens, community fridges, free pantry boxes and budget grocery stores, from OpenStreetMap.</p>
${searchForm({ q: q || '', kind })}
${problem ? notice(problem, 'warn') : ''}
${out ? html`<section class="near-results">
<h2>${out.location.name || 'Around those coordinates'}</h2>
<p class="muted small">Within ${out.radius_km} km, nearest first. ${out.counts.total} found${out.counts.foodbank ? html` · ${out.counts.foodbank} food banks and pantries` : ''}${out.counts.grocery ? html` · ${out.counts.grocery} grocery stores (${out.counts.budget_grocery} budget)` : ''}.</p>
${resultsBlock(out)}
${osmNote(out.fetched_at)}
</section>` : html`<p class="muted">Search for a town, a city or a postcode above — or link here with <code>?lat=</code> and <code>?lon=</code> from a map.</p>`}`,
        });
    });

    // ── Meal plan ────────────────────────────────────────────
    function planForm(spec) {
        return html`<form class="ov-form plan-form" method="get" action="/plan">
<label for="people">People</label>
<input id="people" name="people" type="number" min="1" max="12" value="${spec.people}">
<label for="days">Days</label>
<input id="days" name="days" type="number" min="1" max="14" value="${spec.days}">
<label for="budget">Budget in dollars (optional)</label>
<input id="budget" name="budget" type="number" min="1" max="5000" step="0.01" value="${spec.budget == null ? '' : spec.budget}">
<button class="sc-btn sc-primary" type="submit">Plan it</button>
</form>`;
    }

    function planBody(plan) {
        return html`<section class="plan-summary">
<h2>${plan.spec.people} ${plan.spec.people === 1 ? 'person' : 'people'}, ${plan.spec.days} ${plan.spec.days === 1 ? 'day' : 'days'}</h2>
<ul class="stats">
<li><b>${money(plan.totals.cost)}</b><span>estimated total</span></li>
<li><b>${money(plan.totals.cost_per_person_day)}</b><span>a person a day</span></li>
<li><b>${plan.totals.kcal_per_person_day}</b><span>kcal a person a day</span></li>
<li><b>${plan.totals.protein_g_per_person_day} g</b><span>protein a person a day</span></li>
<li><b>${plan.groups_covered} of ${plan.groups_total}</b><span>food groups covered</span></li>
</ul>
${plan.spec.budget != null ? html`<p class="muted small">Budget ${money(plan.spec.budget)}${plan.remaining_budget != null ? html` · ${money(plan.remaining_budget)} left` : ''}.</p>` : ''}
</section>
<h2>The shopping list</h2>
${table(['Item', 'Packs', 'Where', 'Cost'], plan.shopping_list.map((i) => [html`<a href="/foods/${i.slug}">${i.name}</a>`, String(i.packs), i.store_name || '—', money(i.cost)]), { empty: 'Nothing in the plan.' })}
<p class="muted small">Cheapest total ${money(plan.totals.cost)} at ${plan.by_store.length} ${plan.by_store.length === 1 ? 'store' : 'stores'}: ${plan.by_store.map((x) => `${x.store_name} ${money(x.cost)}`).join(', ')}. ${plan.totals.packs} packs.</p>
<h2>What to eat</h2>
${plan.menu.map((d) => html`<section class="plan-day"><h3>Day ${d.day}</h3>
<ul>${[['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snack', 'Snack']].map(([slot, label]) => html`<li><b>${label}:</b> ${d[slot].join(', ') || '—'}</li>`)}</ul></section>`)}
<h2>Food groups</h2>
${table(['Group', 'A day, at least', 'In the plan', 'Cost'], plan.group_coverage.map((g) => [g.name, `${g.daily_min_g} g`, g.covered ? `${g.items} items, ${g.packs} packs` : '—', money(g.cost)]))}
${plan.notes.map((n) => html`<p class="muted small">${n}</p>`)}`;
    }

    r.get('/plan', (req, res) => {
        const spec = { people: str(req.query.people, 4) || '2', days: str(req.query.days, 4) || '3', budget: str(req.query.budget, 8) || '' };
        let plan = null;
        let problem = null;
        try { plan = planMeals(spec); } catch (err) { problem = err && err.message ? err.message : 'That plan could not be made.'; }
        const savedId = str(req.query.saved, 40);
        page(req, res, {
            title: 'Meal plan', description: 'A budget meal plan with a shopping list and an estimated cost, from the OpenVibe.Food food list.',
            crumbs: [{ label: 'Meal plan' }], styles: [showcase.STYLESHEET],
            body: html`<h1>Plan meals</h1>
<p class="lede">It buys one item from each of the six food groups first, cheapest per serving, then fills up with the best calories per dollar. Deterministic: the same numbers always give the same plan.</p>
${planForm(spec)}
${savedId ? notice('Saved. It is in your plans below.', 'ok') : ''}
${problem ? notice(problem, 'warn') : ''}
${plan ? planBody(plan) : ''}
${plan && signedIn(req) ? html`<h2>Save this plan</h2>
<form class="ov-form save-form" method="post" action="/plan">
${['people', 'days', 'budget'].map((k) => html`<input type="hidden" name="${k}" value="${k === 'budget' ? (plan.spec.budget == null ? '' : plan.spec.budget) : plan.spec[k]}">`)}
<label for="title">Name (optional)</label>
<input id="title" name="title" type="text" maxlength="120" placeholder="e.g. Week of the 12th">
<button class="sc-btn" type="submit">Save this plan</button>
</form>` : ''}
${plan && !signedIn(req) ? html`<p class="muted small"><a href="/auth/login?next=%2Fplan">Sign in</a> to save a plan and come back to it.</p>` : ''}`,
        });
    });

    r.post('/plan', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        const body = req.body || {};
        const spec = { people: str(body.people, 4) || '2', days: str(body.days, 4) || '3', budget: str(body.budget, 8) || '' };
        const back = `/plan?people=${encodeURIComponent(spec.people)}&days=${encodeURIComponent(spec.days)}&budget=${encodeURIComponent(spec.budget)}`;
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/plan')}`);
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('A plan must be saved from openvibe.food itself.');
        let plan;
        try { plan = planMeals(spec); } catch (err) { return res.redirect(303, back); }
        const row = await store.insertPlan(s, {
            id: s.newId('pln'), owner: ownerOf(req), title: str(body.title, 120),
            people: plan.spec.people, days: plan.spec.days, budget: plan.spec.budget, plan, created_at: s.iso(),
        });
        return res.redirect(303, `${back}&saved=${encodeURIComponent(row.id)}`);
    });

    // Saved plans sit under the same page: nothing personal is ever in a public cache.
    r.get('/plan/saved', async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fplan%2Fsaved');
        const rows = await store.listPlans(s, ownerOf(req), { limit: 50 });
        page(req, res, {
            title: 'Your plans', crumbs: [{ label: 'Meal plan', href: '/plan' }, { label: 'Saved' }],
            body: html`<h1>Your saved plans</h1>
${table(['Name', 'For', 'Cost', 'Saved'], rows.map((row) => {
                const plan = typeof row.plan === 'string' ? JSON.parse(row.plan) : row.plan;
                return [row.title || `Plan ${String(row.id).slice(-6)}`, `${row.people} people, ${row.days} days`, money(plan.totals.cost), time(row.created_at)];
            }), { empty: 'No saved plans yet. Make one on the plan page and save it.' })}
<p><a href="/plan">Plan another</a></p>`,
        });
    });

    // ── The food list ────────────────────────────────────────
    r.get('/foods', (req, res) => {
        const group = foods.GROUPS[req.query.group] ? req.query.group : null;
        const q = str(req.query.q, 80);
        const list = foods.listFoods({ group, q });
        const sections = Object.entries(foods.GROUPS).filter(([id]) => !group || id === group).map(([id, def]) => {
            const items = list.filter((f) => f.group === id);
            if (!items.length) return '';
            return html`<section class="food-group"><h2 id="g-${id}">${def.name}</h2>
<p class="muted small">At least ${def.dailyMin} g a person a day. ${def.examples}.</p>
${table(['Food', 'Serving', 'kcal', 'Protein', 'Typical price'], items.map((f) => [
                html`<a href="/foods/${f.slug}">${f.name}</a>`,
                f.serving_size,
                `${f.nutrition.kcal}`,
                `${f.nutrition.protein_g} g`,
                f.price == null ? '—' : html`${money(f.price)} · ${f.band_label}`,
            ]))}</section>`;
        });
        page(req, res, {
            title: q ? `Foods matching “${q}”` : 'The food list', index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            description: 'Every food OpenVibe.Food plans with: nutrition per serving and per 100 g, and the typical price band.',
            crumbs: [{ label: 'Food list' }], styles: [showcase.STYLESHEET],
            body: html`<h1>The food list</h1>
<p class="lede">${foods.FOODS.length} items the planner and the cupboard use. Nutrition is typical, per serving; the price is a band from five budget chains.</p>
<form class="ov-form filter-form" method="get" action="/foods">
<label for="q">Search</label>
<input id="q" name="q" type="search" value="${q || ''}" maxlength="80" placeholder="beans, oats, tuna…">
<label for="group">Group</label>
<select id="group" name="group"><option value="">All groups</option>${Object.entries(foods.GROUPS).map(([id, def]) => html`<option value="${id}"${id === group ? raw(' selected') : ''}>${def.name}</option>`)}</select>
<button class="sc-btn" type="submit">Filter</button>
</form>
${list.length ? sections : notice('Nothing matched. Try a shorter word.', 'warn')}
<p class="muted small">Carried over from the OpenVibe.Tools grocery dataset (typical 2025 US Washington prices). Not a live price.</p>`,
        });
    });

    r.get('/foods/:slug', (req, res) => {
        const f = foods.getFood(req.params.slug);
        if (!f) return page(req, res, {
            title: 'No such food', crumbs: [{ label: 'Food list', href: '/foods' }, { label: 'Not found' }],
            body: html`<h1>No such food</h1><p>Nothing in the list is called “${String(req.params.slug).slice(0, 64)}”. <a href="/foods">See the whole list</a>.</p>`,
        }, 404);
        page(req, res, {
            title: f.name, index: true, cache: signedIn(req) ? null : PUBLIC_CACHE, styles: [showcase.STYLESHEET],
            description: `${f.name}: nutrition per serving and per 100 g, and the typical price band.`,
            crumbs: [{ label: 'Food list', href: '/foods' }, { label: f.name }],
            body: html`<h1>${f.name}</h1>
<p class="muted">${f.group_name} · a serving is ${f.serving_size}${f.serving_grams ? html` (about ${f.serving_grams} g)` : ''} · ${f.servings} servings a pack.</p>
<h2>Nutrition</h2>
${table(['', 'A serving', f.per_100g ? 'Per 100 g' : 'Per 100 g'], [
                ['Energy', `${f.nutrition.kcal} kcal`, f.per_100g ? html`${f.per_100g.kcal} kcal` : '—'],
                ['Protein', `${f.nutrition.protein_g} g`, f.per_100g ? html`${f.per_100g.protein_g} g` : '—'],
                ['Carbohydrate', `${f.nutrition.carbs_g} g`, f.per_100g ? html`${f.per_100g.carbs_g} g` : '—'],
                ['Fat', `${f.nutrition.fat_g} g`, f.per_100g ? html`${f.per_100g.fat_g} g` : '—'],
                ['Fibre', `${f.nutrition.fiber_g} g`, f.per_100g ? html`${f.per_100g.fiber_g} g` : '—'],
            ])}
<p class="muted small">${f.per_100g ? `Per 100 g is worked out from the ${f.pack_grams} g pack the name states and the typical values a serving carries; it is approximate.` : 'This item names no pack weight, so no per-100 g figure is given rather than guess one.'} A pack is about ${f.package_kcal} kcal.</p>
<h2>Typical price</h2>
<p>${f.price == null ? 'No price recorded.' : html`<b>${money(f.price)}</b> to ${money(f.price_max)} a pack · ${f.band_label} · ${money(f.cost_per_serving)} a serving`}</p>
${table(['Store', 'A pack'], f.prices.map((p) => [p.store_name, money(p.price)]))}
<p class="muted small">Typical 2025 US (Washington) prices carried over from the OpenVibe.Tools grocery dataset; not a live price.</p>
${f.tags.length ? html`<p class="tags">${f.tags.map((t) => badge(t))}</p>` : ''}
<p><a href="/plan?people=2&days=3">Plan meals with this</a> · <a href="/foods">Back to the list</a></p>`,
        });
    });

    // ── Your cupboard ────────────────────────────────────────
    async function pantryPage(req, res, { saved = false } = {}) {
        if (!signedIn(req)) {
            return page(req, res, {
                title: 'Your cupboard', crumbs: [{ label: 'Your cupboard' }], styles: [showcase.STYLESHEET],
                body: html`<h1>Your cupboard</h1>
<p class="lede">Keep a list of what you already have and OpenVibe.Food will say which of its simple recipes you can make right now — and what one more item would unlock.</p>
<p><a class="sc-btn sc-primary" href="/auth/login?next=%2Fpantry">Sign in to keep a cupboard</a></p>`,
            });
        }
        const items = await store.getPantry(s, ownerOf(req));
        const match = matchPantry(items);
        const have = new Set(items);
        const groupsBlock = Object.entries(foods.GROUPS).map(([id, def]) => html`<fieldset class="pantry-group"><legend>${def.name}</legend>
${foods.FOODS.filter((f) => f.group === id).map((f) => html`<label class="pantry-item"><input type="checkbox" name="items" value="${f.slug}"${have.has(f.slug) ? raw(' checked') : ''}> ${f.name}</label>`)}
</fieldset>`);
        const recipeLine = (x) => html`<li><b>${x.name}</b> — serves ${x.serves}, about ${x.minutes} minutes${x.missing && x.missing.length ? html` · missing ${x.missing.join(', ')}` : ''}</li>`;
        page(req, res, {
            title: 'Your cupboard', crumbs: [{ label: 'Your cupboard' }], styles: [showcase.STYLESHEET],
            body: html`<h1>Your cupboard</h1>
<p class="lede">Tick what you have. Nothing leaves your account; the matching is done here, not by a model.</p>
${saved ? notice('Cupboard saved.', 'ok') : ''}
<form method="post" action="/pantry" class="pantry-form">
${groupsBlock}
<div class="pantry-actions"><button class="sc-btn sc-primary" type="submit">Save cupboard</button><span class="muted small">${items.length} of ${foods.FOODS.length} items</span></div>
</form>
<h2>What can I make?</h2>
<p class="muted small"><b>Basic suggestions.</b> Simple combinations written by OpenVibe from the items in the list above, matched against your cupboard. Not dietary advice, and not a full recipe book.</p>
${match.can_make.length ? html`<h3>You can make these now</h3><ul>${match.can_make.map(recipeLine)}</ul>` : html`<p class="muted">Nothing is complete yet. Tick what you have above.</p>`}
${match.almost.length ? html`<h3>One item away</h3><ul>${match.almost.map(recipeLine)}</ul>` : ''}
${match.rest.length ? html`<h3>Further off</h3><ul>${match.rest.slice(0, 6).map(recipeLine)}</ul>` : ''}`,
        });
    }

    r.get('/pantry', (req, res) => pantryPage(req, res, { saved: !!req.query.saved }));

    r.post('/pantry', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fpantry');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('A cupboard must be saved from openvibe.food itself.');
        // A checkbox form sends the field once per ticked box; some clients send one comma-joined value. Accept both.
        const sent = [].concat((req.body && req.body.items) || []).flatMap((v) => String(v).split(','));
        const picked = [...new Set(sent.map((x) => x.trim()).filter((slug) => foods.getFood(slug)))];
        if (picked.length > 200) return res.status(413).type('text/plain').send('That is more items than a cupboard can hold.');
        await store.setPantry(s, ownerOf(req), picked);
        return res.redirect(303, '/pantry?saved=1');
    });

    // ── The update log ───────────────────────────────────────
    r.get('/updates', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        title: `What shipped on ${SITE_NAME}`,
        body: raw(frame.updatesBody({ service: 'food', siteName: SITE_NAME }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`),
    }));

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt ──
    r.use(createDiscoveryRoutes(ctx));
    return r;
}

module.exports = { createPageRoutes, TAGLINE, SITE_NAME };
