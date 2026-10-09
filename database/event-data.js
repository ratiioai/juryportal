// Read related event tables in one consistent database batch instead of a
// separate remote request for every table. Archived rounds use the same views.
async function readEvent(db, req, { scores = false, audit = false } = {}) {
    if (req?.roundSnapshot) return req.roundSnapshot.tables;
    const statements = {
        teams: 'SELECT * FROM teams ORDER BY id', venues: 'SELECT * FROM venues ORDER BY id',
        criteria: 'SELECT * FROM criteria ORDER BY display_order, id',
        users: 'SELECT id, name, username, role, active FROM users ORDER BY id',
        juries: 'SELECT id, name, username, venue_id, active FROM juries ORDER BY id',
        assignments: 'SELECT * FROM assignments ORDER BY jury_id, id',
        evaluations: 'SELECT * FROM evaluations ORDER BY id'
    };
    if (scores) statements.evaluation_scores = 'SELECT * FROM evaluation_scores ORDER BY id';
    if (audit) statements.audit_logs = 'SELECT * FROM audit_logs ORDER BY id DESC LIMIT 500';
    const results = await db.batch(Object.values(statements), 'read');
    return Object.fromEntries(Object.keys(statements).map((name, i) => [name, results[i].rows.map(row => ({ ...row }))]));
}

function teamResults(tables) {
    const users = new Map(tables.users.map(u => [u.id, u]));
    const venues = new Map(tables.venues.map(v => [v.id, v.name]));
    const maximum = tables.criteria.filter(c => c.active).reduce((sum, c) => sum + c.max_marks, 0);
    const assignmentsByTeam = new Map(), evaluationsByTeam = new Map();
    for (const a of tables.assignments) {
        if (!users.has(a.jury_id)) continue;
        if (!assignmentsByTeam.has(a.team_id)) assignmentsByTeam.set(a.team_id, []);
        assignmentsByTeam.get(a.team_id).push({ ...a, jury_name: users.get(a.jury_id).name });
    }
    for (const e of tables.evaluations) {
        if (!users.has(e.jury_id)) continue;
        if (!evaluationsByTeam.has(e.team_id)) evaluationsByTeam.set(e.team_id, []);
        evaluationsByTeam.get(e.team_id).push({ ...e, jury_name: users.get(e.jury_id).name });
    }
    return tables.teams.map(team => {
        const assigned = assignmentsByTeam.get(team.id) || [];
        const juryIds = new Set(assigned.map(a => a.jury_id));
        const evals = (evaluationsByTeam.get(team.id) || []).filter(e => juryIds.has(e.jury_id));
        const submitted = evals.filter(e => e.status === 'submitted');
        const complete = assigned.length > 0 && submitted.length === assigned.length;
        const average = complete ? submitted.reduce((sum, e) => sum + e.total_score, 0) / assigned.length : null;
        return { ...team, venue_name: venues.get(team.venue_id), assignments: assigned, evaluations_list: evals,
            juries_count: assigned.length, submitted_count: submitted.length, max_score: maximum,
            status: !assigned.length ? 'No Jury Assigned' : complete ? 'Completed' : submitted.length ? 'Partially Evaluated' : 'Pending',
            final_score: average === null ? '-' : average.toFixed(2), average };
    });
}

function venueResults(tables) {
    return tables.venues.map(v => ({ ...v, team_count: tables.teams.filter(t => t.venue_id === v.id).length,
        jury_count: tables.juries.filter(j => j.venue_id === v.id).length }));
}

function juryResults(tables) {
    return tables.users.filter(u => u.role === 'jury').map(u => {
        const j = tables.juries.find(j => j.username === u.username);
        const assigned = tables.assignments.filter(a => a.jury_id === u.id);
        return { ...u, venue_id: j?.venue_id, venue_name: tables.venues.find(v => v.id === j?.venue_id)?.name,
            assigned_teams: assigned.length,
            completed_evaluations: tables.evaluations.filter(e => e.jury_id === u.id && e.status === 'submitted' && assigned.some(a => a.team_id === e.team_id)).length };
    });
}

async function archiveRound(db, round) {
    const data = await require('./adapter').snapshot(db, { includeRounds: false });
    for (const table of ['users', 'juries']) data.tables[table] = data.tables[table].map(({ password_hash, ...row }) => row);
    await db.prepare('UPDATE event_rounds SET archived_at = ?, snapshot_json = ? WHERE id = ? AND archived_at IS NULL')
        .run(new Date().toISOString(), JSON.stringify(data), round.id);
}

module.exports = { readEvent, teamResults, venueResults, juryResults, archiveRound };
