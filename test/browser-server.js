// Disposable localhost-only fixture for browser acceptance checks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcrypt');
const { openDatabase } = require('../database/database');
const { createApp } = require('../server');
process.env.ADMIN_PASSWORD = 'Browser-test-only-2026';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'juryportal-browser-'));
const db = openDatabase(path.join(directory, 'test.db'));
db.prepare('UPDATE users SET must_change_password = 0').run();
db.prepare('INSERT INTO venues (name, capacity) VALUES (?, ?)').run('Main Hall', 100);
db.prepare('INSERT INTO venues (name, capacity) VALUES (?, ?)').run('Other Hall', 100);
db.prepare('INSERT INTO criteria (name, max_marks, display_order) VALUES (?, ?, ?)').run('Innovation', 10, 1);
db.prepare('INSERT INTO criteria (name, max_marks, display_order) VALUES (?, ?, ?)').run('Execution', 10, 2);
const hash = bcrypt.hashSync('Browser-jury-only-2026', 12);
for (let i = 1; i <= 2; i++) {
    db.prepare("INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, 'jury')").run(`Judge ${i}`, `judge${i}`, hash);
    db.prepare('INSERT INTO juries (name, username, password_hash, venue_id) VALUES (?, ?, ?, 1)').run(`Judge ${i}`, `judge${i}`, hash);
}
for (let i = 1; i <= 3; i++) db.prepare('INSERT INTO teams (team_number, team_name, venue_id) VALUES (?, ?, ?)').run(`T00${i}`, i === 1 ? 'Alpha "One" <img src=x onerror=alert(1)>' : `Team ${i}`, i === 3 ? 2 : 1);
db.prepare('INSERT INTO assignments (team_id, jury_id, venue_id) SELECT t.id, u.id, 1 FROM teams t CROSS JOIN users u WHERE t.venue_id = 1 AND u.role = ?').run('jury');
const server = createApp({ db, backupDir: path.join(directory, 'backups') }).listen(3101, '127.0.0.1', () => console.log('Browser test at http://127.0.0.1:3101. Test data only.'));
const keepAlive = setInterval(() => {}, 1000);
server.on('error', error => { console.error(error); clearInterval(keepAlive); db.close(); process.exitCode = 1; });
function close() { server.close(() => {
    clearInterval(keepAlive);
    db.close();
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('juryportal-browser-')) throw new Error('Unsafe browser fixture cleanup target.');
    fs.rmSync(resolved, { recursive: true, force: true }); process.exit(0);
}); }
process.on('SIGINT', close); process.on('SIGTERM', close);
