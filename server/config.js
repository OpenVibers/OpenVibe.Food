'use strict';

/**
 * OpenVibe.Food configuration. Every value comes from the environment (production: /etc/openvibe/food.env, see
 * .env.example). Only environment variable NAMES appear in code and docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();
const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4970);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.food' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'food',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        // Per-caller limits (server/http/caller-limits.js): the requests one caller (an app, a person, else an
        // address) may make per minute and per hour. The product's own routes add tighter budgets there.
        limits: {
            minute: Math.max(1, int(env.FOOD_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.FOOD_LIMITS_HOUR, 3000)),
        },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role). In
        // development without DATABASE_URL an embedded PGlite database in data/pglite is used (FOOD_PGLITE_DIR
        // overrides the directory).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.FOOD_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:food:' },

        // The two OpenStreetMap services "food near you" stands on (server/food/places.js). Both are open data with
        // published usage policies: Nominatim at most one request a second, Overpass small bounded area queries —
        // server/food/upstream.js paces every call to one host at a time and caches every answer for geoCacheTtlMs.
        osm: {
            nominatimUrl: trim(env.FOOD_NOMINATIM_URL || 'https://nominatim.openstreetmap.org'),
            overpassUrl: trim(env.FOOD_OVERPASS_URL || 'https://overpass-api.de/api/interpreter'),
            // Identify to OSM with a contact URL, as both policies require; never a browser User-Agent.
            userAgent: env.FOOD_OSM_USER_AGENT || `OpenVibeFood/0.1 (+${baseUrl})`,
            minIntervalMs: Math.max(0, int(env.FOOD_OSM_MIN_INTERVAL_MS, 1000)),
            timeoutMs: Math.max(1000, int(env.FOOD_OSM_TIMEOUT_MS, 25_000)),
            cacheTtlMs: Math.max(60_000, int(env.FOOD_GEO_CACHE_TTL_MS, 7 * 24 * 60 * 60 * 1000)),
            defaultRadiusKm: 8,
            maxRadiusKm: 50,
            maxResults: 60,
        },

        // OpenVibe.Network: SSO (OAuth2 authorization server with PKCE) and its JWKS.
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        // The audience this service's app, agent and service tokens carry.
        audience: env.FOOD_AUDIENCE || 'openvibe.food',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'food',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // OpenVibe.Events → this service (server/events-consumer.js). The secret signs a delivery (comma-separated
        // for rotation, 32+ characters each); unset turns POST /internal/events off (503). The url is where the
        // network.account.export_requested and network.account.deleted subscriptions are created at boot, off when
        // unset. Both topics are ADR-033: account export and deletion (server/identity/account-data.js).
        events: {
            secrets: String(env.FOOD_EVENTS_SECRET || '').split(',').map((x) => x.trim()).filter(Boolean),
            url: trim(env.FOOD_EVENTS_URL || env.EVENTS_URL || ''),
            endpoint: env.FOOD_EVENTS_ENDPOINT || '',
        },
    };
}

module.exports = { load };
