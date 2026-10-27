# PlyOut — Frontend

React 18+/TypeScript single-page application for the **PlyOut** broadcast playout
control plane. It is the operator console for a single commercial TV channel: it
authors the schedule, maintains the media library, reports what actually went to
air, and controls the playout agent.

It talks only to the Django **browser API** at `/api/v1/`. The frozen engine API
at `/api/` is a machine contract for the PyQt5 playout agent and is deliberately
never called from here.

---

## Quick start

```bash
# 1. backend (in ../Backend)
python manage.py migrate
python manage.py bootstrap_roles
python manage.py seed_demo            # optional demo dataset
python manage.py bootstrap_admin --username admin --email admin@example.com --password '…'
python manage.py runserver 127.0.0.1:8000

# 2. frontend
npm install
npm run dev                           # http://localhost:5173
```

Sign in with **your username** (`admin`), not your email.

Other scripts: `npm run build` (typecheck + production bundle), `npm run typecheck`,
`npm run lint`.

---

## The same-origin requirement

The SPA talks to Django on the **same origin**, via the dev proxy in
`vite.config.ts`:

```ts
server: { proxy: { '/api': { target: 'http://127.0.0.1:8000' } } }
```

This is not a convenience. The backend sets `SESSION_COOKIE_SAMESITE = "Lax"`,
and `localhost:5173` vs `127.0.0.1:8000` are *different sites* to a browser — a
direct cross-site XHR would have its session cookie dropped and every
authenticated call would 401. Proxying keeps the browser on one origin, which is
also how production serves the SPA, so dev and prod behave identically.

If you genuinely need to serve the SPA from another host, set
`VITE_API_BASE_URL` **and** add that origin to `CORS_ALLOWED_ORIGINS` on the
backend.

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | `''` (same origin) | Absolute API origin |
| `VITE_DEV_PROXY_TARGET` | `http://127.0.0.1:8000` | Dev proxy target |
| `VITE_CHANNEL_TIMEZONE` | `Asia/Dhaka` | Broadcast timezone |
| `VITE_PORT` | `5173` | Dev server port |

---

## Stack

| Concern | Choice | Why |
|---|---|---|
| Build | Vite 8 + TypeScript (strict) | Fast HMR; `paths` + Vite `alias` kept in step |
| UI runtime | React 19 | |
| Server state | TanStack Query 5 | Cache, stale times, mutations, invalidation |
| UI state | Zustand 5 | Viewport, selection, preferences — **only** |
| Routing | React Router 6 | |
| Components | Radix primitives + Tailwind 4 | Headless behaviour, styled by us |
| Icons | lucide-react | |
| Dates | `Intl` via the channel timezone | Avoids a second timezone library for what `Intl` does correctly |
| Forms | react-hook-form + Zod | Schema validation with inline errors |

`@radix-ui/react-toast` was deliberately **dropped**: its provider/viewport
collection failed to render in practice, and a control room cannot afford
notifications that silently fail to appear. `components/ui/toaster.tsx` is a
~150-line accessible replacement (`role="status"`, `aria-live="polite"`,
auto-dismiss that pauses on hover/focus).

---

## Layout

```
src/
  config.ts              Product name, API base, channel timezone — the single
                         source for every one of those values (FR-SH-12)
  api/
    types.ts             Wire types for /api/v1/
    api-client.ts        Typed fetch: session cookie, CSRF, ApiError + codes
    accounts.ts          auth / users / roles / departments
    playout.ts           servers / pipelines / media / templates / schedule
    reports.ts           as-run report + CSV export
  lib/
    format.ts            Time, duration and number formatting
    timeline.ts          Pure timeline geometry + ad-chain grouping
    cn.ts                Tailwind-aware class merge
  hooks/
    use-auth.tsx         Session, permissions, 401 broadcast
    use-now.ts           One shared 1 Hz clock
    use-realtime.ts      SSE consumer (optional, with polling fallback)
    use-playout-data.ts  Query/mutation bindings
    use-timeline-drag.ts  Pointer drag / pan / resize state machine
  stores/
    ui-store.ts          Viewport, selection, now mode, theme (persisted)
    notification-store.ts Toasts and banners
  components/
    ui/                  Button, Input, Select, Checkbox, Modal, Toaster,
                         Table, Badge, Tooltip, Spinner, EmptyState…
    layout/              AppShell, TopBar, ErrorBoundary, Logo
    schedule/            Timeline, Clip, Inspector, MediaPicker, ChainModal,
                         LaneContextMenu, TimelineToolbar, StatusFooter
  pages/                 One file per route
```

---

## Design decisions worth knowing

### The timeline is arithmetic, never measurement

A clip's `left`/`width` are **fractions of the viewport**, not pixel values read
from the DOM. A pan is one store write; a drag mutates one number. That is what
keeps the timeline at 60fps with hundreds of clips (SC-3), and it is why
`lib/timeline.ts` is a pure module with no React in it.

Horizontal panning is **state, not `scrollLeft`**. The lane area always fills the
viewport exactly and only vertical scrolling uses native overflow, which keeps
the sticky label column and sticky ruler trivially in sync.

### An event is a START, not a block

There is no duration column anywhere. A FILE item's length is its media item's
`duration_seconds`; a CG's is its template's; only held lanes (DOG/BUG/TICKER)
carry an `end_time`. The UI derives `endMs` and **never writes a duration** — the
inspector shows it read-only behind a padlock.

### Ad breaks are grouped, not stored

A break is a *derived* run of consecutive FILE events, recomputed on every read.
Grouping is **end-to-start with a 1s tolerance**, matching the agent exactly:
three 20s commercials at 10:00:00 / 10:00:20 / 10:00:40 are **one** break that
airs once and routes back once. Getting this wrong makes the UI disagree with
what actually airs, which is worse than showing nothing.

### Server state vs UI state

React Query owns everything the server owns. Zustand owns only what the browser
owns: viewport, selection, panel state, theme. No component keeps an
authoritative local copy of schedule data — the timeline renders from the cache
on every frame, and a drag shows a *preview overlay* rather than a private copy.

### Realtime is optional

SSE (`/api/v1/realtime/stream`) drives invalidations, but the schedule is
**polled every 30s regardless**. If the stream never connects the console is
still correct; it just shows a quiet "Polling" indicator. The channel is a
latency optimisation, never a dependency.

### Errors branch on codes, not prose

The API returns `{detail, code}`. `ApiError` carries a typed `code`, and the
scheduler maps engine codes (`LOCKED`, `ON_AIR`, `OVERLAP`, `IN_PAST`,
`TEMPLATE_MISSING`, `LANE_TYPE_MISMATCH`, `AGENT_UNREACHABLE`,
`VERSION_MISMATCH`, …) to operator-readable messages. A failed schedule write
says *why* and what to do about it.

### The stream strings are shown verbatim

`stream_source_url` / `output_destination_url` / `preview_stream_url` are **not
URLs**. They are raw CasparCG/ffmpeg argument strings interpolated into AMCP
commands with no quoting. The System tab renders them as read-only monospace and
never trims, pretty-prints or "fixes" them.

### Media sync is destructive

A file deleted from the agent's disk deletes its `MediaItem` row, and every
`ScheduleEvent` referencing it keeps a `NULL` media item. Such an event has no
title and no duration, so it is rendered with a dotted `Missing media` block at a
minimum width — otherwise it would collapse to an invisible sliver the operator
could not select or delete.

---

## Keyboard

| Key | Action |
|---|---|
| `+` / `-` | Zoom in / out |
| `←` / `→` | Shift the viewport ∓6 h |
| `n` | Jump to now |
| `p` | Toggle now mode (follow ⇄ pinned) |
| `i` | Toggle the inspector |
| `Esc` | Clear selection, or cancel an in-flight drag |

Now mode **Following** auto-centres on the clock and disables drag and the lane
context menu (with an explanatory toast). **Pinned** enables editing.

---

## Accessibility

Status is conveyed by text as well as colour. Dialogs trap focus and restore it on
close. Toasts announce through `aria-live`. Every drag has a keyboard alternative
(arrow keys to pan, `+`/`-` to zoom, inspector to retime). `prefers-reduced-motion`
is honoured. Both themes meet 4.5:1 for body text.

---

## Theming

All colour, spacing and elevation is a CSS custom property in `src/index.css`.
The clip status palette is preserved **verbatim** from the legacy operator UI —
operators are trained on those exact colours, and "slightly different amber" is a
support call. Dark is the default (control rooms are dark); the choice persists
to `localStorage` and is applied pre-paint so a reload never flashes.

> Note: the raw elevation values are named `--elevation-*`, not `--shadow-*`.
> Tailwind resolves the `shadow-lg` utility against the `--shadow-*` namespace,
> so reusing it for the raw token would make the utility point at itself.

---

## Known limitations

- **Preview player** renders `preview_embed_url` in an iframe. If that URL is not
  configured the button is hidden.
- **Role-based navigation** hides links the current account cannot use, but the
  pages themselves rely on server-side permission checks; there is no client-side
  route guard per permission beyond that.
- **Schedule window** is the last 3 days → all future, matching the API. A week
  of history is only reachable through the Execution Log's date filters.