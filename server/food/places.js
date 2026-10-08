'use strict';

/**
 * "Find food near you": food banks, pantries, soup kitchens and community fridges, and budget grocery stores, from
 * OpenStreetMap through Overpass. The tag shapes and the classification are ported from OpenVibe.Tools' grocery
 * source (apps/maps/server/sources/grocery.js); the queries here are bounded to one radius around one point and one
 * kind of tag, and server/food/upstream.js paces and caches every one of them.
 *
 * Everything this module returns is © OpenStreetMap contributors, under ODbL. Callers must show the attribution and
 * link it back — the pages do (server/http/pages.js), and the API returns it with every answer.
 */

const { UpstreamError } = require('./upstream');

const ATTRIBUTION = {
    text: '© OpenStreetMap contributors',
    url: 'https://www.openstreetmap.org/copyright',
    license: 'ODbL 1.0',
    license_url: 'https://opendatacommons.org/licenses/odbl/1-0/',
};
const SOURCE = {
    name: 'OpenStreetMap',
    url: 'https://www.openstreetmap.org/',
    via: 'Overpass API',
    license: 'ODbL 1.0',
    fetched_note: 'fetched by OpenVibe.Food and cached for 7 days',
};

// The four kinds of free food OpenStreetMap tags, as the Tools source classified them.
const FOOD_BANK_TYPES = {
    food_bank: { label: 'Food bank', offers: 'Pre-packaged food' },
    soup_kitchen: { label: 'Soup kitchen', offers: 'Hot prepared meals' },
    food_sharing: { label: 'Community fridge', offers: 'Drop off or pick up food' },
    give_box: { label: 'Free pantry box', offers: 'Free pantry items' },
};

// Chains OpenStreetMap tags as a discount grocer. Anything else is still listed, without the budget mark.
const BUDGET_BRANDS = [/aldi/i, /lidl/i, /netto/i, /penny markt/i, /dollar tree/i, /dollar general/i, /family dollar/i, /grocery outlet/i, /save ?a ?lot/i, /winco/i, /food ?4 ?less/i, /foods ?co/i, /price ?rite/i, /action\b/i, /biedronka/i, /żabka/i];

const KINDS = ['foodbank', 'grocery'];

function haversineKm(aLat, aLon, bLat, bLon) {
    const R = 6371.0088;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatAddress(tags) {
    const parts = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city'], tags['addr:state'], tags['addr:postcode']]
        .map((p) => (p == null ? '' : String(p).trim())).filter(Boolean);
    return parts.join(', ');
}

const isBudgetStore = (tags) => {
    if (tags.shop === 'variety_store') return true;   // a dollar store is a budget store by definition
    const brand = `${tags.brand || ''} ${tags.name || ''} ${tags.operator || ''}`;
    return BUDGET_BRANDS.some((re) => re.test(brand));
};

/** The Overpass query for one kind, bounded to `radiusM` metres around one point. Never a bulk download. */
function queryFor(kind, lat, lon, radiusM) {
    const around = `(around:${radiusM},${lat},${lon})`;
    if (kind === 'foodbank') {
        return `[out:json][timeout:25];(
nwr["amenity"="social_facility"]["social_facility"="food_bank"]${around};
nwr["amenity"="social_facility"]["social_facility"="soup_kitchen"]${around};
nwr["amenity"="food_bank"]${around};
nwr["amenity"="food_sharing"]${around};
nwr["amenity"="give_box"]${around};
);out center tags;`;
    }
    return `[out:json][timeout:25];(
nwr["shop"~"^(supermarket|convenience|grocery|greengrocer|variety_store|wholesale|frozen_food)$"]${around};
);out center tags;`;
}

/** One Overpass element → one result, or null when it carries no usable position. */
function toResult(el, kind, origin) {
    const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
    const lon = el.lon != null ? el.lon : (el.center && el.center.lon);
    if (lat == null || lon == null) return null;
    const tags = el.tags || {};
    const fbType = tags.social_facility === 'soup_kitchen' ? 'soup_kitchen'
        : tags.amenity === 'food_sharing' ? 'food_sharing'
            : tags.amenity === 'give_box' ? 'give_box' : 'food_bank';
    const type = kind === 'grocery' ? (tags.shop || 'supermarket') : fbType;
    const label = kind === 'grocery'
        ? type.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
        : FOOD_BANK_TYPES[fbType].label;
    return {
        id: `osm-${el.type}-${el.id}`,
        osm_type: el.type, osm_id: el.id,
        osm_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        kind, type, type_label: label,
        name: tags.name || tags.operator || label,
        lat, lon,
        distance_km: Math.round(haversineKm(origin.lat, origin.lon, lat, lon) * 10) / 10,
        address: formatAddress(tags) || null,
        opening_hours: tags.opening_hours || null,
        operator: tags.operator || null,
        phone: tags.phone || tags['contact:phone'] || null,
        website: tags.website || tags['contact:website'] || null,
        wheelchair: tags.wheelchair === 'yes' ? true : tags.wheelchair === 'no' ? false : null,
        budget: kind === 'grocery' ? isBudgetStore(tags) : (tags.fee === 'yes' ? false : null),
    };
}

/** Elements → results, deduplicated by where they are, nearest first. */
function elementsToResults(elements, kind, origin, limit) {
    const seen = new Set();
    const out = [];
    for (const el of elements || []) {
        const r = toResult(el, kind, origin);
        if (!r) continue;
        const key = `${r.name.toLowerCase()}@${r.lat.toFixed(4)},${r.lon.toFixed(4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
    }
    out.sort((a, b) => a.distance_km - b.distance_km || (a.name < b.name ? -1 : 1));
    return limit ? out.slice(0, limit) : out;
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/**
 * The place search behind both the API and the pages.
 *
 *   { kind: 'foodbank' | 'grocery' | 'both', q, lat, lon, radiusKm, limit }
 *
 * A name (q) is geocoded with Nominatim, once, and cached; the area query is cached too. Throws UpstreamError
 * (food.place.invalid on bad input, food.place.upstream when OSM cannot be reached).
 */
async function searchPlaces(upstream, { kind = 'foodbank', q = null, lat = null, lon = null, radiusKm = null, limit = null } = {}, config) {
    const kinds = kind === 'both' ? KINDS : [kind];
    if (!kinds.every((k) => KINDS.includes(k))) throw new UpstreamError('food.place.invalid', 'kind: foodbank, grocery or both', { status: 422 });

    let place = null;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
        place = { name: null, lat: Number(lat), lon: Number(lon), from: 'coordinates' };
    } else if (q && String(q).trim()) {
        const g = await upstream.geocode(q, { limit: 1 });
        const hit = Array.isArray(g.body) ? g.body[0] : null;
        if (!hit) throw new UpstreamError('food.place.not_found', `no place called “${String(q).slice(0, 80)}”; try a town and state, or a postcode`, { status: 404 });
        const la = Number(hit.lat); const lo = Number(hit.lon);
        if (!Number.isFinite(la) || !Number.isFinite(lo)) throw new UpstreamError('food.place.upstream', 'the place service gave no coordinates for that place');
        place = { name: hit.display_name || String(q), lat: la, lon: lo, from: 'geocode', geocoded_at: g.fetched_at };
    } else {
        throw new UpstreamError('food.place.invalid', 'q: a place to search for (or lat and lon)', { status: 422 });
    }

    const maxRadius = (config && config.osm.maxRadiusKm) || 50;
    const rad = clamp(Number(radiusKm) || (config && config.osm.defaultRadiusKm) || 8, 0.5, maxRadius);
    const cap = clamp(Number(limit) || (config && config.osm.maxResults) || 60, 1, (config && config.osm.maxResults) || 60);
    const radiusM = Math.round(rad * 1000);

    const perKind = {};
    let fetchedAt = null;
    let cached = true;
    for (const k of kinds) {
        const r = await upstream.overpass(queryFor(k, place.lat, place.lon, radiusM));
        perKind[k] = elementsToResults(r.body && r.body.elements, k, place, cap);
        if (!r.cached) cached = false;
        if (!fetchedAt || r.fetched_at > fetchedAt) fetchedAt = r.fetched_at;
    }

    const results = kinds.flatMap((k) => perKind[k]).sort((a, b) => a.distance_km - b.distance_km || a.kind.localeCompare(b.kind) || (a.name < b.name ? -1 : 1));
    const counts = { total: results.length, foodbank: (perKind.foodbank || []).length, grocery: (perKind.grocery || []).length, budget_grocery: (perKind.grocery || []).filter((r) => r.budget).length };

    return {
        location: place,
        kind: kind === 'both' ? 'both' : kinds[0],
        radius_km: rad,
        results,
        counts,
        per_kind: perKind,
        fetched_at: fetchedAt,
        cached,
        attribution: ATTRIBUTION,
        source: SOURCE,
    };
}

module.exports = { searchPlaces, haversineKm, formatAddress, isBudgetStore, queryFor, elementsToResults, ATTRIBUTION, SOURCE, FOOD_BANK_TYPES, KINDS };
