'use strict';

/**
 * Sharing on OpenVibe.Food (design 2026-11-06, visibility step 3), through openvibe-sdk/share.
 *
 * A saved plan is Only me until its owner says otherwise: the meal plan and its shopping list are one thing, so one
 * audience covers both. Specific people is the household case — add the person you shop with with Can edit, and the
 * shopping list ticks for both of you. The Share sheet changes one plan; the person's default for new plans lives on
 * /plan/saved ("New plans: Only me").
 *
 * Recipes are not in this: the library's recipes are OpenVibe's own, written by AI from the food list, and everyone
 * can read them already; a person's recipe ideas are a private answer from the AI, not an address somebody can be
 * given. Its page keeps the sheet's send part only.
 *
 * The old "Plan together" link stays: its secret still lets a signed-in person join a household and edit the list.
 * A plan with a link on is at least Anyone with the link; setting the audience to Specific people or Only me turns
 * the join link off, so an old link can never outlive the audience its owner chose.
 */
const { createShares } = require('openvibe-sdk/share');
const { serviceAuth } = require('openvibe-contracts');

const SERVICE = 'food';
const KIND = 'plan';
const AUDIENCES = ['public', 'link', 'people', 'private'];
const DEFAULT_AUDIENCE = 'private';

const refOf = (id) => ({ service: SERVICE, kind: KIND, id: String(id) });

/** Food names a person 'user:usr_…' in its rows; a page viewer is { subject }. Both become the SDK's subject. */
function subjectOf(viewer) {
    if (!viewer) return null;
    if (typeof viewer === 'string') {
        const id = viewer.startsWith('user:') ? viewer.slice(5) : viewer;
        return /^usr_/.test(id) ? { type: 'user', id } : null;
    }
    if (viewer.subject && /^usr_/.test(String(viewer.subject))) return { type: 'user', id: String(viewer.subject) };
    return null;
}

function shareViewer(viewer) {
    const subject = subjectOf(viewer);
    if (!subject) return null;
    return { subject, staff: !!(viewer && viewer.staff) };
}

function createSharing({ db, config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = String(config.networkInternalUrl || '').replace(/\/+$/, '');
    const tokens = config.oauth && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: base + '/oauth/token',
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'identity.subject.resolve network.notifications.push',
        fetch: fetchImpl,
    }) : null;

    async function networkJson({ path, method = 'GET', json, query } = {}) {
        if (!tokens) throw new Error('Network is not configured for this service');
        const url = new URL(base + path);
        for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
        const headers = { Accept: 'application/json', ...(await tokens.authHeaders()) };
        if (json !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error('Network ' + method + ' ' + path + ' ' + res.status + ': ' + ((body && (body.detail || body.error)) || 'failed'));
            err.status = res.status;
            throw err;
        }
        return body;
    }

    /** One notification. It never carries the plan's name, its meals or its shopping list. */
    async function notify(n) {
        const to = n && n.to;
        if (!to || to.type !== 'user') return;
        const words = {
            'share.added': ['A meal plan was shared with you', 'Open it on OpenVibe.Food.'],
            'share.access_requested': ['Someone asked for access to your meal plan', 'Review the request on OpenVibe.Food.'],
            'share.transfer.requested': ['Someone wants to give you a meal plan', 'Accept or decline it on OpenVibe.Food.'],
            'share.transfer.answered': ['A meal plan transfer was answered', 'See what happened on OpenVibe.Food.'],
        }[n.kind] || ['Sharing on OpenVibe.Food', 'There is something new for you.'];
        try {
            await networkJson({
                path: '/internal/notifications/push', method: 'POST',
                json: {
                    subject: to.id, type: 'GENERIC', title: words[0], message: words[1],
                    service: 'food', url: n.ref && n.ref.id ? `${config.baseUrl}/plan/p/${encodeURIComponent(n.ref.id)}` : `${config.baseUrl}/plan`,
                    category: 'social',
                },
            });
        } catch (err) {
            log.warn('[Sharing] notification not sent:', err.message);
        }
    }

    async function publish(envelope) {
        if (!config.events || !config.events.url) { log.warn('[Sharing] no events URL configured; share envelope not sent'); return; }
        const res = await fetchImpl(String(config.events.url).replace(/\/+$/, ''), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(envelope),
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error('Events answered ' + res.status);
    }

    /**
     * Any audience change ends the household join link: the invite was issued under the audience it had, and an old
     * /plan/join/<secret> must never outlive the choice its owner made. Making a new link is one press, after the
     * audience is set (server/http/pages.js does it in that order).
     */
    async function onAudienceChange(ref, audience, tx) {
        if (ref.service !== SERVICE || ref.kind !== KIND) return;
        await tx.exec('UPDATE food_plans SET share_hash = NULL WHERE id = $1', [String(ref.id)]);
    }

    async function onOwnerChange(ref, from, to, tx) {
        if (ref.service !== SERVICE || ref.kind !== KIND) return;
        const owner = to && to.type === 'user' ? `user:${to.id}` : null;
        if (!owner) return;
        await tx.exec('UPDATE food_plans SET owner = $1 WHERE id = $2', [owner, String(ref.id)]);
    }

    const shares = createShares({
        db,
        network: { json: networkJson },
        events: { publish },
        notify,
        onAudienceChange,
        onOwnerChange,
    });

    return {
        shares,
        SERVICE,
        KIND,
        AUDIENCES,
        DEFAULT_AUDIENCE,
        refOf,
        shareViewer,
        networkJson,
        /** Register a plan, at the owner's default until the Share sheet says otherwise. */
        register: async (viewer, id, audience = DEFAULT_AUDIENCE) => {
            const subject = subjectOf(viewer);
            if (!subject) throw new Error('A plan has a signed-in owner');
            return await shares.register(refOf(id), {
                owner_subject: subject,
                audience: AUDIENCES.includes(audience) ? audience : DEFAULT_AUDIENCE,
            });
        },
        canView: async (viewer, id) => await shares.canView(shareViewer(viewer), refOf(id)),
        canEdit: async (viewer, id) => await shares.canEdit(shareViewer(viewer), refOf(id)),
        setAudience: async (viewer, id, audience) => await shares.setAudience(shareViewer(viewer), refOf(id), audience),
        shareOf: async (id) => await db.maybe('SELECT * FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3',
            [SERVICE, KIND, String(id)]),
        audienceOf: async (id) => {
            const row = await db.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3',
                [SERVICE, KIND, String(id)]);
            return row ? row.audience : null;
        },
        defaultOf: async (viewer) => {
            const subject = subjectOf(viewer);
            if (!subject) return DEFAULT_AUDIENCE;
            const row = await db.maybe('SELECT audience FROM food_share_defaults WHERE subject = $1', [subject.id]);
            return row && AUDIENCES.includes(row.audience) ? row.audience : DEFAULT_AUDIENCE;
        },
        setDefault: async (viewer, audience, { applyAll = false } = {}) => {
            const subject = subjectOf(viewer);
            if (!subject) return false;
            const want = AUDIENCES.includes(audience) ? audience : DEFAULT_AUDIENCE;
            await db.exec(`INSERT INTO food_share_defaults (subject, audience, updated_at) VALUES ($1, $2, now())
                ON CONFLICT (subject) DO UPDATE SET audience = excluded.audience, updated_at = now()`, [subject.id, want]);
            if (applyAll) {
                await db.exec(`UPDATE shares SET audience = $1, revision = revision + 1
                    WHERE service = $2 AND kind = $3 AND owner_subject->>'id' = $4 AND owner_subject->>'type' = 'user'`,
                    [want, SERVICE, KIND, subject.id]);
                // Any audience change ends the household join link, here as on a single plan: an old /plan/join/<secret>
                // must never outlive the audience its owner chose.
                await db.exec('UPDATE food_plans SET share_hash = NULL WHERE owner = $1', [`user:${subject.id}`]);
            }
            return true;
        },
        /** The people a plan is shared with, as the page lists them (the SDK's projections, owner only). */
        membersOf: async (viewer, id) => {
            try {
                const state = await shares.get(shareViewer(viewer), refOf(id));
                return (state && state.members) || [];
            } catch { return []; }
        },
        describe: async (ref) => {
            if (ref.service !== SERVICE || ref.kind !== KIND) return {};
            const row = await db.maybe('SELECT id, title FROM food_plans WHERE id = $1', [String(ref.id)]);
            if (!row) return {};
            return {
                title: row.title || `Plan ${String(row.id).slice(-6)}`,
                link: `${config.baseUrl}/plan/p/${encodeURIComponent(row.id)}`,
                roles: ['viewer', 'editor'],
                transferable: false,
            };
        },
        work: async ({ flush = true } = {}) => {
            let expired = 0;
            try { expired = await shares.expireMembers(); } catch (err) { log.warn('[Sharing] expiry sweep:', err.message); }
            let sent = 0;
            if (flush) { try { sent = await shares.flush(); } catch (err) { log.warn('[Sharing] deliveries:', err.message); } }
            return { expired, sent };
        },
    };
}

/** Register a plan just made, at the person's default; a sharing system that is down never fails the save. */
async function registerPlan(sharing, viewer, id, log = console) {
    if (!sharing) return;
    try {
        const audience = await sharing.defaultOf(viewer).catch(() => DEFAULT_AUDIENCE);
        await sharing.register(viewer, id, audience);
    } catch (err) {
        log.warn(`[Food] plan ${id}: not registered with the sharing system: ${String((err && err.message) || err).slice(0, 200)}`);
    }
}

module.exports = { createSharing, registerPlan, shareViewer, subjectOf, refOf, AUDIENCES, DEFAULT_AUDIENCE, SERVICE, KIND };
