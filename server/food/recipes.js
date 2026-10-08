'use strict';

/**
 * A small set of basic recipes, written for this service in plain words (no copied recipe text, nothing
 * copyrighted), each naming only items from the food list (server/food/foods.js). They exist so the pantry can answer
 * "what can I make?" without an AI call: server/food/pantry-match.js matches a person's cupboard against them.
 *
 * These are deliberately simple combinations and the pantry page labels them as such. They are not dietary advice.
 */

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

module.exports = { RECIPES, RECIPE_BY_SLUG: bySlug };
