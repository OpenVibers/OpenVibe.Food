'use strict';
/**
 * Food recalls (server/food/recalls.js), from the FDA's food enforcement reports through OpenVibe.Sources:
 *
 *   GET /recalls            every recall, newest report first (30 a page), by words, class and state
 *   GET /recalls/:number    one recall (F-0123-2027): the product, why, who, where it was sold, its status
 *
 * Every page carries openFDA's note (unvalidated, not for medical decisions, no endorsement). The list is indexed;
 * a single recall is noindex, as the source's registry entry asks (Sources' default_indexability).
 */
const showcase = require('openvibe-shared/showcase');
const { html, raw, notice, badge } = require('../render/html');
const { CLASSES, CLASS_TEXT, NOTE, FDA_REPORTS } = require('../food/recalls');

const PER_PAGE = 30;
const CLASS_BADGE = { 'Class I': 'bad', 'Class II': 'warn', 'Class III': '' };
const str = (v, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const short = (s, max) => (s && s.length > max ? `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : s || '');
/** 2026-10-14 → 14 Oct 2026 (the reports give days, not times). */
const date = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');

const classBadge = (c) => (c ? badge(c, CLASS_BADGE[c] || '') : '');
const noteBlock = () => html`<p class="muted small recall-note">${NOTE} <a href="${FDA_REPORTS}" rel="noopener">The FDA's enforcement reports</a> are the record.</p>`;

/** One recall as a list item (the list page and the home page). */
function recallCard(x, { reason = true } = {}) {
    return html`<li class="recall"><p class="recall-head">${classBadge(x.classification)} ${x.status ? badge(x.status) : ''} <span class="muted small">Reported ${date(x.reported_on)}</span></p>
<h2 class="recall-product"><a href="/recalls/${x.recall_number}">${short(x.product, 180)}</a></h2>
<p class="small">${x.firm ? html`<b>${x.firm}</b>` : ''}${x.state ? html` · ${x.state}` : ''}${x.distribution ? html` · sold in ${short(x.distribution, 120)}` : ''}</p>
${reason && x.reason ? html`<p class="small muted">${short(x.reason, 220)}</p>` : ''}</li>`;
}

function mountRecalls(r, { ctx, page, config, signedIn, publicCache }) {
    const recalls = ctx.recalls;

    r.get('/recalls', async (req, res) => {
        const q = str(req.query.q);
        const classification = CLASSES.includes(req.query.class) ? req.query.class : null;
        const state = typeof req.query.state === 'string' && /^[A-Z]{2}$/.test(req.query.state) ? req.query.state : null;
        const n = parseInt(req.query.page, 10);
        const pageNo = Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 1;
        const filters = { q, classification, state };
        const [total, all, rows, states] = await Promise.all([
            recalls.count(filters), recalls.count(), recalls.list({ ...filters, limit: PER_PAGE, offset: (pageNo - 1) * PER_PAGE }), recalls.states(),
        ]);
        const pages = Math.max(1, Math.ceil(total / PER_PAGE));
        const filtered = Boolean(q || classification || state);
        const qs = (p) => { const u = new URLSearchParams(); if (q) u.set('q', q); if (classification) u.set('class', classification); if (state) u.set('state', state); if (p > 1) u.set('page', String(p)); const s = u.toString(); return s ? `/recalls?${s}` : '/recalls'; };
        page(req, res, {
            title: filtered ? 'Food recalls, filtered' : 'Food recalls from the FDA',
            description: 'The FDA\'s food recall reports, newest first: what was recalled, by whom, why, where it was sold and how serious it is.',
            index: !filtered && pageNo === 1, cache: signedIn(req) ? null : publicCache,
            crumbs: [{ label: 'Food recalls' }], styles: [showcase.STYLESHEET], localStyles: ['css/recalls.css'],
            body: html`<h1>Food recalls</h1>
<p class="lede">The FDA's food recall reports, newest first: what was recalled, by whom, why, and where it was sold. ${all ? html`${all} recalls so far.` : ''}</p>
<form class="ov-form filter-form" method="get" action="/recalls" role="search">
<label for="rq">Product or company</label>
<input id="rq" name="q" type="search" value="${q || ''}" maxlength="80" placeholder="cheese, peanut butter, a brand…">
<label for="rclass">How serious</label>
<select id="rclass" name="class"><option value="">Every class</option>${CLASSES.map((c) => html`<option value="${c}"${c === classification ? raw(' selected') : ''}>${c}</option>`)}</select>
<label for="rstate">Company's state</label>
<select id="rstate" name="state"><option value="">Every state</option>${states.map((s) => html`<option value="${s.state}"${s.state === state ? raw(' selected') : ''}>${s.state} (${s.n})</option>`)}</select>
<button class="sc-btn" type="submit">Filter</button>
</form>
<details class="recall-classes"><summary>What Class I, II and III mean</summary><ul>${CLASSES.map((c) => html`<li>${classBadge(c)} ${CLASS_TEXT[c]}.</li>`)}</ul></details>
${rows.length ? html`<p class="muted small">${total} ${total === 1 ? 'recall' : 'recalls'}${filtered ? ' match' : ''}.${filtered ? html` <a href="/recalls">Show all</a>` : ''}</p>
<ol class="recalls">${rows.map((x) => recallCard(x))}</ol>`
        : all ? notice(html`Nothing matched. <a href="/recalls">Show every recall</a>.`, 'warn')
            : html`<p class="muted">The recall reports appear here once OpenVibe.Sources has read them. Meanwhile, <a href="${FDA_REPORTS}" rel="noopener">search the FDA's own reports</a>.</p>`}
${pages > 1 ? html`<nav class="pager" aria-label="Pages">${pageNo > 1 ? html`<a href="${qs(pageNo - 1)}">← Newer</a>` : ''} <span>Page ${pageNo} of ${pages}</span> ${pageNo < pages ? html`<a href="${qs(pageNo + 1)}">Older →</a>` : ''}</nav>` : ''}
${noteBlock()}`,
        });
    });

    r.get('/recalls/:number', async (req, res) => {
        const x = await recalls.get(req.params.number);
        if (!x) {
            return page(req, res, { title: 'No such recall', crumbs: [{ label: 'Food recalls', href: '/recalls' }, { label: 'Not found' }],
                body: html`<h1>No such recall</h1><p>No recall here is numbered “${String(req.params.number).slice(0, 40)}”. <a href="/recalls">See every recall</a>.</p>` }, 404);
        }
        const facts = [
            ['Recall number', x.recall_number],
            ['How serious', x.classification ? html`${classBadge(x.classification)} ${x.class_text ? html`<span class="small">${x.class_text}</span>` : ''}` : '—'],
            ['Status', x.status || '—'],
            ['Company', x.firm ? html`${x.firm}${x.state ? ` (${x.state})` : ''}` : '—'],
            ['Where it was sold', x.distribution || '—'],
            ['Who started it', x.voluntary || '—'],
            ['Recall started', date(x.initiated_on)],
            ['Reported', date(x.reported_on)],
        ];
        page(req, res, {
            title: `Recall: ${short(x.product, 70)}`, index: false, cache: signedIn(req) ? null : publicCache,
            description: short(`${x.firm ? `${x.firm}: ` : ''}${x.reason || x.product}`, 160),
            crumbs: [{ label: 'Food recalls', href: '/recalls' }, { label: x.recall_number }],
            styles: [showcase.STYLESHEET], localStyles: ['css/recalls.css'],
            body: html`<h1 class="recall-title">${short(x.product, 200)}</h1>
<p class="recall-head">${classBadge(x.classification)} ${x.status ? badge(x.status) : ''}</p>
${x.product.length > 200 ? html`<p>${x.product}</p>` : ''}
${x.reason ? html`<h2>Why it was recalled</h2><p>${x.reason}</p>` : ''}
<h2>The details</h2>
<dl class="recall-facts">${facts.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
<p class="small">Compare the codes, sizes and dates in the description with the package you have.</p>
<p><a href="/recalls">Every food recall</a> · <a href="${FDA_REPORTS}" rel="noopener">Search the FDA's reports for ${x.recall_number}</a></p>
${noteBlock()}`,
        });
    });
}

module.exports = { mountRecalls, recallCard, date };
