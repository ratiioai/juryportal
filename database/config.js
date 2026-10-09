// Configuration errors contain only fixed descriptions, never supplied values.
class HostedConfigurationError extends Error {
    constructor(settings) {
        super(settings.map(({ name, reason }) => `${name}: ${reason}`).join('; '));
        this.settings = settings;
    }
}

function databaseSettings(env = process.env) {
    const url = (env.TURSO_DATABASE_URL || '').trim();
    const authToken = (env.TURSO_AUTH_TOKEN || '').trim();
    const settings = [];
    if (!url) settings.push({ name: 'TURSO_DATABASE_URL', reason: 'Missing or empty in this deployment.' });
    else {
        let valid = false;
        try {
            const parsed = new URL(url);
            valid = ['libsql:', 'https:'].includes(parsed.protocol) && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
        } catch {}
        if (!valid) settings.push({ name: 'TURSO_DATABASE_URL', reason: 'Use a libsql:// or https:// database URL without quotes or a variable-name prefix.' });
    }
    if (!authToken) settings.push({ name: 'TURSO_AUTH_TOKEN', reason: 'Missing or empty in this deployment.' });
    if (settings.length) throw new HostedConfigurationError(settings);
    return { url, authToken };
}

function sessionSecret(value = process.env.SESSION_SECRET) {
    if (!value || value.trim().length < 32) throw new HostedConfigurationError([{ name: 'SESSION_SECRET', reason: 'Set at least 32 random characters in this deployment.' }]);
    return value;
}

function adminPassword(value = process.env.ADMIN_PASSWORD) {
    if (!value || value.length < 10 || Buffer.byteLength(value) > 72) throw new HostedConfigurationError([{ name: 'ADMIN_PASSWORD', reason: 'Set an initial password with at least 10 characters and at most 72 bytes in this deployment.' }]);
    return value;
}

module.exports = { HostedConfigurationError, databaseSettings, sessionSecret, adminPassword };
