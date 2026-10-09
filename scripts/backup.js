const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const source = process.env.DB_PATH || path.join(__dirname, '../database/database.db');
const directory = path.join(__dirname, '../backups');
fs.mkdirSync(directory, { recursive: true });
const db = new Database(source, { readonly: true, fileMustExist: true });
const target = path.join(directory, `manual-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
db.backup(target).then(() => { console.log(`Backup saved: ${target}`); }).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.close());
