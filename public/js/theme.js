document.addEventListener('DOMContentLoaded', () => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-toggle-btn';
    const header = document.querySelector('.sidebar-header');
    if (header) header.appendChild(button);
    else {
        const wrapper = document.createElement('div');
        wrapper.className = 'theme-toggle-wrapper';
        wrapper.appendChild(button);
        document.body.appendChild(wrapper);
    }
    function setTheme(theme) {
        document.documentElement.dataset.theme = theme;
        button.textContent = theme === 'dark' ? 'Light' : 'Dark';
        button.setAttribute('aria-label', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode');
        button.title = button.getAttribute('aria-label');
    }
    let saved = 'light';
    try { saved = localStorage.getItem('theme') || 'light'; } catch (_) { /* Storage may be unavailable. */ }
    setTheme(saved === 'dark' ? 'dark' : 'light');
    button.addEventListener('click', () => {
        const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        setTheme(theme);
        try { localStorage.setItem('theme', theme); } catch (_) { /* Theme still works for this page. */ }
    });
});
