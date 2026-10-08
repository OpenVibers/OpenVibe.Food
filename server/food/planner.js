'use strict';

/**
 * The meal planner: a shopping list and an estimated cost for one person, a couple or a group over N days, built
 * from the food list (server/food/foods.js). Deterministic — the same spec always gives the same plan — so a saved
 * plan and the page that shows it agree, and a test can check the arithmetic.
 *
 * How it plans, plainly:
 *   1. coverage  one item from each of the six food groups, cheapest per serving first, enough packs to reach the
 *                group's daily minimum (USDA MyPlate, as the food list carries it) for everyone for every day
 *   2. energy    the rest of the packs, best calories per dollar first, until the calorie target is met
 *   3. layout    the items are spread over breakfast, lunch, dinner and snacks, rotating day by day
 *
 * It is an estimate to shop by: prices are typical, not live, and "serves" is what the pack says.
 */

const { FOODS, GROUPS, round } = require('./foods');

const KCAL_PER_PERSON_DAY = 2000;
const LIMITS = { people: [1, 12], days: [1, 14], budget: [1, 5000] };

class PlanError extends Error {
    constructor(code, detail) { super(detail); this.code = code; }
}

const whole = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : NaN);

/** Parse and check a spec; throws PlanError (the API turns it into 422 problem+json, a page into a notice). */
function spec(input = {}) {
    const people = whole(input.people == null || input.people === '' ? 1 : input.people);
    const days = whole(input.days == null || input.days === '' ? 3 : input.days);
    if (!(people >= LIMITS.people[0] && people <= LIMITS.people[1])) throw new PlanError('food.plan.invalid', `people: a whole number from ${LIMITS.people[0]} to ${LIMITS.people[1]}`);
    if (!(days >= LIMITS.days[0] && days <= LIMITS.days[1])) throw new PlanError('food.plan.invalid', `days: a whole number from ${LIMITS.days[0]} to ${LIMITS.days[1]}`);
    let budget = null;
    if (input.budget != null && input.budget !== '') {
        budget = Number(input.budget);
        if (!(budget >= LIMITS.budget[0] && budget <= LIMITS.budget[1])) throw new PlanError('food.plan.invalid', `budget: a number from ${LIMITS.budget[0]} to ${LIMITS.budget[1]}, or leave it out`);
        budget = round(budget, 2);
    }
    return { people, days, budget };
}

// Cheapest way to put a gram of the group on the table (the group minimum is in grams), then most energy a dollar.
const byCost = (a, b) => ((a.cost_per_gram == null ? a.cost_per_serving : a.cost_per_gram) - (b.cost_per_gram == null ? b.cost_per_serving : b.cost_per_gram)) || (b.kcal_per_dollar - a.kcal_per_dollar) || (a.id < b.id ? -1 : 1);
const byEnergy = (a, b) => (b.kcal_per_dollar - a.kcal_per_dollar) || (a.price - b.price) || (a.id < b.id ? -1 : 1);

function planMeals(input = {}) {
    const s = spec(input);
    const targetKcal = s.people * s.days * KCAL_PER_PERSON_DAY;
    const picks = new Map();                       // id → { food, packs }
    const add = (food, n) => { const cur = picks.get(food.id); picks.set(food.id, { food, packs: (cur ? cur.packs : 0) + n }); };
    const costOf = () => round([...picks.values()].reduce((n, p) => n + p.food.price * p.packs, 0), 2);
    const kcalOf = () => [...picks.values()].reduce((n, p) => n + p.food.package_kcal * p.packs, 0);

    // 1. Coverage. Prefer items whose pack states a weight, so the daily minimum can be met by arithmetic.
    const coverage = [];
    for (const [group, def] of Object.entries(GROUPS)) {
        const inGroup = FOODS.filter((f) => f.group === group && f.price != null);
        const withGrams = inGroup.filter((f) => f.serving_grams);
        const pick = (withGrams.length ? withGrams : inGroup).sort(byCost)[0];
        if (!pick) continue;
        const servingsNeeded = pick.serving_grams ? Math.ceil(s.people * s.days * def.dailyMin / pick.serving_grams) : s.people * s.days;
        coverage.push({ food: pick, packs: Math.max(1, Math.ceil(servingsNeeded / pick.servings)) });
    }
    for (const { food, packs } of coverage.sort((a, b) => a.food.price - b.food.price || (a.food.id < b.food.id ? -1 : 1))) {
        if (s.budget != null && round(costOf() + food.price * packs, 2) > s.budget) continue;
        add(food, packs);
    }

    // 2. Energy. One pack at a time, best calories per dollar first; a bound so an impossible target stops.
    const energyOrder = FOODS.filter((f) => f.price != null).sort(byEnergy);
    for (let guard = 0; guard < 80 && kcalOf() < targetKcal; guard++) {
        const food = energyOrder[guard % energyOrder.length];
        if (s.budget != null && round(costOf() + food.price, 2) > s.budget) break;
        add(food, 1);
    }

    // 3. The list, the shopping order (by cheapest store, then name) and the per-group coverage.
    const items = [...picks.values()].map(({ food, packs }) => ({
        slug: food.slug, name: food.name, group: food.group, group_name: food.group_name,
        packs, unit_cost: food.price, cost: round(food.price * packs, 2),
        kcal: food.package_kcal * packs, protein_g: round(food.package_protein_g * packs),
        store: food.cheapest_store, store_name: food.cheapest_store_name,
        meals: food.meals,
    })).sort((a, b) => (a.store < b.store ? -1 : a.store > b.store ? 1 : 0) || (a.name < b.name ? -1 : 1));

    const totalCost = round(items.reduce((n, i) => n + i.cost, 0), 2);
    const totalKcal = items.reduce((n, i) => n + i.kcal, 0);
    const totalProtein = items.reduce((n, i) => n + i.protein_g, 0);
    const personDays = s.people * s.days;

    const groupCoverage = Object.entries(GROUPS).map(([group, def]) => {
        const mine = items.filter((i) => i.group === group);
        return { group, name: def.name, daily_min_g: def.dailyMin, covered: mine.length > 0, items: mine.length, packs: mine.reduce((n, i) => n + i.packs, 0), cost: round(mine.reduce((n, i) => n + i.cost, 0), 2) };
    });

    // One menu a day, rotating each item through the meals it suits, so the days are not all identical.
    const menuItems = items.slice().sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : (a.name < b.name ? -1 : 1)));
    const days = [];
    for (let d = 0; d < s.days; d++) {
        const day = { day: d + 1, breakfast: [], lunch: [], dinner: [], snack: [] };
        for (const item of menuItems) {
            const slot = item.meals[(d % item.meals.length + item.meals.length) % item.meals.length] || 'dinner';
            day[slot].push(item.name);
        }
        days.push(day);
    }

    const byStore = [...new Set(items.map((i) => i.store))].filter(Boolean).map((store) => ({
        store, store_name: items.find((i) => i.store === store).store_name,
        items: items.filter((i) => i.store === store).length,
        cost: round(items.filter((i) => i.store === store).reduce((n, i) => n + i.cost, 0), 2),
    })).sort((a, b) => a.store < b.store ? -1 : 1);

    const coveredGroups = groupCoverage.filter((g) => g.covered).length;
    return {
        spec: { people: s.people, days: s.days, budget: s.budget },
        items, shopping_list: items, by_store: byStore, days: s.days, menu: days,
        group_coverage: groupCoverage,
        totals: {
            cost: totalCost,
            cost_per_person_day: round(totalCost / personDays, 2),
            kcal: totalKcal,
            kcal_per_person_day: Math.round(totalKcal / personDays),
            protein_g: Math.round(totalProtein),
            protein_g_per_person_day: Math.round(totalProtein / personDays),
            target_kcal_per_person_day: KCAL_PER_PERSON_DAY,
            items: items.length,
            packs: items.reduce((n, i) => n + i.packs, 0),
        },
        covers_all_groups: coveredGroups === groupCoverage.length,
        groups_covered: coveredGroups,
        groups_total: groupCoverage.length,
        remaining_budget: s.budget == null ? null : round(s.budget - totalCost, 2),
        notes: [
            'Cost is an estimate from typical 2025 US (Washington) prices carried over from OpenVibe.Tools, not a live price.',
            ...(s.budget != null && coveredGroups < groupCoverage.length ? ['The budget did not stretch to every food group; the plan buys the cheapest items first.'] : []),
            ...(kcalOf() < targetKcal ? [`The plan is under the ${KCAL_PER_PERSON_DAY} kcal a person a day target (it stays inside the budget).`] : []),
            // Shops are whole packs, so a short plan supplies more than its own days; saying so is clearer than a
            // calories-a-day figure that looks absurd next to the target.
            ...(kcalOf() > targetKcal * 1.15 ? [`The shops are whole packs: this basket supplies about ${Math.round(kcalOf() / (s.people * KCAL_PER_PERSON_DAY))} days of energy at ${KCAL_PER_PERSON_DAY} kcal a person, whatever the plan length.`] : []),
        ],
    };
}

module.exports = { planMeals, spec, PlanError, KCAL_PER_PERSON_DAY, LIMITS };
