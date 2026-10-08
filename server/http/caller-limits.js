'use strict';

/**
 * Per-caller rate limits at OpenVibe.Food's API (openvibe-sdk/limits). The per-address limits in app.js stay; these
 * count requests by who makes them:
 *
 *   a person               user:usr_… (a Bearer token or this site's session)
 *   an app, agent, service app:app_… / agent:agt_… / service:<slug>
 *   anyone else            ip:<address>
 *
 * Past a limit the route answers 429 problem+json `rate_limited` with Retry-After before it does any work; the
 * refusal is logged once and counted in food_rate_limited_total{limit,window}. Reads take FOOD_LIMITS_MINUTE /
 * FOOD_LIMITS_HOUR (120 and 3000); the product's expensive routes get their own numbers in BUDGETS below.
 * Counters live in this process unless VALKEY_URL is set.
 *
 * Never limited here: /api/health, /api/ready, /release.json, /metrics, sign-in and the pages.
 */
const { createActorLimiter, createValkeyLimitStore } = require('openvibe-sdk/limits');

function caller(req) {
    const p = req.principal;
    if (p && p.requester) return p.requester;
    const v = req.viewer;
    if (v && v.kind === 'user' && v.subject) return `user:${v.subject}`;
    return `ip:${req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'}`;
}

/**
 * The product's expensive routes, each with its numbers per caller (a minute, an hour). A route takes its entry
 * with `limits.budget('<name>')`; an unknown name throws, so a route can never be counted by a budget that was
 * not declared here. The empty object is the skeleton's starting point:
 *
 *   'food.thing.create': { minute: 6, hour: 60 },
 */
const BUDGETS = {
    // The place search is the expensive route: every miss is a Nominatim geocode and an Overpass area query, both
    // community services with a shared one-request-a-second budget (server/food/upstream.js). Answers are cached for
    // a week, so these numbers are for the callers who keep asking for new places.
    'food.place.search': { minute: 10, hour: 120 },
    // Saving a plan and replacing a pantry are cheap writes but they are writes.
    'food.plan.create': { minute: 20, hour: 300 },
    'food.pantry.write': { minute: 30, hour: 600 },
};

function createCallerLimits({ config, now = () => Date.now(), registry = null, log = console, enabled = true, valkey = null }) {
    const refused = registry
        ? registry.counter({ name: 'food_rate_limited_total', help: 'Requests refused 429 by a per-caller limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.limits.minute, hour: config.limits.hour },
        actor: enabled ? caller : () => null,
        now,
        ...(valkey ? { store: createValkeyLimitStore(valkey) } : {}),
        onLimited(e) {
            // The caller is a subject, a principal or an address, never a token.
            log.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name) => {
        const limit = limiter(name);
        return (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? limit(req, res, next) : next());
    };
    const budgets = new Map(Object.entries(BUDGETS).map(([name, own]) => [name, limiter(name, own)]));
    limiter.budget = (name) => {
        const m = budgets.get(name);
        if (!m) throw new Error(`limits: no budget named ${name}`);
        return m;
    };
    return limiter;
}

module.exports = { createCallerLimits, caller, BUDGETS };
