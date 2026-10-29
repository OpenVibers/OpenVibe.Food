'use strict';
// What openvibe.food tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this host really serves: the public pages (food near you, the meal planner, the food
// list and one food, recalls, the recipe library, the update log), the JSON API under /api/v1, llms.txt and the
// sitemap. No OpenAPI document or MCP endpoint is published here, so none is named.
module.exports = {
    id: 'food',
    name: 'OpenVibe.Food',
    purpose: 'Food near you from OpenStreetMap (food banks, soup kitchens and budget grocery stores), a deterministic meal planner with a shopping list and an estimated cost, a 42-item food database with nutrition and typical prices, a pantry with what you can make, FDA food recalls and a recipe library.',
    home: 'https://openvibe.food',
    site: 'openvibe.food',
    api: '/api/v1',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: 'Pages and /api/v1 are limited per address to 300 and 240 requests a minute; the place search is limited per caller to 10 requests a minute and 120 an hour (its answers are cached for a week)',
    },
};
