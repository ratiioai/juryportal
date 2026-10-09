const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse } = require('csv-parse/sync');
const ExcelJS = require('exceljs');
const { openDatabase } = require('../database/database');
const { createApp } = require('../server');
const { cloudAdapter, initializeCloud } = require('../database/adapter');
const { pathToFileURL } = require('node:url');
const { restoreSnapshot } = require('../database/recovery');

process.env.ADMIN_PASSWORD = 'Initial-admin-2026';
const adminPassword = 'Secure-admin-2026';
const juryPassword = 'Secure-jury-2026';
const secret = 'test-only-session-secret-of-more-than-32-characters';
async function removeFixture(directory) {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('juryportal-')) throw new Error('Unsafe test cleanup target.');
    // Windows libSQL retains native WAL handles until its test process exits.
    // The parent runner removes these fixtures after all native handles are gone.
    if (process.platform === 'win32' && process.env.JURY_TEST_MODE === 'cloud' && process.env.JURY_TEST_CLEANUP_LIST) {
        fs.appendFileSync(process.env.JURY_TEST_CLEANUP_LIST, JSON.stringify(resolved) + '\n');
        return;
    }
    await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

async function fixture(filename = ':memory:') {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'juryportal-test-'));
    const db = openDatabase(process.env.JURY_TEST_MODE === 'cloud' && filename === ':memory:' ? path.join(backupDir, 'cloud.db') : filename);
    let applicationDb = db;
    if (process.env.JURY_TEST_MODE === 'cloud') {
        const client = require('@libsql/client').createClient({ url: pathToFileURL(db.name).href });
        applicationDb = cloudAdapter(client); await initializeCloud(applicationDb);
    }
    const server = createApp({ db: applicationDb, sessionSecret: secret, backupDir }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const client = (cookie = '') => ({ cookie,
        async request(url, body, method = body === undefined ? 'GET' : 'POST', extra = {}) {
            const headers = { 'X-Requested-With': 'JuryPortal', Cookie: this.cookie, ...extra };
            const options = { method, headers };
            if (body !== undefined) {
                if (body instanceof FormData) options.body = body;
                else { options.body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
            }
            const response = await fetch(base + url, options);
            if (response.headers.get('set-cookie')) this.cookie = response.headers.get('set-cookie').split(';')[0];
            const raw = await response.text();
            let data; try { data = JSON.parse(raw); } catch { data = raw; }
            return { status: response.status, data, headers: response.headers };
        }
    });
    const admin = client();
    const login = await admin.request('/api/login', { username: 'admin', password: filename === ':memory:' ? process.env.ADMIN_PASSWORD : adminPassword });
    if (login.status !== 200 && filename !== ':memory:') {
        assert.equal((await admin.request('/api/login', { username: 'admin', password: process.env.ADMIN_PASSWORD })).status, 200);
    }
    if ((await admin.request('/api/me')).data.must_change_password) {
        assert.equal((await admin.request('/api/password', { current_password: process.env.ADMIN_PASSWORD, new_password: adminPassword })).status, 200);
    }
    return { db, admin, client, server, backupDir, base,
        async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (applicationDb !== db) applicationDb.close(); db.close(); await removeFixture(backupDir); } };
}
async function setup(f) {
    const a = f.admin;
    const venue = (await a.request('/api/venues', { name: 'Hall A', capacity: '100' })).data.id;
    const otherVenue = (await a.request('/api/venues', { name: 'Hall B', capacity: 100 })).data.id;
    const c1 = (await a.request('/api/criteria', { name: 'Innovation', max_marks: 10, display_order: 1 })).data.id;
    const c2 = (await a.request('/api/criteria', { name: 'Execution', max_marks: 10, display_order: 2 })).data.id;
    const createJury = async (name, where = venue, enabled = '1') => {
        const created = await a.request('/api/juries', { name, username: name.toLowerCase(), password: juryPassword, venue_id: where, active: enabled });
        assert.equal(created.status, 200, JSON.stringify(created.data));
        const client = f.client();
        if (enabled === '1') assert.equal((await client.request('/api/login', { username: name.toLowerCase(), password: juryPassword })).status, 200);
        return { id: created.data.id, client };
    };
    const j1 = await createJury('Judge1'), j2 = await createJury('Judge2');
    const createTeam = async (number, where = venue, name = `Team ${number}`) => {
        const created = await a.request('/api/teams', { team_number: number, team_name: name, venue_id: where });
        assert.equal(created.status, 200); return created.data.id;
    };
    const t1 = await createTeam('001'), t2 = await createTeam('002'), otherTeam = await createTeam('003', otherVenue);
    const scores = (a, b) => ({ [c1]: a, [c2]: b });
    const save = (j, team, values, action = 'draft', revision = 0) => j.client.request('/api/evaluations', { team_id: team, action, scores: values, revision });
    return { venue, otherVenue, c1, c2, j1, j2, t1, t2, otherTeam, createJury, createTeam, scores, save };
}

test('authentication, CSRF, inactive accounts and session revocation', async t => {
    const f = await fixture(); t.after(() => f.close()); const s = await setup(f);
    assert.equal((await f.client().request('/api/teams')).status, 401);
    assert.equal((await s.j1.client.request('/api/teams')).status, 403);
    assert.equal((await f.admin.request('/api/venues', { name: 'Unsafe', capacity: 10 }, 'POST', { 'X-Requested-With': '' })).status, 403);
    assert.equal((await f.admin.request('/api/venues', { name: 'Unsafe', capacity: 10 }, 'POST', { Origin: 'https://evil.example' })).status, 403);
    const disabled = await s.createJury('Disabled', s.venue, '0');
    assert.equal(f.db.prepare('SELECT active FROM users WHERE id = ?').get(disabled.id).active, 0);
    assert.equal((await disabled.client.request('/api/login', { username: 'disabled', password: juryPassword })).status, 401);
    assert.equal((await f.admin.request(`/api/juries/${s.j1.id}`, { name: 'Judge1', username: 'judge1', password: '', venue_id: s.venue, active: '0' }, 'PUT')).status, 200);
    assert.equal((await s.j1.client.request('/api/jury/teams')).status, 401);
    assert.equal((await f.admin.request(`/api/juries/${1}`, undefined, 'DELETE')).status, 404);
    assert.match((await f.admin.request('/admin.html')).headers.get('content-security-policy'), /script-src 'self'/);
    assert.match((await f.admin.request('/api/me')).headers.get('cache-control'), /no-store/);
});

test('automatic venue assignment, cross-venue exceptions and safe reassignment', async t => {
    const f = await fixture(); t.after(() => f.close()); const s = await setup(f);
    assert.equal((await s.j1.client.request('/api/jury/teams')).data.length, 2);
    assert.equal((await s.save(s.j1, s.otherTeam, s.scores(5, 5))).status, 403);
    assert.equal((await s.j1.client.request(`/api/evaluations/${s.otherTeam}`)).status, 403);
    assert.equal((await f.admin.request(`/api/juries/${s.j1.id}/assignments`, { team_id: s.otherTeam })).status, 200);
    assert.equal((await s.j1.client.request('/api/jury/teams')).data.length, 3);
    assert.equal((await f.admin.request(`/api/juries/${s.j1.id}/assignments/${s.otherTeam}`, undefined, 'DELETE')).status, 200);
    assert.equal((await s.save(s.j1, s.otherTeam, s.scores(5, 5))).status, 403);
    assert.equal((await f.admin.request(`/api/teams/${s.t2}`, { team_number: '002', team_name: 'Moved', venue_id: s.otherVenue }, 'PUT')).status, 200);
    assert.equal((await s.j1.client.request('/api/jury/teams')).data.length, 1);
    assert.equal((await s.save(s.j1, s.t1, s.scores(5, 5))).status, 200);
    assert.equal((await f.admin.request(`/api/teams/${s.t1}`, { team_number: '001', team_name: 'Move scored', venue_id: s.otherVenue }, 'PUT')).status, 409);
    assert.equal((await f.admin.request(`/api/juries/${s.j1.id}/assignments/${s.t1}`, undefined, 'DELETE')).status, 409);
});

test('score bounds, revision conflicts, atomic bulk submission, lock and unlock', async t => {
    const f = await fixture(); t.after(() => f.close()); const s = await setup(f);
    assert.equal((await s.save(s.j1, s.t1, s.scores(11, 5))).status, 400);
    assert.equal((await s.save(s.j1, s.t1, s.scores(-1, 5))).status, 400);
    assert.equal((await s.save(s.j1, s.t1, s.scores('5junk', 5))).status, 400);
    assert.equal((await s.save(s.j1, s.t1, { 999: 4 })).status, 400);
    assert.equal((await s.save(s.j1, s.t1, s.scores(5, ''), 'submit')).status, 400);
    assert.equal((await s.save(s.j1, s.t1, s.scores(5, ''), 'draft')).status, 200);
    assert.equal((await s.save(s.j1, s.t1, s.scores(6, 6), 'draft')).status, 409);
    assert.equal((await s.save(s.j1, s.t2, s.scores(9, 9))).status, 200);
    assert.equal((await s.j1.client.request('/api/jury/submit-all', {})).status, 400);
    assert.equal(f.db.prepare('SELECT status FROM evaluations WHERE team_id = ? AND jury_id = ?').get(s.t2, s.j1.id).status, 'draft');
    assert.equal((await s.save(s.j1, s.t1, s.scores(0, 10), 'draft', 1)).status, 200);
    assert.equal((await s.j1.client.request('/api/jury/submit-all', {})).status, 200);
    assert.equal((await s.save(s.j1, s.t1, s.scores(1, 1), 'draft', 3)).status, 409);
    const evaluation = f.db.prepare('SELECT * FROM evaluations WHERE team_id = ? AND jury_id = ?').get(s.t1, s.j1.id);
    assert.equal(evaluation.total_score, 10);
    assert.equal((await f.admin.request(`/api/evaluations/${evaluation.id}/unlock`, { reason: '' })).status, 400);
    assert.equal((await f.admin.request(`/api/evaluations/${evaluation.id}/unlock`, { reason: 'Correction requested' })).status, 200);
    assert.equal((await s.save(s.j1, s.t1, s.scores(2, 2), 'submit', 3)).status, 409);
    assert.equal((await s.save(s.j1, s.t1, s.scores(2, 2), 'submit', 4)).status, 200);
    assert.equal((await f.admin.request('/api/criteria', { name: 'Late criterion', max_marks: 10, display_order: 3 })).status, 409);
});

test('CSV reconciles assignments, pending/draft scores, quoting, averages and ranks', async t => {
    const f = await fixture(); t.after(() => f.close()); const s = await setup(f);
    const special = 'Team "Quoted", Tamil தமிழ்\nSecond line';
    assert.equal((await f.admin.request(`/api/teams/${s.t1}`, { team_number: '001', team_name: special, venue_id: s.venue }, 'PUT')).status, 200);
    await s.save(s.j1, s.t1, s.scores(10, 10), 'submit');
    await s.save(s.j2, s.t1, s.scores(5, 5), 'submit');
    await s.save(s.j1, s.t2, s.scores(5, 5), 'draft');
    const response = await f.admin.request('/api/reports/detailed-results'); assert.equal(response.status, 200);
    const rows = parse(response.data, { columns: true, bom: true });
    const row = rows.find(r => r['Team Number'] === '001');
    assert.equal(row['Team Name'], special); assert.equal(row['Final Average'], '15.00'); assert.equal(row.Rank, '1');
    assert.equal(row['Jury 1 Innovation (max 10)'], '10'); assert.equal(row['Jury 2 Execution (max 10)'], '5');
    const pending = rows.find(r => r['Team Number'] === '002');
    assert.equal(pending['Jury 1 Status'], 'draft'); assert.equal(pending['Jury 2 Status'], 'pending');
    assert.equal(pending['Jury 2 Total'], ''); assert.equal(pending['Final Average'], '');
    assert.equal(rows.find(r => r['Team Number'] === '003')['Assigned Juries'], '0');
    await s.save(s.j1, s.t2, s.scores(5, 5), 'submit', 1); await s.save(s.j2, s.t2, s.scores(10, 10), 'submit');
    assert.deepEqual((await f.admin.request('/api/leaderboard')).data.map(t => t.rank), [1, 1]);
    const formulaTeam = await s.createTeam('004', s.otherVenue, '=HYPERLINK("https://example.com")');
    const safeCSV = parse((await f.admin.request('/api/reports/detailed-results')).data, { columns: true, bom: true });
    assert.ok(safeCSV.find(r => r['Team Number'] === '004')['Team Name'].startsWith("'=")); assert.ok(formulaTeam);
    assert.equal((await s.j1.client.request('/api/reports/detailed-results')).status, 403);
});

test('CSV and Excel imports preserve identifiers, reject invalid rows atomically', async t => {
    const f = await fixture(); t.after(() => f.close()); await setup(f);
    const upload = async (content, filename) => {
        const form = new FormData(); form.append('file', new Blob([content]), filename); return f.admin.request('/api/teams/import', form);
    };
    assert.equal((await upload('teamNumber,teamName,venue\r\n010,New Team,Hall A\r\n011,Bad Team,Unknown', 'teams.csv')).status, 400);
    assert.equal(f.db.prepare("SELECT id FROM teams WHERE team_number = '010'").get(), undefined);
    assert.equal((await upload('\uFEFFteamNumber,teamName,venue\r\n010,"Comma, Name",Hall A', 'teams.csv')).status, 200);
    assert.equal(f.db.prepare("SELECT team_name FROM teams WHERE team_number = '010'").get().team_name, 'Comma, Name');
    assert.equal((await upload('teamNumber,teamName,venue\n010,Duplicate,Hall A', 'teams.csv')).status, 400);
    assert.equal((await upload('teamNumber,teamName,venue\n012,One,Hall A\n012,Two,Hall A', 'teams.csv')).status, 400);
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Teams');
    sheet.addRow(['teamNumber', 'teamName', 'venue']); sheet.addRow(['00013', 'Excel Team', 'Hall B']);
    assert.equal((await upload(await workbook.xlsx.writeBuffer(), 'teams.xlsx')).status, 200);
    assert.ok(f.db.prepare("SELECT id FROM teams WHERE team_number = '00013'").get());
    assert.equal((await upload('garbage', 'teams.exe')).status, 400);
    assert.equal((await upload('x'.repeat(2 * 1024 * 1024 + 1), 'large.csv')).status, 400);
});

test('deletion preserves integrity; reset retains audit history and a restorable backup', async t => {
    const f = await fixture(); t.after(() => f.close()); const s = await setup(f);
    await s.save(s.j1, s.t1, s.scores(4, 5), 'submit');
    assert.equal((await f.admin.request(`/api/juries/${s.j1.id}`, undefined, 'DELETE')).status, 409);
    assert.equal((await f.admin.request(`/api/venues/${s.venue}`, undefined, 'DELETE')).status, 409);
    assert.equal((await f.admin.request(`/api/teams/${s.t1}`, undefined, 'DELETE')).status, 200);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM evaluation_scores').get().n, 0);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    assert.equal((await f.admin.request('/api/master-reset', { confirmation: 'yes' })).status, 400);
    const count = f.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;
    assert.equal((await f.admin.request('/api/master-reset', { confirmation: 'RESET EVENT' })).status, 200);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM teams').get().n, 0);
    assert.ok(f.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n > count);
    assert.equal((await f.admin.request('/api/me')).status, 401);
    if (process.env.JURY_TEST_MODE === 'cloud') {
        const saved = JSON.parse(f.db.prepare('SELECT data FROM event_backups ORDER BY id DESC LIMIT 1').get().data);
        assert.equal(saved.tables.teams.length, 2);
    } else {
        const backup = fs.readdirSync(f.backupDir).find(name => name.startsWith('before-reset-'));
        const Database = require('better-sqlite3'), restored = new Database(path.join(f.backupDir, backup), { readonly: true });
        assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM teams').get().n, 2); restored.close();
    }
});

test('sessions and saved scores survive a server restart', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'juryportal-restart-'));
    const filename = path.join(dir, 'event.db'); let f = await fixture(filename);
    t.after(async () => { await f.close(); await removeFixture(dir); });
    const s = await setup(f);
    await s.save(s.j1, s.t1, s.scores(7, 8)); const cookie = s.j1.client.cookie;
    await f.close(); f = await fixture(filename);
    const jury = f.client(cookie);
    assert.equal((await jury.request('/api/me')).status, 200);
    const data = (await jury.request(`/api/evaluations/${s.t1}`)).data;
    assert.equal(data.evaluation.total_score, 15); assert.equal(data.evaluation.revision, 1);
    assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
});

test('simultaneous saves cannot overwrite another tab or detach scored assignments', async t => {
    const f = await fixture(); t.after(() => f.close()); const s = await setup(f);
    const outcomes = await Promise.all([
        s.save(s.j1, s.t1, s.scores(3, 4)),
        s.save(s.j1, s.t1, s.scores(8, 9))
    ]);
    assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
    const saved = (await s.j1.client.request(`/api/evaluations/${s.t1}`)).data;
    assert.equal(saved.evaluation.revision, 1);
    assert.ok([7, 17].includes(saved.evaluation.total_score));
    const racing = await Promise.all([
        s.save(s.j2, s.t2, s.scores(6, 7)),
        f.admin.request(`/api/juries/${s.j2.id}/assignments/${s.t2}`, undefined, 'DELETE')
    ]);
    if (racing[0].status === 200) assert.equal(racing[1].status, 409);
    else { assert.equal(racing[0].status, 403); assert.equal(racing[1].status, 200); }
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM evaluations e LEFT JOIN assignments a
        ON a.team_id = e.team_id AND a.jury_id = e.jury_id WHERE a.id IS NULL`).get().n, 0);
});

test('hosted JSON backups recover scores into a new local database without overwriting files', async t => {
    if (process.env.JURY_TEST_MODE !== 'cloud') return t.skip('Hosted backup format only');
    const f = await fixture(); t.after(() => f.close()); const s = await setup(f);
    assert.equal((await s.save(s.j1, s.t1, s.scores(8, 7), 'submit')).status, 200);
    const downloaded = await f.admin.request('/api/backup'); assert.equal(downloaded.status, 200);
    const filename = path.join(f.backupDir, 'recovered.db');
    restoreSnapshot(downloaded.data, filename);
    assert.throws(() => restoreSnapshot(downloaded.data, filename), /EEXIST/);
    const restored = new (require('better-sqlite3'))(filename, { readonly: true });
    try {
        assert.equal(restored.prepare('SELECT total_score FROM evaluations').get().total_score, 15);
        assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
        assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
    } finally { restored.close(); }
    assert.equal((await f.admin.request('/api/master-reset', { confirmation: 'RESET EVENT' })).status, 200);
    assert.equal((await f.admin.request('/api/login', { username: 'admin', password: adminPassword })).status, 200);
    const history = await f.admin.request('/api/backups'); assert.equal(history.data.length, 1);
    const resetBackup = await f.admin.request(`/api/backups/${history.data[0].id}`);
    assert.equal(resetBackup.data.tables.evaluations[0].total_score, 15);
});

test('120 teams, five simultaneous juries and ten criteria preserve all scores and CSV averages', async t => {
    const f = await fixture(); t.after(() => f.close()); const s = await setup(f);
    const extraScores = {};
    for (let i = 3; i <= 10; i++) {
        const created = await f.admin.request('/api/criteria', { name: `Criterion ${i}`, max_marks: 10, display_order: i });
        assert.equal(created.status, 200); extraScores[created.data.id] = 2;
    }
    const juries = [s.j1, s.j2, await s.createJury('Judge3'), await s.createJury('Judge4'), await s.createJury('Judge5')];
    const content = ['teamNumber,teamName,venue', ...Array.from({ length: 118 }, (_, i) => `${100 + i},Load Team ${i},Hall A`)].join('\n');
    const form = new FormData(); form.append('file', new Blob([content]), '120-teams.csv');
    assert.equal((await f.admin.request('/api/teams/import', form)).status, 200);
    const teams = (await s.j1.client.request('/api/jury/teams')).data;
    assert.equal(teams.length, 120);
    const start = Date.now();
    await Promise.all(juries.map(async (j, i) => {
        for (const team of teams) {
            const response = await s.save(j, team.id, { ...s.scores(i + 1, 10 - i), ...extraScores }, 'draft');
            assert.equal(response.status, 200, JSON.stringify(response.data));
        }
        assert.equal((await j.client.request('/api/jury/submit-all', {})).status, 200);
    }));
    const rows = parse((await f.admin.request('/api/reports/detailed-results')).data, { columns: true, bom: true });
    const completed = rows.filter(row => row.Status === 'Completed');
    assert.equal(completed.length, 120);
    for (const row of completed) {
        assert.equal(row['Submitted Juries'], '5'); assert.equal(row['Final Average'], '27.00'); assert.equal(row['Maximum Score'], '100');
        assert.equal(row.Rank, '1');
        for (let j = 1; j <= 5; j++) {
            assert.equal(row[`Jury ${j} Total`], '27');
            for (let c = 3; c <= 10; c++) assert.equal(row[`Jury ${j} Criterion ${c} (max 10)`], '2');
        }
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM evaluations WHERE status = 'submitted'").get().n, 600);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM evaluation_scores').get().n, 6000);
    assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
    t.diagnostic(`600 draft saves and five bulk submissions completed in ${Date.now() - start} ms; driver mode: ${process.env.JURY_TEST_MODE || 'local'}. This is not a hosted network latency test.`);
});
