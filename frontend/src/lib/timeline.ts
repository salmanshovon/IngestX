/**
 * Timeline geometry.
 *
 * The whole scheduler is a pure function of `(viewport, event)`. Nothing here
 * reads or writes the DOM. That is what makes 60fps dragging possible with
 * thousands of clips: a drag mutates one number in the Zustand viewport store
 * and React re-renders from the same arithmetic, with no measurement in the
 * hot path (FR-ST-03).
 *
 * Two rules from the legacy system are encoded here and must not drift:
 *
 * - **An event is a START, not a block.** `endMs` is always derived from
 *   `duration_seconds` / `effective_end_time`, never stored client-side.
 * - **Held graphics are resizable; everything else has fixed length.** A CG's
 *   length comes from its GraphicsTemplate, which only the operator changes.
 */

import type { MediaLane, ScheduleEvent } from '@/api/types'
import { HELD_LANES, LANE_ORDER } from '@/api/types'
import { CHAIN_GAP_SECONDS, DELETE_CUTOFF_MS } from '@/config'
import { toNumber } from './format'

export const MINUTES = 60_000
export const HOUR = 60 * MINUTES

/** Zoom ladder (FR-TL-02). Values are the visible window width. */
export const ZOOM_LEVELS_MS = [5, 10, 15, 30, 60, 120].map((m) => m * MINUTES)
export const DEFAULT_ZOOM_INDEX = 3 // 30 minutes
export const SHIFT_STEP_MS = 6 * HOUR // FR-TL-03

/** Below this rendered width a clip collapses to a plain coloured bar (FR-CL-10). */
export const LABEL_VISIBILITY_PX = 40

/**
 * Below this width only the opening of the title is drawn, with no lane badge
 * and no duration line. Below *that* the block is a coloured bar and the name
 * is carried by the tooltip and the accessible label instead.
 *
 * The old behaviour drew nothing until the full threshold, which left every
 * short commercial looking like an anonymous rectangle.
 */
export const PARTIAL_LABEL_VISIBILITY_PX = 14

export interface Viewport {
  /** Epoch ms of the left edge of the visible window. */
  offsetMs: number
  /** Width of the visible window in ms. */
  zoomMs: number
  /** Width in CSS px of the lane area. */
  widthPx: number
}

export interface ClipGeometry {
  id: number
  pipelineId: number
  lane: MediaLane
  startMs: number
  endMs: number
  /** `left` as a fraction of the viewport width -- resolution independent. */
  left: number
  /** `width` as a fraction of the viewport width. */
  width: number
  /** Pixel equivalents, for hit-testing and edge handles only. */
  leftPx: number
  widthPx: number
  status: ScheduleEvent['status']
  isLocked: boolean
  isOnAir: boolean
  isHeld: boolean
}

export function msPerPx(viewport: Viewport): number {
  return viewport.widthPx > 0 ? viewport.zoomMs / viewport.widthPx : 1
}

export function pxToMs(viewport: Viewport, px: number): number {
  return px * msPerPx(viewport)
}

export function msToPx(viewport: Viewport, ms: number): number {
  const scale = msPerPx(viewport)
  return scale === 0 ? 0 : ms / scale
}

export function offsetToMs(viewport: Viewport, fraction: number): number {
  return viewport.offsetMs + fraction * viewport.zoomMs
}

export function msToOffset(viewport: Viewport, ms: number): number {
  return (ms - viewport.offsetMs) / viewport.zoomMs
}

/** Snap tolerance in ms, derived from pixels at the current zoom (FR-DND-04). */
export function snapToleranceMs(viewport: Viewport, px = 8): number {
  return pxToMs(viewport, px)
}

/**
 * How far an edge has to travel before the gesture counts as a change.
 *
 * A drag emits a final pointer sample on release, and that sample is rarely the
 * same position as the last `pointermove`; sub-pixel rounding alone is enough to
 * invent a millisecond of "movement". Both the hook (which decides whether to
 * bother the network) and the page (which decides which fields to send) compare
 * against this, so it lives here rather than being written twice.
 */
export const DRAG_EPSILON_MS = 250

/**
 * Effective end of an event.
 *
 * `effective_end_time` is authoritative because the server already resolved the
 * hold/template precedence. Falling back to `scheduled_time + duration_seconds`
 * only guards against a partially-hydrated optimistic row.
 */
export function eventStartMs(event: Pick<ScheduleEvent, 'scheduled_time'>): number {
  return new Date(event.scheduled_time).getTime()
}

export function eventEndMs(event: ScheduleEvent): number {
  if (event.end_time) return new Date(event.end_time).getTime()
  if (event.effective_end_time) return new Date(event.effective_end_time).getTime()
  const duration = toNumber(event.duration_seconds) ?? 0
  return eventStartMs(event) + duration * 1000
}

export function isEventHeld(event: Pick<ScheduleEvent, 'media_lane'>): boolean {
  return event.media_lane !== null && HELD_LANES.has(event.media_lane)
}

/** Where an item stands relative to the clock, right now. */
export type PlaybackPhase = 'failed' | 'executing' | 'executed' | 'upcoming'

/**
 * The one rule that decides what colour an item is.
 *
 * This is the run-down's rule, lifted here so the list and the timeline cannot
 * disagree. It is a pure function of the clock and the event's own window, and
 * that is the entire point:
 *
 * - The server's `is_on_air` / `status = PLAYING` are **lagging truths**. They
 *   are recomputed when the schedule is polled, so an item that finished a
 *   moment ago stays lit red until the next poll arrives -- and the legacy
 *   agent writes `PLAYING` for *every* member of a break at once, which is why
 *   a whole ad break went red together instead of one commercial at a time.
 * - The interval `start <= now < end` is exact, self-correcting between polls,
 *   and it is per item, so a four-commercial break always shows exactly one
 *   red segment.
 *
 * The consequence is that the timeline and the run-down always agree, because
 * there is only one implementation left to disagree with.
 */
export function playbackPhase(
  event: Pick<ScheduleEvent, 'scheduled_time' | 'status'> & Partial<ScheduleEvent>,
  nowMs: number,
): PlaybackPhase {
  if (event.status === 'FAILED') return 'failed'

  const startMs = eventStartMs(event)
  const endMs = eventEndMs(event as ScheduleEvent)

  // A cancelled item never plays, whatever window it was given. Past its end it
  // reads as executed so it does not sit in the queue forever.
  if (event.status === 'CANCELLED') return endMs <= nowMs ? 'executed' : 'upcoming'

  if (startMs <= nowMs && nowMs < endMs) return 'executing'
  if (endMs <= nowMs) return 'executed'
  return 'upcoming'
}

/** Is this item on air at `nowMs`? The single source of truth for every "live" tint. */
export function isOnAirAt(
  event: Pick<ScheduleEvent, 'scheduled_time' | 'status'> & Partial<ScheduleEvent>,
  nowMs: number,
): boolean {
  return playbackPhase(event, nowMs) === 'executing'
}

/**
 * Is an item actually running right now?
 *
 * `playbackPhase` already answers this for events with a known window, but a
 * recording is a special case: the engine owns its end, so it stays `PLAYING`
 * until the stop command is acknowledged. Treating that status as live is what
 * lets a recording be stopped in the moment after its scheduled end passes.
 */
export function isLiveAt(event: ScheduleEvent, nowMs: number): boolean {
  if (event.action_type === 'RECORD' && event.status === 'PLAYING') return true
  return playbackPhase(event, nowMs) === 'executing'
}

/**
 * Why an item may not be deleted at `nowMs`, or `null` when it may.
 *
 * Three windows are frozen:
 *
 * - **recording** -- live items are stopped, not removed. The engine has the
 *   file open.
 * - **past** -- the window has already closed. Removing it would rewrite
 *   history rather than the schedule.
 * - **queued** -- within {@link DELETE_CUTOFF_MS} of its start. The item has
 *   been handed to the engine and a delete now races the capture.
 */
export type DeleteBlock = 'recording' | 'queued' | 'past'

export function deleteBlock(event: ScheduleEvent, nowMs: number): DeleteBlock | null {
  if (isLiveAt(event, nowMs)) return 'recording'
  if (eventEndMs(event) <= nowMs) return 'past'
  if (eventStartMs(event) - nowMs <= DELETE_CUTOFF_MS) return 'queued'
  return null
}

/** Client mirror of the server's delete guard. */
export function canDeleteAt(event: ScheduleEvent, nowMs: number): boolean {
  return deleteBlock(event, nowMs) === null
}

/** Operator-facing explanation for a blocked delete. */
export function deleteBlockMessage(block: DeleteBlock): string {
  switch (block) {
    case 'recording':
      return 'It is recording right now — stop the recording instead of deleting it.'
    case 'queued':
      return 'It is queued to start within 15 seconds and can no longer be deleted.'
    case 'past':
      return 'It has already finished, and past items cannot be deleted.'
  }
}

/**
 * Lock / on-air state at a point in time.
 *
 * Locking stays clock-derived so a clip cannot sit on "scheduled" styling after
 * its lock point has passed, and the server's flag is kept only as a floor.
 *
 * On-air comes from {@link playbackPhase} and nothing else. It used to OR in
 * `is_on_air` and `status === 'PLAYING'`, which is what left completed items
 * painted red until the next poll.
 */
export function deriveLockState(
  event: Pick<ScheduleEvent, 'scheduled_time' | 'is_locked' | 'status' | 'is_on_air'>,
  nowMs: number,
  lockWindowMs: number,
): { isLocked: boolean; isOnAir: boolean } {
  const startMs = eventStartMs(event)
  return {
    isLocked: event.is_locked || nowMs >= startMs - lockWindowMs,
    isOnAir: isOnAirAt(event, nowMs),
  }
}

export function computeGeometry(
  event: ScheduleEvent,
  viewport: Viewport,
  nowMs: number,
  lockWindowMs: number,
): ClipGeometry {
  const startMs = eventStartMs(event)
  const endMs = eventEndMs(event)
  const left = msToOffset(viewport, startMs)
  const width = (endMs - startMs) / viewport.zoomMs
  const { isLocked, isOnAir } = deriveLockState(event, nowMs, lockWindowMs)
  return {
    id: event.id,
    pipelineId: event.pipeline,
    lane: (event.media_lane ?? 'FILE') as MediaLane,
    startMs,
    endMs,
    left,
    width,
    leftPx: left * viewport.widthPx,
    widthPx: width * viewport.widthPx,
    status: event.status,
    isLocked,
    isOnAir,
    isHeld: isEventHeld(event),
  }
}

/** FR-CL-09: only blocks intersecting the window are rendered. */
export function isVisible(geometry: ClipGeometry, viewport: Viewport): boolean {
  const end = viewport.offsetMs + viewport.zoomMs
  return geometry.startMs < end && geometry.endMs > viewport.offsetMs
}

// ---------------------------------------------------------------------------
// Ad chains
// ---------------------------------------------------------------------------

/**
 * Group FILE events into ad breaks using the agent's exact rule (Spec §2.2).
 *
 * Grouping is **end-to-start**, not start-to-start, with a 1.0s tolerance.
 * Three 20s commercials at 10:00:00 / 10:00:20 / 10:00:40 are ONE break that
 * airs once and returns to live once. Copying start-to-start here would air
 * three separate route-backs.
 */
export function groupIntoChains<T extends ScheduleEvent>(events: readonly T[]): T[][] {
  const ordered = [...events].sort(
    (a, b) => new Date(a.scheduled_time).getTime() - new Date(b.scheduled_time).getTime(),
  )

  const chains: T[][] = []
  let current: T[] = []
  let prevEndMs: number | null = null

  for (const event of ordered) {
    const startMs = eventStartMs(event)
    if (current.length > 0 && prevEndMs !== null) {
      if ((startMs - prevEndMs) / 1000 > CHAIN_GAP_SECONDS) {
        chains.push(current)
        current = []
      }
    }
    current.push(event)
    // Chain maths use the MEDIA ITEM's probed duration, not the event's derived
    // duration -- that is what the agent compares against.
    const duration = toNumber(event.duration_seconds) ?? 0
    prevEndMs = startMs + duration * 1000
  }

  if (current.length > 0) chains.push(current)
  return chains
}

export function chainIdFor(members: readonly ScheduleEvent[]): number | null {
  return members.length > 0 ? members[0].id : null
}

// ---------------------------------------------------------------------------
// Snapping (FR-DND-04)
// ---------------------------------------------------------------------------

export interface SnapTarget {
  ms: number
  /** Event id owning this edge, so we can skip snapping to ourselves. */
  eventId: number
}

export function collectSnapTargets(
  events: readonly ScheduleEvent[],
  excludeIds: ReadonlySet<number>,
  lane: MediaLane | null,
): SnapTarget[] {
  const targets: SnapTarget[] = []
  for (const event of events) {
    if (excludeIds.has(event.id)) continue
    if (lane !== null && event.media_lane !== lane) continue
    targets.push({ ms: eventStartMs(event), eventId: event.id })
    if (isEventHeld(event)) targets.push({ ms: eventEndMs(event), eventId: event.id })
  }
  return targets
}

export interface SnapResult {
  ms: number
  snappedTo: SnapTarget | null
}

export function snapMs(proposedMs: number, targets: readonly SnapTarget[], toleranceMs: number): SnapResult {
  let best: SnapTarget | null = null
  let bestDistance = toleranceMs

  for (const target of targets) {
    const distance = Math.abs(target.ms - proposedMs)
    if (distance <= bestDistance) {
      best = target
      bestDistance = distance
    }
  }
  return best ? { ms: best.ms, snappedTo: best } : { ms: proposedMs, snappedTo: null }
}

// ---------------------------------------------------------------------------
// Overlap detection (client mirror of the server rule, AC-33)
// ---------------------------------------------------------------------------

export interface OverlapConflict {
  id: number
  start: string
  title: string
}

/**
 * Same-lane overlap only. Cross-lane overlap is legal by design: a CG and an ad
 * are meant to be able to run together.
 *
 * `excludeIds` is a SET, not a single id, and that is the whole point. An ad
 * break is dragged as a unit (FR-DND-08), and every member of that break is
 * moving at the same time -- so none of them may be treated as an obstacle. With
 * only the grabbed item excluded, the break's own second commercial was
 * reported as the thing in the way, and moving a chain by a few pixels always
 * came back "that time overlaps another item".
 */
export function findOverlap(
  events: readonly ScheduleEvent[],
  candidate: { excludeIds: ReadonlySet<number>; lane: MediaLane; startMs: number; endMs: number },
): OverlapConflict | null {
  for (const event of events) {
    if (candidate.excludeIds.has(event.id)) continue
    if (event.media_lane !== candidate.lane) continue
    if (event.status === 'COMPLETED' || event.status === 'FAILED' || event.status === 'CANCELLED') {
      continue
    }
    const start = eventStartMs(event)
    const end = eventEndMs(event)
    if (candidate.startMs < end && candidate.endMs > start) {
      return { id: event.id, start: event.scheduled_time, title: event.media_title }
    }
  }
  return null
}

/**
 * First conflict among several proposed windows, with the item that blocked it.
 *
 * A chain move proposes one window per member, and reporting only the first
 * failure would name a commercial the operator cannot even see. Carrying the
 * offending member alongside means the warning can say *which* ad in the break
 * landed on something.
 */
export function firstConflict(
  events: readonly ScheduleEvent[],
  excludeIds: ReadonlySet<number>,
  lane: MediaLane,
  proposals: readonly { eventId: number; startMs: number; endMs: number }[],
): { blockedEventId: number; conflict: OverlapConflict } | null {
  for (const proposal of proposals) {
    const conflict = findOverlap(events, {
      excludeIds,
      lane,
      startMs: proposal.startMs,
      endMs: proposal.endMs,
    })
    if (conflict) return { blockedEventId: proposal.eventId, conflict }
  }
  return null
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export interface LaneDefinition {
  lane: MediaLane
  label: string
  /** Flex weight. The ad lane is deliberately taller than the rest (FR-TL-07). */
  flex: number
  hint: string
}

export const LANE_DEFINITIONS: readonly LaneDefinition[] = [
  { lane: 'FILE', label: 'Record', flex: 6.0, hint: 'Recording lane' },
]

export function laneDefinition(lane: MediaLane): LaneDefinition {
  return LANE_DEFINITIONS.find((entry) => entry.lane === lane) ?? LANE_DEFINITIONS[0]
}

export { LANE_ORDER }

// Re-exported so the run-down can apply the same gap rule without reaching into
// the config module and risking a second, divergent copy of the constant.
export { CHAIN_GAP_SECONDS }

// ---------------------------------------------------------------------------
// Ruler ticks (FR-TL-04)
// ---------------------------------------------------------------------------

export interface Tick {
  ms: number
  major: boolean
  label: string
  /**
   * Day boundary, so the ruler can shout where the date changes even if the
   * regular every-Nth-mark rule would have left it out.
   */
  dayBoundary: boolean
  /** Local (channel-timezone) day this tick falls on, formatted. */
  dateLabel?: string
}

/**
 * Tick density adapts to zoom: the target is a major label roughly every
 * `MINOR_STEP_PX` pixels, so the ruler never becomes unreadable at 120 minutes
 * or absurdly sparse at 5.
 */
const MINOR_STEP_PX = 72

export function buildTicks(
  viewport: Viewport,
  timezone: string,
  formatLabel: (ms: number) => string,
  formatDateLabel: (ms: number) => string,
  /** Local-day key, used to spot midnight. */
  dayKey: (ms: number) => string,
): Tick[] {
  const minorStepMs = pxToMs(viewport, MINOR_STEP_PX)
  const niceSteps = [
    1_000,
    5_000,
    10_000,
    15_000,
    30_000,
    MINUTES,
    2 * MINUTES,
    5 * MINUTES,
    10 * MINUTES,
    15 * MINUTES,
    30 * MINUTES,
    HOUR,
    2 * HOUR,
    6 * HOUR,
    12 * HOUR,
    24 * HOUR,
  ]
  const stepMs = niceSteps.find((step) => step >= minorStepMs) ?? niceSteps[niceSteps.length - 1]
  const majorEvery = stepMs >= 15 * MINUTES ? 1 : 4

  const start = Math.floor(viewport.offsetMs / stepMs) * stepMs
  const end = viewport.offsetMs + viewport.zoomMs
  const ticks: Tick[] = []

  // Every Nth labelled tick carries the date. Showing it on every mark turns
  // the ruler into a wall of repeated text; showing it on none leaves an
  // operator at a 15-minute zoom unable to tell which day they are looking at.
  const DATE_EVERY = 3
  let previousDay = dayKey(start - stepMs)

  for (let ms = start; ms <= end; ms += stepMs) {
    const index = Math.round(ms / stepMs)
    const day = dayKey(ms)
    const dayBoundary = day !== previousDay
    previousDay = day

    const major = index % majorEvery === 0
    // Midnight always announces itself; otherwise every third mark does.
    const withDate = dayBoundary || (major && Math.abs(index) % DATE_EVERY === 0)

    ticks.push({
      ms,
      major,
      label: formatLabel(ms),
      dayBoundary,
      ...(withDate ? { dateLabel: formatDateLabel(ms) } : null),
    })
  }
  void timezone
  return ticks
}

/** Centre the viewport on `targetMs` without changing zoom. */
export function centreOn(viewport: Viewport, targetMs: number): Viewport {
  return { ...viewport, offsetMs: targetMs - viewport.zoomMs / 2 }
}

/**
 * Where "now" sits across the viewport when the timeline follows the clock.
 *
 * Not 50%. Scheduling is a forward-looking act: an operator needs to see what
 * is about to happen, not what just happened, so now is parked a quarter of the
 * way in and 75% of the window is future. Only ever less than half.
 */
export const NOW_ANCHOR = 0.25

/** Viewport that places `targetMs` at {@link NOW_ANCHOR}. */
export function anchorNow(targetMs: number, zoomMs: number): number {
  return targetMs - zoomMs * NOW_ANCHOR
}