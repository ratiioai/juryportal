document.addEventListener('DOMContentLoaded', async () => {
    const { api, send, escape: esc, notice, busy } = Portal;
    let teams = [], criteria = [], currentTeam = null, revision = 0, dirty = false, loading = false;
    const grid = document.getElementById('teams-grid'), form = document.getElementById('evaluation-form');
    const draftButton = document.getElementById('btn-save-draft'), submitAllButton = document.getElementById('btn-submit-all');
    const submitButton = document.createElement('button'); submitButton.type = 'button'; submitButton.className = 'btn-primary'; submitButton.textContent = 'Submit this team';
    draftButton.after(submitButton);
    function show(section) {
        document.querySelectorAll('.page-section').forEach(el => { el.classList.toggle('hidden', el.id !== section); el.classList.toggle('active', el.id === section); });
        document.querySelectorAll('[data-target]').forEach(a => a.classList.toggle('active', a.dataset.target === section));
    }
    function canLeave() { return !dirty || confirm('You have unsaved scores. Leave without saving?'); }
    function renderDashboard(data) {
        document.getElementById('jury-venue-badge').textContent = `Venue: ${data.venue_name}`;
        document.getElementById('stat-total-teams').textContent = data.totalTeams;
        document.getElementById('stat-completed-teams').textContent = data.completedTeams;
        document.getElementById('stat-pending-teams').textContent = data.pendingTeams;
        document.getElementById('progress-text').textContent = `${data.progress}% Completed`;
        document.getElementById('progress-bar').style.width = `${data.progress}%`;
    }
    async function dashboard() { await loadTeams(); }
    async function loadTeams() {
        grid.setAttribute('aria-busy', 'true'); grid.innerHTML = '<p class="page-loading">Loading assigned teams…</p>';
        let workspace;
        try { workspace = await api('/api/jury/workspace'); } finally { grid.setAttribute('aria-busy', 'false'); }
        teams = workspace.teams; criteria = workspace.criteria; Portal.setRound(workspace.round);
        document.getElementById('jury-round-label').textContent = `Judging: ${workspace.round.name}`;
        renderDashboard(workspace.dashboard);
        grid.innerHTML = teams.map(t => `<div class="team-card"><h3>${esc(t.team_number)}</h3><div class="team-name">${esc(t.team_name)}</div><div class="venue-name">${esc(t.venue_name)}</div>
            <div class="status-row">${esc(t.eval_status)}${t.eval_status === 'draft' ? ` · ${t.scored_count}/${criteria.length} criteria scored` : ''}${t.eval_status === 'submitted' ? ` · Score: ${t.total_score}` : ''}</div>
            <div class="team-card-actions"><button class="btn-primary" data-team="${t.id}">${t.eval_status === 'submitted' ? 'View Evaluation' : t.eval_status === 'draft' ? 'Continue Draft' : 'Evaluate'}</button></div></div>`).join('') || '<p>No teams assigned yet. Ask the admin to assign teams to your account.</p>';
        submitAllButton.disabled = !criteria.length || !teams.length || teams.every(t => t.eval_status === 'submitted') || teams.some(t => t.eval_status === 'Pending' || t.scored_count !== criteria.length);
        submitAllButton.textContent = teams.length && teams.every(t => t.eval_status === 'submitted') ? 'All Submitted' : 'Submit All Evaluations';
    }
    async function openEvaluation(team) {
        if (!canLeave()) return;
        loading = true; draftButton.disabled = true; submitButton.disabled = true;
        try {
            const data = await api(`/api/evaluations/${team.id}`);
            Portal.setRound(data.round); document.getElementById('jury-round-label').textContent = `Judging: ${data.round.name}`;
            currentTeam = team; revision = data.evaluation?.revision || 0; criteria = data.criteria; dirty = false;
            document.getElementById('eval-team-number').textContent = team.team_number;
            document.getElementById('eval-team-name').textContent = team.team_name;
            document.getElementById('eval-venue').textContent = team.venue_name;
            const locked = data.evaluation?.status === 'submitted';
            document.getElementById('criteria-container').innerHTML = criteria.map(c => {
                const score = data.scores.find(s => s.criterion_id === c.id);
                return `<div class="criterion-group"><div class="criterion-header"><label for="score-${c.id}" class="criterion-name">${esc(c.name)}</label><span class="criterion-max">Maximum: ${c.max_marks}</span></div>
                    <input id="score-${c.id}" type="number" inputmode="decimal" min="0" max="${c.max_marks}" step="any" class="score-input" data-crit-id="${c.id}" value="${score?.marks ?? ''}" ${locked ? 'disabled' : ''} placeholder="Enter score"></div>`;
            }).join('') || '<p>The admin must set up scoring criteria first.</p>';
            document.getElementById('eval-actions').style.display = locked ? 'none' : '';
            draftButton.disabled = submitButton.disabled = !criteria.length;
            calculateTotal(); show('evaluation');
        } finally { loading = false; }
    }
    function calculateTotal() {
        const sum = [...form.querySelectorAll('.score-input')].reduce((sum, input) => sum + (Number(input.value) || 0), 0);
        document.getElementById('total-score-display').textContent = `${Number(sum.toFixed(6))} / ${criteria.reduce((s, c) => s + c.max_marks, 0)}`;
    }
    form.addEventListener('input', () => { dirty = true; calculateTotal(); });
    form.addEventListener('submit', e => e.preventDefault());
    async function save(action) {
        if (loading || !currentTeam) return;
        const scores = {};
        for (const input of form.querySelectorAll('.score-input')) {
            input.required = action === 'submit';
            if (!input.reportValidity()) return;
            scores[input.dataset.critId] = input.value.trim();
        }
        if (action === 'submit' && !confirm('Submit this team’s scores? They will be locked until an admin unlocks them.')) return;
        // Disable both actions so simultaneous requests cannot race.
        loading = true; draftButton.disabled = submitButton.disabled = true;
        try {
            const result = await send('/api/evaluations', { team_id: currentTeam.id, action, scores, revision });
            revision = result.revision; dirty = false; notice(result.message); show('teams'); await loadTeams();
        } catch (e) { notice(e.message, true); }
        finally { loading = false; draftButton.disabled = submitButton.disabled = false; }
    }
    draftButton.addEventListener('click', () => save('draft'));
    submitButton.addEventListener('click', () => save('submit'));
    grid.addEventListener('click', e => { const button = e.target.closest('[data-team]'); if (button) busy(button, () => openEvaluation(teams.find(t => t.id === Number(button.dataset.team)))); });
    document.querySelectorAll('[data-target]').forEach(a => a.addEventListener('click', async e => {
        e.preventDefault(); if (loading || !canLeave()) return; dirty = false;
        show(a.dataset.target);
        try { await loadTeams(); } catch (e) { notice(e.message, true); }
    }));
    document.getElementById('back-to-teams').addEventListener('click', () => document.querySelector('[data-target="teams"]').click());
    submitAllButton.addEventListener('click', e => busy(e.currentTarget, async () => {
        if (!confirm('Submit and lock every completed draft? Only an admin can unlock submitted scores.')) return;
        const result = await send('/api/jury/submit-all', {}); notice(result.message); await loadTeams();
    }));
    document.getElementById('logout-btn').addEventListener('click', async e => {
        e.preventDefault(); if (loading || !canLeave()) return;
        try { await api('/api/logout', { method: 'POST' }); dirty = false; location.href = '/'; } catch (e) { notice(e.message, true); }
    });
    window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
    try { const user = await Portal.user('jury'); document.getElementById('jury-welcome').textContent = `Welcome, ${user.name}`; await dashboard(); }
    catch (e) { notice(e.message, true); }
});
