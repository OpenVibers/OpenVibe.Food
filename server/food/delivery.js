'use strict';

/**
 * Delivery and meal kits, compared the way the owner allowed (2026-09-28, Q8: official links, a browser extension in
 * the person's own sessions, licensed data; never scraping): one search opens every delivery app's own search for the
 * dish or restaurant, and the meal-kit services are side by side with their plan pages. Prices, fees and the person's
 * address stay on each app (their own logged-in session); Food never fetches them.
 *
 * Every URL form here was opened in a real headless Chromium on 2026-10-15 (Food's tools note): DoorDash, Grubhub,
 * Seamless and Caviar search pages answer with results, Uber Eats' search is its real search (its bot check stops
 * headless browsers, not people), Instacart's search answers for groceries. Left out: Postmates (now Uber Eats), Gopuff
 * (refuses automated visits and has no stable search link), Slice and ezCater (no search link that keeps the query).
 *
 *   APPS        the delivery apps: id, name, host, what they are best for, search(q) → URL
 *   KITS        meal-kit and prepared-meal services: id, name, host, tier, what they are, plans URL
 *   linksFor(q) → [{ id, name, url, best }] for a non-empty query (at most 120 characters)
 */

const enc = encodeURIComponent;

const APPS = [
    { id: 'doordash', name: 'DoorDash', host: 'doordash.com', best: 'The most restaurants in most US cities, plus groceries and convenience stores.',
        search: (q) => `https://www.doordash.com/search/store/${enc(q)}/` },
    { id: 'ubereats', name: 'Uber Eats', host: 'ubereats.com', best: 'Restaurants and groceries, with Uber One members\' free delivery. Postmates is part of it now.',
        search: (q) => `https://www.ubereats.com/search?q=${enc(q)}` },
    { id: 'grubhub', name: 'Grubhub', host: 'grubhub.com', best: 'Restaurants, with Grubhub+ free delivery (often through Amazon Prime).',
        search: (q) => `https://www.grubhub.com/search?queryText=${enc(q)}` },
    { id: 'seamless', name: 'Seamless', host: 'seamless.com', best: 'Grubhub\'s sister app, strongest in New York City.',
        search: (q) => `https://www.seamless.com/search?queryText=${enc(q)}` },
    { id: 'caviar', name: 'Caviar', host: 'trycaviar.com', best: 'DoorDash\'s pick of local and higher-end restaurants.',
        search: (q) => `https://www.trycaviar.com/search/store/${enc(q)}/` },
    { id: 'instacart', name: 'Instacart', host: 'instacart.com', best: 'Groceries from the stores near you, delivered the same day.',
        search: (q) => `https://www.instacart.com/store/s?k=${enc(q)}` },
];

const KITS = [
    { id: 'everyplate', name: 'EveryPlate', host: 'everyplate.com', tier: 'budget', what: 'Simple recipes with fewer ingredients, among the cheapest kits.', plans: 'https://www.everyplate.com/plans' },
    { id: 'dinnerly', name: 'Dinnerly', host: 'dinnerly.com', tier: 'budget', what: 'Short recipes and a low price per serving, especially on bigger boxes.', plans: 'https://dinnerly.com/' },
    { id: 'hellofresh', name: 'HelloFresh', host: 'hellofresh.com', tier: 'mid', what: 'The biggest menu, with family, quick and calorie-smart recipes.', plans: 'https://www.hellofresh.com/plans' },
    { id: 'homechef', name: 'Home Chef', host: 'homechef.com', tier: 'mid', what: 'Kits plus oven-ready and fast-prep meals; meals can be customized.', plans: 'https://www.homechef.com/' },
    { id: 'marleyspoon', name: 'Marley Spoon', host: 'marleyspoon.com', tier: 'mid', what: 'Chef-designed recipes and a large weekly menu.', plans: 'https://marleyspoon.com/' },
    { id: 'blueapron', name: 'Blue Apron', host: 'blueapron.com', tier: 'mid', what: 'Kits and ready-to-eat meals, bought per meal without a subscription.', plans: 'https://www.blueapron.com/menu' },
    { id: 'hungryroot', name: 'Hungryroot', host: 'hungryroot.com', tier: 'mid', what: 'Groceries and simple recipes picked for you each week.', plans: 'https://www.hungryroot.com/' },
    { id: 'greenchef', name: 'Green Chef', host: 'greenchef.com', tier: 'premium', what: 'Organic ingredients; keto, paleo, vegan and gluten-free plans.', plans: 'https://www.greenchef.com/plans' },
    { id: 'purplecarrot', name: 'Purple Carrot', host: 'purplecarrot.com', tier: 'premium', what: 'Plant-based kits and prepared meals.', plans: 'https://www.purplecarrot.com/shop' },
    { id: 'factor', name: 'Factor', host: 'factor75.com', tier: 'premium', what: 'Fully cooked meals to heat up, no cooking (priced per meal).', plans: 'https://www.factor75.com/plans' },
];
const TIER_TEXT = { budget: 'Budget', mid: 'Mid-range', premium: 'Premium' };

const cleanQuery = (q) => String(q == null ? '' : q).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

function linksFor(q) {
    const query = cleanQuery(q);
    if (!query) return [];
    return APPS.map((a) => ({ id: a.id, name: a.name, url: a.search(query), best: a.best }));
}

module.exports = { APPS, KITS, TIER_TEXT, cleanQuery, linksFor };
