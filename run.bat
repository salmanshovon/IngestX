@echo off
setlocal

cd /d "%~dp0"

rem Ensure Node.js (npm) is available even if not on the system PATH
set "PATH=C:\Program Files\nodejs;%PATH%"

echo Starting backend (ASGI / Daphne) on http://127.0.0.1:8000 ...
start "XcoreIngest Backend" cmd /k "cd /d %~dp0backend && python -m daphne -b 0.0.0.0 -p 8000 core.asgi:application"

echo Starting frontend (Vite) on http://localhost:5173 ...
start "XcoreIngest Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

echo Both servers launched in separate windows.
endlocal