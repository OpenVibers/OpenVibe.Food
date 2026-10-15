'use strict';
/**
 * The recipe library's pages (server/food/library.js):
 *
 *   GET  /recipes/library                 every recipe, newest first (24 a page)
 *   GET  /recipes/library/:slug           one recipe: ingredients from the food list, steps, what to buy and its cost
 *   POST /recipes/library/:slug/review    staff: a person checked it (indexed, with Recipe JSON-LD) or takes it back
 *   POST /recipes/library/:slug/hide|show staff
 *
 * Every page says the recipe was written by OpenVibe.AI; an unreviewed one is noindex.
 */
const showcase = require('openvibe-shared/showcase');
const { html, notice, time } = require('../render/html');
const { sameOrigin } = require('./principal');
const { COST_NOTE } = require('../food/recipes');

const PER_PAGE = 24;
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const AI_LINE = 'Written by OpenVibe.AI from OpenVibe.Food\'s food list. Check a recipe before you cook it: cook meat, poultry and eggs through, and mind allergies.';

function mountLibrary(r, { ctx, page, config, signedIn, express }) {
    const lib = ctx.library;
    const isStaff = (req) => Boolean(signedIn(req) && req.viewer.role === 'admin');
    const meta = (x) => [x.serves ? `Serves ${x.serves}` : null, x.minutes ? `About ${x.minutes} min` : null, x.cost != null ? `${money(x.cost)} to buy${x.cost_partial ? '+' : ''}` : null].filter(Boolean).join(' · ');

    r.get('/recipes/library', async (req, res) => {
        const n = parseInt(req.query.page, 10);
        const pageNo = Number.isInteger(n) && n > 0 ? Math.min(n, 500) : 1;
        const staff = isStaff(req);
        const { total, recipes } = await lib.list({ limit: PER_PAGE, offset: (pageNo - 1) * PER_PAGE, staff });
        const pages = Math.max(1, Math.ceil(total / PER_PAGE));
        page(req, res, {
            title: 'Recipe library', index: false, localStyles: ['css/recipes.css'], styles: [showcase.STYLESHEET],
            description: 'Budget recipes written by AI from OpenVibe.Food\'s food list, each with what to buy and its typical cost.',
            crumbs: [{ label: 'Recipe ideas', href: '/recipes' }, { label: 'Library' }],
            body: html`<h1>Recipe library</h1>
<p class="lede">Cheap, simple recipes that use only foods from <a href="/foods">the food list</a>, so OpenVibe.Food can tell you what to buy and what it typically costs. A new batch is added every few hours.</p>
<p class="notice">${AI_LINE}</p>
${recipes.length ? html`<ol class="lib-grid">${recipes.map((x) => html`<li class="recipe lib-card"><h2><a href="/recipes/library/${x.slug}">${x.title}</a></h2>
<p class="recipe-meta">${meta(x)}${x.reviewed ? ' · checked by a person' : ''}${x.status === 'hidden' ? ' · hidden' : ''}</p>
<p class="muted small">${x.ingredients.slice(0, 6).map((i) => i.name).join(', ')}${x.ingredients.length > 6 ? '…' : ''}</p></li>`)}</ol>`
        : html`<p class="muted">The first recipes are being written. Meanwhile, <a href="/recipes">get ideas from your own cupboard</a>.</p>`}
${pages > 1 ? html`<nav class="pager" aria-label="Pages">${pageNo > 1 ? html`<a href="/recipes/library${pageNo > 2 ? `?page=${pageNo - 1}` : ''}">← Newer</a>` : ''} <span>Page ${pageNo} of ${pages}</span> ${pageNo < pages ? html`<a href="/recipes/library?page=${pageNo + 1}">Older →</a>` : ''}</nav>` : ''}`,
        });
    });

    r.get('/recipes/library/:slug', async (req, res) => {
        const x = await lib.bySlug(req.params.slug);
        const staff = isStaff(req);
        if (!x || (x.status === 'hidden' && !staff)) {
            return page(req, res, { title: 'No such recipe', crumbs: [{ label: 'Recipe library', href: '/recipes/library' }, { label: 'Not found' }],
                body: html`<h1>No such recipe</h1><p><a href="/recipes/library">See the library</a>.</p>` }, 404);
        }
        const url = `${config.baseUrl}/recipes/library/${x.slug}`;
        const jsonLd = x.reviewed && x.status === 'published' ? [{
            '@context': 'https://schema.org', '@type': 'Recipe', name: x.title, url,
            recipeIngredient: x.ingredients.map((i) => [i.amount, i.name].filter(Boolean).join(' ')),
            recipeInstructions: x.steps.map((t) => ({ '@type': 'HowToStep', text: t })),
            ...(x.serves ? { recipeYield: `${x.serves} servings` } : {}), ...(x.minutes ? { totalTime: `PT${x.minutes}M` } : {}),
            author: { '@type': 'Organization', name: 'OpenVibe.Food' }, datePublished: x.created_at,
        }] : [];
        page(req, res, {
            title: x.title, index: Boolean(x.reviewed && x.status === 'published'), localStyles: ['css/recipes.css'], jsonLd,
            description: `${x.title}: ${meta(x)}. A budget recipe from OpenVibe.Food's food list, written by AI.`,
            crumbs: [{ label: 'Recipe library', href: '/recipes/library' }, { label: x.title }],
            body: html`<article class="recipe lib-recipe">
<header class="recipe-head"><h1>${x.title}</h1><p class="recipe-meta">${meta(x)}</p></header>
<p class="notice">${AI_LINE}${x.reviewed ? ' A person at OpenVibe has checked this one.' : ''}</p>
<div class="recipe-body">
<section class="recipe-ingredients" aria-label="Ingredients"><h2 class="h4">Ingredients</h2>
<ul>${x.ingredients.map((i) => html`<li><span>${i.food ? html`<a href="/foods/${i.food}">${i.name}</a>` : i.name}${i.amount ? html` <span class="muted">${i.amount}</span>` : ''}</span></li>`)}</ul></section>
<section class="recipe-steps" aria-label="Steps"><h2 class="h4">Steps</h2><ol>${x.steps.map((t) => html`<li>${t}</li>`)}</ol></section>
</div>
${x.to_buy.length ? html`<div class="recipe-buy"><h2 class="h4">What to buy</h2>
<ul>${x.to_buy.map((b) => html`<li><span><a href="/foods/${b.slug}">${b.name}</a></span><span>${b.price == null ? 'no typical price' : money(b.price)}</span></li>`)}</ul>
<p class="recipe-total"><span>Typical total${x.cost_partial ? ' (items with a price)' : ''}</span><strong>${money(x.cost)}</strong></p>
<p class="muted small">Whole packs: most leave plenty over. ${COST_NOTE}</p></div>` : ''}
${x.notes ? html`<p class="recipe-notes small">${x.notes}</p>` : ''}
<p class="muted small">Asked for: ${x.theme} · ${time(x.created_at)} · <a href="/recipes/library">More recipes</a> · <a href="/plan">Plan a week</a></p>
${staff ? html`<form method="post" action="/recipes/library/${x.slug}/review" class="ov-form"><input type="hidden" name="yes" value="${x.reviewed ? '0' : '1'}"><button class="sc-btn" type="submit">${x.reviewed ? 'Take back the review' : 'I checked this recipe'}</button></form>
<form method="post" action="/recipes/library/${x.slug}/${x.status === 'hidden' ? 'show' : 'hide'}" class="ov-form"><button class="sc-btn" type="submit">${x.status === 'hidden' ? 'Show it again' : 'Hide this recipe'}</button></form>` : ''}
</article>`,
        });
    });

    const form = express.urlencoded({ extended: false, limit: '4kb' });
    async function staffAction(req, res, fn) {
        if (!isStaff(req)) return res.status(403).type('text/plain').send('Staff only.');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Send this from openvibe.food itself.');
        const x = await lib.bySlug(req.params.slug);
        if (!x) return res.status(404).type('text/plain').send('Not found.');
        await fn(x);
        res.redirect(303, `/recipes/library/${x.slug}`);
    }
    r.post('/recipes/library/:slug/review', form, (req, res) => staffAction(req, res, (x) => lib.review(x, req.viewer.subject, req.body.yes !== '0')));
    r.post('/recipes/library/:slug/hide', form, (req, res) => staffAction(req, res, (x) => lib.setHidden(x, true, req.body.reason)));
    r.post('/recipes/library/:slug/show', form, (req, res) => staffAction(req, res, (x) => lib.setHidden(x, false)));
    return { notice };
}

module.exports = { mountLibrary };
