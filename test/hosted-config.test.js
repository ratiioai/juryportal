const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HostedConfigurationError, databaseSettings, sessionSecret, adminPassword } = require('../database/config');

test('hosted configuration identifies missing settings without including their values', () => {
    assert.throws(() => databaseSettings({}), error => {
        assert.ok(error instanceof HostedConfigurationError);
        assert.deepEqual(error.settings.map(s => s.name), ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']);
        return true;
    });
    for (const url of ['"libsql://private.example"', 'turso://private.example', 'TURSO_DATABASE_URL=libsql://private.example', 'https://user:secret@private.example', 'libsql://']) {
        assert.throws(() => databaseSettings({ TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: 'private-token' }), error => {
            assert.deepEqual(error.settings.map(s => s.name), ['TURSO_DATABASE_URL']);
            assert.doesNotMatch(error.message + JSON.stringify(error.settings), /private|secret@/);
            return true;
        });
    }
    assert.throws(() => databaseSettings({ TURSO_DATABASE_URL: 'libsql://test.example', TURSO_AUTH_TOKEN: '  ' }), error => error.settings[0].name === 'TURSO_AUTH_TOKEN');
});

test('valid hosted configuration trims database paste whitespace and checks secret limits', () => {
    assert.deepEqual(databaseSettings({ TURSO_DATABASE_URL: ' libsql://test.example\n', TURSO_AUTH_TOKEN: ' token\n' }), { url: 'libsql://test.example', authToken: 'token' });
    assert.equal(databaseSettings({ TURSO_DATABASE_URL: 'https://test.example', TURSO_AUTH_TOKEN: 'token' }).url, 'https://test.example');
    assert.equal(sessionSecret('a'.repeat(32)), 'a'.repeat(32));
    assert.throws(() => sessionSecret(' '.repeat(32)), HostedConfigurationError);
    assert.throws(() => sessionSecret('short-private-secret'), error => !error.message.includes('short-private-secret'));
    assert.equal(adminPassword('valid-private-password'), 'valid-private-password');
    for (const password of ['', 'short', 'a'.repeat(73), 'é'.repeat(37)]) assert.throws(() => adminPassword(password), HostedConfigurationError);
});
