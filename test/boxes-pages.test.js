'use strict';
// The food boxes on the site and in the API (server/http/box-pages.js, /api/v1/boxes): the directory with its tabs,
// diets and search, a box with its facts, sources, cost and links, boxes side by side, and the API's answers.
const assert = require('assert');
const { boot } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        // ── The directory ──
        let r = await t.get('/boxes');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /<h1>Food boxes<\/h1>/);
        assert.match(r.text, /href="\/boxes\?kind=cook"/, 'a tab per kind');
        assert.match(r.text, /href="\/boxes\/everyplate"/);
        assert.match(r.text, /from \$5\.99 a serving · 2–6 people · 3–5 meals a week/, 'a row says the stated price and plan sizes');
        assert.match(r.text, /\/shared\/kit\.css\?v=/, 'the OpenVibe Kit');
        r = await t.get('/boxes?kind=meat');
        assert.match(r.text, /ButcherBox/);
        assert.doesNotMatch(r.text, /href="\/boxes\/everyplate"/, 'one kind at a time');
        assert.match(r.text, /aria-current="page"[^>]*>(<[^>]+>)*Meat and fish/);
        r = await t.get('/boxes?diet=keto');
        assert.match(r.text, /Green Chef/);
        assert.doesNotMatch(r.text, /href="\/boxes\/butcherbox"/, 'a diet filters');
        r = await t.get('/boxes?q=coffee');
        assert.match(r.text, /Bean Box/);
        r = await t.get('/boxes?q=zzzz');
        assert.match(r.text, /No box matches/);

        // ── One box ──
        r = await t.get('/boxes/everyplate?people=4&meals=3');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /<h1>EveryPlate<\/h1>/);
        assert.match(r.text, /Plans from \$5\.99 a serving/);
        assert.match(r.text, /<strong>\$82\.87<\/strong> a week \(\$71\.88 of food \+ \$10\.99 shipping\), for 12 servings/, '4 people × 3 meals at $5.99 + $10.99');
        assert.match(r.text, /read 2026-10-28/, 'the day it was read');
        assert.match(r.text, /href="https:\/\/www\.everyplate\.com\/about\/menus-and-plans"/, 'the page it was read on');
        assert.match(r.text, /openvibe\.watch\/watches\/new\?template=page/, 'Watch');
        assert.match(r.text, /openvibe\.reviews\/review\?kind=service&amp;name=EveryPlate/, 'no Reviews entry: write the first');
        assert.match(r.text, /openvibe\.coupons\/\?q=everyplate\.com/, 'no Coupons shop: submit a code');
        r = await t.get('/boxes/dinnerly');
        assert.match(r.text, /Not checked yet/, 'nothing stated: said so');
        assert.doesNotMatch(r.text, /What it comes to/, 'and nothing worked out');
        assert.strictEqual((await t.get('/boxes/nope')).status, 404);

        // ── Side by side ──
        r = await t.get('/boxes/compare?b=everyplate,hellofresh,nope');
        assert.match(r.text, /<a href="\/boxes\/everyplate">EveryPlate<\/a>/);
        assert.match(r.text, /<a href="\/boxes\/hellofresh">HelloFresh<\/a>/);
        assert.match(r.text, /The whole US except Alaska and Hawaii/);
        r = await t.get('/boxes/compare?keep=everyplate&add=factor');
        assert.deepStrictEqual([r.status, r.headers.get('location')], [303, '/boxes/compare?b=everyplate,factor']);

        // ── The API ──
        r = await t.get('/api/v1/boxes?kind=pets');
        assert.strictEqual(r.status, 200);
        const pets = r.json();
        assert.ok(pets.boxes.length >= 3 && pets.boxes.every((b) => b.kind === 'pets'));
        assert.ok(pets.method.includes('read on the service\'s own public pages'));
        assert.strictEqual((await t.get('/api/v1/boxes?kind=cars')).status, 422);
        r = await t.get('/api/v1/boxes/cookunity');
        assert.deepStrictEqual([r.json().box.price.line, r.json().coupons, r.json().reviews], ['$10.39–$12.69 a meal', null, null]);
        r = await t.get('/api/v1/boxes/everyplate/cost?people=2&meals=3&weeks=2');
        assert.deepStrictEqual(r.json().cost.total, { from: 93.86, to: 93.86 });
        r = await t.get('/api/v1/boxes/butcherbox/cost');
        assert.deepStrictEqual([r.status, r.json().code], [422, 'food.box.no_cost']);
        process.stdout.write('boxes pages and API: directory, tabs, diets, search, a box, compare and the API ok\n');
    } finally {
        if (t.close) await t.close();
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
