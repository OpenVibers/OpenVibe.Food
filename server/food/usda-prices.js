'use strict';

/**
 * USDA prices: the Economic Research Service's annual national-average retail prices for fruits and vegetables, read
 * from OpenVibe.Sources (source usda-ers-fruit-vegetable-prices, category food), never from ERS. Sources reads ERS's
 * two published all-fruits and all-vegetables tables once a week under its robots and terms checks and keeps one item
 * per product and form (the identity is "product | form"); Food follows Sources' change feed from its own cursor
 * (openvibe-publishing/ingest, the same food_ingest_cursor table as the recalls and BLS) and keeps one row per
 * Sources identity in food_usda_prices.
 *
 * The food list's own prices stay what they are, a hand-kept 2025 band to plan by; a food's page shows the USDA figure
 * beside the BLS one, for ERS's per-pound price and worked out for the item's pack. ERS publishes annual averages, not
 * a monthly series, and says the data "should not be used for making inferences about price changes over time": the
 * page says the data year (2023) and NOTE repeats both, so the figure is never read as a trend or as this month's price.
 *
 * Pulls a minute after start and then every six hours. Off without OV_SOURCES_INTERNAL_URL and the OAuth client secret
 * (a test passes its own source).
 */
const ingest = require('openvibe-publishing/ingest');

const SOURCE_KEY = 'usda-ers-fruit-vegetable-prices';
const CURSOR = 'sources.food.usda.after';
const EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_MS = 60 * 1000;
// ERS's current tables use 2023 retail scanner data; the files were last updated 2025-12-09. ERS updates them each
// year, subject to data availability: re-check both when the source's page changes (the seed's terms_note says so too).
const VINTAGE = '2023';
const URL = 'https://www.ers.usda.gov/data-products/fruit-and-vegetable-prices/';
// In plain words for a shopper: whose figure it is, that it is one year's national average, and that it is not a
// trend (ERS: "should not be used for making inferences about price changes over time"). ERS also asks that its
// findings not be attributed to Circana, whose scanner data it uses: the page never names Circana, which meets that.
const NOTE = 'A yearly national average from the USDA Economic Research Service (public domain): a snapshot of one year, not a price trend, so it is not compared with other years.';

// Sources identity ("ERS product | form") → the food it prices, how many pounds the food's pack holds (null when the
// pack states no weight), and the plain words the page uses for the product. Every row mapped here is priced per pound.
const PRODUCTS = {
    'Apples | Fresh': { slug: 'apples-3lb', pack: 3, label: 'apples' },
    'Bananas | Fresh': { slug: 'bananas', pack: 1, label: 'bananas' },
    'Oranges | Fresh': { slug: 'oranges-3lb', pack: 3, label: 'oranges' },
    'Strawberries | Fresh': { slug: 'strawberries', pack: 1, label: 'strawberries' },
    'Potatoes | Fresh': { slug: 'potatoes-5lb', pack: 5, label: 'potatoes' },
    'Onions | Fresh': { slug: 'onion-3lb', pack: 3, label: 'onions' },
    'Carrots, baby | Fresh': { slug: 'baby-carrots', pack: 1, label: 'baby carrots' },
    'Avocados | Fresh': { slug: 'avocado', pack: null, label: 'avocados' },
    'Grapes (raisins) | Dried': { slug: 'raisins', pack: 0.375, label: 'raisins' },
    'Peaches, in syrup or water | Canned': { slug: 'canned-fruit', pack: 15 / 16, label: 'peaches in syrup or water' },
    'Pinto beans | Dried': { slug: 'dried-beans', pack: 1, label: 'pinto beans' },
    'Black beans | Canned': { slug: 'canned-beans', pack: 15 / 16, label: 'black beans' },
    'Corn | Canned': { slug: 'canned-corn', pack: 15 / 16, label: 'corn' },
    'Green beans | Canned': { slug: 'canned-green-beans', pack: 14.5 / 16, label: 'green beans' },
    'Mixed vegetables, carrots, peas, corn, and green beans | Frozen': { slug: 'frozen-mixed-veg', pack: 12 / 16, label: 'mixed vegetables' },
    'Tomatoes | Canned': { slug: 'canned-tomatoes', pack: 14.5 / 16, label: 'tomatoes' },
};

const text = (v, max) => (v == null || v === '' ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, max) || null);

/** A Sources item → a food_usda_prices row, or null when it is not a row this list maps (or its unit is not a pound). */
function rowOf(item) {
    const f = (item && item.fields) || {};
    const identity = text(item && item.identity, 80);
    if (!identity || !Object.prototype.hasOwnProperty.call(PRODUCTS, identity)) return null;
    const value = Number(f.price);
    // Every mapped food is priced per pound; any other unit would make the pack arithmetic wrong, so hold it.
    if (!Number.isFinite(value) || value <= 0 || value > 1000 || text(f.unit, 20) !== 'per pound') return null;
    return {
        identity,
        item_id: String(item.id),
        revision: Number(item.revision) || 1,
        value: Math.round(value * 10000) / 10000,
        unit: 'lb',
        vintage: VINTAGE,
        retrieved_at: (item.provenance && item.provenance.retrieved_at) || new Date(0).toISOString(),
    };
}

/** What a food's page shows for one row: ERS's figure and data year, and the price worked out for the food's pack. */
function shape(row) {
    const def = PRODUCTS[row.identity];
    const value = Number(row.value);
    return {
        slug: def.slug,
        identity: row.identity,
        item: def.label,
        form: row.identity.slice(row.identity.indexOf(' | ') + 3).toLowerCase(),
        unit: 'lb',
        value,
        pack_price: def.pack == null ? null : Math.round(value * def.pack * 100) / 100,
        year: row.vintage,
        url: URL,
    };
}

function createUsdaPrices({ config, s, fetchImpl = globalThis.fetch, log = console, source = null }) {
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
            await t.query('DELETE FROM food_usda_prices WHERE item_id = $1', [String(item.id)]);
            return 'removed';
        }
        const row = rowOf(item);
        if (!row) return 'hold';
        const cols = Object.keys(row);
        // A replayed page (or an older revision arriving late) never takes a row back.
        await t.query(`INSERT INTO food_usda_prices (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
            ON CONFLICT (identity) DO UPDATE SET ${cols.filter((c) => c !== 'identity').map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
            WHERE food_usda_prices.item_id <> EXCLUDED.item_id OR food_usda_prices.revision <= EXCLUDED.revision`, cols.map((c) => row[c]));
        return 'applied';
    }

    async function load() {
        const rows = await s.db.many('SELECT identity, value, unit, vintage FROM food_usda_prices');
        byFood = new Map(rows.filter((r) => PRODUCTS[r.identity]).map((r) => [PRODUCTS[r.identity].slug, shape(r)]));
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
            if (out.applied || out.removed) log.log(`[Prices] ${out.applied} USDA rows updated, ${out.removed} removed (Sources cursor ${out.after})`);
            return out;
        } catch (err) {
            stats.last_error = text(err && err.message, 300);
            log.warn(`[Prices] pull of USDA prices from OpenVibe.Sources failed: ${stats.last_error}`);
            return { error: stats.last_error };
        } finally { running = false; }
    }

    return {
        enabled: Boolean(client),
        stats,
        pull,
        apply,
        load,
        /** The USDA figure for a food on the list, or null when ERS prices nothing like it (or nothing is read yet). */
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

module.exports = { createUsdaPrices, rowOf, shape, PRODUCTS, SOURCE_KEY, NOTE, VINTAGE, URL };
