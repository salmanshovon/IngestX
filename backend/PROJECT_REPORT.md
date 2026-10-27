# XcoreIngest / IngestX - Project Report

> Purpose: This report documents the existing project in enough detail to rebuild a **React frontend + Django backend** without re-reading the original codebase. It covers domain model, API contracts, recording workflow, desktop recording engine ("TaskQue"), and fixed TaskQue instructions that must be preserved.

---

## 1. Product Overview

**IngestX** is a broadcast ingest/recording scheduler. It lets operators:

- View multiple recording channels (ports) on a horizontal timeline.
- Schedule recordings by clicking on a channel track at a future time.
- Start/stop manual recordings immediately.
- Inspect and edit a scheduled clip's filename, start/end times.
- Track recording status (scheduled -> recording -> done/failed/stopped).
- Manage users, roles, permissions, departments.
- Authenticate, force first-login password change, reset password via OTP.

The system has **three runtime parts**:

1. **Django web backend** (`core`, `accounts`, `records`, `api`) - auth, data, REST API, templates.
2. **Browser frontend** (`templates/gv_ingest_recorder_3.html` + `static_src`) - timeline UI loaded into `rootbase.html`.
3. **TaskQue desktop engine** (`TaskQue/mainscriptv5.py` + `mainwindow.ui`) - PyQt5 app that:
   - listens on WebSocket `ws://127.0.0.1:8765`,
   - talks to CasparCG over TCP `127.0.0.1:5250`,
   - moves/repairs recorded files from `D:\Program\casperCG\media` to `Z:\`,
   - updates Django via `http://127.0.0.1:8000/api/record_cron/<id>/`.

The Django frontend and TaskQue communicate **indirectly**: Django writes DB rows and sends WebSocket commands to TaskQue; TaskQue executes CasparCG commands and patches Django status.

---

## 2. Tech Stack

- Python 3.12, Django 5.2.1, Django REST Framework 3.16, django-filter, python-dotenv.
- Database: SQLite (`db.sqlite3`).
- Auth: Django session + CSRF cookie; DRF SessionAuthentication + BasicAuthentication.
- Frontend: Django templates, jQuery, Bootstrap 5, custom CSS/JS.
- Desktop engine: PyQt5, QWebSocketServer, QThread, requests, websockets (used by Django side), ffmpeg/ffprobe, untrunc.
- Timezone: Django `TIME_ZONE = 'Asia/Dhaka'`. TaskQue uses fixed `+06:00`.

---

## 3. Repository Layout

```
XcoreIngest/
  core/            Django project (settings, urls, wsgi/asgi)
  accounts/        Custom User, Role, Department, auth views
  records/         RecordServer, RecordPort, Recording, RecordLog + admin
  api/             DRF views/serializers/utils (users, roles, recordings)
  api/cadets __/   inactive cadet API
  api/courses/     inactive course/subject API
  api/library/     inactive library API
  live/            inactive Stream/Servers/Outports models
  templates/       HTML templates; main frontend gv_ingest_recorder_3.html
  static_src/      CSS/JS source
  static/          collected static (admin, DRF)
  TaskQue/         PyQt5 recording engine
  manage.py
  .env
```

Only `records` and `accounts` are in `INSTALLED_APPS` among domain apps; `live`, `courses`, `library`, `projects` are commented out in `core/urls.py`. The active product is the **recording ingest scheduler**.

---

## 4. Domain Model

### 4.1 accounts.User (extends AbstractUser)

Fields:
- `email` unique indexed
- `phone_number` max 15
- `address` nullable
- `profile_picture` ImageField -> `profile_pictures/`
- `roles` M2M -> Role
- `department` FK -> Department (SET_NULL)
- `is_new` bool default True (forces password change)
- `otp` int nullable
- `is_cadet`, `is_teacher` bool

Signals keep Django `Group` in sync with `Role` and `User.roles`.

### 4.2 accounts.Role

- `name`, `description`
- `group` OneToOne -> Django Group
- `permissions` M2M -> Permission

### 4.3 accounts.Department

- `name`, `code` unique, `description`, `head` FK User, `parent_department` self FK, `is_active`, timestamps.

### 4.4 records.RecordServer

- `name`, `ip_address` (GenericIPAddress), `storage_path`, `is_active`.

### 4.5 records.RecordPort

- `server` FK
- `channel_index` int
- `name`
- `is_recording` bool
- unique_together: `server`, `channel_index`

### 4.6 records.Recording

- `port` FK RecordPort (SET_NULL)
- `filename` max 255
- `filepath` max 1000
- `start_time` DateTimeField default now
- `end_time` nullable
- `file_size` bigint default 0
- `status`: `SCHEDULED`, `RECORDING`, `COMPLETED`, `FAILED`, `STOPPED`
- `duration` property: end-start or now-start (0 if future start)
- `clean()`: end_time must be >= start_time + 10 seconds.
- `save()` calls `full_clean()`.

### 4.7 records.RecordLog

- `recording` FK nullable
- `timestamp` default now
- `event_type` default `SYSTEM`
- `message` text

### 4.8 live.* (inactive)

`Stream`, `Servers`, `Outports` models exist but are not installed/routed in active config. They appear intended for CasparCG output routing but are unused.

---

## 5. Authentication & Authorization

- Custom `AUTH_USER_MODEL = accounts.User`.
- Sign in: `/signin/` accepts username **or email** (SignInForm converts email to username).
- On login, if `user.is_new` is True, user is redirected to `pass_change.html` until password changed.
- Password change (authenticated): `POST /api/pass_change/` with `new_password`, `confirm_password`; sets `is_new=False`.
- Forgot password flow:
  1. `POST /api/send_otp/` {email} -> generates 6-digit OTP stored in `user.otp`, emails it.
  2. `POST /api/verify_otp/` {email, otp} -> validates; returns `tesseract` (a new random 6-digit value stored back into `user.otp`).
  3. `POST /api/pass_change_tess/` {email, tess, new_pass, confirm_pass} -> validates tess matches `user.otp`, sets password, clears otp.
- Logout: `/logout/`.

Permissions are Django model permissions. `EXCLUDED_PERMS` removes auth/admin/sessions and most records write perms from role assignment UI. User/role endpoints enforce:
- `accounts.view_user`, `accounts.add_user`, `accounts.change_user`, `accounts.delete_user`
- `accounts.view_role`, `accounts.add_role`, `accounts.change_role`, `accounts.delete_role`

Recording endpoints currently have **no permission enforcement** (AllowAny default; commented IsAuthenticated), except `RecordingDetailView` requires `IsAuthenticated`.

---

## 6. REST API Contract

Base URL: `/api/`

### 6.1 Users

| Method | Path | Purpose | Permission |
|---|---|---|---|
| GET | `/userlist/` | Paginated users (not superuser/cadet), search by name/email/username | `accounts.view_user` |
| GET | `/permissions/` | All Django permissions | none |
| POST | `/check_user/` | Username availability | `accounts.add_user` |
| POST | `/create_user/` | Create user, generate temp password, email it | `accounts.add_user` |
| GET | `/user_details/<id>/` | User + all roles | `accounts.change_user` |
| PATCH | `/user_update/<pk>/` | Update user | `accounts.change_user` |
| DELETE | `/user_delete/<id>/` | Delete user | `accounts.delete_user` |
| PATCH | `/user_deactivate/<id>/` | Deactivate | `accounts.change_user` |
| PATCH | `/user_activate/<id>/` | Activate | `accounts.change_user` |

Pagination: `page_size` default 10, max 100, param `page_size`.

`create_user` request fields: `username,email,first_name,last_name,phone_number,address,profile_picture,roles`. `roles` may be JSON array string or comma-separated. Response: `{message, username, email}` (no password).

`user_update` supports partial fields and profile picture.

### 6.2 Roles

| Method | Path | Purpose |
|---|---|---|
| GET | `/role_permissions/` | Roles with user counts + filtered permissions |
| POST | `/role_create/` | Create role |
| DELETE | `/role_delete/<id>/` | Delete role |
| PATCH/PUT | `/role_update/<id>/` | Update role |

Role create/update fields: `name, description, permissions` (list of permission IDs).

### 6.3 Password / OTP

| Method | Path | Body |
|---|---|---|
| POST | `/pass_change/` | `{new_password, confirm_password}` (authenticated) |
| POST | `/pass_change_tess/` | `{email, tess, new_pass, confirm_pass}` |
| POST | `/send_otp/` | `{email}` |
| POST | `/verify_otp/` | `{email, otp}` -> `{message, tesseract}` |

### 6.4 Record Ports

| Method | Path | Query |
|---|---|---|
| GET | `/record_ports/` | `?available=true` returns non-recording ports on active servers |

Response fields: `id, server{id,name,ip_address,is_active}, channel_index, name, display_name, is_recording`.

### 6.5 Recordings

| Method | Path | Purpose |
|---|---|---|
| GET | `/recordings/` | List recordings whose `start_time` date is yesterday/today/tomorrow |
| POST | `/recordings/` | Create recording; sends WebSocket `CREATE` |
| GET | `/recordings/<pk>/` | Retrieve one |
| PUT/PATCH | `/recordings/<pk>/` | Update; sends WebSocket `UPDATE` |
| DELETE | `/recordings/<pk>/` | Delete; sends WebSocket `DELETE` |
| GET/PUT/PATCH/DELETE | `/record_cron/<pk>/` | Same serializer, no auth; used by TaskQue |

Recording fields:
```
id, port (RecordPort id), filename, filepath, start_time (ISO), end_time (ISO), file_size, status, duration (read-only string)
```

Create example (scheduled):
```json
{
  "port": 1,
  "filename": "BTI_20250101_120000_CH1-ING_3",
  "filepath": "D:\\Program\\casperCG\\media",
  "start_time": "2025-01-01T12:00:00Z",
  "end_time": "2025-01-01T12:10:00Z",
  "status": "SCHEDULED"
}
```

### 6.6 Manual Recording Control

| Method | Path | Body | Behavior |
|---|---|---|---|
| POST | `/start_record/` | `{port, filename, filepath, start_time, end_time, status:"RECORDING"}` | Creates Recording; sends WS `start_now` |
| POST | `/stop_record/` | `{id, end_time}` | Sets status `STOPPED`, end_time; sends WS `stop_now` |

`start_record` response:
```json
{
  "message": "Recording start command sent to PyQt5",
  "task_data": {
    "id": <recording id>,
    "filename": "...",
    "start_time": "...",
    "end_time": "...",
    "port": <port id from request>
  }
}
```

`stop_record` response:
```json
{
  "message": "Recording stop command sent to PyQt5",
  "id": <id>,
  "filename": "...",
  "task_data": {"id":..., "filename":..., "port": <port.channel_index>}
}
```

---

## 7. Frontend (`gv_ingest_recorder_3.html`)

### 7.1 Shell

Rendered by `HomeView` inside `rootbase.html` (`#new-content`) when requested via AJAX; direct load wraps in rootbase. Top navbar, user dropdown, theme toggle, modals are in rootbase.

### 7.2 Time Model

- All internal times are **epoch milliseconds**.
- `zoomMs` one of `[5,10,15,30,60,120]` minutes (default 30).
- `viewOffsetMs` start of visible window (default now - zoom/4).
- `pxFromMs(ms) = ((ms - viewOffsetMs)/zoomMs) * TRACK_WIDTH_PX`.
- `TRACK_WIDTH_PX` measured from ruler width (~1453 fallback).

### 7.3 Channels

Loaded from `GET /api/record_ports/`. Each channel:
```
id = "CH" + port.id + "-" + port.name
label = display_name || name
color = cycle [teal,red,purple,orange]
channelIndex = port.channel_index
portId = port.id
isRecording = port.is_recording
serverName = port.server.name
```
State per channel: `{recording, clips:[], activeClip}`.

Each channel row has:
- status dot + label
- `channel-preview-box` containing an iframe to `https://itvstreamx.duckdns.org:8889/<streamKey>/?autoplay=true`, where `streamKey` is the part after the first `-` in channel id (e.g. `ING_3`).
- START/STOP REC button.

### 7.4 Clips

Clip object:
```
{
  startMs, endMs,
  status: 'scheduled'|'recording'|'polling'|'done'|'error',
  recording: bool,
  filename, filepath,
  serverId, serverStatus,
  startLocked: bool,
  fromServer: bool,
  checkedStart, checkedEnd,
  statusError
}
```

Rendering colors:
- scheduled: yellow `#fff8e1` border `#ff9500`
- recording: red `#4a1a1a` border `#ff3b30`
- done: green `#1a3a1a` border `#34c759`
- error: dark red `#3a1a1a` border `#ff3b30`

Scheduled clips get right drag handle (end). If not locked, also left handle (start). Click selects clip -> inspector.

### 7.5 Interactions

- Ruler/channel track drag pans timeline.
- Zoom +/- changes `zoomMs`.
- "Now" button recenters.
- Right-click track opens context menu:
  - Schedule Recording Here
  - Duplicate (only if clicked near a scheduled clip)
  - Delete Scheduled Clip (only if clicked near a scheduled clip)
- Schedule:
  - `preferredStart = max(clickMs, now)`
  - duration = `calcDuration`: default 10 min, but if another non-done clip starts within that window, duration = gap - 10 sec; if gap <= 10 sec, cannot schedule.
  - overlap check rejects if intersects any non-done clip.
  - creates local clip, POSTs `/api/recordings/`.
- Duplicate: new start = original.end + 10 sec, same duration, checks overlap.
- Delete: DELETE `/api/recordings/<serverId>/`, splice local.
- Drag handles adjust start/end with overlap protection. On drag end:
  - recording clip: auto-PATCH end_time.
  - scheduled clip: show Save button (dirty).

### 7.6 Inspector

Shows selected clip:
- filename suffix editable (prefix shown separately; prefix format `BTI_YYYYMMDD_HHMMSS_`)
- channel, start, end, duration, location "ITV-SAN FTP", status.
- Start/end editable only for scheduled unlocked clips.
- Filename editable for scheduled-unlocked or recording clips.
- Recording clip: end time editable (patch on save).
- Save PATCHes `/api/recordings/<serverId>/`.
- Delete for scheduled unlocked.

### 7.7 Status Polling (One-shot, not loops)

- `scheduleStatusCheck(chId, idx, 'start'|'end', retries=5)`:
  - waits until clip.startMs/endMs, then GETs recording.
  - start: if status `RECORDING`, mark recording and schedule end check; else retry up to 5 with delays `[500,1000,1500,2000,2500]`.
  - end: if `COMPLETED/FAILED/STOPPED`, mark done; else retry.
  - after retries exhausted, set status `error` with message.
- Clock tick (1s) also flips scheduled->polling at start time and locks start 30s before.

### 7.8 Manual Recording

`toggleRec(chId)`:
- Start:
  - now -> now+10min, overlap check.
  - filename = `buildPrefix(now) + ch.id`.
  - POST `/api/start_record/`.
  - read `responseData.task_data.id` as serverId.
  - create recording clip, `scheduleStatusCheck(...,'end')`.
- Stop:
  - POST `/api/stop_record/` with `{id, end_time: now}`.
  - set clip recording false, status `polling`, schedule end check.
  - clear active.

### 7.9 Counts

Status bar shows recording count and scheduled count.

---

## 8. TaskQue Desktop Engine (Fixed Instructions)

This is the critical part. These behaviors must be preserved.

### 8.1 Runtime Threads

1. `CasparGatewayThread`: one persistent TCP socket to CasparCG (`127.0.0.1:5250`), sequential AMCP commands from queue, 5s timeout, reconnect if socket lost.
2. `DiskCoordinatorThread`: ffmpeg integrity check, optional untrunc repair, move+rename to `Z:\`.
3. `DjangoApiUpdaterThread`: PATCH `http://127.0.0.1:8000/api/record_cron/<id>/` with JSON payload.
4. `SchedulerThread`: in-memory event list sorted by time; waits until next event; emits `event_triggered(action, task, is_manual=False)`.

WebSocket server on `localhost:8765`.

### 8.2 CasparCG Commands

Start recording:
```
ADD <channel> FILE <id>.mp4 <media_path> -filter:a "pan=stereo|c0=c0|c1=c1" -filter:v "setdar=4/3" -movflags +frag_keyframe+empty_moov+faststart
```
Where:
- `<channel>` = `task['port']` (from Django task data)
- `<id>` = recording id
- `media_path` = `D:\Program\casperCG\media`

Stop recording:
```
REMOVE <channel> FILE <id>.mp4
```

Socket protocol: send command + `\r\n`, recv 4096, success if response contains `RESULT`, `202`, or `201`.

### 8.3 Scheduler Event Logic

- `refresh_tasks()`:
  - GET `http://127.0.0.1:8000/api/recordings/`.
  - Keep tasks where `end_time > now` (timezone +06).
  - For each finished-ish file (`end_time <= now`) not yet moved, queue disk move.
  - `build_task_queue()` creates `Start Rec` for future `start_time`, `Stop Rec` for future `end_time`.
  - `scheduler.update_tasks(tasks)` adds events for future starts/stops only.
- Midnight refresh reschedules next day.
- On Caspar result, `_fired_actions` prevents duplicate dispatch for same `(rec_id, action)`.

### 8.4 WebSocket Commands (Django -> TaskQue)

Endpoint: `ws://127.0.0.1:8765`. JSON `{command, task_data}` (or `task`).

Supported commands:

| Command | Behavior |
|---|---|
| `CREATE` | Add/replace task in memory, rebuild queue/table/scheduler |
| `UPDATE` | Same as create |
| `DELETE` | Remove task by id from memory and queue |
| `start_now` | Add task; emit history; dispatch START_REC manually; add Stop Rec queue item if end future; scheduler update with `start_time` rewritten to now (so only STOP event remains) |
| `stop_now` | Dispatch STOP_REC manually; mark queue row "Stopping..."; no disk move yet |
| `update_task` | Add/replace task, rebuild |
| `update_schedule` / `refresh_tasks` | Full refresh from Django |
| `rename_file` | `{rec_id, new_filename}` queue disk move from media or destination to `Z:\new_filename` |
| `get_status` | Returns `{type:"status", data:{pending}}` |

TaskQue also broadcasts every 1s to all clients:
```json
{"type":"live_update","pending":N,"active":M}
```

### 8.5 Disk Coordinator (Fixed)

For each completed recording:
- Wait up to 30s for file to exist and size > 0.
- Run `ffprobe -v error -show_entries stream=codec_type,duration -of default=noprint_wrappers=1 <file>`.
- If stderr contains `error/invalid/corrupt/truncat/missing/moov atom not found`, mark corrupt.
- If corrupt:
  - run untrunc: `D:\untrunc\untrunc.exe D:\untrunc\reference.mp4 <file>` (timeout 30 min).
  - look for `<name>_fixed.mp4` or `<stem>_fixed.mp4`; if found replace original.
  - else verify original with ffprobe.
- Move with retries (10 x 5s): `shutil.move(media\<id>.mp4, Z:\<filename>.mp4)`, creating parent dirs, overwriting destination.
- Timezone not relevant here.

### 8.6 Django Status Updates from TaskQue

On Caspar result:
- Start success -> PATCH `/api/record_cron/<id>/` `{status: "RECORDING"}`.
- Start failure -> `{status: "FAILED"}`.
- Stop success -> `{status: "COMPLETED"}`.
- Stop failure -> `{status: "FAILED"}`.
- Stop success also queues disk move.

On manual `stop_now`, TaskQue does **not** remove task immediately; waits for Caspar confirmation, then moves file and removes task from memory.

### 8.7 History Log

Local JSON `logs/history_log.json`, retained 3 days. Entries: `rec_id, filename, task_type, status, executed_at (ISO +06), details`. Also daily rotating log `logs/playout_engine_YYYYMMDD.log`.

---

## 9. File Naming & Storage

- Frontend prefix: `BTI_YYYYMMDD_HHMMSS_` (local browser time).
- Suffix: channel id (e.g. `CH1-ING_3`) or clip name.
- Django stores `filename` without extension and `filepath` = `D:\Program\casperCG\media`.
- TaskQue writes Caspar file `<id>.mp4` in media path.
- After successful stop, moved to `Z:\<filename>.mp4`.
- Manual recording default duration 10 minutes.

---

## 10. Environment / Configuration

`.env` keys:
```
SECRET_KEY
DEBUG
ADMIN_URL (4dm1n/)
TRAP_URL (admin/)
EMAIL_HOST, EMAIL_PORT, EMAIL_USE_SSL, EMAIL_USE_TLS, EMAIL_HOST_USER, EMAIL_HOST_PASSWORD
DEFAULT_FROM_EMAIL, DEFAULT_FROM_NAME
STATIC_URL (/static/)
STATIC_ROOT (D:/Program/XcoreIngest/static/)
FRONTEND_LOGIN_URL
CSRF_TRUSTED_ORIGINS (comma list)
```

`manage.py` standard. Static source in `static_src/`, collected to `STATIC_ROOT`.

---

## 11. Suggested React + Django Rebuild Plan

### Backend (Django)
- Keep models and API contracts above.
- Replace template rendering with JSON API + CORS/CSRF or token auth. If using session auth, keep CSRF.
- Ensure recording endpoints enforce permissions as needed.
- Keep `record_cron` endpoint for TaskQue or secure it with a service token.
- Keep WebSocket sender (`send_command_to_pyqt`) but consider moving to Channels if frontend needs realtime.

### Frontend (React)
- Replicate timeline: channels, ruler, clips, drag, zoom/pan, inspector, context menu.
- Use epoch ms time model exactly.
- Keep API field names (`port`, `filename`, `filepath`, `start_time`, `end_time`, `status`).
- Keep status polling strategy (one-shot at start/end with retries) or replace with WebSocket/SSE.
- Channel preview iframe URL pattern.
- Preserve manual recording flow and `task_data.id` extraction.

### Desktop Engine
- Do not change fixed instructions unless explicitly required: Caspar AMCP strings, paths, WebSocket commands, disk repair/move, Django patch URLs, timezone, retry counts.

---

## 12. Known Gaps / Inconsistencies to Be Aware Of

- `task['port']` from Django is a RecordPort id in `start_record`, but TaskQue treats it as a Caspar channel number. In scheduled flow, `port` is also RecordPort id. If port IDs and Caspar channel indices differ, this is a latent bug; preserve or fix deliberately.
- Recording endpoints mostly unauthenticated.
- `live`, cadets, courses, library modules are present but not wired.
- `models_from_db.py` is a generated artifact, not used.
- Frontend hardcodes `FILEPATH`, preview stream host, TaskQue hardcodes Windows paths.
- No automated tests.

---

## 13. Quick Reference: Constants

- Django API base: `http://127.0.0.1:8000/api/`
- TaskQue WebSocket: `ws://127.0.0.1:8765`
- CasparCG: `127.0.0.1:5250`
- Django record cron: `http://127.0.0.1:8000/api/record_cron/`
- Media path: `D:\Program\casperCG\media`
- Destination: `Z:\`
- untrunc: `D:\untrunc\untrunc.exe`, reference `D:\untrunc\reference.mp4`
- Preview stream: `https://itvstreamx.duckdns.org:8889/<key>/?autoplay=true`
- Default recording duration: 10 minutes
- Minimum gap: 10 seconds
- Start lock window: 30 seconds before start
- Timezone: Asia/Dhaka / +06:00