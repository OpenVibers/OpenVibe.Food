'use strict';

/**
 * Crawl artifacts for openvibe.food, built with openvibe-shared/seo: robots.txt, sitemap.xml, llms.txt and
 * llms-full.txt, and the home page's JSON-LD. The public pages are for search engines and AI crawlers; sign-in, the
 * API and anything personal (a pantry, a saved plan) are not.
 *
 * The sitemap carries every food page (server/food/foods.js) as well as the site's own pages, and llms-full.txt lists
 * the same set — the two must stay the same list.
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const foods = require('../food/foods');

const SITE_NAME = 'OpenVibe.Food';
const DESCRIPTION = 'OpenVibe.Food — What should we eat? Find food banks and budget grocery stores near you, plan meals, and cook from what is in your cupboard.';
const DISALLOW = ['/auth/', '/api/', '/pantry', '/plan/saved'];

const PAGE_TEXT = {
    '/': ['OpenVibe.Food home', 'OpenVibe.Food: What should we eat? Find food near you, plan budget meals and cook from your cupboard.'],
    '/near': ['Food near you', 'Food banks, soup kitchens, community fridges and budget grocery stores near a place, from OpenStreetMap.'],
    '/plan': ['Meal plan', 'Plan meals for one person, a couple or a group for up to fourteen days, with a shopping list and an estimated cost.'],
    '/foods': ['The food list', 'Every food OpenVibe.Food plans with: nutrition per serving and per 100 g, and a typical price band.'],
    '/updates': ['What shipped on OpenVibe.Food', 'This site\'s update log, from the network changelog feed.'],
};
const SUMMARIES = {
    '/': 'Find food near you, plan budget meals and cook from what you have.',
    '/near': 'Food banks and budget grocery stores near a place, from OpenStreetMap.',
    '/plan': 'A meal plan with a shopping list and an estimated cost.',
    '/foods': 'Nutrition per serving and per 100 g, and a typical price band, for every food.',
    '/updates': 'What shipped on the site.',
};

function dayOf(ts) {
    const m = String(ts == null ? '' : ts).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
function siteUpdated() {
    try { return dayOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated); } catch { return null; }
}

function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION }),
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'BusinessApplication', keywords: 'food, meal planning, food banks, OpenStreetMap' }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

/** Every public page, the food pages included (the sitemap and llms-full.txt both read this). */
const publicPages = () => [
    { path: '/', changefreq: 'weekly', priority: 1.0 },
    { path: '/near', changefreq: 'weekly', priority: 0.9 },
    { path: '/plan', changefreq: 'weekly', priority: 0.9 },
    { path: '/foods', changefreq: 'weekly', priority: 0.8 },
    { path: '/updates', changefreq: 'daily', priority: 0.5 },
    ...foods.FOODS.map((f) => ({
        path: `/foods/${f.slug}`, changefreq: 'monthly', priority: 0.5,
        title: f.name, text: `${f.name} (${f.group_name})${f.price != null ? `, typically ${f.price} to ${f.price_max} a pack` : ''}. ${SUMMARIES['/foods']}`,
    })),
];

function createDiscoveryRoutes(ctx) {
    const { config } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# openvibe.food: the public pages are for search and AI crawlers; sign-in, the API and anything personal are not.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: 'OpenVibe.Food: What should we eat? Find food banks and budget grocery stores near you, plan budget meals, and cook from what is in your cupboard.',
            details: 'Every page is server-rendered and readable without JavaScript. Places come from OpenStreetMap © contributors (ODbL).',
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenVibe.Food', url: abs('/'), note: 'What should we eat?' },
                    { title: 'Food near you', url: abs('/near'), note: 'food banks and budget grocery stores, from OpenStreetMap' },
                    { title: 'Meal plan', url: abs('/plan'), note: 'a shopping list and an estimated cost' },
                    { title: 'The food list', url: abs('/foods'), note: 'nutrition and typical prices' },
                    { title: 'What shipped on OpenVibe.Food', url: abs('/updates') },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                    { title: 'Full text for language models', url: abs('/llms-full.txt') },
                    { title: 'Release metadata (JSON)', url: abs('/release.json') },
                    { title: 'The API', url: abs('/api/v1/foods'), note: 'JSON: places, foods, plans, pantry' },
                ] },
                { title: 'Elsewhere', links: [
                    { title: 'OpenVibe.Network', url: 'https://openvibe.network', note: 'accounts, apps and grants' },
                    { title: 'OpenVibe.Services', url: 'https://openvibe.services', note: 'apps, keys and capability grants' },
                    { title: 'OpenStreetMap', url: 'https://www.openstreetmap.org/copyright', note: 'the place data, © contributors, ODbL' },
                ] },
            ],
        }));
    });

    r.get('/llms-full.txt', (_req, res) => {
        const pages = publicPages().map((p) => ({
            url: p.path,
            title: p.title || PAGE_TEXT[p.path][0],
            text: p.text || PAGE_TEXT[p.path][1],
        }));
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'Every public page of OpenVibe.Food, one entry each.',
            base: site,
            maxBytes: 64 * 1024,
            sections: [{ title: 'Pages', pages }],
        }));
    });

    r.get('/sitemap.xml', (_req, res) => {
        const lastmod = siteUpdated();
        const urls = publicPages().map((e) => ({ loc: abs(e.path), ...(lastmod ? { lastmod } : {}), changefreq: e.changefreq, priority: e.priority }));
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, DESCRIPTION, SITE_NAME };
