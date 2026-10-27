/**
 * Single source of product configuration (FR-SH-12).
 *
 * Nothing in the UI may hard-code the product name. The spec is explicit that
 * the legacy "StreamX" / "IngestX" branding is vestigial and must not surface
 * anywhere; keeping the name in one place makes that auditable.
 */

export const PRODUCT_NAME = 'IngestX'

export const PRODUCT_TAGLINE = 'Playout control plane'

/**
 * Channel timezone. The broadcast day is Asia/Dhaka (UTC+06:00) regardless of
 * where the operator sits -- an ad break at 20:00 means 20:00 Dhaka time.
 *
 * `null` means "use the browser's zone", which is the right behaviour for a
 * demo box but wrong for a real channel. Override with VITE_CHANNEL_TIMEZONE.
 */
export const CHANNEL_TIMEZONE: string =
  (import.meta.env.VITE_CHANNEL_TIMEZONE as string | undefined) ?? 'Asia/Dhaka'

/**
 * API base.
 *
 * Empty string = same origin, which is what the dev proxy and every production
 * deployment use. See vite.config.ts for why a same-origin proxy is required
 * rather than merely convenient.
 */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''

export const API_PREFIX = `${API_BASE}/api`
/** Fallback poll cadence when the realtime stream is unavailable (FR-RT-02). */
export const SCHEDULE_POLL_MS = 30_000

/** Server lock window, mirrored so the UI can pre-empt it (FR-RT-04). */
export const LOCK_WINDOW_MS = 30_000

/** Lock window as an ISO-ish duration string for display. */
export const LOCK_WINDOW_LABEL = '30s'

/**
 * Default length for a newly placed held graphic (DOG / BUG).
 *
 * Two minutes is a slot, not a day. These were created with an explicit
 * one-hour end, which put a screen-filling block on the channel for an hour
 * because somebody double-clicked a lane. TICKER is excluded on purpose: a
 * scrolling ticker legitimately stays up for as long as the show runs.
 */
export const HELD_DEFAULT_MS = 2 * 60_000

/**
 * Default length for a new / immediate recording.
 *
 * Matches the backend's `RecordingSetting.default_duration_minutes` fallback
 * (30). A recording is compressed to fit before the next scheduled item, never
 * expanded, and always keeps `RECORD_GAP_MS` clear of it.
 */
export const DEFAULT_RECORD_MS = 30 * 60_000

/** Minimum clearance between a recording and the next scheduled item. */
export const RECORD_GAP_MS = 10_000

/** The backend refuses recordings shorter than this. */
export const MIN_RECORD_MS = 10_000

/**
 * How close to its start an item must be before it stops being deletable.
 *
 * At this point the item is queued for the recorder and deleting it would race
 * the engine. It is not yet live, so it cannot be stopped either -- the only
 * safe answer is "no". Mirrors `DELETE_CUTOFF` in the API.
 */
export const DELETE_CUTOFF_MS = 15_000

/** Chain grouping tolerance. Must match CHAIN_GAP_SECONDS server-side. */
export const CHAIN_GAP_SECONDS = 1.0

export const REALTIME_PATH = '/ws/realtime/'