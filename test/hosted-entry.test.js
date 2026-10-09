const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { cloudAdapter, initializeCloud } = require('../database/adapter');

test('Vercel entry rejects missing setup without falling back to a local database', async t => {
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    delete process.env.SESSION_SECRET;
    const app = require('../app');
    const server = app.listen(0, '127.0.0.1');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/api/health`;
    const first = await fetch(url);
    assert.equal(first.status, 503);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(first.headers.get('x-powered-by'), null);
    const firstBody = await first.json();
    assert.match(firstBody.error, /setup is incomplete|database is unavailable/);
    assert.equal(firstBody.code, 'HOSTED_CONFIGURATION_INVALID');
    assert.deepEqual(firstBody.settings.map(s => s.name), ['SESSION_SECRET']);
    process.env.SESSION_SECRET = 'test-only-hosted-entry-secret-32-characters';
    const second = await fetch(url);
    assert.equal(second.status, 503);
    const secondBody = await second.json();
    assert.match(secondBody.error, /setup is incomplete|database is unavailable/);
    assert.deepEqual(secondBody.settings.map(s => s.name), ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']);
    process.env.TURSO_DATABASE_URL = 'TURSO_DATABASE_URL=libsql://private-database.example';
    process.env.TURSO_AUTH_TOKEN = 'private-token-never-expose';
    const malformed = await fetch(url);
    assert.equal(malformed.status, 503);
    const malformedBody = await malformed.json();
    assert.deepEqual(malformedBody.settings.map(s => s.name), ['TURSO_DATABASE_URL']);
    assert.doesNotMatch(JSON.stringify(malformedBody), /private-database|private-token/);
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
});

test('hosted instances share secure sessions and scores; failed startup can recover', async t => {
    process.env.SESSION_SECRET = 'test-only-hosted-entry-secret-32-characters';
    process.env.ADMIN_PASSWORD = 'Hosted-initial-test-2026';
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'juryportal-hosted-'));
    const databaseURL = pathToFileURL(path.join(directory, 'hosted.db')).href;
    const { createClient } = require('@libsql/client');
    const clients = [], servers = [];
    const connect = () => { const client = createClient({ url: databaseURL }); clients.push(client); return cloudAdapter(client); };
    t.after(async () => {
        for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        for (const client of clients) client.close();
        const resolved = path.resolve(directory);
        if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('juryportal-hosted-')) throw new Error('Unsafe test cleanup target.');
        if (process.platform === 'win32' && process.env.JURY_TEST_CLEANUP_LIST) fs.appendFileSync(process.env.JURY_TEST_CLEANUP_LIST, JSON.stringify(resolved) + '\n');
        else await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    const { createHostedApp } = require('../app');
    let initializations = 0;
    async function start(initialize = initializeCloud) {
        const server = createHostedApp({ connect, initialize }).listen(0, '127.0.0.1'); servers.push(server);
        await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`;
    }
    const first = await start(async db => { initializations++; await initializeCloud(db); });
    const health = await Promise.all([fetch(first + '/api/health'), fetch(first + '/api/health')]);
    assert.deepEqual(health.map(r => r.status), [200, 200]); assert.equal(initializations, 1);
    const second = await start();
    const browser = () => ({ cookie: '', round: null, async request(base, route, body) {
        const headers = { 'X-Forwarded-Proto': 'https', 'X-Requested-With': 'JuryPortal', Cookie: this.cookie, ...(this.round ? { 'X-Portal-Round': String(this.round) } : {}) };
        if (body) headers['Content-Type'] = 'application/json';
        const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
        if (response.ok && response.headers.get('x-portal-round')) this.round = Number(response.headers.get('x-portal-round'));
        const setCookie = response.headers.get('set-cookie'); if (setCookie) this.cookie = setCookie.split(';')[0];
        return { status: response.status, data: await response.json(), setCookie };
    } });
    const admin = browser();
    const login = await admin.request(first, '/api/login', { username: 'admin', password: process.env.ADMIN_PASSWORD });
    assert.equal(login.status, 200); assert.match(login.setCookie, /Secure/); assert.match(login.setCookie, /HttpOnly/); assert.match(login.setCookie, /SameSite=Strict/);
    assert.equal((await admin.request(second, '/api/me')).status, 200);
    assert.equal((await admin.request(second, '/api/password', { current_password: process.env.ADMIN_PASSWORD, new_password: 'Hosted-secure-test-2026' })).status, 200);
    assert.equal((await admin.request(first, '/api/me')).status, 200);
    const venue = (await admin.request(first, '/api/venues', { name: 'Shared Hall', capacity: 120 })).data.id;
    const criterion = (await admin.request(second, '/api/criteria', { name: 'Quality', max_marks: 20, display_order: 1 })).data.id;
    for (const username of ['jury1', 'jury2']) assert.equal((await admin.request(first, '/api/juries', { name: username, username, password: 'Hosted-jury-test-2026', venue_id: venue, active: 1 })).status, 200);
    const team = (await admin.request(second, '/api/teams', { team_number: 'H001', team_name: 'Shared Team', venue_id: venue })).data.id;
    for (const [username, score] of [['jury1', 15], ['jury2', 20]]) {
        const jury = browser(); assert.equal((await jury.request(first, '/api/login', { username, password: 'Hosted-jury-test-2026' })).status, 200);
        assert.equal((await jury.request(second, '/api/evaluations', { team_id: team, action: 'submit', scores: { [criterion]: score }, revision: 0 })).status, 200);
    }
    const board = await admin.request(first, '/api/leaderboard'); assert.equal(board.data[0].final_score, '17.50');
    let attempts = 0;
    const recovering = await start(async db => { if (++attempts === 1) throw new Error('Simulated temporary connection failure'); await initializeCloud(db); });
    const failed = await fetch(recovering + '/api/health');
    assert.equal(failed.status, 503);
    const failedBody = await failed.json();
    assert.equal(failedBody.code, 'HOSTED_STARTUP_FAILED');
    assert.equal(failedBody.settings, undefined);
    assert.doesNotMatch(JSON.stringify(failedBody), /Simulated temporary connection failure/);
    assert.equal((await admin.request(recovering, '/api/me')).status, 200);
    assert.equal((await admin.request(recovering, '/api/leaderboard')).data[0].final_score, '17.50');
    assert.equal(attempts, 2);
});
