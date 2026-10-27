@echo off
title IngestX + CasparCG Production Startup

:: ===== Configuration =====
set "INGESTX_DIR=D:\Program\IngestX"
set "CASPAR_DIR=D:\Program\casperCG"
set "NGINX_DIR=D:\Program\NGINX"
set "TASKQUE_SERVICE_TOKEN=umJITqLDrkZUqwDDcTmWE_0q-Ar6JtrbWk7wPhLcpsI"

echo ============================================
echo  IngestX production startup
echo ============================================

:: 1. Start CasparCG Server (if not already running)
echo [1/6] Starting CasparCG Server...
tasklist /FI "IMAGENAME eq casparcg.exe" 2>nul | find /I "casparcg.exe" >nul
if errorlevel 1 (
    cd /d "%CASPAR_DIR%"
    start "" "casparcg.exe"
) else (
    echo       CasparCG already running.
)

:: 2. Wait for CasparCG to boot
echo [2/6] Waiting for CasparCG to initialize...
timeout /t 5 /nobreak >nul

:: 3. Send initial channel commands
echo [3/6] Sending initial commands to CasparCG...
(
  echo LOADBG 1 DECKLINK 1
  echo PLAY 1
  echo LOADBG 2 DECKLINK 2
  echo PLAY 2
) | powershell -NoProfile -Command "$cc = [System.Net.Sockets.TcpClient]::new('127.0.0.1', 5250); $str = $cc.GetStream(); $sw = [System.IO.StreamWriter]::new($str); foreach($line in $input){ $sw.WriteLine($line); $sw.Flush() }; $cc.Close()"

timeout /t 1 /nobreak >nul
echo       Adding RTMP stream for channel 1...
(
  echo ADD 1 STREAM rtmp://202.84.34.70/live/ING_3 -codec:v libx264 -filter:v format=yuv420p -b:v 500k -preset:v ultrafast -codec:a aac -b:a 64k -format flv
) | powershell -NoProfile -Command "$cc = [System.Net.Sockets.TcpClient]::new('127.0.0.1', 5250); $str = $cc.GetStream(); $sw = [System.IO.StreamWriter]::new($str); foreach($line in $input){ $sw.WriteLine($line); $sw.Flush() }; $cc.Close()"

timeout /t 1 /nobreak >nul
echo       Adding RTMP stream for channel 2...
(
  echo ADD 2 STREAM rtmp://202.84.34.70/live/ING_4 -codec:v libx264 -filter:v format=yuv420p -b:v 500k -preset:v ultrafast -codec:a aac -b:a 64k -format flv
) | powershell -NoProfile -Command "$cc = [System.Net.Sockets.TcpClient]::new('127.0.0.1', 5250); $str = $cc.GetStream(); $sw = [System.IO.StreamWriter]::new($str); foreach($line in $input){ $sw.WriteLine($line); $sw.Flush() }; $cc.Close()"

:: 4. Start Django backend (Daphne) on 127.0.0.1:8000 using the project venv
echo [4/6] Starting Django backend (Daphne)...
tasklist /FI "IMAGENAME eq daphne.exe" 2>nul | find /I "daphne.exe" >nul
if errorlevel 1 (
    start "IngestX Backend" cmd /k "cd /d %INGESTX_DIR%\backend && %INGESTX_DIR%\backend\.venv\Scripts\python.exe -m daphne -b 127.0.0.1 -p 8000 core.asgi:application"
) else (
    echo       Daphne already running.
)

:: Wait for backend health
echo       Waiting for backend to become healthy...
set /a WAIT=0
:wait_backend
curl.exe -s -o NUL -w "%%{http_code}" http://127.0.0.1:8000/healthz/ 2>nul | findstr "200" >nul
if not errorlevel 1 goto backend_ready
set /a WAIT+=1
if %WAIT% GEQ 30 (
    echo       WARNING: backend did not become healthy within 30s.
    goto backend_ready
)
timeout /t 1 /nobreak >nul
goto wait_backend
:backend_ready

:: 5. Start nginx reverse proxy (only if port 80 is free)
echo [5/6] Ensuring nginx is running...
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort 80 -ErrorAction SilentlyContinue)) { Start-Process '%NGINX_DIR%\nginx.exe' -WorkingDirectory '%NGINX_DIR%' }"

:: 6. Start TaskQue playout/recording engine
echo [6/6] Starting TaskQue main script...
set "TASKQUE_SERVICE_TOKEN=%TASKQUE_SERVICE_TOKEN%"
start "TaskQue Script" cmd /k "cd /d %INGESTX_DIR%\backend\TaskQue && set TASKQUE_SERVICE_TOKEN=%TASKQUE_SERVICE_TOKEN% && py mainscriptv6.py"

echo.
echo ============================================
echo  All services started.
echo  App:        http://127.0.0.1/  (LAN: http://172.19.4.201/)
echo  Django admin: http://127.0.0.1/4dm1n/
echo  Backend API:  http://127.0.0.1/api/
echo ============================================
pause
