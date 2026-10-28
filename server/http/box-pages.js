'use strict';

/**
 * Food boxes on the site (server/food/boxes.js), built with the OpenVibe Kit (openvibe-shared/kit, Shared 4.20):
 *
 *   GET /boxes[?kind=&diet=&q=]        every box, a tab per kind, diets as chips, a search row; rows that say the
 *                                      stated price, the plan sizes and the shipping at a glance
 *   GET /boxes/:slug[?people=&meals=]  one box: what its own pages said and when, what that comes to for your plan,
 *                                      its codes on OpenVibe.Coupons and its score on OpenVibe.Reviews, Watch, its site
 *   GET /boxes/compare?b=a,b,c         up to four side by side
 *
 * Mounted by pages.js with its page() and helpers. Everything is server-rendered and complete without JavaScript.
 */
const kit = require('openvibe-shared/kit');
const cache = require('openvibe-shared/cache-policy');
const boxes = require('../food/boxes');
const { html, raw } = require('../render/html');

const k = (markup) => raw(String(markup));
const $ = (n) => `$${Number(n).toFixed(2)}`;
const range = (r) => (!r ? null : r.from === r.to ? $(r.from) : `${$(r.from)}–${$(r.to)}`);
const WATCH_NEW = 'https://openvibe.watch/watches/new';
const watchHref = (b) => `${WATCH_NEW}?${new URLSearchParams({ template: 'page', url: b.url, name: `Food: ${b.name} prices`.slice(0, 80) })}`;
const reviewHref = (b) => `https://openvibe.reviews/review?${new URLSearchParams({ kind: 'service', name: b.name })}`;
const couponsHref = (b) => `https://openvibe.coupons/?${new URLSearchParams({ q: b.host })}`;
const span = (list) => (!list.length ? null : list.length === 1 ? String(list[0]) : `${list[0]}–${list[list.length - 1]}`);

/** The facts a row shows: the stated price, the plan size, free shipping; or what the box is when nothing was checked. */
function factsLine(b) {
    const parts = [boxes.priceLine(b.price), b.people.length ? `${span(b.people)} people` : null, b.meals.length ? `${span(b.meals)} meals a week` : null,
        b.shipping && b.shipping.amount === 0 ? 'free shipping' : null].filter(Boolean);
    return parts.length ? parts.join(' · ') : b.what;
}

function mountBoxPages(r, { page, signedIn, PUBLIC_CACHE, boxLinks }) {
    // ── The directory ──
    r.get('/boxes', (req, res) => {
        const kinds = ['all', ...boxes.KINDS.map((x) => x.kind)];
        const tab = kit.tabOf(req.query, kinds, 'kind');
        const diet = boxes.DIETS[req.query.diet] ? String(req.query.diet) : null;
        const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 60) : null;
        const list = boxes.list({ kind: tab === 'all' ? null : tab, diet, q });
        const tabs = kit.tabs({ base: diet ? `/boxes?diet=${diet}` : '/boxes', param: 'kind', active: tab, label: 'Kinds of box',
            items: [{ key: 'all', label: 'All', count: boxes.list({ diet }).length }, ...boxes.KINDS.map((x) => ({ key: x.kind, label: x.name, count: boxes.list({ kind: x.kind, diet }).length }))] });
        const head = kit.head({ title: 'Food boxes', sub: 'Meal kits, ready meals and food boxes, side by side', actions: [kit.iconButton({ href: '/boxes/compare', icon: 'list', label: 'Compare boxes' })], tabs });
        const inKind = boxes.list({ kind: tab === 'all' ? null : tab });
        const diets = Object.keys(boxes.DIETS).filter((d) => inKind.some((b) => b.diets.includes(d)));
        const kindParam = tab === 'all' ? '' : `kind=${tab}`;
        const dietHref = (d) => `/boxes?${[kindParam, d ? `diet=${d}` : ''].filter(Boolean).join('&')}`;
        const chips = diets.length ? html`<nav class="bx-diets" aria-label="Diets"><a href="${dietHref(null)}"${diet ? '' : raw(' aria-current="page"')}>Any diet</a>${diets.map((d) => html`<a href="${dietHref(d)}"${d === diet ? raw(' aria-current="page"') : ''}>${boxes.DIETS[d]}</a>`)}</nav>` : '';
        const row = (b) => kit.row({ href: `/boxes/${b.slug}`, mark: kit.mark({ name: b.name, square: true }), title: b.name,
            badge: tab === 'all' ? kit.badge(boxes.KIND[b.kind].short) : '', sub: factsLine(b) });
        page(req, res, {
            title: tab === 'all' ? 'Food boxes, compared' : `${boxes.KIND[tab].name}, compared`,
            description: 'Every meal kit, ready-meal service and food box (produce, meat and fish, snacks, coffee, baby food, dog food) side by side: prices as their own pages state them, plan sizes, diets, shipping and how to cancel, with codes and reviews.',
            index: !q && !diet, cache: signedIn(req) ? null : PUBLIC_CACHE, crumbs: [], styles: ['kit.css'], localStyles: ['css/boxes.css'],
            body: html`${k(head)}
${k(kit.find({ action: '/boxes', placeholder: 'A box, a diet or a kind: keto, coffee, HelloFresh', hidden: tab === 'all' ? {} : { kind: tab }, value: q || '' }))}
${chips}
${list.length ? k(kit.list(list.map(row))) : k(kit.empty({ icon: 'search', title: 'No box matches', text: 'Try another word, another diet or All.', action: { href: '/boxes', label: 'Every box', kind: 'quiet' } }))}
<p class="muted small bx-how">Every fact is read on the service's own pages by a person, with the page and the day beside it; prices change, so each box links to its site, and OpenVibe.Watch can tell you when they change. Codes come from <a href="https://openvibe.coupons/">OpenVibe.Coupons</a> and scores from <a href="https://openvibe.reviews/">OpenVibe.Reviews</a>. The same list is <a href="/api/v1/boxes">an API</a>.</p>`,
        });
    });

    // ── Side by side ──
    r.get('/boxes/compare', (req, res) => {
        const picked = String(req.query.b || '').split(',').map((s) => boxes.get(s.trim())).filter(Boolean).slice(0, 4);
        const head = kit.head({ title: 'Compare food boxes', sub: picked.length ? picked.map((b) => b.name).join(' · ') : 'Pick up to four', back: { href: '/boxes', label: 'All boxes' } });
        const options = boxes.KINDS.map((kd) => html`<optgroup label="${kd.name}">${boxes.list({ kind: kd.kind }).map((b) => html`<option value="${b.slug}">${b.name}</option>`)}</optgroup>`);
        const add = html`<form class="bx-pick" method="get" action="/boxes/compare"><label class="ovk-sr" for="bx-add">Add a box</label>
<input type="hidden" name="keep" value="${picked.map((b) => b.slug).join(',')}"><select id="bx-add" name="add">${options}</select><button type="submit" class="ovk-btn ovk-btn--quiet ovk-btn--small">Add</button></form>`;
        if (req.query.add) {
            const next = [...String(req.query.keep || '').split(',').filter(Boolean), String(req.query.add)].map((s) => boxes.get(s)).filter(Boolean).map((b) => b.slug);
            return res.redirect(303, `/boxes/compare?b=${[...new Set(next)].slice(-4).join(',')}`);
        }
        const rows = [
            ['Kind', (b) => boxes.KIND[b.kind].name],
            ['Price, as stated', (b) => (b.price ? b.price.text : 'Not checked yet')],
            ['Shipping', (b) => (b.shipping ? b.shipping.text : 'Not checked yet')],
            ['People', (b) => span(b.people) || '—'],
            ['Meals a week', (b) => span(b.meals) || '—'],
            ['How often', (b) => b.cadence.join(', ') || '—'],
            ['Diets', (b) => b.diets.map((d) => boxes.DIETS[d]).join(', ') || '—'],
            ['Delivers to', (b) => b.ships_to || 'Not checked yet'],
            ['Skip and cancel', (b) => b.cancel || 'Not checked yet'],
        ];
        page(req, res, {
            title: picked.length ? `${picked.map((b) => b.name).join(' vs ')}` : 'Compare food boxes',
            description: 'Food boxes side by side: prices as their own pages state them, plan sizes, diets, shipping and how to cancel.',
            index: false, cache: signedIn(req) ? null : PUBLIC_CACHE, crumbs: [], styles: ['kit.css'], localStyles: ['css/boxes.css'],
            body: html`${k(head)}
${add}
${picked.length ? html`<div class="bx-compare" role="region" aria-label="The boxes side by side" tabindex="0"><table><thead><tr><th scope="col"><span class="ovk-sr">Fact</span></th>${picked.map((b) => html`<th scope="col"><a href="/boxes/${b.slug}">${b.name}</a> <a class="bx-x" href="/boxes/compare?b=${picked.filter((x) => x !== b).map((x) => x.slug).join(',')}" aria-label="Take ${b.name} out">×</a></th>`)}</tr></thead>
<tbody>${rows.map(([label, f]) => html`<tr><th scope="row">${label}</th>${picked.map((b) => html`<td>${f(b)}</td>`)}</tr>`)}</tbody></table></div>
<p class="muted small">As each service's own pages said on the day shown on its page. Prices change: open a box for its site and to watch it.</p>` : k(kit.empty({ icon: 'list', title: 'Nothing to compare yet', text: 'Add a box above, or start from the list.', action: { href: '/boxes', label: 'All boxes', kind: 'quiet' } }))}`,
        });
    });

    // ── One box ──
    r.get('/boxes/:slug', async (req, res, next) => {
        const b = boxes.get(req.params.slug);
        if (!b) return next();
        const kind = boxes.KIND[b.kind];
        const people = b.people.length ? (b.people.includes(Number(req.query.people)) ? Number(req.query.people) : b.people[0]) : Math.min(12, Math.max(1, Number(req.query.people) || 2));
        const meals = b.meals.length ? (b.meals.includes(Number(req.query.meals)) ? Number(req.query.meals) : b.meals[0]) : Math.min(21, Math.max(1, Number(req.query.meals) || 3));
        const c = boxes.cost(b, { people, meals });
        const links = boxLinks ? await boxLinks.forBox(b) : { coupons: null, reviews: null };
        const head = kit.head({ title: b.name, subHtml: String(html`${kind.name} · <a href="${b.url}" rel="noopener nofollow">${b.host}</a>`), back: { href: `/boxes?kind=${b.kind}`, label: kind.name },
            actions: [kit.iconButton({ href: watchHref(b), icon: 'bell', label: `Watch ${b.name}'s prices on OpenVibe.Watch` }), kit.iconButton({ href: b.url, icon: 'open', label: `${b.name}'s site`, attrs: { rel: 'noopener nofollow' } })] });
        const fact = (label, value) => html`<div class="ovk-set-row bx-fact"><span class="ovk-set-text">${label}</span><span class="bx-val">${value || html`<span class="muted">Not checked yet</span>`}</span></div>`;
        const opt = (list, cur) => list.map((n) => html`<option value="${n}"${n === cur ? raw(' selected') : ''}>${n}</option>`);
        const sizes = (b.people.length ? b.people : [1, 2, 3, 4, 5, 6]);
        const weekly = (b.meals.length ? b.meals : [2, 3, 4, 5, 6, 7]);
        const calc = b.price && ['serving', 'meal'].includes(b.price.unit) ? html`<section class="ovk-section" aria-labelledby="bx-calc-h"><h2 id="bx-calc-h">What it comes to</h2>
<form class="bx-calc" method="get" action="/boxes/${b.slug}"><label>${b.kind === 'ready' ? 'Meals a week' : 'People'} <select name="${b.kind === 'ready' ? 'meals' : 'people'}">${b.kind === 'ready' ? opt(weekly, meals) : opt(sizes, people)}</select></label>
${b.kind === 'ready' ? '' : html`<label>Meals a week <select name="meals">${opt(weekly, meals)}</select></label>`}<button type="submit" class="ovk-btn ovk-btn--quiet ovk-btn--small">Work it out</button></form>
${c ? html`<p class="bx-cost"><strong>${range(c.total) || range(c.food)}</strong> a week${c.total ? ` (${range(c.food)} of food + ${range(c.shipping)} shipping)` : ''}, for ${c.servings} ${b.price.unit === 'meal' ? 'meals' : 'servings'}.</p>
<p class="ovk-note">From ${c.basis}. The first box is often cheaper and later ones cost more: check theirs.</p>` : html`<p class="ovk-note">That plan size is not one ${b.name} states; pick one of theirs.</p>`}</section>` : '';
        const codes = links.coupons
            ? html`<a class="ovk-set-row bx-link" href="${links.coupons.url}"><span class="ovk-set-text">Codes on OpenVibe.Coupons<small>${links.coupons.best ? html`Best now: ${links.coupons.best.code} · ${links.coupons.best.title}` : `${links.coupons.active} active`}</small></span>${k(kit.icon('chevron'))}</a>`
            : html`<a class="ovk-set-row bx-link" href="${couponsHref(b)}"><span class="ovk-set-text">Codes on OpenVibe.Coupons<small>None listed for ${b.host} yet; submit one you have</small></span>${k(kit.icon('chevron'))}</a>`;
        const score = links.reviews
            ? html`<a class="ovk-set-row bx-link" href="${links.reviews.url}"><span class="ovk-set-text">Reviews on OpenVibe.Reviews<small>${links.reviews.line || 'Read what people say'}</small></span>${k(kit.icon('chevron'))}</a>`
            : html`<a class="ovk-set-row bx-link" href="${reviewHref(b)}"><span class="ovk-set-text">Reviews on OpenVibe.Reviews<small>No reviews yet: write the first</small></span>${k(kit.icon('chevron'))}</a>`;
        const others = boxes.list({ kind: b.kind }).filter((x) => x !== b).slice(0, 4);
        page(req, res, {
            title: `${b.name}: ${kind.name.toLowerCase()} compared`,
            description: `${b.name}: ${b.what} ${b.price ? `${b.price.text}. ` : ''}Plan sizes, shipping, diets and how to cancel, from its own pages, with codes and reviews.`.slice(0, 300),
            index: !req.query.people && !req.query.meals, cache: signedIn(req) ? null : cache.htmlHeaders({ maxAge: 300 }), crumbs: [], styles: ['kit.css'], localStyles: ['css/boxes.css'],
            body: html`${k(head)}
<p class="bx-what">${b.what}</p>
${b.price ? html`<p class="bx-price"><strong>${boxes.priceLine(b.price)}</strong>${b.shipping && b.shipping.amount === 0 ? ' · free shipping' : ''}</p>` : ''}
<section class="ovk-section" aria-labelledby="bx-facts-h"><h2 id="bx-facts-h">The plans</h2>
${fact('Price', b.price ? b.price.text : null)}
${fact('Shipping', b.shipping ? b.shipping.text : null)}
${fact('People', span(b.people))}
${fact('Meals a week', span(b.meals))}
${fact('How often', b.cadence.join(', '))}
${fact('Diets', b.diets.length ? b.diets.map((d) => boxes.DIETS[d]).join(', ') : null)}
${fact('Delivers to', b.ships_to)}
${fact('Skip and cancel', b.cancel)}
${b.notes.length ? html`<ul class="ovk-note bx-notes">${b.notes.map((n) => html`<li>${n}</li>`)}</ul>` : ''}
<p class="ovk-note">${b.sources.length ? html`From ${b.name}'s own pages, read ${b.checked}: ${b.sources.map((s, i) => html`${i ? ', ' : ''}<a href="${s}" rel="noopener nofollow">${s.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}</a>`)}.` : html`Nothing checked yet beyond what it is; its plans are on <a href="${b.url}" rel="noopener nofollow">its site</a>.`}</p></section>
${calc}
<section class="ovk-section" aria-labelledby="bx-more-h"><h2 id="bx-more-h">Across OpenVibe</h2>${codes}${score}
<a class="ovk-set-row bx-link" href="${watchHref(b)}"><span class="ovk-set-text">Watch its prices<small>OpenVibe.Watch tells you when ${b.host}'s page changes</small></span>${k(kit.icon('chevron'))}</a>
<a class="ovk-set-row bx-link" href="/boxes/compare?b=${[b, ...others.slice(0, 1)].map((x) => x.slug).join(',')}"><span class="ovk-set-text">Compare it<small>Side by side with ${others[0] ? others[0].name : 'others'}</small></span>${k(kit.icon('chevron'))}</a></section>
${others.length ? k(kit.list(others.map((x) => kit.row({ href: `/boxes/${x.slug}`, mark: kit.mark({ name: x.name, square: true }), title: x.name, sub: factsLine(x) })), { title: `More ${kind.name.toLowerCase()}`, more: { href: `/boxes?kind=${b.kind}`, label: 'All' } })) : ''}`,
        });
    });
}

module.exports = { mountBoxPages, factsLine };
