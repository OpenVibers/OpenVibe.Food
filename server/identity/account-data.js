'use strict';

/**
 * Account export and deletion → Food (ADR-033; openvibe-sdk/account-data). Food holds five things of a person's:
 * their saved meal plans, their pantry list and their recipe suggestions (plans and pantry under
 * `owner = user:usr_…`, recipe suggestions under `subject_id = user:usr_…`), and, from plan together, the households
 * they joined (`member`) and the shopping-list items they ticked (`ticked_by`). All are deleted whole and nothing is
 * kept: a plan's own members and ticks go with it (ON DELETE CASCADE); a member's tick on someone else's plan goes,
 * and that item shows as not yet got.
 *
 *   network.account.export_requested  plans.json, pantry.json, recipe-suggestions.json, households.json and
 *                                     shopping-ticks.json, pushed to Network (POST /internal/account-exports/:id/parts)
 *                                     with this service's token.
 *   network.account.deleted           the same rows go, and Food confirms with counts.
 *
 * The Nominatim/Overpass cache (food_geo_cache) holds no person's rows: it is keyed by the query, not by a subject, so
 * it is neither exported nor erased (see migrations/0002_food.sql). Nothing here is a secret: no token, key or
 * credential is stored, so every column of both tables may be exported.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

/**
 * The tables that hold a person's rows, with the value the subject column really stores. All five store
 * `user:usr_…` (server/food/store.js takes the owner straight from the principal's requester).
 */
const TABLES = [
    { table: 'food_plans', subject: 'owner', value: (usr) => `user:${usr}`, file: 'plans.json' },
    { table: 'food_pantry', subject: 'owner', value: (usr) => `user:${usr}`, file: 'pantry.json' },
    { table: 'food_recipe_suggestions', subject: 'subject_id', value: (usr) => `user:${usr}`, file: 'recipe-suggestions.json' },
    // Plan together: the households a person joined, and the shopping-list items they ticked on any plan. Their own
    // plans' members and ticks go with the plan (ON DELETE CASCADE).
    { table: 'food_plan_members', subject: 'member', value: (usr) => `user:${usr}`, file: 'households.json' },
    { table: 'food_plan_ticks', subject: 'ticked_by', value: (usr) => `user:${usr}`, file: 'shopping-ticks.json' },
];

/** The account-data handle for Food's store (server/db.js createStore). */
function create({ db, note = 'A pantry row names a food by its slug in server/food/foods.js.', log = console } = {}) {
    return createAccountData({ db, service: 'food', tables: TABLES, note, log });
}

module.exports = { create, TABLES, TOPICS };
