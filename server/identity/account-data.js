'use strict';

/**
 * Account export and deletion → Food (ADR-033; openvibe-sdk/account-data). Food holds three things a person made:
 * a saved meal plan, their pantry list and their recipe suggestions, each keyed by the person (plans and pantry under
 * `owner = user:usr_…`, recipe suggestions under `subject_id = user:usr_…`). All three are the person's own — nothing
 * anyone else hangs under them — so all three are deleted whole and nothing is kept.
 *
 *   network.account.export_requested  the person's plans (plans.json), pantry (pantry.json) and recipe suggestions
 *                                     (recipe-suggestions.json), newest first, pushed to Network
 *                                     (POST /internal/account-exports/:id/parts) with this service's token.
 *   network.account.deleted           the person's plans, pantry and recipe suggestions go, and Food confirms with
 *                                     counts.
 *
 * The Nominatim/Overpass cache (food_geo_cache) holds no person's rows: it is keyed by the query, not by a subject, so
 * it is neither exported nor erased (see migrations/0002_food.sql). Nothing here is a secret: no token, key or
 * credential is stored, so every column of both tables may be exported.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

/**
 * The tables that hold a person's rows, with the value the subject column really stores. All three store
 * `user:usr_…` (server/food/store.js takes the owner straight from the principal's requester).
 */
const TABLES = [
    { table: 'food_plans', subject: 'owner', value: (usr) => `user:${usr}`, file: 'plans.json' },
    { table: 'food_pantry', subject: 'owner', value: (usr) => `user:${usr}`, file: 'pantry.json' },
    { table: 'food_recipe_suggestions', subject: 'subject_id', value: (usr) => `user:${usr}`, file: 'recipe-suggestions.json' },
];

/** The account-data handle for Food's store (server/db.js createStore). */
function create({ db, note = 'A pantry row names a food by its slug in server/food/foods.js.', log = console } = {}) {
    return createAccountData({ db, service: 'food', tables: TABLES, note, log });
}

module.exports = { create, TABLES, TOPICS };
