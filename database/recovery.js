const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./database');

// Restore only into a new file, so recovery cannot overwrite the live database.
function restoreSnapshot(snapshot, destination) {
    const tables = ['users', 'venues', 'criteria', 'teams', 'juries', 'assignments', 'evaluations', 'evaluation_scores', 'audit_logs'];
    if (snapshot?.format !== 'juryportal-backup-v1' || !tables.every(table => Array.isArray(snapshot.tables?.[table]))) throw new Error('Not a complete JuryPortal backup.');
    if (snapshot.tables.event_rounds !== undefined) {
        if (!Array.isArray(snapshot.tables.event_rounds)) throw new Error('Invalid round history in backup.');
        tables.push('event_rounds');
    }
    const filename = path.resolve(destination);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.closeSync(fs.openSync(filename, 'wx'));
    const db = openDatabase(filename);
    try {
        db.transaction(() => {
            for (const table of [...tables].reverse()) db.prepare(`DELETE FROM ${table}`).run();
            for (const table of tables) {
                const columns = db.pragma(`table_info(${table})`).map(c => c.name);
                const insert = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
                for (const row of snapshot.tables[table]) {
                    if (Object.keys(row).some(key => !columns.includes(key))) throw new Error(`Unexpected columns in ${table}.`);
                    insert.run(...columns.map(column => row[column] ?? null));
                }
            }
            if (!db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").get()) throw new Error('Backup has no active administrator.');
            if (db.prepare('SELECT COUNT(*) AS n FROM event_rounds WHERE archived_at IS NULL').get().n !== 1) throw new Error('Backup must have exactly one active judging round.');
            if (db.pragma('foreign_key_check').length || db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Backup failed database integrity checks.');
        })();
        return filename;
    } finally { db.close(); }
}
module.exports = { restoreSnapshot };
