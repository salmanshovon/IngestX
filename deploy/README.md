# IngestX production deployment (Windows LAN)

This install runs at `D:\Program\IngestX` and is reachable from the LAN at
`http://172.19.4.201/` (and `http://DESKTOP-NQPRNGR/`).

## Topology

```
Browser (LAN)
   |
   v
nginx :80  (D:\Program\NGINX)
   |-- /            -> frontend\dist (built SPA, SPA fallback)
   |-- /api/        -> Daphne 127.0.0.1:8000
   |-- /4dm1n/      -> Django admin
   |-- /static/     -> backend\staticfiles
   |-- /media/      -> backend\media
   +-- /ws/         -> Django Channels WebSocket (upgrade)
```

Daphne runs the Django ASGI app (REST + WebSockets). SQLite lives at
`backend\db.sqlite3`; uploads at `backend\media\`.

## Commands

| Action | Command |
| --- | --- |
| Start / ensure running | `powershell -ExecutionPolicy Bypass -File deploy\start-ingestx.ps1` |
| Stop everything | `powershell -ExecutionPolicy Bypass -File deploy\stop-ingestx.ps1` |
| Restart backend only | stop the PID on port 8000; the watchdog restarts it |
| Enable autostart at logon | `powershell -ExecutionPolicy Bypass -File deploy\install-autostart.ps1` |
| Pull and redeploy | `powershell -ExecutionPolicy Bypass -File deploy\update.ps1` |

The supervisor (`deploy\watchdog.ps1`) checks the backend HTTP health every
10 s, restarts Daphne after three consecutive failures, starts nginx if port 80
is closed, and rotates Daphne logs older than 7 days.

Logs: `backend\logs\daphne-YYYYMMDD.log`, nginx: `D:\Program\NGINX\logs\`.

## Configuration

- Backend secrets and LAN origins: `backend\.env` (gitignored, `DEBUG=False`).
- Nginx: `nginx.conf` in this repo is the deployed copy at
  `D:\Program\NGINX\conf\nginx.conf`.
- The frontend is a same-origin build (`VITE_API_BASE_URL` empty), so session
  cookies and CSRF work without CORS.

## Autostart caveat

Autostart is a per-user Startup shortcut, because installing real Windows
services requires administrator rights. The server must therefore log in as
this user after a reboot. For a true boot-time service, run
`deploy\install-autostart.ps1` from an elevated shell after installing NSSM or
WinSW and register `deploy\watchdog.ps1` as a service.

## Firewall

Inbound TCP 80 must be allowed. If LAN clients cannot connect, run once in an
**elevated** PowerShell:

```powershell
New-NetFirewallRule -DisplayName 'IngestX HTTP' -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow -Profile Private
```

## Notes

- The channel layer is in-memory because a single Daphne process is used. For
  multiple ASGI workers install Redis, set `REDIS_URL` in `backend\.env`, and
  run one Daphne per core behind nginx.
- Password-reset OTP email needs the `EMAIL_*` values in `backend\.env`.
- The PyQt5 TaskQue playout/recording engine is a separate desktop component
  and is not started by this deployment; it needs CasparCG and PyQt5.
