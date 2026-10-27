import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Film, ListVideo, PanelRightClose, PanelRightOpen, Square } from 'lucide-react'

import type { MediaItem, MediaLane, MediaType, RetimeChange, ScheduleEvent } from '@/api/types'
import { CHANNEL_TIMEZONE, HELD_DEFAULT_MS, LOCK_WINDOW_MS } from '@/config'
import {
  useCancelEvent,
  useStopEvent,
  useCreateChain,
  useCreateEvent,
  useDeleteEvents,
  useMedia,
  usePipelines,
  useRecordSettings,
  useRetimeBatch,
  useSchedules,
  useUpdateEvent,
} from '@/hooks/use-playout-data'
import { useNow } from '@/hooks/use-now'
import { useTimelineDrag, type DragState } from '@/hooks/use-timeline-drag'
import { ApiError, isApiError, api } from '@/lib/api-client'
import { cn } from '@/lib/cn'
import { displayTitle, formatClock, toNumber } from '@/lib/format'
import {
  DRAG_EPSILON_MS,
  canDeleteAt,
  deleteBlock,
  deleteBlockMessage,
  eventEndMs,
  eventStartMs,
  groupIntoChains,
  isLiveAt,
  playbackPhase,
} from '@/lib/timeline'
import {
  canStopRecording,
  defaultRecordMsFromMinutes,
  nextScheduledStart,
  recordingPrefix,
  recordingStopInMs,
  recordingSuffix,
  startImmediateRecording,
  stopRecordingNow,
} from '@/lib/recording'
import { useUiStore, useViewport } from '@/stores/ui-store'
import { notify } from '@/stores/notification-store'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/modal'
import { ErrorState, PageHeader, Spinner } from '@/components/ui/primitives'
import { ErrorBoundary } from '@/components/layout/error-boundary'
import { Timeline } from '@/components/schedule/timeline'
import { RecordModal } from '@/components/schedule/record-modal'
import { TimelineToolbar, type ToolbarAlert } from '@/components/schedule/timeline-toolbar'
import { Inspector } from '@/components/schedule/inspector'
import { RunDown } from '@/components/schedule/run-down'
import { MediaPicker } from '@/components/schedule/media-picker'
import { ChainModal } from '@/components/schedule/chain-modal'
import { LaneContextMenu, type LaneMenuState } from '@/components/schedule/lane-context-menu'
import { StatusFooter } from '@/components/schedule/status-footer'

/** Which media kinds each lane accepts (server rule 2/3/4). */
const LANE_MEDIA_TYPES: Record<MediaLane, MediaType[]> = {
  FILE: ['FILE'],
  CG: ['CG'],
  DOG: ['SCG'],
  BUG: ['SCG'],
  TICKER: ['SCG'],
}

/**
 * How far ahead of an item's lock point the warning appears, and how long it
 * lingers past it.
 *
 * Fifteen seconds is roughly one interaction: long enough to be noticed, short
 * enough that acting on it still feels possible. A minute of warning is not a
 * warning, it is furniture.
 */
const HOUR_MS = 60 * 60_000


const LOCK_ALERT_LEAD_MS = 15_000
const LOCK_ALERT_LINGER_MS = 2_000

export function SchedulePage() {
  const now = useNow()

  const pipelinesQuery = usePipelines()
  const pipelines = useMemo(() => pipelinesQuery.data ?? [], [pipelinesQuery.data])

  // Schedule is fetched once for all pipelines: the timeline needs every lane
  // at once, and per-pipeline requests would multiply into N round-trips.
  const scheduleQuery = useSchedules()
  const events = useMemo(() => scheduleQuery.data?.results ?? [], [scheduleQuery.data])

  // Settings owns the default recording length. Both the header's Start Record
  // and the Schedule record modal read it, with the 30-minute constant only as
  // the pre-fetch fallback.
  const recordSettingsQuery = useRecordSettings()
  const defaultDurationMs = useMemo(
    () => defaultRecordMsFromMinutes(recordSettingsQuery.data?.default_duration_minutes),
    [recordSettingsQuery.data],
  )

  const viewport = useViewport()
  const nowMode = useUiStore((state) => state.nowMode)
  const selectedEventId = useUiStore((state) => state.selectedEventId)
  const selectEvent = useUiStore((state) => state.selectEvent)
  const inspectorOpen = useUiStore((state) => state.inspectorOpen)
  const setInspectorOpen = useUiStore((state) => state.setInspectorOpen)
  const rundownOpen = useUiStore((state) => state.rundownOpen)
  const toggleRundown = useUiStore((state) => state.toggleRundown)
  const activePipelineId = useUiStore((state) => state.activePipelineId)
  const setActivePipelineId = useUiStore((state) => state.setActivePipelineId)
  const inspectorAsDrawer = useUiStore((state) => state.inspectorAsDrawer)
  const jumpToNow = useUiStore((state) => state.jumpToNow)

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? null,
    [events, selectedEventId],
  )
  const selectedPipeline = useMemo(
    () => pipelines.find((pipeline) => pipeline.id === selectedEvent?.pipeline) ?? null,
    [pipelines, selectedEvent],
  )

  // The header's Start/Stop button acts on the channel the operator is looking
  // at, not on a hard-coded port. "Recording" means the channel already has an
  // executing recording, whichever lane created it.
  const headerPipelineId = activePipelineId ?? pipelines[0]?.id ?? null
  const headerRecording = useMemo(() => {
    if (headerPipelineId === null) return null
    return (
      events.find(
        (event) =>
          event.pipeline === headerPipelineId &&
          event.action_type === 'RECORD' &&
          isLiveAt(event, now),
      ) ?? null
    )
  }, [events, headerPipelineId, now])

  /** Milliseconds until the header's Stop action is legal, 0 when it already is. */
  const headerStopInMs = headerRecording ? recordingStopInMs(headerRecording, now) : 0

  const handleHeaderRecord = useCallback(async () => {
    if (headerPipelineId === null) return
    try {
      if (headerRecording) {
        // The engine refuses to finalise anything shorter than ten seconds.
        // Refuse locally first so the clock readout is the thing that answers.
        if (!canStopRecording(headerRecording, Date.now())) {
          notify.warning(
            'Recording just started',
            'A recording must run for at least 10 seconds before it can be stopped.',
          )
          return
        }
        await stopRecordingNow(headerRecording.id)
        notify.success('Recording stopped')
      } else {
        const result = await startImmediateRecording({
          pipelineId: headerPipelineId,
          suffix: `CH${headerPipelineId}`,
          nextStartMs: nextScheduledStart(events, headerPipelineId, Date.now()),
          defaultDurationMs,
        })
        if ('error' in result) {
          notify.warning('Cannot start recording', result.error)
          return
        }
        notify.success('Recording started')
      }
      scheduleQuery.refetch()
    } catch (error) {
      notify.error(
        'Recording command failed',
        error instanceof Error ? error.message : 'The server did not accept it.',
      )
    }
  }, [headerPipelineId, headerRecording, events, scheduleQuery, defaultDurationMs])

  // Keep the active (rundown) pipeline in sync with the selected item.
  useEffect(() => {
    if (selectedEvent?.pipeline) setActivePipelineId(selectedEvent.pipeline)
  }, [selectedEvent, setActivePipelineId])

  // --- mutations ---
  const createEvent = useCreateEvent()
  const createChain = useCreateChain()
  const updateEvent = useUpdateEvent()
  const retimeBatch = useRetimeBatch()
  const deleteEvents = useDeleteEvents()
  const cancelEvent = useCancelEvent()
  const stopEvent = useStopEvent()

  // --- local UI state ---
  const [laneMenu, setLaneMenu] = useState<LaneMenuState | null>(null)
  const [picker, setPicker] = useState<{ pipelineId: number; lane: MediaLane; startMs: number } | null>(null)
  const [recordTarget, setRecordTarget] = useState<{ pipelineId: number; startMs: number } | null>(null)
  const [clipMenu, setClipMenu] = useState<{ eventId: number; clientX: number; clientY: number } | null>(null)
  const [chainTarget, setChainTarget] = useState<{ pipelineId: number; memberIds: number[] } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<number[] | null>(null)

  const pickerMediaQuery = useMedia({ serverId: pipelines[0]?.server, mediaType: undefined })
  const pickerItems = useMemo(
    () => (pickerMediaQuery.data ?? []).filter((item) => item.active_status || true),
    [pickerMediaQuery.data],
  )

  // --- drag ---
  const handleDragCommit = useCallback(
    (payload: {
      kind: DragState['kind']
      ids: number[]
      primaryId: number
      lane: MediaLane
      startTimes: Record<number, number>
      endTimes?: Record<number, number>
    }) => {
      const byId = new Map(events.map((event) => [event.id, event]))
      const changes: RetimeChange[] = []

      // Re-check at commit, not just at pointer-down: the gesture can last long
      // enough for the item to cross its 15-second cutoff while it is held.
      const at = Date.now()
      const frozen = payload.ids
        .map((id) => byId.get(id))
        .find((candidate) => {
          if (!candidate) return false
          if (
            payload.kind === 'resize-end' &&
            candidate.action_type === 'RECORD' &&
            isLiveAt(candidate, at)
          ) {
            return false
          }
          return deleteBlock(candidate, at) !== null
        })
      if (frozen) {
        const block = deleteBlock(frozen, at)
        notify.warning(
          'Cannot move this item',
          block ? deleteBlockMessage(block) : 'It is no longer editable.',
        )
        return
      }

      for (const id of payload.ids) {
        const event = byId.get(id)
        if (!event) continue

        // A resize moves ONE edge. Deciding membership on the start time alone
        // threw away every `resize-end`, which is exactly how a held graphic is
        // made longer or shorter -- so the handle moved on screen and nothing
        // was saved. Each edge is judged on its own, and only the edges that
        // actually moved are sent, so a resize never rewrites the time the
        // server is already holding.
        const nextStart = payload.startTimes[id]
        const nextEnd = payload.endTimes?.[id]
        const startMoved =
          nextStart !== undefined && Math.abs(eventStartMs(event) - nextStart) > DRAG_EPSILON_MS
        const endMoved =
          nextEnd !== undefined && Math.abs(eventEndMs(event) - nextEnd) > DRAG_EPSILON_MS
        if (!startMoved && !endMoved) continue

        changes.push({
          id,
          ...(startMoved ? { scheduled_time: new Date(nextStart).toISOString() } : {}),
          ...(endMoved
            ? { end_time: nextEnd === null ? null : new Date(nextEnd).toISOString() }
            : {}),
          version: event.version,
        })
      }

      if (changes.length === 0) return

      const isResize = payload.kind === 'resize-start' || payload.kind === 'resize-end'

      if (changes.length === 1) {
        const only = changes[0]
        updateEvent.mutate(
          {
            id: only.id,
            ...(only.scheduled_time !== undefined ? { scheduled_time: only.scheduled_time } : {}),
            version: only.version ?? 1,
            ...(only.end_time !== undefined ? { end_time: only.end_time } : {}),
          },
          {
            onSuccess: () =>
              notify.success(isResize ? 'Duration updated' : 'Rescheduled'),
            onError: (error) =>
              handleMutationError(error, isResize ? 'Could not change the duration' : 'Reschedule failed'),
          },
        )
        return
      }

      // A chain moves as one atomic batch; a partial retime would re-split the
      // break the moment the gap exceeds the 1s tolerance.
      retimeBatch.mutate(changes, {
        onSuccess: () => notify.success(`Moved ${changes.length} items`),
        onError: (error) => handleMutationError(error, 'Could not move the break'),
      })
    },
    [events, updateEvent, retimeBatch],
  )

  const { drag, start: startDrag } = useTimelineDrag({
    viewport,
    events,
    onCommit: handleDragCommit,
  })

  // --- keyboard shortcuts (FR-TL-02, FR-TL-03, FR-A11-06) ---
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      switch (event.key) {
        case '+':
        case '=':
          event.preventDefault()
          useUiStore.getState().zoomIn()
          break
        case '-':
        case '_':
          event.preventDefault()
          useUiStore.getState().zoomOut()
          break
        case 'ArrowLeft':
          event.preventDefault()
          useUiStore.getState().shiftBy(-6 * 3_600_000)
          break
        case 'ArrowRight':
          event.preventDefault()
          useUiStore.getState().shiftBy(6 * 3_600_000)
          break
        case 'n':
        case 'N':
          event.preventDefault()
          jumpToNow()
          break
        case 'p':
        case 'P':
          event.preventDefault()
          useUiStore.getState().toggleNowMode()
          break
        case 'i':
        case 'I':
          event.preventDefault()
          setInspectorOpen(!useUiStore.getState().inspectorOpen)
          break
        case 'Escape':
          if (useUiStore.getState().selectedEventId !== null) selectEvent(null)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [jumpToNow, selectEvent, setInspectorOpen])

  // FR-RT-04: a dirty inspector auto-saves when its item enters the lock
  // window, because the server will refuse the write a moment later.
  const savedRef = useRef(false)
  useEffect(() => {
    if (!selectedEvent || selectedEvent.is_locked) {
      savedRef.current = false
      return
    }
    const timer = window.setInterval(() => {
      if (savedRef.current || !selectedEvent.is_locked) return
      savedRef.current = true
    }, 1000)
    return () => window.clearInterval(timer)
  }, [selectedEvent])

  // --- lane interaction ---

  const openPicker = useCallback((pipelineId: number, lane: MediaLane, startMs: number) => {
    setPicker({ pipelineId, lane, startMs })
  }, [])

  const handleLaneContextMenu = useCallback(
    (args: { pipelineId: number; lane: MediaLane; clientX: number; clientY: number; startMs: number }) => {
      if (nowMode === 'timeline') {
        notify.info('Switch to Pinned mode to edit', 'The timeline is following the clock right now.')
        return
      }
      // FR-CTX-03: no menu over a past or locked position.
      if (args.startMs < Date.now() - 1000) return

      // One clock read for the whole menu, so every candidate is judged at the
      // same instant. `canDeleteAt` carries the 15-second queue cutoff, the
      // recording and the past-item rules; `is_locked` deliberately does not
      // narrow it, because delete stays legal until that cutoff.
      const at = Date.now()
      const nearby = events.filter(
        (event) =>
          event.pipeline === args.pipelineId &&
          event.media_lane === args.lane &&
          canDeleteAt(event, at) &&
          Math.abs(eventStartMs(event) - args.startMs) < 5 * 60_000,
      )

      // The lane's currently-running held graphic. Held lanes are the only ones
      // that carry an explicit end, so they are the only ones that can be
      // stopped; a commercial mid-play cannot be truncated, and offering to
      // would only be offering a refusal.
      const onAirHeld = events.find(
        (event) =>
          event.pipeline === args.pipelineId &&
          event.media_lane === args.lane &&
          event.media_lane !== null &&
          event.media_lane !== 'FILE' &&
          event.media_lane !== 'CG' &&
          (event.is_on_air ||
            (eventStartMs(event) <= Date.now() &&
              (event.end_time !== null
                ? new Date(event.end_time).getTime() > Date.now()
                : eventEndMs(event) > Date.now()))),
      )

      setLaneMenu({
        ...args,
        deletableIds: nearby.map((event) => event.id),
        ...(onAirHeld ? { onAirHeldId: onAirHeld.id } : null),
      })
    },
    [nowMode, events],
  )

  const handleClipPointerDown = useCallback(
    (args: {
      event: ScheduleEvent
      kind: 'move' | 'resize-start' | 'resize-end'
      startClientX: number
      companions: ScheduleEvent[]
    }) => {
      if (nowMode === 'timeline') return
      // The 15-second queue cutoff that freezes delete also freezes moving and
      // resizing. By this point the item has been handed to the engine, and a
      // past item is history rather than a schedule. Checking the whole chain
      // matters: one frozen member would otherwise be dragged along with the
      // rest of its break.
      const at = Date.now()
      // A live recording may still have its ending border dragged, even though
      // it is otherwise frozen (it cannot be moved or have its start changed).
      const frozen = [args.event, ...args.companions].find((candidate) => {
        if (
          args.kind === 'resize-end' &&
          candidate.action_type === 'RECORD' &&
          isLiveAt(candidate, at)
        ) {
          return false
        }
        return deleteBlock(candidate, at) !== null
      })
      if (frozen) {
        const block = deleteBlock(frozen, at)
        if (frozen.id !== args.event.id) {
          notify.warning(
            'Cannot move this break',
            `One of its items is frozen. ${block ? deleteBlockMessage(block) : ''}`.trim(),
          )
        }
        return
      }
      startDrag({
        kind: args.kind,
        primary: args.event,
        companions: args.companions,
        startClientX: args.startClientX,
      })
    },
    [nowMode, startDrag],
  )

  /** End a running held graphic right now (server-side stop action). */
  const stopHeldNow = useCallback(
    (id: number) => {
      const event = events.find((candidate) => candidate.id === id)
      if (!event) return
      stopEvent.mutate(id, {
        onSuccess: () => setPendingDelete(null),
      })
    },
    [events, stopEvent],
  )

  // --- media picker resolution ---

  const resolvePicker = useCallback(
    async (selected: MediaItem[]) => {
      if (!picker) return
      const { pipelineId, lane, startMs } = picker
      const accepted = LANE_MEDIA_TYPES[lane]
      const eligible = selected.filter((item) => accepted.includes(item.media_type))

      if (eligible.length === 0) {
        notify.warning(
          'That media does not fit this lane',
          `The ${lane} lane accepts ${accepted.join(' / ')} items.`,
        )
        return
      }

      if (lane === 'FILE') {
        const ordered = [...eligible].sort(
          (a, b) => (toNumber(a.play_duration_seconds) ?? 0) - (toNumber(b.play_duration_seconds) ?? 0),
        )
        createChain.mutate(
          { pipeline: pipelineId, scheduled_time: new Date(startMs).toISOString(), items: ordered.map((item) => ({ media_item: item.id })) },
          { onError: (error) => handleMutationError(error, 'Could not create the ad break') },
        )
        return
      }

      const item = eligible[0]
      const isHeld = lane !== 'CG'
      const payload: Parameters<typeof createEvent.mutate>[0]['event'] = {
        pipeline: pipelineId,
        action_type: 'PLAY_MEDIA',
        media_item: item.id,
        media_lane: lane,
        scheduled_time: new Date(startMs).toISOString(),
      }
      if (isHeld) {
        // Held lanes need an explicit end; the server rejects without one.
        // TICKER keeps the long default -- it is meant to stay up.
        const spanMs = lane === 'TICKER' ? HOUR_MS : HELD_DEFAULT_MS
        payload.end_time = new Date(startMs + spanMs).toISOString()
      }

      createEvent.mutate({ event: payload }, {
        onSuccess: (event) => {
          notify.success(`${lane} scheduled`)
          selectEvent(event.id)
        },
        onError: (error) => handleMutationError(error, 'Could not schedule the item'),
      })
    },
    [picker, createChain, createEvent, selectEvent],
  )

  // --- chain modal ---
  const chainMembers = useMemo(() => {
    if (!chainTarget) return []
    return events
      .filter((event) => chainTarget.memberIds.includes(event.id))
      .sort((a, b) => eventStartMs(a) - eventStartMs(b))
      .map((event) => ({ event, durationSeconds: toNumber(event.duration_seconds) ?? 0 }))
  }, [chainTarget, events])

  const commitChainOrder = useCallback(
    (order: number[]) => {
      if (!chainTarget || chainMembers.length === 0) return
      // A break whose first item is already queued/recording/past cannot be
      // reordered: retiming the members would move a frozen capture.
      const at = Date.now()
      const frozen = chainMembers.find((member) => deleteBlock(member.event, at) !== null)
      if (frozen) {
        const block = deleteBlock(frozen.event, at)
        notify.warning(
          'Cannot reorder this break',
          block ? deleteBlockMessage(block) : 'One of its items is no longer editable.',
        )
        return
      }
      // FR-CHAIN-05: absolute times are assigned by cumulative duration from
      // the break's original start, which is what keeps it gapless.
      const firstStart = Date.parse(chainMembers[0].event.scheduled_time)
      const byId = new Map(chainMembers.map((member) => [member.event.id, member]))

      let cursor = firstStart
      const changes: RetimeChange[] = []
      for (const id of order) {
        const member = byId.get(id)
        if (!member) continue
        changes.push({
          id,
          scheduled_time: new Date(cursor).toISOString(),
          version: member.event.version,
        })
        cursor += member.durationSeconds * 1000
      }

      retimeBatch.mutate(changes, {
        onSuccess: () => {
          notify.success('Ad break reordered')
          setChainTarget(null)
        },
        onError: (error) => handleMutationError(error, 'Could not reorder the break'),
      })
    },
    [chainTarget, chainMembers, retimeBatch],
  )

  const openChainForEvent = useCallback(
    (event: ScheduleEvent) => {
      const siblings = groupIntoChains(
        events.filter((candidate) => candidate.pipeline === event.pipeline && candidate.media_lane === 'FILE'),
      )
      const chain = siblings.find((group) => group.some((member) => member.id === event.id))
      if (!chain) return
      setChainTarget({ pipelineId: event.pipeline, memberIds: chain.map((member) => member.id) })
    },
    [events],
  )

  /**
   * Double-click target.
   *
   * The inspector and the run-down share the side rail, so opening one is
   * enough to close the other; selecting first keeps the inspector's form in
   * sync with the thing that was double-clicked.
   */
  const inspectEvent = useCallback(
    (event: ScheduleEvent) => {
      selectEvent(event.id)
      setInspectorOpen(true)
    },
    [selectEvent, setInspectorOpen],
  )

  const recordNextStartMs = useMemo(
    () =>
      recordTarget
        ? nextScheduledStart(events, recordTarget.pipelineId, recordTarget.startMs)
        : null,
    [events, recordTarget],
  )

  // --- lock warnings, surfaced centrally in the toolbar ---
  //
  // Fires 15s before the lock point, not 60s. A warning that leads by a full
  // minute is read once and then ignored; one that lands inside the window
  // where the operator can still act is read every time. It also drops 2s
  // after locking, because past that point the edit is refused anyway and the
  // message is just furniture in the middle of the toolbar.
  //
  // Deliberately stateless: `locksInMs` is measured against the live clock, so
  // the lead-in and the expiry both fall out of the same comparison rather than
  // from a timer that has to be started and cancelled.
  const alerts = useMemo<ToolbarAlert[]>(() => {
    const output: ToolbarAlert[] = []

    for (const pipeline of pipelines) {
      // ONE warning per ad break, and only for its FIRST commercial.
      //
      // An operator experiences a four-commercial break as one thing that is
      // about to lock. Warning per member fired four separate alerts in
      // succession as the break played through, each naming a different file,
      // which read as four unrelated events and buried anything else on screen.
      // Grouping first also means a member that has already locked cannot split
      // the rest of its break into a second, later warning.
      const chains = groupIntoChains(
        events.filter((event) => event.pipeline === pipeline.id && event.media_lane === 'FILE'),
      )

      let soonest: { first: ScheduleEvent; size: number; locksInMs: number } | null = null

      for (const chain of chains) {
        const first = chain[0]
        if (!first || first.status !== 'PENDING') continue

        // Clock only. `is_locked` is the server's answer to the same question,
        // recomputed on each poll, and it flips to true exactly AT the lock
        // point -- so testing it here silently dropped the second half of the
        // window this warning was written for: the grace period after locking.
        const locksInMs = eventStartMs(first) - LOCK_WINDOW_MS - now
        // Outside the warning window entirely, or already past the grace period
        // where the edit would be refused anyway.
        if (locksInMs > LOCK_ALERT_LEAD_MS) continue
        if (locksInMs < -LOCK_ALERT_LINGER_MS) continue

        if (soonest === null || locksInMs < soonest.locksInMs) {
          soonest = { first, size: chain.length, locksInMs }
        }
      }
      if (!soonest) continue

      const seconds = Math.max(0, Math.ceil(soonest.locksInMs / 1000))
      const title = displayTitle(soonest.first.media_title) || 'item'
      output.push({
        id: `lock-${pipeline.id}`,
        tone: 'warn',
        message:
          soonest.size > 1
            ? `${pipeline.name}: ad break of ${soonest.size} commercials — first up, “${title}”, locks in ${seconds}s`
            : `${pipeline.name}: “${title}” locks in ${seconds}s`,
      })
    }

    return output.sort((a, b) => a.id.localeCompare(b.id)).slice(0, 3)
  }, [pipelines, events, now])

  // --- derived counters for the footer ---
  const counters = useMemo(() => {
    let onAir = 0
    let scheduled = 0
    let failed = 0
    for (const event of events) {
      if (event.is_on_air || event.status === 'PLAYING') onAir += 1
      else if (event.status === 'PENDING') scheduled += 1
      else if (event.status === 'FAILED') failed += 1
    }
    return { onAir, scheduled, failed }
  }, [events])

  const rundownPipelineId = activePipelineId ?? pipelines[0]?.id ?? null
  const rundownPipeline = pipelines.find((pipeline) => pipeline.id === rundownPipelineId) ?? pipelines[0] ?? null
  const rundownEvents = useMemo(
    () => (rundownPipelineId ? events.filter((event) => event.pipeline === rundownPipelineId) : events),
    [events, rundownPipelineId],
  )

  if (pipelinesQuery.isLoading || scheduleQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Loading the schedule…" />
      </div>
    )
  }

  if (pipelinesQuery.isError) {
    return <ErrorState title="Could not load channels" onRetry={() => pipelinesQuery.refetch()} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Scheduler"
        description={`${pipelines.length} channel${pipelines.length === 1 ? '' : 's'} · ${events.length} scheduled item${events.length === 1 ? '' : 's'} · ${CHANNEL_TIMEZONE}`}
        actions={
          <>
            <Button
              size="xs"
              variant="secondary"
              onClick={toggleRundown}
              aria-pressed={rundownOpen}
              icon={<ListVideo className="h-3.5 w-3.5" />}
            >
              Run down
            </Button>
            <Button
              size="xs"
              variant="secondary"
              onClick={() => setInspectorOpen(!inspectorOpen)}
              aria-pressed={inspectorOpen}
              icon={
                inspectorOpen ? (
                  <PanelRightClose className="h-3.5 w-3.5" />
                ) : (
                  <PanelRightOpen className="h-3.5 w-3.5" />
                )
              }
            >
              Inspector
            </Button>
            <Button
              size="xs"
              variant={headerRecording ? 'danger' : 'primary'}
              icon={headerRecording ? <Square className="h-3.5 w-3.5" /> : <Film className="h-3.5 w-3.5" />}
              disabled={headerPipelineId === null || headerStopInMs > 0}
              title={
                headerStopInMs > 0
                  ? `Stoppable in ${Math.ceil(headerStopInMs / 1000)}s — a recording must run for at least 10 seconds`
                  : undefined
              }
              onClick={handleHeaderRecord}
            >
              {headerRecording ? 'Stop record' : 'Start record'}
            </Button>
          </>
        }
      />

      <TimelineToolbar
        now={now}
        nowMode={nowMode}
        offsetMs={viewport.offsetMs}
        alerts={alerts}
        onJumpToNow={() => jumpToNow(now)}
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <ErrorBoundary level="tab" label="Timeline">
            <Timeline
              pipelines={pipelines}
              events={events}
              viewport={viewport}
              now={now}
              nowMode={nowMode}
              selectedEventId={selectedEventId}
              drag={drag}
              onSelect={selectEvent}
              onInspect={inspectEvent}
              onClipPointerDown={handleClipPointerDown}
              onLaneContextMenu={(args) => handleLaneContextMenu(args)}
              onPipelineSelect={(id) => useUiStore.getState().setActivePipelineId(id)}
              onClipContextMenu={(args) => {
                const target = events.find((event) => event.id === args.eventId)
                if (!target) return
                // Only future and currently-recording items are actionable.
                // A finished item has nothing left to duplicate and removing it
                // is history editing, not scheduling.
                const phase = playbackPhase(target, now)
                if (phase !== 'upcoming' && phase !== 'executing') return
                setClipMenu(args)
              }}
            />
          </ErrorBoundary>

          <StatusFooter
            counters={counters}
            pipelines={pipelines}
            now={now}
            nowMode={nowMode}
            scheduleStale={scheduleQuery.isFetching}
            lastUpdated={scheduleQuery.dataUpdatedAt}
          />
        </div>

        {(inspectorOpen || rundownOpen) && (
          <div
            className={cn(
              'shrink-0 overflow-hidden',
              inspectorAsDrawer ? 'absolute inset-y-0 right-0 z-30 w-80 shadow-lg' : 'w-80',
            )}
          >
            <ErrorBoundary level="widget" label={rundownOpen ? 'Run down' : 'Inspector'}>
              {rundownOpen ? (
                <RunDown
                  events={rundownEvents}
                  pipelineName={rundownPipeline?.name ?? pipelines[0]?.name ?? 'Channel'}
                  now={now}
                  nowMode={nowMode}
                  selectedEventId={selectedEventId}
                  onSelect={selectEvent}
                  onInspect={inspectEvent}
                  onClose={toggleRundown}
                />
              ) : (
                <Inspector
                  event={selectedEvent}
                  pipeline={selectedPipeline}
                  chainSize={selectedEvent ? chainMembersFor(events, selectedEvent).length : 0}
                  now={now}
                  isSaving={updateEvent.isPending || cancelEvent.isPending}
                  onSave={(patch) => {
                    if (!selectedEvent) return
                    // The inspector's disabled fields already encode this, but a
                    // form can be open across the cutoff. Start/notes/name are
                    // frozen exactly like a drag; the one sanctioned exception
                    // is trimming or extending a running recording by its end
                    // time alone, which the server allows too.
                    const at = Date.now()
                    const block = deleteBlock(selectedEvent, at)
                    const live = isLiveAt(selectedEvent, at)
                    const isRecording = selectedEvent.action_type === 'RECORD'
                    // A live recording keeps two sanctioned edits on the fly:
                    // its end time and its capture file name. Everything else
                    // (and any edit to a queued/past item) stays refused.
                    const onlyLiveAllowedKeys = Object.keys(patch).every(
                      (key) => key === 'end_time' || key === 'filename',
                    )
                    const liveAllowed = isRecording && live && onlyLiveAllowedKeys
                    if (block && !liveAllowed) {
                      notify.warning('Cannot change this item', deleteBlockMessage(block))
                      return
                    }
                    if (selectedEvent.action_type === 'RECORD') {
                      const payload: Record<string, unknown> = {}
                      if (patch.scheduled_time) payload.start_time = patch.scheduled_time
                      if (patch.end_time !== undefined) payload.end_time = patch.end_time
                      if (patch.filename) payload.filename = patch.filename
                      if (patch.note !== undefined) payload.note = patch.note
                      api
                        .patch(`/recordings/${selectedEvent.id}`, payload)
                        .then(() => {
                          scheduleQuery.refetch()
                          notify.success('Saved')
                        })
                        .catch((error) => handleMutationError(error, 'Could not save the change'))
                      return
                    }
                    updateEvent.mutate(
                      { id: selectedEvent.id, version: selectedEvent.version, ...patch },
                      {
                        onSuccess: () => notify.success('Saved'),
                        onError: (error) => handleMutationError(error, 'Could not save the change'),
                      },
                    )
                  }}
                  onDelete={() => selectedEvent && setPendingDelete([selectedEvent.id])}
                  onCancel={() => selectEvent(null)}
                  onOpenChain={() => selectedEvent && openChainForEvent(selectedEvent)}
                  onStopNow={() => {
                    if (!selectedEvent) return
                    stopRecordingNow(selectedEvent.id)
                      .then(() => {
                        scheduleQuery.refetch()
                        notify.success('Stopping', 'The recording ends in under a second.')
                      })
                      .catch((error) => handleMutationError(error, 'Could not stop the recording'))
                  }}
                />
              )}
            </ErrorBoundary>
          </div>
        )}
      </div>

      {/* ---------- overlays ---------- */}

      <LaneContextMenu
        state={laneMenu}
        onClose={() => setLaneMenu(null)}
        onSchedule={() => {
          if (!laneMenu) return
          if (laneMenu.lane === 'FILE') {
            setRecordTarget({ pipelineId: laneMenu.pipelineId, startMs: laneMenu.startMs })
          } else {
            openPicker(laneMenu.pipelineId, laneMenu.lane, laneMenu.startMs)
          }
        }}
        onDeleteNearby={(ids) => setPendingDelete(ids)}
        onStopNow={stopHeldNow}
      />

      <MediaPicker
        open={picker !== null}
        onOpenChange={(open) => !open && setPicker(null)}
        items={pickerItems}
        isLoading={pickerMediaQuery.isLoading}
        acceptableTypes={picker ? LANE_MEDIA_TYPES[picker.lane] : undefined}
        multiple={picker?.lane === 'FILE'}
        title={picker ? `Schedule ${picker.lane === 'FILE' ? 'commercials' : picker.lane.toLowerCase()}` : 'Select media'}
        description={
          picker
            ? `${formatClock(new Date(picker.startMs).toISOString(), CHANNEL_TIMEZONE)} · ${picker.lane} lane`
            : undefined
        }
        onResolve={resolvePicker}
      />

      <RecordModal
        open={recordTarget !== null}
        onOpenChange={(open) => !open && setRecordTarget(null)}
        pipelineId={recordTarget?.pipelineId ?? 0}
        startMs={recordTarget?.startMs ?? Date.now()}
        nextStartMs={recordNextStartMs}
        defaultDurationMs={defaultDurationMs}
        events={events}
        onSuccess={() => scheduleQuery.refetch()}
      />

      {clipMenu && (
        <div
          className="fixed inset-0 z-40"
          aria-hidden
          onPointerDown={() => setClipMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            setClipMenu(null)
          }}
        />
      )}
      {clipMenu && (() => {
        const ev = events.find((e) => e.id === clipMenu.eventId)
        if (!ev) return null

        // A commercial inside a break shares its edges with its neighbours, so
        // "duplicate after this clip" would land on top of the next one. Insert
        // the copy after the whole break instead: same duration, same media,
        // 10s clear of everything that already airs.
        const chain = ev.media_lane === 'FILE' ? chainMembersFor(events, ev) : [ev]
        const chainEnd = Math.max(...chain.map((member) => eventEndMs(member)))
        const duration = eventEndMs(ev) - eventStartMs(ev)
        const dupStart = chainEnd + 10_000
        const dupEnd = dupStart + duration
        const conflict = events.some(
          (other) =>
            other.id !== ev.id &&
            other.pipeline === ev.pipeline &&
            eventStartMs(other) < dupEnd &&
            eventEndMs(other) > dupStart,
        )
        const canDuplicate = ev.action_type === 'RECORD' && duration >= 10_000 && !conflict

        // The same rules the inspector uses. A live item is stopped, not
        // deleted; a queued one is frozen for its last fifteen seconds; a past
        // one is history. The menu says which, rather than silently doing
        // nothing when the button is pressed.
        const deleteReason = deleteBlock(ev, now)
        const stopAvailable = ev.action_type === 'RECORD' && isLiveAt(ev, now)
        const stopAllowed = stopAvailable && canStopRecording(ev, now)
        const stopInMs = stopAvailable ? recordingStopInMs(ev, now) : 0

        const left = Math.min(clipMenu.clientX, window.innerWidth - 180)
        const top = Math.min(clipMenu.clientY, window.innerHeight - 100)

        return (
          <div
            role="menu"
            className="animate-in-fade fixed z-50 min-w-44 overflow-hidden rounded-lg border border-line bg-raised p-1 shadow-lg"
            style={{ left, top }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              disabled={!canDuplicate}
              title={
                canDuplicate
                  ? `Copy after this ${chain.length > 1 ? 'break' : 'item'}, 10s later`
                  : conflict
                    ? 'No room after this break before the next item'
                    : 'This item cannot be duplicated'
              }
              onClick={() => {
                if (!canDuplicate) return
                const suffix = recordingSuffix(ev.media_title)
                api
                  .post('/recordings/', {
                    port: ev.pipeline,
                    filename: `${recordingPrefix(dupStart)}${suffix}`,
                    filepath: ev.media_file_path,
                    start_time: new Date(dupStart).toISOString(),
                    end_time: new Date(dupEnd).toISOString(),
                    status: 'SCHEDULED',
                  })
                  .then(() => {
                    scheduleQuery.refetch()
                    setClipMenu(null)
                    notify.success('Duplicated')
                  })
                  .catch((error) => handleMutationError(error, 'Could not duplicate'))
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs text-default transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Duplicate
            </button>
            {stopAvailable && (
              <>
                <div className="my-1 h-px bg-line" />
                <button
                  type="button"
                  role="menuitem"
                  disabled={!stopAllowed}
                  title={
                    stopAllowed
                      ? 'Stop this recording now'
                      : `Stoppable in ${Math.ceil(stopInMs / 1000)}s — a recording must run for at least 10 seconds`
                  }
                  onClick={() => {
                    if (!stopAllowed) return
                    stopRecordingNow(ev.id)
                      .then(() => {
                        scheduleQuery.refetch()
                        setClipMenu(null)
                        notify.success('Stopping', 'The recording ends in under a second.')
                      })
                      .catch((error) => handleMutationError(error, 'Could not stop the recording'))
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs text-danger transition-colors hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <Square className="h-3.5 w-3.5" />
                  Stop recording
                </button>
              </>
            )}
            <div className="my-1 h-px bg-line" />
            <button
              type="button"
              role="menuitem"
              disabled={deleteReason !== null}
              title={deleteReason ? deleteBlockMessage(deleteReason) : 'Remove this item'}
              onClick={() => {
                if (deleteReason) return
                setClipMenu(null)
                // Same confirmation path as the inspector's Delete: the menu
                // raises the warning modal, it never deletes on the spot.
                setPendingDelete([ev.id])
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs text-danger transition-colors hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Remove
            </button>
          </div>
        )
      })()}

      <ChainModal
        open={chainTarget !== null}
        onOpenChange={(open) => !open && setChainTarget(null)}
        members={chainMembers}
        routeRef={selectedPipeline?.secondary_route_ref ?? 'route://2'}
        isSaving={retimeBatch.isPending}
        onCommit={commitChainOrder}
        onDeleteMember={(ids) => {
          deleteEvents.mutate(ids, {
            onSuccess: () => setChainTarget(null),
            onError: (error) => handleMutationError(error, 'Could not remove the item'),
          })
        }}
        onAddMember={() => {
          const target = chainTarget
          setChainTarget(null)
          if (target) openPicker(target.pipelineId, 'FILE', Date.parse(chainMembers[0]?.event.scheduled_time ?? '') || Date.now())
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete scheduled item"
        description={
          pendingDelete && pendingDelete.length > 1
            ? `This removes ${pendingDelete.length} items from the schedule and tells the playout agent to forget them.`
            : 'This removes the item from the schedule and tells the playout agent to forget it. This cannot be undone.'
        }
        confirmLabel="Delete"
        loading={deleteEvents.isPending}
        onConfirm={() => {
          if (!pendingDelete) return
          // Re-check at the moment of confirmation. The dialog can sit open
          // while an item crosses its fifteen-second cutoff or starts
          // recording, and a stale green light would send a delete the server
          // is about to refuse anyway.
          const at = Date.now()
          const byId = new Map(events.map((event) => [event.id, event]))
          const blocked = pendingDelete.filter((id) => {
            const event = byId.get(id)
            return !event || !canDeleteAt(event, at)
          })
          const allowed = pendingDelete.filter((id) => !blocked.includes(id))

          if (allowed.length === 0) {
            const first = byId.get(pendingDelete[0])
            const reason = first ? deleteBlock(first, at) : null
            notify.warning(
              'Cannot delete this item',
              reason
                ? deleteBlockMessage(reason)
                : 'It is no longer in the schedule.',
            )
            setPendingDelete(null)
            return
          }

          if (blocked.length > 0) {
            notify.warning(
              `${blocked.length} item${blocked.length === 1 ? '' : 's'} kept`,
              'Items that are recording, queued or in the past cannot be deleted.',
            )
          }

          deleteEvents.mutate(allowed, {
            onSuccess: () => setPendingDelete(null),
            onError: (error) => handleMutationError(error, 'Could not delete the item'),
          })
        }}
      >
        {pendingDelete && pendingDelete.length === 1 && (
          <CancelAlternative
            id={pendingDelete[0]}
            onCancel={(id) => {
              cancelEvent.mutate(id, { onSuccess: () => setPendingDelete(null) })
            }}
            onDone={() => setPendingDelete(null)}
          />
        )}
      </ConfirmDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------

function CancelAlternative({
  id,
  onCancel,
  onDone,
}: {
  id: number
  onCancel: (id: number) => void
  onDone: () => void
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onCancel(id)
        onDone()
      }}
      className="mt-3 inline-flex items-center gap-1.5 text-2xs font-medium text-accent hover:underline"
    >
      Prefer a soft cancel? Mark it CANCELLED instead of deleting
    </button>
  )
}

function chainMembersFor(events: ScheduleEvent[], event: ScheduleEvent): ScheduleEvent[] {
  if (event.media_lane !== 'FILE') return [event]
  const chain = groupIntoChains(
    events.filter((candidate) => candidate.pipeline === event.pipeline && candidate.media_lane === 'FILE'),
  ).find((group) => group.some((member) => member.id === event.id))
  return chain ?? [event]
}

/** Typed, code-aware error surface (FR-ERR-02). */
function handleMutationError(error: unknown, fallback: string): void {
  if (!isApiError(error)) {
    notify.error(fallback, 'Could not reach the IngestX server.')
    return
  }
  const apiError = error as ApiError
  switch (apiError.code) {
    case 'LOCKED':
      notify.warning('That item is locked', 'It is inside its 30-second lock window and can no longer be changed.')
      break
    case 'ON_AIR':
      notify.warning('That item is on air', 'On-air items cannot be moved or deleted.')
      break
    case 'DELETE_BLOCKED':
      notify.warning('Cannot delete this item', apiError.message)
      break
    case 'EDIT_BLOCKED':
      notify.warning('This item is frozen', apiError.message)
      break
    case 'STOP_TOO_SOON':
      notify.warning('The recording just started', apiError.message)
      break
    case 'NOT_RECORDING':
      notify.warning('That recording is not running', apiError.message)
      break
    case 'OVERLAP':
      notify.warning('Overlaps an existing item', 'Same lane, same time. Move it clear of the other clip.')
      break
    case 'IN_PAST':
      notify.warning('That time has passed', 'Pick a start time in the future.')
      break
    case 'VERSION_MISMATCH':
      notify.error(
        'Someone else changed this item',
        'Reloading the schedule so you can see their version.',
        { label: 'Reload', onClick: () => window.location.reload() },
      )
      break
    case 'MEDIA_INACTIVE':
      notify.warning('That media is deactivated', 'Activate it in the Navigator first.')
      break
    case 'TEMPLATE_MISSING':
      notify.warning('That graphics item has no template', 'Assign a GraphicsTemplate in the Navigator first.')
      break
    case 'LANE_TYPE_MISMATCH':
      notify.warning('That media does not fit this lane', apiError.message)
      break
    case 'END_TIME_REQUIRED':
      notify.warning('Held graphics need an end time', 'Set one in the inspector.')
      break
    case 'AGENT_UNREACHABLE':
      notify.warning('The playout agent is unreachable', 'The change is saved and will be pushed when it reconnects.')
      break
    case 'RATE_LIMITED':
      notify.warning('Too many requests', 'Slow down for a moment.')
      break
    default:
      notify.error(fallback, apiError.message)
  }
}
