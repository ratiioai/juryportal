const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const ExcelJS = require('exceljs');
const {
  parse: parseCSV
} = require('csv-parse/sync');
const helmet = require('helmet');
const {
  rateLimit
} = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const {
  openDatabase,
  clearDb
} = require('./database/database');
const SQLiteSessionStore = require('./database/session-store');
const { localAdapter, snapshot } = require('./database/adapter');
function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label} is required (maximum ${max} characters).`);
  return value.trim();
}
function number(value, label, min = 1, max = 100000, integer = true) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') fail(`${label} must be a number.`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || integer && !Number.isInteger(n)) fail(`${label} must be ${integer ? 'a whole number ' : ''}between ${min} and ${max}.`);
  return n;
}
function password(value) {
  if (typeof value !== 'string' || value.length < 10 || Buffer.byteLength(value) > 72) fail('Password must be at least 10 characters and at most 72 bytes.');
  return value;
}
function active(value) {
  if ([true, 1, '1'].includes(value)) return 1;
  if ([false, 0, '0'].includes(value)) return 0;
  fail('Select an active or inactive account.');
}
function csvCell(value, isText = true) {
  let s = value == null ? '' : String(value);
  if (isText && /^[\s]*[=+\-@\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
function secretFor(db) {
  if (process.env.SESSION_SECRET) {
    if (process.env.SESSION_SECRET.length < 32) fail('SESSION_SECRET must contain at least 32 characters.');
    return process.env.SESSION_SECRET;
  }
  const filename = path.join(path.dirname(db.name), '.session-secret');
  if (!fs.existsSync(filename)) fs.writeFileSync(filename, crypto.randomBytes(48).toString('hex'), {
    mode: 0o600,
    flag: 'wx'
  });
  return fs.readFileSync(filename, 'utf8').trim();
}
function createApp({
  db = openDatabase(),
  sessionSecret,
  backupDir = path.join(__dirname, 'backups')
} = {}) {
  const app = express();
  app.locals.db = db;
  if (!db.hosted) db = localAdapter(db);
  let resetting = false;
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null
      }
    },
    strictTransportSecurity: process.env.HTTPS_ONLY === '1' ? undefined : false
  }));
  app.use(express.json({
    limit: '128kb'
  }));
  app.use(session({
    name: 'jury.sid',
    secret: sessionSecret || secretFor(db),
    store: new SQLiteSessionStore(db),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.HTTPS_ONLY === '1',
      maxAge: 12 * 3600000
    }
  }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (resetting) return res.status(503).json({
        error: 'The event is being reset. Please wait and log in again.'
      });
      if (req.get('X-Requested-With') !== 'JuryPortal') return res.status(403).json({
        error: 'Refresh the portal and try again.'
      });
      const origin = req.get('Origin');
      if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({
        error: 'Cross-site request rejected.'
      });
    }
    next();
  });
  const audit = async (req, action, entity, id, details) => await db.prepare('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(req.user.id, action, entity, id || null, details);
  const auth = role => async (req, res, next) => {
    const saved = req.session.user;
    const user = saved && (await db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(saved.id));
    if (!user || user.session_version !== saved.session_version) return res.status(401).json({
      error: 'Please log in again.'
    });
    if (role && user.role !== role) return res.status(403).json({
      error: 'You do not have permission for this action.'
    });
    req.user = user;
    if (user.must_change_password && !['/api/me', '/api/password'].includes(req.path)) return res.status(403).json({
      error: 'Change your initial password before continuing.'
    });
    next();
  };
  const admin = auth('admin'),
    jury = auth('jury');
  const get = async (table, id) => {
    const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(number(id, 'ID'));
    if (!row) fail('Record not found.', 404);
    return row;
  };
  const rubric = async () => await db.prepare('SELECT * FROM criteria WHERE active = 1 ORDER BY display_order, id').all();
  const rubricUnlocked = async () => {
    if (await db.prepare('SELECT id FROM evaluations LIMIT 1').get()) fail('Scoring has begun. Criteria cannot change during this event.', 409);
  };
  const ensureAssigned = async (teamId, juryId) => {
    await get('teams', teamId);
    if (!(await db.prepare('SELECT id FROM assignments WHERE team_id = ? AND jury_id = ?').get(teamId, juryId))) fail('This team is not assigned to you.', 403);
  };
  const assignTeam = async (teamId, venueId) => await db.prepare(`INSERT OR IGNORE INTO assignments (team_id, jury_id, venue_id)
        SELECT ?, u.id, ? FROM users u JOIN juries j ON j.username = u.username
        WHERE u.role = 'jury' AND u.active = 1 AND j.venue_id = ?`).run(teamId, venueId, venueId);
  const assignJury = async (juryId, venueId) => await db.prepare(`INSERT OR IGNORE INTO assignments (team_id, jury_id, venue_id)
        SELECT id, ?, venue_id FROM teams WHERE venue_id = ?`).run(juryId, venueId);
  const validateScores = async (scores, submit, cachedCriteria) => {
    const criteria = cachedCriteria || await rubric();
    if (!criteria.length) fail('An admin must configure scoring criteria first.', 409);
    if (!scores || typeof scores !== 'object' || Array.isArray(scores)) fail('Scores must be supplied.');
    const validIds = new Set(criteria.map(c => String(c.id)));
    for (const id of Object.keys(scores)) if (!validIds.has(id)) fail('Unknown scoring criterion. Refresh the form.');
    const parsed = [];
    let total = 0;
    for (const criterion of criteria) {
      const raw = scores[criterion.id];
      if (raw === '' || raw == null) {
        if (submit) fail(`Score required for ${criterion.name}.`);
        continue;
      }
      const marks = number(raw, `Score for ${criterion.name}`, 0, criterion.max_marks, false);
      total += marks;
      parsed.push({
        criterion_id: criterion.id,
        marks
      });
    }
    return {
      parsed,
      total: Math.round((total + Number.EPSILON) * 1000000) / 1000000
    };
  };
  const teamResults = async () => {
    return (db.readTransaction || db.transaction)(async () => {
    const teams = await db.prepare('SELECT t.*, v.name AS venue_name FROM teams t LEFT JOIN venues v ON v.id = t.venue_id ORDER BY t.id').all();
    const assignments = await db.prepare('SELECT a.*, u.name AS jury_name FROM assignments a JOIN users u ON u.id = a.jury_id ORDER BY u.id').all();
    const evaluations = await db.prepare('SELECT e.*, u.name AS jury_name FROM evaluations e JOIN users u ON u.id = e.jury_id').all();
    const maximum = (await rubric()).reduce((sum, c) => sum + c.max_marks, 0);
    const assignmentsByTeam = new Map(),
      evaluationsByTeam = new Map();
    for (const a of assignments) {
      if (!assignmentsByTeam.has(a.team_id)) assignmentsByTeam.set(a.team_id, []);
      assignmentsByTeam.get(a.team_id).push(a);
    }
    for (const e of evaluations) {
      if (!evaluationsByTeam.has(e.team_id)) evaluationsByTeam.set(e.team_id, []);
      evaluationsByTeam.get(e.team_id).push(e);
    }
    return teams.map(team => {
      const assigned = assignmentsByTeam.get(team.id) || [];
      const juryIds = new Set(assigned.map(a => a.jury_id));
      const evals = (evaluationsByTeam.get(team.id) || []).filter(e => juryIds.has(e.jury_id));
      const submitted = evals.filter(e => e.status === 'submitted');
      const complete = assigned.length > 0 && submitted.length === assigned.length;
      return {
        ...team,
        assignments: assigned,
        evaluations_list: evals,
        juries_count: assigned.length,
        submitted_count: submitted.length,
        max_score: maximum,
        status: !assigned.length ? 'No Jury Assigned' : complete ? 'Completed' : submitted.length ? 'Partially Evaluated' : 'Pending',
        final_score: complete ? (submitted.reduce((sum, e) => sum + e.total_score, 0) / assigned.length).toFixed(2) : '-',
        average: complete ? submitted.reduce((sum, e) => sum + e.total_score, 0) / assigned.length : null
      };
    });
    });
  };
  const leaderboard = async (teams) => {
    const board = (teams || await teamResults()).filter(t => t.average !== null).sort((a, b) => b.average - a.average || a.id - b.id);
    let rank = 1;
    return board.map((t, i) => {
      if (i && Math.abs(t.average - board[i - 1].average) > 0.000001) rank = i + 1;
      return {
        ...t,
        rank
      };
    });
  };
  app.post('/api/login', rateLimit({
    windowMs: 15 * 60000,
    limit: 40,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: 'Too many login attempts. Try again in 15 minutes.'
    }
  }), async (req, res) => {
    const username = text(req.body.username, 'Username', 80);
    if (typeof req.body.password !== 'string' || Buffer.byteLength(req.body.password) > 72) fail('Invalid username or password.', 401);
    const user = await db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND active = 1').get(username);
    const valid = await bcrypt.compare(req.body.password, user ? user.password_hash : bcrypt.hashSync('unusable-password', 10));
    if (!user || !valid) fail('Invalid username or password.', 401);
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.user = {
      id: user.id,
      session_version: user.session_version
    };
    await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    req.user = user;
    await audit(req, 'LOGIN', 'user', user.id, 'Successful login');
    res.json({
      message: 'Login successful',
      role: user.role
    });
  });
  app.post('/api/logout', (req, res, next) => req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('jury.sid');
    res.json({
      message: 'Logged out'
    });
  }));
  app.get('/api/me', auth(), (req, res) => res.json({
    id: req.user.id,
    username: req.user.username,
    name: req.user.name,
    role: req.user.role,
    must_change_password: Boolean(req.user.must_change_password)
  }));
  app.post('/api/password', auth(), async (req, res) => {
    if (typeof req.body.current_password !== 'string' || !(await bcrypt.compare(req.body.current_password, req.user.password_hash))) fail('Current password is incorrect.', 401);
    const hash = await bcrypt.hash(password(req.body.new_password), 12);
    await db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, session_version = session_version + 1 WHERE id = ?').run(hash, req.user.id);
    await db.prepare('UPDATE juries SET password_hash = ? WHERE username = ?').run(hash, req.user.username);
    req.session.user.session_version++;
    await audit(req, 'CHANGE_PASSWORD', 'user', req.user.id, 'Changed own password');
    res.json({
      message: 'Password changed'
    });
  });
  app.get('/api/health', async (req, res) => {
    await db.prepare('SELECT 1').get();
    res.json({
      status: 'ok'
    });
  });
  app.get('/api/dashboard', admin, async (req, res) => {
    const teams = await teamResults();
    const assignments = teams.reduce((s, t) => s + t.juries_count, 0);
    const completed = teams.reduce((s, t) => s + t.submitted_count, 0);
    res.json({
      totalTeams: teams.length,
      completedTeams: teams.filter(t => t.status === 'Completed').length,
      pendingTeams: teams.filter(t => t.status !== 'Completed').length,
      activeJuries: (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'jury' AND active = 1").get()).n,
      totalVenues: (await db.prepare('SELECT COUNT(*) AS n FROM venues').get()).n,
      totalEvaluationsNeeded: assignments,
      completedEvaluations: completed
    });
  });
  app.get('/api/venues', admin, async (req, res) => res.json(await db.prepare(`SELECT v.*,
        (SELECT COUNT(*) FROM teams WHERE venue_id = v.id) AS team_count,
        (SELECT COUNT(*) FROM juries WHERE venue_id = v.id) AS jury_count FROM venues v ORDER BY v.id`).all()));
  for (const method of ['post', 'put']) app[method]('/api/venues' + (method === 'put' ? '/:id' : ''), admin, async (req, res) => {
    const name = text(req.body.name, 'Venue name'),
      capacity = number(req.body.capacity, 'Capacity');
    let id = method === 'put' ? (await get('venues', req.params.id)).id : null;
    await db.transaction(async () => {
      if (id) await db.prepare('UPDATE venues SET name = ?, capacity = ? WHERE id = ?').run(name, capacity, id);else id = (await db.prepare('INSERT INTO venues (name, capacity) VALUES (?, ?)').run(name, capacity)).lastInsertRowid;
      await audit(req, method === 'put' ? 'UPDATE_VENUE' : 'CREATE_VENUE', 'venue', id, name);
    });
    res.json({
      id,
      message: 'Venue saved'
    });
  });
  app.delete('/api/venues/:id', admin, async (req, res) => {
    const venue = await get('venues', req.params.id);
    if (await db.prepare('SELECT id FROM teams WHERE venue_id = ? UNION ALL SELECT id FROM juries WHERE venue_id = ? LIMIT 1').get(venue.id, venue.id)) fail('Move or remove this venue’s teams and juries first.', 409);
    await db.transaction(async () => {
      if (await db.prepare('SELECT id FROM teams WHERE venue_id = ? UNION ALL SELECT id FROM juries WHERE venue_id = ? LIMIT 1').get(venue.id, venue.id)) fail('Move or remove this venue’s teams and juries first.', 409);
      await db.prepare('DELETE FROM venues WHERE id = ?').run(venue.id);
      await audit(req, 'DELETE_VENUE', 'venue', venue.id, venue.name);
    });
    res.json({
      message: 'Venue deleted'
    });
  });
  app.get('/api/criteria', auth(), async (req, res) => res.json(await rubric()));
  for (const method of ['post', 'put']) app[method]('/api/criteria' + (method === 'put' ? '/:id' : ''), admin, async (req, res) => {
    await rubricUnlocked();
    const name = text(req.body.name, 'Criterion name'),
      max = number(req.body.max_marks, 'Maximum marks', 0.01, 10000, false);
    const order = number(req.body.display_order, 'Display order', 0, 10000);
    let id = method === 'put' ? (await get('criteria', req.params.id)).id : null;
    await db.transaction(async () => {
      await rubricUnlocked();
      if (id) await db.prepare('UPDATE criteria SET name = ?, max_marks = ?, display_order = ? WHERE id = ?').run(name, max, order, id);else id = (await db.prepare('INSERT INTO criteria (name, max_marks, display_order) VALUES (?, ?, ?)').run(name, max, order)).lastInsertRowid;
      await audit(req, method === 'put' ? 'UPDATE_CRITERION' : 'CREATE_CRITERION', 'criterion', id, name);
    });
    res.json({
      id,
      message: 'Criterion saved'
    });
  });
  app.delete('/api/criteria/:id', admin, async (req, res) => {
    await rubricUnlocked();
    const c = await get('criteria', req.params.id);
    await db.transaction(async () => {
      await rubricUnlocked();
      await db.prepare('DELETE FROM criteria WHERE id = ?').run(c.id);
      await audit(req, 'DELETE_CRITERION', 'criterion', c.id, c.name);
    });
    res.json({
      message: 'Criterion deleted'
    });
  });
  app.get('/api/teams', admin, async (req, res) => res.json(await teamResults()));
  app.get('/api/teams/:id', admin, async (req, res) => {
    const t = (await teamResults()).find(t => t.id === number(req.params.id, 'Team ID'));
    if (!t) fail('Team not found.', 404);
    res.json({
      team: t,
      evaluations: t.evaluations_list,
      assignments: t.assignments,
      assignments_count: t.juries_count
    });
  });
  const teamInput = async body => ({
    number: text(body.team_number, 'Team number', 50),
    name: text(body.team_name, 'Team name'),
    venue: (await get('venues', body.venue_id)).id
  });
  app.post('/api/teams', admin, async (req, res) => {
    const t = await teamInput(req.body);
    let id;
    await db.transaction(async () => {
      id = (await db.prepare('INSERT INTO teams (team_number, team_name, venue_id) VALUES (?, ?, ?)').run(t.number, t.name, t.venue)).lastInsertRowid;
      await assignTeam(id, t.venue);
      await audit(req, 'CREATE_TEAM', 'team', id, t.number);
    });
    res.json({
      id,
      message: 'Team created'
    });
  });
  app.put('/api/teams/:id', admin, async (req, res) => {
    const old = await get('teams', req.params.id),
      t = await teamInput(req.body);
    if (old.venue_id !== t.venue && (await db.prepare('SELECT id FROM evaluations WHERE team_id = ? LIMIT 1').get(old.id))) fail('This team already has evaluations. Its venue cannot change during judging.', 409);
    await db.transaction(async () => {
      const current = await get('teams', old.id);
      if (current.venue_id !== t.venue && await db.prepare('SELECT id FROM evaluations WHERE team_id = ? LIMIT 1').get(old.id)) fail('This team already has evaluations. Its venue cannot change during judging.', 409);
      await db.prepare('UPDATE teams SET team_number = ?, team_name = ?, venue_id = ? WHERE id = ?').run(t.number, t.name, t.venue, old.id);
      if (current.venue_id !== t.venue) {
        await db.prepare('DELETE FROM assignments WHERE team_id = ?').run(old.id);
        await assignTeam(old.id, t.venue);
      }
      await audit(req, 'UPDATE_TEAM', 'team', old.id, t.number);
    });
    res.json({
      message: 'Team updated'
    });
  });
  app.delete('/api/teams/:id', admin, async (req, res) => {
    const t = await get('teams', req.params.id);
    await db.transaction(async () => {
      await db.prepare('DELETE FROM evaluation_scores WHERE evaluation_id IN (SELECT id FROM evaluations WHERE team_id = ?)').run(t.id);
      await db.prepare('DELETE FROM evaluations WHERE team_id = ?').run(t.id);
      await db.prepare('DELETE FROM assignments WHERE team_id = ?').run(t.id);
      await db.prepare('DELETE FROM teams WHERE id = ?').run(t.id);
      await audit(req, 'DELETE_TEAM', 'team', t.id, `${t.team_number}: deleted team and evaluations`);
    });
    res.json({
      message: 'Team deleted'
    });
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 2 * 1024 * 1024,
      files: 1,
      fields: 0
    },
    fileFilter: (req, file, cb) => cb(/\.(csv|xlsx)$/i.test(file.originalname) ? null : Object.assign(new Error('Use a CSV or XLSX file.'), {
      status: 400
    }), true)
  });
  app.post('/api/teams/import', admin, upload.single('file'), async (req, res) => {
    if (!req.file) fail('Choose a CSV or XLSX file.');
    let rows;
    try {
      if (/\.csv$/i.test(req.file.originalname)) rows = parseCSV(req.file.buffer, {
        columns: true,
        bom: true,
        skip_empty_lines: true,
        trim: true,
        max_record_size: 10000
      });else {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(req.file.buffer);
        const sheet = workbook.worksheets[0];
        if (!sheet || sheet.rowCount > 2001 || sheet.columnCount > 20) fail('Excel file must have at most 2000 teams and 20 columns.');
        const header = sheet.getRow(1).values.slice(1).map(v => String(v ?? '').trim());
        rows = [];
        sheet.eachRow((row, index) => {
          if (index > 1) rows.push(Object.fromEntries(header.map((key, i) => [key, row.getCell(i + 1).text])));
        });
      }
    } catch {
      fail('The file could not be read. Use the supplied template.');
    }
    if (!rows.length || rows.length > 2000) fail('Import between 1 and 2000 teams at a time.');
    const errors = [],
      ready = [],
      seen = new Set();
    const existing = new Set((await db.prepare('SELECT team_number FROM teams').all()).map(t => t.team_number));
    const venueMap = new Map((await db.prepare('SELECT id, name FROM venues').all()).map(v => [v.name.toLowerCase(), v]));
    for (const [i, row] of rows.entries()) {
      try {
        const normalized = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[ _]/g, ''), v]));
        const teamNumber = text(normalized.teamnumber, 'Team number', 50),
          teamName = text(normalized.teamname, 'Team name');
        const venueName = text(normalized.venue, 'Venue');
        const venue = venueMap.get(venueName.toLowerCase());
        if (!venue) fail(`Unknown venue: ${venueName}.`);
        if (seen.has(teamNumber) || existing.has(teamNumber)) fail(`Duplicate team number: ${teamNumber}.`);
        seen.add(teamNumber);
        ready.push({
          teamNumber,
          teamName,
          venue: venue.id
        });
      } catch (error) {
        errors.push(`Row ${i + 2}: ${error.message}`);
      }
    }
    if (errors.length) return res.status(400).json({
      error: `Nothing imported. ${errors.slice(0, 15).join('\n')}${errors.length > 15 ? `\n…and ${errors.length - 15} more errors.` : ''}`
    });
    await db.transaction(async () => {
      await db.prepare(`INSERT INTO teams (team_number, team_name, venue_id) VALUES ${ready.map(() => '(?, ?, ?)').join(',')}`).run(...ready.flatMap(t => [t.teamNumber, t.teamName, t.venue]));
      await db.prepare(`INSERT OR IGNORE INTO assignments (team_id, jury_id, venue_id)
        SELECT t.id, u.id, t.venue_id FROM teams t JOIN juries j ON j.venue_id = t.venue_id JOIN users u ON u.username = j.username
        WHERE u.active = 1 AND u.role = 'jury' AND t.team_number IN (${ready.map(() => '?').join(',')})`).run(...ready.map(t => t.teamNumber));
      await audit(req, 'IMPORT_TEAMS', 'system', null, `Imported ${ready.length} teams`);
    });
    res.json({
      message: `Successfully imported all ${ready.length} teams.`
    });
  });
  const getJury = async id => {
    const u = await get('users', id);
    if (u.role !== 'jury') fail('Jury not found.', 404);
    const j = await db.prepare('SELECT * FROM juries WHERE username = ?').get(u.username);
    if (!j) fail('Jury record is missing.', 409);
    return {
      ...u,
      venue_id: j.venue_id
    };
  };
  app.get('/api/juries', admin, async (req, res) => res.json(await db.prepare(`SELECT u.id, u.name, u.username, u.active, j.venue_id, v.name AS venue_name,
        (SELECT COUNT(*) FROM assignments WHERE jury_id = u.id) AS assigned_teams,
        (SELECT COUNT(*) FROM evaluations e JOIN assignments a ON a.team_id = e.team_id AND a.jury_id = e.jury_id WHERE e.jury_id = u.id AND e.status = 'submitted') AS completed_evaluations
        FROM users u JOIN juries j ON j.username = u.username LEFT JOIN venues v ON v.id = j.venue_id WHERE u.role = 'jury' ORDER BY u.id`).all()));
  for (const method of ['post', 'put']) app[method]('/api/juries' + (method === 'put' ? '/:id' : ''), admin, async (req, res) => {
    let old = method === 'put' ? await getJury(req.params.id) : null;
    const name = text(req.body.name, 'Jury name'),
      username = text(req.body.username, 'Username', 80).toLowerCase();
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) fail('Username can contain letters, numbers, dots, dashes and underscores.');
    const duplicate = await db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (duplicate && duplicate.id !== old?.id) fail('That username is already taken.', 409);
    const venueId = (await get('venues', req.body.venue_id)).id,
      enabled = active(req.body.active);
    let started = old && (await db.prepare('SELECT id FROM evaluations WHERE jury_id = ? LIMIT 1').get(old.id));
    if (started && old.venue_id !== venueId) fail('This jury has started scoring. Keep its venue and use Assign Teams for other venues.', 409);
    let hash = !old || req.body.password ? await bcrypt.hash(password(req.body.password), 12) : old.password_hash;
    let id = old?.id;
    await db.transaction(async () => {
      if (old) {
        old = await getJury(id);
        started = await db.prepare('SELECT id FROM evaluations WHERE jury_id = ? LIMIT 1').get(id);
        if (started && old.venue_id !== venueId) fail('This jury has started scoring. Keep its venue and use Assign Teams for other venues.', 409);
        if (!req.body.password) hash = old.password_hash;
      }
      const duplicate = await db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
      if (duplicate && duplicate.id !== id) fail('That username is already taken.', 409);
      await get('venues', venueId);
      if (old) {
        await db.prepare('UPDATE users SET name = ?, username = ?, password_hash = ?, active = ?, session_version = session_version + 1 WHERE id = ?').run(name, username, hash, enabled, id);
        await db.prepare('UPDATE juries SET name = ?, username = ?, password_hash = ?, venue_id = ?, active = ? WHERE username = ?').run(name, username, hash, venueId, enabled, old.username);
        if (!started && (old.venue_id !== venueId || old.active !== enabled)) await db.prepare('DELETE FROM assignments WHERE jury_id = ?').run(id);
      } else {
        id = (await db.prepare("INSERT INTO users (name, username, password_hash, role, active) VALUES (?, ?, ?, 'jury', ?)").run(name, username, hash, enabled)).lastInsertRowid;
        await db.prepare('INSERT INTO juries (name, username, password_hash, venue_id, active) VALUES (?, ?, ?, ?, ?)').run(name, username, hash, venueId, enabled);
      }
      if (enabled && (!old || old.venue_id !== venueId || old.active !== enabled)) await assignJury(id, venueId);
      await audit(req, old ? 'UPDATE_JURY' : 'CREATE_JURY', 'jury', id, username);
    });
    res.json({
      id,
      message: 'Jury saved'
    });
  });
  app.delete('/api/juries/:id', admin, async (req, res) => {
    const j = await getJury(req.params.id);
    if (await db.prepare('SELECT id FROM evaluations WHERE jury_id = ? LIMIT 1').get(j.id)) fail('This jury has evaluations and cannot be deleted during judging.', 409);
    await db.transaction(async () => {
      if (await db.prepare('SELECT id FROM evaluations WHERE jury_id = ? LIMIT 1').get(j.id)) fail('This jury has evaluations and cannot be deleted during judging.', 409);
      await db.prepare('DELETE FROM assignments WHERE jury_id = ?').run(j.id);
      await db.prepare('DELETE FROM juries WHERE username = ?').run(j.username);
      await db.prepare('DELETE FROM users WHERE id = ?').run(j.id);
      await audit(req, 'DELETE_JURY', 'jury', j.id, j.username);
    });
    res.json({
      message: 'Jury deleted'
    });
  });
  app.get('/api/juries/:id/assignments', admin, async (req, res) => {
    const j = await getJury(req.params.id);
    res.json(await db.prepare(`SELECT t.*, v.name AS venue_name, a.id AS assignment_id, e.status AS eval_status
            FROM teams t LEFT JOIN venues v ON v.id = t.venue_id
            LEFT JOIN assignments a ON a.team_id = t.id AND a.jury_id = ?
            LEFT JOIN evaluations e ON e.team_id = t.id AND e.jury_id = ? ORDER BY t.id`).all(j.id, j.id));
  });
  app.post('/api/juries/:id/assignments', admin, async (req, res) => {
    const j = await getJury(req.params.id),
      t = await get('teams', req.body.team_id);
    if (!j.active) fail('Activate this jury before assigning teams.', 409);
    await db.transaction(async () => {
      const current = await getJury(j.id), team = await get('teams', t.id);
      if (!current.active) fail('Activate this jury before assigning teams.', 409);
      await db.prepare('INSERT OR IGNORE INTO assignments (team_id, jury_id, venue_id) VALUES (?, ?, ?)').run(t.id, j.id, team.venue_id);
      await audit(req, 'ASSIGN_TEAM', 'team', t.id, `Assigned to jury ${j.username}`);
    });
    res.json({
      message: 'Team assigned'
    });
  });
  app.delete('/api/juries/:id/assignments/:teamId', admin, async (req, res) => {
    const j = await getJury(req.params.id),
      t = await get('teams', req.params.teamId);
    if (await db.prepare('SELECT id FROM evaluations WHERE jury_id = ? AND team_id = ?').get(j.id, t.id)) fail('Scoring has begun for this assignment. It cannot be removed.', 409);
    await db.transaction(async () => {
      if (await db.prepare('SELECT id FROM evaluations WHERE jury_id = ? AND team_id = ?').get(j.id, t.id)) fail('Scoring has begun for this assignment. It cannot be removed.', 409);
      await db.prepare('DELETE FROM assignments WHERE jury_id = ? AND team_id = ?').run(j.id, t.id);
      await audit(req, 'REMOVE_ASSIGNMENT', 'team', t.id, `Removed from jury ${j.username}`);
    });
    res.json({
      message: 'Assignment removed'
    });
  });
  const juryTeams = async id => await db.prepare(`SELECT t.*, v.name AS venue_name, COALESCE(e.status, 'Pending') AS eval_status, e.total_score, e.revision,
        (SELECT COUNT(*) FROM evaluation_scores s WHERE s.evaluation_id = e.id) AS scored_count
        FROM assignments a JOIN teams t ON t.id = a.team_id LEFT JOIN venues v ON v.id = t.venue_id
        LEFT JOIN evaluations e ON e.team_id = t.id AND e.jury_id = a.jury_id WHERE a.jury_id = ? ORDER BY t.id`).all(id);
  app.get('/api/jury/dashboard', jury, async (req, res) => {
    const teams = await juryTeams(req.user.id),
      complete = teams.filter(t => t.eval_status === 'submitted').length;
    const venue = await db.prepare('SELECT v.name FROM juries j JOIN venues v ON v.id = j.venue_id WHERE j.username = ?').get(req.user.username);
    res.json({
      venue_name: venue?.name || 'Unassigned',
      totalTeams: teams.length,
      completedTeams: complete,
      pendingTeams: teams.length - complete,
      progress: teams.length ? (complete / teams.length * 100).toFixed(1) : '0'
    });
  });
  app.get('/api/jury/teams', jury, async (req, res) => res.json(await juryTeams(req.user.id)));
  app.get('/api/evaluations/:teamId', jury, async (req, res) => {
    const teamId = number(req.params.teamId, 'Team ID');
    await ensureAssigned(teamId, req.user.id);
    const evaluation = await db.prepare('SELECT * FROM evaluations WHERE team_id = ? AND jury_id = ?').get(teamId, req.user.id);
    res.json({
      evaluation: evaluation || null,
      scores: evaluation ? await db.prepare('SELECT * FROM evaluation_scores WHERE evaluation_id = ?').all(evaluation.id) : [],
      criteria: await rubric()
    });
  });
  app.post('/api/evaluations', jury, async (req, res) => {
    const teamId = number(req.body.team_id, 'Team ID');
    if (!['draft', 'submit'].includes(req.body.action)) fail('Choose save draft or submit.');
    const revision = number(req.body.revision, 'Revision', 0, Number.MAX_SAFE_INTEGER);
    let nextRevision;
    await db.transaction(async () => {
      await ensureAssigned(teamId, req.user.id);
      const validated = await validateScores(req.body.scores, req.body.action === 'submit');
      const old = await db.prepare('SELECT * FROM evaluations WHERE team_id = ? AND jury_id = ?').get(teamId, req.user.id);
      if (old?.status === 'submitted') fail('Evaluation is submitted and locked.', 409);
      if ((old?.revision || 0) !== revision) fail('This evaluation changed in another tab. Reload it before saving.', 409);
      nextRevision = revision + 1;
      const now = new Date().toISOString(),
        status = req.body.action === 'submit' ? 'submitted' : 'draft';
      let id;
      if (old) {
        id = old.id;
        await db.prepare('UPDATE evaluations SET status = ?, total_score = ?, updated_at = ?, submitted_at = ?, revision = ? WHERE id = ?').run(status, validated.total, now, status === 'submitted' ? now : null, nextRevision, id);
        await db.prepare('DELETE FROM evaluation_scores WHERE evaluation_id = ?').run(id);
      } else id = (await db.prepare('INSERT INTO evaluations (team_id, jury_id, status, total_score, created_at, updated_at, submitted_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(teamId, req.user.id, status, validated.total, now, now, status === 'submitted' ? now : null, nextRevision)).lastInsertRowid;
      if (validated.parsed.length) await db.prepare(`INSERT INTO evaluation_scores (evaluation_id, criterion_id, marks) VALUES ${validated.parsed.map(() => '(?, ?, ?)').join(',')}`).run(...validated.parsed.flatMap(s => [id, s.criterion_id, s.marks]));
      await audit(req, status === 'submitted' ? 'SUBMIT_EVALUATION' : 'SAVE_DRAFT', 'evaluation', id, `Team ${teamId}`);
    });
    res.json({
      message: req.body.action === 'submit' ? 'Evaluation submitted and locked' : 'Draft saved',
      revision: nextRevision
    });
  });
  app.post('/api/jury/submit-all', jury, async (req, res) => {
    await db.transaction(async () => {
      const teams = await juryTeams(req.user.id);
      if (!teams.length) fail('No teams are assigned.');
      const checked = [];
      const criteria = await rubric();
      const evaluations = await db.prepare('SELECT * FROM evaluations WHERE jury_id = ?').all(req.user.id);
      const allScores = await db.prepare('SELECT s.* FROM evaluation_scores s JOIN evaluations e ON e.id = s.evaluation_id WHERE e.jury_id = ?').all(req.user.id);
      const scoreMap = new Map();
      for (const s of allScores) { if (!scoreMap.has(s.evaluation_id)) scoreMap.set(s.evaluation_id, {}); scoreMap.get(s.evaluation_id)[s.criterion_id] = s.marks; }
      for (const t of teams) {
        const e = evaluations.find(e => e.team_id === t.id);
        if (!e) fail(`Save scores for team ${t.team_number} before submitting.`);
        const scores = scoreMap.get(e.id) || {};
        try {
          checked.push({
            id: e.id,
            status: e.status,
            total: (await validateScores(scores, true, criteria)).total
          });
        } catch (error) {
          fail(`Team ${t.team_number}: ${error.message}`);
        }
      }
      const now = new Date().toISOString();
      await db.prepare(`UPDATE evaluations SET status = 'submitted', total_score = (SELECT SUM(marks) FROM evaluation_scores WHERE evaluation_id = evaluations.id),
        submitted_at = ?, updated_at = ?, revision = revision + 1 WHERE jury_id = ? AND status = 'draft'
        AND team_id IN (SELECT team_id FROM assignments WHERE jury_id = ?)`).run(now, now, req.user.id, req.user.id);
      await audit(req, 'SUBMIT_ALL', 'evaluations', null, `Validated and submitted ${checked.filter(e => e.status === 'draft').length} drafts`);
    });
    res.json({
      message: 'All evaluations submitted and locked'
    });
  });
  app.post('/api/evaluations/:id/unlock', admin, async (req, res) => {
    const e = await get('evaluations', req.params.id),
      reason = text(req.body.reason, 'Unlock reason', 500);
    await db.transaction(async () => {
      await db.prepare("UPDATE evaluations SET status = 'draft', submitted_at = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?").run(new Date().toISOString(), e.id);
      await audit(req, 'UNLOCK_EVALUATION', 'evaluation', e.id, `Team ${e.team_id}; reason: ${reason}`);
    });
    res.json({
      message: 'Evaluation unlocked'
    });
  });
  app.get('/api/leaderboard', admin, async (req, res) => res.json(await leaderboard()));
  app.get('/api/audit-logs', admin, async (req, res) => res.json(await db.prepare(`SELECT a.*, COALESCE(u.username, 'Deleted user') AS user_name
        FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 500`).all()));
  app.get('/api/reports/detailed-results', admin, async (req, res) => {
    const { teams, criteria, scores } = await (db.readTransaction || db.transaction)(async () => ({
      teams: await teamResults(), criteria: await rubric(),
      scores: new Map((await db.prepare('SELECT * FROM evaluation_scores').all()).map(s => [`${s.evaluation_id}:${s.criterion_id}`, s.marks]))
    }));
    const ranks = new Map((await leaderboard(teams)).map(t => [t.id, t.rank]));
    const maxJuries = Math.max(0, ...teams.map(t => t.juries_count));
    const header = ['Team Number', 'Team Name', 'Venue', 'Status', 'Assigned Juries', 'Submitted Juries', 'Maximum Score', 'Final Average', 'Rank'];
    for (let i = 1; i <= maxJuries; i++) header.push(`Jury ${i} Name`, `Jury ${i} Status`, ...criteria.map(c => `Jury ${i} ${c.name} (max ${c.max_marks})`), `Jury ${i} Total`);
    const lines = [header.map(h => csvCell(h)).join(',')];
    for (const t of teams) {
      const row = [csvCell(t.team_number), csvCell(t.team_name), csvCell(t.venue_name), csvCell(t.status), csvCell(t.juries_count, false), csvCell(t.submitted_count, false), csvCell(t.max_score, false), csvCell(t.average === null ? '' : t.final_score, false), csvCell(ranks.get(t.id) || '', false)];
      for (let i = 0; i < maxJuries; i++) {
        const a = t.assignments[i],
          e = a && t.evaluations_list.find(e => e.jury_id === a.jury_id);
        row.push(csvCell(a?.jury_name), csvCell(a ? e?.status || 'pending' : ''));
        for (const c of criteria) row.push(csvCell(e ? scores.get(`${e.id}:${c.id}`) : '', false));
        row.push(csvCell(e ? e.total_score : '', false));
      }
      lines.push(row.join(','));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="detailed_results.csv"');
    res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
  });
  app.get('/api/backup', admin, async (req, res) => {
    if (db.hosted) {
      const data = await snapshot(db);
      await audit(req, 'BACKUP', 'system', null, 'Downloaded hosted database snapshot');
      res.attachment(`juryportal-${Date.now()}.json`);
      return res.json(data);
    }
    fs.mkdirSync(backupDir, {
      recursive: true
    });
    const filename = path.join(backupDir, `juryportal-${Date.now()}.db`);
    await db.backup(filename);
    await audit(req, 'BACKUP', 'system', null, path.basename(filename));
    res.download(filename, path.basename(filename));
  });
  app.get('/api/backups', admin, async (req, res) => {
    res.json(db.hosted ? await db.prepare('SELECT id, created_at FROM event_backups ORDER BY id DESC LIMIT 100').all() : []);
  });
  app.get('/api/backups/:id', admin, async (req, res) => {
    if (!db.hosted) fail('Saved hosted backup not found.', 404);
    const backup = await get('event_backups', req.params.id);
    res.attachment(`juryportal-before-reset-${backup.id}.json`).type('json').send(backup.data);
  });
  app.post('/api/master-reset', admin, async (req, res) => {
    if (req.body.confirmation !== 'RESET EVENT') fail('Type RESET EVENT to confirm.');
    resetting = true;
    try {
      if (!db.hosted) {
        fs.mkdirSync(backupDir, { recursive: true });
        await db.backup(path.join(backupDir, `before-reset-${Date.now()}.db`));
      }
      await db.transaction(async () => {
        if (db.hosted) {
          const data = await snapshot(db);
          await db.prepare('INSERT INTO event_backups (data, created_at) VALUES (?, ?)').run(JSON.stringify(data), new Date().toISOString());
        }
        await clearDb(db);
        await audit(req, 'MASTER_RESET', 'system', null, 'Reset event; preserved audit history and a database backup');
      });
      res.json({
        message: 'Event reset. A backup was saved. Please log in again.'
      });
    } finally {
      resetting = false;
    }
  });
  app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: 0
  }));
  app.use('/api', (req, res) => res.status(404).json({
    error: 'API endpoint not found.'
  }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = error.status || 500,
      message = error.message;
    if (error.code === 'LIMIT_FILE_SIZE') {
      status = 400;
      message = 'File must be smaller than 2 MB.';
    } else if (error instanceof multer.MulterError) {
      status = 400;
      message = 'Upload one CSV or XLSX file.';
    } else if (error.code?.includes('SQLITE_CONSTRAINT')) {
      status = 409;
      message = 'A duplicate or linked record prevents this change.';
    }
    if (status >= 500) {
      console.error(error);
      message = 'The server could not complete the request. Your last saved data is retained.';
    }
    res.status(status).json({
      error: message
    });
  });
  return app;
}
module.exports = {
  createApp,
  csvCell
};
if (require.main === module) {
  const db = openDatabase(),
    app = createApp({
      db
    });
  const port = number(process.env.PORT || 3000, 'Port', 1, 65535),
    host = process.env.HOST || '0.0.0.0';
  const server = app.listen(port, host, () => {
    console.log(`Jury Portal: http://localhost:${port}`);
    for (const list of Object.values(os.networkInterfaces())) for (const address of list || []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`Venue Wi-Fi address: http://${address.address}:${port}`);
    }
  });
  // Online SQLite backups include committed WAL data without interrupting judging.
  const backupDir = path.join(__dirname, 'backups');
  const backupTimer = setInterval(async () => {
    try {
      fs.mkdirSync(backupDir, {
        recursive: true
      });
      await db.backup(path.join(backupDir, `automatic-${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
    } catch (error) {
      console.error(`Automatic backup failed: ${error.message}`);
    }
  }, 15 * 60000);
  backupTimer.unref();
  server.on('error', error => {
    console.error(`Cannot start portal: ${error.message}`);
    db.close();
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    clearInterval(backupTimer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
