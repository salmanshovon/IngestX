# PlyOut v2 — Detailed Project Report

> **Scope of this report.** This document describes the PlyOut broadcast playout platform as it exists in
> `D:\Salman\Utilities\PlyOut_v2` (Backend + Frontend repositories). It explains how the system works,
> the React styling system, every page, how the scheduler works, and every rule that is applied. No source
> code was modified to produce it. Sources: `PLYOUT_SPECIFICATION.md`, `PLYOUT_REQUIREMENTS.md`,
> `PLYOUT_PLAN.md`, and the implementation under `Backend/` and `Frontend/`.

---

## 1. What PlyOut Is

PlyOut is a **television broadcast playout automation system** for a single commercial TV channel in
Bangladesh (Asia/Dhaka, UTC+06). Its job is to take a **continuous live programme feed** arriving over
SRT/RTMP, **interrupt it with scheduled commercial breaks and graphics**, and produce:

1. The channel's **on-air output** (RTMP, 1080p50, 2.5 Mbps).
2. A **low-resolution preview feed** (320 px wide, 25 fps, 500 kbps) for operator confidence.

It does four things:

1. **Ingest** a live stream into a *buffer channel* that runs continuously and never stops.
2. **Schedule** a timeline of events (ad breaks, L-Shape graphics, DOG/BUG/TICKER overlays) on a visual,
   drag-and-drop timeline UI.
3. **Execute** the timeline with frame-accurate animation against a CasparCG video server, then route
   back to the buffered live feed automatically.
4. **Report** what actually went to air (as-run log) with duration, media and status.

The product is **PlyOut**. Legacy vestigial branding ("StreamX", "IngestX", "Aranya Technology") is
not product identity and must not surface in the UI.

---

## 2. Architecture

### 2.1 Three cooperating processes

| # | Process | Role |
|---|---|---|
| 1 | **Django web app** (`Backend/`) | Users/roles, media library, graphics templates, output pipelines, schedule authoring, as-run reports, realtime fan-out. **Contains no scheduler.** |
| 2 | **TaskQue playout agent** (`runv5.py`, PyQt5, retained unmodified) | Polls Django, drives CasparCG over AMCP, PATCHes status + logs back. **This is the real scheduler.** |
| 3 | **CasparCG server** (external, port 5250) | Renders channels/layers, executes AMCP commands, encodes outputs via ffmpeg. |

### 2.2 Port map

| Port | Protocol | Owner | Direction |
|---|---|---|---|
| 8000 | HTTP | Django | browser → Django; agent → Django (REST) |
| 8766 | WebSocket (`ws://`) | TaskQue agent | Django connects **out** to `server.ip:8766` |
| 5250 | AMCP over raw TCP | CasparCG | agent → CasparCG (127.0.0.1 only) |
| 8765 | WebSocket | legacy recorder | unused by playout |

### 2.3 Key architectural fact

> **Django is authoritative for configuration and intent. The agent is authoritative for execution.**

Django dials outbound to the agent and closes after each message (connect-per-message). The agent polls
`GET /api/pipelines/` and `GET /api/schedule/` every 300 s as a safety net.

### 2.4 Layer map (CasparCG)

| Target | Purpose |
|---|---|
| ch1 : layer 21 | **PROGRAM** — live route *or* ad chain |
| ch1 : layer 20 | **GRAPHICS** — CG overlay alpha |
| ch1 : consumer 99 | **AIR OUT** (ffmpeg → RTMP) |
| ch1 : consumer 98 | **PREVIEW OUT** |
| ch2 : layer 1 | **LIVE SOURCE** (SRT ingest) |
| ch2 : layers 2 / 3 / 4 | TICKER / BUG / DOG (SCG loops) |

Layers 99/98 and 2/3/4 are engine-side env constants, not DB columns.

---

## 3. Domain Model

### 3.1 Entities

- **Server** — a box running CasparCG + the agent. `name` (unique, the agent's self-identity), `ip_address`, `amcp_port` (default 5250), `is_active`, plus new `engine_heartbeat_at`, `engine_version`, `engine_token_digest`.
- **OutputPipeline** — **the central abstraction**: one on-air output channel = CasparCG ch1 + ch2 buffer pair + one set of stream URLs. Fields: `server`, `name`, `primary_channel_number` (1), `primary_playout_layer` (21), `primary_graphics_layer` (20), `secondary_channel_number` (2), `secondary_receiver_layer` (1), `stream_source_url`, `output_destination_url`, `preview_stream_url`, `preview_embed_url` (new), `is_on_air` (new, derived). `unique_together (server, primary_channel_number)`.
- **GraphicsTemplate** — animation timing + DVE geometry for a CG overlay. `name`, `template_path`, `template_type ∈ {L_SHAPE, POPUP, LOWER_THIRD}`, `fps`, `in_frames`, `out_frames`, `hold_seconds`, `hold_frames`, `squeeze_x/y/w/h ∈ [0.0,1.0]`.
- **MediaItem** — a media file discovered on a server's disk. `title`, `media_type ∈ {FILE, CG, SCG}`, `server` (required), `active_status`, `file_path`, `duration_seconds`, `duration_frames`, `start_frame`, `end_frame`, `fps`, `template` (FK nullable — mandatory for CG), `probe_error`, `last_scanned_at`. `unique_together (server, file_path)`.
- **ScheduleEvent** — one timed instruction on one pipeline's timeline. `pipeline`, `action_type ∈ {PLAY_MEDIA, ROUTE_STREAM}`, `media_item` (nullable, required for PLAY_MEDIA), `media_lane ∈ {FILE, CG, DOG, BUG, TICKER}` (required for PLAY_MEDIA), `scheduled_time` (the **start**), `end_time` (only meaningful for SCG), `status ∈ {PENDING, PLAYING, COMPLETED, FAILED, CANCELLED}`, plus `hold_seconds`, `version` (optimistic concurrency), `created_by`/`updated_by`, `note`, `engine_claimed_at`. **No duration column.**
- **ExecutionLog** — as-run log written by the engine. `pipeline`, `schedule`, `timestamp` (indexed, server-set), `level ∈ {INFO, WARNING, ERROR}`, `action`, `message`, `raw_response`, `agent_source`.
- **Accounts** — `User(AbstractUser)` with `email` (unique), `phone_number`, `address`, `profile_picture`, `roles` M2M→Role, `department` FK, `is_new` (forces first-login password change), `otp` (reused as password-reset "tesseract" token), `is_cadet`, `is_teacher`. `Role` ↔ `auth.Group` ↔ `Permission` kept in lockstep by three signals.

### 3.2 The three media types

| Type | Filename prefix | Meaning | Duration source | Layer |
|---|---|---|---|---|
| FILE | `FILE_*` | Full-screen commercial replacing the programme | Probed from file | ch1 L21 |
| CG | `CG_*` | L-Shape / PopUp overlay with alpha, squeezed by DVE | **From the linked GraphicsTemplate** | ch1 L20 |
| SCG | `SCG_*` | Standalone transparent loop — DOG / BUG / TICKER. Loops. | Probed + explicit event `end_time` | ch2 L2/3/4 |

All CG `MediaItem`s carry `duration_seconds = 0`. Any code computing a CG block length from `duration_seconds` produces zero.

### 3.3 GraphicsTemplate duration formula (exact)

```
hold_from_frames = hold_frames / fps            (if fps > 0 else 0)
anim_duration    = (in_frames + out_frames) / fps (if fps > 0 else 0)
total_duration_seconds = anim_duration + float(hold_seconds) + hold_from_frames
```

Example: `LS_10Sec`: fps 25, in 12, out 6, hold 9.00 s, hold_frames 10 → 18/25 + 9 + 10/25 = **10.12 s**.

### 3.4 The central invariant: an event is a START, not a block

There is **no duration column on `ScheduleEvent`**. A FILE item's length is always its referenced
`MediaItem.duration_seconds` (or `MediaItem.template.total_duration_seconds` for CG). A consecutive run of
FILE events is one "ad break", and each file is its own row with its own id, re-derived every time the
schedule loads. You can only ever move a start; its end is derived. Exception: SCG events carry an explicit
`end_time` because they are held.

---

## 4. How the Scheduler Works

### 4.1 Engine (`TaskQue/runv5.py`)

Class inventory: `QuesystemBridge` (WS server on 0.0.0.0:8766), `PipelineManager`, `PipelineController`
(one per active pipeline), 3 `SchedulerThread`s per pipeline (AD / CG / SCG), `AdSequenceWorker`,
`CGOverlayWorker`, `SCGLoopWorker`, `DjangoClient`, `HistoryLogManager`, `PlayoutEngineWindow`.

Timing constants: `RESYNC_INTERVAL_MS = 5*60_000` (5 min poll), `CHAIN_GAP_SECONDS = 1.0`,
`CASCADE_SAFETY_MARGIN_SECONDS = 2.0`, `RETENTION_DAYS = 2`, `TZ = UTC+06`, `SCG_ROUTE_WHOLE_CHANNEL = 1`,
SCG layers 2/3/4, dest/preview consumers 99/98.

Concurrency: `threading.Lock` (not QMutex) for controller state; `_stream_lock` serializes source/dest/preview
AMCP ops; all waits poll in 5 ms slices and honour `_stop_requested`; cleanup hangs off `QThread.finished`.

### 4.2 AMCP client

Every worker opens its own short-lived socket (`AF_INET, SOCK_STREAM`, timeout 8.0), writes `command + "\r\n"`,
reads exactly one 4096-byte reply. `_send()` sleeps 40 ms between commands. A reply whose first char is `4`
or `5` raises unless `tolerate_error`. Full verb set: `PLAY`, `PLAY … LOOP`, `LOADBG … AUTO`, `STOP`, `CLEAR`,
`REMOVE`, `ADD … STREAM`, `MIXER … FILL`, `MIXER … OPACITY`, `route://` producer. **No template text-filling
anywhere** — lower-thirds/DOG/BUG/Ticker are pre-rendered `.avi` files with alpha.

### 4.3 Stream initialisation (exact sequence)

```
CLEAR 2-1
(sleep 0.3 s)
PLAY 2-1 "<stream_source_url>"                  # ingest live into buffer
PLAY 1-21 "route://2"                            # route WHOLE buffer ch onto program layer
REMOVE 1-99                                      # tolerate_error
(sleep 2.0 s)
ADD 1-99 STREAM "<output_destination_url>"       # air out
REMOVE 1-98                                      # tolerate_error
(sleep 2.0 s)
ADD 1-98 STREAM "<preview_stream_url>"           # preview out
```

This is the permanent baseline state. `reinit_stream` = source + destination (not preview, not route).
`reinit_preview` = preview only. Both may carry an optional `"pipeline": {...}` applied first.

### 4.4 Ad chain (FILE) execution (exact sequence)

Chain grouping is **end-to-start**, not start-to-start (see §5.1). At fire time (first event's
`scheduled_time`):

```
PATCH /api/schedule/<id>/  {"status":"PLAYING"}   # for EVERY event in the chain
POST  /api/logs/  {pipeline, schedule=<chain seq id>, level:INFO, action:"Item On Air",
                   message:"Sequence <seq> : event <id> is now on air."}

t = 0
  AMCP >> PLAY   1-21 "<file_A>"
  AMCP >> LOADBG 1-21 "<file_B>"   AUTO
  AMCP >> LOADBG 1-21 "route://2"   AUTO          # synthetic ROUTE item, pre-armed

  (declare next item on air when cumulative duration elapses)

  when LAST file ends → CasparCG auto-promotes the LOADBG'd route → live returns

PATCH /api/schedule/<id>/  {"status":"COMPLETED"}  # or FAILED on error
POST  /api/logs/  {action:"Ad Sequence Completed",
                   message:"Sequence <seq> finished and routed back to live stream."}
```

Cascade timing is duration-driven via a single `QElapsedTimer` compared against the cumulative sum of
`duration_seconds`. Next ad is LOADBG-armed at `CASCADE_SAFETY_MARGIN_SECONDS = 2.0` before the current
one ends. Early-out (`request_early_out`) hard-cuts with `PLAY 1-21 "route://2"` immediately.

The synthetic route-back shows in logs as `Sequence 1154: event -1 now ON AIR.` `event_id == -1` means
"no backing ScheduleEvent" — never PATCHed, never logged to Django.

### 4.5 CG overlay execution (exact 7-command sequence)

On the **graphics layer**, for a CG media item with a linked GraphicsTemplate:

```
LOADBG 1-20 "<cg_file.avi>"  AUTO
MIXER  1-20 OPACITY 0
MIXER  1-21 FILL {sq_x:.4f} {sq_y:.4f} {sq_w:.4f} {sq_h:.4f} {in_frames}   # DVE squeeze on PROGRAM layer
MIXER  1-20 OPACITY 1 {in_frames}                                           # fade graphics in
       wait  hold_seconds + hold_frames/fps + 0.08
MIXER  1-21 FILL 0 0 1 1 {out_frames}                                       # release DVE
MIXER  1-20 OPACITY 0 {out_frames}                                          # fade graphics out
       wait  out_frames/fps + 0.1
STOP   1-20
CLEAR  1-20
```

**Key insight:** `MIXER … FILL` (DVE squeeze) is applied to the **PROGRAM layer (1-21)**. `MIXER … OPACITY`
(fade) is applied to the **GRAPHICS layer (1-20)**. Swapping these produces a completely different visual.
Logs: `CG Fired` on start, `CG Completed` on finish, `CG Failed` / `CG Dispatch Failed` on error.

### 4.6 SCG loop execution (DOG / BUG / TICKER)

```
AMCP >> PLAY 2-{layer} "<file.avi>"  LOOP     # layer 4=DOG, 3=BUG, 2=TICKER (on the BUFFER channel)
   … socket CLOSED, engine sleeps until end_time …
AMCP >> CLEAR 2-{layer}                      # 3 attempts, 1 s apart, then raise
```

Validation rules (each logged once):
- missing start (`scheduled_time`) or missing end → REJECT ("SCG needs a start and an end time …")
- `end <= start` → REJECT
- `end <= now` → status `MISSED` (local only)
- start in the past (join-in-progress) → `fire_at = now + 1 s`

### 4.7 Scheduler loop (SchedulerThread)

Sorted job list + condition-variable timer:

```
def update_jobs(self, jobs):
    self.jobs = [j for j in jobs if j['fire_at'] > now]   # past-due silently dropped
    self.jobs.sort(key=lambda j: j['fire_at']); self.cond.wakeAll()

def run(self):
    while self.running:
        lock; wait while empty
        job = jobs[0]; delta_ms = (job['fire_at'] - now) * 1000
        if delta_ms <= 0: jobs.pop(0); unlock; emit(event_triggered)
        else:            self.cond.wait(mutex, delta_ms); unlock
```

Job shapes: AD `{fire_at, sequence_id, events}` · CG `{fire_at, event}` · SCG `{fire_at, end_at, event}`.

### 4.8 Status machine

```
PENDING ──on dispatch──▶ PLAYING ──success──▶ COMPLETED
   └─────────────error──────────────────────▶ FAILED
```

Single writer `_set_event_status(event_id, status)` PATCHes Django **and** updates the local mirror. All events
in a chain are PATCHed together (PLAYING on dispatch, COMPLETED/FAILED at the end).

### 4.9 Idempotency bookkeeping

| Set | Added on | Cleared |
|---|---|---|
| `_fired_sequence_ids` | ad chain fire | `thread.finished` |
| `_fired_cg_ids` | CG fire | `thread.finished` |
| `_fired_scg_ids` | SCG fire | **NEVER** — deliberate, so an open SCG doesn't re-join after a force-end |
| `_missed_sequence_ids`, `_missed_cg_ids`, `_flagged_ids` | on miss/reject | — (suppress repeated history rows across 5-min resyncs) |

`_forget_event_state(eid)` clears all six on event delete.

### 4.10 Retention / ageing

`RETENTION_DAYS = 2`. Events whose time has passed 2 days are dropped from the working set regardless of
status. For SCG the comparison uses `end_time` when it is later than `scheduled_time` — a long-running DOG
only becomes "old" once its END is old.

### 4.11 Terminal statuses (never re-processed)

```
TERMINAL = {'COMPLETED','FAILED','CANCELLED','CANCELED','MISSED'}
```

Dropped from the working set regardless of time. `MISSED` is a **local-only** status — never PATCHed to Django.

### 4.12 PLAYING can stick

There is **no watchdog**. If the engine crashes mid-item, the row stays `PLAYING` until the 2-day purge or a
manual admin action. The UI status poller gives up after 5 retries and marks the client-side clip as `error`;
the server row is unaffected. The reaper (`reap_stuck_events`) exists but is **disabled by default**
(`SCHEDULE_REAPER_ENABLED=false`).

### 4.13 Local history file

`logs/playout_history_log.json` — JSON array, `indent=2`, 2-day retention purged on load and every append.
Entry schema (7 keys): `pipeline_name, kind, ref_id, action, status, executed_at, details`. `kind ∈ {AD CHAIN, CG, SCG, STREAM, EVENT}`. This is the engine's own UI table, separate from `ExecutionLog` in the DB.

---

## 5. Rules Applied

### 5.1 Media type ⟷ lane agreement (engine rejects mismatches)

`classify_play_event(e)` returns `(kind, reason)`:

```
if media_type == 'SCG':  lane ∈ {DOG, BUG, TICKER} ? 'SCG' : REJECT
if lane ∈ {DOG, BUG, TICKER}:  REJECT ("media_lane=X requires an SCG_ media item")
if media_type == 'CG':  'CG' (lane ignored)
else (FILE, unknown):  'CHAIN'
```

Rejected events are logged once and skipped; not marked FAILED; retried-and-rejected on next resync
(suppressed by a flag set).

### 5.2 Ad-chain grouping — end-to-start, 1 s tolerance

```
primary_events.sort(key=lambda e: e['scheduled_time'])
for e in primary_events:
    if current and prev_end is not None \
       and (t_start - prev_end).total_seconds() > CHAIN_GAP_SECONDS:   # 1.0 s
        chains.append(current); current = []
    current.append(e)
    prev_end = t_start + timedelta(seconds=media_item.duration_seconds)
```

Because files have real durations, three ads at `10:00`, `10:00:20`, `10:00:40` form **one** chain, not three.
Every chain gets a synthetic ROUTE item appended (`event_id == -1`).

### 5.3 Route-back must be whole-channel

```
SCG_ROUTE_WHOLE_CHANNEL = os.getenv("SCG_ROUTE_WHOLE_CHANNEL", "1")
def secondary_route_ref(pipeline):
    ch = pipeline['secondary_channel_number']
    return f"route://{ch}" if SCG_ROUTE_WHOLE_CHANNEL \
           else f"route://{ch}-{pipeline['secondary_receiver_layer']}"
```

`route://2`, not `route://2-1`. DOG/BUG/TICKER live on ch2 layers 2/3/4; a layer-scoped route-back would
cut them off air. Migration visible in logs: `route://2-1` (Sep 17/21/23) → `route://2` (Sep 29 onward).

### 5.4 Trimming is DISABLED

`start_frame`/`end_frame` are populated by the probe but `_amcp_clip_ref()` has the `SEEK … LENGTH …`
construction commented out in every version. Clips always play full length. Do not implement trim on the
first pass.

### 5.5 Media sync is destructive

```
MediaItem.objects.filter(server=server).exclude(file_path__in=incoming_paths).delete()
```

Deleting a file from `MEDIA_PATH` deletes its DB row. CG rows are created with `template=None` and must be
assigned a template by an operator, or they fail `clean()` on any later save.

### 5.6 CG duration comes from the template, not the file

All 66 CG `MediaItem`s have `duration_seconds = 0.00`. Any code computing a CG block length from
`media_item.duration_seconds` produces 0.

### 5.7 `media_lane` is the authoritative lane discriminator on load

The UI has legacy heuristics (`cgLaneFromRecord()` regex) used only as a fallback. Persisted `media_lane` wins.

### 5.8 DRF serialises `DecimalField` as JSON strings (engine API only)

`"duration_seconds": "20.44"`, `"hold_seconds": "9.00"`, `"squeeze_x": "0.2050"`. Consumers must cast. The
browser API returns real numbers — the two serializers are deliberately separate.

### 5.9 Server-side validation rules (9 mandatory)

1. `PLAY_MEDIA` ⇒ `media_item` and `media_lane` both required.
2. `media_lane ∈ {DOG, BUG, TICKER}` ⇒ `media_item.media_type == 'SCG'` and `end_time` required.
3. `media_lane == 'FILE'` ⇒ `media_item.media_type == 'FILE'`.
4. `media_lane == 'CG'` ⇒ `media_item.media_type == 'CG'` and `media_item.template` present.
5. `end_time` (if set) must be > `scheduled_time`.
6. Overlap: a new event shall not overlap an existing non-terminal event on the same `(pipeline, media_lane)`. Cross-lane overlap is permitted.
7. `scheduled_time` must not be in the past on create (configurable tolerance, default 0 s).
8. Events within `LOCK_WINDOW_MS` (default 30 000 ms) of now are **locked** — read-only and rejected on mutation.
9. Media type ⟷ lane agreement, mirroring the agent's `classify_play_event`.

### 5.10 Overlap rules (frontend)

`hasOverlap` is checked **within a single lane only**:

```
state[chId][lane].some((clip, i) => {
  if (i === excludeIdx) return false;
  if (clip.status === 'done' && !clip.playing) return false;   // finished items don't block
  return startMs < clip.endMs && endMs > clip.startMs;
});
```

A ticker and a bug at the same instant is normal. Two tickers at the same instant is not. CG lanes are free
to overlap the main track entirely. The live band is never overlap-checked.

### 5.11 Lock window

`LOCK_WINDOW_MS = 30 000 ms`. Items lock 30 s before start: `startLocked = true`, inspector force-saves,
open chain modal closes, re-render. Context-menu open guards: (1) `nowMode === 'timeline'` → toast; (2)
`clickMs < nowMs() + LOCK_WINDOW_MS` → silently suppressed.

### 5.12 Validation strings (exact, preserved)

```
start unparseable        → "Invalid start time."
start < now − 5000 ms    → "Start time is in the past."
end unparseable          → "Invalid end time."
end < start + 1000 ms    → "End time must be at least a second after the start."
same-lane overlap        → "Time overlaps with another scheduled item on this lane."
```

### 5.13 Editor enablement matrix

```
isScheduledEditable = status === 'scheduled' && !locked
isLive               = playing
canMove              = isScheduledEditable
canResizeLeft        = stretchable && canMove
canResizeRight       = stretchable && (canMove || playing)   # right edge live-resizable ON AIR
```

Resizing clamps: left edge to `end − 1000 ms` and not before now; right edge to `start + 1000 ms` and, while
on air, forward-only. Name/detail edits are applied live to the in-memory clip but **never persisted**.

### 5.14 Error code registry (frontend must handle all)

`PASSWORD_CHANGE_REQUIRED` (403) → route to change-password; `OVERLAP` (409); `IN_PAST` (409); `LOCKED` (409);
`ON_AIR` (409); `MEDIA_INACTIVE` (409); `TEMPLATE_MISSING` (409); `LANE_TYPE_MISMATCH` (409);
`END_TIME_REQUIRED` (409); `END_BEFORE_START` (409); `VERSION_MISMATCH` (409); `AGENT_UNREACHABLE` (504);
`AGENT_PROTOCOL_ERROR` (422); `IDEMPOTENCY_CONFLICT` (409); `RATE_LIMITED` (429).

---

## 6. Backend API

### 6.1 Two surfaces

- **Browser API** — `/api/v1/` (versioned, OpenAPI 3.1, session/JWT auth, deny-by-default).
- **Engine API** — `/api/` (FROZEN, contract tests CT-1…CT-10, `AllowAny` in permissive mode, no pagination).

### 6.2 Frozen engine contract (C-1…C-5)

| # | Call | Expected response |
|---|---|---|
| C-1 | `GET /api/pipelines/?is_active=true&server_name=<SERVER_NAME>` | Unpaginated JSON array |
| C-2 | `GET /api/schedule/?pipeline=<pipeline_id>` | Unpaginated JSON array |
| C-3 | `PATCH /api/schedule/<event_id>/` body `{"status","server_name"}` | 2xx. `server_name` ignored |
| C-4 | `POST /api/logs/` body `{pipeline, schedule, level, action, message, raw_response}` | 201 |
| C-5 | `GET /api/graphics-templates/<id>/` | Single template object |

Engine serializes `media_item` and `template` nested; `template` key omitted unless `media_type == "CG"`;
decimals as strings; timestamps with offset + microseconds.

### 6.3 Browser API endpoints (selected)

Auth: `/auth/login`, `/auth/logout`, `/auth/me`, `/auth/change-password`, `/auth/sessions`, `/auth/otp/send`,
`/auth/otp/verify`, `/auth/password/reset`. Users/Roles/Departments. Servers & pipelines (incl.
`/playout-channels/{id}/reinit/`, `reinit_preview/`). Media items + bulk status/template + scan-media.
Graphics templates. Schedules (CRUD, `/schedules/times/` atomic batch, `/schedules/bulk/`,
`/schedules/chain-preview/`). Reports (`/log-report/`, CSV export). Realtime SSE (`/realtime/stream`).
Health: `/healthz`, `/readyz`.

### 6.4 Push bridge (Django → agent)

Outbound WS to `ws://<server.ip>:8766`, connect timeout 2 s, **one connection per frame** (matches the
agent). Frames C-6…C-16. Failed pushes persisted in a retry table with exponential backoff 1 s → 5 min;
visible in admin and surfaced as `bridge_delivery` events. Invariant: an unreachable agent must never block
the HTTP response and must never lose the operator's write.

### 6.5 Realtime to browser

SSE at `GET /api/v1/realtime/stream`. Events: `schedule.changed`, `schedule.status`, `media.scanned`,
`agent.state`, `bridge.delivery`. Authenticated with the browser session cookie (never a query token).
Initial snapshot + incremental deltas with monotonically increasing sequence numbers; client detects gaps via
`Last-Event-ID`. Heartbeat every 20 s. Strictly optional — the SPA works fully by polling (30 s) without it.

### 6.6 Security

Deny by default. No `AllowAny` except public auth routes. CSRF on cookie mutations. CORS allow-list.
Per-Server API token (hashed, shown once, revocable, rotatable) accepted via `X-Engine-Token` header or
`?token=` query param. `ENGINE_AUTH_MODE = permissive | enforcing` (default permissive). Security headers
(CSP, HSTS, nosniff, Referrer-Policy, frame-ancestors). Rate limits: login 5/15 min per IP+identifier; OTP
send 3/hour per email; mutations 600/min per user. `Idempotency-Key` on mutations (24 h replay window).
Structured audit log for all writes. Admin path from env (`4dm1n/` by default) + honeypot.

---

## 7. Frontend / React

### 7.1 Stack

React 18 + TypeScript (strict) + Vite. TanStack Query for server state; Zustand for UI state only. React
Router v6. Radix UI primitives + Tailwind CSS. Lucide React icons. date-fns + date-fns-tz. SheetJS (xlsx)
for Excel export. No Bootstrap, no jQuery, no jQuery UI. No runtime template strings, no `innerHTML` with
user data, no `eval`, no inline event handlers (CSP-clean).

### 7.2 Routing (FR-SH-01)

```
/login  /change-password  /forgot-password  /reset-password
/schedule  /navigator  /execlog  /system
/admin/users  /admin/roles  /admin/pipelines  /admin/templates
*  →  404
```

Route guard: unauthenticated → `/login`; `is_new` → `/change-password`, all other routes blocked. Clock ticks
at 1 Hz in the channel timezone. Global loading overlay on first load. Realtime indicator. Toast + dismissible
banner. Confirm dialogs for destructive actions. On 401: attempt refresh once, else redirect to login
preserving the route. Per-user light/dark theme. All user-facing strings name the product "PlyOut".

### 7.3 Design system / React styles

Tokens are CSS custom properties in `Frontend/src/index.css` (Tailwind v4 `@theme`). Two themes: light
(default `:root`) and dark (`:root[data-theme='dark']`), toggled via `document.documentElement.classList`
and `data-theme`. Theme preference persisted in Zustand.

Colour tokens (selected): `--bg-canvas` `#f4f6fa`/`#0a0e16`; `--bg-surface` `#ffffff`/`#111722`;
`--fg-default` `#0f172a`/`#e8edf7`; `--accent` `#007aff`/`#2f8bff`; `--ok` `#34c759`/`#34d96b`;
`--warn` `#ff9500`/`#ffab2e`; `--danger` `#ff3b30`/`#ff5a4f`; `--info` `#5ac8fa`.

Clip status palette (preserved verbatim from legacy; does not flip with theme):

| State | Block bg (light) | Border | Text |
|---|---|---|---|
| error | `#3a1a1a` | `#ff3b30` | `#ff6b6b` |
| scheduled | `#fff8e1` | `#ff9500` dashed | `#e65100` |
| scheduled + locked | `#fff8e1` | `#ff9500` solid | `#e65100` |
| live | `#4a1a1a` | `#ff3b30` | `#ff6b6b` |
| done | `#1a3a1a` | `#34c759` | `#4cfaaa` |
| live band | `#4a1a1a` | `#ff3b30` | `#ff6b6b` |
| ad group scheduled | `#16283f` | `#5ac8fa` | `#8ecdfa` |
| ad group locked | `#3a3010` | `#ffcc00` | `#ffe082` |

Segment states: played `rgba(52,199,89,.30)` · on-air `rgba(255,59,48,.38)` · queued `rgba(255,204,0,.30)` ·
failed `rgba(255,149,0,.45)`. Status badges: COMPLETED `#34c759` · PLAYING `#007aff` · PENDING `#ff9500` ·
FAILED `#ff3b30`.

Typography: Inter var / Inter, 13 px base, line-height 1.45. Type scale `--text-2xs` 0.6875 rem, `--text-xs`
0.75 rem, `--text-sm` 0.8125 rem. Tabular numerals (`.tnum`) for clocks/timers/durations. Monospace for file
paths and codes. Reduced-motion honoured (`prefers-reduced-motion: reduce` zeroes animations). Thin scrollbars
sized for dense data views. Focus-visible: 2 px accent outline, 2 px offset.

Animations: `ply-fade` 140 ms, `ply-slide-up` 160 ms, `ply-pulse-once` 900 ms, `ply-onair` 1.4 s infinite,
`ply-sweep`. Utility classes `.animate-in-fade`, `.animate-slide-up`, `.animate-pulse-once`, `.animate-onair`.
`.grid-lines` utility for ruler background. `.text-clip` for ellipsis.

Components (in `src/components/ui/`): Button, Input, Select, Checkbox, Switch, Modal, ContextMenu, Toast,
Table, Badge, Tabs, Spinner, Tooltip, Primitives (Panel, PageHeader, EmptyState, ErrorState, StatusBadge,
AgentDot, Label, Field). Layout: AppShell, TopBar, Logo, ErrorBoundary.

---

## 8. Pages

### 8.1 `/schedule` — Scheduler (the product)

Top-level `SchedulePage`. Layout: `PageHeader` (title "Scheduler", description with channel count + item
count + timezone, actions: Run down toggle, Inspector toggle, Schedule ad button) → `TimelineToolbar`
(zoom/pan/jump-to-now/alerts) → flex row: `Timeline` + optional right rail (Inspector or RunDown) →
`StatusFooter` (on-air count, scheduled count, failed count, now-mode toggle, stale indicator).

State: pipelines, events (single fetch for all pipelines), viewport (offsetMs, zoomMs), nowMode, selection,
inspectorOpen, rundownOpen, activePipelineId, drag. Mutations: create event/chain, update, retime batch,
delete, cancel, stop. Keyboard shortcuts: `+`/`-` zoom, `←`/`→` shift ±6 h, `n` jump to now, `p` toggle
now-mode, `i` toggle inspector, `Escape` deselect. Lock-warning alerts surfaced in toolbar (15 s lead, 2 s
linger, one per ad break naming the first commercial). RunDown shows upcoming/on-air items for the selected
pipeline.

### 8.2 `/navigator` — Navigator (media library)

`NavigatorPage`. Server selector + "Refresh media" button (with confirm dialog) + last-scan timestamp +
incomplete-graphics warning. Search/filter input. Three panels: **Commercials** (FILE), **Graphics &
templates** (CG, with Assign template button), **Standing CG (DOG/BUG/TICKER)** (SCG). Each table: select-all
checkbox, Title (with file_path mono), Duration, Status (active switch), fps; CG table adds Template badge.
Bulk Activate/Deactivate per table. Scan failure is per-server with dismissible banner. Incomplete CG rows
flagged with alert icon and cannot be scheduled.

### 8.3 `/execlog` — Execution Log (as-run report)

`ExecLogPage`. Filters: Server, Channel, Start date, End date, type checkboxes (Commercials/Graphics/Standing
CG), Status. Default range: yesterday → today. `N of M event(s)` summary. Sortable columns: Scheduled Time,
Duration, Title, Type, Template, Status (+ Lane). Refresh button. Export CSV (filtered + sorted view) and
Server export (full range). Out-of-order response guard via monotonic request token + AbortController.
Date validation inline before any request.

### 8.4 `/system` — System

`SystemPage`. Channel selector. Agent state panel (state, last heartbeat, agent version, queued pushes).
Deferred-deliveries warning list. Stream configuration (read-only textareas for Source/Destination/Preview
with copy buttons). Optional preview player (iframe using `preview_embed_url`). Layer map (read-only reference
of ch/layers). Channels table (name, agent state, on-air badge). Servers table (name, state, channel count).
Reinit stream / Reinit preview buttons (permission-gated: superuser or `plyout.reinit_pipeline`).

### 8.5 `/admin/pipelines`, `/admin/templates`, `/admin/users`, `/admin/roles`

Code-split admin pages. Pipelines: server, name, channel/layer numbers, stream URLs (free text, verbatim),
preview_embed_url, active toggle. Templates: name, type, path, fps, in/out frames, hold seconds/frames,
squeeze x/y/w/h (0–1), computed total duration preview. Users: list (paginated, searchable), create (temp
password emailed, never returned), update (roles as ids/comma-string/objects), activate/deactivate, delete
(no self/superuser). Roles: matrix of permissions (excluding `EXCLUDED_PERMS`), create/update/delete
(protected `admin`/`superuser`), force reassign on delete.

### 8.6 Auth pages

`/login` (username or email + password), `/change-password` (forced first-login, min 12 chars, validators,
optional sign-out-other-devices), `/forgot-password` (3-step OTP: send code → verify → returns tesseract →
reset). Neutral confirmation on send regardless of account existence.

---

## 9. Scheduler UI Details

### 9.1 Lanes

Five lanes per channel: main FILE/AD (`flex 1.6`), then CG (L-Shape/PopUp), DOG, BUG, TICKER (`flex 1`
each). Each lane has its own label, now-line, lock marker.

| Lane | media_lane | Kind | Item source | Initial length | Resizable |
|---|---|---|---|---|---|
| main FILE/AD | FILE | — | media picker (kind=ad) | media_item.duration | — |
| L-Shape / PopUp | CG | TIMED | media picker (kind=cg) | template duration | no |
| Doggy | DOG | HELD | media picker (kind=scg) | 60,000 ms | yes |
| Bug | BUG | HELD | media picker (kind=scg) | 60,000 ms | yes |
| Ticker | TICKER | HELD | free-text label modal, no media item | 60,000 ms | yes |

TIMED (L-Shape/PopUp): length derived from template. No edge handles, no End editing; only start movable.
HELD (DOG/BUG/Ticker): comes up and stays up until taken down. New block starts at 1 min (2 min in v2 for
DOG/BUG; TICKER keeps the long default). Stretched by either edge handle or by typing an End; video loops,
drawn as faint per-cycle rules plus a `↻ ×N` badge.

### 9.2 Live band

LIVE is a persistent background band, not a timed block: exactly one per channel, drawn across the whole
visible track. Ad groups and CG are scheduled on top of it. When an ad ends, live is what remains
underneath — it "resumes" automatically with no explicit event. Ads are never overlap-checked against the
live band.

### 9.3 Clip rendering

Block types: ad group, CG, DOG/BUG/TICKER, live band. Ad group renders as ordered segments with per-segment
state (played/on-air/queued). Held graphics render with both edge handles, faint per-cycle loop rules, and a
`↻ ×N` badge. Timed graphics render without edge handles. Gapless neighbours get joined-edge styling
(within 1 s). Status styling by scheduled/locked/live/done/error. Type badge and name row per block; name
strips `FILE_`/`CG_`/`SCG_` prefixes for display only. Hover tooltip: type, file path, template, scheduled
time, duration, status, server. Virtualise by time window — only blocks intersecting `[offset, offset+zoom]`
render. Blocks below a visibility threshold collapse to a coloured bar without text.

### 9.4 Drag systems

Three mouse-event-based (no HTML5 DnD):

(a) **Timeline pan** — bound to ruler and track background mousedown; mousemove on document; updates
`viewOffsetMs` and fully re-renders every channel on every pixel (legacy). v2 uses rAF-throttled updates.

(b) **Whole-clip move** — duration captured once at mousedown and never recomputed:
```
const duration = clipDrag.origEnd - clipDrag.origStart;   // fixed
newStart = snapCG(...)                                    // CG lanes snap to neighbour edges
newStart = Math.max(newStart, nowMs());                   // cannot drag into the past
if (!hasOverlap(...)) { clip.startMs = newStart; clip.endMs = newStart + duration; }
```
On mouseup → PATCH: CG → both ends; ad group → N PATCHes (one per chained file, `Promise.all`); single clip
→ 1 PATCH.

(c) **CG edge stretch** — only on `stretch:true` lanes, handles `.drag-handle.lh`/`.rh`:
```
// right edge
newEnd = snap(...); newEnd = max(newEnd, startMs + MIN_CG_DURATION_MS);
                       newEnd = max(newEnd, nowMs() + MIN_CG_DURATION_MS);   // on-air grows forward only
// left edge
newStart = min(newStart, endMs - MIN_CG_DURATION_MS); newStart = max(newStart, nowMs());
```

Snap (`CG_SNAP_PX = 8`): snaps to any neighbour's startMs/endMs within 8 px → gapless runs.

(d) **Ad-chain reordering is BUTTONS ONLY** (▲/▼ in chain modal), never by timeline drag, to avoid
accidentally reshuffling files while moving the chain. The 5 px `.ad-group-movebar` at the top of the group
moves the whole chain. `persistAdGroupTimes()` re-PATCHes every row's absolute time by cumulative duration.

### 9.5 Context menu

Right-click a lane opens a lane-aware menu: "Schedule File/Ad Here" on main lane; "Schedule {Lane} Here" on
CG lanes; "Delete Scheduled Item" shown only when a nearby unlocked scheduled clip exists. Suppressed in
timeline auto-follow mode (toast) and for past/locked positions. Click-outside and Escape close.

### 9.6 Media picker & chain modal

Media picker: modal listing media with search (250 ms debounce), filter by kind (ad/cg/scg), active items
only; resolves a `Promise<MediaItem | null>`; incomplete CG items (no template) shown but disabled with reason.
Chain modal: ordered file list with index, name, duration, ▲/▼, ✕, "+ Add file". Cannot remove last file or
file currently on air. Reorder/remove issues one batched request. Modal auto-closes if any member enters the
lock window. Reordering updates absolute times by cumulative duration, preserving gaplessness. Grouping
rendered from `GET /schedules/chain-preview/` so UI matches agent.

### 9.7 Inspector panel

Fields: Type, Name, Detail, Chain (for ad groups), Channel, Start, End, Duration, Status, plus Save and Delete.
Duration always read-only and server-derived. End editable only for held lanes; Start editable only for
unlocked scheduled items. CG name/detail read-only (from template). Delete hidden/disabled for locked and
on-air items. Live band inspector shows everything disabled, End as "— (runs until stopped)". Validation
messages mirror the exact strings in §5.12. Auto-switch to selected clip; clear on deselection.

### 9.8 Timers

Exactly one `setInterval` at 1000 ms (`updateClock`): updates clock/current-time/status-bar; if nowMode is
timeline, recentre and full re-render; positions now-line and lock-marker on main lane and all 4 CG lanes
(lock marker only when zoom ≤ 10 min); `updateNowInfo` per channel; main-lane watcher (reverse loop) for
scheduled items entering lock window / start; live-band inspector kept live; re-render if anything playing.
Same watcher independently for each of the 4 CG lanes. One-shot `setTimeout` for status checks at start
(then chains to end check) and at end (5 retries at 500/1000/1500/2000/2500 ms then marks clip `error`).
Media-picker search debounce 250 ms. Nav toast 4000 ms then 250 ms. Demo-channel fallback 1500 ms.

### 9.9 Auto-prefetch on load

`loadChannels()` → `autoScanAllServers()` fires `POST scan-media` for every derived server in parallel via
`Promise.allSettled` (per-server failures only `console.warn`ed), then `await loadServerEvents()`.

### 9.10 Persistence

FR-ST-05: viewport persisted (local storage + server preference) so a reload restores the view. Server state
owned by React Query; UI state (selection, viewport, now mode, panel sizes) in Zustand. Clip geometry
derived from startMs/endMs; no DOM measurement during drag. Normalised clip store keyed by event id; lane
arrays derived by selector. Optimistic mutations with rollback and conflict resolution. No component may hold
an authoritative copy of schedule data in local state.

### 9.11 Rendering rules (performance)

1. Compute `pxPerMs = trackWidth / zoomMs` once per render; derive every block's geometry from it.
2. Virtualise by time window — render only blocks intersecting `[offsetMs, offsetMs+zoomMs]` and only
   channels in the viewport.
3. `onPointerMove` writes to a ref-backed transient drag state; render via `useSyncExternalStore` /
   `requestAnimationFrame`; commit to the store on `pointerup`.
4. Snap tolerance expressed in ms derived from px at current zoom.
5. Keep the live band as a background layer, never an array item.
6. Status styles applied via data attributes, not inline cssText.

Target: 8 channels × 5,000 clips at 60 fps pan and 60 fps drag.

---

## 10. Degradation Behaviour

| Scenario | Required behaviour |
|---|---|
| Agent not running | Pipeline shows Offline. Media scan → 504. Schedule writes still succeed and queue. Reinit reports `delivery:"deferred"` |
| CasparCG down | Agent cannot execute; events stay PENDING. UI shows last-known status |
| Django down | Agent continues executing from its in-memory schedule; status PATCHes fail and are dropped (agent has timeout=5, no retry). Pushes resume when Django returns |
| Network partition, agent side | Agent's WS drops; the 300 s resync reconciles automatically |
| Concurrent operator edit | Optimistic concurrency via `version`; loser gets 409 VERSION_MISMATCH; SPA reloads that item |
| WebSocket push lost | Caught by the 300 s resync |
| SSE to browser lost | 30 s polling fallback keeps the UI correct; quiet indicator shown |

No scenario may cause silent data loss. The SPA must always communicate agent state honestly.

---

## 11. Operational Notes

- `/healthz` (liveness), `/readyz` (readiness incl. DB and bridge state).
- Structured JSON logs with `request_id` propagated end-to-end.
- Management commands: `bootstrap_roles`, `bootstrap_admin`, `issue_engine_token`, `rescan_media`,
  `push_pending`, `reap_stuck_events`.
- `SCHEDULE_REAPER_ENABLED` defaults to false; when enabled, flags PLAYING events older than
  `ENGINE_LEASE_TIMEOUT` on a stale agent as FAILED with `note="agent lease expired"`.
- Retention: execution logs per channel policy (default 400 days); schedule events 3 years.
- Migrations reversible and zero-downtime. Django migrations only.
- Backup: PostgreSQL daily base backup + WAL archiving, documented restore drill.

---

## 12. Summary of "Every Rule Applied"

- Media type ⟷ lane agreement (engine rejects mismatches); rejected events logged once, not marked FAILED.
- Ad-chain grouping end-to-start with 1 s tolerance; synthetic ROUTE item appended to every chain.
- Route-back must be whole-channel (`route://2`), never `route://2-1`.
- Trimming disabled (`SEEK`/`LENGTH` commented out); clips always play full length.
- Media sync destructive: deleting a file deletes its DB row; CG rows created with `template=None`.
- CG duration comes from the template, not the file (all CG `duration_seconds = 0`).
- `media_lane` is the authoritative lane discriminator on load.
- DRF serialises `DecimalField` as JSON strings on the engine API only; browser API returns numbers.
- Terminal statuses never re-processed; `MISSED` is local-only.
- Retention 2 days; SCG uses `end_time` when later than `scheduled_time`.
- `PLAYING` can stick (no watchdog); reaper default-off.
- No automatic retry of a failed ad chain; only SCG `_clear_layer()` retries 3×.
- Overlap checked within a single lane only; finished items don't block; cross-lane allowed; live band never checked.
- Lock window 30 s: items read-only and rejected on mutation.
- Validation strings exact (Invalid start time / in the past / Invalid end time / at least a second / overlaps).
- Editor enablement matrix (canMove/canResizeLeft/canResizeRight) with right edge live-resizable on air.
- Resize clamps: left to `end − 1000 ms` and not before now; right to `start + 1000 ms`, forward-only on air.
- Context-menu guards: timeline mode toast; past/locked silently suppressed.
- Drag disabled while modal open or in timeline auto-follow mode.
- Escape cancels in-flight drag and restores original position.
- Optimistic update with rollback on 409 + conflict banner + per-item reload.
- Ad-chain reordering via ▲/▼ only, never timeline drag; batched single request; cannot remove last or on-air file.
- CG snap tolerance 8 px to neighbour edges → gapless runs.
- Whole-clip move captures duration at mousedown, never recomputed; clamped not before now.
- Now-line and lock-marker positioned on main lane + all 4 CG lanes (lock marker only when zoom ≤ 10 min).
- One `setInterval` at 1 Hz; one-shot timers for status checks with 5 retries then `error`.
- Auto-prefetch scan for every server on load via `Promise.allSettled`.
- Viewport persisted across reloads (FR-ST-05).
- Realtime optional: SSE + 30 s polling fallback.
- Deny-by-default permissions; CSRF; CORS allow-list; per-Server token; `ENGINE_AUTH_MODE`.
- All transactional emails name the product "PlyOut".

---

*End of report. Companion documents: `PLYOUT_SPECIFICATION.md`, `PLYOUT_REQUIREMENTS.md`, `PLYOUT_PLAN.md`.*
