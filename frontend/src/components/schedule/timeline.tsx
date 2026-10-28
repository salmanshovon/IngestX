import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { MonitorPlay } from 'lucide-react'

import type { MediaLane, Pipeline, ScheduleEvent } from '@/api/types'
import { CHANNEL_TIMEZONE, LOCK_WINDOW_MS } from '@/config'
import { cn } from '@/lib/cn'
import { defaultRecordMsFromMinutes } from '@/lib/recording'
import { formatClock, formatDate, formatElapsed, formatShortDuration, displayTitle, toNumber } from '@/lib/format'
import { nextScheduledStart, startImmediateRecording, stopRecordingNow } from '@/lib/recording'
import { useRecordSettings } from '@/hooks/use-playout-data'
import {
  LANE_DEFINITIONS,
  NOW_ANCHOR,
  ZOOM_LEVELS_MS,
  anchorNow,
  buildTicks,
  computeGeometry,
  eventEndMs,
  eventStartMs,
  groupIntoChains,
  isVisible,
  playbackPhase,
  type ClipGeometry,
  type PlaybackPhase,
  type Tick,
  type Viewport,
} from '@/lib/timeline'
import { useUiStore } from '@/stores/ui-store'
import { notify } from '@/stores/notification-store'
import { Tooltip } from '@/components/ui/tooltip'
import { AgentDot, Badge, EmptyState } from '@/components/ui/primitives'
import { Clip, clipTooltip } from './clip'
import type { DragState } from '@/hooks/use-timeline-drag'

/**
 * Width of the per-pipeline left panel.
 *
 * Sized to the preview monitor rather than the other way round: the panel has
 * to hold identity, preview and now/next in the same vertical budget as the
 * lanes, and the preview is the only element that scales with width.
 */
const PANEL_WIDTH = 176
const RULER_HEIGHT = 30
const MIN_LANE_HEIGHT = 24

export interface TimelineProps {
  pipelines: Pipeline[]
  events: ScheduleEvent[]
  viewport: Viewport
  now: number
  nowMode: 'marker' | 'timeline'
  selectedEventId: number | null
  drag: DragState | null
  onSelect: (id: number | null) => void
  /** Double-clicking an item opens it in the inspector. */
  onInspect?: (event: ScheduleEvent) => void
  onClipPointerDown: (args: {
    event: ScheduleEvent
    kind: 'move' | 'resize-start' | 'resize-end'
    startClientX: number
    companions: ScheduleEvent[]
  }) => void
  onLaneContextMenu: (args: {
    pipelineId: number
    lane: MediaLane
    clientX: number
    clientY: number
    startMs: number
  }) => void
  onPipelineSelect: (pipelineId: number) => void
  onClipContextMenu?: (args: { eventId: number; clientX: number; clientY: number }) => void
}

/**
 * The operator timeline.
 *
 * Three ideas carry the whole thing:
 *
 * - **Position is arithmetic, never measurement.** A clip's left/width are
 *   fractions of the viewport, so a pan costs one store write and one render
 *   of the visible subset (FR-ST-03, FR-CL-09).
 * - **Horizontal panning is state, not scrollLeft.** The lane area always fills
 *   the viewport exactly; only vertical scrolling uses native overflow. That
 *   keeps the sticky label column and the sticky ruler trivially in sync.
 * - **The ad lane is a chain view.** Consecutive FILE events are grouped with
 *   the agent's end-to-start rule and drawn as one break with ordered segments,
 *   because that is what actually airs.
 */
export function Timeline({
  pipelines,
  events,
  viewport,
  now,
  nowMode,
  selectedEventId,
  drag,
  onSelect,
  onInspect,
  onClipPointerDown,
  onLaneContextMenu,
  onPipelineSelect,
  onClipContextMenu,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [laneWidth, setLaneWidth] = useState(viewport.widthPx)

  const showGrid = useUiStore((state) => state.showGrid)
  const setLaneWidthStore = useUiStore((state) => state.setLaneWidth)
  const zoomIndex = useUiStore((state) => state.zoomIndex)

  // FR-TL-11: recompute on resize, and on tab activation via rAF.
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const measure = () => {
      const width = Math.max(240, element.clientWidth - PANEL_WIDTH)
      setLaneWidth(width)
      setLaneWidthStore(width)
    }

    measure()
    const observer = new ResizeObserver(() => window.requestAnimationFrame(measure))
    observer.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [setLaneWidthStore])

  const effectiveViewport: Viewport = useMemo(
    () => ({ ...viewport, widthPx: laneWidth }),
    [viewport, laneWidth],
  )

  /** Events bucketed per pipeline and per lane, plus derived ad chains. */
  // `now` is a dependency on purpose: lock and on-air styling are derived from
  // the clock, so the model has to be rebuilt on every tick or clips keep the
  // colouring the server last told us about.
  const model = useMemo(
    () => buildModel(events, now, effectiveViewport, drag),
    [events, now, effectiveViewport, drag],
  )

  const ticks = useMemo(
    () =>
      buildTicks(
        effectiveViewport,
        CHANNEL_TIMEZONE,
        (ms) => formatClock(new Date(ms).toISOString(), CHANNEL_TIMEZONE),
        (ms) => formatDate(new Date(ms).toISOString(), CHANNEL_TIMEZONE),
        // Day key in channel time: "2026-10-16" for the tick at local midnight.
        (ms) =>
          new Intl.DateTimeFormat('en-CA', {
            timeZone: CHANNEL_TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(new Date(ms)),
      ),
    [effectiveViewport],
  )

  // Auto-follow: keep "now" parked at NOW_ANCHOR. In marker mode the viewport
  // is pinned.
  //
  // Driven by its own 1 Hz interval rather than the `now` prop: the prop ticks
  // on every render of the parent, and re-centring from a render is exactly
  // the kind of side-effect-in-render that makes a timeline fight itself.
  //
  // `zoomIndex` is a dependency and `getState()` is read fresh on each tick.
  // Capturing the store object once froze the zoom this anchors against:
  // `zoomIn` swaps in a *new* state object, so a stale reference kept
  // re-centring at the old zoom and left now parked at the wrong fraction.
  useEffect(() => {
    if (nowMode !== 'timeline') return
    const follow = () => {
      const store = useUiStore.getState()
      store.setViewport({ offsetMs: anchorNow(Date.now(), ZOOM_LEVELS_MS[store.zoomIndex]) })
    }
    follow()
    const interval = window.setInterval(follow, 1000)
    return () => window.clearInterval(interval)
  }, [nowMode, zoomIndex])

  const nowOffset = (now - viewport.offsetMs) / viewport.zoomMs
  const showNowLine = nowOffset >= -0.02 && nowOffset <= 1.02

  const handlePanPointerDown = useCallback((nativeEvent: React.PointerEvent) => {
    // FR-DND-01: pan by dragging the ruler or the empty track background.
    if (nativeEvent.button !== 0) return
    const startX = nativeEvent.clientX
    const startOffset = useUiStore.getState().offsetMs
    const msPerPx = viewport.zoomMs / Math.max(1, laneWidth)
    let frame: number | null = null

    const move = (moveEvent: PointerEvent) => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        useUiStore.getState().setViewport({
          offsetMs: startOffset - (moveEvent.clientX - startX) * msPerPx,
        })
      })
    }
    const up = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [viewport.zoomMs, laneWidth])

  if (pipelines.length === 0) {
    return (
      <EmptyState
        icon={<MonitorPlay className="h-5 w-5" />}
        title="No output channels configured"
        description="Create a playout channel under System → Pipelines. Each channel is one on-air output driven by one playout agent."
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden mx-2">
        <div style={{ width: PANEL_WIDTH + laneWidth }}>
          {/* ---------- ruler ---------- */}
          <div
            className="sticky top-0 z-30 flex border-b border-line bg-surface"
            style={{ height: RULER_HEIGHT }}
          >
            <div
              className="sticky left-0 z-40 flex shrink-0 items-end border-r border-line bg-surface px-3 pb-1.5"
              style={{ width: PANEL_WIDTH }}
            >
              <span className="text-2xs font-semibold tracking-wide text-subtle uppercase">
                Channel
              </span>
            </div>
            <div
              className="relative shrink-0 cursor-default select-none active:cursor-grabbing"
              style={{ width: laneWidth }}
              onPointerDown={handlePanPointerDown}
            >
              <Ruler ticks={ticks} viewport={effectiveViewport} />
            </div>
          </div>

          {/* ---------- channels ---------- */}
          {pipelines.map((pipeline, index) => (
            <Fragment key={pipeline.id}>
              {index > 0 && (
                <div
                  key={`gap-${pipeline.id}`}
                  className="relative flex h-6 items-center px-4"
                  aria-hidden
                >
                  <div className="h-1 flex-1 rounded-full bg-gradient-to-r from-transparent via-accent/50 to-transparent" />
                  <div className="mx-3 h-2 w-2 rotate-45 rounded-sm bg-accent/70 shadow-sm" />
                  <div className="h-1 flex-1 rounded-full bg-gradient-to-r from-transparent via-accent/50 to-transparent" />
                </div>
              )}
              <ChannelBlock
              key={pipeline.id}
              pipeline={pipeline}
              model={model}
              viewport={effectiveViewport}
              now={now}
              nowMode={nowMode}
              showNowLine={showNowLine}
              nowOffset={nowOffset}
              showGrid={showGrid}
              selectedEventId={selectedEventId}
              drag={drag}
              onSelect={onSelect}
              onInspect={onInspect}
              onClipPointerDown={onClipPointerDown}
              onLaneContextMenu={onLaneContextMenu}
              onPanPointerDown={handlePanPointerDown}
              onPipelineSelect={onPipelineSelect}
              onClipContextMenu={onClipContextMenu}
            />
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

interface LaneModel {
  clips: Array<{ event: ScheduleEvent; geometry: ClipGeometry }>
  chains: Array<{ id: number; members: Array<{ event: ScheduleEvent; geometry: ClipGeometry }>; geometry: ClipGeometry }>
  held: Array<{ event: ScheduleEvent; geometry: ClipGeometry }>
}

interface ChannelModel {
  laneModels: Record<string, LaneModel>
  events: ScheduleEvent[]
  onAirCount: number
  scheduledCount: number
  nextEvent: ScheduleEvent | null
  currentEvent: ScheduleEvent | null
  deferredCount: number
}

/**
 * Bucket events into lanes, split the FILE lane into ad chains, and fold in any
 * in-flight drag preview. This is a pure function of (events, now, viewport,
 * drag), which is what makes it safe to memoise and cheap to re-run.
 *
 * 
ow is passed in rather than read from the clock so the caller controls
 * when the second resolution happens; reading it here made the memo impure and
 * meant a rebuild could silently disagree with the render that triggered it.
 */
function buildModel(
  events: ScheduleEvent[],
  now: number,
  viewport: Viewport,
  drag: DragState | null,
): Map<number, ChannelModel> {
  const channels = new Map<number, ChannelModel>()

  for (const event of events) {
    let channel = channels.get(event.pipeline)
    if (!channel) {
      channel = {
        laneModels: {},
        events: [],
        onAirCount: 0,
        scheduledCount: 0,
        nextEvent: null,
        currentEvent: null,
        deferredCount: 0,
      }
      channels.set(event.pipeline, channel)
    }
    channel.events.push(event)
  }

  for (const [pipelineId, channel] of channels) {
    // Group FIRST on the true schedule, then apply the drag preview: grouping a
    // previewed position would re-derive the break boundaries mid-gesture.
    for (const definition of LANE_DEFINITIONS) {
      const laneEvents = channel.events.filter((event) => event.media_lane === definition.lane)
      const laneModel: LaneModel = { clips: [], chains: [], held: [] }

      if (definition.lane === 'FILE') {
        for (const chain of groupIntoChains(laneEvents)) {
          const members = chain
            .map((event) => ({ event, geometry: geometryFor(event, viewport, drag, now) }))
            .filter((member) => isVisible(member.geometry, viewport))

          if (members.length === 0) continue

          // A chain spans from its first member's start to its last member's end.
          // Both must be expressed as offsets from the viewport origin -- an
          // absolute epoch divided by the zoom span is a meaningless ratio.
          const chainLeft = (members[0].geometry.startMs - viewport.offsetMs) / viewport.zoomMs
          const chainRight = (members[members.length - 1].geometry.endMs - viewport.offsetMs) / viewport.zoomMs
          const geometry: ClipGeometry = {
            id: chain[0].id,
            pipelineId,
            lane: 'FILE',
            startMs: members[0].geometry.startMs,
            endMs: members[members.length - 1].geometry.endMs,
            left: chainLeft,
            width: chainRight - chainLeft,
            leftPx: chainLeft * viewport.widthPx,
            widthPx: (chainRight - chainLeft) * viewport.widthPx,
            status: members[0].event.status,
            // The break is only *fully* locked once its LAST commercial has
            // entered its lock window. `some` flipped the whole block to the
            // locked styling the moment the first one locked, so a break that
            // was still two-thirds editable looked finished.
            isLocked: members.length > 0 && members.every((m) => m.geometry.isLocked),
            // Not `some`: a break is never on air as a unit, only one commercial
            // at a time. The segments carry the live colour.
            isOnAir: members.some((m) => m.geometry.isOnAir),
            isHeld: false,
          }
          laneModel.chains.push({ id: chain[0].id, members, geometry })
        }
      } else {
        for (const event of laneEvents) {
          const geometry = geometryFor(event, viewport, drag, now)
          if (!isVisible(geometry, viewport)) continue
          if (definition.lane === 'CG') laneModel.clips.push({ event, geometry })
          else laneModel.held.push({ event, geometry })
        }
      }

      channel.laneModels[definition.lane] = laneModel
    }

    const sorted = [...channel.events].sort(
      (a, b) => Date.parse(a.scheduled_time) - Date.parse(b.scheduled_time),
    )
    channel.onAirCount = sorted.filter((e) => e.is_on_air || e.status === 'PLAYING').length
    channel.scheduledCount = sorted.filter((e) => e.status === 'PENDING').length
    channel.currentEvent = sorted.find((e) => eventStartMs(e) <= now && eventEndMs(e) > now) ?? null
    channel.nextEvent = sorted.find((e) => eventStartMs(e) > now && e.status === 'PENDING') ?? null
  }

  return channels
}

/** Apply the in-flight drag preview to a single event, if it is being dragged. */
function geometryFor(
  event: ScheduleEvent,
  viewport: Viewport,
  drag: DragState | null,
  now: number,
): ClipGeometry {
  const geometry = computeGeometry(event, viewport, now, LOCK_WINDOW_MS)
  if (!drag) return geometry
  const previewStart = drag.preview[event.id]
  if (previewStart === undefined) return geometry
  const previewEnd = drag.previewEnd?.[event.id]

  const startMs = previewStart
  const endMs = previewEnd ?? geometry.endMs
  return {
    ...geometry,
    startMs,
    endMs,
    left: (startMs - viewport.offsetMs) / viewport.zoomMs,
    width: (endMs - startMs) / viewport.zoomMs,
    leftPx: ((startMs - viewport.offsetMs) / viewport.zoomMs) * viewport.widthPx,
    widthPx: ((endMs - startMs) / viewport.zoomMs) * viewport.widthPx,
  }
}

// ---------------------------------------------------------------------------
// Channel block
// ---------------------------------------------------------------------------

interface ChannelBlockProps extends Omit<TimelineProps, 'events' | 'viewport' | 'pipelines'> {
  pipeline: Pipeline
  model: Map<number, ChannelModel>
  viewport: Viewport
  now: number
  showNowLine: boolean
  nowOffset: number
  showGrid: boolean
  onPanPointerDown: (event: React.PointerEvent) => void
  onPipelineSelect: (pipelineId: number) => void
}

const ChannelBlock = memo(function ChannelBlock({
  pipeline,
  model,
  viewport,
  now,
  nowMode,
  showNowLine,
  nowOffset,
  showGrid,
  selectedEventId,
  drag,
  onSelect,
  onInspect,
  onClipPointerDown,
  onLaneContextMenu,
  onPanPointerDown,
  onPipelineSelect,
  onClipContextMenu,
}: ChannelBlockProps) {
  const channel = model.get(pipeline.id)
  const laneHeight = MIN_LANE_HEIGHT * 1.5

  const { current, next } = useMemo(() => {
    if (!channel) return { current: null, next: null }

    // ADS ONLY. This panel answers "what is the channel carrying, and what does
    // it carry next" -- and the answer is a programme or a commercial. A DOG,
    // BUG or TICKER is an overlay *on top of* that; listing one here made the
    // panel report "DOG: showbug" as the channel's current output and hide the
    // fact that an ad break was on air at the same time.
    //
    // Phases come from the shared rule rather than the server's on-air flag, so
    // this agrees with the run-down and with the blocks on the lanes.
    const ads = channel.events.filter((event) => event.media_lane === 'FILE')
    const sorted = [...ads].sort((a, b) => eventStartMs(a) - eventStartMs(b))

    const current = sorted.find((event) => playbackPhase(event, now) === 'executing') ?? null
    const next =
      sorted.find(
        (event) => event.status !== 'CANCELLED' && playbackPhase(event, now) === 'upcoming',
      ) ?? null
    return { current, next }
  }, [channel, now])

  // The Start Record button is bounded by the next *recording*, not by whatever
  // programmes or commercials happen to follow on the FILE lane. Those play
  // through the channel while the recorder runs independently.
  const nextRecordingStart = useMemo(
    () => (channel ? nextScheduledStart(channel.events, pipeline.id, now) : null),
    [channel, pipeline.id, now],
  )

  // The panel is exactly as tall as all lanes combined, with no internal
  // scroller: everything in it has to fit that budget or it is cut, so the
  // contents are sized against `lanesHeight` rather than the other way round.
  const lanesHeight = LANE_DEFINITIONS.reduce(
    (sum, def) => sum + Math.round(laneHeight * def.flex),
    0,
  )

  return (
    <section
      className="border-b border-line cursor-pointer"
      aria-label={`Channel ${pipeline.name}`}
      onClick={() => onPipelineSelect(pipeline.id)}
    >
      <div className="flex">
        {/* ---------- left panel ---------- */}
        <div
          className="sticky left-0 z-20 flex shrink-0 flex-col overflow-hidden border-r border-line bg-surface"
          style={{ width: PANEL_WIDTH, height: lanesHeight }}
        >
          {/* identity + status: one row, so the badge shares the title line */}
          <div className="border-b border-line px-2 py-0.5">
            <button
              type="button"
              onClick={() => onPipelineSelect(pipeline.id)}
              className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-hover"
            >
              <AgentDot state={pipeline.engine_state} />
              <span className="min-w-0 flex-1 truncate text-[11px] leading-tight font-semibold text-default">
                {pipeline.name}
              </span>
              {pipeline.is_on_air ? (
                <Badge tone="danger" className="shrink-0 px-1 py-0 text-[9px]">
                  ON AIR
                </Badge>
              ) : (
                <Badge tone="muted" className="shrink-0 px-1 py-0 text-[9px]">
                  STANDBY
                </Badge>
              )}
            </button>
            <div className="tnum truncate px-1 text-[9px] leading-tight text-subtle">
              Ch{pipeline.primary_channel_number} · {pipeline.server_name}
            </div>
          </div>

          {/* preview monitor */}
          <PreviewMonitor pipeline={pipeline} />

          {/* now / next */}
          <NowNext
            pipelineId={pipeline.id}
            current={current}
            next={next}
            now={now}
            nextRecordingStartMs={nextRecordingStart}
          />
        </div>

        {/* ---------- lanes ---------- */}
        <div className="relative shrink-0" style={{ width: viewport.widthPx }}>
          {LANE_DEFINITIONS.map((definition) => {
            const laneModel = channel?.laneModels[definition.lane]
            const height = Math.round(laneHeight * definition.flex)
            const events = laneModel ? [...laneModel.clips, ...laneModel.held, ...laneModel.chains.flatMap((c) => c.members)] : []

            return (
              <div key={definition.lane} className="relative border-b border-line" style={{ height }}>
                {/* lane label tag */}
                <span
                  className="absolute left-1.5 top-1 z-10 inline-flex items-center gap-1 rounded bg-surface/80 px-1.5 py-0.5 text-2xs font-medium text-muted backdrop-blur-sm"
                  aria-hidden
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: laneAccent(definition.lane) }} />
                  {definition.label}
                </span>

                <div
                  className={cn(
                    'group/lane absolute inset-0 cursor-default active:cursor-grabbing',
                    showGrid && 'bg-inset',
                  )}
                  onContextMenu={(nativeEvent) => {
                    nativeEvent.preventDefault()
                    const rect = nativeEvent.currentTarget.getBoundingClientRect()
                    const fraction = (nativeEvent.clientX - rect.left) / Math.max(1, rect.width)
                    onLaneContextMenu({
                      pipelineId: pipeline.id,
                      lane: definition.lane,
                      clientX: nativeEvent.clientX,
                      clientY: nativeEvent.clientY,
                      startMs: viewport.offsetMs + fraction * viewport.zoomMs,
                    })
                  }}
                  onPointerDown={(nativeEvent) => {
                    // Empty track = grab-and-pan, exactly like the ruler. Clips
                    // stop propagation on their own pointerdown, so this only
                    // runs on bare lane space.
                    if ((nativeEvent.target as HTMLElement).closest('[role="button"], [role="group"]')) return
                    onPanPointerDown(nativeEvent)
                  }}
                >
                  {showGrid && <LaneGrid viewport={viewport} />}

                  {/* now line */}
                  {showNowLine && (
                    <div
                      className="pointer-events-none absolute inset-y-0 z-20 w-px"
                      style={{
                        // When following, the now line is pinned at NOW_ANCHOR so
                        // it doesn't swing as the viewport re-centres every second.
                        left:
                          nowMode === 'timeline'
                            ? `${NOW_ANCHOR * 100}%`
                            : `${Math.min(1, Math.max(0, nowOffset)) * 100}%`,
                        background: 'var(--now-line)',
                        boxShadow: '0 0 6px color-mix(in srgb, var(--now-line) 60%, transparent)',
                      }}
                      aria-hidden
                    />
                  )}

                  {/* clips */}
                  {laneModel?.chains.map((chain) => (
                    <AdChain
                      key={`chain-${chain.id}`}
                      chain={chain}
                      selectedEventId={selectedEventId}
                      drag={drag}
                      onSelect={onSelect}
                      now={now}
                      onInspect={onInspect}
                      onClipPointerDown={onClipPointerDown}
                      onContextMenu={onClipContextMenu}
                    />
                  ))}

                  {laneModel?.clips.map((entry) => (
                    <TimelineClip
                      key={entry.event.id}
                      entry={entry}
                      selected={selectedEventId === entry.event.id}
                      dragging={drag?.preview[entry.event.id] !== undefined}
                      onSelect={onSelect}
                      now={now}
                      onInspect={onInspect}
                      onPointerDown={onClipPointerDown}
                      onContextMenu={onClipContextMenu}
                    />
                  ))}

                  {laneModel?.held.map((entry) => (
                    <TimelineClip
                      key={entry.event.id}
                      entry={entry}
                      selected={selectedEventId === entry.event.id}
                      dragging={drag?.preview[entry.event.id] !== undefined}
                      onSelect={onSelect}
                      now={now}
                      onInspect={onInspect}
                      onPointerDown={onClipPointerDown}
                      onContextMenu={onClipContextMenu}
                      loopCycles={loopCycles(entry.event)}
                    />
                  ))}

                  {events.length === 0 && (
                    <span className="pointer-events-none absolute inset-0 flex items-center pl-3 text-[10px] text-subtle opacity-0 transition-opacity group-hover/lane:opacity-100">
                      Drag to pan · right-click to schedule
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
})

/**
 * Preview monitor for the channel.
 *
 * Implemented exactly like the legacy `plyout_main.html` preview box: an
 * `<iframe>` pointed at the channel's MediaMTX stream URL with autoplay
 * enabled. No WebRTC/WHEP negotiation — the browser just plays the stream.
 */
function PreviewMonitor({ pipeline }: { pipeline: Pipeline }) {
  const base = `https://itvstreamx.duckdns.org:8889/${pipeline.name}/`

  return (
    <div
      className="relative mx-auto mb-1 h-[160px] w-full overflow-hidden rounded border border-line bg-black cursor-pointer"
      onClick={() => useUiStore.getState().setActivePipelineId(pipeline.id)}
    >
      <iframe
        src={`${base}?autoplay=true`}
        allow="autoplay"
        title={`Preview of ${pipeline.name}`}
        style={{ width: '100%', height: '100%', border: 'none', pointerEvents: 'none' }}
      />
    </div>
  )
}


/**
 * What the channel is carrying, and what comes next -- Ads lane only.
 *
 * The pair is deliberately about the *programme* (an ad break) rather than
 * about overlays. A held DOG sits over whatever this names; surfacing it here
 * would answer a question nobody asked and hide the break that is actually
 * carrying the channel.
 */
function NowNext({
  pipelineId,
  current,
  next,
  now,
  nextRecordingStartMs,
}: {
  pipelineId: number
  current: ScheduleEvent | null
  next: ScheduleEvent | null
  now: number
  /** Start of the next scheduled recording, even if a programme comes first. */
  nextRecordingStartMs: number | null
}) {
  const queryClient = useQueryClient()
  const recordSettings = useRecordSettings()
  const defaultDurationMs = defaultRecordMsFromMinutes(recordSettings.data?.default_duration_minutes)
  // Local id covers the gap between POST and the next schedule refetch; after
  // that the executing event is the source of truth, so a reload remembers
  // that this channel is already recording.
  const [localRecordingId, setLocalRecordingId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const activeRecordingId =
    localRecordingId ??
    // Only a RECORD event that is currently airing means "this channel is
    // recording". A commercial playing on the FILE lane must not turn the
    // button into a Stop Record for the ad.
    (current && current.action_type === 'RECORD' ? current.id : null)
  const isRecording = activeRecordingId !== null
  const countdown = next ? Math.max(0, Math.ceil((eventStartMs(next) - now) / 1000)) : null

  const label = (event: ScheduleEvent): string =>
    event.media_item === null && event.action_type !== 'RECORD'
      ? 'Missing media'
      : displayTitle(event.media_title) || 'Untitled'

  async function toggleRecording() {
    if (busy) return
    setBusy(true)
    try {
      if (activeRecordingId !== null) {
        await stopRecordingNow(activeRecordingId)
        setLocalRecordingId(null)
        notify.success('Recording stopped')
      } else {
        // Default length, compressed to stop 10s before the next scheduled
        // recording on this channel -- it never overlaps one.
        const result = await startImmediateRecording({
          pipelineId,
          suffix: `CH${pipelineId}`,
          nextStartMs: nextRecordingStartMs,
          defaultDurationMs,
        })
        if ('error' in result) {
          notify.warning('Cannot start recording', result.error)
          return
        }
        setLocalRecordingId(result.id)
        notify.success('Recording started')
      }
      await queryClient.invalidateQueries({ queryKey: ['schedules'] })
    } catch (error) {
      notify.error(
        'Recording command failed',
        error instanceof Error ? error.message : 'The server did not accept it.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-col justify-center gap-1 px-2 py-0.5">
      <div>
        {current ? (
          <div className="flex items-center gap-1">
            <span className="h-1 w-1 shrink-0 animate-onair rounded-full bg-danger" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[10px] leading-[1.15] font-medium text-default">
                {label(current)}
              </span>
              <span className="tnum block truncate text-[9px] leading-[1.15] text-subtle">
                {formatShortDuration((eventEndMs(current) - eventStartMs(current)) / 1000)} ·{' '}
                {formatClock(new Date(eventStartMs(current)).toISOString(), CHANNEL_TIMEZONE)}
              </span>
            </span>
          </div>
        ) : null}
      </div>

      <div>
        {next ? (
          <div className="flex items-center gap-1">
            <span className="h-1 w-1 shrink-0 rounded-full bg-warn" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[10px] leading-[1.15] font-medium text-default">
                {label(next)}
              </span>
              <span className="tnum block truncate text-[9px] leading-[1.15] text-subtle">
                {formatClock(new Date(eventStartMs(next)).toISOString(), CHANNEL_TIMEZONE)} ·{' '}
                {formatShortDuration((eventEndMs(next) - eventStartMs(next)) / 1000)}
              </span>
            </span>
            {countdown !== null && (
              <span className="tnum shrink-0 rounded bg-warn-soft px-1 py-px text-[9px] font-semibold text-warn">
                {countdown}s
              </span>
            )}
          </div>
        ) : null}
      </div>
      <div className="mt-1 flex items-center justify-center">
        <button
          type="button"
          disabled={busy}
          className={`rounded-sm border px-2 py-0.5 text-[10px] font-semibold transition-colors disabled:opacity-50 ${isRecording ? 'bg-[#ffebee] text-[#c62828] border-[#ffcdd2] animate-pulse' : 'bg-[#e8f5e9] text-[#2e7d32] border-[#c8e6c9] hover:bg-[#c8e6c9]'}`}
          onClick={() => void toggleRecording()}
        >
          {busy ? 'Working…' : isRecording ? 'Stop Record' : 'Start Record'}
        </button>
      </div>
    </div>
  )
}

function laneAccent(lane: MediaLane): string {
  switch (lane) {
    case 'FILE':
      return 'var(--info)'
    case 'CG':
      return 'var(--accent)'
    case 'DOG':
      return 'var(--warn)'
    case 'BUG':
      return 'var(--ok)'
    default:
      return 'var(--fg-subtle)'
  }
}

/** `↻ ×N` badge for a held overlay: how many times the file loops in its window. */
function loopCycles(event: ScheduleEvent): number | undefined {
  if (!event.end_time) return undefined
  const fileSeconds = toNumber(event.duration_seconds) ?? 0
  if (fileSeconds <= 0) return undefined
  const span = (eventEndMs(event) - eventStartMs(event)) / 1000
  return Math.max(1, Math.floor(span / fileSeconds))
}

/**
 * Time-based grid lines that move with the viewport.
 *
 * Rendered at actual time positions (not evenly spaced), so they scroll with
 * the timeline and always show real clock times.
 */
function LaneGrid({ viewport }: { viewport: Viewport }) {
  const ticks = useMemo(() => {
    const stepMs = viewport.zoomMs / 8
    const start = Math.floor(viewport.offsetMs / stepMs) * stepMs
    const lines: { left: string; major: boolean }[] = []
    for (let ms = start; ms <= viewport.offsetMs + viewport.zoomMs; ms += stepMs) {
      const fraction = (ms - viewport.offsetMs) / viewport.zoomMs
      lines.push({ left: `${fraction * 100}%`, major: false })
    }
    return lines
  }, [viewport])

  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {ticks.map((tick, index) => (
        <div
          key={index}
          className="absolute inset-y-0 w-px"
          style={{
            left: tick.left,
            background: tick.major ? 'var(--grid-major)' : 'var(--grid-minor)',
          }}
        />
      ))}
    </div>
  )
}


// ---------------------------------------------------------------------------
// Clip wrappers
// ---------------------------------------------------------------------------

function TimelineClip({
  entry,
  selected,
  dragging,
  loopCycles: loops,
  now,
  onSelect,
  onInspect,
  onPointerDown,
  onContextMenu,
}: {
  entry: { event: ScheduleEvent; geometry: ClipGeometry }
  selected: boolean
  dragging: boolean
  loopCycles?: number
  now: number
  onSelect: (id: number | null) => void
  onInspect: TimelineProps['onInspect']
  onPointerDown: TimelineProps['onClipPointerDown']
  onContextMenu?: TimelineProps['onClipContextMenu']
}) {
  const { event, geometry } = entry

  const handlePointerDown = useCallback(
    (nativeEvent: React.PointerEvent) => {
      nativeEvent.stopPropagation()
      const handle = (nativeEvent.target as HTMLElement).closest('[data-resize-handle]') as HTMLElement | null
      if (handle) {
        const kind = handle.dataset.resizeHandle === 'left' ? 'resize-start' : 'resize-end'
        onPointerDown({
          event,
          kind: kind as 'resize-start' | 'resize-end',
          startClientX: nativeEvent.clientX,
          companions: [],
        })
        return
      }
      onSelect(event.id)
      onPointerDown({ event, kind: 'move', startClientX: nativeEvent.clientX, companions: [] })
    },
    [event, onPointerDown, onSelect],
  )

  return (
    <Tooltip content={clipTooltip(event, geometry)}>
      <div className="absolute inset-0">
        <Clip
          event={event}
          geometry={geometry}
          selected={selected}
          dragging={dragging}
          loopCycles={loops}
          now={now}
          onPointerDown={handlePointerDown}
          onDoubleClick={() => onInspect?.(event)}
          onContextMenu={(nativeEvent) => {
            nativeEvent.preventDefault()
            nativeEvent.stopPropagation()
            onContextMenu?.({ eventId: event.id, clientX: nativeEvent.clientX, clientY: nativeEvent.clientY })
          }}
        />
      </div>
    </Tooltip>
  )
}

/**
 * One ad break (FR-CL-02).
 *
 * Drawn as a single bordered block with ordered segments, because the operator
 * needs to see the *break*, not five separate commercials that happen to be
 * adjacent. Segment fill encodes per-item state: played / on air / queued.
 */
const AdChain = memo(function AdChain({
  chain,
  selectedEventId,
  drag,
  onSelect,
  now,
  onInspect,
  onClipPointerDown,
  onContextMenu,
}: {
  chain: { id: number; members: Array<{ event: ScheduleEvent; geometry: ClipGeometry }>; geometry: ClipGeometry }
  selectedEventId: number | null
  drag: DragState | null
  onSelect: (id: number | null) => void
  now: number
  onInspect: TimelineProps['onInspect']
  onClipPointerDown: TimelineProps['onClipPointerDown']
  onContextMenu?: TimelineProps['onClipContextMenu']
}) {
  const { geometry, members } = chain
  // A resize preview can be attached to any member (the left edge belongs to
  // the first commercial, the right edge to the last), so "is dragging" is no
  // longer "was the first member grabbed".
  const isDragging = members.some((member) => drag?.preview[member.event.id] !== undefined)
  const widthPx = Math.max(1, geometry.widthPx)
  const anySelected = members.some((m) => m.event.id === selectedEventId)

  const first = members[0]
  const last = members[members.length - 1]
  // An edge is only pullable when its own commercial is still movable. A chain
  // whose break has started cannot have its start pulled backwards, and a
  // locked item cannot be touched at all -- hiding the handle rather than
  // showing a dead one is the rule the single clips already follow.
  // A queued or running recording may still be stretched from its ending
  // border (the server accepts an end/duration-only edit on it), even though it
  // is otherwise frozen: its start cannot move and the item cannot be dragged.
  const isStretchableRecording = Boolean(
    last &&
      last.event.action_type === 'RECORD' &&
      last.event.status !== 'COMPLETED' &&
      last.event.status !== 'FAILED' &&
      last.event.status !== 'CANCELLED',
  )
  const canPullStart = Boolean(first && !first.geometry.isLocked && !first.geometry.isOnAir)
  const canPullEnd = isStretchableRecording
    ? true
    : Boolean(last && !last.geometry.isLocked && !last.geometry.isOnAir && !geometry.isLocked)
  const showHandles = widthPx >= 44

  const style: React.CSSProperties = {
    left: `${geometry.left * 100}%`,
    width: `${Math.max(geometry.width * 100, 0.2)}%`,
    background: 'var(--clip-adgroup-bg)',
    borderColor: isDragging
      ? 'var(--accent)'
      : geometry.isLocked
        ? 'var(--clip-adgroup-locked-border)'
        : 'var(--clip-adgroup-border)',
    color: geometry.isLocked ? 'var(--clip-adgroup-locked-fg)' : 'var(--clip-adgroup-fg)',
    // Applied inline rather than via the `shadow-lg` utility: the elevation
    // token is a design-system variable, and a utility that resolves against
    // Tailwind's own shadow scale would ignore the theme (FR-DS-01).
    ...(isDragging ? { zIndex: 30, boxShadow: 'var(--shadow-lg)' } : null),
  }

  const handlePointerDown = useCallback(
    (nativeEvent: React.PointerEvent) => {
      nativeEvent.stopPropagation()
      const target = nativeEvent.target as HTMLElement

      // Resize first: the handles sit on top of the chain and must never start
      // a move. Pulling the left edge changes the first commercial's start;
      // pulling the right edge changes the last one's end, which is exactly
      // what stretches or compresses the whole break.
      const handleEl = target.closest('[data-resize-handle]') as HTMLElement | null
      if (handleEl) {
        const side = handleEl.dataset.resizeHandle === 'left' ? 'left' : 'right'
        const primaryMember = side === 'left' ? members[0] : members[members.length - 1]
        if (!primaryMember) return
        onSelect(primaryMember.event.id)
        onClipPointerDown({
          event: primaryMember.event,
          kind: side === 'left' ? 'resize-start' : 'resize-end',
          startClientX: nativeEvent.clientX,
          companions: [],
        })
        return
      }

      const memberEl = target.closest('[data-member-id]') as HTMLElement | null
      const memberId = memberEl ? Number(memberEl.dataset.memberId) : members[0].event.id
      const primary = members.find((m) => m.event.id === memberId)?.event ?? members[0].event

      onSelect(primary.id)
      // FR-DND-08: the whole chain moves as a unit.
      onClipPointerDown({
        event: primary,
        kind: 'move',
        startClientX: nativeEvent.clientX,
        companions: members.map((m) => m.event).filter((e) => e.id !== primary.id),
      })
    },
    [members, onClipPointerDown, onSelect],
  )

  return (
    <div
      role="group"
      data-testid={`chain-${chain.id}`}
      aria-label={`Ad break, ${members.length} commercials`}
      onPointerDown={handlePointerDown}
      onContextMenu={(nativeEvent) => {
        nativeEvent.preventDefault()
        nativeEvent.stopPropagation()
        // Act on the commercial under the pointer, not always the first one.
        // The chain is drawn as one block but each segment is still its own
        // recording, and Duplicate / Remove should feel like they hit what was
        // right-clicked.
        const memberEl = (nativeEvent.target as HTMLElement).closest('[data-member-id]') as HTMLElement | null
        const memberId = memberEl ? Number(memberEl.dataset.memberId) : members[0]?.event.id
        onContextMenu?.({
          eventId: memberId ?? chain.id,
          clientX: nativeEvent.clientX,
          clientY: nativeEvent.clientY,
        })
      }}
      onDoubleClick={(nativeEvent) => {
        nativeEvent.stopPropagation()
        // Inspect the segment under the pointer, not the first commercial in
        // the break; the chain editor is reachable from the inspector.
        const memberEl = (nativeEvent.target as HTMLElement).closest('[data-member-id]') as HTMLElement | null
        const memberId = memberEl ? Number(memberEl.dataset.memberId) : null
        const member = members.find((entry) => entry.event.id === memberId) ?? members[0]
        if (member) onInspect?.(member.event)
      }}
      className={cn(
        'group/chain absolute top-1 bottom-1 overflow-hidden rounded border',
        'transition-[box-shadow,filter] hover:brightness-110',
        isDragging ? 'cursor-grabbing' : 'cursor-grab active:cursor-grabbing',
        anySelected && 'ring-2 ring-[var(--accent)] ring-offset-1 ring-offset-[var(--bg-surface)]',
      )}
      style={style}
    >
      {/* 5px drag bar: a distinct grab affordance for the chain (FR-DND-08). */}
      <span
        className="absolute inset-x-0 top-0 h-1 cursor-grab"
        style={{ background: 'color-mix(in srgb, currentColor 22%, transparent)' }}
        aria-hidden
      />

      <div className="flex h-full w-full">
        {members.map((member, index) => {
          const phase = playbackPhase(member.event, now)
          const tone = SEGMENT_TONE[phase]
          // A recording is drawn through this same chain component (as a
          // one-member chain), but it is not an ad break: its executing chip
          // reads REC, and a lone segment has no meaningful "1/1" position.
          const isRecording = member.event.action_type === 'RECORD'
          const phaseLabel = isRecording ? 'REC' : tone.label
          const recordingElapsedMs =
            isRecording && phase === 'executing' ? Math.max(0, now - member.geometry.startMs) : null
          const title = displayTitle(member.event.media_title) || 'Untitled'
          const startMs = member.geometry.startMs
          const endMs = member.geometry.endMs
          const spanMs = Math.max(0, endMs - startMs)
          // Actual rendered width of THIS commercial, not an average across
          // the break: the thresholds below gate text, and an average made a
          // short ad in a long break draw labels it had no room for.
          const segmentPx = Math.max(1, member.geometry.widthPx)
          const progress =
            phase === 'executing' && spanMs > 0
              ? Math.min(1, Math.max(0, (now - startMs) / spanMs))
              : null

          return (
          // Every segment gets the same rich hover card a standalone clip has.
          // Segments are usually only a few seconds wide, so the tooltip is
          // often the ONLY place the commercial's identity is available at all.
          <Tooltip key={member.event.id} content={clipTooltip(member.event, member.geometry)}>
            <div
              data-member-id={member.event.id}
              data-phase={phase}
              className="relative h-full min-w-0 overflow-hidden border-r border-black/20 last:border-r-0"
              style={{
                flexGrow: Math.max(0.001, spanMs),
                flexBasis: 0,
                background: segmentFill(phase),
                color: 'var(--clip-adgroup-fg)',
              }}
            >
              {/* Phase wash + left rail: colour is readable before any text. */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background: `linear-gradient(180deg, ${tone.tint} 0%, transparent 68%)`,
                }}
              />
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
                style={{
                  background: tone.accent,
                  boxShadow: `0 0 8px color-mix(in srgb, ${tone.accent} 55%, transparent)`,
                }}
              />

              {segmentPx >= 18 ? (
                <div className="relative flex h-full min-w-0 flex-col justify-center gap-1 px-2 py-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {members.length > 1 && (
                      <span
                        className="tnum shrink-0 rounded px-1 py-px text-[10px] font-bold leading-tight"
                        style={{
                          background: tone.chipBg,
                          color: tone.chipFg,
                          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tone.accent} 35%, transparent)`,
                        }}
                        title={`File ${index + 1} of ${members.length} in this break`}
                      >
                        {index + 1}/{members.length}
                      </span>
                    )}
                    <span
                      className="min-w-0 flex-1 truncate text-xs leading-tight font-semibold"
                      title={title}
                    >
                      {title}
                    </span>
                    {segmentPx >= 150 && (
                      <span
                        className="shrink-0 rounded px-1 py-px text-[9px] font-bold tracking-wider uppercase"
                        style={{ background: tone.chipBg, color: tone.chipFg }}
                      >
                        {phaseLabel}
                      </span>
                    )}
                  </div>

                  {segmentPx >= 56 && (
                    <dl
                      className="tnum grid w-full max-w-[140px] grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px] leading-tight"
                      style={{ color: 'color-mix(in srgb, var(--clip-adgroup-fg) 88%, transparent)' }}
                    >
                      <dt
                        className="text-[9px] tracking-wider uppercase"
                        style={{ color: tone.accent, opacity: 0.75 }}
                      >
                        Start
                      </dt>
                      <dd className="text-right font-medium">
                        {formatClock(new Date(startMs).toISOString(), CHANNEL_TIMEZONE)}
                      </dd>
                      <dt
                        className="text-[9px] tracking-wider uppercase"
                        style={{ color: tone.accent, opacity: 0.75 }}
                      >
                        End
                      </dt>
                      <dd className="text-right font-medium">
                        {formatClock(new Date(endMs).toISOString(), CHANNEL_TIMEZONE)}
                      </dd>
                      {segmentPx >= 80 && (
                        <>
                          <dt
                            className="text-[9px] tracking-wider uppercase"
                            style={{ color: tone.accent, opacity: 0.75 }}
                          >
                            Duration
                          </dt>
                          <dd className="text-right font-semibold" style={{ color: tone.accent }}>
                            {formatShortDuration(spanMs / 1000)}
                          </dd>
                        </>
                      )}
                      {segmentPx >= 150 && member.event.note && (
                        <>
                          <dt
                            className="text-[9px] tracking-wider uppercase"
                            style={{ color: tone.accent, opacity: 0.75 }}
                          >
                            Note
                          </dt>
                          <dd className="truncate text-right italic opacity-75" title={member.event.note}>
                            {member.event.note}
                          </dd>
                        </>
                      )}
                    </dl>
                  )}

                  {progress !== null && (
                    <span
                      aria-hidden
                      className="absolute inset-x-0 bottom-0 h-1 overflow-hidden"
                      style={{ background: 'rgb(255 255 255 / 0.14)' }}
                    >
                      <span
                        className="block h-full rounded-r-full"
                        style={{ width: `${progress * 100}%`, background: tone.accent }}
                      />
                    </span>
                  )}
                </div>
              ) : (
                <span className="sr-only">{title}</span>
              )}

              {/* Elapsed wall time of a capture that is still running. Kept out
                  of the centred info grid so it reads as a live counter in the
                  corner rather than another static field. `now` ticks at 1 Hz,
                  so it advances without waiting for the next schedule poll. */}
              {recordingElapsedMs !== null && (
                <span
                  className="tnum pointer-events-none absolute bottom-1.5 left-2 text-lg leading-none font-bold tracking-tight"
                  style={{ color: tone.accent, textShadow: '0 1px 3px rgb(0 0 0 / 0.55)' }}
                >
                  {formatElapsed(recordingElapsedMs)}
                </span>
              )}
            </div>
          </Tooltip>
          )
        })}
      </div>

      {/* Pullable start / end borders. They belong to the chain, not to a
          segment: one sits over the first commercial's left edge and one over
          the last commercial's right edge, so the break stretches as a unit. */}
      {showHandles && canPullStart && (
        <ChainResizeHandle side="left" eventId={first.event.id} active={anySelected || isDragging} />
      )}
      {showHandles && canPullEnd && (
        <ChainResizeHandle side="right" eventId={last.event.id} active={anySelected || isDragging} />
      )}
    </div>
  )
})

/**
 * Which colour an ad-break segment carries.
 *
 * The fill already encodes the phase. The tone adds the parts fill cannot: a
 * readable accent for the rail and chips, and a matching wash at the top. It is
 * a separate map rather than a chain of conditionals so the four phases stay
 * visually consistent wherever they appear.
 */
const SEGMENT_TONE: Record<
  PlaybackPhase,
  { accent: string; label: string; chipBg: string; chipFg: string; tint: string }
> = {
  upcoming: {
    accent: 'var(--warn)',
    label: 'Queued',
    chipBg: 'color-mix(in srgb, var(--warn) 20%, transparent)',
    chipFg: 'var(--warn)',
    tint: 'color-mix(in srgb, var(--warn) 13%, transparent)',
  },
  executing: {
    accent: 'var(--danger)',
    label: 'On air',
    chipBg: 'color-mix(in srgb, var(--danger) 26%, transparent)',
    chipFg: 'var(--clip-live-fg)',
    tint: 'color-mix(in srgb, var(--danger) 18%, transparent)',
  },
  executed: {
    accent: 'var(--ok)',
    label: 'Played',
    chipBg: 'color-mix(in srgb, var(--ok) 20%, transparent)',
    chipFg: 'var(--ok)',
    tint: 'color-mix(in srgb, var(--ok) 13%, transparent)',
  },
  failed: {
    accent: 'var(--warn)',
    label: 'Failed',
    chipBg: 'color-mix(in srgb, var(--danger) 24%, transparent)',
    chipFg: 'var(--clip-error-fg)',
    tint: 'color-mix(in srgb, var(--danger) 16%, transparent)',
  },
}

/**
 * Resize grip on an ad-break edge.
 *
 * Ten pixels, not six: this is the only hit target a break's duration change
 * has, and it has to survive a click on a 24px-tall lane row. Always partly
 * visible so the edge reads as draggable before the pointer arrives, and full
 * strength on hover or while selected.
 */
function ChainResizeHandle({
  side,
  eventId,
  active,
}: {
  side: 'left' | 'right'
  eventId: number
  active: boolean
}) {
  return (
    <span
      data-resize-handle={side}
      data-event-id={eventId}
      title={side === 'left' ? 'Drag to change the start time' : 'Drag to change the end time'}
      aria-hidden
      className={cn(
        'absolute inset-y-0 z-20 flex w-2.5 touch-none items-center justify-center',
        side === 'left' ? 'left-0 rounded-l' : 'right-0 rounded-r',
        'cursor-ew-resize transition-opacity',
        active ? 'opacity-100' : 'opacity-45 group-hover/chain:opacity-100',
      )}
      style={{
        background:
          side === 'left'
            ? 'linear-gradient(90deg, rgb(255 255 255 / 0.32), rgb(255 255 255 / 0))'
            : 'linear-gradient(270deg, rgb(255 255 255 / 0.32), rgb(255 255 255 / 0))',
      }}
    >
      <span
        className="h-7 w-1 rounded-full bg-white/80"
        style={{ boxShadow: '0 0 5px rgb(0 0 0 / 0.55)' }}
        aria-hidden
      />
    </span>
  )
}

/**
 * Segment colour inside an ad break.
 *
 * Driven by the same {@link playbackPhase} the run-down rows use, so the list
 * and the timeline always agree, and so each commercial is judged on its OWN
 * window.
 *
 * It used to read `geometry.isOnAir || status === 'PLAYING'` first. Both are
 * poll-lagging: the server stamps `PLAYING` on every member of a break at once,
 * which turned a four-commercial break entirely red at the start of the break
 * and left it there after the break had finished. Interval containment cannot
 * do either -- exactly one segment is `executing` at any instant, and each one
 * turns green the moment it ends.
 */
function segmentFill(phase: PlaybackPhase): string {
  switch (phase) {
    case 'executing':
      return 'var(--seg-onair)'
    case 'failed':
      return 'var(--seg-failed)'
    case 'executed':
      return 'var(--seg-played)'
    default:
      return 'var(--seg-queued)'
  }
}

// ---------------------------------------------------------------------------
// Ruler
// ---------------------------------------------------------------------------

function Ruler({ ticks, viewport }: { ticks: Tick[]; viewport: Viewport }) {
  return (
    <div className="absolute inset-0">
      {ticks.map((tick) => {
        // Positioned against the viewport, not against the first tick.
        //
        // Anchoring to `ticks[0]` made the ruler jump a whole step each time the
        // first tick changed, so while the timeline slid continuously the
        // labels sat still. Against `offsetMs` the whole ruler translates in
        // lockstep with the lanes and the now marker.
        const fraction = (tick.ms - viewport.offsetMs) / viewport.zoomMs

        return (
          <div key={tick.ms} className="absolute inset-y-0" style={{ left: `${fraction * 100}%` }}>
            <div
              className="absolute bottom-0 left-0 w-px"
              style={{
                height: tick.major || tick.dayBoundary ? 14 : 6,
                background: tick.dayBoundary
                  ? 'var(--accent)'
                  : tick.major
                    ? 'var(--border-strong)'
                    : 'var(--border-subtle)',
              }}
            />
            {tick.major && (
              <span className="tnum absolute bottom-2.5 left-1 text-[10px] font-medium text-muted">
                {tick.label}
              </span>
            )}
            {/*
              The date goes in the gap *after* this tick, on the same baseline
              as the time labels but nudged right past this tick's own text.
              Stacking it on a separate line above meant it collided with the
              time of whichever tick it sat over, and the ruler band is only
              30px tall -- there is no free line to move it to.
            */}
            {tick.dateLabel && (
              <span
                className={cn(
                  'tnum pointer-events-none absolute bottom-2.5 left-6 whitespace-nowrap text-[9px] font-medium',
                  tick.dayBoundary ? 'text-accent' : 'text-subtle',
                )}
              >
                {tick.dateLabel}
              </span>
            )}
          </div>
        )
      })}
      <span className="sr-only">
        Time ruler from {formatDate(new Date(ticks[0]?.ms ?? 0).toISOString(), CHANNEL_TIMEZONE)}
      </span>
    </div>
  )
}

