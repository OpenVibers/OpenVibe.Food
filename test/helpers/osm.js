'use strict';
/**
 * A stand-in for the two OpenStreetMap services OpenVibe.Food uses, on one local HTTP server:
 *
 *   GET  /search            Nominatim (format=jsonv2): the array in `state.geocode`
 *   POST /api/interpreter   Overpass: the body in `state.overpass.foodbank` or `state.overpass.grocery`,
 *                           chosen by whether the query mentions social_facility or shop
 *
 * Every request is recorded in `.requests` as { path, at, query, body } with its timestamp, so a test can prove the
 * one-request-a-second pace (server/food/upstream.js) and prove a cache hit made no request at all.
 *
 *   const osm = await startOsm();
 *   const t = await boot({ env: { FOOD_NOMINATIM_URL: osm.url, FOOD_OVERPASS_URL: `${osm.url}/api/interpreter` } });
 */
const http = require('http');

const SPRINGFIELD = { lat: '39.7817', lon: '-89.6501', display_name: 'Springfield, Illinois, United States' };

const DEFAULT_OVER = {
    foodbank: {
        elements: [
            { type: 'node', id: 101, lat: 39.7850, lon: -89.6500, tags: { amenity: 'social_facility', social_facility: 'food_bank', name: 'Springfield Food Pantry', 'addr:housenumber': '12', 'addr:street': 'Main Street', 'addr:city': 'Springfield', 'addr:state': 'IL', opening_hours: 'Mo-Fr 09:00-16:00', phone: '+1 217 555 0101', website: 'https://example.org/pantry', wheelchair: 'yes' } },
            { type: 'node', id: 102, lat: 39.7900, lon: -89.6400, tags: { amenity: 'social_facility', social_facility: 'soup_kitchen', name: 'St. Mary Soup Kitchen', opening_hours: 'Sa 11:00-13:00' } },
            { type: 'way', id: 103, center: { lat: 39.7700, lon: -89.6600 }, tags: { amenity: 'give_box', name: 'Free pantry box' } },   // no name: falls back to its type label
            { type: 'node', id: 104, lat: 39.8200, lon: -89.7000, tags: { amenity: 'food_sharing', name: 'Riverside Community Fridge' } },
        ],
    },
    grocery: {
        elements: [
            { type: 'node', id: 201, lat: 39.7800, lon: -89.6600, tags: { shop: 'supermarket', name: 'Aldi', brand: 'Aldi', opening_hours: 'Mo-Su 08:00-20:00' } },
            { type: 'node', id: 202, lat: 39.7900, lon: -89.6600, tags: { shop: 'convenience', name: 'Corner Market' } },
            { type: 'node', id: 203, lat: 39.7750, lon: -89.6450, tags: { shop: 'variety_store', name: 'Dollar Tree' } },
        ],
    },
};

async function startOsm(opts = {}) {
    const requests = [];
    const state = {
        geocode: opts.geocode || [SPRINGFIELD],
        overpass: opts.overpass || DEFAULT_OVER,
        fail: false,
        respond: null,                      // (kind, query) → body, to override per call
    };

    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (d) => { raw += d; raw = raw.slice(0, 65536); });
        req.on('end', () => {
            const url = new URL(req.url, 'http://x');
            const query = url.search || '';
            requests.push({ method: req.method, path: url.pathname, query, body: raw, at: Date.now() });
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (state.fail) return json(503, { error: 'the stand-in OSM service is down' });
            if (url.pathname === '/search' && req.method === 'GET') {
                // Like Nominatim: a place it does not know is an empty array, not an error.
                const words = String(url.searchParams.get('q') || '').toLowerCase().split(/\W+/).filter((w) => w.length >= 3);
                return json(200, state.geocode.filter((g) => words.some((w) => String(g.display_name).toLowerCase().includes(w))));
            }
            if (url.pathname === '/api/interpreter' && req.method === 'POST') {
                const data = decodeURIComponent(new URLSearchParams(raw).get('data') || '');
                const kind = /social_facility|food_sharing|give_box/.test(data) ? 'foodbank' : 'grocery';
                if (state.respond) return json(200, state.respond(kind, data));
                return json(200, state.overpass[kind] || { elements: [] });
            }
            return json(404, { error: 'not found' });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    return {
        url, state, requests,
        env: { FOOD_NOMINATIM_URL: url, FOOD_OVERPASS_URL: `${url}/api/interpreter` },
        reset() { requests.length = 0; state.fail = false; state.respond = null; state.geocode = [SPRINGFIELD]; state.overpass = DEFAULT_OVER; },
        /** The gaps, in ms, between consecutive upstream calls — the pace a test checks. */
        gaps() { return requests.slice(1).map((r, i) => r.at - requests[i].at); },
        close: () => new Promise((r) => server.close(r)),
    };
}

module.exports = { startOsm, SPRINGFIELD, DEFAULT_OVER };
