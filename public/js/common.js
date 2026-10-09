const Portal = (() => {
    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('.form-group').forEach((group, i) => {
            const label = group.querySelector('label'), input = group.querySelector('input, select');
            if (label && input) { if (!input.id) input.id = `field-${i}`; label.htmlFor = input.id; }
        });
    });
    const nativeFetch = window.fetch.bind(window);
    let roundId = null, selectedRound = null, roundIsArchived = false, staleRound = false;
    const setRound = round => { roundId = round.id; staleRound = false; };
    const selectRound = (id, archived = false) => { selectedRound = id; roundIsArchived = archived; };
    // Every state-changing request carries a header that cross-site forms cannot send.
    window.fetch = (url, options = {}) => nativeFetch(url, { ...options,
        headers: { ...options.headers, 'X-Requested-With': 'JuryPortal' }, credentials: 'same-origin' });
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    async function api(url, options = {}) {
        const scoped = /^\/api\/(dashboard|teams(?:\/|$)|juries(?:\/|$)|venues(?:\/|$)|criteria(?:\/|$)|leaderboard|audit-logs|reports\/)/.test(url);
        const writes = options.method && !['GET', 'HEAD'].includes(options.method);
        if (writes && !['/api/login', '/api/logout', '/api/password'].includes(url)) {
            if (staleRound) throw new Error('The judging round changed. Refresh the portal before saving.');
            if (roundIsArchived) throw new Error('Earlier rounds are read-only. Switch to the active round.');
            options = { ...options, headers: { ...options.headers, ...(roundId ? { 'X-Portal-Round': String(roundId) } : {}) } };
        }
        if (scoped && selectedRound) url += `${url.includes('?') ? '&' : '?'}round=${selectedRound}`;
        let response;
        try { response = await fetch(url, options); } catch { throw new Error('Cannot reach the server. Check the Wi-Fi connection, then retry.'); }
        const data = await response.json().catch(() => ({ error: 'The server returned an unexpected response.' }));
        if (response.status === 401 && !['/api/login', '/api/password'].includes(url)) { location.href = '/'; throw new Error('Please log in again.'); }
        if (!response.ok) {
            if (data.code === 'ROUND_CHANGED') staleRound = true;
            throw Object.assign(new Error(data.error || 'Request failed.'), { code: data.code });
        }
        return data;
    }
    const send = (url, body, method = 'POST') => api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    function notice(message, error = false) {
        let box = document.getElementById('portal-notice');
        if (!box) { box = document.createElement('div'); box.id = 'portal-notice'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
        box.textContent = message; box.className = error ? 'portal-notice error' : 'portal-notice'; box.hidden = false;
        clearTimeout(box.timer); box.timer = setTimeout(() => { box.hidden = true; }, error ? 15000 : 5000);
    }
    async function busy(button, work) {
        if (button.disabled) return;
        button.disabled = true; const label = button.textContent; button.textContent = 'Please wait…';
        try { return await work(); } catch (error) { notice(error.message, true); }
        finally { button.disabled = false; button.textContent = label; }
    }
    function passwordDialog(required = false) {
        return new Promise(resolve => {
            document.getElementById('password-dialog')?.remove();
            const dialog = document.createElement('dialog'); dialog.id = 'password-dialog'; dialog.className = 'account-dialog';
            dialog.innerHTML = `<h2>${required ? 'Set a secure password' : 'Change password'}</h2>
                <p>${required ? 'Change the initial administrator password before setting up the event.' : 'Use at least 10 characters.'}</p>
                <form><div class="form-group"><label for="current-password">Current password</label><input id="current-password" type="password" autocomplete="current-password" required></div>
                <div class="form-group"><label for="new-password">New password</label><input id="new-password" type="password" minlength="10" autocomplete="new-password" required></div>
                <div class="form-group"><label for="confirm-password">Confirm new password</label><input id="confirm-password" type="password" minlength="10" autocomplete="new-password" required></div>
                <p class="account-error" role="alert"></p><button class="btn-primary" type="submit">Save password</button>
                ${required ? '' : '<button class="btn-secondary" type="button" data-cancel>Cancel</button>'}</form>`;
            document.body.appendChild(dialog); dialog.showModal();
            dialog.addEventListener('cancel', event => { if (required) event.preventDefault(); else { dialog.remove(); resolve(); } });
            dialog.querySelector('[data-cancel]')?.addEventListener('click', () => { dialog.close(); dialog.remove(); resolve(); });
            dialog.querySelector('form').addEventListener('submit', async event => {
                event.preventDefault(); const error = dialog.querySelector('.account-error'); error.textContent = '';
                const value = dialog.querySelector('#new-password').value;
                if (value !== dialog.querySelector('#confirm-password').value) { error.textContent = 'The new passwords do not match.'; return; }
                const button = dialog.querySelector('[type=submit]'); button.disabled = true;
                try { await send('/api/password', { current_password: dialog.querySelector('#current-password').value, new_password: value });
                    dialog.close(); dialog.remove(); notice('Password changed.'); resolve(); }
                catch (e) { error.textContent = e.message; } finally { button.disabled = false; }
            });
        });
    }
    async function user(role) {
        const current = await api('/api/me');
        if (current.round) setRound(current.round);
        if (current.role !== role) { location.href = current.role === 'admin' ? '/admin.html' : '/jury.html'; throw new Error('Opening your portal.'); }
        if (current.must_change_password) await passwordDialog(true);
        const nav = document.querySelector('.nav-links');
        if (nav) { const li = document.createElement('li'), button = document.createElement('button'); button.className = 'btn-secondary account-button'; button.textContent = 'Change password'; li.appendChild(button); nav.appendChild(li); button.addEventListener('click', () => passwordDialog()); }
        return current;
    }
    return { api, send, escape, notice, busy, user, setRound, selectRound };
})();
