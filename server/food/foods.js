'use strict';

/**
 * The food list: what a person can plan a week of meals from, with the nutrition and the typical price behind each
 * item. Every page and the meal planner read it here; nothing else in this service holds food data.
 *
 * Ported from OpenVibe.Tools' grocery source (OpenVibe.Tools/apps/maps/server/sources/grocery.js), where the food
 * tools live today. The Walmart page scraping that source also did is deliberately *not* ported: this service never
 * scrapes a retail site. The prices are the same hand-kept typical 2025 US (Washington) prices, carried over
 * unchanged; they are a band to plan by, never a live price.
 *
 * "Per 100 g" is arithmetic on data we already have: the pack size stated in the item's own name divided by its
 * servings gives grams per serving (server/food/foods.js packGrams). Where the name states no weight (a dozen eggs,
 * a 12-pack of ramen) there is no per-100 g figure and the pages say so rather than guessing a density.
 */

// id, name, group, servings, serving size, kcal, protein g, carbs g, fat g, fiber g, shelf stable, tags
const ROWS = [
    // protein
    ['eggs-dozen', 'Large Eggs (1 dozen)', 'protein', 12, '1 egg', 70, 6, 0.5, 5, 0, false, 'breakfast,versatile,complete-protein'],
    ['chicken-breast', 'Chicken Breasts (per lb)', 'protein', 3, '5 oz', 165, 31, 0, 3.6, 0, false, 'lean,high-protein'],
    ['canned-tuna', 'Canned Tuna (5 oz)', 'protein', 2.5, '2 oz', 60, 13, 0, 0.5, 0, true, 'shelf-stable,lightweight,omega-3'],
    ['peanut-butter', 'Peanut Butter (16 oz)', 'protein', 15, '2 tbsp', 190, 7, 7, 16, 2, true, 'shelf-stable,calorie-dense'],
    ['dried-beans', 'Dried Pinto Beans (1 lb)', 'protein', 12, '1/4 cup dry', 150, 10, 28, 0.5, 10, true, 'shelf-stable,fiber,cheap-protein'],
    ['canned-beans', 'Canned Black Beans (15 oz)', 'protein', 3.5, '1/2 cup', 110, 7, 20, 0.5, 8, true, 'shelf-stable,fiber,ready-to-eat'],
    ['hot-dogs', 'Hot Dogs (8 ct, 12 oz)', 'protein', 8, '1 frank', 150, 5, 2, 13, 0, false, 'easy-cook,budget-king'],
    ['ground-beef', 'Ground Beef 73/27 (1 lb)', 'protein', 4, '4 oz', 280, 19, 0, 23, 0, false, 'high-calorie,iron-rich'],
    ['canned-soup', 'Canned Soup, Chicken Noodle (10.5 oz)', 'protein', 2.5, '1/2 can', 60, 3, 8, 2, 1, true, 'shelf-stable,heat-and-eat'],
    ['canned-chili', 'Canned Chili with Beans (15 oz)', 'protein', 2, '1 cup', 240, 16, 25, 8, 7, true, 'shelf-stable,high-protein,complete-meal'],
    ['sardines', 'Sardines (3.75 oz tin)', 'protein', 2, '~3 fish', 120, 13, 0, 7, 0, true, 'shelf-stable,omega-3,no-cook'],
    // grains
    ['ramen-12pk', 'Ramen Noodles (12 pack)', 'grains', 12, '1 packet', 188, 4, 26, 7, 1, true, 'shelf-stable,just-add-water'],
    ['white-rice', 'Long Grain White Rice (2 lb)', 'grains', 20, '1/4 cup dry', 160, 3, 36, 0, 0, true, 'shelf-stable,bulk-calories,versatile'],
    ['spaghetti', 'Spaghetti (16 oz)', 'grains', 8, '2 oz dry', 200, 7, 41, 1, 2, true, 'shelf-stable,energy-dense'],
    ['bread-white', 'White Bread (20 oz)', 'grains', 20, '1 slice', 65, 2, 13, 1, 0.5, false, 'sandwich-base,breakfast'],
    ['oatmeal', 'Oats, Old Fashioned (42 oz)', 'grains', 30, '1/2 cup dry', 150, 5, 27, 3, 4, true, 'shelf-stable,fiber,breakfast'],
    ['tortillas', 'Flour Tortillas (10 ct)', 'grains', 10, '1 tortilla', 140, 4, 24, 3, 1, false, 'wraps,versatile,no-cook'],
    ['jiffy-mix', 'Corn Muffin Mix (8.5 oz)', 'grains', 6, '1 muffin', 180, 3, 28, 5, 1, true, 'shelf-stable,baking'],
    ['mac-cheese', 'Mac & Cheese Box (7.25 oz)', 'grains', 3, '1 cup prepared', 220, 8, 48, 2, 2, true, 'shelf-stable,kid-friendly'],
    ['granola-bars', 'Granola Bars (6 ct)', 'grains', 6, '1 bar', 100, 2, 19, 3, 1, true, 'shelf-stable,portable'],
    ['instant-coffee', 'Instant Coffee (8 oz jar)', 'grains', 120, '1 tsp', 0, 0, 0, 0, 0, true, 'shelf-stable,no-calories'],
    // vegetables
    ['potatoes-5lb', 'Russet Potatoes (5 lb)', 'vegetables', 10, '1 medium', 160, 4, 37, 0, 4, true, 'calorie-dense,versatile'],
    ['canned-corn', 'Canned Corn (15 oz)', 'vegetables', 3.5, '1/2 cup', 60, 2, 14, 0.5, 2, true, 'shelf-stable,ready-to-eat'],
    ['baby-carrots', 'Baby Carrots (1 lb)', 'vegetables', 6, '3 oz', 35, 1, 8, 0, 2, false, 'ready-to-eat,no-cook,vitamin-a'],
    ['canned-green-beans', 'Canned Green Beans (14.5 oz)', 'vegetables', 3.5, '1/2 cup', 20, 1, 4, 0, 1, true, 'shelf-stable,low-calorie'],
    ['frozen-mixed-veg', 'Frozen Mixed Vegetables (12 oz)', 'vegetables', 4, '3/4 cup', 50, 2, 10, 0, 3, false, 'needs-freezer,vitamin-rich'],
    ['onion-3lb', 'Yellow Onions (3 lb bag)', 'vegetables', 9, '1 medium', 45, 1, 11, 0, 1, true, 'flavor-base,long-lasting'],
    ['canned-tomatoes', 'Diced Tomatoes (14.5 oz can)', 'vegetables', 3.5, '1/2 cup', 25, 1, 5, 0, 1, true, 'shelf-stable,cooking-base,vitamin-c'],
    // fruits
    ['bananas', 'Bananas (per lb, ~3 bananas)', 'fruits', 3, '1 medium', 105, 1, 27, 0, 3, false, 'no-cook,potassium,energy'],
    ['apples-3lb', 'Gala Apples (3 lb bag)', 'fruits', 7, '1 medium', 95, 0.5, 25, 0, 4, false, 'no-cook,fiber,portable'],
    ['oranges-3lb', 'Oranges (3 lb bag)', 'fruits', 6, '1 medium', 65, 1, 16, 0, 3, false, 'no-cook,vitamin-c,portable'],
    ['canned-fruit', 'Canned Peaches (15 oz)', 'fruits', 3.5, '1/2 cup', 60, 0, 15, 0, 1, true, 'shelf-stable,ready-to-eat,sweet'],
    ['raisins', 'Raisins (6 oz box)', 'fruits', 4, '1/4 cup', 120, 1, 32, 0, 2, true, 'shelf-stable,energy-dense'],
    ['strawberries', 'Fresh Strawberries (1 lb)', 'fruits', 4, '1 cup', 50, 1, 12, 0, 3, false, 'vitamin-c,antioxidants'],
    // dairy
    ['whole-milk', 'Whole Milk (1 gallon)', 'dairy', 16, '1 cup', 150, 8, 12, 8, 0, false, 'calcium,complete-protein,vitamin-d'],
    ['cheese-block', 'Cheddar Cheese Block (8 oz)', 'dairy', 8, '1 oz', 110, 7, 1, 9, 0, false, 'calcium,protein,portable'],
    ['yogurt', 'Yogurt (32 oz tub)', 'dairy', 4, '1 cup', 130, 12, 17, 0, 0, false, 'probiotics,breakfast'],
    ['powdered-milk', 'Powdered Milk (25.6 oz)', 'dairy', 24, '1/3 cup powder', 80, 8, 12, 0, 0, true, 'shelf-stable,lightweight'],
    // fats and oils
    ['cooking-oil', 'Vegetable Oil (48 fl oz)', 'fats', 96, '1 tbsp', 120, 0, 0, 14, 0, true, 'cooking-essential,calorie-dense'],
    ['butter', 'Butter (16 oz / 4 sticks)', 'fats', 32, '1 tbsp', 100, 0, 0, 11, 0, false, 'cooking,flavor'],
    ['avocado', 'Fresh Avocado (each)', 'fats', 3, '1/3 avocado', 80, 1, 4, 7, 3, false, 'healthy-fats,potassium,no-cook'],
    ['trail-mix', 'Trail Mix (10 oz)', 'fats', 7, '3 tbsp', 160, 5, 15, 10, 2, true, 'shelf-stable,energy-dense'],
];

// The same prices the Tools source kept: the five budget chains it compared, per pack. A null price (the chain does
// not carry the item) is simply absent. Only ever shown as a band and a comparison, never as a live price.
const PRICES = {
    'eggs-dozen': { walmart: 3.24, fredmeyer: 3.49, safeway: 3.79, groceryoutlet: 2.99 },
    'chicken-breast': { walmart: 2.57, fredmeyer: 2.99, safeway: 3.49, groceryoutlet: 1.99 },
    'canned-tuna': { walmart: 1.08, fredmeyer: 1.25, safeway: 1.39, dollartree: 1.25, groceryoutlet: 0.99 },
    'peanut-butter': { walmart: 2.14, fredmeyer: 2.49, safeway: 2.79, dollartree: 1.25, groceryoutlet: 1.99 },
    'dried-beans': { walmart: 1.28, fredmeyer: 1.49, safeway: 1.69, dollartree: 1.25, groceryoutlet: 1.19 },
    'canned-beans': { walmart: 0.78, fredmeyer: 0.99, safeway: 1.09, dollartree: 1.25, groceryoutlet: 0.79 },
    'hot-dogs': { walmart: 1.00, fredmeyer: 1.29, safeway: 1.49, dollartree: 1.25, groceryoutlet: 0.99 },
    'ground-beef': { walmart: 5.94, fredmeyer: 5.99, safeway: 6.49, groceryoutlet: 4.99 },
    'canned-soup': { walmart: 0.98, fredmeyer: 1.09, safeway: 1.19, dollartree: 1.25, groceryoutlet: 0.89 },
    'canned-chili': { walmart: 1.48, fredmeyer: 1.69, safeway: 1.89, dollartree: 1.25, groceryoutlet: 1.29 },
    'sardines': { walmart: 1.08, fredmeyer: 1.29, safeway: 1.49, dollartree: 1.25, groceryoutlet: 0.89 },
    'ramen-12pk': { walmart: 3.97, fredmeyer: 3.99, safeway: 4.29, dollartree: 1.25, groceryoutlet: 2.99 },
    'white-rice': { walmart: 1.42, fredmeyer: 1.69, safeway: 1.89, dollartree: 1.25, groceryoutlet: 1.49 },
    'spaghetti': { walmart: 0.98, fredmeyer: 1.15, safeway: 1.29, dollartree: 1.25, groceryoutlet: 0.89 },
    'bread-white': { walmart: 1.18, fredmeyer: 1.39, safeway: 1.49, dollartree: 1.25, groceryoutlet: 1.29 },
    'oatmeal': { walmart: 3.48, fredmeyer: 3.69, safeway: 3.99, dollartree: 1.25, groceryoutlet: 2.99 },
    'tortillas': { walmart: 1.96, fredmeyer: 2.29, safeway: 2.49, dollartree: 1.25, groceryoutlet: 1.79 },
    'jiffy-mix': { walmart: 0.67, fredmeyer: 0.79, safeway: 0.89, dollartree: 1.25, groceryoutlet: 0.69 },
    'mac-cheese': { walmart: 0.52, fredmeyer: 0.79, safeway: 0.89, dollartree: 1.25, groceryoutlet: 0.59 },
    'granola-bars': { walmart: 1.96, fredmeyer: 2.29, safeway: 2.79, dollartree: 1.25, groceryoutlet: 1.49 },
    'instant-coffee': { walmart: 4.64, fredmeyer: 4.99, safeway: 5.49, dollartree: 1.25, groceryoutlet: 3.99 },
    'potatoes-5lb': { walmart: 2.47, fredmeyer: 2.79, safeway: 2.99, groceryoutlet: 2.49 },
    'canned-corn': { walmart: 0.76, fredmeyer: 0.89, safeway: 0.99, dollartree: 1.25, groceryoutlet: 0.69 },
    'baby-carrots': { walmart: 1.17, fredmeyer: 1.29, safeway: 1.49, dollartree: 1.25, groceryoutlet: 1.09 },
    'canned-green-beans': { walmart: 0.72, fredmeyer: 0.85, safeway: 0.99, dollartree: 1.25, groceryoutlet: 0.65 },
    'frozen-mixed-veg': { walmart: 1.14, fredmeyer: 1.29, safeway: 1.49, dollartree: 1.25, groceryoutlet: 0.99 },
    'onion-3lb': { walmart: 2.12, fredmeyer: 2.29, safeway: 2.49, groceryoutlet: 1.99 },
    'canned-tomatoes': { walmart: 0.78, fredmeyer: 0.89, safeway: 0.99, dollartree: 1.25, groceryoutlet: 0.75 },
    'bananas': { walmart: 0.50, fredmeyer: 0.59, safeway: 0.69, groceryoutlet: 0.49 },
    'apples-3lb': { walmart: 3.47, fredmeyer: 3.69, safeway: 3.99, groceryoutlet: 2.99 },
    'oranges-3lb': { walmart: 3.57, fredmeyer: 3.79, safeway: 3.99, groceryoutlet: 2.99 },
    'canned-fruit': { walmart: 1.18, fredmeyer: 1.39, safeway: 1.49, dollartree: 1.25, groceryoutlet: 0.99 },
    'raisins': { walmart: 1.98, fredmeyer: 2.19, safeway: 2.39, dollartree: 1.25, groceryoutlet: 1.49 },
    'strawberries': { walmart: 2.82, fredmeyer: 2.99, safeway: 3.29, groceryoutlet: 2.49 },
    'whole-milk': { walmart: 2.92, fredmeyer: 3.19, safeway: 3.49, groceryoutlet: 2.99 },
    'cheese-block': { walmart: 1.87, fredmeyer: 2.19, safeway: 2.49, groceryoutlet: 1.79 },
    'yogurt': { walmart: 2.68, fredmeyer: 2.89, safeway: 3.19, groceryoutlet: 2.49 },
    'powdered-milk': { walmart: 5.97, fredmeyer: 6.49, safeway: 6.99, groceryoutlet: 4.99 },
    'cooking-oil': { walmart: 3.74, fredmeyer: 3.99, safeway: 4.49, dollartree: 1.25, groceryoutlet: 3.49 },
    'butter': { walmart: 3.48, fredmeyer: 3.79, safeway: 3.99, groceryoutlet: 2.99 },
    'avocado': { walmart: 0.55, fredmeyer: 0.79, safeway: 0.99, groceryoutlet: 0.50 },
    'trail-mix': { walmart: 2.98, fredmeyer: 3.49, safeway: 3.99, dollartree: 1.25, groceryoutlet: 2.49 },
};

const STORES = {
    walmart: 'Walmart',
    fredmeyer: 'Fred Meyer',
    safeway: 'Safeway',
    dollartree: 'Dollar Tree',
    groceryoutlet: 'Grocery Outlet',
};

// USDA MyPlate groups, as the Tools source carried them; dailyMin is grams a day (dairy, as millilitres of milk,
// which is close enough per gram to treat the same).
const GROUPS = {
    protein: { name: 'Protein', dailyMin: 50, examples: 'Chicken, eggs, beans, peanut butter, canned tuna' },
    grains: { name: 'Grains', dailyMin: 170, examples: 'Rice, bread, pasta, oatmeal, tortillas' },
    vegetables: { name: 'Vegetables', dailyMin: 300, examples: 'Carrots, potatoes, canned corn, frozen mixed vegetables' },
    fruits: { name: 'Fruits', dailyMin: 200, examples: 'Bananas, apples, oranges, canned fruit' },
    dairy: { name: 'Dairy', dailyMin: 720, examples: 'Milk, cheese, yogurt' },
    fats: { name: 'Fats & Oils', dailyMin: 25, examples: 'Cooking oil, butter, peanut butter, avocado' },
};

// Which meals an item suits (ported); used to lay a plan out over breakfast, lunch, dinner and snacks.
const MEALS = {
    'eggs-dozen': 'breakfast', 'chicken-breast': 'lunch,dinner', 'canned-tuna': 'lunch,snack',
    'peanut-butter': 'breakfast,snack', 'dried-beans': 'lunch,dinner', 'canned-beans': 'lunch,dinner',
    'hot-dogs': 'lunch,dinner', 'ground-beef': 'dinner', 'ramen-12pk': 'lunch,dinner',
    'white-rice': 'lunch,dinner', 'spaghetti': 'dinner', 'bread-white': 'breakfast,lunch,snack',
    'oatmeal': 'breakfast', 'tortillas': 'lunch,dinner', 'jiffy-mix': 'breakfast,snack',
    'potatoes-5lb': 'lunch,dinner', 'canned-corn': 'lunch,dinner', 'baby-carrots': 'lunch,snack',
    'canned-green-beans': 'lunch,dinner', 'frozen-mixed-veg': 'dinner', 'onion-3lb': 'lunch,dinner',
    'canned-tomatoes': 'lunch,dinner', 'bananas': 'breakfast,snack', 'apples-3lb': 'breakfast,snack',
    'oranges-3lb': 'breakfast,snack', 'canned-fruit': 'breakfast,snack', 'raisins': 'breakfast,snack',
    'strawberries': 'breakfast,snack', 'whole-milk': 'breakfast', 'cheese-block': 'lunch,snack',
    'yogurt': 'breakfast,snack', 'powdered-milk': 'breakfast', 'cooking-oil': 'lunch,dinner',
    'butter': 'breakfast,lunch,dinner', 'avocado': 'lunch,snack', 'mac-cheese': 'lunch,dinner',
    'canned-soup': 'lunch,dinner', 'canned-chili': 'lunch,dinner', 'trail-mix': 'snack',
    'granola-bars': 'breakfast,snack', 'sardines': 'lunch,snack', 'instant-coffee': 'breakfast',
};

// A pack size stated in an item's own name → grams. Volume (fl oz) is deliberately absent: converting it would mean
// assuming a density. A dozen eggs and a 12-pack of ramen state no weight, so they get no per-100 g figure.
const UNIT_G = { oz: 28.3495, lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592, g: 1, gram: 1, grams: 1, kg: 1000, kilogram: 1000, gallon: 3785.41, gal: 3785.41, l: 1000, litre: 1000, liter: 1000, ml: 1 };
function packGrams(name) {
    const str = String(name);
    const m = str.match(/(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|oz|lbs?|pounds?|kgs?|kilograms?|grams?|kg|g|gallons?|gal|l|litres?|liters?|ml)\b/i);
    // "Chicken Breasts (per lb)" and "Bananas (per lb)" state a unit with no number: that is one of it.
    const bare = m ? null : str.match(/\bper\s+(fl\.?\s*oz|oz|lbs?|pounds?|kgs?|kg|g|gallons?|gal|litres?|liters?|l|ml)\b/i);
    const unitText = m ? m[2] : bare && bare[1];
    if (!unitText) return null;
    const unit = unitText.toLowerCase().replace(/[.\s]/g, '');
    if (/^(floz|foz)$/.test(unit)) return null;   // a volume: no density known, so no grams
    const g = UNIT_G[unit];
    return g ? (m ? Number(m[1]) : 1) * g : null;
}

const round = (n, d = 0) => { const p = 10 ** d; return Math.round((Number(n) + Number.EPSILON) * p) / p; };
const nullPrice = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function band(min) {
    if (min <= 2) return 'low';
    if (min <= 4) return 'medium';
    if (min <= 8) return 'higher';
    return 'high';
}
const BAND_LABEL = { low: 'under $2 a pack', medium: '$2–4 a pack', higher: '$4–8 a pack', high: 'over $8 a pack' };

/** One row plus its prices → what the pages, the planner and the pantry match read. */
function build([id, name, group, servings, servingSize, kcal, proteinG, carbsG, fatG, fiberG, shelfStable, tags]) {
    const prices = PRICES[id] || {};
    const known = Object.entries(prices).map(([store, price]) => ({ store, store_name: STORES[store], price: nullPrice(price) }))
        .filter((p) => p.price != null).sort((a, b) => a.price - b.price || (a.store < b.store ? -1 : 1));
    const price = known.length ? known[0].price : null;
    const priceMax = known.length ? known[known.length - 1].price : null;
    const grams = packGrams(name);
    const servingGrams = grams && servings ? round(grams / servings, 1) : null;
    const per100 = servingGrams ? {
        kcal: round(kcal * 100 / servingGrams),
        protein_g: round(proteinG * 100 / servingGrams, 1),
        carbs_g: round(carbsG * 100 / servingGrams, 1),
        fat_g: round(fatG * 100 / servingGrams, 1),
        fiber_g: round(fiberG * 100 / servingGrams, 1),
    } : null;
    return {
        id, slug: id, name, group,
        group_name: GROUPS[group].name,
        servings, serving_size: servingSize,
        nutrition: { kcal, protein_g: proteinG, carbs_g: carbsG, fat_g: fatG, fiber_g: fiberG },
        serving_grams: servingGrams,
        pack_grams: grams ? round(grams) : null,
        per_100g: per100,
        package_kcal: round(kcal * servings),
        package_protein_g: round(proteinG * servings),
        price, price_max: priceMax,
        cheapest_store: known.length ? known[0].store : null,
        cheapest_store_name: known.length ? known[0].store_name : null,
        prices: known,
        band: price == null ? null : band(price),
        band_label: price == null ? null : BAND_LABEL[band(price)],
        cost_per_serving: price == null ? null : round(price / servings, 2),
        cost_per_gram: price == null || !grams ? null : round(price / grams, 4),
        kcal_per_dollar: price == null ? null : round(kcal * servings / price),
        shelf_stable: !!shelfStable,
        meals: (MEALS[id] || 'lunch,dinner').split(','),
        tags: String(tags).split(','),
    };
}

const FOODS = ROWS.map(build).sort((a, b) => (a.group === b.group ? (a.name < b.name ? -1 : 1) : (Object.keys(GROUPS).indexOf(a.group) - Object.keys(GROUPS).indexOf(b.group))));
const BY_SLUG = new Map(FOODS.map((f) => [f.slug, f]));

const listFoods = ({ group = null, q = null } = {}) => {
    let foods = FOODS;
    if (group && GROUPS[group]) foods = foods.filter((f) => f.group === group);
    if (q) {
        const needle = String(q).toLowerCase();
        foods = foods.filter((f) => f.name.toLowerCase().includes(needle) || f.tags.some((t) => t.includes(needle)));
    }
    return foods;
};
const getFood = (slug) => BY_SLUG.get(String(slug)) || null;

/** The list as the API hands it out (no store-by-store table: that is the food page's job). */
const toWire = (f) => ({
    slug: f.slug, name: f.name, group: f.group, group_name: f.group_name,
    servings: f.servings, serving_size: f.serving_size, serving_grams: f.serving_grams,
    nutrition_per_serving: f.nutrition, nutrition_per_100g: f.per_100g,
    price: f.price, price_max: f.price_max, price_band: f.band, price_band_label: f.band_label,
    cheapest_store: f.cheapest_store, cost_per_serving: f.cost_per_serving, kcal_per_dollar: f.kcal_per_dollar,
    shelf_stable: f.shelf_stable, tags: f.tags, meals: f.meals, url: `/foods/${f.slug}`,
});

module.exports = { FOODS, GROUPS, STORES, MEALS, BY_SLUG, listFoods, getFood, toWire, band, BAND_LABEL, packGrams, round };
