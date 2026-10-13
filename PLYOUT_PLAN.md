# PlyOut v2 — Project Plan

**Monorepo-split delivery plan for the PlyOut broadcast playout platform.**
Derived from `PLYOUT_REQUIREMENTS.md` (SRS-PLYOUT-001 v1.0) and `PLYOUT_SPECIFICATION.md`.

> This file is **mirrored byte-for-byte** into both `Backend/` and `Frontend/` repositories so that
> each repo is self-contained. Edit one, copy to the other. If they diverge, the Frontend copy is
> the stale one until proven otherwise.

| | |
|---|---|
| **Product** | PlyOut — broadcast playout management platform (single commercial TV channel) |
| **Deliverable shape** | Two independent git repositories: `Backend/` and `Frontend/` |
| **Source of truth (architecture)** | `PLYOUT_REQUIREMENTS.md` |
| **Source of truth (behaviour)** | `PLYOUT_SPECIFICATION.md` |
| **Status** | Plan — pre-implementation |
| **No code has been written** | This document is the contract for the first commit of real code |

---

## 0. How to read this document

The two source documents disagree in places. The tie-break rule, stated in SRS §1.4, governs
everything below:

> **The SRS governs the target architecture. The specification governs the behaviour.**

Concretely, this means:

| Topic | `PLYOUT_SPECIFICATION.md` proposes | `PLYOUT_REQUIREMENTS.md` decides | We follow |
|---|---|---|---|
| Engine decimal fields | Emit JSON numbers | **Emit JSON strings** (A-4) | **SRS** |
| Engine transport | Persistent WebSocket, versioned `/engine/v1/` | **Unmodified agent, connect-per-message, `/api/` frozen** | **SRS** |
| Stuck `PLAYING` | Reaper marks orphaned rows `FAILED` | **Reaper exists but is disabled by default** (L-2) | **SRS** |
| Scheduler location | Move into Django-side worker | **Agent stays PyQt5, unedited** | **SRS** |
| Engine auth | Token-auth immediately | **Token issued, `ENGINE_AUTH_MODE=permissive` by default** | **SRS** |

Where the SRS is silent, the specification's behavioural detail (AMCP sequences, grouping
algorithms, timing constants) is binding.

---

## 1. Executive summary

PlyOut takes a continuous live programme feed, interrupts it with scheduled commercial breaks and
graphics, and produces an on-air output plus a low-resolution preview.

The rebuild replaces a monolithic Django + server-rendered-template application with a
**Django REST API** and a **React SPA**, while continuing to interoperate with the **existing PyQt5
playout agent** (`TaskQue/runv5.py`) which is **retained unmodified**. This is a re-architecture,
not a re-design: functional behaviour, AMCP command sequences, schedule semantics and
media-management semantics must be preserved exactly.

The single most important architectural fact:

> **Django is authoritative for configuration and intent. The agent is authoritative for execution.**

That split dictates the repository split:

- **Backend** owns the domain model, the browser API, the **frozen** engine API, the push bridge
  to the agent, realtime fan-out to the browser, reporting, auth and RBAC.
- **Frontend** owns everything the operator sees and touches.

### 1.1 The eight acceptance gates

| Gate | Measure |
|---|---|
| SC-1 Engine compatibility | `runv5.py` runs **unmodified**; 24 h soak, zero contract violations |
| SC-2 Functional parity | All 27 workflows in SRS §9 pass |
| SC-3 Timeline performance | 8 channels × 5 lanes, 5,000 clips, 60 fps pan and drag |
| SC-4 API latency | p95 < 200 ms for browser endpoints at 500 concurrent users |
| SC-5 Contract availability | Schedule edits reach the agent within 1 s of commit |
| SC-6 No lost updates | Zero schedule-event overwrites under concurrent operators |
| SC-7 Security | Zero critical/high findings at sign-off |

---

## 2. Scope

### 2.1 In scope

**Backend** — all browser-facing REST APIs; the frozen engine ("TRON") API; the WebSocket bridge
to the agent on `:8766`; media scanning/probing/sync orchestration; schedule management including
multi-item ad-break chains and held-graphic end times; as-run reporting; auth, users, roles,
permissions, departments; health checks, structured logging, migrations, background jobs.

**Frontend** — React SPA replacing `templates/plyout_main.html` and the `rootbase.html` shell, with
four primary areas (**Scheduler**, **Navigator**, **Execution Log**, **System**) plus login, forced
first-login password change and password reset.

### 2.2 Out of scope

| Item | Rationale |
|---|---|
| Redesigning playout behaviour | Explicitly "exact same task" |
| Modifying the CasparCG server | External system |
| `TaskQue/mainscriptv5.py` (the recorder) | Different application, different port (8765) |
| `api/cadets__/`, `api/courses/`, `api/library/` | Dead code; models absent from `INSTALLED_APPS` |
| Media ingestion / transcoding / QC | Does not exist in legacy |
| Clip trimming (`SEEK`/`LENGTH`) | Disabled in legacy; excluded to preserve behaviour |
| Security edits inside `runv5.py` | Deferred to phase 2 (SRS §16.5) |
| Reporting/BI beyond as-run | Not in legacy |

### 2.3 Deliberately preserved legacy limitations

These are **intentional** in phase 1. They must not be "fixed" in a way that changes engine
behaviour. Improvements are permitted only as **additive, opt-in, default-off** features.

| # | Limitation | Additive escape hatch |
|---|---|---|
| L-1 | No retry of a failed ad break | Operator reschedules; UI surfaces it clearly |
| L-2 | No watchdog on stuck `PLAYING` events | `reap_stuck_events` command, **`SCHEDULE_REAPER_ENABLED=false`** by default |
| L-3 | Ad-break membership is derived, not stored | `chain-preview` endpoint shows the agent's own grouping |
| L-4 | Media sync deletes DB rows for files removed from disk | Correct — the DB mirrors disk. Confirm before scan |
| L-5 | `start_frame` / `end_frame` stored but unused | Excluded from the UI entirely |

### 2.4 Naming

The product is **PlyOut**. Legacy vestiges are **not** identity and must be removed:
`StreamX` (welcome/OTP email subjects and bodies), `IngestX` (startup toast, agent window title),
`Aranya Technology` (email footer).

**Do not rename** genuine deployment identifiers: `itvstreamx.duckdns.org:8889` (legacy preview host,
replaced by `preview_embed_url`), `aranyait.com.bd` (SMTP domain), `LOCAL_CASP` / `PIPE_1` (seed data
the agent matches on), and all protocol identifiers — `stream_source_url`, `DEST_STREAM_LAYER`,
`PREVIEW_STREAM_LAYER`, `ROUTE_STREAM`, `DOG`, `BUG`, `TICKER`, `TRON`, etc.

**Enforcement:** a grep-based branding sweep is a blocking CI check on both repos.

---

## 3. Repository split and the contract between them

```
┌─────────────────────────────┐        ┌─────────────────────────────────┐
│  Frontend/  (git repo #1)   │        │  Backend/   (git repo #2)       │
│                             │        │                                 │
│  React 18 + TS + Vite SPA   │  HTTPS │  Django 5 REST API              │
│  · Scheduler (timeline)     │◄──────►│  · /api/v1/  browser API        │
│  · Navigator                │  JSON  │  · /api/      ENGINE API (frozen)│
│  · Execution Log            │        │  · SSE realtime to browser       │
│  · System                   │        │  · WS bridge to agent :8766      │
│  · Auth screens             │        │  · PostgreSQL 16                 │
│                             │        │                                 │
│  Owns: types, hooks, tests  │        │  Owns: domain, serializers,      │
│         and the OpenAPI     │        │         OpenAPI (source of      │
│         TypeScript client   │        │         truth), contract tests   │
└─────────────────────────────┘        └─────────────────────────────────┘
                 │                                       │
                 └──────────────┬────────────────────────┘
                                ▼
                 ══════ MACHINE BOUNDARY (playout server) ══════
                    TaskQue\runv5.py  — UNMODIFIED, PyQt5
                    · QWebSocketServer 0.0.0.0:8766
                    · 3 SchedulerThreads per pipeline
                    · polls GET /api/pipelines/ + GET /api/schedule/ every 300 s
                                │
                                ▼ AMCP TCP :5250
                         CasparCG Server ──► RTMP ON-AIR
                                             ──► RTMP PREVIEW
```

### 3.1 What each repo owns

| Concern | Owner | Notes |
|---|---|---|
| Domain model, migrations | Backend | |
| Browser API `/api/v1/` | Backend | |
| Engine API `/api/` | Backend | **Frozen.** Frontend must never call it |
| Push bridge to agent | Backend | |
| Realtime SSE to browser | Backend | |
| Data migration tool | Backend | |
| OpenAPI 3.1 schema | Backend | **Source of truth**; committed |
| Generated TypeScript types/client | Frontend | Generated from the committed schema in CI |
| React SPA, all tabs | Frontend | |
| Timeline rendering + drag | Frontend | |
| Design tokens, components | Frontend | |
| Playwright E2E suite | Frontend | Runs against a live Backend |

### 3.2 The three seams

| Seam | Mechanism | Contract owner | Failure impact |
|---|---|---|---|
| **Browser API** | OpenAPI 3.1, committed at `Backend/openapi.yaml`; frontend types generated | Backend | Compile-time break in CI — good |
| **Realtime events** | SSE event names + payload schemas, versioned and frozen | Backend | Frontend falls back to 30 s polling |
| **Frozen engine API** | `/api/` + golden-file tests + serializer fingerprint | Backend | **Production playout breakage** |

### 3.3 Versioning policy

| Surface | Policy |
|---|---|
| Browser API | `/api/v1/`. Breaking change → `/api/v2/` alongside, never in place |
| Engine API | **Frozen at `/api/`.** No version segment. Changes require an agent change |
| Realtime event payloads | Additive-only within v1; new fields are optional |
| Frontend ↔ Backend deploys | Independent. The frontend must tolerate any backend ≥ its minimum version, and must fail gracefully against a newer one |

### 3.4 Repository layout

**Backend/**
```
backend/
├── manage.py
├── pyproject.toml            # ruff, mypy, pytest, coverage
├── core/                     # settings, urls, asgi, wsgi, celery-ish config
├── apps/
│   ├── accounts/             # User, Role, Department, OTP/tesseract reset
│   ├── playout/              # Server, OutputPipeline, GraphicsTemplate, MediaItem,
│   │   │                     #   ScheduleEvent, ExecutionLog  + services/
│   │   │                     #   media_sync.py, duration.py, validation.py,
│   │   │                     #   chain.py, realtime.py
│   ├── engine_api/           # THE FROZEN CONTRACT — separate app, separate serializers
│   └── reports/              # as-run aggregation + CSV export
├── worker/
│   ├── playout_bridge.py     # management command: outbound WS client, durable queue
│   └── supervisor/           # systemd unit / compose service
├── migrations_tools/         # legacy SQLite → PostgreSQL importer, dry-run first
├── tests/
│   ├── contract/             # C-1…C-5 contract tests, golden files, fingerprints
│   ├── integration/          # mock agent replaying recorded production frames
│   └── performance/
├── openapi.yaml              # committed, CI drift-checked
├── deploy/                   # systemd, Docker Compose, env template
└── docs/runbooks/
```

**Frontend/**
```
frontend/
├── package.json  pnpm-lock.yaml  tsconfig.json  vite.config.ts
├── eslint.config.js  .prettierrc
├── src/
│   ├── app/                  # router, layout, route guards, providers
│   ├── api/                  # generated client, typed error mapper, realtime client
│   ├── features/
│   │   ├── auth/
│   │   ├── scheduler/        # toolbar, ruler, channel row, lanes, clips, inspector,
│   │   │                     #   drag, context menu, media picker, chain modal
│   │   ├── navigator/
│   │   ├── execlog/
│   │   └── system/
│   ├── components/ui/        # Button, Input, Select, Checkbox, Modal, ContextMenu,
│   │                         #   Toast, Table, Badge, Tabs, Spinner, Tooltip
│   ├── state/                # Zustand stores (viewport, selection, now-mode)
│   ├── lib/                  # time, duration, geometry, ms/px conversions
│   ├── styles/               # design tokens, light + dark themes
│   └── types/                # generated from openapi.yaml
├── tests/{unit,component,e2e}/
├── playwright.config.ts
└── docs/
```

---

## 4. Non-negotiable frozen contracts

**Every engineer reads this section before writing code.** Breaking any item here breaks
production playout, not just the build.

### 4.1 The PyQt5 agent constraint

> The agent will **not** be modified for functional reasons. Any backend change that alters the wire
> format of an engine-consumed endpoint or WebSocket frame is **out of scope**.

The agent calls these, and all must remain byte-compatible:

| # | Call | Expected response |
|---|---|---|
| C-1 | `GET {API_BASE}/pipelines/?is_active=true&server_name=<SERVER_NAME>` | **Unpaginated JSON array** |
| C-2 | `GET {API_BASE}/schedule/?pipeline=<pipeline_id>` | **Unpaginated JSON array** |
| C-3 | `PATCH {API_BASE}/schedule/<event_id>/` body `{"status","server_name"}` | 2xx. `server_name` ignored |
| C-4 | `POST {API_BASE}/logs/` body `{pipeline, schedule, level, action, message, raw_response}` | 201 |
| C-5 | `GET {API_BASE}/graphics-templates/<id>/` | Single template object |

All with `timeout=5 s`. The agent sends **no `Authorization` header**, manages **no cookies**, and
**does not retry**.

Django dials **outbound** to `ws://<server.ip_address>:8766` and **closes after each message** —
the agent's `QuesystemBridge` accepts a new connection per message.

| # | Frame | Direction |
|---|---|---|
| C-6 | `{"command":"get_media_list"}` | Django → agent, replies `media_list` on same socket |
| C-7 | `{"command":"schedule_event_upsert","pipeline_id":N,"event":{…}}` | Django → agent |
| C-8 | `{"command":"schedule_event_deleted","pipeline_id":N,"event_id":N}` | Django → agent |
| C-9 | `{"command":"reinit_stream","pipeline_id":N}` | Django → agent |
| C-10 | `{"command":"reinit_preview","pipeline_id":N}` | Django → agent |
| C-11…C-16 | `sync_pipelines`, `pipeline_updated`, `pipeline_removed`, `force_end_ad_break`, `force_end_cg`, `force_end_scg` | Django → agent (agent already implements these; **Django does not yet produce them**) |

### 4.2 Agent parsing assumptions (A-1 … A-9) — frozen

| # | Assumption |
|---|---|
| A-1 | `/pipelines/` and `/schedule/` return a **bare JSON array**, never `{"results": […]}` |
| A-2 | `event.media_item` is a **fully populated nested object**, not an integer id |
| A-3 | `event.media_item.template` is a nested object, **present only when `media_type == "CG"`** |
| A-4 | Decimal fields (`duration_seconds`, `hold_seconds`, `squeeze_*`) are **JSON strings** (`"20.44"`) |
| A-5 | `scheduled_time` / `end_time` are ISO-8601 **with UTC offset**, microsecond precision |
| A-6 | `event.status` ∈ `{PENDING, PLAYING, COMPLETED, FAILED, CANCELLED, CANCELED, MISSED}` |
| A-7 | `pipeline.secondary_channel_number` and `secondary_receiver_layer` are always present |
| A-8 | `media_item.file_path` uses **forward slashes**, relative to the agent's `MEDIA_PATH` |
| A-9 | `media_item.duration_seconds` is `"0"` for CG items; the agent relies on `template` for CG timing |

### 4.3 Consequences for the backend codebase

- The frozen engine routes live in their **own Django app** (`engine_api`) with their **own
  serializers** (`TRON_*`), separate permission classes, separate throttling and separate tests.
- **Do not** set `default_versioning`, `DEFAULT_PAGINATION_CLASS`, or a global exception handler
  that would alter the engine routes' response shape.
- A **schema-fingerprint test** fails CI if any frozen serializer's field set changes.
- Contract tests CT-1…CT-10 are **CI-gated and blocking**.

### 4.4 Phased engine security (do not skip stage S1)

| Stage | Change | Backend impact |
|---|---|---|
| **S1 (now)** | `ENGINE_AUTH_MODE=permissive`; per-`Server` tokens issued but optional | None |
| S2 *(agent edit)* | Agent adds `X-Engine-Token` header | **None** — backend already accepts it |
| S3 | `ENGINE_AUTH_MODE=enforcing` | Backend starts rejecting |
| S4 *(agent edit)* | mTLS or signed requests on the WS bridge | Backend verifies client certs |
| S5 *(agent edit)* | Agent publishes `engine_version` + `capabilities` | Backend feature-gates |

The entire point of S1 is that **S2 is a one-line change in the agent and needs no backend rewrite**.
The backend must accept the token via **either** the `X-Engine-Token` header **or** a `?token=`
query parameter, on all engine routes.

---

# PART A — BACKEND

> Repository: `Backend/` · Django 5.x + DRF · PostgreSQL 16 · Redis (optional)

## A.1 Architecture and platform

| ID | Requirement |
|---|---|
| BR-ARC-01 | Django 5.x project named `core`; apps `accounts`, `playout`, `engine_api`, `reports` |
| BR-ARC-02 | PostgreSQL 16 as the **only** supported production database (SQLite is not an option — single-writer contention with the agent's writeback) |
| BR-ARC-03 | All configuration from environment / secret store; no secrets in code |
| BR-ARC-04 | `PLAYSUB` channel timezone configurable, default `Asia/Dhaka`; storage in UTC |
| BR-ARC-05 | The engine bridge runs as a **separate process** (management command + supervisor), never in a request thread |
| BR-ARC-06 | Bridge uses a **durable queue** (Redis pub/sub, or PostgreSQL `LISTEN/NOTIFY` + retry table) so pushes survive restarts |
| BR-ARC-07 | Django admin relocated to a non-default path (e.g. `4dm1n/`) |
| BR-ARC-08 | `bootstrap_roles` and `bootstrap_admin` management commands to seed a superuser |

### A.1.1 Backend phases

Phases are ordered so that **each one leaves the system in a working state**.

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0 — Foundation** | Django project, apps, migrations, settings, CI, health checks | Migrations apply cleanly; CI green |
| **P1 — Read-only parity** | Engine API (frozen routes) + all GET browser endpoints, served from migrated data | Contract tests pass; **agent runs unmodified for 24 h against the new API** |
| **P2 — Agent cutover** | Bridge process; agent points at the new API | Live push working; upsert reaches agent < 1 s |
| **P3 — Writes** | Schedule CRUD, media scan, templates, pipelines | Operator can schedule via API; agent executes correctly |
| **P4 — React SPA: Scheduler** | *(Frontend repo — see Part B)* | WF-12…WF-18 pass |
| **P5 — React SPA: remaining tabs** | *(Frontend repo)* | WF-06…WF-11, WF-24, WF-25 pass |
| **P6 — Admin & auth** | Users, roles, departments, OTP flow | WF-01…WF-05 pass |
| **P7 — Realtime & polish** | SSE channel, toasts, a11y, dark theme, performance | SC-3 met; FR-A11-01…07 pass |
| **P8 — Hardening & sign-off** | Security review, load test, DR drill, runbooks | SC-1…SC-7 all met |

## A.2 Domain model

Target model, including the additive changes over legacy.

### A.2.1 `Server`

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | varchar(100) | ✔ | **unique**, indexed — the agent's self-identity |
| `ip_address` | inet | ✔ | reachable address for the WS bridge |
| `amcp_port` | positive int | ✔ | default `5250` |
| `is_active` | bool | ✔ | default `True` |
| `engine_heartbeat_at` | timestamptz | | **NEW** — last agent contact |
| `engine_version` | varchar(32) | | **NEW** |
| `engine_token_digest` | varchar(128) | | **NEW** — see BR-SEC-04 |

### A.2.2 `OutputPipeline` — the central abstraction

> **One pipeline = one on-air output channel** = one CasparCG channel-1 + channel-2 pair + one set
> of stream URLs. This is the core IP of the system.

| Field | Type | Required | Default |
|---|---|---|---|
| `server` | FK→Server | ✔ | |
| `name` | varchar(100) | ✔ | |
| `primary_channel_number` | smallint | ✔ | 1 |
| `primary_playout_layer` | smallint | ✔ | 21 |
| `primary_graphics_layer` | smallint | ✔ | 20 |
| `secondary_channel_number` | smallint | ✔ | 2 |
| `secondary_receiver_layer` | smallint | ✔ | 1 |
| `stream_source_url` | text | | ingest URL/args |
| `output_destination_url` | text | | air-out URL/args |
| `preview_stream_url` | text | | preview URL/args |
| `preview_embed_url` | text | | **NEW** — replaces hardcoded `itvstreamx.duckdns.org` |
| `is_on_air` | bool | ✔ | **NEW** — derived, default `False` |

- `unique_together (server, primary_channel_number)`
- **URL fields are opaque CasparCG/ffmpeg argument strings.** Store and transmit them **verbatim** —
  no parsing, no re-quoting, no validation beyond a leading-scheme check
  (`rtmp://`, `srt://`, `udp://@…`, `rtsp://`, `http://`).

Reference layer map (engine-side env constants, not DB columns):

| Target | Purpose |
|---|---|
| `ch1 : layer 21` | **PROGRAM** — live route *or* ad chain |
| `ch1 : layer 20` | **GRAPHICS** — CG overlay |
| `ch1 : consumer 99` | AIR OUT (`DEST_STREAM_LAYER`) |
| `ch1 : consumer 98` | PREVIEW OUT (`PREVIEW_STREAM_LAYER`) |
| `ch2 : layer 1` | LIVE SOURCE (SRT ingest) |
| `ch2 : layers 2 / 3 / 4` | TICKER / BUG / DOG (SCG loops) |

### A.2.3 `GraphicsTemplate`

`name`, `template_path`, `template_type ∈ {L_SHAPE, POPUP, LOWER_THIRD}`, `fps`, `in_frames`,
`out_frames`, `hold_seconds`, `hold_frames`, `squeeze_x/y/w/h ∈ [0.0, 1.0]`.

Derived duration — **exact formula, must match the engine to the millisecond**:

```
hold_from_frames = hold_frames / fps            (if fps > 0 else 0)
anim_duration    = (in_frames + out_frames) / fps  (if fps > 0 else 0)
total_duration_seconds = anim_duration + float(hold_seconds) + hold_from_frames
```

### A.2.4 `MediaItem`

`title`, `media_type ∈ {FILE, CG, SCG}`, `server` (required), `active_status`, `file_path`,
`duration_seconds`, `duration_frames`, `start_frame`, `end_frame`, `fps`, `template` (FK nullable —
**mandatory for CG**), `probe_error` (**NEW**), `last_scanned_at` (**NEW**).

- `unique_together (server, file_path)`
- Play-duration resolution: CG with template → `template.total_duration_seconds`; otherwise
  `float(duration_seconds)`.
- CG items always carry `duration_seconds = 0`. **Any code computing a CG block length from
  `duration_seconds` produces zero.**

| Type | Filename prefix | Meaning | Duration source | Layer |
|---|---|---|---|---|
| **FILE** | `FILE_*` | Full-screen commercial replacing the programme | Probed from file | ch1 L21 |
| **CG** | `CG_*` | L-Shape / PopUp overlay with alpha, squeezed by DVE | **From the linked template** | ch1 L20 |
| **SCG** | `SCG_*` | Standalone transparent loop — DOG / BUG / TICKER. Loops. | Probed + explicit event `end_time` | ch2 L2/3/4 |

### A.2.5 `ScheduleEvent` — an event is a START, not a block

> There is **no duration column**. A FILE item's length is always its `MediaItem.duration_seconds`
> (or `template.total_duration_seconds` for CG). A consecutive run of FILE events **is** an ad
> break; each file is its own row with its own id, re-derived every time the schedule loads.
> **Consequence: you can only ever move a start. Its end is derived.**
> Exception: SCG (DOG/BUG/TICKER) events carry an explicit `end_time` because they are held.

| Field | Type | Required | Notes |
|---|---|---|---|
| `pipeline` | FK→OutputPipeline | ✔ | |
| `action_type` | enum | ✔ | `PLAY_MEDIA`, `ROUTE_STREAM` |
| `media_item` | FK→MediaItem, nullable | ✔ for `PLAY_MEDIA` | |
| `media_lane` | enum | ✔ for `PLAY_MEDIA` | `FILE`, `CG`, `DOG`, `BUG`, `TICKER` |
| `scheduled_time` | timestamptz | ✔ | the **start** |
| `end_time` | timestamptz, nullable | ✔ for DOG/BUG/TICKER | held-graphic end |
| `status` | enum | ✔ | `PENDING`, `PLAYING`, `COMPLETED`, `FAILED`, `CANCELLED` |
| `hold_seconds` | numeric(10,3) nullable | | **NEW** — NULL ⇒ derive from template |
| `version` | int | ✔ | **NEW** — optimistic concurrency, default 1 |
| `created_by` / `updated_by` | FK→User, nullable | | **NEW** — audit |
| `note` | text | | **NEW** — operator annotation; ticker label lives here |
| `engine_claimed_at` | timestamptz nullable | | **NEW** — lease for crash recovery |

Indexes:

```
(pipeline_id, scheduled_time)
partial (pipeline_id, status) WHERE status IN ('PENDING','PLAYING')
(pipeline_id, timestamp DESC) on ExecutionLog
```

### A.2.6 Server-side validation rules (all nine are mandatory)

1. `PLAY_MEDIA` ⇒ `media_item` **and** `media_lane` are both required.
2. `media_lane ∈ {DOG, BUG, TICKER}` ⇒ `media_item.media_type == 'SCG'` **and** `end_time` required.
3. `media_lane == 'FILE'` ⇒ `media_item.media_type == 'FILE'`.
4. `media_lane == 'CG'` ⇒ `media_item.media_type == 'CG'` and `media_item.template` present.
5. `end_time` (if set) **must be > `scheduled_time`**.
6. Overlap: a new event shall not overlap an existing non-terminal event **on the same
   `(pipeline, media_lane)`**. Cross-lane overlap **is** permitted.
7. `scheduled_time` must not be in the past on create (configurable tolerance, default 0 s).
8. Events within `LOCK_WINDOW_MS` (default 30 000 ms) of now are **locked** — read-only and
   rejected on mutation.
9. Media type ⟷ lane agreement, mirroring the agent's `classify_play_event` rejection logic so the
   UI never offers a combination the agent will reject.

### A.2.7 Chain grouping (mirrors the agent exactly)

A chain is **not a server-side object**. It is a derived view over consecutive `FILE` events. The
grouping is **end-to-start**, not start-to-start — this is the subtlest rule in the system:

```
sort events by scheduled_time
for each event e:
    if current and prev_end is not None and (t_start - prev_end).total_seconds() > CHAIN_GAP_SECONDS:
        close current chain
    append e to current
    prev_end = t_start + timedelta(seconds = media_item.duration_seconds)

CHAIN_GAP_SECONDS = 1.0
```

Therefore three ads at `10:00`, `10:00:20`, `10:00:40` each 20 s long form **one** chain.

Every chain gets a **synthetic ROUTE item appended** by the agent (`event_id == -1`, never
PATCHed, never logged to Django). The server must expose `GET /schedules/chain-preview/` returning
exactly this grouping so the UI renders what the agent will compute.

> **Route-back must be whole-channel:** `route://<secondary_channel>`, **not** `route://<ch>-<layer>`.
> This is load-bearing: DOG/BUG/TICKER live on channel-2 layers 2/3/4, and a layer-scoped route
> would cut them off air. Verified in production logs (migration from `route://2-1` to `route://2`
> on 29 Sep fixed exactly this). **Do not "fix" this back.**

### A.2.8 `ExecutionLog`

`pipeline`, `schedule`, `timestamp` (indexed, server-set), `level ∈ {INFO, WARNING, ERROR}`,
`action`, `message`, `raw_response`, `agent_source` (**NEW**, default `"legacy-agent"`).

Observed `action` values to preserve: `Item On Air`, `Ad Sequence Completed`, `CG Fired`,
`CG Completed`, `SCG Fired`, `SCG Completed`.

### A.2.9 Accounts

`User`, `Role`, `Department` carried forward unchanged. `User.otp` remains an integer field reused
as the second factor of the password-reset handover (legacy quirk preserved).

**Three signals keep `Role` ↔ `Group` ↔ `Permission` in lockstep. They are the RBAC backbone and
must be reimplemented:**

1. `post_save(Role)` → create/get the `auth.Group` named after the role, sync its permissions.
2. `m2m_changed(Role.permissions)` → re-sync `role.group.permissions`.
3. `m2m_changed(User.roles)` → `instance.groups.set(Group.objects.filter(role__users=instance))`.

Any reimplementation that lets them drift breaks `has_perm()` throughout the API.

## A.3 Browser API — `/api/v1/`

### A.3.1 Required surface

```
# Auth
POST   /auth/login                  {identifier, password}  → {user, roles, permissions, is_new}
POST   /auth/logout
GET    /auth/me                                            → {user, roles, permissions, is_new}
POST   /auth/change-password         {new_password, confirm_password}
GET    /auth/sessions
DELETE /auth/sessions/{id}
POST   /auth/otp/send               {email}                 → 202 always
POST   /auth/otp/verify             {email, code}           → {message, tesseract}
POST   /auth/password/reset         {email, tesseract, new_password, confirm_password}

# Users / roles / departments
GET    /users/?search=&page=&page_size=
POST   /users/
GET    /users/username-available?username=
GET    /users/{id}/                                          → {user, roles}
PATCH  /users/{id}/                     (multipart supported)
DELETE /users/{id}/                     ?force=
POST   /users/{id}/activate/    POST /users/{id}/deactivate/
GET    /roles/permissions/                                      → {roles, permissions}
POST   /roles/       PATCH /roles/{id}/       DELETE /roles/{id}/   ?force=&reassign_to=
GET/POST/PATCH/DELETE /departments/…

# Servers & pipelines
GET/POST /servers/        PATCH/DELETE /servers/{id}/
POST   /servers/{id}/issue-engine-token/     → {token} (shown once)
GET    /servers/{id}/engine-state/
GET/POST /playout-channels/                 PATCH/DELETE /playout-channels/{id}/
POST   /playout-channels/{id}/reinit/        {} → {status, pipeline_id, delivery}
POST   /playout-channels/{id}/reinit_preview/ {} → {status, pipeline_id, delivery}

# Media & templates
GET    /media-items/?server=&media_type=&active_status=&search=&page=
GET/POST/PATCH/DELETE /media-items/{id}/
PATCH  /media-items/bulk-status/     {ids, active_status}    → {updated, failed}
PATCH  /media-items/bulk-template/   {ids, template_id}      → {updated, failed}
POST   /servers/{id}/scan-media/     → {status, server, count, scanned_at, media_items}
GET/POST /graphics-templates/        GET/PATCH/DELETE /graphics-templates/{id}/ ?detach=true

# Schedules
GET    /schedules/?pipeline_id=&from=&to=&lane=&status=&media_type=
POST   /schedules/          (also accepts {…, items:[{media_item_id, offset_ms}]} for a chain)
GET/PATCH/DELETE /schedules/{id}/
PATCH  /schedules/times/    {changes:[{id, scheduled_time, end_time?}]}   ← ATOMIC batch
DELETE /schedules/bulk/    {ids:[…]}                                       → {deleted, failed}
POST   /schedules/{id}/cancel/
GET    /schedules/chain-preview/?pipeline_id=&anchor_id=

# Reports & operations
GET    /log-report/?pipeline_id=&start_date=&end_date=&status=&lane=
GET    /log-report/export.csv?…
GET    /bridge/deliveries/?server=&status=
GET    /realtime/stream                       → SSE
GET    /healthz    GET /readyz    GET /api/v1/schema/    GET /api/v1/schema/docs/
```

### A.3.2 Requirement groups

**Authentication & sessions (BR-AUTH)**

- Login by username **or** email; generic failure message, never revealing whether the account
  exists.
- Session cookie `HttpOnly; Secure; SameSite=Lax`; session id **rotated** on login.
- Optional JWT mode (access ≤ 15 min, rotating refresh) behind a setting.
- Server-side session registry with revocation (list-all, revoke individual).
- Session limit per user (default 5): oldest evicted or new rejected (configurable).
- **`is_new` users are rejected with `403 {code:"PASSWORD_CHANGE_REQUIRED"}` on every business
  endpoint** — server-enforced, not merely a UI gate.
- Logout invalidates server-side; `POST` only, CSRF-protected.

**Password reset (BR-PWD)** — preserves the legacy 4-step design **including the non-obvious
"tesseract" handover**, because behaviour parity is required:

1. `otp/send` → 6-digit numeric code, stored on `user.otp` with a 10-minute expiry, emailed.
   **Always returns 202**, whether or not the email exists. Max 5 attempts; resend cooldown 60 s.
2. `otp/verify` → on match, the code is **replaced with a fresh random 6-digit value** returned as
   `tesseract`. The tesseract is therefore **different from the emailed code**.
3. `password/reset` with `{email, tesseract, new_password, confirm_password}` → clears `otp`,
   sets password, **invalidates all sessions**.
4. Tesseract is **single-use** and expires with the OTP. Replay → 400.

Password policy: min 12 chars, similarity + common-password + numeric-only validators.

**Users, roles, departments (BR-USR / BR-ROLE / BR-DEP)**

- List paginated, searchable across name/email/username, excludes superusers and cadets.
- Create generates a **6-digit numeric temporary password**, emails it, and **never returns it in
  any API response or log**. User is created with no usable password beforehand.
- Update accepts role ids as a list, a comma-string, **or** objects — all three forms.
- Delete blocks self-deletion and superuser deletion. Activate/deactivate blocks self and superuser.
- Profile picture stored as `<10-hex><ext>` under `profile_pictures/`.
- Every mutation audited with actor and timestamp.
- Role name uniqueness is **case-insensitive**. Roles named `admin` or `superuser` **cannot be
  deleted**. Deleting a role with users requires `?force=true&reassign_to=<id>`.
- `role_permissions` applies `EXCLUDED_PERMS` patterns (`app.*` and `app.*substring`).
- **All transactional emails name the product "PlyOut"** and use the deploying organisation's name
  in the footer.

**Media items & templates (BR-MED / BR-TPL)**

- Filter by `server`, `media_type`, `active_status`; search `title` / `file_path`.
- `server` and `file_path` are **immutable after creation**.
- Bulk endpoints return `{updated:[…], failed:[{id, error}]}` and **distinguish** "not found" from
  "Not a CG item".
- **Validation lives in the serializer, not in `Model.save()`** — the legacy `clean()`-on-every-save
  breaks bulk operations.
- `squeeze_*` validated to `[0.0, 1.0]`. Template delete blocked while referenced unless
  `?detach=true`.
- Server-side `total_duration` using the exact formula above.

**Media scanning (BR-SCAN)**

- `POST /servers/<id>/scan-media/` → WS `get_media_list`, **one** reply frame, close, 10 s timeout.
- Full sync in **one transaction**: create missing, update
  `[media_type, duration_seconds, fps, duration_frames, start_frame, end_frame]` on existing,
  delete rows absent from the incoming set. **Never touch `template` or `active_status`.**
- CG rows are created with `template = NULL` and must be assigned by an operator.
- Errors: agent unreachable → `504 AGENT_UNREACHABLE`; malformed frame → `422 AGENT_PROTOCOL_ERROR`.
- Per-server scan lock so concurrent scans cannot interleave.
- Emit a `media_scanned` realtime event so the SPA invalidates caches without polling.
- Scanning 5 000 files completes < 30 s.

**Servers & pipelines (BR-PIPE)**

- Reinit endpoints push C-9 / C-10 and return **immediately** with a `delivery` status.
- Pipeline create/update/delete push C-11 / C-12 / C-13.
- `is_on_air` is **derived**: any non-terminal event exists for the pipeline.
- Surface `engine_heartbeat_at`, `engine_version`, and an Online/Stale/Offline indicator
  (fresh < 60 s, stale < 15 min).
- Layer/channel range validation with warnings for overlaps (e.g. playout layer == graphics layer).

**Schedules (BR-SCH)** — the most rule-dense area

- Default list window: last 3 days → all future.
- `PATCH /schedules/times/` is **atomic**: if any change is invalid, **none** are applied.
- `DELETE /schedules/bulk/` returns `deleted` / `failed` separately; partial success is visible.
- Every create/update/delete pushes C-7 / C-8 with retry.
- Optimistic concurrency via `version`; `409 {code:"VERSION_MISMATCH"}`.
- Lock-window enforcement is **server-side**, not just a disabled button.
- `POST /schedules/` may accept a **composite** `{items:[{media_item_id, offset_ms}]}` to create a
  whole chain in one transaction — but the agent **still receives one upsert per event**.
- Soft delete via `CANCELLED` is preferred over hard delete for anything not yet fired.
- Bulk chain retiming **must not reorder members**; order is by `scheduled_time`.

**Reporting (BR-RPT)**

- Response `{pipeline_id, pipeline_name, server, start_date, end_date, total_events, events:[…]}`.
- `events[]` fields: `id, pipeline_id, action_type, media_lane, status, scheduled_time, end_time,
  duration_seconds, media_title, media_type, media_file_path, template_name`.
- **Per-event duration precedence — exact:**

```
if end_time and scheduled_time : (end_time - scheduled_time)
elif no media_item             : 0.0
elif media_type == CG and template : template.total_duration_seconds
else                           : media_item.duration_seconds
```

- Paginate when the range exceeds a configurable threshold (default 50 000 rows).
- CSV export for large ranges; XLSX assembled client-side for ≤ 50 k rows.

**Realtime to browser (BR-RT)**

- SSE (or WebSocket) channel for `schedule.changed`, `schedule.status`, `media.scanned`,
  `agent.state`, `bridge.delivery`.
- Authenticated with the **browser session cookie**, never a query token.
- Initial snapshot + incremental deltas with **monotonically increasing sequence numbers**.
- Client detects gaps via `Last-Event-ID` and requests a resync.
- Heartbeat every 20 s; client reconnects with exponential backoff and jitter.
- **The realtime channel is strictly optional** — the SPA must work fully by polling without it.

## A.4 Engine API — `/api/` (FROZEN)

| ID | Requirement |
|---|---|
| BR-ENG-01 | `GET /api/pipelines/?server_name=&is_active=` → **bare array** |
| BR-ENG-02 | `GET /api/schedule/?pipeline=` → **bare array**, no pagination envelope |
| BR-ENG-03 | `PATCH /api/schedule/{id}/` → **PATCH only**; `GET`/`POST`/`DELETE` on that path return `405` |
| BR-ENG-04 | `POST /api/logs/` → creates exactly one `ExecutionLog`; unknown fields ignored |
| BR-ENG-05 | `GET /api/graphics-templates/{id}/` |
| BR-ENG-06 | p95 < 300 ms at 20 concurrent agents; **no** heavy joins or permission checks on these routes |
| BR-ENG-07 | Serialisers emit `media_item` and `template` **nested** |
| BR-ENG-08 | The `template` key is **omitted entirely** unless `media_type == "CG"` |
| BR-ENG-09 | Decimals as **strings**; timestamps with explicit offset + microseconds |
| BR-ENG-10 | Status writeback tolerates concurrent updates to different ids and repeated identical writes |
| BR-ENG-11 | All engine routes accept `X-Engine-Token` or `?token=`; governed by `ENGINE_AUTH_MODE` |
| BR-ENG-12 | `permissive`: unauthenticated calls accepted **and logged**. `enforcing`: `401` |
| BR-ENG-13 | Contract tests assert the exact JSON shape and field set for C-1…C-5 |
| BR-ENG-14 | A schema-fingerprint test fails CI if a frozen serializer changes |
| BR-ENG-15 | Do **not** add `default_versioning`, `DEFAULT_PAGINATION_CLASS`, or a global exception handler that alters these routes |

Frozen response shapes, reproduced verbatim from the SRS:

```json
// GET /api/pipelines/
[{"id":3,"server_name":"LOCAL_CASP","name":"PIPE_1",
  "primary_channel_number":1,"primary_playout_layer":21,"primary_graphics_layer":20,
  "secondary_channel_number":2,"secondary_receiver_layer":1,
  "stream_source_url":"srt://…","output_destination_url":"…","preview_stream_url":"…"}]

// GET /api/schedule/?pipeline=3
[{"id":1921,"action_type":"PLAY_MEDIA",
  "scheduled_time":"2026-10-04T18:33:36.549000+06:00",
  "media_item":{"id":33,"title":"FILE_x","media_type":"FILE","server":1,"active_status":true,
    "server_name":"LOCAL_CASP","file_path":"FILE_x.mp4",
    "duration_seconds":"9.90","duration_frames":297,
    "start_frame":0,"end_frame":297,"fps":30,"template":null},
  "media_lane":"FILE","end_time":null,"status":"PENDING"}]
```

For a CG item, `media_item.template` is a nested object. **For non-CG items the `template` key is
omitted entirely.**

> **Watch out:** A-2 says the nested object is mandatory, and the example above shows
> `"template":null` on a FILE item. Reconcile this in the golden files during P1 — the golden file
> *is* the authority, and it must be captured from a real, unmodified agent session. Until then,
> emit `template` for CG items and follow the recorded production frame exactly.

## A.5 Engine bridge (Django → agent)

| ID | Requirement |
|---|---|
| BR-BRG-01 | Outbound WS to `ws://<server.ip_address>:8766`; connect timeout 2 s |
| BR-BRG-02 | **One connection per frame** — matches the agent's per-connection bridge |
| BR-BRG-03 | Frames C-6…C-10 implemented; C-11…C-16 implemented and wired |
| BR-BRG-04 | `get_media_list` reads **exactly one** reply frame, then closes |
| BR-BRG-05 | Reinit may optionally await `*_result` on the same socket (10 s); **non-blocking by default** |
| BR-BRG-06 | Failed pushes persisted in a retry table; exponential backoff 1 s → 5 min; visible in admin |
| BR-BRG-07 | Publish a `bridge_delivery` event so the SPA shows deferred status |
| BR-BRG-08 | Graceful shutdown drains in-flight pushes |
| BR-BRG-09 | Per-server connection concurrency cap to protect the agent |

**Flow for a schedule write:**

1. SPA `POST`/`PATCH`/`DELETE` → server commits the write.
2. Server publishes to an internal broker (Redis pub/sub or PostgreSQL `LISTEN/NOTIFY`).
3. Bridge subscriber opens a WS to the target agent and sends C-7 / C-8. **New connection per
   message.**
4. On failure: retry with exponential backoff (1 s → 2 s → 4 s … max 5 min), surfaced in the UI as
   **"agent delivery deferred"** on the affected pipeline.

**Invariant: an unreachable agent must never block the HTTP response and must never lose the
operator's write.** The write commits first; delivery is a separate, retryable concern.

## A.6 Security

| ID | Requirement |
|---|---|
| BR-SEC-01 | Deny by default. No `AllowAny` except `/auth/login`, `/auth/otp/*`, `/auth/password/reset`, `/healthz`, `/readyz` |
| BR-SEC-02 | CSRF protection on all cookie-authenticated mutations |
| BR-SEC-03 | CORS allow-list from configuration; `credentials` only for listed origins |
| BR-SEC-04 | Per-`Server` API token: admin action, stored **hashed**, shown **once**, revocable, rotatable |
| BR-SEC-05 | `ENGINE_AUTH_MODE` = `permissive` (default) \| `enforcing`, switchable without downtime |
| BR-SEC-06 | Security headers: CSP with nonce for the SPA, HSTS, `nosniff`, `Referrer-Policy`, `frame-ancestors` |
| BR-SEC-07 | Rate limits: login 5/15 min per IP+identifier; OTP send 3/hour per email; mutations 600/min per user |
| BR-SEC-08 | `Idempotency-Key` on all mutations, 24-hour replay window |
| BR-SEC-09 | Structured audit log for all writes to `playout` and `accounts` entities |
| BR-SEC-10 | Secrets never logged; URL credentials redacted while retaining the rest for diagnostics |
| BR-SEC-11 | Dependency scanning + secret scanning in CI |
| BR-SEC-12 | Admin path from env; honeypot path retained |

**Legacy defect being fixed:** the legacy app sets `DEFAULT_PERMISSION_CLASSES = [AllowAny]`
globally. The rebuilt app flips the default to deny-by-default. This is the single highest-value
security change in the project.

**Threats addressed:** unauthenticated caller marking events PLAYING/COMPLETED or injecting fake
logs (TH-1); anyone reaching the agent's WS on 8766 (TH-2); privilege escalation via RBAC drift
(TH-4); CSRF (TH-5); XSS via media titles sourced from filenames (TH-6); account enumeration
(TH-7); credential leakage (TH-8); clickjacking (TH-9); replay of destructive mutations (TH-10);
stuck `PLAYING` masking real failure (TH-11); secrets in the repository (TH-12).

### A.6.1 Content Security Policy

```
default-src 'self'
script-src 'self'                    (+ nonce for the SPA bootstrap; NO unsafe-inline, NO unsafe-eval)
style-src  'self' 'unsafe-inline'     (Tailwind-in-CSS; tighten later with nonce-based CSS)
connect-src 'self' wss://…            (realtime endpoint)
frame-src   <configured preview_embed_url origins>
img-src     'self' data: blob:
```

## A.7 Operations

- `/healthz` (liveness), `/readyz` (readiness incl. DB and bridge state).
- Structured JSON logs with `request_id` propagated end-to-end.
- OpenTelemetry spans across HTTP → DB → bridge → agent WS.
- Metrics: API latency, schedule mutation rate, push success/failure, agent online count, events by
  status.
- Management commands: `bootstrap_roles`, `bootstrap_admin`, `issue_engine_token`, `rescan_media`,
  `push_pending`, `reap_stuck_events`.
- `SCHEDULE_REAPER_ENABLED` defaults to **false**; when enabled, it flags `PLAYING` events older
  than `ENGINE_LEASE_TIMEOUT` on a stale agent as `FAILED` with `note="agent lease expired"`.
- Export/purge of `ExecutionLog` beyond the retention window.
- Retention: execution logs per channel policy (default 400 days); schedule events 3 years.
- Backup: PostgreSQL daily base backup + WAL archiving, with a documented restore drill.
- Migrations must be reversible and zero-downtime. Django migrations only.

## A.8 Testing

| ID | Requirement |
|---|---|
| BR-TST-01 | Unit tests for **all** validation rules in §A.2.6 |
| BR-TST-02 | Contract tests for C-1…C-5 asserting exact shape and **absence of pagination envelopes** |
| BR-TST-03 | Golden-file tests for the three `TRON_*` serializers |
| BR-TST-04 | Integration tests against a **mock agent replaying recorded production frames** |
| BR-TST-05 | Tests for media sync create/update/delete and `template` preservation |
| BR-TST-06 | Batch atomicity tests for `times/`, `bulk/`, composite chain create |
| BR-TST-07 | Load test: 5 000 events, 8 pipelines |
| BR-TST-08 | **≥ 85 % line coverage** on `playout` and `engine_api` |

### A.8.1 Blocking contract tests

| # | Assertion |
|---|---|
| CT-1 | `/api/pipelines/` is a **bare array**; each element has all 11 fields with correct types |
| CT-2 | `/api/schedule/` is a bare array; `media_item` nested; `template` present **iff** `media_type=='CG'` |
| CT-3 | `duration_seconds` is a **string**; `scheduled_time` has offset + microseconds |
| CT-4 | `GET`/`POST`/`DELETE` on `/api/schedule/{id}/` return `405` |
| CT-5 | `POST /api/logs/` creates exactly one row; unknown fields ignored |
| CT-6 | `/api/graphics-templates/{id}/` has the correct field set |
| CT-7 | Replaying a **recorded production frame** yields byte-equal state |
| CT-8 | `enforcing` without a token → `401`; with a valid token → `200` |
| CT-9 | Serializer fingerprint — CI fails if any frozen field changes |
| CT-10 | 200 concurrent `PATCH`es across 50 ids **all succeed** |

### A.8.2 Performance and security gates

| # | Test | Target |
|---|---|---|
| PF-1 | `GET /api/schedule/` at 5 000 events | p95 < 400 ms |
| PF-2 | 200 concurrent `POST /api/logs/` | p95 < 300 ms, zero errors |
| PF-4 | Realtime: commit → agent receives | < 1 s |
| SE-1 | Every `/api/v1` endpoint without credentials | `401`/`403` (except the public list) |
| SE-2 | Engine endpoints in enforcing mode without a token | `401` |
| SE-3 | CSRF-less mutation with a session cookie | `403` |
| SE-4 | XSS payload as a media title | Rendered as text, not executed |
| SE-5 | Timing analysis on login and OTP | No statistically significant difference |
| SE-6 | Dependency audit | No critical/high |
| SE-7 | `output_destination_url` containing credentials | Redacted in logs |

### A.8.3 Backend CI pipeline

```
lint (ruff) → format check → type-check (mypy) → unit tests
  → migration check (makemigrations --check) → integration tests
  → CONTRACT TESTS (blocking) → OpenAPI drift check → coverage ≥ 85 %
  → dependency audit → secret scan → branding sweep
```

## A.9 Data migration

| ID | Requirement |
|---|---|
| MIG-01 | Import `accounts_user`, `accounts_role`, `auth_group`, `auth_permission`, `auth_group_permissions`, `accounts_user_roles`, `accounts_user_groups` |
| MIG-02 | Import `plyout_server`, `plyout_outputpipeline`, `plyout_graphicstemplate`, `plyout_mediaitem`, `plyout_scheduleevent`, `plyout_executionlog` |
| MIG-03 | Map `accounts_user.otp` to `NULL` — OTP is ephemeral |
| MIG-04 | Preserve IDs where possible so existing references stay valid; otherwise remap and verify |
| MIG-05 | Recompute `version = 1` for all schedule events |
| MIG-06 | Backfill `last_scanned_at` and `preview_embed_url` |
| MIG-07 | Produce a reconciliation report: row counts per table, FK orphans, validation violations |
| MIG-08 | **Dry-run by default**; `--apply` to commit |
| MIG-09 | **Do not** delete or modify the legacy database until sign-off |

## A.10 Backend Definition of Done

- [ ] All 9 validation rules unit-tested; batch atomicity proven
- [ ] Contract tests CT-1…CT-10 green and **blocking in CI**
- [ ] Serializer fingerprint test in place
- [ ] Mock-agent integration tests replaying recorded production frames pass
- [ ] ≥ 85 % coverage on `playout` and `engine_api`
- [ ] `openapi.yaml` committed and drift-checked
- [ ] Every BR-SEC requirement implemented and SE-1…SE-7 green
- [ ] Bridge survives agent downtime; retries drain automatically
- [ ] Migration tool runs clean in dry-run, produces a reconciliation report
- [ ] `/healthz`, `/readyz`, structured logs, `request_id` propagation, metrics all working
- [ ] Runbooks written: agent onboarding, reinit playbook, rollback, DR restore
- [ ] 24 h unmodified-agent soak completed

---

# PART B — FRONTEND

> Repository: `Frontend/` · React 18 + TypeScript (strict) + Vite

## B.1 Technology baseline

| ID | Requirement |
|---|---|
| FR-T-01 | React 18 + TypeScript (**strict**) + Vite |
| FR-T-02 | TanStack Query for server state; **Zustand for UI state only** |
| FR-T-03 | React Router v6 |
| FR-T-04 | Radix UI primitives (headless) + Tailwind CSS. **No Bootstrap, no jQuery, no jQuery UI** |
| FR-T-05 | Lucide React icons |
| FR-T-06 | `date-fns` + `date-fns-tz`; channel timezone from config |
| FR-T-07 | SheetJS (`xlsx`) or exceljs for Excel export |
| FR-T-08 | **No runtime template strings; no `innerHTML` with user data** |
| FR-T-09 | Strict CSP-compatible: **no inline event handlers, no `eval`** |

The legacy frontend is a 4,134-line single HTML file with 138 function declarations, jQuery,
jQuery UI, Bootstrap, Select2, `innerHTML` re-renders on every mouse pixel, **zero persistence**
and **zero realtime**. Every one of those is a thing this rebuild fixes.

## B.2 Application shell

Routes (FR-SH-01):

```
/login  /change-password  /forgot-password  /reset-password
/schedule  /navigator  /execlog  /system
/admin/users  /admin/roles  /admin/pipelines  /admin/templates
*  →  404
```

| ID | Requirement |
|---|---|
| FR-SH-02 | Top bar (product logo, nav tabs, live clock, user menu) + content area |
| FR-SH-03 | Route guard: unauthenticated → `/login`; `is_new` → `/change-password`, **all other routes blocked** |
| FR-SH-04 | Clock ticks at 1 Hz in the channel timezone |
| FR-SH-05 | Global loading overlay on first load |
| FR-SH-06 | Realtime indicator (connected / reconnecting / offline) |
| FR-SH-07 | Toast + dismissible banner notification system |
| FR-SH-08 | Confirm dialogs for destructive actions (delete chain, cancel event) |
| FR-SH-09 | On `401`: attempt refresh once, else redirect to login **preserving the route** |
| FR-SH-10 | Per-user light/dark theme preference |
| FR-SH-11 | All user-facing strings name the product **"PlyOut"**. No "StreamX" / "IngestX" |
| FR-SH-12 | Product name from a **single configuration value**, not hardcoded per component |

## B.3 Scheduler — layout

| ID | Requirement |
|---|---|
| FR-TL-01 | Toolbar: shift left/right, jump to now, zoom in/out, zoom readout, current time |
| FR-TL-02 | Zoom levels **5, 10, 15, 30, 60, 120 minutes**; shortcuts `+` / `-` |
| FR-TL-03 | Shift view by **±6 h**; keyboard `←` / `→` |
| FR-TL-04 | Time ruler with minor/major ticks and day-boundary date labels |
| FR-TL-05 | One row per pipeline, grouped and ordered by server |
| FR-TL-06 | Row anatomy: channel label (status dot, name, preview player, now/upcoming readout) + lane stack |
| FR-TL-07 | Lane stack: main FILE lane (**flex 1.6**) then CG, DOG, BUG, TICKER lanes (**flex 1** each) |
| FR-TL-08 | Each lane has its own label, now-line, and lock marker |
| FR-TL-09 | Footer status bar: engine state, ON AIR count, SCHEDULED count, now-mode toggle |
| FR-TL-10 | Now mode: **marker** (static now line) or **timeline** (auto-following) |
| FR-TL-11 | Layout recomputation on resize and tab activation (`requestAnimationFrame`) |
| FR-TL-12 | Responsive to 1280×800; below that the inspector collapses to a drawer |

> The 1.6 : 1×4 split is deliberate — most of a channel row's height belongs to the graphics stack
> because all four CG lanes are independently live at once.

### B.3.1 The five lanes

| Lane | `media_lane` | Kind | Item source | Initial length | Resizable |
|---|---|---|---|---|---|
| main FILE/AD | `FILE` | — | media picker (`kind=ad`) | `media_item.duration` | — |
| L-Shape / PopUp | `CG` | **TIMED** | media picker (`kind=cg`) | template duration | **no** |
| Doggy | `DOG` | **HELD** | media picker (`kind=scg`) | 60,000 ms | **yes** |
| Bug | `BUG` | **HELD** | media picker (`kind=scg`) | 60,000 ms | **yes** |
| Ticker | `TICKER` | **HELD** | **free-text label modal**, no media item | 60,000 ms | **yes** |

> **TIMED vs HELD is the key distinction.**
> **TIMED** (L-Shape/PopUp): length derived from the template. No edge handles, no End editing; only
> the **start** is movable.
> **HELD** (DOG/BUG/Ticker): comes up and **stays up** until taken down. New block starts at 1 min,
> stretched by either edge handle or by typing an End; the video **loops**, drawn as faint per-cycle
> rules plus a `↻ ×N` badge.

### B.3.2 Overlap rules

Overlap is checked **within a single lane only**, and only against non-finished clips:

```
startMs < other.endMs && endMs > other.startMs
```

Therefore: a TICKER and a BUG at the same instant is **normal**; two TICKERs at the same instant is
not. CG lanes are free to overlap the main track entirely. The live band is a **persistent
background layer, never an array item**, and is **never overlap-checked**.

### B.3.3 The live band

LIVE is a background band spanning the whole visible track, one per channel. Ad groups and CG are
scheduled **on top of** it and interrupt it. When an ad ends, live is what remains underneath — it
"resumes" automatically with **no explicit event**.

## B.4 Clips

| ID | Requirement |
|---|---|
| FR-CL-01 | Block types: ad group, CG, DOG/BUG/TICKER, live band |
| FR-CL-02 | Ad group renders as ordered segments with per-segment state: **played / on-air / queued** |
| FR-CL-03 | Held graphics render with **both edge handles**, faint per-cycle loop rules, and a `↻ ×N` badge |
| FR-CL-04 | Timed graphics render **without** edge handles |
| FR-CL-05 | Gapless neighbours get joined-edge styling (within 1 s) |
| FR-CL-06 | Status styling by `scheduled` / `locked` / `live` / `done` / `error` |
| FR-CL-07 | Type badge and name row per block; name strips `FILE_`/`CG_`/`SCG_` prefixes **for display only** |
| FR-CL-08 | Hover tooltip: type, file path, template, scheduled time, duration, status, server |
| FR-CL-09 | **Virtualise by time window** — only blocks intersecting `[offset, offset+zoom]` render |
| FR-CL-10 | Blocks below a visibility threshold collapse to a coloured bar without text |

Ad-chain segment states: played `rgba(52,199,89,.30)` · on-air `rgba(255,59,48,.38)` ·
queued `rgba(255,204,0,.30)`.

## B.5 Drag, drop and editing

| ID | Requirement |
|---|---|
| FR-DND-01 | **Pan** the timeline by dragging the ruler or the track background |
| FR-DND-02 | **Move** any clip; duration captured at drag start and **never recomputed** |
| FR-DND-03 | Moves are clamped to **not before now** |
| FR-DND-04 | CG lanes snap to neighbour edges; tolerance in **ms derived from px ÷ pxPerMs** at current zoom |
| FR-DND-05 | Overlapping proposals are refused with a toast naming the conflict |
| FR-DND-06 | **Resize both edges on held lanes only** |
| FR-DND-07 | The right edge of an on-air held graphic may only **extend forward** |
| FR-DND-08 | Ad chains move as a unit via a 5 px top drag bar |
| FR-DND-09 | Ad chain reordering is **▲/▼ only** — never by timeline drag |
| FR-DND-10 | Pointer capture; `requestAnimationFrame`-throttled visual updates; commit on release |
| FR-DND-11 | **Escape** cancels an in-flight drag and restores the original position |
| FR-DND-12 | Optimistic update with rollback on `409`, plus a conflict banner and per-item reload |
| FR-DND-13 | Drag is disabled while a modal is open or in timeline (auto-follow) mode |

**Enablement matrix (preserved from legacy):**

```
isScheduledEditable = status === 'scheduled' && !locked
isLive               = playing
canMove              = isScheduledEditable
canResizeLeft        = stretchable && canMove
canResizeRight       = stretchable && (canMove || playing)    ← right edge is live-resizable ON AIR
```

Resizing clamps: left edge to `end − 1000 ms` and not before now; right edge to `start + 1000 ms`
and, while on air, forward-only.

Editing the start **preserves duration**; for chains it **shifts every member by the same delta**,
preserving order and gaplessness.

> **Why reordering is buttons-only** (deliberate, from the legacy source comment): *"dragging
> segments on the timeline used to reorder the chain, but that made it too easy to accidentally
> reshuffle files while trying to just move the chain."*

## B.6 Context menu and creation

| ID | Requirement |
|---|---|
| FR-CTX-01 | Right-click a lane opens a **lane-aware** context menu |
| FR-CTX-02 | Suppress the menu in timeline auto-follow mode, with an explanatory toast |
| FR-CTX-03 | Suppress the menu for past / locked positions |
| FR-CTX-04 | **Schedule File/Ad Here** on the main lane; **Schedule {Lane} Here** on CG lanes |
| FR-CTX-05 | **Delete Scheduled Item** shown only when a nearby unlocked scheduled clip exists |
| FR-CTX-06 | Click-outside and Escape close the menu |

**Schedule flow (WF-12):** right-click → convert x-coordinate to epoch ms using current
zoom/offset → media picker pre-filtered to the lane's kind, **active items only** → `POST
/api/v1/schedules/` → server validates, persists as `PENDING`, pushes C-7 → block renders.

The menu items `startLive`, `insertAdNow`, `insertCgNow` and `stopOnair` from the legacy UI are
**dead code** and are **not** rebuilt.

## B.7 Inspector panel

Fields: Type, Name, Detail, Chain (for ad groups), Channel, **Start**, **End**, **Duration**,
**Status**, plus Save and Delete.

| ID | Requirement |
|---|---|
| FR-INS-02 | Duration is **always read-only and server-derived** |
| FR-INS-03 | End editable only for held lanes; Start editable only for unlocked scheduled items |
| FR-INS-04 | CG name/detail **read-only** (they come from the template) |
| FR-INS-05 | Delete hidden/disabled for locked and on-air items |
| FR-INS-06 | Live band inspector shows everything disabled, End as `— (runs until stopped)` |
| FR-INS-07 | Validation messages mirror WF-18 exactly |
| FR-INS-08 | Auto-switch to the selected clip; clear on deselection |

**Validation on save (exact strings, preserved):**

```
start unparseable        → "Invalid start time."
start < now − 5000 ms    → "Start time is in the past."
end unparseable          → "Invalid end time."
end < start + 1000 ms    → "End time must be at least a second after the start."
same-lane overlap        → "Time overlaps with another scheduled item on this lane."
```

`parseDateTime` accepts `YYYY-MM-DD HH:MM:SS` **or** bare `HH:MM(:SS)` (defaults to today).

## B.8 Media picker and chain modal

| ID | Requirement |
|---|---|
| FR-PICK-01 | Modal listing media with search (250 ms debounce), filter by kind (`ad`/`cg`/`scg`), **active items only** |
| FR-PICK-02 | Duration shown is **server-derived**; never typed by the user |
| FR-PICK-03 | Resolves a `Promise<MediaItem \| null>` |
| FR-PICK-04 | If the search endpoint is unavailable, fall back to the last cached scan and show a notice |
| FR-PICK-05 | Incomplete CG items (no template) are shown but **disabled with the reason** |
| FR-CHAIN-01 | Chain modal: ordered file list with index, name, duration, ▲/▼, ✕, "+ Add file" |
| FR-CHAIN-02 | Cannot remove the last file, or the file currently on air |
| FR-CHAIN-03 | Reorder/remove issues **one** batched request |
| FR-CHAIN-04 | Modal **auto-closes** if any member enters the lock window (legacy behaviour) |
| FR-CHAIN-05 | Reordering updates absolute times by cumulative duration, preserving gaplessness |

The chain modal renders grouping from `GET /schedules/chain-preview/` so **what the UI shows is
identical to what the agent will compute** (AC-35). CG items without a template cannot be selected.

## B.9 Navigator (media library)

| ID | Requirement |
|---|---|
| FR-NAV-01 | Server selector + **⟲ Refresh Media** + last-scan timestamp + duration |
| FR-NAV-02 | Two tables: **FILES** and **CG / TEMPLATES**, plus a SCG group for DOG/BUG |
| FR-NAV-03 | Columns: select-all, Title, Duration, Active Status; the CG table adds Template |
| FR-NAV-04 | Row selection with tri-state select-all; per-type selection sets |
| FR-NAV-05 | Bulk **Activate / Deactivate** per table |
| FR-NAV-06 | Bulk **Assign Template** for CG only |
| FR-NAV-07 | Scanning overlay with progress message, cancel-safe |
| FR-NAV-08 | Per-server error banner (dismissible) that **does not block other servers** |
| FR-NAV-09 | Newly-changed rows briefly highlighted after a scan |
| FR-NAV-10 | Rows changed since the last scan show a delta indicator |

On mount, issue `scan-media` for **every** server in parallel via `Promise.allSettled` — a failing
server shows a dismissible banner and does not block the others. Duration shown is always derived
(`duration_seconds`, except CG which shows the template's `total_duration_seconds`).

The legacy `＋ New` button and `Search…` input in this tab had **no handlers**. They are not
rebuilt unless a real requirement emerges.

## B.10 Execution Log

| ID | Requirement |
|---|---|
| FR-XL-01 | Filters: Server, Channel, Start date, End date, type checkboxes `FILE`/`CG`/`SCG`, optional status |
| FR-XL-02 | Default range: **yesterday → today** |
| FR-XL-03 | Reject `end < start` inline before any request |
| FR-XL-04 | Summary shows **`N of M event(s)`** after filtering |
| FR-XL-05 | Sortable columns: Scheduled Time, Duration, Title, Type, Template, Status |
| FR-XL-06 | Status badges colour-coded; duration formatted `hh:mm:ss.mmm` |
| FR-XL-07 | **⤓ Export XLSX** exports the **filtered + sorted view**, not the raw response |
| FR-XL-08 | Out-of-order response guard (monotonic request token) |
| FR-XL-09 | Refresh button with spinner |
| FR-XL-10 | Virtualise rows beyond 500 |

Columns: `scheduled_time`, `duration_seconds`, `media_title`, `media_type`, `template_name`,
`status`.

## B.11 System tab

| ID | Requirement |
|---|---|
| FR-SYS-01 | Channel selector; **read-only** Source / Destination / Preview textareas |
| FR-SYS-02 | Optional preview player using `preview_embed_url` |
| FR-SYS-03 | **⟲ Reinit** and **⟲ Reinit PVW** buttons, **permission-gated** |
| FR-SYS-04 | Show agent online state and last heartbeat |
| FR-SYS-05 | Show pipeline layer/channel map for the selected pipeline (read-only reference) |
| FR-SYS-06 | Show deferred-push warnings for this pipeline |
| FR-SYS-07 | Optionally surface "force end ad break / CG / SCG" once the agent is upgraded (phase 2) |

The three URL fields render **exactly as stored**, including embedded quotes and ffmpeg arguments.
The preview player uses the configured `preview_embed_url`, **never** a hardcoded host.

## B.12 Auth screens

- **Login** — username *or* email. `is_new` forces the change-password route and blocks everything
  else; this is **also** enforced server-side with `403 PASSWORD_CHANGE_REQUIRED`, so direct
  navigation cannot bypass it.
- **Forced first-login password change** — min 12 chars, similarity/common/numeric validators,
  optional "sign out other devices", other sessions invalidated.
- **Forgot password** — 3 screens mirroring the legacy 4-step design: send code → verify code
  (returns the `tesseract`) → reset. Always displays a neutral confirmation on send, regardless of
  whether the address exists.

## B.13 State management

| ID | Requirement |
|---|---|
| FR-ST-01 | Server state (pipelines, media, templates, schedules, logs) owned by React Query |
| FR-ST-02 | UI state (selection, viewport `{zoomMs, offsetMs}`, now mode, panel sizes) in Zustand |
| FR-ST-03 | Clip geometry derived from `startMs`/`endMs`; **no DOM measurement during drag** |
| FR-ST-04 | Normalised clip store keyed by event id; lane arrays derived by selector |
| FR-ST-05 | Viewport persisted (local storage + server preference) so a reload restores the view |
| FR-ST-06 | Optimistic mutations with rollback and conflict resolution |
| FR-ST-07 | **No component may hold an authoritative copy of schedule data in local state** |

> This directly fixes the legacy behaviour: zero `localStorage`, zero persistence, reload discards
> all timeline state. FR-ST-05 is a deliberate, approved improvement.

### B.13.1 Rendering rules (the performance-critical part)

The legacy app re-renders **every channel on every mouse pixel** and is unusable at 8+ channels.
The rules that fix it:

1. Compute `pxPerMs = trackWidth / zoomMs` **once per render**; derive every block's geometry from
   it. Never measure the DOM during a drag.
2. **Virtualise by time window** — render only blocks intersecting `[offsetMs, offsetMs+zoomMs]`
   and only channels in the viewport.
3. `onPointerMove` writes to a **ref-backed transient drag state**; render via
   `useSyncExternalStore` / `requestAnimationFrame`; commit to the store on `pointerup`.
4. Snap tolerance is expressed in **ms derived from px at current zoom**, so it feels constant on
   screen at every zoom level.
5. Keep the **live band** as a background layer, never an array item.
6. Status styles applied via **data attributes**, not inline `cssText`.

**Target: 8 channels × 5 000 clips at 60 fps pan and 60 fps drag (SC-3 / PF-3).**

## B.14 Realtime and refresh

| ID | Requirement |
|---|---|
| FR-RT-01 | Subscribe to the realtime channel; apply `schedule.changed`, `schedule.status`, `media.scanned`, `agent.state`, `bridge.delivery` |
| FR-RT-02 | **Poll `GET /schedules/` every 30 s** as the authoritative fallback; **never rely solely on realtime** |
| FR-RT-03 | Clock-driven local transition: when a clip's `scheduled_time` passes and status is still `PENDING`, mark it *due* client-side and show a spinner |
| FR-RT-04 | Preserve legacy lock behaviour: at `scheduled_time − 30 s` an item locks, a dirty inspector auto-saves, and an open chain modal closes |
| FR-RT-05 | Connection-loss banner with automatic reconnection |
| FR-RT-06 | When realtime is unavailable, surface a quiet indicator; **functionality continues** |

The legacy app had **no realtime at all** — status was learned via two one-shot timers per clip
(at start, and at end with 5 retries then `error`). The 1 Hz clock watcher is retained for
now-line positioning and lock transitions, but status now arrives pushed.

## B.15 Notifications and feedback

| ID | Requirement |
|---|---|
| FR-NF-01 | Toasts for every mutation outcome, auto-dismiss 4 s, manual dismiss |
| FR-NF-02 | Agent delivery deferral shown as a **non-blocking warning on the affected pipeline** |
| FR-NF-03 | Network / `5xx` errors surfaced with a retry affordance |
| FR-NF-04 | All `alert()` calls replaced by non-blocking toasts |

## B.16 Design system

| ID | Requirement |
|---|---|
| FR-DS-01 | Design tokens as **CSS custom properties** (the legacy hard-codes every colour) |
| FR-DS-02 | Light **and dark** themes, persisted (the legacy is light-only) |
| FR-DS-03 | Primary accent `#007aff` |
| FR-DS-04 | Status styles via **data attributes**, not inline `cssText` |
| FR-DS-05 | Spacing/typography scale matching the legacy's compact 10–12 px timeline density |
| FR-DS-06 | Components: Button, Input, Select, Checkbox, Modal, ContextMenu, Toast, Table, Badge, Tabs, Spinner, Tooltip |

### Status palette (preserved from legacy — do not restyle)

| State | Block background | Border | Text |
|---|---|---|---|
| `error` | `#3a1a1a` | `#ff3b30` | `#ff6b6b` |
| `scheduled` | `#fff8e1` | `#ff9500` **dashed** | `#e65100` |
| `scheduled` + locked | `#fff8e1` | `#ff9500` **solid** | `#e65100` |
| `live` | `#4a1a1a` | `#ff3b30` | `#ff6b6b` |
| `done` | `#1a3a1a` | `#34c759` | `#4cfaaa` |
| live band | `#4a1a1a` | `#ff3b30` | `#ff6b6b` |
| ad group scheduled | `#16283f` | `#5ac8fa` | `#8ecdfa` |
| ad group locked | `#3a3010` | `#ffcc00` | `#ffe082` |

Status badges: COMPLETED `#34c759` · PLAYING `#007aff` · PENDING `#ff9500` · FAILED `#ff3b30`.

## B.17 Accessibility

| ID | Requirement |
|---|---|
| FR-A11-01 | Timeline blocks reachable by keyboard; arrows move selection, `Enter` opens the inspector |
| FR-A11-02 | Focus visible on all interactive elements; focus trap in modals; focus restored on close |
| FR-A11-03 | Status conveyed by **text in addition to colour** |
| FR-A11-04 | ARIA roles for tabs, dialogs, menus; `aria-live` for toasts |
| FR-A11-05 | Contrast ≥ 4.5:1 for text in **both** themes |
| FR-A11-06 | **Full keyboard alternative to every drag interaction** |
| FR-A11-07 | Reduced-motion honoured |

A drag-only timeline is an accessibility failure. Every move and resize must have a keyboard path
through the inspector at minimum.

## B.18 Error handling and forms

| ID | Requirement |
|---|---|
| FR-ERR-01 | Typed API client mapping HTTP status → user-facing message + machine code |
| FR-ERR-02 | Handle every engine error code (see the registry below) |
| FR-ERR-03 | Error boundary at shell, tab and widget level |
| FR-ERR-04 | 404 page and 403 page |
| FR-ERR-05 | Global unhandled-error reporting (Sentry-compatible hook) |

| ID | Requirement |
|---|---|
| FR-FRM-01 | Schema-validated forms (Zod) with inline field errors |
| FR-FRM-02 | `YYYY-MM-DD HH:MM:SS` input with a channel-timezone helper and date-time picker |
| FR-FRM-03 | Unsaved-changes guard on route change |
| FR-FRM-04 | Username availability checked asynchronously with debounce |
| FR-FRM-05 | Profile image preview before upload; client-side size/type validation |
| FR-FRM-06 | Decimal squeeze fields entered as normalised fractions with 0–1 validation |
| FR-FRM-07 | Squeeze fields offer a pixel equivalent (1920×1080) as a **display convenience only** |

### Error code registry (frontend must handle all of these)

| Code | HTTP | UI behaviour |
|---|---|---|
| `PASSWORD_CHANGE_REQUIRED` | 403 | Route to change-password |
| `OVERLAP` | 409 | Name the conflicting items |
| `IN_PAST` | 409 | Refuse the drop |
| `LOCKED` | 409 | Disable controls, reload |
| `ON_AIR` | 409 | Refuse |
| `MEDIA_INACTIVE` | 409 | Exclude from the picker |
| `TEMPLATE_MISSING` | 409 | Flag incomplete |
| `LANE_TYPE_MISMATCH` | 409 | Show the pairing rule |
| `END_TIME_REQUIRED` | 409 | Prompt for an end |
| `END_BEFORE_START` | 409 | Show both values |
| `VERSION_MISMATCH` | 409 | Conflict banner + reload |
| `AGENT_UNREACHABLE` | 504 | Banner + retry |
| `AGENT_PROTOCOL_ERROR` | 422 | Banner + retry |
| `IDEMPOTENCY_CONFLICT` | 409 | Reject |
| `RATE_LIMITED` | 429 | Countdown |

## B.19 Frontend phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **F0** | Vite + TS strict + Tailwind + tokens + design system components + typed API client generated from `openapi.yaml` | Lint, type-check, unit tests, a11y harness green |
| **F1** | App shell, routing, route guards, login, forced password change, OTP reset, toasts, error boundaries | WF-01…WF-03 pass |
| **F2** | Scheduler: toolbar, ruler, channel rows, five lanes, clip rendering, **virtualisation** | SC-3 met on a synthetic 5 000-clip dataset |
| **F3** | Drag: pan, move, resize, snap, Escape cancel, optimistic update + rollback, conflict banner | WF-16, WF-17 pass |
| **F4** | Media picker, chain modal, `chain-preview` grouping, context menu, inspector | WF-12…WF-15, WF-18 pass |
| **F5** | Navigator: scan, tables, bulk activate/deactivate, bulk template assign, error banners | WF-06…WF-11 pass |
| **F6** | Execution Log + XLSX export; System tab + reinit controls | WF-25, WF-24 pass |
| **F7** | Realtime SSE client, 30 s polling fallback, lock watcher, dark theme, full a11y pass, load test | FR-A11-01…07 pass; SC-3 held under realtime load |

### B.19.1 Frontend Definition of Done

- [ ] Strict TypeScript, zero `any` in feature code
- [ ] No `innerHTML`, no runtime template strings, no `eval`, no inline event handlers
- [ ] CSP-clean: builds and runs with `script-src 'self'` and a nonce, no `unsafe-inline`
- [ ] 60 fps pan and drag at 8 channels × 5 000 clips, measured in CI, not asserted from memory
- [ ] Full keyboard path for every drag interaction
- [ ] All 15 error codes mapped to distinct user-facing handling
- [ ] Realtime optional: the app is fully functional with the SSE channel blocked
- [ ] Viewport survives a reload
- [ ] Zero occurrences of "StreamX" / "IngestX" / "Aranya" in the bundle (CI grep)
- [ ] Vitest unit + component tests and Playwright E2E covering WF-01…WF-25
- [ ] Axe accessibility scan clean on every route in both themes

---

## 5. Integrated delivery plan

### 5.1 Sequencing

```
Backend P0 ──┬─► P1 (frozen engine API) ──► 24 h unmodified-agent soak
             │        ▲
             │        │  contract tests + golden files are the gate
             │
             └─► P2 (bridge) ──► P3 (writes) ──► P6 (admin & auth)
                              │                    ▲
                              ▼                    │
Frontend F0 ──► F1 (shell/auth) ──► F2 (scheduler) ──► F3 (drag)
                                                       │
                                                       ▼
                                            F4 (picker/chain/inspector)
                                                       │
                    ┌──────────────────────────────────┤
                    ▼                                  ▼
             F5 (navigator)                   F6 (execlog/system)
                    └──────────────────────────────────┤
                                                       ▼
                                            F7 (realtime/a11y/perf)
                                                       │
                                                       ▼
                                                P8 hardening & sign-off
```

### 5.2 Collaboration rules

| # | Rule |
|---|---|
| 1 | **`Backend/openapi.yaml` is the contract.** It is committed and CI drift-checked. The frontend's types are **generated** from it — never hand-written |
| 2 | A frontend PR that needs a new endpoint opens an issue against `Backend` first. No speculative fields on the frontend |
| 3 | The frontend never calls `/api/` (the frozen engine API). That is backend-internal to the agent |
| 4 | Realtime event payloads are frozen once shipped. Additions are optional fields only |
| 5 | The branding sweep and the contract tests run in **both** repos' CI |
| 6 | A change to a `TRON_*` serializer requires sign-off from whoever owns the playout server |

### 5.3 Test environment for the frontend

E2E tests need a real backend. Three modes, in increasing fidelity:

1. **Mock** — MSW handlers serving fixture JSON. Fast, default for PRs.
2. **Integration** — a live Backend instance with seeded data and a **fake agent** WS server.
   Used for the parity suites.
3. **Staging** — a live Backend pointed at a real CasparCG. Manual, pre-release only. Used for
   WF-19…WF-22 verification.

---

## 6. Migration and cutover

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0 — Foundation** | Project, apps, migrations, settings, CI, health checks | Migrations apply cleanly; CI green |
| **P1 — Read-only parity** | Engine API + all GET browser endpoints from migrated data | Contract tests pass; **agent runs unmodified 24 h** |
| **P2 — Agent cutover** | Bridge; agent points at the new API | Live push working; upsert reaches agent < 1 s |
| **P3 — Writes** | Schedule CRUD, media scan, templates, pipelines | Operator can schedule via API; agent executes correctly |
| **P4/P5/P6/P7** | Frontend and admin phases (Part B) | As listed above |
| **P8 — Hardening** | Security review, load test, DR drill, runbook | SC-1…SC-7 all met |

**Parallel-run policy**

- The legacy system stays up through P7. Both systems point at **different** databases.
- Only **one** may be the agent's `API_BASE` at a time. Switch during a scheduled maintenance
  window, after a dry-run of the agent's `GET /pipelines/` and `GET /schedule/` against the new API.
- **Rollback = repoint `API_BASE` to the legacy host.** No data is lost, because pushes are
  regenerable from the new DB and the agent holds its own working set.
- The legacy database is **never** deleted or modified until sign-off.

---

## 7. Degradation behaviour (WF-27)

| Scenario | Required behaviour |
|---|---|
| Agent not running | Pipeline shows **Offline**. Media scan → `504`. Schedule writes **still succeed** and queue. Reinit reports `delivery:"deferred"` |
| CasparCG down | Agent cannot execute; events stay `PENDING`. UI shows last-known status |
| Django down | Agent continues executing from its in-memory schedule; status PATCHes fail and are dropped (agent has `timeout=5`, **no retry**). Pushes resume when Django returns |
| Network partition, agent side | Agent's WS drops; the 300 s resync reconciles automatically |
| Concurrent operator edit | Optimistic concurrency via `version`; the loser gets `409 VERSION_MISMATCH`; the SPA reloads that item |
| WebSocket push lost | Caught by the 300 s resync |
| SSE to browser lost | 30 s polling fallback keeps the UI correct; quiet indicator shown |

**No scenario may cause silent data loss. The SPA must always communicate agent state honestly.**

---

## 8. Risk register

| # | Risk | Blast radius | Mitigation |
|---|---|---|---|
| R-1 | `runv5.py` breaks on a wire-format change | **Total playout outage** | Frozen `engine_api` app, golden files, CT-1…CT-10 blocking, serializer fingerprint, 24 h soak before cutover |
| R-2 | `PLAYING` can stick forever | Operational confusion about what is on air | Heartbeat + agent state surfaced in UI; reaper available but **default-off** |
| R-3 | TRON endpoints are `AllowAny` in legacy | Anyone can mark events PLAYING or inject fake logs | Per-`Server` tokens, `ENGINE_AUTH_MODE`, permissive→enforcing switch with no downtime |
| R-4 | Whole-channel `route://2` is load-bearing | Reverting it silently kills DOG/BUG/TICKER | Documented prominently; asserted in tests; change requires explicit sign-off |
| R-5 | Destructive media sync | Deleting a file wipes its row and `SET_NULL`s any schedule row pointing at it | Confirmation before scan; scan diff surfaced in the UI; reconciliation report |
| R-6 | CG rows created with `template=NULL` | They fail validation on the next save | Bulk-assign UI + incomplete flagging + disabled-in-picker |
| R-7 | Decimal-as-string JSON | Silent type bugs in every consumer | Frozen strings for the agent; typed client for the browser API; fingerprint test |
| R-8 | `/api/schedule/` must stay unpaginated | Engine indexes the response directly | Separate app, no global pagination class, CT-2 |
| R-9 | O(channels) full re-render per mouse pixel | Timeline unusable at 8+ channels | Virtualisation, rAF throttling, geometry from state — PF-3 gates this |
| R-10 | SQLite in the legacy system | Lock contention the moment a second box reports | PostgreSQL 16 from day one |
| R-11 | XSS via media titles (from filenames) | Operator session compromise | React escaping, no `innerHTML`, CSP, SE-4 test |
| R-12 | Two-repo drift on the API contract | Frontend and backend disagree at runtime | Generated client from a committed, CI-checked `openapi.yaml` |
| R-13 | Scope creep into "improvements" | Behaviour divergence from the frozen agent | L-1…L-5 are written down; any change needs engine-contract sign-off |
| R-14 | Bridge pushes lost on restart | Stale agent working set | Durable queue + retry table; drained at startup |

---

## 9. Deliverables

| # | Deliverable | Repo |
|---|---|---|
| D-1 | Django REST API source, migrations, admin | Backend |
| D-2 | Engine bridge service + supervisor config | Backend |
| D-3 | React SPA source with unit, component and E2E tests | Frontend |
| D-4 | OpenAPI 3.1 specification (CI-verified) | Backend |
| D-5 | Contract-test suite for the frozen engine API | Backend |
| D-6 | Data migration tool with dry-run and reconciliation report | Backend |
| D-7 | Deployment manifests (systemd / Docker Compose), secrets template | Backend |
| D-8 | Runbooks: agent onboarding, reinit playbook, rollback, DR restore | Backend |
| D-9 | Security design document + phased engine plan | Backend |
| D-10 | Operator training guide + UI-parity checklist | Frontend |

---

## 10. Open decisions

These need an answer before the phase that depends on them starts.

| # | Decision | Needed by | Default if unanswered |
|---|---|---|---|
| D-1 | How is the SPA served — Django-served bundle, or a CDN/static host? | F0 | Django serves a pinned build artefact from the frontend repo |
| D-2 | Realtime transport: SSE or WebSocket for `/realtime/stream`? | F7 | **SSE** — simpler reconnect, works through proxies, matches `Last-Event-ID` resync |
| D-3 | Durable queue: Redis pub/sub, or PostgreSQL `LISTEN/NOTIFY` + retry table? | P2 | PostgreSQL `LISTEN/NOTIFY` — one fewer moving part; Redis marked optional |
| D-4 | Does the frontend repo generate its types in CI, or commit the generated output? | F0 | Commit the generated output, verify in CI that it matches the schema |
| D-5 | Who signs off on a change to a `TRON_*` serializer? | P0 | Named playout-server owner; no change merges without it |
| D-6 | `LOCK_WINDOW_MS` tolerance — server default 30 000 ms confirmed for production? | P3 | 30 000 ms, configurable by env |
| D-7 | Are the "force end" controls (C-14…C-16) surfaced in phase 1 even though they need no agent change? | F7 | Surface them; the agent already implements them |
| D-8 | Retained limitation L-3 (derived chain membership) — keep, or start storing chains? | — | **Keep derived.** Storing chains is a phase-2 proposal and changes the agent contract |

---

## 11. Traceability

| This plan | Source |
|---|---|
| Architecture, principles, contracts A-4 | SRS §5, §7, §12.2, §12.3 |
| Domain model A.2 | SRS §7; Spec Part 1 |
| Validation rules A.2.6 | SRS §7.5; Spec Part 2 |
| Chain grouping A.2.7 | Spec §2.2, §4.5 |
| Media scanning A.3.2 | SRS WF-06, BR-SCAN; Spec Part 3 |
| Engine bridge A.5 | SRS BR-BRG, WF-23; Spec §5.2 |
| Browser API A.3 | SRS §12.1, WF-01…WF-25 |
| Reporting A.3.2 | SRS BR-RPT, WF-25; Spec §6.2 |
| Auth / RBAC A.3.2 | SRS BR-AUTH, BR-PWD, BR-USR, BR-ROLE; Spec Part 7 |
| Security A.6 | SRS §16, BR-SEC; Spec Part 10 |
| Frontend B.3…B.11 | SRS §11, WF-12…WF-25; Spec Part 8 |
| Durations and timing constants A.2.3, B.5 | Spec §1.3.1, §4.2, §8.6, §8.9 |
| Status palette B.16 | Spec §8.10; SRS §11.15 |
| Error registry B.18 | SRS Appendix B |
| Risks §8 | Spec Part 10; SRS §3.3 |

---

## 12. Glossary

| Term | Meaning |
|---|---|
| **Agent** | The PyQt5 playout process, `TaskQue/runv5.py`. **Not modified.** |
| **TRON API** | The frozen, engine-facing API family at `/api/` |
| **Pipeline** | One on-air output channel = CasparCG ch1 + ch2 buffer pair + three stream URLs |
| **Schedule event** | A single timed instruction. **A start, not a block** — it has no duration |
| **Ad break / chain** | A run of consecutive `FILE` events with one synthetic route-back. **Derived, never stored** |
| **Timed graphic** | CG whose length is fixed by its GraphicsTemplate |
| **Held graphic** | DOG / BUG / TICKER, held between `scheduled_time` and `end_time` |
| **Lane** | A horizontal track: `FILE`, `CG`, `DOG`, `BUG`, `TICKER` |
| **Lock window** | The 30 s before `scheduled_time` during which an event is read-only |
| **Live band** | The always-on programme background on the main lane. Not a timed event |
| **Tesseract** | The legacy second-factor token returned by OTP verification and consumed by password reset |
| **Frozen contract** | A wire format the unmodified agent depends on; changing it breaks playout |
| **Push frame** | A single JSON message Django sends over the agent's WebSocket |

---

*End of plan. Companion documents: `PLYOUT_REQUIREMENTS.md` (SRS-PLYOUT-001), `PLYOUT_SPECIFICATION.md`.*
