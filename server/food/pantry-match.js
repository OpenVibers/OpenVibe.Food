'use strict';

/**
 * "What can I make?": match what a person says is in their cupboard against the basic recipes (server/food/recipes.js).
 *
 * Deterministic and offline — no model call, no ranking magic. A recipe can be made when every ingredient it needs is
 * in the pantry; the rest are listed with what is missing, so the answer is useful even when nothing is complete.
 * Everything the pantry holds is a food from the list, so an unknown item can never reach this function.
 */

const { RECIPES } = require('./recipes');
const { getFood } = require('./foods');

const nameOf = (slug) => { const f = getFood(slug); return f ? f.name : slug; };

/** One recipe vs one set of pantry slugs. */
function score(recipe, pantry) {
    const has = (slug) => pantry.has(slug);
    const ingredientList = recipe.ingredients.map((slug) => ({ slug, name: nameOf(slug), have: has(slug), optional: false }));
    const optionalList = (recipe.optional || []).map((slug) => ({ slug, name: nameOf(slug), have: has(slug), optional: true }));
    const missing = ingredientList.filter((i) => !i.have);
    return {
        slug: recipe.slug, name: recipe.name, serves: recipe.serves, minutes: recipe.minutes, steps: recipe.steps,
        ingredients: ingredientList, optional: optionalList,
        have: ingredientList.filter((i) => i.have),
        missing,
        optional_have: optionalList.filter((i) => i.have),
        optional_missing: optionalList.filter((i) => !i.have),
        can_make: missing.length === 0,
        missing_count: missing.length,
        coverage: ingredientList.length ? Number(((ingredientList.length - missing.length) / ingredientList.length).toFixed(2)) : 1,
    };
}

/**
 * Every recipe against what the pantry holds, best first: what can be made, then what is closest, then by name.
 * `pantry` is an array of food slugs.
 */
function matchPantry(pantrySlugs = []) {
    const pantry = new Set(pantrySlugs);
    const all = RECIPES.map((r) => score(r, pantry)).sort((a, b) => (Number(b.can_make) - Number(a.can_make)) || (a.missing_count - b.missing_count) || (a.name < b.name ? -1 : 1));
    return {
        can_make: all.filter((r) => r.can_make),
        almost: all.filter((r) => !r.can_make && r.missing_count <= 1),
        rest: all.filter((r) => !r.can_make && r.missing_count > 1),
        all,
    };
}

module.exports = { matchPantry, score };
