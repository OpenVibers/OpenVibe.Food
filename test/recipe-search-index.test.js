'use strict';
/**
 * Checked library recipes in OpenVibe.Search (server/food/search-index.js), against a stand-in Search owner API:
 *   - each checked recipe is a valid search.index-document@1 (owner food, type recipe, /recipes/library/<slug>);
 *   - unchanged is not sent again; a change goes one revision up; a recipe no longer checked is tombstoned;
 *   - off without FOOD_SEARCH_URL.
 */
const assert = require('assert');
const http = require('http');
const { validate } = require('openvibe-contracts');
const { createRecipeSearchIndex } = require('../server/food/search-index');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.log(`  ✗ ${name}\n      ${err && err.stack}`); }
}

function startSearch() {
    const docs = new Map();
    const puts = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const u = new URL(req.url, 'http://search.test');
            const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
            if (req.headers.authorization !== 'Bearer svc-food') return send(401, { code: 'token.invalid' });
            if (req.method === 'GET' && u.pathname === '/api/v1/owners/food/documents') {
                return send(200, { documents: [...docs.values()].map((d) => ({ type: 'recipe', id: d.id, revision: d.revision, deleted: Boolean(d.deleted) })), next_after: null });
            }
            let m = /^\/api\/v1\/owners\/food\/documents\/recipe\/([^/]+)$/.exec(u.pathname);
            if (m && req.method === 'GET') {
                const d = docs.get(decodeURIComponent(m[1]));
                return d && !d.deleted ? send(200, { document: d }) : send(404, { code: 'search.not_found' });
            }
            m = /^\/api\/v1\/documents\/food\/recipe\/([^/]+)$/.exec(u.pathname);
            if (m && req.method === 'PUT') {
                const doc = { ...JSON.parse(raw), owner: 'food', type: 'recipe', id: decodeURIComponent(m[1]) };
                const v = validate('search.index-document@1', doc);
                if (!v.valid) return send(422, { code: 'search.bad_document', errors: v.errors });
                docs.set(doc.id, doc);
                puts.push(doc.id);
                return send(200, { outcome: 'applied' });
            }
            if (m && req.method === 'DELETE') {
                const id = decodeURIComponent(m[1]);
                docs.set(id, { id, revision: Number(u.searchParams.get('revision')), deleted: true });
                return send(200, { outcome: 'applied' });
            }
            return send(404, { code: 'route.not_found' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ docs, puts, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

(async () => {
    const search = await startSearch();
    let checked = [{
        slug: 'beans-and-rice', title: 'Beans and rice', serves: 2, minutes: 25, cost: 4.5, cost_partial: false,
        ingredients: [{ name: 'Black beans', amount: '1 can' }, { name: 'Rice', amount: '1 cup' }], steps: ['Cook the rice.', 'Warm the beans.'],
        created_at: '2026-10-15T10:00:00.000Z', reviewed_at: '2026-10-15T12:00:00.000Z',
    }];
    const library = { reviewed: async () => checked };
    const config = { search: { url: search.url }, oauth: { clientSecret: 'x', clientId: 'food' }, networkInternalUrl: 'http://network.test', baseUrl: 'https://openvibe.food' };
    const index = createRecipeSearchIndex({ config, library, tokens: { authHeaders: async () => ({ authorization: 'Bearer svc-food' }) }, log: { warn() {} } });

    await check('a checked recipe is a valid document with its own address', async () => {
        const r = await index.run();
        assert.strictEqual(r.upserted, 1, JSON.stringify(r));
        const doc = search.docs.get('beans-and-rice');
        assert.strictEqual(doc.canonical_url, 'https://openvibe.food/recipes/library/beans-and-rice');
        assert.ok(doc.body.includes('Ingredients: 1 can Black beans; 1 cup Rice') && doc.summary.includes('$4.50 to buy'));
        assert.strictEqual(doc.authorship, 'ai_generated');
        assert.strictEqual(doc.revision, 1);
    });

    await check('unchanged is not sent again; a change goes one revision up; no longer checked, it is tombstoned', async () => {
        await index.run();
        assert.strictEqual(search.puts.length, 1, 'nothing changed');
        checked = [{ ...checked[0], title: 'Beans and rice for two' }];
        await index.run();
        assert.strictEqual(search.docs.get('beans-and-rice').revision, 2);
        checked = [];
        const r = await index.run();
        assert.strictEqual(r.deleted, 1);
        assert.deepStrictEqual(search.docs.get('beans-and-rice'), { id: 'beans-and-rice', revision: 3, deleted: true });
    });

    await check('off without FOOD_SEARCH_URL', async () => {
        const off = createRecipeSearchIndex({ config: { ...config, search: { url: '' } }, library });
        assert.strictEqual(off.enabled, false);
        assert.strictEqual(await off.run(), null);
    });

    await search.close();
    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})();
