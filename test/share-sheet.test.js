'use strict';
/**
 * Every recipe in the library carries the network's one Share button (openvibe-shared 4.114.0): one
 * [data-ov-share-sheet] in its head, with the recipe's canonical address, title and line. A recipe has no picture of
 * its own, so there is no data-image. The navbar loads the sheet on the first press.
 */
const assert = require('assert');
const { boot } = require('./helpers/boot');
const { buildSources } = require('../server/food/recipes');

const src = buildSources();
const at = (slug) => src.findIndex((x) => x.source_id === slug);
const ai = {
    async run() {
        return {
            runId: 'run_share_1',
            output: {
                recipes: [{
                    title: 'Beans and Rice', serves: 4, minutes: 25,
                    ingredients: [
                        { name: 'Rice', amount: '2 cups', from_pantry: false, citations: [at('white-rice')] },
                        { name: 'Beans', amount: '1 can', from_pantry: false, citations: [at('canned-beans')] },
                    ],
                    steps: ['Cook the rice.', 'Warm the beans.', 'Serve together.'], notes: 'Add hot sauce.',
                }],
                citations: [], gaps: [],
            },
        };
    },
};

(async () => {
    const t = await boot({ env: { OV_AI_INTERNAL_URL: 'http://ai.test' }, ai });
    try {
        const [recipe] = await t.ctx.library.tick({ force: true });
        const r = await t.get(`/recipes/library/${recipe.slug}`);
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.strictEqual((r.text.match(/data-ov-share-sheet/g) || []).length, 1, 'one Share button');
        assert.ok(r.text.includes(`data-url="https://openvibe.food/recipes/library/${recipe.slug}"`), 'the recipe address');
        assert.ok(r.text.includes('data-title="Beans and Rice"'), 'its title');
        assert.ok(r.text.includes('data-text="Beans and Rice: Serves 4 · About 25 min'), 'its line');
        assert.ok(r.text.includes('class="ovk-btn ovk-btn--quiet"') && r.text.includes('<span>Share</span>'), 'the shared kit button');
        assert.ok(!r.text.includes('data-image='), 'no picture: no data-image');
        console.log('food share sheet ok');
    } finally {
        await t.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
