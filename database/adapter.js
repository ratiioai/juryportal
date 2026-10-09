const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { databaseSettings, adminPassword: validateAdminPassword } = require('./config');

// Both deployment modes use SQLite SQL and the same awaited application queries.
function localAdapter(raw) {
    const context = new AsyncLocalStorage(); let tail = Promise.resolve();
    const locked = work => {
        if (context.getStore()) return work();
        const result = tail.then(() => context.run(true, work)); tail = result.catch(() => {}); return result;
    };
    return { name: raw.name, hosted: false,
        prepare(sql) { return Object.fromEntries(['get', 'all', 'run'].map(method => [method, (...args) => locked(() => raw.prepare(sql)[method](...args))])); },
        transaction(work) { return locked(async () => {
            if (raw.inTransaction) return work();
            raw.exec('BEGIN IMMEDIATE');
            try { const result = await work(); raw.exec('COMMIT'); return result; }
            catch (error) { raw.exec('ROLLBACK'); throw error; }
        }); },
        backup(filename) { return locked(() => raw.backup(filename)); },
        batch(statements, mode = 'write') { return locked(() => {
            const execute = () => statements.map(statement => {
                const sql = typeof statement === 'string' ? statement : statement.sql;
                const args = typeof statement === 'string' ? [] : statement.args || [];
                const query = raw.prepare(sql);
                if (query.reader) return { rows: query.all(...args), rowsAffected: 0 };
                const result = query.run(...args);
                return { rows: [], rowsAffected: result.changes, lastInsertRowid: result.lastInsertRowid };
            });
            if (raw.inTransaction) return execute();
            raw.exec(mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
            try { const result = execute(); raw.exec('COMMIT'); return result; }
            catch (error) { raw.exec('ROLLBACK'); throw error; }
        }); },
        close() { raw.close(); }
    };
}

function cloudAdapter(client) {
    const context = new AsyncLocalStorage();
    const adapter = { hosted: true, name: 'hosted',
        prepare(sql) {
            const execute = async args => (context.getStore() || client).execute({ sql, args });
            return {
                get: async (...args) => (await execute(args)).rows[0],
                all: async (...args) => (await execute(args)).rows.map(row => ({ ...row })),
                run: async (...args) => { const result = await execute(args); return { lastInsertRowid: Number(result.lastInsertRowid), changes: result.rowsAffected }; }
            };
        },
        async transaction(work) {
            if (context.getStore()) return work();
            const tx = await client.transaction('write');
            try { const result = await context.run(tx, work); await tx.commit(); return result; }
            catch (error) { if (!tx.closed) await tx.rollback(); throw error; }
            finally { tx.close(); }
        },
        batch(statements, mode = 'write') { return context.getStore() ? context.getStore().batch(statements) : client.batch(statements, mode); },
        async readTransaction(work) {
            if (context.getStore()) return work();
            const tx = await client.transaction('read');
            try { return await context.run(tx, work); } finally { tx.close(); }
        },
        close() { client.close(); }
    };
    return adapter;
}

async function initializeCloud(db, adminPassword = process.env.ADMIN_PASSWORD) {
    validateAdminPassword(adminPassword);
    const metadata = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'portal_meta'").get();
    if (metadata && (await db.prepare("SELECT value FROM portal_meta WHERE key = 'schema_version'").get())?.value === '2') return;
    const hash = await bcrypt.hash(adminPassword, 12);
    await db.transaction(async () => {
        // No local database file is read or written in hosted mode.
        const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
        await db.batch(schema.split(';').filter(s => s.trim()));
        const [users, evaluations] = await db.batch(['PRAGMA table_info(users)', 'PRAGMA table_info(evaluations)']);
        const migrations = [];
        for (const [table, name, definition] of [['users', 'session_version', 'INTEGER NOT NULL DEFAULT 0'], ['users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0'], ['evaluations', 'revision', 'INTEGER NOT NULL DEFAULT 1']]) {
            const columns = table === 'users' ? users.rows : evaluations.rows;
            if (!columns.some(c => c.name === name)) migrations.push(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        }
        await db.batch([...migrations,
            'CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)',
            'CREATE TABLE IF NOT EXISTS event_backups (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, created_at TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS portal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
            'CREATE INDEX IF NOT EXISTS assignments_jury ON assignments(jury_id)',
            'CREATE INDEX IF NOT EXISTS evaluations_jury ON evaluations(jury_id)',
            'CREATE INDEX IF NOT EXISTS scores_evaluation ON evaluation_scores(evaluation_id)',
            'CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires)'
        ]);
        const admin = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
        if (!admin) await db.prepare("INSERT INTO users (name, username, password_hash, role, must_change_password) VALUES ('System Administrator', 'admin', ?, 'admin', 1)").run(hash);
        await db.prepare("INSERT OR REPLACE INTO portal_meta (key, value) VALUES ('schema_version', '2')").run();
    });
}

async function snapshot(db, { includeRounds = true } = {}) {
    const collect = async () => {
        const tables = {};
        const names = ['users', 'venues', 'criteria', 'teams', 'juries', 'assignments', 'evaluations', 'evaluation_scores', 'audit_logs'];
        if (includeRounds) names.push('event_rounds');
        if (db.batch) {
            const results = await db.batch(names.map(table => `SELECT * FROM ${table} ORDER BY id`));
            names.forEach((table, i) => { tables[table] = results[i].rows.map(row => ({ ...row })); });
        } else for (const table of names) tables[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
        return { format: 'juryportal-backup-v1', created_at: new Date().toISOString(), tables };
    };
    return db.readTransaction ? db.readTransaction(collect) : db.transaction(collect);
}

function hostedDatabase() {
    const { url, authToken } = databaseSettings();
    const { createClient } = require('@libsql/client/web');
    return cloudAdapter(createClient({ url, authToken }));
}
module.exports = { localAdapter, cloudAdapter, initializeCloud, snapshot, hostedDatabase };
