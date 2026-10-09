document.addEventListener('DOMContentLoaded', async () => {
    const { api, send, escape: esc, notice, busy } = Portal;
    const cache = {}, sectionNames = ['dashboard', 'teams', 'juries', 'venues', 'criteria', 'leaderboard', 'audit'];
    let current = 'dashboard', loadVersion = 0, readOnly = false, roundState, venuesCache;
    const roundSelect = document.getElementById('round-select'), startRoundButton = document.getElementById('start-round-btn'), manageRoundsButton = document.getElementById('manage-rounds-btn');
    const badge = status => `<span class="badge ${['Completed', 'submitted'].includes(status) ? 'badge-completed' : ['draft', 'Partially Evaluated'].includes(status) ? 'badge-partial' : 'badge-pending'}">${esc(status)}</span>`;
    const actions = (type, id) => readOnly ? 'Archived' : `<button class="btn-secondary" data-edit="${type}" data-id="${id}">Edit</button> <button class="btn-danger" data-delete="${type}" data-id="${id}">Delete</button>`;
    function selectRound(id) {
        const round = roundState.rounds.find(r => r.id === Number(id));
        if (!round) return;
        readOnly = Boolean(round.archived_at); roundSelect.value = String(round.id);
        Portal.selectRound(round.id, readOnly);
        document.getElementById('round-status').textContent = readOnly ? `${round.name} is archived. Its teams, scores and reports are read-only.` : `${round.name} is active. Start a new round to preserve these results and begin with blank scores.`;
        document.querySelectorAll('[data-open-modal]').forEach(button => { button.hidden = readOnly; });
        document.getElementById('master-reset-btn').hidden = readOnly; startRoundButton.disabled = false; manageRoundsButton.disabled = false;
        document.querySelector('a[href^="/api/reports/detailed-results"]').href = `/api/reports/detailed-results?round=${round.id}`;
        for (const key of Object.keys(cache)) delete cache[key];
        venuesCache = undefined;
    }
    async function refreshRounds(selectedId) {
        roundState = await api('/api/rounds'); Portal.setRound(roundState.active);
        const available = roundState.rounds.filter(r => !r.removed_at);
        roundSelect.innerHTML = available.map(r => `<option value="${r.id}">${esc(r.name)}${r.archived_at ? ' · Archived' : ' · Active'}</option>`).join('');
        selectRound(available.some(r => r.id === Number(selectedId)) ? selectedId : roundState.active.id);
    }
    roundSelect.addEventListener('change', () => { selectRound(roundSelect.value); load().catch(e => notice(e.message, true)); });
    startRoundButton.addEventListener('click', () => {
        const dialog = document.createElement('dialog'); dialog.className = 'account-dialog';
        dialog.setAttribute('aria-labelledby', 'start-round-title');
        dialog.innerHTML = `<h2 id="start-round-title">Start a new judging round</h2><p>${esc(roundState.active.name)} will be archived with its scores and reports. Judges will score the new round.</p>
            <form><div class="form-group"><label for="new-round-name">Round name</label><input id="new-round-name" maxlength="80" value="Round ${roundState.rounds.length + 1}" required></div>
            <label class="assignment-row"><input type="checkbox" id="carry-round-teams" checked> Keep teams and jury assignments</label>
            <p>Venues, scoring criteria and jury accounts are kept. Scores start blank. Uncheck the option to import a new team roster.</p>
            <p class="account-error" role="alert"></p><button class="btn-primary" type="submit">Start round</button> <button class="btn-secondary" type="button" data-cancel>Cancel</button></form>`;
        document.body.appendChild(dialog); dialog.showModal();
        dialog.querySelector('#new-round-name').select();
        const close = () => { dialog.close(); dialog.remove(); };
        dialog.querySelector('[data-cancel]').addEventListener('click', close); dialog.addEventListener('cancel', () => dialog.remove());
        dialog.querySelector('form').addEventListener('submit', event => {
            event.preventDefault(); busy(dialog.querySelector('[type=submit]'), async () => {
                const errorBox = dialog.querySelector('.account-error'); errorBox.textContent = '';
                dialog.querySelector('[data-cancel]').disabled = true;
                try {
                    const result = await send('/api/rounds', { name: dialog.querySelector('#new-round-name').value, keep_teams: dialog.querySelector('#carry-round-teams').checked });
                    Portal.setRound(result.round); close(); notice(result.message); await refreshRounds(); navigate('dashboard');
                } catch (error) { errorBox.textContent = error.message; }
                finally { dialog.querySelector('[data-cancel]').disabled = false; }
            });
        });
    });
    manageRoundsButton.addEventListener('click', () => busy(manageRoundsButton, async () => {
        await refreshRounds(roundSelect.value);
        const dialog = document.createElement('dialog'); dialog.className = 'account-dialog rounds-dialog';
        dialog.setAttribute('aria-labelledby', 'manage-rounds-title');
        dialog.innerHTML = `<h2 id="manage-rounds-title">Manage judging rounds</h2><p>Open a round to view its teams, scores and reports. Rename rounds or remove archived rounds from history. Removed rounds can be restored with their scores.</p>
            <div class="round-list"></div><p class="account-error" role="alert"></p><div class="round-dialog-actions"><button class="btn-primary" type="button" data-new-round>Start new round</button><button class="btn-secondary" type="button" data-close-rounds>Close</button></div>`;
        const renderRounds = () => {
            dialog.querySelector('.round-list').innerHTML = roundState.rounds.map(round => `<section class="round-card" data-round-id="${round.id}">
                <div><strong>${esc(round.name)}</strong><p>${round.removed_at ? 'Removed · Scores retained' : round.archived_at ? 'Archived · Read-only results' : 'Active · Juries are scoring this round'}</p></div>
                <div class="round-card-actions">${round.removed_at ? '<button class="btn-secondary" type="button" data-round-action="restore">Restore</button>' : `<button class="btn-secondary" type="button" data-round-action="open">Open round</button><button class="btn-secondary" type="button" data-round-action="rename">Rename</button><button class="btn-danger" type="button" data-round-action="remove" ${round.archived_at ? '' : 'disabled title="Start a new round before removing this round"'}>Remove</button>`}</div>
                <form class="round-rename-form" hidden><label for="round-name-${round.id}">Round name</label><input id="round-name-${round.id}" value="${esc(round.name)}" maxlength="80" required><button class="btn-primary" type="submit">Save name</button><button class="btn-secondary" type="button" data-round-action="cancel-rename">Cancel</button></form>
                <div class="round-remove-confirm" hidden><p>Remove ${esc(round.name)} from history? Its scores will be retained and you can restore it here.</p><button class="btn-danger" type="button" data-round-action="confirm-remove">Remove round</button><button class="btn-secondary" type="button" data-round-action="cancel-remove">Cancel</button></div></section>`).join('');
        };
        const close = () => { dialog.close(); dialog.remove(); };
        renderRounds(); document.body.appendChild(dialog); dialog.showModal();
        dialog.querySelector('[data-close-rounds]').addEventListener('click', close);
        dialog.addEventListener('cancel', () => dialog.remove());
        dialog.querySelector('[data-new-round]').addEventListener('click', () => { close(); startRoundButton.click(); });
        async function change(button, work) {
            await busy(button, async () => {
                dialog.querySelector('.account-error').textContent = '';
                try { const result = await work(); await refreshRounds(roundSelect.value); renderRounds(); await load(); notice(result.message); }
                catch (error) { dialog.querySelector('.account-error').textContent = error.message; }
            });
        }
        dialog.addEventListener('click', event => {
            const button = event.target.closest('[data-round-action]'); if (!button || button.disabled) return;
            const card = button.closest('[data-round-id]'), id = Number(card.dataset.roundId), round = roundState.rounds.find(r => r.id === id);
            if (button.dataset.roundAction === 'open') { selectRound(id); navigate('dashboard'); close(); }
            else if (button.dataset.roundAction === 'rename') { card.querySelector('form').hidden = false; card.querySelector('input').select(); }
            else if (button.dataset.roundAction === 'cancel-rename') card.querySelector('form').hidden = true;
            else if (button.dataset.roundAction === 'restore') change(button, () => send(`/api/rounds/${id}/restore`, {}));
            else if (button.dataset.roundAction === 'remove') { card.querySelector('.round-remove-confirm').hidden = false; card.querySelector('[data-round-action="confirm-remove"]').focus(); }
            else if (button.dataset.roundAction === 'cancel-remove') card.querySelector('.round-remove-confirm').hidden = true;
            else if (button.dataset.roundAction === 'confirm-remove') change(button, () => api(`/api/rounds/${id}`, { method: 'DELETE' }));
        });
        dialog.addEventListener('submit', event => {
            event.preventDefault(); const form = event.target, id = Number(form.closest('[data-round-id]').dataset.roundId);
            change(form.querySelector('[type=submit]'), () => send(`/api/rounds/${id}`, { name: form.querySelector('input').value }, 'PUT'));
        });
    }));
    function modal(id, open = true) {
        const element = document.getElementById(id); element.classList.toggle('active', open);
        element.setAttribute('role', 'dialog'); element.setAttribute('aria-modal', 'true');
        if (!open) { const form = element.querySelector('form'); if (form) { form.reset(); if (form.elements.id) form.elements.id.value = ''; } }
        else element.querySelector('input:not([type=hidden]), select, button')?.focus();
    }
    async function dropdowns() {
        const venues = venuesCache || await api('/api/venues'); venuesCache = venues;
        const html = '<option value="">Choose venue</option>' + venues.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
        for (const id of ['team-venue-select', 'jury-venue-select']) { const select = document.getElementById(id), selected = select.value; select.innerHTML = html; select.value = selected; }
    }
    async function load(section = current) {
        const version = ++loadVersion;
        const endpoint = section === 'audit' ? 'audit-logs' : section;
        const target = document.getElementById(section);
        target.setAttribute('aria-busy', 'true');
        if (section !== 'dashboard') document.getElementById(`${section}-table-body`).innerHTML = '<tr><td colspan="8" class="page-loading">Loading…</td></tr>';
        let items;
        try { items = await api(`/api/${endpoint}`); } finally { if (version === loadVersion) target.setAttribute('aria-busy', 'false'); }
        if (version !== loadVersion) return;
        cache[section] = items;
        if (section === 'venues' && !readOnly) venuesCache = items;
        if (section === 'dashboard') {
            for (const [field, id] of [['totalTeams', 'total-teams'], ['completedTeams', 'completed-teams'], ['pendingTeams', 'pending-teams'], ['activeJuries', 'active-juries'], ['totalVenues', 'total-venues']]) document.getElementById(`stat-${id}`).textContent = items[field];
            document.getElementById('progress-text').textContent = `${items.completedEvaluations} / ${items.totalEvaluationsNeeded} evaluations completed`;
            document.getElementById('progress-bar').style.width = `${items.totalEvaluationsNeeded ? items.completedEvaluations / items.totalEvaluationsNeeded * 100 : 0}%`; return;
        }
        const render = {
            venues: v => `<td>${esc(v.name)}</td><td>${v.capacity}</td><td>${v.team_count}</td><td>${v.jury_count}</td><td>${actions('venues', v.id)}</td>`,
            criteria: c => `<td>${c.display_order}</td><td>${esc(c.name)}</td><td>${c.max_marks}</td><td>Active</td><td>${actions('criteria', c.id)}</td>`,
            teams: t => `<td>${esc(t.team_number)}</td><td>${esc(t.team_name)}</td><td>${esc(t.venue_name)}</td><td>${t.juries_count}</td><td>${t.evaluations_list.map(e => `${esc(e.jury_name)}: ${e.status === 'submitted' ? e.total_score : 'Draft'}`).join('<br>') || '—'}</td><td>${badge(t.status)}</td><td>${esc(t.final_score)}</td><td><button class="btn-secondary" data-view="${t.id}">View</button> ${actions('teams', t.id)}</td>`,
            juries: j => `<td>${esc(j.name)}</td><td>${esc(j.username)}</td><td>${esc(j.venue_name)}</td><td>${j.assigned_teams}</td><td>${j.completed_evaluations}</td><td>${j.active ? 'Active' : 'Inactive'}</td><td>${readOnly ? 'Archived' : `<button class="btn-secondary" data-assign="${j.id}">Assign Teams</button> ${actions('juries', j.id)}`}</td>`,
            leaderboard: t => `<td>${t.rank}</td><td>${esc(t.team_name)}</td><td>${esc(t.venue_name)}</td><td>${t.final_score} / ${t.max_score}</td><td>${badge(t.status)}</td>`,
            audit: l => `<td>${esc(new Date(l.created_at.includes('T') ? l.created_at : l.created_at.replace(' ', 'T') + 'Z').toLocaleString())}</td><td>${esc(l.user_name)}</td><td>${esc(l.action)}</td><td>${esc(l.entity_type)} ${l.entity_id || ''}</td><td>${esc(l.details)}</td>`
        };
        document.getElementById(`${section}-table-body`).innerHTML = items.length ? items.map(i => `<tr>${render[section](i)}</tr>`).join('') : '<tr><td colspan="8">No records yet.</td></tr>';
    }
    function navigate(section) {
        current = section;
        for (const name of sectionNames) { document.getElementById(name).classList.toggle('hidden', name !== section); document.getElementById(name).classList.toggle('active', name === section); }
        document.querySelectorAll('[data-target]').forEach(a => a.classList.toggle('active', a.dataset.target === section));
        load().catch(e => notice(e.message, true));
    }
    document.querySelectorAll('[data-target]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); navigate(a.dataset.target); }));
    document.querySelectorAll('[data-open-modal]').forEach(button => button.addEventListener('click', () => busy(button, async () => {
        const id = button.dataset.openModal;
        if (readOnly) throw new Error('Earlier rounds are read-only.');
        const form = document.querySelector(`#${id} form`); form?.reset(); if (form?.elements.id) form.elements.id.value = '';
        if (id === 'team-modal' || id === 'jury-modal') await dropdowns();
        if (id === 'jury-modal') { form.elements.password.required = true; form.elements.password.placeholder = 'At least 10 characters'; }
        modal(id);
    })));
    document.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', () => modal(button.dataset.closeModal, false)));
    document.querySelectorAll('.modal').forEach(element => element.addEventListener('click', e => { if (e.target === element) modal(element.id, false); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal.active').forEach(m => modal(m.id, false)); });
    document.getElementById('logout-btn').addEventListener('click', async e => { e.preventDefault(); try { await api('/api/logout', { method: 'POST' }); location.href = '/'; } catch (e) { notice(e.message, true); } });
    for (const [formId, type, modalId] of [['venue-form', 'venues', 'venue-modal'], ['criterion-form', 'criteria', 'criterion-modal'], ['team-form', 'teams', 'team-modal'], ['jury-form', 'juries', 'jury-modal']]) {
        const form = document.getElementById(formId);
        form.addEventListener('submit', e => { e.preventDefault(); busy(form.querySelector('[type=submit]'), async () => {
            const data = Object.fromEntries(new FormData(form)), id = data.id;
            const result = await send(`/api/${type}${id ? '/' + id : ''}`, data, id ? 'PUT' : 'POST');
            if (type === 'venues') venuesCache = undefined;
            modal(modalId, false); notice(result.message); await load();
        }); });
    }
    const importForm = document.getElementById('team-import-form');
    importForm.addEventListener('submit', e => { e.preventDefault(); busy(importForm.querySelector('[type=submit]'), async () => {
        const data = await api('/api/teams/import', { method: 'POST', body: new FormData(importForm) }); modal('team-import-modal', false); notice(data.message); await load('teams');
    }); });
    document.getElementById('master-reset-btn').addEventListener('click', e => busy(e.currentTarget, async () => {
        const confirmation = prompt('For the next judging round, cancel and use Start new round. Reset removes the current event setup and jury accounts; archived rounds and a backup remain. Type RESET EVENT to continue.');
        if (confirmation !== 'RESET EVENT') return;
        const result = await send('/api/master-reset', { confirmation }); alert(result.message); location.href = '/';
    }));
    const backup = document.createElement('a'); backup.href = '/api/backup'; backup.className = 'btn-secondary'; backup.textContent = 'Download Backup';
    document.getElementById('master-reset-btn').before(backup);
    const historyButton = document.createElement('button'); historyButton.className = 'btn-secondary'; historyButton.textContent = 'Saved Reset Backups';
    document.getElementById('master-reset-btn').before(historyButton);
    historyButton.addEventListener('click', () => busy(historyButton, async () => {
        const backups = await api('/api/backups'), dialog = document.createElement('dialog'); dialog.className = 'account-dialog';
        dialog.innerHTML = '<h2>Saved reset backups</h2>' + (backups.length ? backups.map(b => `<p><a href="/api/backups/${b.id}">Download backup from ${esc(b.created_at)}</a></p>`).join('') : '<p>No hosted reset backups. Local backups are kept in the server’s backups folder.</p>') + '<button class="btn-secondary" type="button">Close</button>';
        document.body.appendChild(dialog); dialog.showModal();
        dialog.querySelector('button').addEventListener('click', () => { dialog.close(); dialog.remove(); });
        dialog.addEventListener('cancel', () => dialog.remove());
    }));
    const assignmentModal = document.createElement('div'); assignmentModal.id = 'assignment-modal'; assignmentModal.className = 'modal';
    assignmentModal.innerHTML = '<div class="modal-content assignment-content"><div class="modal-header"><h3 id="assignment-title">Assign teams</h3><button class="modal-close" type="button" aria-label="Close">×</button></div><p>Add teams from any venue. Assignments with saved scores cannot be removed.</p><div id="assignment-list"></div></div>';
    document.body.appendChild(assignmentModal); assignmentModal.querySelector('.modal-close').addEventListener('click', () => modal('assignment-modal', false));
    let assignmentJury;
    async function assignments(id) {
        assignmentJury = id; const rows = await api(`/api/juries/${id}/assignments`);
        document.getElementById('assignment-title').textContent = `Assignments: ${cache.juries?.find(j => j.id === id)?.name || 'Jury'}`;
        document.getElementById('assignment-list').innerHTML = rows.map(t => `<label class="assignment-row"><input type="checkbox" data-assignment-team="${t.id}" ${t.assignment_id ? 'checked' : ''} ${t.eval_status ? 'disabled' : ''}> <span>${esc(t.team_number)} — ${esc(t.team_name)} (${esc(t.venue_name)})${t.eval_status ? ' · ' + esc(t.eval_status) : ''}</span></label>`).join('') || '<p>Create teams first.</p>';
        modal('assignment-modal');
    }
    assignmentModal.addEventListener('change', async e => {
        const input = e.target.closest('[data-assignment-team]'); if (!input) return; input.disabled = true;
        try { await send(`/api/juries/${assignmentJury}/assignments${input.checked ? '' : '/' + input.dataset.assignmentTeam}`, { team_id: Number(input.dataset.assignmentTeam) }, input.checked ? 'POST' : 'DELETE'); await load('juries'); }
        catch (error) { input.checked = !input.checked; notice(error.message, true); } finally { input.disabled = false; }
    });
    async function viewTeam(id) {
        const { team, evaluations, assignments } = await api(`/api/teams/${id}`);
        document.getElementById('td-title').textContent = `${team.team_number} — ${team.team_name}`;
        document.getElementById('td-content').innerHTML = `<p>Venue: ${esc(team.venue_name)}</p><p>Status: ${esc(team.status)}</p>` + assignments.map(a => {
            const e = evaluations.find(e => e.jury_id === a.jury_id);
            return `<div class="eval-card"><strong>${esc(a.jury_name)}</strong><p>${e ? `${e.total_score} / ${team.max_score} · ${badge(e.status)}` : 'Not started'}</p>${!readOnly && e?.status === 'submitted' ? `<button class="btn-secondary" data-unlock="${e.id}" data-team="${id}">Unlock</button>` : ''}</div>`;
        }).join('') + `<h3>Final average: ${esc(team.final_score)} / ${team.max_score}</h3>`;
        modal('team-details-modal');
    }
    document.addEventListener('click', e => {
        const button = e.target.closest('[data-edit], [data-delete], [data-view], [data-unlock], [data-assign]'); if (!button) return;
        busy(button, async () => {
            if (readOnly && !button.dataset.view) throw new Error('Earlier rounds are read-only. Switch to the active round.');
            if (button.dataset.edit) {
                const type = button.dataset.edit, item = cache[type]?.find(i => i.id === Number(button.dataset.id)); if (!item) return;
                const ids = { venues: 'venue', criteria: 'criterion', teams: 'team', juries: 'jury' }, prefix = ids[type];
                if (type === 'teams' || type === 'juries') await dropdowns();
                const form = document.getElementById(`${prefix}-form`); form.reset();
                for (const [key, value] of Object.entries(item)) if (form.elements[key]) form.elements[key].value = value;
                if (type === 'juries') { form.elements.password.value = ''; form.elements.password.required = false; form.elements.password.placeholder = 'Leave blank to keep password'; }
                modal(`${prefix}-modal`);
            } else if (button.dataset.delete) {
                if (!confirm(`Delete this ${button.dataset.delete === 'teams' ? 'team and all its scores' : 'record'}?`)) return;
                const data = await api(`/api/${button.dataset.delete}/${button.dataset.id}`, { method: 'DELETE' }); notice(data.message); await load();
                if (button.dataset.delete === 'venues') venuesCache = undefined;
            } else if (button.dataset.view) await viewTeam(Number(button.dataset.view));
            else if (button.dataset.assign) await assignments(Number(button.dataset.assign));
            else if (button.dataset.unlock) {
                const reason = prompt('Why should this evaluation be unlocked?'); if (!reason?.trim()) return;
                await send(`/api/evaluations/${button.dataset.unlock}/unlock`, { reason }); await viewTeam(Number(button.dataset.team)); await load();
            }
        });
    });
    try { await Portal.user('admin'); await refreshRounds(); await load(); }
    catch (e) { notice(e.message, true); }
    setInterval(() => { if (current === 'dashboard' && !readOnly && !document.hidden) load().catch(e => notice(e.message, true)); }, 10000);
});
