'use strict';

/**
 * Official prices: the Bureau of Labor Statistics' monthly US city average retail prices for the items on the food list
 * that BLS prices, read from OpenVibe.Sources (source bls-average-prices, category food), never from BLS. Sources reads
 * BLS's published average-price file once a day under its robots and terms checks and keeps each series' newest month
 * as an item; Food follows Sources' change feed from its own cursor (openvibe-publishing/ingest, the same
 * food_ingest_cursor table as the recalls) and keeps one row per series in food_official_prices.
 *
 * The food list's own prices stay what they are, a hand-kept 2025 band to plan by; a food's page shows the BLS figure
 * beside it, for the series' unit and worked out for the item's pack. BLS asks to be cited and says it cannot vouch for
 * the data once they leave BLS.gov: NOTE says both wherever a figure shows.
 *
 * Pulls 45 seconds after start and then hourly. Off without OV_SOURCES_INTERNAL_URL and the OAuth client secret (a test
 * passes its own source).
 */
const ingest = require('openvibe-publishing/ingest');

const SOURCE_KEY = 'bls-average-prices';
const CURSOR = 'sources.food.prices.after';
const EVERY_MS = 60 * 60 * 1000;
const FIRST_MS = 45 * 1000;
const NOTE = 'US city average retail prices from the U.S. Bureau of Labor Statistics (Average Price Data, public domain). BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov.';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// BLS series (US city average) → the food it prices, the series' unit, and how many units the food's pack holds.
const SERIES = {
    APU0000708111: { slug: 'eggs-dozen', unit: 'dozen', item: 'Eggs, grade A, large', perPack: 1 },
    APU0000FF1101: { slug: 'chicken-breast', unit: 'lb', item: 'Chicken breast, boneless', perPack: 1 },
    APU0000703112: { slug: 'ground-beef', unit: 'lb', item: 'Ground beef, 100% beef', perPack: 1 },
    APU0000702111: { slug: 'bread-white', unit: 'lb', item: 'Bread, white, pan', perPack: 1.25 },
    APU0000701312: { slug: 'white-rice', unit: 'lb', item: 'Rice, white, long grain, uncooked', perPack: 2 },
    APU0000701322: { slug: 'spaghetti', unit: 'lb', item: 'Spaghetti and macaroni', perPack: 1 },
    APU0000714233: { slug: 'dried-beans', unit: 'lb', item: 'Beans, dried, any type', perPack: 1 },
    APU0000711211: { slug: 'bananas', unit: 'lb', item: 'Bananas', perPack: 1 },
    APU0000711311: { slug: 'oranges-3lb', unit: 'lb', item: 'Oranges, Navel', perPack: 3 },
    APU0000711415: { slug: 'strawberries', unit: '12 oz', item: 'Strawberries, dry pint', perPack: 16 / 12 },
    APU0000712112: { slug: 'potatoes-5lb', unit: 'lb', item: 'Potatoes, white', perPack: 5 },
    APU0000709112: { slug: 'whole-milk', unit: 'gallon', item: 'Milk, fresh, whole, fortified', perPack: 1 },
    APU0000710212: { slug: 'cheese-block', unit: 'lb', item: 'Cheddar cheese, natural', perPack: 0.5 },
};

const text = (v, max) => (v == null || v === '' ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, max) || null);

/** A Sources item → a food_official_prices row, or null when it is not a series this list prices. */
function rowOf(item) {
    const f = (item && item.fields) || {};
    const series = text(item && item.identity, 20);
    if (!series || !Object.prototype.hasOwnProperty.call(SERIES, series)) return null;
    const value = Number(f.value);
    const year = Number(f.year);
    const period = text(f.period, 3);
    if (!Number.isFinite(value) || value <= 0 || value > 1000 || !Number.isInteger(year) || year < 2000 || year > 2100 || !/^M(0[1-9]|1[0-2])$/.test(period || '')) return null;
    return {
        series_id: series,
        item_id: String(item.id),
        revision: Number(item.revision) || 1,
        value: Math.round(value * 1000) / 1000,
        year,
        period,
        retrieved_at: (item.provenance && item.provenance.retrieved_at) || new Date(0).toISOString(),
    };
}

/** What a food's page shows for one row: the series' figure and month, and the price worked out for the food's pack. */
function shape(row) {
    const def = SERIES[row.series_id];
    const value = Number(row.value);
    return {
        slug: def.slug,
        series_id: row.series_id,
        item: def.item,
        unit: def.unit,
        value,
        pack_price: Math.round(value * def.perPack * 100) / 100,
        month: `${MONTHS[Number(row.period.slice(1)) - 1]} ${row.year}`,
        url: `https://data.bls.gov/timeseries/${row.series_id}`,
    };
}

function createOfficialPrices({ config, s, fetchImpl = globalThis.fetch, log = console, source = null }) {
    const url = String((config.sources && config.sources.internalUrl) || '').replace(/\/+$/, '');
    const client = source || (url && config.oauth.clientSecret
        ? ingest.createSourcesClient({ config: { ...config, sources: { internalUrl: url, category: 'food' } }, fetchImpl })
        : null);
    const cursor = ingest.createChangeCursor(s.db, { prefix: 'food', now: s.now });
    const stats = { pulls: 0, applied: 0, removed: 0, last_at: null, last_error: null };
    let byFood = new Map();   // food slug → shape(row), refreshed after each pull
    let timer = null;
    let first = null;
    let running = false;

    async function apply(item, t) {
        if (!item || item.source_key !== SOURCE_KEY || item.kind !== 'price') return 'hold';
        if (item.removed) {
            await t.query('DELETE FROM food_official_prices WHERE item_id = $1', [String(item.id)]);
            return 'removed';
        }
        const row = rowOf(item);
        if (!row) return 'hold';
        const cols = Object.keys(row);
        // A replayed page (or an older revision arriving late) never takes a row back.
        await t.query(`INSERT INTO food_official_prices (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
            ON CONFLICT (series_id) DO UPDATE SET ${cols.filter((c) => c !== 'series_id').map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
            WHERE food_official_prices.item_id <> EXCLUDED.item_id OR food_official_prices.revision <= EXCLUDED.revision`, cols.map((c) => row[c]));
        return 'applied';
    }

    async function load() {
        const rows = await s.db.many('SELECT series_id, value, year, period FROM food_official_prices');
        byFood = new Map(rows.filter((r) => SERIES[r.series_id]).map((r) => [SERIES[r.series_id].slug, shape(r)]));
        return byFood.size;
    }

    /** Follow Sources' change feed to its end. Never throws: the caller is a timer or a test. */
    async function pull() {
        if (!client || running) return { skipped: true };
        running = true;
        try {
            const out = await ingest.pullChanges({ db: s.db, cursor, source: client, name: CURSOR, apply });
            stats.pulls++;
            stats.applied += out.applied;
            stats.removed += out.removed;
            stats.last_at = s.iso();
            stats.last_error = null;
            await load();
            if (out.applied || out.removed) log.log(`[Prices] ${out.applied} BLS series updated, ${out.removed} removed (Sources cursor ${out.after})`);
            return out;
        } catch (err) {
            stats.last_error = text(err && err.message, 300);
            log.warn(`[Prices] pull from OpenVibe.Sources failed: ${stats.last_error}`);
            return { error: stats.last_error };
        } finally { running = false; }
    }

    return {
        enabled: Boolean(client),
        stats,
        pull,
        apply,
        load,
        /** The BLS figure for a food on the list, or null when BLS prices nothing like it (or nothing is read yet). */
        forFood(slug) { return byFood.get(slug) || null; },
        start() {
            load().catch(() => { /* the first pull loads it */ });
            if (!client || timer) return;
            first = setTimeout(() => { pull(); }, FIRST_MS);
            timer = setInterval(() => { pull(); }, EVERY_MS);
            if (first.unref) first.unref();
            if (timer.unref) timer.unref();
        },
        stop() {
            if (first) clearTimeout(first);
            if (timer) clearInterval(timer);
            first = null;
            timer = null;
        },
    };
}

module.exports = { createOfficialPrices, rowOf, shape, SERIES, SOURCE_KEY, NOTE };
