'use strict';
/**
 * A household's chat (server/food/household-chat.js): the owner of a shared plan opens a private room on OpenVibe.Chat
 * (a stand-in here) as themselves, with every member added by account subject and Pantry, an AI member linked to the
 * plan; only the owner can; the page links the room for everyone. Chat's AI member reads the household through
 * GET /internal/households/:id/chat-context with a service token carrying food.household.read: the plan, what is
 * still to buy and every member's cupboard. A person, or a service without the capability, is refused.
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { serviceAuth } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin' };

/** A stand-in for OpenVibe.Chat's room API: records every call, answers like Chat. */
function startChat() {
    const calls = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const json = body ? JSON.parse(body) : null;
            calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, json });
            const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.method === 'POST' && req.url === '/api/chat/rooms/') return send(201, { room: { slug: json.slug, name: json.name, role: 'owner', visibility: json.visibility } });
            if (req.method === 'POST' && /\/members$/.test(req.url)) return send(200, { ok: true, role: 'member' });
            if (req.method === 'POST' && /\/ai-members$/.test(req.url)) return send(201, { id: 1, name: json.name, handle: 'pantry' });
            return send(404, { error: 'No such room' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) })));
}

function serviceToken(t, cap) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({ iss: t.network.url, sub: 'svc:chat', actor_type: 'service', aud: ['openvibe.food'], cap, iat: now, exp: now + 300, jti: `tok_${crypto.randomUUID()}` }, t.network.privatePem);
}

(async () => {
    const chat = await startChat();
    const t = await boot({ env: { FOOD_CHAT_INTERNAL_URL: chat.url, FOOD_CHAT_PUBLIC_URL: 'https://openvibe.chat' } });
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    let id = null;
    try {
        await check('the owner starts the household chat: a private room as themselves, the members, and Pantry', async () => {
            const posted = await t.get('/plan', { as: kim, method: 'POST', form: { people: '2', days: '3', title: 'Our week' }, headers: SAME });
            id = new URL(posted.headers.get('location'), t.base).searchParams.get('saved');
            const shared = await t.get(`/plan/p/${id}/share`, { as: kim, method: 'POST', form: {}, headers: SAME });
            const secret = (/\/plan\/join\/([A-Za-z0-9_-]{43})/.exec(shared.text) || [])[1];
            assert.strictEqual((await t.get(`/plan/join/${secret}`, { as: lee, method: 'POST', form: {}, headers: SAME })).status, 303);
            await t.get('/api/v1/pantry', { json: { items: ['white-rice', 'canned-beans'] }, method: 'PUT', as: kim, headers: SAME });
            await t.get('/api/v1/pantry', { json: { items: ['onion-3lb'] }, method: 'PUT', as: lee, headers: SAME });

            const before = await t.get(`/plan/p/${id}`, { as: kim });
            assert.ok(before.text.includes('Start the household chat'));
            assert.strictEqual((await t.get(`/plan/p/${id}/chat`, { as: lee, method: 'POST', form: {}, headers: SAME })).status, 403, 'only the owner');
            const started = await t.get(`/plan/p/${id}/chat`, { as: kim, method: 'POST', form: {}, headers: SAME });
            assert.strictEqual(started.status, 303, started.text.slice(0, 200));
            const slug = `household-${id.slice(-10).toLowerCase()}`;
            const room = chat.calls.find((c) => c.method === 'POST' && c.url === '/api/chat/rooms/');
            assert.deepStrictEqual([room.json.slug, room.json.visibility, room.json.name], [slug, 'private', 'Our week household']);
            assert.match(room.auth, /^Bearer ey/, 'as the owner, with their own Network token');
            const member = chat.calls.find((c) => c.url === `/api/chat/rooms/${slug}/members`);
            assert.deepStrictEqual(member.json, { subject: lee.subject, role: 'member' }, 'members by account subject');
            const ai = chat.calls.find((c) => c.url === `/api/chat/rooms/${slug}/ai-members`);
            assert.deepStrictEqual([ai.json.name, ai.json.link_service, ai.json.link_resource], ['Pantry', 'food', id]);

            const page = await t.get(`/plan/p/${id}`, { as: lee });
            assert.ok(page.text.includes(`href="https://openvibe.chat/r/${slug}"`), 'every member gets the link');
            assert.ok(page.text.includes('@pantry'));
            const again = await t.get(`/plan/p/${id}/chat`, { as: kim, method: 'POST', form: {}, headers: SAME });
            assert.strictEqual(again.status, 303);
            assert.strictEqual(chat.calls.filter((c) => c.url === '/api/chat/rooms/').length, 1, 'one room per household');
        });

        await check('Chat reads the household with food.household.read: the plan, what is left to buy, every cupboard', async () => {
            const r = await t.get(`/internal/households/${id}/chat-context`, { bearer: serviceToken(t, ['food.household.read']) });
            assert.strictEqual(r.status, 200, r.text);
            const b = r.json();
            assert.strictEqual(b.source, 'OpenVibe.Food household');
            assert.ok(b.text.includes('Plan "Our week": 2 people, 3 days'), b.text);
            assert.ok(b.text.includes('Still to buy:'));
            assert.match(b.text, /The owner's cupboard: .*rice/i);
            assert.match(b.text, /lee's cupboard: .*onion/i);
            assert.strictEqual((await t.get(`/internal/households/${id}/chat-context`, { bearer: serviceToken(t, ['food.pantry.read']) })).status, 403, 'without the capability');
            assert.strictEqual((await t.get(`/internal/households/${id}/chat-context`, { as: kim })).status, 403, 'never a person');
            assert.strictEqual((await t.get('/internal/households/pln_00000000000000000000000000/chat-context', { bearer: serviceToken(t, ['food.household.read']) })).status, 404);
        });
    } finally { await t.close(); await chat.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
