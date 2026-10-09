const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

function openDatabase(filename = process.env.DB_PATH || path.join(__dirname, 'database.db')) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    const db = new Database(filename);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    for (const [table, name, definition] of [
        ['users', 'session_version', 'INTEGER NOT NULL DEFAULT 0'],
        ['users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0'],
        ['evaluations', 'revision', 'INTEGER NOT NULL DEFAULT 1'],
        ['event_rounds', 'removed_at', 'TEXT']
    ]) {
        if (!db.pragma(`table_info(${table})`).some(column => column.name === name)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS assignments_jury ON assignments(jury_id);
        CREATE INDEX IF NOT EXISTS evaluations_jury ON evaluations(jury_id);
        CREATE INDEX IF NOT EXISTS scores_evaluation ON evaluation_scores(evaluation_id);
        CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);`);
    const admin = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get();
    if (!admin) {
        const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
        db.prepare('INSERT INTO users (name, username, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)')
            .run('System Administrator', 'admin', bcrypt.hashSync(password, 12), 'admin');
        if (!process.env.ADMIN_PASSWORD) console.log(`Initial administrator: admin / ${password} (change at first login)`);
    } else if (bcrypt.compareSync('admin123', admin.password_hash)) {
        db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(admin.id);
    }
    return db;
}

async function clearDb(db) {
    await db.transaction(async () => {
        // Preserve audit history and IDs so old IDs cannot refer to new records.
        const statements = [
            ...['evaluation_scores', 'evaluations', 'assignments', 'criteria', 'juries', 'teams', 'venues'].map(table => `DELETE FROM ${table}`),
            "DELETE FROM users WHERE role = 'jury'", 'DELETE FROM sessions', 'UPDATE users SET session_version = session_version + 1'
        ];
        if (db.batch) await db.batch(statements);
        else for (const sql of statements) await db.prepare(sql).run();
    });
}
module.exports = { openDatabase, clearDb };
