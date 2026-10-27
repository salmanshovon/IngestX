/**
 * Starting / stopping a recording from the UI.
 *
 * The scheduler and the channel's Start Record button both need the same two
 * rules, so they live here rather than being written twice:
 *
 * 1. A recording that starts now runs for the default length.
 * 2. If the next scheduled item is closer than that, it is compressed to end
 *    `RECORD_GAP_MS` before it. A recording never pushes another one aside.
 */

import type { ScheduleEvent } from '@/api/types'
import { DEFAULT_RECORD_MS, MIN_RECORD_MS, RECORD_GAP_MS } from '@/config'
import { api } from '@/lib/api-client'
import { eventStartMs, isLiveAt } from '@/lib/timeline'

/** Where the recorder writes. Mirrors the schedule modal's fixed location. */
const RECORD_FILEPATH = 'ITV-SAN-FTP'

/** `BTI_YYYYMMDD_HHMMSS_` for the moment a recording starts. */
export function recordingPrefix(ms: number): string {
  const d = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const hms = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `BTI_${ymd}_${hms}_`
}

/** Everything after the timestamp prefix, so a duplicate keeps its identity. */
export function recordingSuffix(filename: string): string {
  const match = (filename || '').match(/^BTI_\d{8}_\d{6}_(.*)$/)
  return match ? match[1] : filename || 'recording'
}

/** Earliest scheduled recording on `pipelineId` that starts after `afterMs`. */
export function nextScheduledStart(
  events: readonly ScheduleEvent[],
  pipelineId: number,
  afterMs: number,
): number | null {
  let best: number | null = null
  for (const event of events) {
    if (event.pipeline !== pipelineId) continue
    if (event.action_type !== 'RECORD') continue
    if (event.status === 'CANCELLED') continue
    const start = eventStartMs(event)
    if (start <= afterMs) continue
    if (best === null || start < best) best = start
  }
  return best
}

export interface ImmediateRecordingPlan {
  startMs: number
  endMs: number
}

export type ImmediateRecordingResult = ImmediateRecordingPlan | { error: string }

/**
 * Default slot length, from the `RecordingSetting` minutes value.
 *
 * Settings owns the number; the constant in `config.ts` is only the fallback
 * for the moment before the setting has loaded (or if the request fails).
 */
export function defaultRecordMsFromMinutes(minutes: number | null | undefined): number {
  return Math.max(1, minutes ?? DEFAULT_RECORD_MS / 60_000) * 60_000
}

/**
 * Work out the window for a recording that starts now.
 *
 * `nextStartMs` is the next scheduled item's start, if any. When the default
 * duration would reach into it, the end is pulled back to leave ten seconds.
 */
export function planImmediateRecording(
  nextStartMs: number | null,
  nowMs: number = Date.now(),
  defaultDurationMs: number = DEFAULT_RECORD_MS,
): ImmediateRecordingResult {
  const startMs = nowMs
  const preferredEnd = startMs + defaultDurationMs
  const endMs =
    nextStartMs === null ? preferredEnd : Math.min(preferredEnd, nextStartMs - RECORD_GAP_MS)

  if (endMs - startMs < MIN_RECORD_MS) {
    return {
      error: 'The next scheduled item starts too soon — leave at least 10 seconds clear.',
    }
  }

  return { startMs, endMs }
}

/** Start a recording on `pipelineId` at once, clamped to the next item. */
export async function startImmediateRecording(input: {
  pipelineId: number
  suffix: string
  nextStartMs: number | null
  nowMs?: number
  /** `RecordingSetting.default_duration_minutes` in ms; defaults to 30 min. */
  defaultDurationMs?: number
}): Promise<{ id: number | null; endMs: number } | { error: string }> {
  const plan = planImmediateRecording(input.nextStartMs, input.nowMs, input.defaultDurationMs)
  if ('error' in plan) return plan

  const response = await api.post<{ task_data?: { id?: number } }>('/start_record/', {
    port: input.pipelineId,
    filename: `${recordingPrefix(plan.startMs)}${input.suffix}`,
    filepath: RECORD_FILEPATH,
    start_time: new Date(plan.startMs).toISOString(),
    end_time: new Date(plan.endMs).toISOString(),
    status: 'RECORDING',
  })

  return { id: response?.task_data?.id ?? null, endMs: plan.endMs }
}

/** Stop an in-progress recording now. */
export async function stopRecordingNow(id: number): Promise<void> {
  await api.post('/stop_record/', { id, end_time: new Date().toISOString() })
}

/**
 * How long a recording has been running at `nowMs`.
 *
 * Clamped at zero so a click a fraction of a second before the scheduled start
 * does not report a negative elapsed time.
 */
export function recordingElapsedMs(event: ScheduleEvent, nowMs: number): number {
  return Math.max(0, nowMs - eventStartMs(event))
}

/**
 * Can this recording be stopped yet?
 *
 * The engine refuses to finalise a file shorter than {@link MIN_RECORD_MS}, so
 * a stop inside the first ten seconds would either be dropped or leave a
 * zero-length artefact. Hide the action until it is meaningful rather than
 * offering a button that always fails.
 */
export function canStopRecording(event: ScheduleEvent, nowMs: number): boolean {
  return isLiveAt(event, nowMs) && recordingElapsedMs(event, nowMs) >= MIN_RECORD_MS
}

/** Milliseconds until the stop action becomes legal. */
export function recordingStopInMs(event: ScheduleEvent, nowMs: number): number {
  return Math.max(0, MIN_RECORD_MS - recordingElapsedMs(event, nowMs))
}
