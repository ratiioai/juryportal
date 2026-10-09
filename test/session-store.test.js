const { test } = require('node:test');
const assert = require('node:assert/strict');
const SQLiteSessionStore = require('../database/session-store');

test('reading a fixed-expiry session never triggers touch writes or session cleanup', async () => {
    const queries = [];
    const expires = Date.now() + 100000;
    const store = new SQLiteSessionStore({ prepare(sql) {
        queries.push(sql);
        return { async get(sid, now) { assert.equal(sid, 'test-session'); assert.ok(now < expires); return { data: JSON.stringify({ user: { id: 1 }, cookie: { expires: new Date(expires).toISOString() } }) }; } };
    } });
    const value = await new Promise((resolve, reject) => store.get('test-session', (error, data) => error ? reject(error) : resolve(data)));
    await new Promise((resolve, reject) => store.touch('test-session', value, error => error ? reject(error) : resolve()));
    assert.equal(queries.length, 1); assert.match(queries[0], /expires > \?/);
    assert.equal(new Date(value.cookie.expires).getTime(), expires);
});
