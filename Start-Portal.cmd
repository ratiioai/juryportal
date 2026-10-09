@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo Install Node.js 24 LTS before starting Jury Portal.
    pause
    exit /b 1
)
if not exist node_modules\express (
    echo Dependencies are missing. Run npm ci in this folder first.
    pause
    exit /b 1
)
echo Keep this window open during the event. Press Ctrl+C to stop safely.
node server.js
pause
