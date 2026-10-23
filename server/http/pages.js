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
 *   /recalls          the FDA's food recall reports, through OpenVibe.Sources (http/recall-pages.js)
 *   /updates          the update log
 *
 * Crawl artifacts (robots.txt, sitemap.xml, llms.txt, llms-full.txt, JSON-LD) are http/discovery.js.
 * Every page that shows OpenStreetMap data carries the attribution ODbL requires, linked back.
 */
const crypto = require('crypto');
const express = require('express');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { html, raw, table, notice, time, badge } = require('../render/html');
const { markdown } = require('../render/markdown');
const { send } = require('../render/layout');
const foods = require('../food/foods');
const { planMeals } = require('../food/planner');
const { searchPlaces, safeUrl, ATTRIBUTION } = require('../food/places');
const { matchPantry } = require('../food/pantry-match');
const { suggestRecipes } = require('../food/recipes');
const store = require('../food/store');
const delivery = require('../food/delivery');
const householdChat = require('../food/household-chat');
const { date: recallDate } = require('./recall-pages');
const seo = require('openvibe-shared/seo');
const { products } = require('openvibe-contracts');

const SITE_NAME = 'OpenVibe.Food';
const TAGLINE = 'What should we eat?';
const KINDS = { foodbank: 'Food banks and pantries', grocery: 'Budget grocery stores', both: 'Both' };

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const km = (n) => `${Number(n).toFixed(1)} km`;
const str = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function createPageRoutes(ctx) {
    const { config, s, limits } = ctx;
    const r = asyncRouter();
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 300 });
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const ownerOf = (req) => `user:${req.viewer.subject}`;

    // ── Small pieces ─────────────────────────────────────────
    // ODbL requires attribution wherever OSM data is shown; every result page carries it, linked back.
    const osmNote = (fetchedAt) => html`<p class="attribution small muted">Food bank and store data © <a href="${ATTRIBUTION.url}" rel="noopener">OpenStreetMap contributors</a>, available under the <a href="${ATTRIBUTION.license_url}" rel="noopener">Open Database License</a>. ${fetchedAt ? html`Fetched ${time(fetchedAt)}.` : ''} OpenVibe.Food asks OSM at most once a second and caches answers for 7 days.</p>`;

    // The same fields everywhere; on the home page they sit in a panel beside the hero (panel: true), on /near in a row.
    function searchForm({ q = '', kind = 'foodbank', panel = false } = {}) {
        const opt = (value, label) => html`<option value="${value}"${value === kind ? raw(' selected') : ''}>${label}</option>`;
        return html`<form class="ov-form food-search${panel ? ' food-search-panel' : ''}" method="get" action="/near">
${panel ? html`<p class="food-search-title">Find food near you</p>` : ''}
<div class="food-field food-field-where"><label for="q">Where are you?</label>
<input id="q" name="q" type="search" placeholder="Town, city or postcode" value="${q}" maxlength="120" autocomplete="address-level2"></div>
<div class="food-field"><label for="kind">Looking for</label>
<select id="kind" name="kind">${Object.entries(KINDS).map(([v, l]) => opt(v, l))}</select></div>
<button class="sc-btn sc-primary" type="submit">Find food</button>
${panel ? html`<p class="food-search-note">Free, no account. Places from OpenStreetMap.</p>` : ''}
</form>`;
    }

    // OpenVibe.Watch's new-watch form, filled in to follow a food bank's own website for changes (new hours, a closure);
    // the person reviews and creates it on Watch. Only for food help: a grocery chain's site changes all the time.
    const WATCH_NEW = 'https://openvibe.watch/watches/new';
    const watchHref = (place, website) => `${WATCH_NEW}?${new URLSearchParams({ template: 'page', url: website, name: `Food: ${place.name}`.slice(0, 80) })}`;

    function placeRow(res_) {
        // The source already drops a non-http(s) website from OSM (server/food/places.js); checked again here, so a
        // hostile or stale value can never reach an href. Anything but a safe URL simply shows no website link.
        const website = safeUrl(res_.website);
        return html`<li class="place" id="${res_.id}">
<p class="place-name"><b>${res_.name}</b> ${badge(res_.type_label)} ${res_.budget === true ? badge('budget', 'ok') : ''}</p>
<p class="muted small">${km(res_.distance_km)} away${res_.address ? html` · ${res_.address}` : ''}${res_.operator ? html` · run by ${res_.operator}` : ''}</p>
${res_.opening_hours ? html`<p class="small">Opening hours: ${res_.opening_hours}</p>` : ''}
${res_.phone ? html`<p class="small">Phone: <a href="tel:${String(res_.phone).replace(/[^\d+]/g, '')}">${res_.phone}</a></p>` : ''}
<p class="small">${website ? html`<a href="${website}" rel="noopener nofollow">Their website</a> · ` : ''}${website && res_.kind === 'foodbank' ? html`<a href="${watchHref(res_, website)}">Watch for changes</a> · ` : ''}<a href="${res_.osm_url}" rel="noopener nofollow">View on OpenStreetMap</a>${res_.wheelchair === true ? html` · wheelchair accessible` : ''}</p>
</li>`;
    }

    function resultsBlock(out) {
        if (!out.results.length) {
            return html`<p class="muted">Nothing was found within ${out.radius_km} km. OpenStreetMap does not know every food bank — try a wider area, or ask your local council.</p>`;
        }
        const watchable = out.results.some((r) => r.kind === 'foodbank' && safeUrl(r.website));
        return html`<ul class="places">${out.results.map(placeRow)}</ul>
${watchable ? html`<p class="muted small">Watch for changes opens OpenVibe.Watch with that place's website filled in: it checks the page and tells you when it changes, such as new opening hours or a closure.</p>` : ''}`;
    }

    // ── Home ─────────────────────────────────────────────────
    // What the home shows is read, never restated: the food list's own numbers (typical prices, nutrition), the recipe
    // library's cheapest published recipes, the delivery apps and meal kits Food compares, and the product's questions.
    // A block with nothing to show is left out.
    const FAQ = ((products.get('openvibe.food') || {}).faq || []);
    const proteinPerDollar = (f) => (f.price ? Math.round(f.package_protein_g / f.price) : null);
    const byKcal = foods.FOODS.filter((f) => f.kcal_per_dollar).sort((a, b) => b.kcal_per_dollar - a.kcal_per_dollar).slice(0, 8);
    const byProtein = foods.FOODS.filter((f) => proteinPerDollar(f)).sort((a, b) => proteinPerDollar(b) - proteinPerDollar(a)).slice(0, 8);
    const shortName = (f) => f.name.replace(/\s*\([^)]*\)\s*$/, '');
    const foodCard = (f, main, label) => html`<li><a href="/foods/${f.slug}"><b>${shortName(f)}</b><span class="hc-main"><strong>${main}</strong> ${label}</span><span class="hc-sub">${money(f.price)} at ${f.cheapest_store_name}, typical</span></a></li>`;
    const NEAR_CITIES = ['New York, NY', 'Los Angeles, CA', 'Chicago, IL', 'Houston, TX', 'Phoenix, AZ', 'Philadelphia, PA', 'San Antonio, TX', 'Seattle, WA'];
    r.get('/', async (req, res) => {
        let lib = { total: 0, cheap: [] };
        if (ctx.library) {
            try {
                const [{ total }, cheap] = await Promise.all([ctx.library.list({ limit: 1 }), ctx.library.cheapest(8)]);
                lib = { total, cheap };
            } catch { lib = { total: 0, cheap: [] }; }
        }
        // The newest FDA recall reports (server/food/recalls.js); none yet or a failed read leaves the block out.
        let recalls = { total: 0, latest: [] };
        try { const [total, latest] = await Promise.all([ctx.recalls.count(), ctx.recalls.list({ limit: 4 })]); recalls = { total, latest }; } catch { /* left out */ }
        const base = String(config.baseUrl).replace(/\/+$/, '');
        const hero = showcase.hero({
            eyebrow: `${SITE_NAME} · ${TAGLINE}`,
            title: 'Eat well.', accent: 'Spend less.',
            lede: 'Find food banks and budget grocers near you, plan meals with the shopping list and its cost, cook from what is in your cupboard, and compare every delivery app and meal kit at once.',
            actions: [
                { label: 'Find food near you', href: '/near', primary: true },
                { label: 'Plan a week', href: '/plan' },
                { label: 'The food list', href: '/foods' },
            ],
            note: 'Open source (AGPL-3.0). Places come from OpenStreetMap © contributors (ODbL); prices are typical, not live.',
            aside: { html: String(searchForm({ panel: true })) },
        });
        const stats = [
            { value: foods.FOODS.length, label: 'foods with nutrition and typical prices', href: '/foods' },
            { value: lib.total, label: 'budget recipes in the library', href: '/recipes/library' },
            { value: Object.keys(foods.STORES).length, label: 'budget chains priced', href: '/foods' },
            { value: delivery.APPS.length, label: 'delivery apps in one search', href: '/delivery' },
            { value: delivery.KITS.length, label: 'meal kits side by side', href: '/delivery#kits' },
            { value: recalls.total, label: 'FDA food recalls, newest first', href: '/recalls' },
        ].filter((x) => x.value);
        page(req, res, {
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            title: 'Food banks, cheap meals, every delivery app',
            description: 'Find food banks and budget grocers, plan cheap meals with the shopping list and its cost, cook from your cupboard and compare delivery apps.',
            jsonLd: [
                ...homeJsonLd(config),
                seo.jsonLd.itemList('The most food for a dollar on OpenVibe.Food', byKcal.map((f) => ({ name: shortName(f), url: `${base}/foods/${f.slug}` })), { url: `${base}/foods` }),
                FAQ.length ? seo.jsonLd.faq(FAQ.map((f) => ({ q: f.question, a: f.answer }))) : null,
            ],
            styles: [showcase.STYLESHEET], localStyles: ['css/home.css'],
            body: html`${raw(hero)}
${stats.length ? html`<ul class="home-stats" aria-label="${SITE_NAME} in numbers">${stats.map((x) => html`<li><a href="${x.href}"><b>${x.value}</b><span>${x.label}</span></a></li>`)}</ul>` : ''}
${lib.cheap.length ? html`<section class="sc-sec" aria-labelledby="h-meals"><h2 id="h-meals">Cheap meals from the recipe library</h2>
<p class="sc-lede">The recipes that cost least per serving, with every ingredient priced from the food list. Written by OpenVibe.AI: check a recipe before you cook it. <a href="/recipes/library">All ${lib.total} recipes</a></p>
<ul class="home-cards">${lib.cheap.map((x) => html`<li><a href="/recipes/library/${x.slug}"><b>${x.title}</b><span class="hc-main"><strong>${money(x.cost / x.serves)}</strong> a serving</span><span class="hc-sub">${[`${money(x.cost)} to buy`, `serves ${x.serves}`, x.minutes ? `about ${x.minutes} min` : null].filter(Boolean).join(' · ')}</span></a></li>`)}</ul></section>` : ''}
<section class="sc-sec" aria-labelledby="h-value"><h2 id="h-value">The most food for a dollar</h2>
<p class="sc-lede">Calories per dollar at the cheapest budget chain's typical price, from <a href="/foods">the food list</a>. Prices are a band to plan by, not a live price.</p>
<ul class="home-cards">${byKcal.map((f) => foodCard(f, f.kcal_per_dollar.toLocaleString('en-US'), 'calories for $1'))}</ul></section>
<section class="sc-sec" aria-labelledby="h-protein"><h2 id="h-protein">The cheapest protein</h2>
<p class="sc-lede">Grams of protein a dollar buys, at the same typical prices.</p>
<ul class="home-cards">${byProtein.map((f) => foodCard(f, `${proteinPerDollar(f)} g`, 'of protein for $1'))}</ul></section>
<section class="sc-sec" aria-labelledby="h-groups"><h2 id="h-groups">Browse the food list</h2>
<p class="sc-lede">Every food with its nutrition per serving and per 100 g, its typical price and the cheapest chain for it.</p>
<ul class="home-cards three">${Object.entries(foods.GROUPS).map(([id, g]) => { const n = foods.FOODS.filter((f) => f.group === id).length; return n ? html`<li><a href="/foods?group=${id}"><b>${g.name}</b><span class="hc-main"><strong>${n}</strong> foods</span><span class="hc-sub">${g.examples}</span></a></li>` : ''; })}</ul></section>
<section class="sc-sec" aria-labelledby="h-delivery"><h2 id="h-delivery">Every delivery app at once</h2>
<p class="sc-lede">Type a dish, a restaurant or groceries and each app opens its own search for it, in your own account, where its prices and fees are.</p>
<form class="home-search" method="get" action="/delivery" role="search"><label for="home-dv-q">A dish, a restaurant or groceries</label><span class="home-search-row"><input id="home-dv-q" name="q" type="search" maxlength="120" placeholder="pad thai, tacos, milk and eggs" required><button class="sc-btn sc-primary" type="submit">Search every app</button></span></form>
<ul class="home-chips">${delivery.APPS.map((a) => html`<li title="${a.best}">${a.name}</li>`)}</ul></section>
<section class="sc-sec" id="kits" aria-labelledby="h-kits"><h2 id="h-kits">Meal kits, side by side</h2>
<p class="sc-lede">From the cheapest kits to fully cooked meals. Each opens its own plans page, where the current price per serving is.</p>
<ul class="home-cards five">${delivery.KITS.map((k) => html`<li><a href="${k.plans}" rel="noopener nofollow" target="_blank"><b>${k.name} <span class="hc-tag">${delivery.TIER_TEXT[k.tier]}</span></b><span class="hc-sub">${k.what}</span><span class="hc-host">${k.host} ↗</span></a></li>`)}</ul></section>
<section class="sc-sec" aria-labelledby="h-near"><h2 id="h-near">Find a food bank</h2>
<p class="sc-lede">Food banks, soup kitchens, community fridges and free pantry boxes, with hours, from OpenStreetMap. Search any town or postcode, or start with a city.</p>
<ul class="home-chips">${NEAR_CITIES.map((c) => html`<li><a href="/near?${new URLSearchParams({ q: c })}">${c.split(',')[0]}</a></li>`)}</ul>
<p><a class="sc-btn sc-primary" href="/near">Search near you</a></p></section>
${recalls.latest.length ? html`<section class="sc-sec" aria-labelledby="h-recalls"><h2 id="h-recalls">Food recalls</h2>
<p class="sc-lede">The newest of the FDA's food recall reports: what was recalled, by whom and how serious it is. <a href="/recalls">All ${recalls.total} recalls</a></p>
<ul class="home-cards">${recalls.latest.map((x) => html`<li><a href="/recalls/${x.recall_number}"><b>${x.product.length > 90 ? `${x.product.slice(0, 89).replace(/\s+\S*$/, '')}…` : x.product}</b><span class="hc-main"><strong>${x.classification || 'Recall'}</strong> ${x.firm || ''}</span><span class="hc-sub">${[x.reported_on ? `Reported ${recallDate(x.reported_on)}` : null, x.state].filter(Boolean).join(' · ')}</span></a></li>`)}</ul></section>` : ''}
${raw(showcase.features({
                title: 'Everything food',
                lede: 'All working today: no card, no account needed to look around.',
                items: [
                    { icon: 'ov:map', title: 'Food near you', text: 'Food banks, soup kitchens, community fridges and free pantry boxes, plus budget grocers, with hours.', href: '/near' },
                    { icon: 'ov:docs', title: 'A meal planner', text: 'Up to fourteen days for one person to a group, with the shopping list and its cost. Share it, and your household ticks it off together.', href: '/plan' },
                    { icon: 'ov:tools', title: 'A food list you can read', text: 'Nutrition per serving and per 100 g, the typical price, and the cheapest budget chain for each item.', href: '/foods' },
                    { icon: 'ov:account', title: 'Your cupboard', text: 'Add what you have by barcode, photo or receipt; see what you can make now and what one more item unlocks.', href: '/pantry' },
                    { icon: 'ov:search', title: 'Delivery, compared', text: 'Search DoorDash, Uber Eats, Grubhub and more at once, and compare meal kits.', href: '/delivery' },
                    { icon: 'ov:ai', title: 'Recipes on a budget', text: 'Cheap recipes costed from the food list, and ideas from your cupboard. Written by AI: check before you cook.', href: '/recipes' },
                ],
            }))}
${FAQ.length ? html`<section class="sc-sec" aria-labelledby="h-faq"><h2 id="h-faq">Questions people ask</h2>
<div class="home-faq">${FAQ.map((f) => html`<details><summary>${f.question}</summary><p>${f.answer}</p></details>`)}</div></section>` : ''}
${raw(showcase.cta({
                title: 'Start where you are',
                text: 'Search your town for a food bank, plan the next three days for what you can spend, or look up what is in the tin before you open it.',
                actions: [{ label: 'Find food near you', href: '/near', primary: true }, { label: 'Plan meals', href: '/plan' }, { label: 'The food list', href: '/foods' }],
            }))}`,
        });
    });

    // ── Food near you ────────────────────────────────────────
    const queryNum = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    // A page load only costs the shared OpenStreetMap budget when it will actually search.
    const wantsSearch = (req) => !!str(req.query.q) || (queryNum(req.query.lat) != null && queryNum(req.query.lon) != null);

    async function nearPage(req, res, { limited = false } = {}) {
        const q = str(req.query.q);
        const kind = KINDS[req.query.kind] ? req.query.kind : 'foodbank';
        let out = null;
        let problem = null;
        if (limited) {
            problem = 'Too many searches from you just now. Try again in a minute.';
        } else if (wantsSearch(req)) {
            try {
                out = await searchPlaces(ctx.upstream, { kind, q, lat: queryNum(req.query.lat), lon: queryNum(req.query.lon), radiusKm: queryNum(req.query.radius) }, config);
            } catch (err) {
                problem = err && err.code ? err.message : 'The place search is unavailable right now. Try again in a few minutes.';
            }
        }
        const title = out && out.location.name ? `Food near ${out.location.name.split(',').slice(0, 2).join(',')}` : 'Food near you';
        // The page itself is in search (the sitemap lists it; it was noindex by default); a search's results are not.
        page(req, res, {
            title, description: 'Food banks, pantries and budget grocery stores near a place, from OpenStreetMap.',
            index: !wantsSearch(req), cache: !wantsSearch(req) && !signedIn(req) ? PUBLIC_CACHE : null,
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
        }, limited ? 429 : 200);
    }

    // The search on this page spends the same per-caller budget the API does (server/http/caller-limits.js), so a
    // script cannot reach OpenStreetMap through the HTML route while the API is limited. The budget runs before the
    // search; over it, the limiter's refusal is turned into the page's normal message (a 429 page), not its JSON.
    const placeSearch = limits.budget('food.place.search');
    r.get('/near', (req, res) => {
        if (!wantsSearch(req)) return nearPage(req, res);
        let settled = false;
        let retryAfter = '60';
        const allowed = () => { if (!settled) { settled = true; nearPage(req, res); } };
        const refused = () => {
            if (settled) return;
            settled = true;
            res.set('Retry-After', retryAfter);
            nearPage(req, res, { limited: true });
        };
        // The limiter calls next when the caller is under budget, or ends the response itself when over it; it is
        // handed a stand-in response so a refusal cannot write its JSON problem onto this HTML route.
        placeSearch(req, { statusCode: 200, setHeader: (k, v) => { if (String(k).toLowerCase() === 'retry-after') retryAfter = String(v); }, end: refused }, allowed);
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

    function planBody(plan, { shopping = true } = {}) {
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
${shopping ? html`<h2>The shopping list</h2>
${table(['Item', 'Packs', 'Where', 'Cost'], plan.shopping_list.map((i) => [html`<a href="/foods/${i.slug}">${i.name}</a>`, String(i.packs), i.store_name || '—', money(i.cost)]), { empty: 'Nothing in the plan.' })}
<p class="muted small">Cheapest total ${money(plan.totals.cost)} at ${plan.by_store.length} ${plan.by_store.length === 1 ? 'store' : 'stores'}: ${plan.by_store.map((x) => `${x.store_name} ${money(x.cost)}`).join(', ')}. ${plan.totals.packs} packs.</p>` : ''}
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
        // A public tool page in search (it was noindex by default while the sitemap listed it); every ?people=&days=
        // variant names /plan as canonical (layout.js drops the query).
        page(req, res, {
            title: 'Meal plan', description: 'A budget meal plan with a shopping list and an estimated cost, from the OpenVibe.Food food list.',
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            crumbs: [{ label: 'Meal plan' }], styles: [showcase.STYLESHEET],
            body: html`<h1>Plan meals</h1>
<p class="lede">It buys one item from each of the six food groups first, cheapest per serving, then fills up with the best calories per dollar. Deterministic: the same numbers always give the same plan.</p>
${planForm(spec)}
${savedId && /^pln_[0-9A-Z]{26}$/.test(savedId) ? notice(html`Saved. <a href="/plan/p/${savedId}">Open it</a> to tick the shopping list off or share it with your household.`, 'ok') : ''}
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
        const [rows, shared] = await Promise.all([store.listPlans(s, ownerOf(req), { limit: 50 }), store.listSharedPlans(s, ownerOf(req))]);
        const cells = (row, when) => {
            const plan = typeof row.plan === 'string' ? JSON.parse(row.plan) : row.plan;
            return [html`<a href="/plan/p/${row.id}">${planTitle(row)}</a>`, `${row.people} people, ${row.days} days`, money(plan.totals.cost), time(when)];
        };
        page(req, res, {
            title: 'Your plans', crumbs: [{ label: 'Meal plan', href: '/plan' }, { label: 'Saved' }],
            body: html`<h1>Your saved plans</h1>
${table(['Name', 'For', 'Cost', 'Saved'], rows.map((row) => cells(row, row.created_at)), { empty: 'No saved plans yet. Make one on the plan page and save it.' })}
${shared.length ? html`<h2>Shared with you</h2>
${table(['Name', 'For', 'Cost', 'Joined'], shared.map((row) => cells(row, row.joined_at)))}` : ''}
<p><a href="/plan">Plan another</a></p>`,
        });
    });

    // ── Plan together: a saved plan's page, its household and the shared shopping list ──
    // The owner makes a share link; anyone signed in who opens it and says yes joins the household, sees the plan and
    // ticks the shopping list off for everyone. Only the SHA-256 of the link's secret is kept, so a link is shown once;
    // a new one replaces it and turning it off stops new joins (members stay until removed). Every change is a POST
    // from openvibe.food itself.
    const PLAN_ID = /^pln_[0-9A-Z]{26}$/;
    const SECRET = /^[A-Za-z0-9_-]{43}$/;
    const hashOf = (secret) => crypto.createHash('sha256').update(secret).digest('hex');
    const nameOf = (req) => String(req.viewer.displayName || req.viewer.username || 'someone').slice(0, 80);
    const planTitle = (row) => row.title || `Plan ${String(row.id).slice(-6)}`;
    const PLAN_STYLES = { styles: [showcase.STYLESHEET], localStyles: ['css/plan.css'] };
    const form = express.urlencoded({ extended: false, limit: '16kb' });
    const toLogin = (req, res) => res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl.slice(0, 400))}`);
    const notOurs = (req, res) => res.status(403).type('text/plain').send('A plan is changed from openvibe.food itself.');

    async function loadPlan(req, res) {
        const id = str(req.params.id, 40);
        const got = id && PLAN_ID.test(id) ? await store.planForViewer(s, ownerOf(req), id) : null;
        if (got) return got;
        page(req, res, { title: 'Plan not found', crumbs: [{ label: 'Meal plan', href: '/plan' }, { label: 'Not found' }],
            body: html`<h1>Plan not found</h1><p>It is not yours or shared with you, or it was deleted.</p><p><a href="/plan/saved">Your plans</a></p>` }, 404);
        return null;
    }

    /** The household's room on OpenVibe.Chat, with Pantry, an AI member that knows the plan and every cupboard. */
    const chatDeps = (req) => ({ config, token: req.viewer && req.viewer.token, log: ctx.log || console });
    function chatSection(row, role, members) {
        const intro = html`<p class="muted small">Pantry, the chat's AI member, knows this plan, what is still to buy and what everyone keeps in their pantry here: write <code>@pantry</code> to ask it what to cook.</p>`;
        if (row.chat_room) {
            return html`<h2 id="chat">The household chat</h2>${intro}
<p><a class="sc-btn sc-primary" href="${config.chat.publicUrl}/r/${encodeURIComponent(row.chat_room)}">Open the household chat</a></p>
<p class="muted small">A private room on OpenVibe.Chat for ${members.length + 1} ${members.length ? 'people' : 'person'}. ${role === 'owner' ? 'People who join the household are added when you open this page.' : ''}</p>`;
        }
        if (role !== 'owner') return html`<h2 id="chat">The household chat</h2><p class="muted small">The plan's owner can start a private chat for the household, with an AI member that knows your pantries.</p>`;
        return html`<h2 id="chat">The household chat</h2>${intro}
<form method="post" action="/plan/p/${row.id}/chat"><button class="sc-btn sc-primary" type="submit">Start the household chat</button></form>
<p class="muted small">It makes a private room on OpenVibe.Chat for you${members.length ? ' and everyone in this household' : ''}. You can add more people and change Pantry in the room's settings.</p>`;
    }

    async function planPage(req, res, got, { link = null, problem = null, status = 200 } = {}) {
        const { row, role } = got;
        const plan = typeof row.plan === 'string' ? JSON.parse(row.plan) : row.plan;
        const [members, ticks] = await Promise.all([store.listMembers(s, row.id), store.listTicks(s, row.id)]);
        if (role === 'owner' && row.chat_room) householdChat.syncMembers(chatDeps(req), row, members).catch(() => {});
        const ticked = new Map(ticks.map((t) => [t.item, t]));
        const got_ = plan.shopping_list.filter((i) => ticked.has(i.slug)).length;
        const me = ownerOf(req);
        const btn = (action, label, { cls = 'sc-btn', fields = {} } = {}) => html`<form method="post" action="/plan/p/${row.id}/${action}">${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button class="${cls}" type="submit">${label}</button></form>`;
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        page(req, res, {
            title: planTitle(row), crumbs: [{ label: 'Meal plan', href: '/plan' }, { label: 'Your plans', href: '/plan/saved' }, { label: planTitle(row) }], ...PLAN_STYLES,
            body: html`<h1>${planTitle(row)}</h1>
<p class="lede">${role === 'owner' ? 'Your plan' : 'Shared with you'} · ${members.length + 1} ${members.length ? 'people in this household' : 'person so far'}.</p>
${problem ? notice(problem, 'warn') : ''}
<h2>The shopping list</h2>
<p class="muted small">${got_} of ${plan.shopping_list.length} got. A tick shows for everyone in the household.</p>
<ul class="shop-list">${plan.shopping_list.map((i) => {
                const t = ticked.get(i.slug);
                return html`<li class="${t ? 'got' : ''}"><form method="post" action="/plan/p/${row.id}/tick"><input type="hidden" name="item" value="${i.slug}"><input type="hidden" name="done" value="${t ? '0' : '1'}"><button class="tick" type="submit" aria-pressed="${t ? 'true' : 'false'}" aria-label="${t ? 'Not got yet' : 'Got it'}: ${i.name}">${t ? '✓' : ''}</button></form>
<span class="shop-name"><a href="/foods/${i.slug}">${i.name}</a> × ${String(i.packs)}</span><span class="shop-meta muted small">${i.store_name || ''} ${money(i.cost)}${t ? html` · got by ${t.ticked_by === me ? 'you' : (t.name || 'someone')}` : ''}</span></li>`;
            })}</ul>
${planBody(plan, { shopping: false })}
<h2 id="household">The household</h2>
<ul class="household">
<li>${role === 'owner' ? 'You' : 'The plan’s owner'} <span class="badge">owner</span></li>
${members.map((m) => html`<li>${m.member === me ? 'You' : (m.name || 'Someone')} <span class="muted small">joined ${time(m.joined_at)}</span>${role === 'owner' ? btn('remove', 'Remove', { fields: { member: m.member } }) : ''}</li>`)}
</ul>
${chatSection(row, role, members)}
${role === 'owner' ? html`${link ? html`<div class="notice ok" role="status"><p><b>Your share link.</b> Anyone signed in with OpenVibe who opens it can join this household. It is shown once: copy it now. A new link replaces it.</p>
<p class="share-link"><input type="text" readonly value="${link}" aria-label="Share link"></p></div>` : ''}
<p class="muted small">${row.share_hash ? 'A share link is on.' : 'No share link is on.'} Members see this plan and tick the shopping list; only you change the household.</p>
<div class="plan-actions">${btn('share', row.share_hash ? 'Make a new share link' : 'Make a share link', { cls: 'sc-btn sc-primary' })}${row.share_hash ? btn('unshare', 'Turn the link off') : ''}${btn('delete', 'Delete this plan', { cls: 'sc-btn danger' })}</div>`
                : html`<div class="plan-actions">${btn('leave', 'Leave this household', { cls: 'sc-btn danger' })}</div>`}`,
        }, status);
    }

    r.get('/plan/p/:id', async (req, res) => {
        if (!signedIn(req)) return toLogin(req, res);
        const got = await loadPlan(req, res);
        if (got) await planPage(req, res, got);
    });

    r.post('/plan/p/:id/:action', form, async (req, res) => {
        if (!signedIn(req)) return toLogin(req, res);
        if (!sameOrigin(req, config.baseUrl)) return notOurs(req, res);
        const got = await loadPlan(req, res);
        if (!got) return undefined;
        const { row, role } = got;
        const body = req.body || {};
        const back = () => res.redirect(303, `/plan/p/${row.id}`);
        switch (req.params.action) {
        case 'tick': {
            const plan = typeof row.plan === 'string' ? JSON.parse(row.plan) : row.plan;
            const item = str(body.item, 80);
            if (!item || !plan.shopping_list.some((i) => i.slug === item)) return res.status(400).type('text/plain').send('That is not on this shopping list.');
            if (body.done === '0') await store.untick(s, row.id, item);
            else await store.tick(s, row.id, item, ownerOf(req), nameOf(req), s.iso());
            return back();
        }
        case 'leave':
            if (role === 'member') await store.removeMember(s, row.id, ownerOf(req));
            return res.redirect(303, '/plan/saved');
        case 'share': case 'unshare': case 'remove': case 'delete': case 'chat':
            if (role !== 'owner') return res.status(403).type('text/plain').send('Only the plan’s owner changes the household.');
            break;
        default:
            return res.status(404).type('text/plain').send('Not found.');
        }
        if (req.params.action === 'share') {
            const secret = crypto.randomBytes(32).toString('base64url');
            await store.setShareHash(s, ownerOf(req), row.id, hashOf(secret));
            return planPage(req, res, { row: { ...row, share_hash: 'on' }, role }, { link: `${config.baseUrl}/plan/join/${secret}` });
        }
        if (req.params.action === 'chat') {
            if (row.chat_room) return res.redirect(303, `/plan/p/${row.id}#chat`);
            const out = await householdChat.openRoom(chatDeps(req), s, row, await store.listMembers(s, row.id));
            if (!out.ok) return planPage(req, res, got, { problem: out.detail, status: 502 });
            return res.redirect(303, `/plan/p/${row.id}#chat`);
        }
        if (req.params.action === 'unshare') await store.setShareHash(s, ownerOf(req), row.id, null);
        if (req.params.action === 'remove') { const m = str(body.member, 80); if (m) await store.removeMember(s, row.id, m); }
        if (req.params.action === 'delete') { await store.deletePlan(s, ownerOf(req), row.id); return res.redirect(303, '/plan/saved'); }
        return back();
    });

    async function joinTarget(req, res) {
        const secret = String(req.params.secret || '');
        const row = SECRET.test(secret) ? await store.planByShareHash(s, hashOf(secret)) : null;
        if (row) return row;
        page(req, res, { title: 'Link not working', crumbs: [{ label: 'Meal plan', href: '/plan' }, { label: 'Join' }],
            body: html`<h1>This link does not work any more</h1><p>Its owner turned it off or made a new one. Ask them for the new link.</p><p><a href="/plan">Make your own plan</a></p>` }, 404);
        return null;
    }

    r.get('/plan/join/:secret', async (req, res) => {
        if (!signedIn(req)) return toLogin(req, res);
        const row = await joinTarget(req, res);
        if (!row) return undefined;
        if (await store.planForViewer(s, ownerOf(req), row.id)) return res.redirect(303, `/plan/p/${row.id}`);
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        return page(req, res, {
            title: 'Join a household', crumbs: [{ label: 'Meal plan', href: '/plan' }, { label: 'Join' }], ...PLAN_STYLES,
            body: html`<h1>Join “${planTitle(row)}”?</h1>
<p class="lede">You will see this meal plan (${row.people} people, ${row.days} days) and tick its shopping list off with everyone in the household. The household sees your name, ${nameOf(req)}. You can leave at any time.</p>
<form method="post" action="/plan/join/${req.params.secret}"><button class="sc-btn sc-primary" type="submit">Join the household</button></form>`,
        });
    });

    r.post('/plan/join/:secret', form, async (req, res) => {
        if (!signedIn(req)) return toLogin(req, res);
        if (!sameOrigin(req, config.baseUrl)) return notOurs(req, res);
        const row = await joinTarget(req, res);
        if (!row) return undefined;
        if (row.owner !== ownerOf(req)) {
            const out = await store.addMember(s, row.id, ownerOf(req), nameOf(req), s.iso());
            if (out === 'food.plan.full' || out === 'food.plan.too_many') {
                return page(req, res, { title: 'Could not join', crumbs: [{ label: 'Meal plan', href: '/plan' }, { label: 'Join' }],
                    body: html`<h1>Could not join</h1><p>${out === 'food.plan.full' ? `This household is full (${store.MEMBERS_MAX} people besides its owner).` : `You are already in ${store.SHARED_PLANS_MAX} households; leave one first.`}</p><p><a href="/plan/saved">Your plans</a></p>` }, 409);
            }
        }
        return res.redirect(303, `/plan/p/${row.id}`);
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
    async function pantryPage(req, res, { saved = false, added = null, addedCount = 0 } = {}) {
        if (!signedIn(req)) {
            return page(req, res, {
                description: 'Keep what is in your cupboard, added by barcode, photo or receipt, and see which budget recipes you can make with it now.', title: 'Your cupboard', crumbs: [{ label: 'Your cupboard' }], styles: [showcase.STYLESHEET],
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
            description: 'Keep what is in your cupboard, added by barcode, photo or receipt, and see which budget recipes you can make with it now.', title: 'Your cupboard', crumbs: [{ label: 'Your cupboard' }], styles: [showcase.STYLESHEET], localStyles: ['css/pantry.css'], scripts: ['js/barcode-scan.js', 'js/pantry-photo.js'],
            body: html`<h1>Your cupboard</h1>
<p class="lede">Tick what you have. Nothing leaves your account; the matching is done here, not by a model.</p>
${saved ? notice('Cupboard saved.', 'ok') : ''}
${added && foods.getFood(added) ? notice(html`Added <b>${foods.getFood(added).name}</b> to your cupboard.`, 'ok') : ''}
${addedCount > 1 && addedCount <= 80 ? notice(`Added ${addedCount} items to your cupboard.`, 'ok') : ''}
<form method="get" action="/pantry/barcode" class="pantry-barcode" role="search">
<label for="bc">Add by barcode</label>
<div class="pantry-barcode-row"><input id="bc" name="code" inputmode="numeric" autocomplete="off" pattern="[0-9 \-]{8,18}" maxlength="18" placeholder="The numbers under the bars" required>
<button class="sc-btn" type="submit">Look it up</button>
<button class="sc-btn" type="button" id="bc-scan" hidden>Scan with camera</button></div>
<video id="bc-video" playsinline muted hidden></video>
<p class="muted small">Looks the product up on <a href="https://world.openfoodfacts.org/">Open Food Facts</a> and asks you before adding it. Only the barcode is sent.</p>
</form>
<form method="post" action="/pantry/photo" class="pantry-photo" id="photo-form">
<fieldset><legend>Add from a photo or a receipt</legend>
<div class="pantry-photo-kind"><label><input type="radio" name="kind" value="shelf" checked> A cupboard, fridge or shelf</label>
<label><input type="radio" name="kind" value="receipt"> A grocery receipt</label></div>
<input type="file" id="photo-file" accept="image/*" capture="environment" aria-describedby="photo-note">
<input type="hidden" name="image" id="photo-data">
<button class="sc-btn" type="submit" id="photo-send" disabled>Read the photo</button>
<p class="muted small" id="photo-note">OpenVibe.AI reads the photo and lists what it sees from Food's list; you choose what to add. The photo is made smaller on your device first, is not kept, and a receipt's prices, card and store details are never read out. Ten photos a day. Needs JavaScript.</p>
</fieldset></form>
<p><a href="/recipes">Get recipe ideas</a></p>
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

    r.get('/pantry', (req, res) => pantryPage(req, res, { saved: !!req.query.saved, added: typeof req.query.added === 'string' ? req.query.added : null, addedCount: Number(req.query.added_count) || 0 }));

    // ── Pantry by barcode (server/food/barcode.js) ───────────
    // Look a barcode up and ask before adding: the match is preselected, any other item can be picked instead.
    r.get('/pantry/barcode', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/pantry')}`);
        let found = null;
        let problem = null;
        try { found = await ctx.barcodes.lookup(req.query.code); } catch (err) { problem = err.message; }
        const pick = found && found.match ? foods.getFood(found.match) : null;
        const options = foods.FOODS.map((f) => html`<option value="${f.slug}"${pick && pick.slug === f.slug ? raw(' selected') : ''}>${f.name}</option>`);
        page(req, res, {
            title: 'Add by barcode', crumbs: [{ label: 'Your cupboard', href: '/pantry' }, { label: 'Add by barcode' }], styles: [showcase.STYLESHEET], localStyles: ['css/pantry.css'],
            body: html`<h1>Add by barcode</h1>
${problem ? notice(problem, 'warn') : ''}
${found && found.found ? html`<p class="lede"><b>${found.name || 'A product with no name listed'}</b>${found.brand ? html` · ${found.brand}` : ''}${found.quantity ? html` · ${found.quantity}` : ''}</p>
<p class="muted small">Barcode ${found.code}, from <a href="${found.url}" rel="noopener nofollow">Open Food Facts</a> (Open Database License).</p>
${pick ? html`<p>That is <b>${pick.name}</b> on Food's list.</p>` : html`<p>It does not match an item on Food's list by itself. Pick the closest one, or go back.</p>`}`
        : found ? html`<p class="lede">Open Food Facts does not know barcode ${found.code} yet.</p>
<p class="muted small">You can <a href="${found.url}" rel="noopener nofollow">add it there</a> for everyone, or pick the item from the list below.</p>` : ''}
${found ? html`<form method="post" action="/pantry/items" class="pantry-confirm">
<label for="item">Add to your cupboard as</label>
<select id="item" name="item">${pick ? '' : html`<option value="" selected disabled>Choose an item</option>`}${options}</select>
<button class="sc-btn sc-primary" type="submit">Add to my cupboard</button></form>` : ''}
<p><a href="/pantry">Back to your cupboard</a></p>`,
        });
    });

    // ── Pantry by photo or receipt (OpenVibe.AI food.read_pantry_photo) ──
    // The page's script shrinks the photo on the device and sends it as a data URL; the model names list items by
    // number; the person ticks what to add. Ten photos a person a day (this process's count).
    const photoReads = new Map();
    const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
    r.post('/pantry/photo', express.urlencoded({ extended: false, limit: '4mb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fpantry');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Send a photo from openvibe.food itself.');
        const b = req.body || {};
        const kind = b.kind === 'receipt' ? 'receipt' : 'shelf';
        const image = typeof b.image === 'string' ? b.image : '';
        const owner = ownerOf(req);
        const today = new Date(s.now()).toISOString().slice(0, 10);
        const used = photoReads.get(owner);
        const count = used && used.day === today ? used.n : 0;
        let problem = null;
        let out = null;
        if (!PHOTO_RE.test(image) || image.length > 3_500_000) problem = 'That photo did not arrive. Choose it again, and wait until "Read the photo" lights up.';
        else if (!config.aiUrl || !ctx.ai) problem = 'Reading photos needs OpenVibe.AI, which is not connected here.';
        else if (count >= 10) problem = 'That is ten photos today. Barcodes and the list below still work.';
        else {
            photoReads.set(owner, { day: today, n: count + 1 });
            try {
                const run = await ctx.ai.run('food.read_pantry_photo', { image: { data_url: image }, kind, foods: foods.FOODS.map((f) => f.name) }, {
                    onBehalfOf: { type: 'user', id: owner.replace(/^user:/, '') }, target: { service: 'food', type: 'pantry', id: owner.replace(/^user:/, '') },
                });
                out = run && run.output;
            } catch (err) {
                if (err && err.name === 'AiRunError') problem = 'OpenVibe.AI could not read that photo just now. Try again in a moment, or use a barcode.';
                else throw err;
            }
        }
        const seen = new Map();
        for (const it of (out && Array.isArray(out.items) ? out.items : [])) {
            const f = Number.isInteger(it && it.food) ? foods.FOODS[it.food] : null;
            if (f && !seen.has(f.slug)) seen.set(f.slug, { food: f, seen: String(it.seen || '').slice(0, 160), confidence: ['high', 'medium', 'low'].includes(it.confidence) ? it.confidence : 'low' });
        }
        const have = new Set(await store.getPantry(s, owner));
        const unlisted = (out && Array.isArray(out.unlisted) ? out.unlisted : []).map((x) => String(x).slice(0, 120)).filter(Boolean).slice(0, 30);
        const rows = [...seen.values()];
        page(req, res, {
            title: kind === 'receipt' ? 'From your receipt' : 'From your photo', crumbs: [{ label: 'Your cupboard', href: '/pantry' }, { label: 'From a photo' }],
            styles: [showcase.STYLESHEET], localStyles: ['css/pantry.css'],
            body: html`<h1>${kind === 'receipt' ? 'From your receipt' : 'From your photo'}</h1>
${problem ? notice(problem, 'warn') : ''}
${!problem && rows.length ? html`<p class="lede">OpenVibe.AI saw these from Food's list. Untick anything that is wrong, then add the rest.</p>
<form method="post" action="/pantry/items" class="pantry-photo-confirm">
<ul class="pantry-seen">${rows.map((r) => html`<li><label><input type="checkbox" name="item" value="${r.food.slug}"${r.confidence !== 'low' ? raw(' checked') : ''}> <b>${r.food.name}</b>${have.has(r.food.slug) ? html` <span class="muted small">already in your cupboard</span>` : ''}</label>
<span class="muted small">${r.seen}${r.confidence === 'low' ? ' · not sure' : ''}</span></li>`)}</ul>
<button class="sc-btn sc-primary" type="submit">Add to my cupboard</button></form>` : ''}
${!problem && !rows.length ? html`<p class="lede">Nothing from Food's list was clear in that photo.</p>` : ''}
${unlisted.length ? html`<p class="muted small">Also seen, not on Food's list: ${unlisted.join(', ')}.</p>` : ''}
<p class="muted small">Read by OpenVibe.AI; the photo was not kept. Check before you cook or shop.</p>
<p><a href="/pantry">Back to your cupboard</a></p>`,
        });
    });

    r.post('/pantry/items', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fpantry');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Add to a cupboard from openvibe.food itself.');
        const picked = [...new Set([].concat((req.body && req.body.item) || []).map((v) => foods.getFood(String(v))).filter(Boolean).map((f) => f.slug))].slice(0, 80);
        if (!picked.length) return res.redirect(303, '/pantry');
        for (const slug of picked) await store.addPantryItem(s, ownerOf(req), slug);
        return res.redirect(303, picked.length === 1 ? `/pantry?added=${encodeURIComponent(picked[0])}` : `/pantry?added_count=${picked.length}`);
    });

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

    // ── Recipe ideas from the network's AI ───────────────────
    function recipeBlock(r) {
        const meta = [r.serves != null ? `Serves ${r.serves}` : null, r.minutes != null ? `About ${r.minutes} min` : null].filter(Boolean);
        return html`<article class="recipe">
<header class="recipe-head"><h3>${r.title}</h3>${meta.length ? html`<p class="recipe-meta">${meta.join(' · ')}</p>` : ''}</header>
<div class="recipe-body">
<section class="recipe-ingredients" aria-label="Ingredients"><h4>Ingredients</h4>
<ul>${r.ingredients.map((i) => html`<li><span>${i.name}${i.amount ? html` <span class="muted">${i.amount}</span>` : ''}</span>${i.from_pantry ? html` <span class="badge ok">in your cupboard</span>` : ''}</li>`)}</ul></section>
<section class="recipe-steps" aria-label="Steps"><h4>Steps</h4>
<ol>${r.steps.map((st) => html`<li>${st}</li>`)}</ol></section>
</div>
${r.to_buy && r.to_buy.length ? html`<div class="recipe-buy"><h4>Still to buy</h4>
<ul>${r.to_buy.map((x) => html`<li><span>${x.name}</span><span>${x.price == null ? 'no typical price' : money(x.price)}</span></li>`)}</ul>
<p class="recipe-total"><span>Typical total${r.to_buy_cost_partial ? ' (items with a price)' : ''}</span><strong>${money(r.to_buy_cost)}</strong></p>
<p class="muted small">${r.cost_note}</p></div>` : html`<p class="recipe-buy recipe-buy-none">Everything this recipe needs is already in your cupboard.</p>`}
${r.notes ? html`<div class="recipe-notes small">${raw(markdown(r.notes))}</div>` : ''}
</article>`;
    }

    async function recipesPage(req, res, { saved = false, error = null } = {}) {
        if (!signedIn(req)) {
            return page(req, res, {
                description: 'Budget recipe ideas from what is in your cupboard, costed from the food list, plus a library of cheap recipes. Written by AI.', title: 'Recipe ideas', crumbs: [{ label: 'Recipe ideas' }], styles: [showcase.STYLESHEET], localStyles: ['css/recipes.css'],
                body: html`<h1>Recipe ideas</h1>
<p class="lede">Tell OpenVibe.Food what you feel like and how many people you are feeding. It suggests up to three recipes from the food list, marks what is already in your cupboard and lists what you would still need to buy, with a typical cost.</p>
<p><a class="sc-btn sc-primary" href="/auth/login?next=%2Frecipes">Sign in to get recipe ideas</a> <a class="sc-btn" href="/recipes/library">Browse the recipe library</a></p>`,
            });
        }
        const rows = (await store.listRecipeSuggestions(s, ownerOf(req), { limit: 20 })).map(store.recipeSuggestionToWire);
        const problems = {
            'food.pantry_empty': 'Add what you have to your cupboard first — there is nothing to suggest recipes from.',
            'food.ai_off': 'Recipe ideas are not available right now.',
            'food.recipes.invalid': 'That request did not make sense. Try again.',
            'food.recipes_daily_limit': 'You have reached today\'s recipe idea limit. Come back tomorrow.',
        };
        page(req, res, {
            description: 'Budget recipe ideas from what is in your cupboard, costed from the food list, plus a library of cheap recipes. Written by AI.', title: 'Recipe ideas', crumbs: [{ label: 'Recipe ideas' }], styles: [showcase.STYLESHEET], localStyles: ['css/recipes.css'],
            body: html`<h1>Recipe ideas</h1>
<p class="lede">What do you feel like, and for how many people? OpenVibe.AI suggests up to three recipes from the food list, and OpenVibe.Food works out what you would still need to buy from its own typical prices.</p>
${saved ? notice('Recipe ideas saved below.', 'ok') : ''}
${error ? notice(problems[error] || 'That did not work. Try again.', 'warn') : ''}
<form class="ov-form recipe-form" method="post" action="/recipes">
<div class="recipe-field recipe-field-ask"><label for="ask">What do you feel like? <span class="muted">(optional)</span></label>
<input id="ask" name="ask" type="text" maxlength="500" placeholder="Something quick and filling"></div>
<div class="recipe-field"><label for="people">People <span class="muted">(optional)</span></label>
<input id="people" name="people" type="number" min="1" max="12" step="1" inputmode="numeric"></div>
<button class="sc-btn sc-primary" type="submit">Suggest recipes</button>
</form>
<p class="muted small">Ideas come from what is in <a href="/pantry">your cupboard</a>. Up to 10 requests a day. Or browse <a href="/recipes/library">the recipe library</a>.</p>
${rows.length ? html`<h2>Recent ideas</h2>
<p class="notice">Suggested by OpenVibe.AI from your cupboard and the food list. Check a recipe before you cook it: cook meat, poultry and eggs through, and mind allergies.</p>
${rows.map((row) => html`<section class="recipe-suggestion">
<p class="recipe-asked muted small">${row.ask ? html`“${row.ask}” · ` : ''}${row.people ? html`${row.people} ${row.people === 1 ? 'person' : 'people'} · ` : ''}${time(row.created_at)}</p>
${row.recipes.length ? html`<div class="recipe-grid">${row.recipes.map(recipeBlock)}</div>` : html`<p class="muted">No recipe could be made from the food list this time. Try a different request.</p>`}
</section>`)}` : html`<p class="muted">No ideas yet. Say what you feel like above, or just press Suggest recipes.</p>`}`,
        });
    }

    // ── Delivery and meal kits, compared (server/food/delivery.js): every app's own search, never their data ──
    r.get('/delivery', (req, res) => {
        const q = delivery.cleanQuery(req.query.q);
        const links = delivery.linksFor(q);
        const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
        const kitRow = (k) => html`<li class="dv-kit"><span class="dv-tier dv-${k.tier}">${delivery.TIER_TEXT[k.tier]}</span>
<span class="dv-kit-main"><a class="dv-kit-name" href="${k.plans}" target="_blank" rel="noopener nofollow">${k.name} ↗</a><span class="muted small">${k.what}</span></span>
<a class="dv-watch small" href="${WATCH_NEW}?${new URLSearchParams({ template: 'page', url: k.plans, name: `Food: ${k.name} prices` })}">Watch its prices</a></li>`;
        page(req, res, {
            title: q ? `“${q}” on every delivery app` : 'Delivery and meal kits, compared',
            description: 'Search DoorDash, Uber Eats, Grubhub, Seamless, Caviar and Instacart at once, and compare meal kits from EveryPlate and Dinnerly to HelloFresh, Home Chef, Green Chef and Factor.',
            index: !q, cache: q ? null : cache.htmlHeaders({ maxAge: 300 }),
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Delivery' }],
            styles: [showcase.STYLESHEET], localStyles: ['css/delivery.css'],
            body: html`<h1>${q ? html`“${q}” on every delivery app` : 'Delivery and meal kits, compared'}</h1>
<p class="lede">Type it once: every delivery app opens its own search for it, in a new tab. Prices, fees and your address stay on each app, so you see your real total where you are signed in.</p>
<form class="dv-form" method="get" action="/delivery" role="search"><label for="dv-q">A dish, a restaurant or groceries</label>
<div class="dv-row"><input id="dv-q" name="q" type="search" maxlength="120" required placeholder="pad thai, Chipotle, eggs and milk" value="${q}"><button class="sc-btn sc-primary" type="submit">Search every app</button></div></form>
${links.length ? html`<ul class="dv-apps">${links.map((l) => html`<li class="dv-app"><a class="dv-open" href="${l.url}" target="_blank" rel="noopener nofollow"><span class="dv-name">${l.name}</span><span class="dv-host">${hostOf(l.url)} ↗</span></a><p class="dv-best muted small">${l.best}</p></li>`)}</ul>
<p class="muted small">Compare the totals each app shows you, delivery and service fees included. For coupon codes on an app's own page, the <a href="https://openvibe.coupons/companion">OpenVibe Companion</a> browser extension shows what OpenVibe.Coupons knows for it.</p>` : ''}
<section aria-labelledby="h-kits"><h2 id="h-kits">Meal kits and prepared meals</h2>
<p class="muted">Boxes of recipes and ingredients, or meals ready to heat. Prices change with the box size and the week, so each links to its own plans page; OpenVibe.Watch can tell you when a price changes.</p>
<ul class="dv-kits">${delivery.KITS.map(kitRow)}</ul>
<p class="muted small">Budget kits usually cost the least per serving; premium ones cost more for organic or special-diet food, and prepared meals cost more again. The first box is often heavily discounted, so compare the price from the second week.</p></section>
<p class="muted small">Cooking from what you have is cheaper still: <a href="/pantry">your cupboard</a>, <a href="/recipes">recipe ideas</a> and <a href="/plan">a meal plan</a> with its shopping list.</p>`,
        });
    });

    r.get('/recipes', (req, res) => recipesPage(req, res, { saved: !!req.query.saved, error: typeof req.query.error === 'string' ? req.query.error : null }));

    r.post('/recipes', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Frecipes');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('A recipe request must be made from openvibe.food itself.');
        const b = req.body || {};
        const ask = str(b.ask, 500);
        const peopleRaw = str(b.people, 4);
        let people = null;
        if (peopleRaw) {
            people = Number(peopleRaw);
            if (!Number.isInteger(people) || people < 1 || people > 12) return res.redirect(303, '/recipes?error=food.recipes.invalid');
        }
        if (!config.aiUrl) return res.redirect(303, '/recipes?error=food.ai_off');
        const owner = ownerOf(req);
        const pantry = await store.getPantry(s, owner);
        if (!pantry.length) return res.redirect(303, '/recipes?error=food.pantry_empty');
        const today = new Date(s.now()).toISOString().slice(0, 10);
        if (await store.countRecipeSuggestionsSince(s, owner, today) >= 10) return res.redirect(303, '/recipes?error=food.recipes_daily_limit');
        let suggestion;
        try {
            suggestion = await suggestRecipes(ctx.ai, { pantry, ask, people, subject: owner.replace(/^user:/, '') });
        } catch (err) {
            if (err && err.name === 'AiRunError') return res.redirect(303, `/recipes?error=${encodeURIComponent(err.code || 'ai.run_failed')}`);
            throw err;
        }
        await store.insertRecipeSuggestion(s, {
            id: s.newId('rcp'), subject_id: owner, created_at: s.iso(),
            ask, people, ai_run_id: suggestion.runId, recipes: suggestion.recipes,
        });
        return res.redirect(303, '/recipes?saved=1');
    });

    // ── The update log ───────────────────────────────────────
    r.get('/updates', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        title: `What shipped on ${SITE_NAME}`,
        description: 'Every change deployed to OpenVibe.Food, newest first, from the OpenVibe network\'s shared update log.',
        body: raw(frame.updatesBody({ service: 'food', siteName: SITE_NAME }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`),
    }));

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt ──
    r.use(createDiscoveryRoutes(ctx));
    // The recipe library (server/food/library.js, http/library-routes.js).
    require('./library-routes').mountLibrary(r, { ctx, page, config, signedIn, express });
    // Food recalls (server/food/recalls.js, http/recall-pages.js).
    require('./recall-pages').mountRecalls(r, { ctx, page, config, signedIn, publicCache: PUBLIC_CACHE });
    return r;
}

module.exports = { createPageRoutes, TAGLINE, SITE_NAME };
