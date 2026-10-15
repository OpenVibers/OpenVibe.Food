'use strict';

/**
 * Pantry by barcode: a product's barcode (EAN-13, UPC-A, EAN-8, GTIN-14) is looked up on Open Food Facts
 * (https://world.openfoodfacts.org, the open food product database: data under the Open Database License, so the page
 * says where it came from), and the product is matched to the item on Food's own list it is (server/food/foods.js).
 * The person confirms before anything is added: a wrong guess is one click to change, never a silent tick.
 *
 *   normalize(code)        digits only, 8 to 14 of them, with a valid check digit → the GTIN, else null
 *   matchFood(product)     → a foods.js slug or null, from the product's name and Open Food Facts categories
 *   createBarcodes({ config, fetchImpl }).lookup(code) → { code, found, name, brand, quantity, match, url } | throws
 *
 * Open Food Facts asks for a User-Agent that names the app and a contact, and allows about 100 product reads a
 * minute: lookups are cached for a day and the whole service makes at most FOOD_BARCODE_PER_MINUTE (60) a minute.
 * Nothing about the person is sent: only the barcode.
 */
const foods = require('./foods');

const API = 'https://world.openfoodfacts.org/api/v2/product';
const FIELDS = 'product_name,product_name_en,generic_name,brands,quantity,categories_tags';

function normalize(code) {
    const d = String(code == null ? '' : code).replace(/[\s-]/g, '');
    if (!/^\d{8}$|^\d{12,14}$/.test(d)) return null;
    // GS1 check digit: from the right, the digits before the check digit weigh 3, 1, 3, 1, …
    let sum = 0;
    for (let i = d.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(d[i]) * w;
    return (10 - (sum % 10)) % 10 === Number(d[d.length - 1]) ? d : null;
}

// Produce, dairy and staples are matched only when the product is the thing itself, not something made from it.
const MADE_FROM = /\b(juice|chips?|crisps|sauce|ketchup|jam|jelly|preserves|pie|cake|cookies?|candy|gummies|flavou?red|snack|bars?|soda|drink|smoothie|ice cream|dressing|seasoning|baby food|puree)\b/i;

/** First match wins: the specific before the general (peanut butter before butter, canned chili before beans). */
const RULES = [
    ['canned-chili', /\bchili\b/i],
    ['ramen-12pk', /\b(ramen|instant noodles?)\b/i],
    ['canned-soup', /\bsoups?\b/i],
    ['canned-tuna', /\btuna\b/i],
    ['sardines', /\bsardines?\b/i],
    ['peanut-butter', /peanut[\s-]*butter/i],
    ['mac-cheese', /\bmac(aroni)?\s*(&|and|n'?)?\s*cheese\b/i],
    ['granola-bars', /\b(granola|cereal)\s*bars?\b/i],
    ['trail-mix', /\btrail\s*mix\b/i],
    ['jiffy-mix', /\b(corn\s*)?muffin\s*mix\b|\bcornbread\s*mix\b/i],
    ['instant-coffee', /\binstant\s*coffee\b/i],
    ['powdered-milk', /\b(powdered|dry|nonfat dry)\s*milk\b|\bmilk\s*powder\b/i],
    ['hot-dogs', /\bhot\s*dogs?\b|\bfranks\b|\bwieners?\b/i],
    ['ground-beef', /\bground\s*beef\b|\bhamburger\s*meat\b/i],
    ['chicken-breast', /\bchicken\s*breasts?\b/i],
    ['canned-green-beans', /\bgreen\s*beans\b/i, true],
    ['canned-beans', /\b(black|kidney|refried|cannellini|garbanzo|chick\s*peas?|chickpeas)\b.*\bbeans?\b|\bcanned\s*beans\b|\brefried\b|\bchickpeas\b/i],
    ['dried-beans', /\b(pinto|navy|great northern)\s*beans\b|\bdried\s*beans\b|\bdry\s*beans\b/i],
    ['whole-milk', /\b(whole|2%|1%|skim|reduced fat|fat free|lowfat|low fat)?\s*milk\b/i, true],
    ['cheese-block', /\bcheddar\b|\bcheese\b/i, true],
    ['yogurt', /\byog(h)?o?urt\b/i, true],
    ['butter', /\bbutter\b/i, true],
    ['cooking-oil', /\b(vegetable|canola|olive|sunflower|corn|soybean|cooking)\s*oil\b/i],
    ['white-rice', /\brice\b/i, true],
    ['spaghetti', /\bspaghetti\b|\bpasta\b|\bpenne\b|\bmacaroni\b|\blinguine\b|\brotini\b/i, true],
    ['tortillas', /\btortillas?\b/i, true],
    ['bread-white', /\bbread\b|\bsandwich loaf\b/i, true],
    ['oatmeal', /\boats\b|\boatmeal\b|\brolled oats\b/i, true],
    ['potatoes-5lb', /\bpotato(es)?\b/i, true],
    ['canned-corn', /\b(whole kernel|sweet)?\s*corn\b/i, true],
    ['baby-carrots', /\bcarrots?\b/i, true],
    ['frozen-mixed-veg', /\bmixed\s*veg(etable)?s?\b/i, true],
    ['onion-3lb', /\bonions?\b/i, true],
    ['canned-tomatoes', /\b(diced|crushed|whole|stewed)\s*tomato(es)?\b|\btomatoes\b/i, true],
    ['bananas', /\bbananas?\b/i, true],
    ['apples-3lb', /\bapples?\b/i, true],
    ['oranges-3lb', /\boranges?\b/i, true],
    ['canned-fruit', /\bpeach(es)?\b|\bfruit\s*cocktail\b|\bpears?\b|\bcanned\s*fruit\b|\bpineapple\b|\bmandarin\b/i, true],
    ['raisins', /\braisins?\b/i, true],
    ['strawberries', /\bstrawberr(y|ies)\b/i, true],
    ['avocado', /\bavocados?\b/i, true],
    ['eggs-dozen', /\beggs?\b/i, true],
];

/** The foods.js slug this product is, or null. Categories are Open Food Facts tags ("en:peanut-butters"). */
function matchFood(product) {
    if (!product) return null;
    const name = [product.product_name_en, product.product_name, product.generic_name].filter(Boolean).join(' ');
    const cats = (Array.isArray(product.categories_tags) ? product.categories_tags : []).filter((c) => /^en:/.test(c)).map((c) => c.slice(3).replace(/-/g, ' ')).join(' ');
    const text = `${name} ${cats}`.trim();
    if (!text) return null;
    for (const [slug, re, plain] of RULES) {
        if (!re.test(text)) continue;
        if (plain && MADE_FROM.test(name)) continue;
        if (foods.getFood(slug)) return slug;
    }
    return null;
}

function createBarcodes({ config, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    const cache = new Map();   // code → { at, value }
    const DAY = 86400_000;
    let window = { start: 0, n: 0 };

    async function lookup(raw) {
        const code = normalize(raw);
        if (!code) { const e = new Error('That is not a product barcode (8, 12, 13 or 14 digits with a valid check digit).'); e.code = 'food.barcode.invalid'; throw e; }
        const hit = cache.get(code);
        if (hit && now() - hit.at < DAY) return hit.value;
        if (now() - window.start > 60_000) window = { start: now(), n: 0 };
        if (++window.n > config.barcode.perMinute) { const e = new Error('Too many barcode lookups right now. Try again in a minute.'); e.code = 'food.barcode.busy'; throw e; }
        let res;
        try {
            res = await fetchImpl(`${API}/${code}.json?fields=${FIELDS}`, {
                headers: { 'User-Agent': config.barcode.userAgent, Accept: 'application/json' },
                signal: AbortSignal.timeout(8000), redirect: 'error',
            });
        } catch (err) {
            const e = new Error('Open Food Facts did not answer. Try again in a moment.'); e.code = 'food.barcode.unreachable'; throw e;
        }
        if (res.status !== 200 && res.status !== 404) { const e = new Error(`Open Food Facts answered ${res.status}. Try again in a moment.`); e.code = 'food.barcode.unreachable'; throw e; }
        const body = await res.json().catch(() => null);
        const p = body && body.status === 1 && body.product ? body.product : null;
        const value = p
            ? { code, found: true, name: String(p.product_name_en || p.product_name || p.generic_name || '').trim().slice(0, 160) || null, brand: String(p.brands || '').split(',')[0].trim().slice(0, 80) || null,
                quantity: String(p.quantity || '').trim().slice(0, 40) || null, match: matchFood(p), url: `https://world.openfoodfacts.org/product/${code}` }
            : { code, found: false, name: null, brand: null, quantity: null, match: null, url: `https://world.openfoodfacts.org/product/${code}` };
        cache.set(code, { at: now(), value });
        if (cache.size > 2000) cache.delete(cache.keys().next().value);
        return value;
    }

    return { lookup };
}

module.exports = { normalize, matchFood, createBarcodes, RULES };
