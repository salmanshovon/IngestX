# IngestX

**Playout control plane for a broadcast channel.**

IngestX is the operator console and recording engine for a single commercial TV
channel. It schedules what goes to air, records incoming feeds into the media
library, reports what actually played out, and controls the playout agent that
talks to CasparCG.

The system has three parts:

| Part | Stack | Role |
| --- | --- | --- |
| `backend/` | Django 5.2 + DRF + Channels (Daphne) | Browser API, auth, scheduling, recordings, realtime updates |
| `frontend/` | React 19 + TypeScript + Vite + Tailwind 4 | Operator UI (schedule, exec log, settings, system, admin) |
| `backend/TaskQue/` | PyQt5 + QtWebSockets | Desktop playout/recording engine driving CasparCG |

---

## Features

- **Schedule timeline** — drag-and-drop rundown, chained items, live/next
  indicators, conflict and gap handling, bulk delete.
- **Recording lifecycle** — start/stop recordings, automatic fitting before the
  next scheduled item, disk coordination, cron-driven engine updates.
- **Media library and servers** — playout channels, servers and media items are
  first-class API resources.
- **Execution log** — what actually went to air, per item.
- **Realtime updates** — WebSocket channel `/ws/realtime/` with a 30 s polling
  fallback when the socket is unavailable.
- **Auth and RBAC** — session login, forced password change on first sign-in,
  one-time-code (OTP) password reset by email, per-role permission matrix, user
  activation/deactivation.
- **Service-to-service auth** — the TaskQue engine authenticates to Django with
  `TASKQUE_SERVICE_TOKEN`.

### Recording rules (enforced in both UI and API)

| Action | Rule |
| --- | --- |
| Delete | Blocked while a recording is live or recording, blocked for items queued within **15 s** of their start (`DELETE_CUTOFF_MS` / `DELETE_CUTOFF`), and blocked for items in the past. |
| Stop | Allowed only after the recording has run for at least **10 s** (`MIN_RECORD_MS` / `MIN_RECORDING_DURATION`). |
| Start | Recordings shorter than 10 s are rejected; the default length is 30 min, compressed to fit before the next item with a 10 s gap. |

The API returns the machine-readable codes `DELETE_BLOCKED`, `STOP_TOO_SOON` and
`NOT_RECORDING`; the UI mirrors the same windows client-side so invalid actions
are never offered.

---

## Repository layout

```
IngestX/
├── run.bat                 # one-click dev launcher (Daphne + Vite)
├── nginx.conf              # production reverse proxy (backend + built SPA)
├── backend/
│   ├── core/               # settings, ASGI/WSGI, root URLconf
│   ├── api/                # REST views, URL routes, WebSocket consumer
│   ├── accounts/           # custom user model, auth, roles, email backend
│   ├── records/            # schedule, media, server, recording models
│   ├── TaskQue/            # PyQt5 playout/recording engine
│   ├── requirements.txt
│   └── manage.py
└── frontend/
    ├── src/
    │   ├── pages/          # schedule, exec log, settings, system, auth, admin
    │   ├── components/     # layout and UI primitives
    │   ├── api/            # typed API client
    │   ├── lib/            # timeline, recording and time helpers
    │   ├── stores/         # Zustand stores
    │   └── config.ts       # product name, timezone, windows, API base
    ├── vite.config.ts      # dev proxy for /api on the same origin
    └── package.json
```

---

## Prerequisites

- **Python 3.10+** and `pip`
- **Node.js 18+** with `npm`
- **Redis** (optional) — without `REDIS_URL` the channel layer falls back to
  in-memory, which is fine for a single-process dev server.
- **CasparCG Server** (optional) — required for the TaskQue engine to actually
  play out or record.
- **PyQt5** — only for the desktop engine, not for the API or the SPA.

---

## Quick start

### One-click (Windows)

```bat
run.bat
```

Launches the backend with Daphne on `http://127.0.0.1:8000` and the frontend with
Vite on `http://localhost:5173`, each in its own console window.

### Manual

**Backend**

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate           # Windows
# source .venv/bin/activate      # Linux/macOS
pip install -r requirements.txt

# create backend/.env (see Configuration below)
python manage.py migrate
python manage.py createsuperuser # admin account
python -m daphne -b 0.0.0.0 -p 8000 core.asgi:application
```

`python manage.py runserver` also works for quick API work, but Channels needs
Daphne (or another ASGI server) for WebSockets.

**Frontend**

```bash
cd frontend
npm install
npm run dev                      # http://localhost:5173
```

The SPA calls the API on the **same origin**; Vite proxies `/api` to
`http://127.0.0.1:8000` in development. That is required, not cosmetic: session
cookies are `SameSite=Lax`, so direct cross-origin XHR would drop them and every
authenticated call would return 401.

Sign in with your **username**, not your email.

---

## Configuration

### Backend (`backend/.env`, loaded by `core/settings.py`)

| Variable | Purpose |
| --- | --- |
| `SECRET_KEY` | Django secret key (change in production) |
| `DEBUG` | `true` enables debug mode, permissive CORS and dev defaults |
| `ALLOWED_HOSTS` | Comma-separated hostnames |
| `ADMIN_URL` | Django admin path (default `admin/`) |
| `REDIS_URL` | Redis URL for the Channels layer; in-memory when unset |
| `STATIC_URL`, `STATIC_ROOT` | Static file URL and output directory |
| `CSRF_TRUSTED_ORIGINS` | Comma-separated trusted origins |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowed origins (production only) |
| `FRONTEND_LOGIN_URL` | Base URL used in password-reset emails |
| `TASKQUE_SERVICE_TOKEN` | Shared token for the TaskQue engine → API |
| `EMAIL_HOST`, `EMAIL_PORT` | SMTP host and port |
| `EMAIL_USE_SSL`, `EMAIL_USE_TLS` | SMTP transport security |
| `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD` | SMTP credentials |
| `DEFAULT_FROM_EMAIL`, `DEFAULT_FROM_NAME` | Sender identity for OTP mail |

Database is SQLite at `backend/db.sqlite3`; media lives in `backend/media/`.
The channel timezone is `Asia/Dhaka`.

### Frontend (`frontend/.env.local`, read by Vite)

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `''` (same origin) | Absolute backend origin when the SPA is served from another host |
| `VITE_CHANNEL_TIMEZONE` | `Asia/Dhaka` | Broadcast-day timezone |
| `VITE_DEV_PROXY_TARGET` | `http://127.0.0.1:8000` | Dev proxy target for `/api` |
| `VITE_PORT` | `5173` | Dev server port |

---

## API

All browser endpoints live under `/api/` and are session-authenticated.

| Group | Endpoints |
| --- | --- |
| Auth | `auth/login/`, `auth/logout/`, `auth/me/` |
| Password reset | `send_otp/`, `verify_otp/`, `pass_change/`, `pass_change_tess/` |
| Users | `userlist/`, `check_user/`, `create_user/`, `user_details/<id>/`, `user_update/<pk>/`, `user_delete/<id>/`, `user_activate/<id>/`, `user_deactivate/<id>/` |
| Roles | `permissions/`, `role_permissions/`, `role_create/`, `role_update/<id>/`, `role_delete/<id>/` |
| Schedule | `schedules/`, `schedules/bulk/`, `schedules/<pk>/`, `playout-channels/` |
| Library | `servers/`, `media-items/`, `record-settings/` |
| Recordings | `recordings/`, `recordings/<pk>/`, `record_ports/`, `start_record/`, `stop_record/`, `record_cron/<pk>/` |

Realtime: `ws://<host>/ws/realtime/` (Django Channels, cookie-authenticated).

---

## TaskQue playout engine

`backend/TaskQue/mainscriptv6.py` is a PyQt5 desktop application that:

- talks to **CasparCG** through a gateway thread,
- queues and schedules recordings on a disk coordinator thread,
- pushes schedule state to Django through `record_cron/<pk>/` using
  `TASKQUE_SERVICE_TOKEN`,
- exposes a local WebSocket server at `ws://127.0.0.1:8765` for the UI,
- writes rotating logs to `backend/TaskQue/logs/` (kept for 3 days).

```bash
cd backend
pip install PyQt5 requests
python TaskQue/mainscriptv6.py
```

The engine is Windows-oriented and expects a reachable CasparCG host. Keep
`TASKQUE_SERVICE_TOKEN` identical in `backend/.env` and the engine's environment.

---

## Production

1. Build the SPA:

   ```bash
   cd frontend
   npm ci
   npm run build            # emits frontend/dist
   ```

2. Collect backend static files:

   ```bash
   cd backend
   python manage.py collectstatic --noinput
   python manage.py migrate
   ```

3. Run the ASGI app behind nginx:

   ```bash
   python -m daphne -b 127.0.0.1 -p 8000 core.asgi:application
   ```

4. Use `nginx.conf` as the reverse proxy. It serves `frontend/dist`, proxies
   `/api`, the admin path, `/static` and `/media` to Daphne, upgrades `/ws/`,
   and allows large uploads (`client_max_body_size 1024m`). **Edit the `root`
   path and `server_name` before deploying**; the sample admin location is
   `/4dm1n/`, matching `ADMIN_URL` in `.env`.

Set `DEBUG=false`, a real `SECRET_KEY`, a non-default `TASKQUE_SERVICE_TOKEN`,
`ALLOWED_HOSTS`, and `CSRF_TRUSTED_ORIGINS` for the public hostname. Use Redis
(`REDIS_URL`) whenever you run more than one ASGI worker.

---

## Verification

```bash
# backend
cd backend
python manage.py check
python manage.py migrate --check

# frontend
cd frontend
npm run typecheck
npm run lint
npm run build
```

---

## Notes and gotchas

- The broadcast day is `Asia/Dhaka` in both backend settings and the SPA; the
  UI converts timestamps with `date-fns-tz` rather than the browser zone.
- Deleting a schedule item near its start is refused on purpose — the recorder
  has already been handed the item, so deleting it would race the engine.
- `MIN_RECORD_MS`, `DELETE_CUTOFF_MS` and `LOCK_WINDOW_MS` exist in
  `frontend/src/config.ts` and must stay in sync with the backend constants.
- Do not commit `backend/.env`, `backend/db.sqlite3`, `cookies.txt`, or runtime
  logs; the root `.gitignore` already excludes them.
- `frontend/README.md` contains deeper frontend notes; `backend/README.md`
  covers the API-only backend basics.
