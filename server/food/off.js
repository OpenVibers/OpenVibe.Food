'use strict';

/**
 * Open Food Facts products as label data beside the food list (source open-food-facts, category food).
 *
 * Sources streams Open Food Facts' export (ODbL) and keeps each product's code, name, brands, Nutri-Score and
 * per-100 g nutrients. Food follows Sources' change feed from its own cursor, matches a product to one of the
 * 42 foods it plans with by the product's own name, and keeps the match in food_off_products. The list's own
 * nutrition and typical prices stay what they are: a food's page shows the product's figures in a separate
 * section, as the label states them, with the ODbL credit and a link to the product — never as a replacement.
 *
 * Pulls 50 seconds after start and then every six hours. Off without OV_SOURCES_INTERNAL_URL and the OAuth
 * client secret (a test passes its own source).
 */
const ingest = require('openvibe-publishing/ingest');

const SOURCE_KEY = 'open-food-facts';
const CURSOR = 'sources.food.off.after';
const EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_MS = 50 * 1000;
const ODBL_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';
const NOTE = 'Product label data from Open Food Facts (ODbL). The Open Food Facts database is available under the Open Database License; attribution and share-alike apply.';

const text = (v, max) => (v == null || v === '' ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, max) || null);
const num = (v) => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
    return Number.isFinite(n) && n >= 0 && n < 1_000_000 ? Math.round(n * 1000) / 1000 : null;
};

/** The food list's own matchers, in the order that keeps "peanut butter" from becoming butter. */
const MATCHERS = [
    ['peanut-butter', /peanut butter/],
    ['whole-milk', /\bwhole milk\b/, /\b(milk chocolate|chocolate milk|milk powder|powdered milk|coconut milk|almond milk|soy milk|oat milk|whole milk powder)\b/],
    ['powdered-milk', /\b(powdered milk|milk powder|nonfat dry milk)\b/],
    ['cheese-block', /\b(cheddar|cheese block|block cheese)\b/, /\b(shredded|sliced|sauce|spread|puffs|snack)\b/],
    ['yogurt', /\b(yogurt|yoghurt)\b/],
    ['butter', /\bbutter\b/, /\b(peanut|almond|cashew|cocoa|apple|shea|body)\b/],
    ['eggs-dozen', /\beggs?\b/, /\b(egg noodles?|egg rolls?|candy|easter)\b/],
    ['chicken-breast', /\bchicken breast\b/],
    ['ground-beef', /\bground beef\b/],
    ['hot-dogs', /\b(hot dogs?|frankfurters?|wieners?)\b/],
    ['canned-tuna', /\btuna\b/, /\b(tuna casserole|tuna salad)\b/],
    ['sardines', /\bsardines?\b/],
    ['canned-chili', /\bchili\b/, /\b(chili powder|chili sauce|chili oil|chili flakes?)\b/],
    ['canned-soup', /\b(chicken noodle soup|condensed soup|soup)\b/, /\b(soup mix|soup base|soup bowl)\b/],
    ['ramen-12pk', /\b(ramen|instant noodles?)\b/],
    ['mac-cheese', /\b(mac(aroni)? (and|&) cheese|macaroni cheese)\b/],
    ['spaghetti', /\b(spaghetti|thin spaghetti)\b/],
    ['white-rice', /\b(long grain white rice|white rice)\b/],
    ['oatmeal', /\b(oatmeal|old fashioned oats|rolled oats|quick oats)\b/, /\b(oat milk|oat cereal|granola)\b/],
    ['bread-white', /\b(white bread|white sandwich bread)\b/],
    ['tortillas', /\btortillas?\b/],
    ['jiffy-mix', /\b(corn muffin mix|muffin mix)\b/],
    ['granola-bars', /\bgranola bars?\b/],
    ['instant-coffee', /\binstant coffee\b/],
    ['canned-beans', /\b(canned|black|kidney|pinto|white) beans\b/, /\b(dried|dry|green beans?|string beans?|bean sprouts?)\b/],
    ['dried-beans', /\b(dried|dry) (pinto|black|kidney|white|great northern) beans\b/],
    ['canned-corn', /\bcorn\b/, /\b(corn flakes?|corn chips?|corn starch|corn syrup|popcorn|cornmeal|corn dogs?)\b/],
    ['baby-carrots', /\bbaby carrots?\b/],
    ['canned-green-beans', /\bgreen beans?\b/],
    ['frozen-mixed-veg', /\b(mixed vegetables?|frozen mixed veg)\b/],
    ['onion-3lb', /\bonions?\b/, /\b(onion powder|onion rings?|onion soup)\b/],
    ['canned-tomatoes', /\b(diced|crushed|whole) tomatoes?\b/],
    ['potatoes-5lb', /\bpotatoes?\b/, /\b(chips?|crisps?|fries|flakes?|starch|salad)\b/],
    ['bananas', /\bbananas?\b/, /\b(banana chips?|banana bread)\b/],
    ['apples-3lb', /\bapples?\b/, /\b(apple juice|apple sauce|applesauce|apple cider|apple vinegar|pineapple)\b/],
    ['oranges-3lb', /\boranges?\b/, /\b(orange juice|orange soda|orange chicken)\b/],
    ['canned-fruit', /\b(peaches|fruit cocktail|canned fruit)\b/],
    ['raisins', /\braisins?\b/],
    ['strawberries', /\bstrawberries\b/],
    ['cooking-oil', /\b(vegetable oil|canola oil|sunflower oil)\b/],
    ['avocado', /\bavocados?\b/, /\b(oil|guacamole)\b/],
    ['trail-mix', /\b(trail mix|mixed nuts)\b/],
];

/** A product's own name → the slug on the food list it labels, or null when the list has no such food. */
function matchSlug(name) {
    const s = String(name == null ? '' : name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
    if (!s) return null;
    for (const [slug, yes, no] of MATCHERS) {
        if (yes.test(s) && !(no && no.test(s))) return slug;
    }
    return null;
}

// food_off_products columns -> the Sources field they hold (the header has a '-' in two of them).
const NUTRIENTS = {
    energy_kcal_100g: 'energy_kcal_100g',
    fat_100g: 'fat_100g',
    saturated_fat_g: 'saturated_fat_100g',
    carbs_g: 'carbohydrates_100g',
    sugars_g: 'sugars_100g',
    protein_g: 'proteins_100g',
    salt_g: 'salt_100g',
    fiber_g: 'fiber_100g',
};

/** A Sources item → the food_off_products row it states, or null when it is not a product this list has. */
function rowOf(item) {
    if (!item || item.source_key !== SOURCE_KEY || item.kind !== 'food_product') return null;
    const code = String(item.identity == null ? '' : item.identity).trim();
    if (!/^\d{6,14}$/.test(code)) return null;
    const name = text(item.title, 300);
    if (!name) return null;
    const slug = matchSlug(name);
    if (!slug) return null;
    const f = item.fields || {};
    const grade = text(f.nutriscore_grade, 3);
    const row = {
        code,
        item_id: String(item.id || ''),
        revision: Number(item.revision) || 1,
        slug,
        product_name: name,
        brands: text(f.brands, 200),
        product_url: item.canonical_url || `https://world.openfoodfacts.org/product/${code}`,
        nutriscore_grade: grade && /^[a-e]$/i.test(grade) ? grade.toUpperCase() : null,
        retrieved_at: (item.provenance && item.provenance.retrieved_at) || new Date(0).toISOString(),
    };
    for (const [col, field] of Object.entries(NUTRIENTS)) row[col] = num(f[field]);
    if (Object.keys(NUTRIENTS).every((col) => row[col] == null) && !row.nutriscore_grade) return null;
    return row;
}

/** The shape a food's page shows: the product as its label states it, per 100 g. */
function shape(row) {
    return {
        code: row.code,
        name: row.product_name,
        brands: row.brands || null,
        url: row.product_url || `https://world.openfoodfacts.org/product/${row.code}`,
        nutriscore_grade: row.nutriscore_grade || null,
        per_100g: {
            energy_kcal: row.energy_kcal_100g == null ? null : Number(row.energy_kcal_100g),
            fat_g: row.fat_100g == null ? null : Number(row.fat_100g),
            saturated_fat_g: row.saturated_fat_g == null ? null : Number(row.saturated_fat_g),
            carbs_g: row.carbs_g == null ? null : Number(row.carbs_g),
            sugars_g: row.sugars_g == null ? null : Number(row.sugars_g),
            protein_g: row.protein_g == null ? null : Number(row.protein_g),
            salt_g: row.salt_g == null ? null : Number(row.salt_g),
            fiber_g: row.fiber_g == null ? null : Number(row.fiber_g),
        },
        retrieved_at: row.retrieved_at,
        note: NOTE,
        license_url: ODBL_URL,
    };
}

function createOff({ config, s, fetchImpl = globalThis.fetch, log = console, source = null }) {
    const url = String((config.sources && config.sources.internalUrl) || '').replace(/\/+$/, '');
    const client = source || (url && config.oauth.clientSecret
        ? ingest.createSourcesClient({ config: { ...config, sources: { internalUrl: url, category: 'food' } }, fetchImpl })
        : null);
    const cursor = ingest.createChangeCursor(s.db, { prefix: 'food', now: s.now });
    const stats = { pulls: 0, applied: 0, removed: 0, last_at: null, last_error: null };
    let byFood = new Map();   // food slug → shape(row), the most complete product for it
    let timer = null;
    let first = null;
    let running = false;

    async function apply(item, t) {
        if (!item || item.source_key !== SOURCE_KEY || item.kind !== 'food_product') return 'hold';
        if (item.removed) {
            await t.query('DELETE FROM food_off_products WHERE item_id = $1', [String(item.id)]);
            return 'removed';
        }
        const row = rowOf(item);
        if (!row) return 'hold';
        const cols = Object.keys(row);
        await t.query(`INSERT INTO food_off_products (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
            ON CONFLICT (code) DO UPDATE SET ${cols.filter((c) => c !== 'code').map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
            WHERE food_off_products.item_id <> EXCLUDED.item_id OR food_off_products.revision <= EXCLUDED.revision`, cols.map((c) => row[c]));
        return 'applied';
    }

    /** One product per food: the one that states the most nutrient values (then its Nutri-Score). */
    async function load() {
        const rows = await s.db.many('SELECT * FROM food_off_products');
        const best = new Map();
        const score = (r) => Object.keys(NUTRIENTS).filter((col) => r[col] != null).length + (r.nutriscore_grade ? 1 : 0);
        for (const row of rows) {
            const cur = best.get(row.slug);
            if (!cur || score(row) > score(cur) || (score(row) === score(cur) && row.code < cur.code)) best.set(row.slug, row);
        }
        byFood = new Map([...best.entries()].map(([slug, row]) => [slug, shape(row)]));
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
            if (out.applied || out.removed) log.log(`[OFF] ${out.applied} Open Food Facts products updated, ${out.removed} removed (Sources cursor ${out.after})`);
            return out;
        } catch (err) {
            stats.last_error = text(err && err.message, 300);
            log.warn(`[OFF] pull from OpenVibe.Sources failed: ${stats.last_error}`);
            return { error: stats.last_error };
        } finally { running = false; }
    }

    return {
        enabled: Boolean(client),
        stats,
        pull,
        apply,
        load,
        /** The Open Food Facts product for a food on the list, or null when no product matched (or nothing is read yet). */
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

module.exports = { createOff, rowOf, shape, matchSlug, MATCHERS, SOURCE_KEY, NOTE, ODBL_URL };
