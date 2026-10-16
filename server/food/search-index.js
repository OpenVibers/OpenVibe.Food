'use strict';
/**
 * The recipe library in OpenVibe.Search: every recipe a member of staff checked (published and reviewed, the ones whose
 * page is indexed) is one document (search.index-document@1, owner food, type recipe, id = the slug,
 * /recipes/library/<slug>), written through Search's owner API with Food's service token (search.document.write on
 * openvibe.search). A recipe that is hidden or whose check is taken back is tombstoned.
 *
 * Runs a minute after boot, every six hours, and 30 seconds after a review or a hide (kick()). There are few checked
 * recipes, so the stored copy is read back from Search for each one and a document is re-sent, one revision up, only
 * when its content differs.
 *
 * Off unless FOOD_SEARCH_URL and the OAuth client secret are set.
 */
const { serviceAuth } = require('openvibe-contracts');

const OWNER = 'food';
const TYPE = 'recipe';
const EVERY_MS = 6 * 60 * 60 * 1000;
const KICK_MS = 30 * 1000;
const COMPARED = ['canonical_url', 'title', 'summary', 'body'];

const money = (n) => (n == null ? null : `$${Number(n).toFixed(2)}`);

/** A recipe (the library's shape) → the document body; identity and revision are added by the caller. */
function documentFor(x, { baseUrl }) {
    const facts = [x.serves ? `Serves ${x.serves}` : null, x.minutes ? `about ${x.minutes} minutes` : null,
        x.cost != null ? `${money(x.cost)} to buy${x.cost_partial ? ' (some prices unknown)' : ''}` : null].filter(Boolean).join(', ');
    const ingredients = (x.ingredients || []).map((i) => [i.amount, i.name].filter(Boolean).join(' ')).filter(Boolean);
    return {
        visibility: 'public',
        canonical_url: `${baseUrl}/recipes/library/${x.slug}`,
        title: String(x.title).slice(0, 500),
        summary: `A budget recipe from OpenVibe.Food${facts ? `: ${facts}` : ''}.`.slice(0, 4000),
        body: [x.title, facts, ingredients.length ? `Ingredients: ${ingredients.join('; ')}` : '', ...(x.steps || [])].filter(Boolean).join('\n').slice(0, 48000),
        facets: { kind: 'recipe', ...(x.cost != null ? { cost: Number(x.cost) } : {}), ...(x.serves ? { serves: x.serves } : {}) },
        authorship: 'ai_generated',
        publication_state: 'published',
        published_at: x.created_at || null,
        updated_at: x.reviewed_at || x.created_at || null,
        indexability: { decision: 'index', reasons: [] },
    };
}

function createRecipeSearchIndex({ config, library, fetchImpl = globalThis.fetch, log = console, tokens = null }) {
    const url = String((config.search && config.search.url) || '').replace(/\/+$/, '');
    const enabled = Boolean(url && (tokens || config.oauth.clientSecret));
    const auth = tokens || (enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.search', scope: 'search.document.write', fetchImpl,
    }) : null);
    const baseUrl = String(config.baseUrl).replace(/\/+$/, '');
    const stats = { runs: 0, upserted: 0, deleted: 0, unchanged: 0, failed: 0, last_error: null };

    async function call(method, p, body) {
        const res = await fetchImpl(`${url}${p}`, {
            method,
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await auth.authHeaders()) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
        });
        const json = await res.json().catch(() => ({}));
        if (res.status === 401 && auth.invalidate) auth.invalidate();
        return { status: res.status, ok: res.ok, body: json };
    }

    async function remoteDocs() {
        const out = new Map();
        let after = 0;
        for (let i = 0; i < 50; i++) {
            const r = await call('GET', `/api/v1/owners/${OWNER}/documents?type=${TYPE}&limit=1000&after=${after}`);
            if (!r.ok) throw new Error(`listing: ${r.status} ${r.body.code || ''}`);
            for (const d of r.body.documents || []) out.set(d.id, d);
            if (!r.body.next_after) break;
            after = r.body.next_after;
        }
        return out;
    }

    async function run() {
        if (!enabled) return null;
        stats.runs++;
        const checked = await library.reviewed();
        const remote = await remoteDocs();
        const keep = new Set();
        for (const x of checked) {
            keep.add(x.slug);
            const doc = documentFor(x, { baseUrl });
            const r = remote.get(x.slug);
            if (r && !r.deleted) {
                const stored = await call('GET', `/api/v1/owners/${OWNER}/documents/${TYPE}/${encodeURIComponent(x.slug)}`);
                const s = stored.ok ? (stored.body.document || stored.body) : null;
                if (s && COMPARED.every((k) => s[k] === doc[k])) { stats.unchanged++; continue; }
            }
            const revision = r ? Number(r.revision) + 1 : 1;
            const res = await call('PUT', `/api/v1/documents/${OWNER}/${TYPE}/${encodeURIComponent(x.slug)}`, { ...doc, revision });
            if (res.ok) stats.upserted++;
            else { stats.failed++; stats.last_error = `${x.slug}: ${res.status} ${res.body.code || ''}`; }
        }
        for (const [id, r] of remote) {
            if (keep.has(id) || r.deleted) continue;
            const res = await call('DELETE', `/api/v1/documents/${OWNER}/${TYPE}/${encodeURIComponent(id)}?revision=${Number(r.revision) + 1}`);
            if (res.ok) stats.deleted++;
            else { stats.failed++; stats.last_error = `${id}: ${res.status} ${res.body.code || ''}`; }
        }
        return { ...stats };
    }

    const quietly = () => run().catch((err) => { stats.failed++; stats.last_error = err.message; log.warn('[OpenVibe.Food] search index run failed:', err.message); });
    let timer = null;
    let first = null;
    let kicked = null;
    return {
        enabled,
        run,
        stats: () => ({ ...stats }),
        kick() {
            if (!enabled || kicked) return;
            kicked = setTimeout(() => { kicked = null; quietly(); }, KICK_MS);
            if (kicked.unref) kicked.unref();
        },
        start({ firstDelayMs = 60_000 } = {}) {
            if (!enabled || timer) return;
            first = setTimeout(quietly, firstDelayMs);
            if (first.unref) first.unref();
            timer = setInterval(quietly, EVERY_MS);
            if (timer.unref) timer.unref();
        },
        stop() { clearTimeout(first); clearInterval(timer); clearTimeout(kicked); timer = null; first = null; kicked = null; },
    };
}

module.exports = { createRecipeSearchIndex, documentFor };
