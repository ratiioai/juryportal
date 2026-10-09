const fs = require('node:fs');
const { restoreSnapshot } = require('../database/recovery');
const [source, destination] = process.argv.slice(2);
if (!source || !destination) {
    console.error('Usage: node scripts/restore-backup.js downloaded-backup.json new-database.db');
    process.exitCode = 1;
} else {
    try { console.log(`Recovered database: ${restoreSnapshot(JSON.parse(fs.readFileSync(source, 'utf8')), destination)}`); }
    catch (error) { console.error(`Recovery failed: ${error.message}`); process.exitCode = 1; }
}
