document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const errorMsg = document.getElementById('error-message');

    // Check if already logged in
    fetch('/api/me')
        .then(res => {
            if (res.ok) {
                return res.json();
            }
            throw new Error('Not logged in');
        })
        .then(user => {
            if (user.role === 'admin') {
                window.location.href = '/admin.html';
            } else if (user.role === 'jury') {
                window.location.href = '/jury.html';
            }
        })
        .catch(() => {
            // Not logged in, stay on login page
        });

    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const button = loginForm.querySelector('button[type="submit"]');
            if (button.disabled) return;
            button.disabled = true;
            button.textContent = 'Signing in...';
            errorMsg.classList.add('hidden');
            
            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ username, password })
                });
                
                const data = await response.json();
                
                if (response.ok) {
                    if (data.role === 'admin') {
                        window.location.href = '/admin.html';
                    } else if (data.role === 'jury') {
                        window.location.href = '/jury.html';
                    }
                } else {
                    errorMsg.textContent = data.error || 'Login failed';
                    errorMsg.classList.remove('hidden');
                }
            } catch (error) {
                errorMsg.textContent = 'Server error. Please try again.';
                errorMsg.classList.remove('hidden');
            } finally {
                button.disabled = false;
                button.textContent = 'Login';
            }
        });
    }
});
