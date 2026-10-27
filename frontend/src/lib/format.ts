import type { AgentState, MediaLane, MediaType, ScheduleStatus } from '@/api/types'

/**
 * Query key factory (FR-ST-01).
 *
 * Every key is built here so an invalidation can never drift from the key that
 * populated the cache -- the classic source of "the list did not refresh" bugs.
 */
export const queryKeys = {
  session: ['session'] as const,

  servers: ['servers'] as const,
  serverState: (id: number) => ['servers', id, 'state'] as const,
  serverEngineToken: (id: number) => ['servers', id, 'token'] as const,

  pipelines: (serverId?: number) => ['pipelines', serverId ?? 'all'] as const,
  pipeline: (id: number) => ['pipelines', 'detail', id] as const,

  media: (serverId?: number) => ['media', serverId ?? 'all'] as const,

  templates: ['templates'] as const,

  schedules: (pipelineId?: number) => ['schedules', pipelineId ?? 'all'] as const,
  chainPreview: (pipelineId: number) => ['chain-preview', pipelineId] as const,

  deliveries: (serverId?: number) => ['deliveries', serverId ?? 'all'] as const,

  report: (key: unknown[]) => ['report', ...key] as const,

  users: (params: unknown) => ['users', params] as const,
  roles: ['roles'] as const,
  roleMatrix: ['roles', 'permissions'] as const,
  departments: ['departments'] as const,
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** `01:02:03` style. Used for clock and lane headers. */
export function formatClock(iso: string, timezone: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

/** `20:00:36` for the tick strip -- drops the date when it is today's. */
export function formatTime(iso: string, timezone: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

export function formatDate(iso: string, timezone: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

export function formatDateTime(iso: string, timezone: string): string {
  if (!iso) return '—'
  return `${formatDate(iso, timezone)} ${formatTime(iso, timezone)}`
}

/** `14 Oct 2026, 20:00:36` -- for tooltips and detail rows. */
export function formatFull(iso: string | null, timezone: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

/** `hh:mm:ss.mmm` -- the as-run report format (FR-XL-06). */
export function formatDurationHhmmssmmm(seconds: number | string | null | undefined): string {
  const total = toNumber(seconds)
  if (total === null) return '—'
  const sign = total < 0 ? '-' : ''
  const ms = Math.abs(Math.round(total * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const milli = ms % 1000
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)}.${pad(milli, 3)}`
}

/** Compact clip width labels: `4.2s`, `1m 05s`, `2h 10m`. */
export function formatShortDuration(seconds: number | string | null | undefined): string {
  const total = toNumber(seconds)
  if (total === null) return '—'
  if (total < 1) return `${Math.round(total * 1000)}ms`
  if (total < 60) return `${total.toFixed(1)}s`
  // Round to whole seconds BEFORE splitting into minutes, otherwise 2399.99s
  // prints as "39m 60s" instead of "40m 00s".
  const wholeSeconds = Math.round(total)
  const minutes = Math.floor(wholeSeconds / 60)
  const remainder = wholeSeconds % 60
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * Decimals arrive as strings. `Number('')` is 0, which would silently turn a
 * missing duration into "0s" -- so anything unparseable becomes null and the
 * caller renders an em dash.
 */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** `FILE_`/`CG_`/`SCG_` are transport prefixes; the UI strips them (FR-CL-07). */
export function displayTitle(title: string): string {
  return (title ?? '').replace(/^(FILE_|CG_|SCG_)/, '')
}

export function mediaTypeLabel(type: MediaType | ''): string {
  switch (type) {
    case 'FILE':
      return 'Commercial'
    case 'CG':
      return 'Graphics'
    case 'SCG':
      return 'Standing CG'
    default:
      return '—'
  }
}

export const LANE_LABEL: Record<MediaLane, string> = {
  FILE: 'Record',
  CG: 'DVE',
  DOG: 'Dog',
  BUG: 'Bug',
  TICKER: 'Ticker',
}

export const STATUS_LABEL: Record<ScheduleStatus, string> = {
  PENDING: 'Pending',
  PLAYING: 'On air',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
}

export const STATUS_TONE: Record<ScheduleStatus, 'ok' | 'accent' | 'warn' | 'danger' | 'muted'> = {
  PENDING: 'warn',
  PLAYING: 'accent',
  COMPLETED: 'ok',
  FAILED: 'danger',
  CANCELLED: 'muted',
}

export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  online: 'Online',
  stale: 'Stale',
  offline: 'Offline',
}

export function fileExtension(path: string): string {
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase()
}

/** Byte size for the media library table. */
export function formatRelativeTime(iso: string | null, timezone: string): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'never'
  const deltaSeconds = Math.round((Date.now() - then) / 1000)
  if (deltaSeconds < 5) return 'just now'
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`
  const minutes = Math.floor(deltaSeconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return formatDateTime(iso, timezone)
}

/**
 * Strip path separators and control characters before building a download
 * name. Without this a pipeline called "../../etc/passwd" would let the browser
 * choose where the file lands.
 */
export function sanitiseFilename(value: string): string {
  return (
    value
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '_')
      .replace(/^[.-]+/, '')
      .slice(0, 80) || 'asrun'
  )
}