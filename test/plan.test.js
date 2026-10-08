'use strict';
/**
 * The meal planner: the arithmetic (deterministic, all six food groups, a budget is a cap, the total is the sum of
 * the packs), the API that saves a plan for the person who asked for it, and the page that renders and saves it
 * without JavaScript.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { planMeals, PlanError } = require('../server/food/planner');

const SAME = { 'sec-fetch-site': 'same-origin' };
const money = (n) => Math.round(n * 100) / 100;

(async () => {
    await check('the plan is deterministic and its arithmetic adds up', () => {
        const a = planMeals({ people: 2, days: 3 });
        const b = planMeals({ people: 2, days: 3 });
        assert.deepStrictEqual(a.items, b.items, 'the same spec gives the same plan');
        assert.strictEqual(a.items.length, new Set(a.items.map((i) => i.slug)).size, 'no item twice');

        const sum = money(a.items.reduce((n, i) => n + i.cost, 0));
        assert.strictEqual(a.totals.cost, sum, 'the total is the sum of the lines');
        for (const i of a.items) assert.strictEqual(i.cost, money(i.unit_cost * i.packs), `${i.slug} line`);
        assert.strictEqual(a.totals.cost_per_person_day, money(a.totals.cost / 6), 'cost a person a day');
        assert.strictEqual(a.totals.kcal, a.items.reduce((n, i) => n + i.kcal, 0));
        assert.strictEqual(a.totals.kcal_per_person_day, Math.round(a.totals.kcal / 6));
        assert.ok(a.totals.cost > 0 && a.totals.kcal_per_person_day > 500, JSON.stringify(a.totals));
        assert.strictEqual(a.days, 3);
        assert.strictEqual(a.menu.length, 3);
        for (const d of a.menu) assert.deepStrictEqual(Object.keys(d).sort(), ['breakfast', 'day', 'dinner', 'lunch', 'snack']);
        assert.strictEqual(a.shopping_list, a.items, 'the shopping list is the list');
    });

    await check('a plan covers all six food groups with no budget, and says so', () => {
        const p = planMeals({ people: 4, days: 7 });
        assert.strictEqual(p.group_coverage.length, 6);
        assert.strictEqual(p.groups_covered, 6);
        assert.strictEqual(p.covers_all_groups, true);
        for (const g of p.group_coverage) {
            assert.ok(g.covered, `${g.group} is not covered`);
            assert.ok(g.packs >= 1 && g.cost > 0);
        }
        assert.ok(p.by_store.length >= 1);
        assert.ok(Math.abs(p.by_store.reduce((n, s) => n + s.cost, 0) - p.totals.cost) <= 0.02, 'the per-store totals are the total');
    });

    await check('a budget is a hard cap; too small a budget buys the cheapest groups first and says what is missing', () => {
        const roomy = planMeals({ people: 1, days: 1, budget: 20 });
        assert.ok(roomy.totals.cost <= 20);
        assert.strictEqual(roomy.remaining_budget, money(20 - roomy.totals.cost));

        const tight = planMeals({ people: 1, days: 1, budget: 2 });
        assert.ok(tight.totals.cost <= 2, `spent ${tight.totals.cost}`);
        assert.strictEqual(tight.covers_all_groups, false);
        assert.ok(tight.notes.some((n) => /budget did not stretch/.test(n)));
        assert.ok(tight.items.every((i) => i.unit_cost <= 2));
    });

    await check('a spec that cannot be planned is refused, not silently changed', () => {
        assert.throws(() => planMeals({ people: 0 }), (e) => e instanceof PlanError && e.code === 'food.plan.invalid');
        assert.throws(() => planMeals({ days: 99 }), PlanError);
        assert.throws(() => planMeals({ budget: -3 }), PlanError);
        assert.strictEqual(planMeals({}).spec.people, 1, 'defaults');
        assert.strictEqual(planMeals({}).spec.days, 3);
    });

    const t = await boot();
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    try {
        await check('a signed-in person saves a plan and gets it back; the plan is theirs alone', async () => {
            const created = await t.get('/api/v1/plans', { as: kim, json: { people: 2, days: 4, budget: 60, title: 'Four days for two' }, headers: SAME });
            assert.strictEqual(created.status, 201, created.text);
            const body = created.json();
            assert.match(body.id, /^pln_/);
            assert.strictEqual(body.people, 2);
            assert.strictEqual(body.days, 4);
            assert.strictEqual(body.title, 'Four days for two');
            assert.strictEqual(body.plan.totals.cost, planMeals({ people: 2, days: 4, budget: 60 }).totals.cost, 'the saved plan is the generated one');
            assert.match(String(created.headers.get('location')), /^\/api\/v1\/plans\/pln_/);

            const list = await t.get('/api/v1/plans', { as: kim });
            assert.strictEqual(list.status, 200);
            assert.deepStrictEqual(list.json().plans.map((p) => p.id), [body.id]);
            const one = await t.get(`/api/v1/plans/${body.id}`, { as: kim });
            assert.strictEqual(one.status, 200);
            assert.strictEqual(one.json().title, 'Four days for two');

            const theirs = await t.get(`/api/v1/plans/${body.id}`, { as: lee });
            assert.strictEqual(theirs.status, 404, 'another person cannot see it');
            assert.deepStrictEqual((await t.get('/api/v1/plans', { as: lee })).json().plans, []);
        });

        await check('a plan that makes no sense is a 422 problem, and an anonymous caller cannot write one', async () => {
            const bad = await t.get('/api/v1/plans', { as: kim, json: { people: 0 }, headers: SAME });
            assert.strictEqual(bad.status, 422);
            assert.strictEqual(bad.json().code, 'food.plan.invalid');
            const anon = await t.get('/api/v1/plans', { json: { people: 2, days: 3 } });
            assert.strictEqual(anon.status, 401, 'anonymous read of a write route');
            assert.strictEqual(anon.json().code, 'token.required');
            assert.deepStrictEqual((await t.get('/api/v1/plans')).json().code, 'token.required');
        });

        await check('the /plan page plans without JavaScript and saves with one POST, then shows it was saved', async () => {
            const rendered = await t.get('/plan?people=3&days=2', { as: kim });
            assert.strictEqual(rendered.status, 200);
            assert.match(rendered.text, /3 people, 2 days/);
            assert.match(rendered.text, /The shopping list/);
            assert.match(rendered.text, /action="\/plan"/);
            assert.match(rendered.text, /Save this plan/, 'a signed-in visitor can save it');

            const guest = await t.get('/plan');
            assert.match(guest.text, /Sign in<\/a> to save a plan/, 'a guest is told to sign in to save');

            const posted = await t.get('/plan', { as: kim, method: 'POST', form: { people: '3', days: '2', title: 'Two days for three' }, headers: SAME });
            assert.strictEqual(posted.status, 303, posted.text.slice(0, 200));
            assert.match(String(posted.headers.get('location')), /^\/plan\?.*saved=pln_/);

            const saved = (await t.get('/api/v1/plans', { as: kim })).json().plans;
            assert.ok(saved.some((p) => p.title === 'Two days for three'), 'the form saved it');

            const back = await t.get(posted.headers.get('location'), { as: kim });
            assert.match(back.text, /Saved\./);

            const mine = await t.get('/plan/saved', { as: kim });
            assert.strictEqual(mine.status, 200);
            assert.match(mine.text, /Two days for three/);
            const other = await t.get('/plan/saved', { as: lee });
            assert.ok(!other.text.includes('Two days for three'), 'lee sees none of kim\'s plans');
        });

        await check('a cross-site form cannot save a plan for a signed-in visitor', async () => {
            const cross = await t.get('/plan', { as: kim, method: 'POST', form: { people: '2', days: '2' }, headers: { 'sec-fetch-site': 'cross-site' } });
            assert.strictEqual(cross.status, 403);
        });
    } finally { await t.close(); }
    done();
})();
