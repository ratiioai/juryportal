const express = require('express');
const { createApp } = require('./server');
const { hostedDatabase, initializeCloud } = require('./database/adapter');

// Vercel's recognized Express entry point. Persistent data is always remote here.
function createHostedApp({ connect = hostedDatabase, initialize = initializeCloud } = {}) {
    const app = express();
    let initialized;
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!initialized) initialized = (async () => {
        if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('Set SESSION_SECRET to at least 32 random characters.');
        const db = connect();
        try { await initialize(db); } catch (error) { db.close(); throw error; }
        process.env.HTTPS_ONLY = '1'; process.env.TRUST_PROXY = '1';
        return createApp({ db, sessionSecret: process.env.SESSION_SECRET });
    })().catch(error => { initialized = undefined; throw error; });
    try { (await initialized)(req, res, next); }
    catch (error) { console.error('Hosted startup failed:', error.message); res.status(503).json({ error: 'Portal setup is incomplete or the database is unavailable. Contact the administrator.' }); }
    });
    return app;
}
module.exports = createHostedApp();
module.exports.createHostedApp = createHostedApp;
