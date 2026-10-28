'use strict';

/**
 * Food boxes: every meal kit, ready-meal service and food box (produce, meat and fish, snacks, coffee, baby, pets),
 * weekly or monthly, side by side (the owner, 2026-10-28: "an aggregated list of all the food, weekly, monthly food
 * boxes… like EveryPlate… connected with the promotions and the review sites… and an API and SDK").
 *
 * How it is filled, the permitted way (2026-09-28, Q8: official links, a person's own session, licensed data; never
 * scraping): each fact below was read on the service's own public page, by a person, and carries that page and the
 * day it was read. Nothing here is fetched from the services. A fact nobody checked is null and the page says "not
 * checked yet" with the link to their site; a price that changes is the service's to show, and OpenVibe.Watch can
 * tell you when it does. Codes come from OpenVibe.Coupons and scores from OpenVibe.Reviews at request time
 * (./box-links.js); a box never claims either.
 *
 *   KINDS                                 the kinds, in order, with their names
 *   BOXES                                 the boxes (see the shape below)
 *   list({ kind, diet, q })               → boxes, in the list's order (kind first, then as listed)
 *   get(slug)                             → one box or null
 *   cost(box, { people, meals, weeks })   → what the stated price per serving or meal comes to, or null when the box
 *                                           has no stated per-serving price (or the plan size is not one it states)
 *   toWire(box)                           → the API's shape (`food.box@1`-like: every fact with its source)
 *
 * A box: { slug, name, kind, host, url, what, cadence[], people[], meals[], diets[], price, shipping, ships_to,
 *          cancel, notes[], sources[], checked }
 *   price     { from, to, unit: 'serving'|'meal'|'box'|'month'|'delivery'|'day'|'membership', text } or null
 *   shipping  { amount, to, text } or null (amount 0: free)
 */

const CHECKED = '2026-10-28';

const KINDS = [
    { kind: 'cook', name: 'Meal kits', short: 'Kit', what: 'Recipes and the ingredients to cook them' },
    { kind: 'ready', name: 'Ready meals', short: 'Ready', what: 'Cooked meals to heat up' },
    { kind: 'produce', name: 'Produce and groceries', short: 'Produce', what: 'Fruit, vegetables and pantry food' },
    { kind: 'meat', name: 'Meat and fish', short: 'Meat', what: 'Boxes of meat and seafood' },
    { kind: 'snacks', name: 'Snack boxes', short: 'Snacks', what: 'A box of snacks each month' },
    { kind: 'coffee', name: 'Coffee', short: 'Coffee', what: 'Coffee from roasters, delivered' },
    { kind: 'baby', name: 'Baby and kids', short: 'Baby', what: 'Food for babies and children' },
    { kind: 'pets', name: 'Pets', short: 'Pets', what: 'Fresh food for dogs' },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.kind, k]));

const DIETS = {
    vegetarian: 'Vegetarian', vegan: 'Vegan', pescatarian: 'Pescatarian', keto: 'Keto', paleo: 'Paleo', 'gluten-free': 'Gluten-free',
    'calorie-smart': 'Calorie-smart', 'high-protein': 'High-protein', family: 'Family', quick: 'Quick', 'plant-based': 'Plant-based',
};

const box = (o) => ({ cadence: [], people: [], meals: [], diets: [], price: null, shipping: null, ships_to: null, cancel: null, notes: [], sources: [], checked: CHECKED, ...o });

const BOXES = [
    // ── Meal kits ──
    box({ slug: 'everyplate', name: 'EveryPlate', kind: 'cook', host: 'everyplate.com', url: 'https://www.everyplate.com/', what: 'Simple recipes with fewer ingredients; among the cheapest kits.',
        cadence: ['weekly'], people: [2, 4, 6], meals: [3, 4, 5], diets: ['vegetarian', 'quick', 'calorie-smart', 'family'],
        price: { from: 5.99, to: null, unit: 'serving', text: 'Plans from $5.99 a serving' }, shipping: { amount: 10.99, text: '$10.99 a box' },
        ships_to: 'Most of the continental US', cancel: 'Skip or cancel online',
        sources: ['https://www.everyplate.com/', 'https://www.everyplate.com/about/menus-and-plans'] }),
    box({ slug: 'hellofresh', name: 'HelloFresh', kind: 'cook', host: 'hellofresh.com', url: 'https://www.hellofresh.com/', what: 'The biggest menu, with family, quick and calorie-smart recipes.',
        cadence: ['weekly'], people: [2, 4], meals: [3, 4, 5], diets: ['vegetarian', 'pescatarian', 'calorie-smart', 'gluten-free', 'keto', 'family'],
        ships_to: 'The whole US except Alaska and Hawaii', cancel: 'No commitment: pause or cancel by 11:59 pm PT five days before the next delivery',
        notes: ['5 recipes a week are for the two-person plan only.', 'Gluten-free and keto are options within the plans, not plans of their own.'],
        sources: ['https://www.hellofresh.com/', 'https://www.hellofresh.com/eat/kid-friendly-meal-delivery', 'https://www.hellofresh.com/eat/healthy-meal-delivery'] }),
    box({ slug: 'home-chef', name: 'Home Chef', kind: 'cook', host: 'homechef.com', url: 'https://www.homechef.com/', what: 'Kits plus oven-ready and fast-prep meals; meals can be customized.',
        cadence: ['weekly'], price: { from: 6.99, to: null, unit: 'serving', text: 'Meals from $6.99 a serving' },
        sources: ['https://cook.homechef.com/fresh-start'] }),
    box({ slug: 'green-chef', name: 'Green Chef', kind: 'cook', host: 'greenchef.com', url: 'https://www.greenchef.com/', what: 'Organic produce and premium proteins; keto and plant-powered plans.',
        cadence: ['weekly'], people: [2, 4, 6], meals: [3, 4], diets: ['keto', 'gluten-free', 'vegan', 'vegetarian'],
        cancel: 'Skip or cancel before the weekly cutoff',
        notes: ['Every meal is made in a kitchen that also handles milk, eggs, wheat, soy and nuts.'],
        sources: ['https://www.greenchef.com/', 'https://www.greenchef.com/eat/meal-plan-delivery-service'] }),
    box({ slug: 'marley-spoon', name: 'Marley Spoon', kind: 'cook', host: 'marleyspoon.com', url: 'https://marleyspoon.com/', what: 'Chef-designed recipes and a large weekly menu.',
        cadence: ['weekly'], price: { from: 12.99, to: 13.49, unit: 'serving', text: 'Its plans page: $13.49 a serving for 3 meals for 2 people; its help centre: $12.99 a serving' },
        shipping: { amount: 11.99, to: 12.99, text: '$12.99 on its plans page, $11.99 in its help centre' },
        notes: ['Its own pages disagree on the price; check the plans page for yours.'],
        sources: ['https://marleyspoon.com/select-plan', 'https://support.marleyspoon.com/hc/en-us/articles/360001958975-What-boxes-and-plans-do-you-offer'] }),
    box({ slug: 'dinnerly', name: 'Dinnerly', kind: 'cook', host: 'dinnerly.com', url: 'https://dinnerly.com/', what: 'Short recipes and a low price per serving, especially on bigger boxes.' }),
    box({ slug: 'blue-apron', name: 'Blue Apron', kind: 'cook', host: 'blueapron.com', url: 'https://www.blueapron.com/', what: 'Kits and ready-to-eat meals, bought per meal without a subscription.' }),
    box({ slug: 'hungryroot', name: 'Hungryroot', kind: 'cook', host: 'hungryroot.com', url: 'https://www.hungryroot.com/', what: 'Groceries and simple recipes picked for you each week.' }),
    box({ slug: 'purple-carrot', name: 'Purple Carrot', kind: 'cook', host: 'purplecarrot.com', url: 'https://www.purplecarrot.com/', what: 'Plant-based kits and prepared meals.' }),
    box({ slug: 'gobble', name: 'Gobble', kind: 'cook', host: 'gobble.com', url: 'https://www.gobble.com/', what: 'Dinner kits with the ingredients already prepped, for quick cooking.' }),
    // ── Ready meals ──
    box({ slug: 'factor', name: 'Factor', kind: 'ready', host: 'factor75.com', url: 'https://www.factor75.com/', what: 'Fully cooked meals to heat up, priced per meal.' }),
    box({ slug: 'cookunity', name: 'CookUnity', kind: 'ready', host: 'cookunity.com', url: 'https://www.cookunity.com/', what: 'Meals made by chefs, from many cuisines.',
        cadence: ['weekly'], meals: [4, 6, 8, 10, 12, 16], price: { from: 10.39, to: 12.69, unit: 'meal', text: 'About $10.39 to $12.69 a meal, by plan size' },
        shipping: { amount: 9.99, to: 11.99, text: '$9.99 or $11.99 by ZIP code; waived with its UnityPass membership' }, cancel: 'Skip, pause or cancel',
        sources: ['https://www.cookunity.com/lp/cookunity-cost', 'https://www.cookunity.com/'] }),
    box({ slug: 'tovala', name: 'Tovala', kind: 'ready', host: 'tovala.com', url: 'https://www.tovala.com/', what: 'Meals that take about a minute of prep.',
        cadence: ['weekly'], meals: [4, 6, 8, 10, 12, 16], diets: ['high-protein', 'vegetarian'],
        price: { from: 8.99, to: 13.99, unit: 'serving', text: 'Single meals from $13.99; two-packs and family meals about $8.99 a serving' },
        shipping: { amount: 10.99, text: '$10.99 a delivery' }, cancel: 'Skip a week, pause or cancel',
        sources: ['https://www.tovala.com/'] }),
    box({ slug: 'trifecta', name: 'Trifecta', kind: 'ready', host: 'trifectanutrition.com', url: 'https://www.trifectanutrition.com/', what: 'Diet plans of cooked meals: keto, paleo, vegan, vegetarian.',
        cadence: ['weekly'], diets: ['keto', 'paleo', 'vegan', 'vegetarian'], price: { from: 112, to: null, unit: 'delivery', text: 'Meal plans from $112 a delivery; build your own from $99' },
        shipping: { amount: 12.99, text: '$12.99 a delivery (not Alaska or Hawaii)' },
        sources: ['https://www.trifectanutrition.com/ask-us-anything/how-much-does-trifecta-cost', 'https://www.trifectanutrition.com/meal-plan-delivery'] }),
    box({ slug: 'daily-harvest', name: 'Daily Harvest', kind: 'ready', host: 'daily-harvest.com', url: 'https://daily-harvest.com/', what: 'Frozen smoothies, bowls and soups.' }),
    box({ slug: 'mosaic-foods', name: 'Mosaic Foods', kind: 'ready', host: 'mosaicfoods.com', url: 'https://mosaicfoods.com/', what: 'Frozen meals, mostly plant-based.' }),
    // ── Produce and groceries ──
    box({ slug: 'misfits-market', name: 'Misfits Market', kind: 'produce', host: 'misfitsmarket.com', url: 'https://www.misfitsmarket.com/', what: 'Organic and odd-looking produce plus groceries.',
        cadence: ['weekly', 'monthly', 'once'], price: { from: 30, to: null, unit: 'box', text: 'A $30 order minimum (it can depend on where you live); membership is free' },
        shipping: { amount: 6.99, text: 'A flat rate by ZIP code from $6.99; free over a threshold in some areas' }, cancel: 'Skip or cancel for free, anytime',
        notes: ['Each week you get a shopping window of 3 to 6 days.'],
        sources: ['https://www.misfitsmarket.com/how-it-works'] }),
    box({ slug: 'farm-fresh-to-you', name: 'Farm Fresh To You', kind: 'produce', host: 'farmfreshtoyou.com', url: 'https://www.farmfreshtoyou.com/', what: 'Organic produce boxes from farms, with over 90 things to pick from each week.',
        cadence: ['weekly'], price: { from: 29, to: null, unit: 'box', text: 'Boxes from $29, no membership fee' }, shipping: { amount: 0, text: 'Delivery included' }, cancel: 'Manage your schedule online',
        sources: ['https://www.farmfreshtoyou.com/offers', 'https://www.farmfreshtoyou.com/signup'] }),
    box({ slug: 'thrive-market', name: 'Thrive Market', kind: 'produce', host: 'thrivemarket.com', url: 'https://thrivemarket.com/', what: 'An online pantry store: organic and healthy groceries for members.',
        price: { from: 12, to: null, unit: 'month', text: 'Membership: $12 a month, or $60 a year' }, sources: ['https://thrivemarket.com/'] }),
    box({ slug: 'weee', name: 'Weee!', kind: 'produce', host: 'sayweee.com', url: 'https://www.sayweee.com/', what: 'Asian and Hispanic groceries delivered.' }),
    // ── Meat and fish ──
    box({ slug: 'butcherbox', name: 'ButcherBox', kind: 'meat', host: 'butcherbox.com', url: 'https://www.butcherbox.com/', what: 'Grass-fed beef, chicken, pork and seafood.',
        cadence: ['every 2 weeks', 'every 4 weeks', 'every 6 weeks', 'every 8 weeks'],
        price: { from: 179, to: 319, unit: 'box', text: 'Medium $179 (6 proteins), Large $249 (9), Extra-Large $319 (12)' }, shipping: { amount: 0, text: 'Free' },
        cancel: 'Pause, change or cancel anytime', notes: ['Its pricing page has shown other figures; check the current price.'],
        sources: ['https://www.butcherbox.com/pages/faqs', 'https://www.butcherbox.com/pages/get-started'] }),
    box({ slug: 'porter-road', name: 'Porter Road', kind: 'meat', host: 'porterroad.com', url: 'https://porterroad.com/', what: 'Pasture-raised meat from a butcher shop.',
        cadence: ['every 2 weeks', 'every 4 weeks', 'every 8 weeks'], shipping: { amount: 0, text: 'Free' }, sources: ['https://porterroad.com/pages/subscriptions'] }),
    box({ slug: 'wild-alaskan', name: 'Wild Alaskan Company', kind: 'meat', host: 'wildalaskancompany.com', url: 'https://wildalaskancompany.com/', what: 'Wild-caught Alaskan seafood, frozen.',
        cadence: ['monthly'], cancel: 'Cancel in your account; an email comes before each charge',
        sources: ['https://wildalaskancompany.com/how-it-works', 'https://wildalaskancompany.com/pricing'] }),
    box({ slug: 'crowd-cow', name: 'Crowd Cow', kind: 'meat', host: 'crowdcow.com', url: 'https://www.crowdcow.com/', what: 'Meat and seafood from named farms.' }),
    box({ slug: 'good-chop', name: 'Good Chop', kind: 'meat', host: 'goodchop.com', url: 'https://www.goodchop.com/', what: 'Boxes of meat and seafood.' }),
    // ── Snack boxes ──
    box({ slug: 'bokksu', name: 'Bokksu', kind: 'snacks', host: 'bokksu.com', url: 'https://bokksu.com/', what: '20 to 22 Japanese snacks and a tea, around a theme each month.',
        cadence: ['monthly'], price: { from: 32.99, to: 39.99, unit: 'month', text: '$39.99 a month, down to $32.99 on the 12-month plan' }, shipping: { amount: null, text: 'Added at checkout' },
        notes: ['Longer plans are paid up front.'], sources: ['https://bokksu.com/products/classic-bokksu'] }),
    box({ slug: 'snackcrate', name: 'SnackCrate', kind: 'snacks', host: 'snackcrate.com', url: 'https://www.snackcrate.com/', what: '10 to 20 snacks from a different country each month.',
        cadence: ['monthly'], price: { from: 20, to: 50, unit: 'month', text: '$20 to $50 a month' }, cancel: 'Cancel anytime in your account',
        notes: ['The page these figures come from may be old.'], sources: ['https://www.snackcrate.com/'] }),
    box({ slug: 'universal-yums', name: 'Universal Yums', kind: 'snacks', host: 'universalyums.com', url: 'https://www.universalyums.com/', what: 'Snacks from a different country each month.' }),
    box({ slug: 'sakuraco', name: 'Sakuraco', kind: 'snacks', host: 'sakuraco.com', url: 'https://sakuraco.com/', what: 'Traditional Japanese snacks and tea, monthly.' }),
    // ── Coffee ──
    box({ slug: 'bean-box', name: 'Bean Box', kind: 'coffee', host: 'beanbox.com', url: 'https://beanbox.com/', what: 'Coffee from Seattle-area and other independent roasters.',
        price: { from: 19.5, to: 40, unit: 'delivery', text: 'One 12 oz bag $19.50 to $21.50 a delivery; two bags $36 to $40' },
        cancel: 'Pause, skip or cancel by 1 pm PT the Wednesday before a shipment', sources: ['https://beanbox.com/'] }),
    box({ slug: 'trade', name: 'Trade Coffee', kind: 'coffee', host: 'drinktrade.com', url: 'https://www.drinktrade.com/', what: 'Coffee from independent roasters, matched to your taste.' }),
    box({ slug: 'atlas-coffee-club', name: 'Atlas Coffee Club', kind: 'coffee', host: 'atlascoffeeclub.com', url: 'https://atlascoffeeclub.com/', what: 'Single-origin coffee from a different country each box.' }),
    // ── Baby and kids ──
    box({ slug: 'little-spoon', name: 'Little Spoon', kind: 'baby', host: 'littlespoon.com', url: 'https://www.littlespoon.com/', what: 'Baby food, toddler and kids\' meals, delivered across the US.',
        cadence: ['every 2 weeks'], price: { from: null, to: 5, unit: 'meal', text: 'Kids\' plates under $5 a meal' }, ships_to: 'Across the US',
        cancel: 'Change the schedule in your account by Saturday 5 pm ET; the first order can be moved up to 4 weeks but not cancelled',
        sources: ['https://www.littlespoon.com/'] }),
    box({ slug: 'yumi', name: 'Yumi', kind: 'baby', host: 'helloyumi.com', url: 'https://helloyumi.com/', what: 'Baby and toddler food and snacks.' }),
    box({ slug: 'cerebelly', name: 'Cerebelly', kind: 'baby', host: 'cerebelly.com', url: 'https://cerebelly.com/', what: 'Baby food pouches and bars.' }),
    // ── Pets ──
    box({ slug: 'the-farmers-dog', name: 'The Farmer\'s Dog', kind: 'pets', host: 'thefarmersdog.com', url: 'https://www.thefarmersdog.com/', what: 'Fresh dog food portioned for your dog.',
        cadence: ['every 1 week to 3 months'], price: { from: 2, to: null, unit: 'day', text: 'From about $2 a day; your dog sets the price' }, shipping: { amount: 0, text: 'Free' },
        cancel: 'Pause, cancel or come back anytime', sources: ['https://www.thefarmersdog.com/faq'] }),
    box({ slug: 'nom-nom', name: 'Nom Nom', kind: 'pets', host: 'nomnomnow.com', url: 'https://www.nomnomnow.com/', what: 'Fresh dog food in portions, on a schedule you set.',
        price: { from: 1.6, to: 4.6, unit: 'meal', text: '$1.60 to $2.60 a meal for small dogs, to $4.60 for large ones' }, cancel: 'Cancel before your next delivery',
        sources: ['https://www.nomnomnow.com/how-it-works/', 'https://www.nomnomnow.com/faq'] }),
    box({ slug: 'ollie', name: 'Ollie', kind: 'pets', host: 'myollie.com', url: 'https://www.myollie.com/', what: 'Fresh and baked dog food made for your dog.' }),
];

const BY_SLUG = new Map(BOXES.map((b) => [b.slug, b]));
const UNIT = { serving: 'a serving', meal: 'a meal', box: 'a box', month: 'a month', delivery: 'a delivery', day: 'a day', membership: '' };

function list({ kind = null, diet = null, q = null } = {}) {
    const needle = q ? String(q).toLowerCase().slice(0, 60) : null;
    return BOXES.filter((b) => (!kind || b.kind === kind) && (!diet || b.diets.includes(diet))
        && (!needle || b.name.toLowerCase().includes(needle) || b.host.includes(needle) || b.what.toLowerCase().includes(needle)));
}
const get = (slug) => BY_SLUG.get(String(slug || '')) || null;
const kindOf = (k) => KIND[k] || null;

/** A price in a line: "from $5.99 a serving", "$10.39–$12.69 a meal", "under $5 a meal". */
function priceLine(p) {
    if (!p) return null;
    const $ = (n) => `$${Number(n).toFixed(Number.isInteger(n) ? 0 : 2)}`;
    const unit = UNIT[p.unit] ? ` ${UNIT[p.unit]}` : '';
    if (p.from != null && p.to != null && p.to !== p.from) return `${$(p.from)}–${$(p.to)}${unit}`;
    if (p.from != null) return `from ${$(p.from)}${unit}`;
    if (p.to != null) return `under ${$(p.to)}${unit}`;
    return null;
}

/**
 * What a box's stated price comes to for a plan: people × meals a week (servings) at its stated price per serving or
 * meal, for some weeks, plus its stated shipping a week. Only for a per-serving or per-meal price, and only for a plan
 * size the box states (or any when it states none). Never a price of its own: a range stays a range.
 */
function cost(b, { people = 2, meals = 3, weeks = 1 } = {}) {
    if (!b || !b.price || !['serving', 'meal'].includes(b.price.unit)) return null;
    const p = Math.round(Number(people)), m = Math.round(Number(meals)), w = Math.round(Number(weeks));
    if (!(p >= 1 && p <= 12 && m >= 1 && m <= 21 && w >= 1 && w <= 52)) return null;
    if (b.people.length && !b.people.includes(p)) return null;
    if (b.meals.length && !b.meals.includes(m)) return null;
    const servings = b.price.unit === 'meal' && b.kind === 'ready' ? m : p * m;
    const lo = b.price.from != null ? b.price.from : b.price.to;
    const hi = b.price.to != null ? b.price.to : b.price.from;
    const ship = b.shipping && b.shipping.amount != null ? b.shipping.amount : null;
    const shipHi = b.shipping && b.shipping.to != null ? b.shipping.to : ship;
    const r2 = (n) => Math.round(n * 100) / 100;
    return {
        servings, weeks: w,
        food: { from: r2(lo * servings * w), to: r2(hi * servings * w) },
        shipping: ship == null ? null : { from: r2(ship * w), to: r2(shipHi * w) },
        total: ship == null ? null : { from: r2((lo * servings + ship) * w), to: r2((hi * servings + shipHi) * w) },
        basis: `${b.price.text} (${b.name}'s own page, read ${b.checked})`,
    };
}

function toWire(b) {
    return {
        slug: b.slug, name: b.name, kind: b.kind, kind_name: KIND[b.kind].name, url: b.url, host: b.host, what: b.what,
        cadence: b.cadence, people: b.people, meals_per_week: b.meals, diets: b.diets,
        price: b.price ? { ...b.price, line: priceLine(b.price) } : null, shipping: b.shipping, ships_to: b.ships_to, cancel: b.cancel, notes: b.notes,
        sources: b.sources, checked: b.sources.length ? b.checked : null,
        links: { page: `https://openvibe.food/boxes/${b.slug}`, coupons: `https://openvibe.coupons/?q=${encodeURIComponent(b.host)}`, reviews: `https://openvibe.reviews/search?q=${encodeURIComponent(b.name)}` },
    };
}

module.exports = { KINDS, KIND, DIETS, BOXES, list, get, kindOf, cost, priceLine, toWire, CHECKED };
