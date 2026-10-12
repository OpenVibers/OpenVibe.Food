'use strict';

/**
 * A small set of basic recipes, written for this service in plain words (no copied recipe text, nothing
 * copyrighted), each naming only items from the food list (server/food/foods.js). They exist so the pantry can answer
 * "what can I make?" without an AI call: server/food/pantry-match.js matches a person's cupboard against them.
 *
 * These are deliberately simple combinations and the pantry page labels them as such. They are not dietary advice.
 */

const { FOODS, getFood, round } = require('./foods');

const RECIPES = [
    {
        slug: 'beans-and-rice', name: 'Beans and rice', serves: 2, minutes: 25,
        ingredients: ['white-rice', 'canned-beans', 'onion-3lb'], optional: ['cooking-oil', 'canned-tomatoes', 'cheese-block'],
        steps: [
            'Cook the rice as the packet says.',
            'Chop the onion and soften it in a little oil in a pan.',
            'Add the beans (and the tomatoes, if you have them) and heat through.',
            'Spoon the beans over the rice. Cheese on top if you like.',
        ],
    },
    {
        slug: 'tuna-pasta', name: 'Tuna pasta', serves: 2, minutes: 20,
        ingredients: ['spaghetti', 'canned-tuna', 'canned-tomatoes'], optional: ['cooking-oil', 'onion-3lb'],
        steps: [
            'Boil the spaghetti until tender, then drain it.',
            'Warm the tomatoes in the same pan with a little oil and, if you have one, a chopped onion.',
            'Stir in the drained tuna, then the spaghetti.',
        ],
    },
    {
        slug: 'tuna-sandwich', name: 'Tuna sandwich', serves: 1, minutes: 5,
        ingredients: ['bread-white', 'canned-tuna'], optional: ['cooking-oil', 'onion-3lb', 'avocado'],
        steps: ['Drain the tuna and mash it with a little oil.', 'Spread it between two slices of bread.'],
    },
    {
        slug: 'eggs-on-toast', name: 'Eggs on toast', serves: 1, minutes: 10,
        ingredients: ['eggs-dozen', 'bread-white'], optional: ['butter', 'cheese-block'],
        steps: ['Toast two slices of bread.', 'Scramble or fry two eggs.', 'Put the eggs on the toast.'],
    },
    {
        slug: 'oatmeal-with-fruit', name: 'Oatmeal with fruit', serves: 1, minutes: 8,
        ingredients: ['oatmeal', 'bananas'], optional: ['whole-milk', 'raisins', 'canned-fruit', 'peanut-butter'],
        steps: ['Simmer the oats in water or milk for about five minutes.', 'Slice the fruit over the top.'],
    },
    {
        slug: 'quesadilla', name: 'Cheese quesadilla', serves: 1, minutes: 10,
        ingredients: ['tortillas', 'cheese-block'], optional: ['canned-beans', 'avocado', 'canned-corn'],
        steps: ['Put grated cheese on half a tortilla and fold it over.', 'Cook in a dry pan until the cheese melts, turning once.'],
    },
    {
        slug: 'vegetable-rice-bowl', name: 'Vegetable rice bowl', serves: 2, minutes: 25,
        ingredients: ['white-rice', 'frozen-mixed-veg', 'onion-3lb'], optional: ['cooking-oil', 'canned-corn', 'canned-green-beans', 'canned-beans'],
        steps: ['Cook the rice.', 'Fry the chopped onion in oil, add the vegetables and cook until hot through.', 'Serve the vegetables over the rice.'],
    },
    {
        slug: 'chili-rice-bowl', name: 'Chili and rice bowl', serves: 1, minutes: 15,
        ingredients: ['canned-chili', 'white-rice'], optional: ['cheese-block', 'canned-corn', 'yogurt'],
        steps: ['Cook the rice.', 'Warm the chili in a pan.', 'Spoon the chili over the rice.'],
    },
    {
        slug: 'peanut-butter-banana-sandwich', name: 'Peanut butter and banana sandwich', serves: 1, minutes: 5,
        ingredients: ['bread-white', 'peanut-butter', 'bananas'],
        optional: [],
        steps: ['Spread peanut butter on a slice of bread.', 'Slice the banana over it and close the sandwich.'],
    },
    {
        slug: 'potato-egg-hash', name: 'Potato and egg hash', serves: 2, minutes: 30,
        ingredients: ['potatoes-5lb', 'eggs-dozen', 'onion-3lb'], optional: ['cooking-oil', 'cheese-block', 'canned-green-beans'],
        steps: ['Dice the potatoes and onion and fry them in oil until soft and browned, about twenty minutes.', 'Make gaps in the pan, break in the eggs and cook until set.', 'Season and serve.'],
    },
];

const bySlug = new Map(RECIPES.map((r) => [r.slug, r]));

// ── Recipes from the network's AI (OpenVibe.AI workflow food.suggest_recipes) ──
// The pantry match above is deterministic and offline. This half builds the request to OpenVibe.AI from a person's
// saved pantry and Food's own food list, then validates what comes back strictly: an ingredient must be in the pantry
// or cite one of the sources Food sent, and a recipe with nothing left to make is dropped. Costs are computed here
// from the food list's typical prices, never from anything the model said.
const COST_NOTE = 'Cost is an estimate from typical 2025 US (Washington) prices carried over from OpenVibe.Tools, not a live price.';
const MAX_SOURCES = 60;
const MAX_PANTRY = 60;
const MAX_ASK = 500;

/** The rows of Food's own food list the AI may cite, staples first, at most 60. */
function buildSources() {
    return [...FOODS]
        .sort((a, b) => (Number(b.shelf_stable) - Number(a.shelf_stable)) || (a.name < b.name ? -1 : 1))
        .slice(0, MAX_SOURCES)
        .map((f) => ({
            source_type: 'food.food',
            source_id: f.slug,
            title: f.name,
            content: JSON.stringify({ name: f.name, unit: f.serving_size, price: f.price, price_max: f.price_max, price_band_label: f.band_label }),
        }));
}

function buildRequest({ pantry = [], ask = null, people = null } = {}) {
    return {
        pantry: pantry.slice(0, MAX_PANTRY).map((x) => String(x).slice(0, 120)),
        ...(ask ? { ask: String(ask).slice(0, MAX_ASK) } : {}),
        ...(people != null ? { people } : {}),
        sources: buildSources(),
    };
}

/**
 * Validate the workflow output against the sources Food sent and the person's pantry. Citations are indexes into the
 * `sources` array; an ingredient that neither is from the pantry nor cites a valid source is dropped, and a recipe
 * left with no ingredients or no steps is dropped. Each kept recipe gains Food's own `to_buy` and `to_buy_cost`.
 */
function validateSuggestions(output, { sources = [], pantry = [] } = {}) {
    const pantrySet = new Set(pantry);
    const src = Array.isArray(sources) ? sources : [];
    const out = output && typeof output === 'object' ? output : {};
    const recipes = [];
    for (const r of (Array.isArray(out.recipes) ? out.recipes : []).slice(0, 3)) {
        if (!r || typeof r !== 'object') continue;
        const ingredients = [];
        for (const ing of (Array.isArray(r.ingredients) ? r.ingredients : [])) {
            if (!ing || typeof ing !== 'object') continue;
            const fromPantry = ing.from_pantry === true;
            const citations = Array.isArray(ing.citations)
                ? ing.citations.filter((c) => Number.isInteger(c) && c >= 0 && c < src.length)
                : [];
            if (!fromPantry && !citations.length) continue;
            ingredients.push({ name: typeof ing.name === 'string' ? ing.name : '', amount: ing.amount == null ? null : ing.amount, from_pantry: fromPantry, citations });
        }
        const steps = Array.isArray(r.steps) ? r.steps.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean) : [];
        if (!ingredients.length || !steps.length) continue;

        const toBuy = new Map();
        for (const ing of ingredients) {
            if (ing.from_pantry) continue;
            for (const c of ing.citations) {
                const slug = src[c] && src[c].source_id;
                if (!slug || pantrySet.has(slug)) continue;
                const food = getFood(slug);
                if (!food) continue;
                toBuy.set(slug, { slug, name: food.name, price: food.price == null ? null : round(food.price, 2) });
            }
        }
        const toBuyList = [...toBuy.values()].sort((a, b) => (a.name < b.name ? -1 : 1));

        recipes.push({
            title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : 'Recipe',
            serves: r.serves,
            minutes: r.minutes,
            ingredients,
            steps,
            notes: r.notes == null ? null : (typeof r.notes === 'string' ? r.notes : String(r.notes)),
            to_buy: toBuyList,
            // A food with no typical price is listed without one and left out of the total, which then says so.
            to_buy_cost: round(toBuyList.reduce((n, x) => n + (x.price || 0), 0), 2),
            to_buy_cost_partial: toBuyList.some((x) => x.price == null),
            cost_note: COST_NOTE,
        });
    }
    return {
        recipes,
        citations: Array.isArray(out.citations) ? out.citations.filter((c) => Number.isInteger(c) && c >= 0 && c < src.length) : [],
        gaps: Array.isArray(out.gaps) ? out.gaps : [],
    };
}

/** Call the workflow and return its run id plus Food's validated, costed output. */
async function suggestRecipes(ai, { pantry = [], ask = null, people = null, subject } = {}) {
    // The model reads the pantry by name; the slugs stay for matching what is already in the cupboard.
    const input = buildRequest({ pantry: pantry.map((slug) => (getFood(slug) || {}).name || slug), ask, people });
    const run = await ai.run('food.suggest_recipes', input, {
        onBehalfOf: { type: 'user', id: subject },
        target: { service: 'food', type: 'pantry', id: subject },
    });
    const out = validateSuggestions(run && run.output, { sources: input.sources, pantry });
    return { runId: run && run.runId, recipes: out.recipes, citations: out.citations, gaps: out.gaps };
}

module.exports = { RECIPES, RECIPE_BY_SLUG: bySlug, COST_NOTE, MAX_SOURCES, buildSources, buildRequest, validateSuggestions, suggestRecipes };
