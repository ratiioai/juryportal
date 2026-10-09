const express = require('express');
const { createApp } = require('./server');
const { hostedDatabase, initializeCloud } = require('./database/adapter');
const { HostedConfigurationError, sessionSecret } = require('./database/config');

// Vercel's recognized Express entry point. Persistent data is always remote here.
function createHostedApp({ connect = hostedDatabase, initialize = initializeCloud } = {}) {
    const app = express();
    let initialized;
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!initialized) initialized = (async () => {
        const secret = sessionSecret();
        const db = connect();
        try { await initialize(db); } catch (error) { db.close(); throw error; }
        process.env.HTTPS_ONLY = '1'; process.env.TRUST_PROXY = '1';
        return createApp({ db, sessionSecret: secret });
    })().catch(error => { initialized = undefined; throw error; });
    try { (await initialized)(req, res, next); }
    catch (error) {
        console.error('Hosted startup failed:', error.message);
        const response = { error: 'Portal setup is incomplete or the database is unavailable. Contact the administrator.', code: 'HOSTED_STARTUP_FAILED' };
        if (error instanceof HostedConfigurationError) {
            response.code = 'HOSTED_CONFIGURATION_INVALID';
            response.settings = error.settings;
        }
        res.status(503).json(response);
    }
    });
    return app;
}
module.exports = createHostedApp();
module.exports.createHostedApp = createHostedApp;
