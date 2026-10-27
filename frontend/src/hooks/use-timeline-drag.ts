/**
 * Timeline drag / pan / resize interaction (FR-DND-01 .. FR-DND-12).
 *
 * Design constraints, in the order they bit during development:
 *
 * 1. **No DOM measurement during a drag** (FR-ST-03). Geometry is arithmetic on
 *    the viewport; the pointer delta is converted with `msPerPx` captured once
 *    at pointer-down, not re-read from the element.
 * 2. **Visual updates are rAF-throttled** (FR-DND-10). A pointermove fires far
 *    more often than the display refreshes; scheduling one state write per
 *    frame is what keeps a drag at 60fps with hundreds of clips.
 * 3. **Commit on release, never on move** (FR-DND-10). Network calls belong at
 *    the end of the gesture, and Escape can then abandon it cleanly
 *    (FR-DND-11) with no half-applied state to unwind.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { MediaLane, ScheduleEvent } from '@/api/types'
import { notify } from '@/stores/notification-store'
import {
  DRAG_EPSILON_MS,
  collectSnapTargets,
  eventEndMs,
  eventStartMs,
  findOverlap,
  firstConflict,
  msPerPx,
  pxToMs,
  snapMs,
  type Viewport,
} from '@/lib/timeline'

export type DragKind = 'move' | 'resize-start' | 'resize-end'

export interface DragState {
  kind: DragKind
  /** Event ids participating. A chain move carries every member. */
  ids: number[]
  /** Primary event (the one grabbed, or the one being resized). */
  primaryId: number
  lane: MediaLane
  /** Live preview times in epoch ms, keyed by event id. */
  preview: Record<number, number>
  /** Live preview end times, only meaningful for resize. */
  previewEnd?: Record<number, number>
  /** ms the pointer has moved, used for direction-sensitive rules. */
  deltaMs: number
  snapTargetId: number | null
  conflictId: number | null
  /**
   * Which member of a moving ad break landed on the conflict, when the gesture
   * is a chain move. Null for a single item. Only used to make the refusal
   * message name an ad the operator can actually see on screen.
   */
  conflictMemberId: number | null
}

interface StartArgs {
  kind: DragKind
  primary: ScheduleEvent
  /** All events that move together (chain members). */
  companions: ScheduleEvent[]
  startClientX: number
  /** Set when the user opted out (locked/on-air items are not draggable). */
  enabled?: boolean
}

interface HookArgs {
  viewport: Viewport
  /** Every event on this pipeline, used for snapping and overlap checks. */
  events: ScheduleEvent[]
  onCommit: (payload: {
    kind: DragKind
    ids: number[]
    primaryId: number
    lane: MediaLane
    startTimes: Record<number, number>
    endTimes?: Record<number, number>
  }) => void
}

/** Shortest a held graphic may be stretched to. */
const MIN_HELD_MS = 30_000

/**
 * Shortest a recording may be stretched to.
 *
 * The server refuses an end that is less than ten seconds after its start
 * (`Recording.clean`), so clamping any tighter than that just produced a
 * round-trip that came back rejected. Matching the server rule here means the
 * block stops where the backend would stop it.
 */
const MIN_RECORD_MS = 10_000

export function useTimelineDrag({ viewport, events, onCommit }: HookArgs) {
  const [drag, setDrag] = useState<DragState | null>(null)

  const session = useRef<{
    kind: DragKind
    primary: ScheduleEvent
    companions: ScheduleEvent[]
    startClientX: number
    msPerPx: number
    originStart: number
    originEnd: number
  } | null>(null)

  const frame = useRef<number | null>(null)
  const pending = useRef<{ clientX: number } | null>(null)

  /**
   * Mirrors `drag` for callbacks registered outside React's render cycle.
   * The pointerup handler reads the preview state; without this it would close
   * over the value from the render that attached it, which is always one frame
   * stale.
   */
  const dragRef = useRef<DragState | null>(null)
  const eventsRef = useRef(events)
  const viewportRef = useRef(viewport)

  // Latched after commit so that callbacks created during render (and the
  // native handlers they attach) always see current values, without writing to
  // a ref during render.
  useEffect(() => {
    dragRef.current = drag
    eventsRef.current = events
    viewportRef.current = viewport
  })

  /**
   * Window-level handlers are held in refs and attached at pointer-down, not
   * from an effect keyed on `drag`. Waiting for a render before attaching
   * leaves a gap in which a fast click can release with no handler attached at
   * all.
   */
  const onMoveRef = useRef<(event: PointerEvent) => void>(() => {})
  const onUpRef = useRef<(event: PointerEvent) => void>(() => {})
  const onCancelRef = useRef<(event: PointerEvent) => void>(() => {})
  const onKeyRef = useRef<(event: KeyboardEvent) => void>(() => {})

  const detach = useCallback(() => {
    window.removeEventListener('pointermove', onMoveRef.current)
    window.removeEventListener('pointerup', onUpRef.current)
    window.removeEventListener('pointercancel', onCancelRef.current)
    window.removeEventListener('keydown', onKeyRef.current)
  }, [])

  /**
   * Compute (and render) the preview for the latest pointer position.
   *
   * Returns the state it computed rather than only calling `setDrag`, because
   * `finish` runs inside a native pointer event handler: React has not re-rendered
   * yet, so reading it back out of the state hook would give the *previous*
   * frame's value and the clip would land one frame behind the pointer.
   */
  const flush = useCallback((): DragState | null => {
    frame.current = null
    const active = session.current
    const pendingDelta = pending.current
    if (!active || !pendingDelta) return dragRef.current

    const rawDelta = (pendingDelta.clientX - active.startClientX) * active.msPerPx
    const lane = (active.primary.media_lane ?? 'FILE') as MediaLane
    // Only events on the SAME pipeline may act as snap targets or conflicts:
    // timelines for different channels are independent, so a drag on one
    // channel must never collide with (or snap to) items on another.
    const allEvents = eventsRef.current.filter(
      (event) => event.pipeline === active.primary.pipeline,
    )

    // ---- resize ----
    if (active.kind !== 'move') {
      const isStart = active.kind === 'resize-start'
      let next = isStart ? active.originStart + rawDelta : active.originEnd + rawDelta

      // FR-DND-07: an on-air held graphic may only be extended forward, never
      // retracted -- pulling it back would cut the overlay off mid-broadcast.
      // A locked one may not move at all; the server refuses it either way.
      if (isStart) {
        const now = Date.now()
        next = active.primary.is_locked
          ? active.originEnd - 1000
          : active.primary.is_on_air
            ? active.originStart // start is pinned at "now" on the server
            : Math.max(next, now) // FR-DND-03: never into the past
      }

      // Minimum length: below this a held graphic is ungrabable and the
      // operator cannot tell what they are resizing. Recordings have their own
      // floor because the server enforces ten seconds on them.
      const minDuration = lane === 'FILE' ? MIN_RECORD_MS : MIN_HELD_MS
      const minEnd = active.originStart + minDuration
      if (next < minEnd) next = minEnd

      const conflict = findOverlap(allEvents, {
        excludeIds: new Set([active.primary.id]),
        lane,
        startMs: isStart ? next : active.originStart,
        endMs: isStart ? active.originEnd : next,
      })

      const state: DragState = {
        kind: active.kind,
        ids: [active.primary.id],
        primaryId: active.primary.id,
        lane,
        preview: { [active.primary.id]: isStart ? next : active.originStart },
        previewEnd: { [active.primary.id]: isStart ? active.originEnd : next },
        deltaMs: rawDelta,
        snapTargetId: null,
        conflictId: conflict?.id ?? null,
        conflictMemberId: null,
      }
      dragRef.current = state
      setDrag(state)
      return state
    }

    // ---- move ----
    const exclude = new Set([active.primary.id, ...active.companions.map((e) => e.id)])
    const targets = collectSnapTargets(allEvents, exclude, lane)
    const tolerance = pxToMs(viewportRef.current, 7)

    // The primary event snaps; companions follow with the same delta so a chain
    // stays gapless (FR-CHAIN-05).
    const proposedPrimaryStart = active.originStart + rawDelta
    const snapped = snapMs(proposedPrimaryStart, targets, tolerance)
    const resolvedDelta = snapped.ms - active.originStart

    const nextNow = Date.now()
    const startTimes: Record<number, number> = {}
    const endTimes: Record<number, number> = {}
    for (const event of [active.primary, ...active.companions]) {
      // FR-DND-03: clamp to "now" rather than allowing a past-due commit.
      const nextStart = Math.max(eventStartMs(event) + resolvedDelta, nextNow)
      startTimes[event.id] = nextStart
      // Carry the end across by the SAME amount the start moved.
      //
      // A move is a translation, not a resize. Sending only `scheduled_time`
      // left the stored `end_time` at its old value, so the event's duration
      // silently changed -- a held CG or DOG would come back from the server
      // visibly stretched or squashed after every drag. Events whose end is
      // derived from a media duration are unaffected, which is why this only
      // showed up on the lanes that carry an explicit end.
      endTimes[event.id] = eventEndMs(event) + (nextStart - eventStartMs(event))
    }

    // FR-DND-05: refuse an overlapping proposal, and name the conflict.
    //
    // An ad break moves as one unit (FR-DND-08), so the conflict test has to
    // treat it as one: EVERY member is excluded from the scan (they are back to
    // back by construction, so none of them can be the obstacle), and EVERY
    // member's proposed window is tested against what is outside the break.
    //
    // Checking only the grabbed item, against the whole lane, made a chain
    // undraggable: the grabbed commercial's new position overlapped the break's
    // own second commercial, which is still sitting at its old time, so any move
    // of a few seconds came back "that time overlaps another item".
    const hit = firstConflict(
      allEvents,
      exclude,
      lane,
      [active.primary, ...active.companions].map((event) => ({
        eventId: event.id,
        startMs: startTimes[event.id] ?? eventStartMs(event),
        endMs: endTimes[event.id] ?? eventEndMs(event),
      })),
    )

    const state: DragState = {
      kind: 'move',
      ids: Array.from(exclude),
      primaryId: active.primary.id,
      lane,
      preview: startTimes,
      previewEnd: endTimes,
      deltaMs: resolvedDelta,
      snapTargetId: snapped.snappedTo?.eventId ?? null,
      conflictId: hit?.conflict.id ?? null,
      conflictMemberId: hit?.blockedEventId ?? null,
    }
    dragRef.current = state
    setDrag(state)
    return state
  }, [])

  const onMove = useCallback(
    (nativeEvent: PointerEvent) => {
      if (!session.current) return
      pending.current = { clientX: nativeEvent.clientX }
      if (frame.current === null) {
        frame.current = window.requestAnimationFrame(flush)
      }
    },
    [flush],
  )

  const finish = useCallback(
    (commit: boolean) => {
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current)
        frame.current = null
      }
      detach()

      // A pointer-up can land in the same frame as the last pointer-move, before
      // the scheduled rAF has run. Recompute synchronously so the commit uses the
      // pointer's true final position rather than the previous frame's preview.
      const current = commit && session.current ? flush() : dragRef.current

      session.current = null
      pending.current = null
      dragRef.current = null
      setDrag(null)

      if (!commit || !current) return

      if (current.conflictId !== null) {
        const conflicting = eventsRef.current.find((e) => e.id === current.conflictId)
        const blocked =
          current.conflictMemberId !== null
            ? eventsRef.current.find((e) => e.id === current.conflictMemberId)
            : null
        const chainOf = blocked ? companionTitle(blocked, eventsRef.current, current.ids) : null
        const blocker = conflicting?.media_title ?? 'another item'
        notify.warning(
          'That time overlaps another item',
          chainOf
            ? `${chainOf} of this break — “${blocked?.media_title ?? 'unnamed'}” — lands on “${blocker}”, which is already there.`
            : `“${blocker}” already occupies that slot on this lane.`,
        )
        return
      }

      // Nothing actually moved: do not burn a request.
      //
      // BOTH edges have to be compared. A `resize-end` leaves `preview` holding
      // the original start time, so a start-only test read "0 ms moved" and
      // returned here -- which meant dragging the right edge of a DOG/BUG to
      // lengthen or shorten it did nothing at all, however far you pulled.
      const byId = new Map(eventsRef.current.map((event) => [event.id, event]))
      const moved = current.ids.some((id) => {
        const event = byId.get(id)
        if (!event) return false
        const nextStart = current.preview[id]
        if (nextStart !== undefined && Math.abs(eventStartMs(event) - nextStart) > DRAG_EPSILON_MS) {
          return true
        }
        const nextEnd = current.previewEnd?.[id]
        return nextEnd !== undefined && Math.abs(eventEndMs(event) - nextEnd) > DRAG_EPSILON_MS
      })
      if (!moved) return

      onCommit({
        kind: current.kind,
        ids: current.ids,
        primaryId: current.primaryId,
        lane: current.lane,
        startTimes: current.preview,
        endTimes: current.previewEnd,
      })
    },
    [detach, flush, onCommit],
  )

  /**
   * Escape abandons an in-flight gesture and restores the original position
   * (FR-DND-11).
   */
  const onKeyDown = useCallback((nativeEvent: KeyboardEvent) => {
    if (!session.current) return
    if (nativeEvent.key === 'Escape') {
      nativeEvent.preventDefault()
      finishRef.current(false)
    }
  }, [])

  const finishRef = useRef<(commit: boolean) => void>(() => {})

  // Latched in an effect rather than during render: effects run after commit
  // and before any pointer event can be dispatched, so `start()` always
  // attaches the current implementation, and render stays side-effect free.
  useEffect(() => {
    finishRef.current = finish
    onMoveRef.current = onMove
    onUpRef.current = () => finishRef.current(true)
    onCancelRef.current = () => finishRef.current(false)
    onKeyRef.current = onKeyDown
  })

  const start = useCallback(
    ({ kind, primary, companions, startClientX, enabled = true }: StartArgs) => {
      if (!enabled) return
      session.current = {
        kind,
        primary,
        companions,
        startClientX,
        msPerPx: msPerPx(viewportRef.current),
        originStart: eventStartMs(primary),
        originEnd: eventEndMs(primary),
      }
      pending.current = { clientX: startClientX }

      window.addEventListener('pointermove', onMoveRef.current)
      window.addEventListener('pointerup', onUpRef.current)
      window.addEventListener('pointercancel', onCancelRef.current)
      window.addEventListener('keydown', onKeyRef.current)

      frame.current = window.requestAnimationFrame(flush)
    },
    [flush],
  )

  const cancel = useCallback(() => finish(false), [finish])

  useEffect(() => detach, [detach])

  return { drag, start, cancel }
}

/** "commercial 3 of 4" — where the offending ad sits inside the break being moved. */
function companionTitle(
  blocked: ScheduleEvent,
  all: readonly ScheduleEvent[],
  chainIds: readonly number[],
): string | null {
  if (chainIds.length < 2) return null
  const ordered = all
    .filter((event) => chainIds.includes(event.id))
    .sort((a, b) => eventStartMs(a) - eventStartMs(b))
  const position = ordered.findIndex((event) => event.id === blocked.id)
  return position >= 0 ? `commercial ${position + 1} of ${ordered.length}` : null
}