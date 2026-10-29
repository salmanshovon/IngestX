import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { ListVideo, Radio, ScrollText, X } from 'lucide-react'



import type { MediaLane, ScheduleEvent } from '@/api/types'

import { CHANNEL_TIMEZONE } from '@/config'

import { cn } from '@/lib/cn'

import { displayTitle, formatShortDuration } from '@/lib/format'

import {
  eventEndMs,
  eventStartMs,
  groupIntoChains,
  playbackPhase,
  workflowStatus,
  WORKFLOW_LABEL,
  type WorkflowStatus,
} from '@/lib/timeline'

import { Badge, type BadgeTone } from '@/components/ui/primitives'

import { Tooltip } from '@/components/ui/tooltip'



/**

 * One row of the run-down.

 *

 * `live` is a first-class row, not an absence. Physically the channel always

 * carries *something*: between two ad breaks it is carrying the buffered

 * programme. Rendering that as a row is what makes the list read as the

 * channel's actual output rather than a shopping list of commercials.

 */

type Row =

  | {

      kind: 'event'

      key: string

      event: ScheduleEvent

      startMs: number

      endMs: number

      phase: 'executed' | 'executing' | 'upcoming' | 'failed'

      /** Files in the same ad break as this one, for the chain badge. */

      chainSize: number

      chainIndex: number

    }

  | { kind: 'live'; key: string; startMs: number; endMs: number; phase: 'executing' | 'upcoming' | 'executed' }

  | { kind: 'idle'; key: string; startMs: number; endMs: number }



const OVERLAY_LANES: ReadonlySet<MediaLane> = new Set(['CG', 'DOG', 'BUG', 'TICKER'])



export interface RunDownProps {

  events: ScheduleEvent[]

  pipelineName: string

  now: number

  nowMode: 'marker' | 'timeline'

  selectedEventId: number | null

  onSelect: (id: number | null) => void

  /** Double-click: open this item in the inspector. */
  onInspect: (event: ScheduleEvent) => void

  onClose: () => void

}



/**

 * Vertical run-down.

 *

 * The operator's "what is actually going out right now, and what is next"

 * list. It shows the FILE lane as the spine with the live programme rendered

 * between chunks, plus the overlay lanes inline -- a DOG that is on air is

 * part of the output, and a run-down that silently omits it would be lying.

 *

 * Auto-scroll is tied to the same now-mode switch as the timeline, by the same

 * button. Following means "keep the current moment in view"; pinned means

 * "leave my scroll where I put it". Coupling them is deliberate: two controls

 * that look related but move independently is how an operator ends up

 * scrolling a list that jumps on its own.

 */

export function RunDown({

  events,

  pipelineName,

  now,

  nowMode,

  selectedEventId,

  onSelect,

  onInspect,

  onClose,

}: RunDownProps) {

  const listRef = useRef<HTMLOListElement>(null)

  const activeRef = useRef<HTMLLIElement>(null)



  const rows = useMemo(() => buildRows(events, now), [events, now])



  // Opening the panel must land on whatever is on air, not on the top of a

  // 60-row list. This is unconditional: following state decides whether the

  // list keeps moving afterwards, but the operator asked to see now either way.

  // A layout effect so it happens before paint -- otherwise the list visibly

  // starts at the top and then jumps.

  useLayoutEffect(() => {

    const container = listRef.current

    const active = activeRef.current

    if (!container || !active) return

    container.scrollTop = scrollActiveIntoView(container, active)

    // Deliberately mount-only: the panel remounts on every open, and re-running

    // this as rows change would yank the list back under the operator.

    // eslint-disable-next-line react-hooks/exhaustive-deps

  }, [])



  // Keep the executing row at ~25% from the top *while* following. Gated on

  // now-mode so a pinned list holds whatever the operator scrolled to.

  useEffect(() => {

    if (nowMode !== 'timeline') return

    const container = listRef.current

    const active = activeRef.current

    if (!container || !active) return



    const target = scrollActiveIntoView(container, active)

    // Only scroll if the change is meaningful (avoids jitter on every tick).

    if (Math.abs(container.scrollTop - target) > 2) {

      container.scrollTo({ top: target, behavior: 'smooth' })

    }

  }, [nowMode, rows])



  const counts = useMemo(() => {

    let executing = 0

    let upcoming = 0

    let executed = 0

    for (const row of rows) {

      if (row.kind === 'idle') continue

      if (row.phase === 'executing') executing += 1

      else if (row.phase === 'upcoming') upcoming += 1

      else executed += 1

    }

    return { executing, upcoming, executed }

  }, [rows])



  return (

    <aside

      aria-label="Run down"

      data-testid="run-down"

      className="flex h-full w-full flex-col overflow-hidden border-l border-line bg-surface"

    >

      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">

        <div className="min-w-0">

          <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Run down</h2>

          <p className="truncate text-sm font-bold text-accent">{pipelineName}</p>

          <p className="truncate text-2xs text-subtle">

            {counts.executing} live · {counts.upcoming} upcoming

          </p>

        </div>

        <button

          type="button"

          onClick={onClose}

          aria-label="Close run down"

          className="rounded p-1 text-subtle transition-colors hover:bg-hover hover:text-default"

        >

          <X className="h-4 w-4" />

        </button>

      </header>



      <div className="flex items-center gap-3 border-b border-line px-4 py-1.5 text-[10px] text-subtle">

        <Legend swatch="var(--ok)" label="Done" />

        <Legend swatch="var(--info)" label="Ingesting" />

        <Legend swatch="var(--warn)" label="Testing" />

        <Legend swatch="var(--danger)" label="REC" pulse />

        <Legend swatch="var(--warn)" label="Queued" />

        <Legend swatch="var(--accent)" label="Scheduled" />

      </div>



      <ol ref={listRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="run-down-list">

        {rows.length === 0 ? (

          <li className="px-4 py-10 text-center text-2xs text-subtle">

            <span className="rounded bg-subtle/20 px-2 py-1 text-subtle">Idle</span>

          </li>

        ) : (

          rows.map((row) =>

            row.kind === 'live' ? (

              <LiveRow

                key={row.key}

                row={row}

                now={now}

                activeRef={row.phase === 'executing' ? activeRef : undefined}

              />

            ) : row.kind === 'idle' ? (

              <IdleRow key={row.key} row={row} now={now} activeRef={row.startMs <= now && now < row.endMs ? activeRef : undefined} />

            ) : (

              <EventRow

                key={row.key}

                row={row}

                now={now}

                selected={selectedEventId === row.event.id}

                activeRef={row.phase === 'executing' ? activeRef : undefined}

                onSelect={onSelect}

                onInspect={onInspect}

              />

            ),

          )

        )}

      </ol>



      <footer className="border-t border-line bg-inset px-4 py-2 text-2xs text-subtle">

        {nowMode === 'timeline' ? (

          <span className="inline-flex items-center gap-1.5">

            <Radio className="h-3 w-3 text-accent" />

            Following the clock · list auto-scrolls

          </span>

        ) : (

          <span className="inline-flex items-center gap-1.5">

            <ScrollText className="h-3 w-3" />

            Pinned · list holds your scroll position

          </span>

        )}

      </footer>

    </aside>

  )

}



function Legend({ swatch, label, pulse }: { swatch: string; label: string; pulse?: boolean }) {

  return (

    <span className="inline-flex items-center gap-1">

      <span

        className={cn('h-2 w-2 rounded-sm', pulse && 'animate-onair')}

        style={{ background: swatch }}

        aria-hidden

      />

      {label}

    </span>

  )

}



// ---------------------------------------------------------------------------



function IdleRow({ row, now, activeRef }: { row: Extract<Row, { kind: 'idle' }>; now: number; activeRef?: React.Ref<HTMLLIElement> }) {
  const isNow = row.startMs <= now && now < row.endMs

  const span = row.endMs - row.startMs

  const progress = isNow && span > 0 ? Math.max(0, Math.min(1, (now - row.startMs) / span)) : null



  return (

    <li ref={activeRef} className="relative">

      <div

        className={cn(

          'flex w-full items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 py-2.5 text-left',

          isNow && 'bg-accent-soft',

        )}

      >

        <span

          className={cn('h-12 w-0.5 shrink-0 rounded-full', isNow && 'animate-onair')}

          style={{ background: isNow ? 'var(--accent)' : 'var(--border-subtle)' }}

          aria-hidden

        />

        <span className="min-w-0 flex-1">

          <span className={cn('text-sm font-medium', isNow ? 'text-accent' : 'text-subtle')}>IDLE</span>

          <span className="tnum mt-0.5 block text-xs text-subtle">

            {formatClockMs(row.startMs)} → {formatClockMs(row.endMs)} ·{' '}
            {formatShortDuration((row.endMs - row.startMs) / 1000)}

          </span>

        </span>

      </div>



      {progress !== null && <ProgressFill progress={progress} label="Idle gap progress" />}

    </li>

  )

}



function EventRow({

  row,

  now,

  selected,

  activeRef,

  onSelect,

  onInspect,

}: {

  row: Extract<Row, { kind: 'event' }>

  now: number

  selected: boolean

  activeRef?: React.Ref<HTMLLIElement>

  onSelect: (id: number | null) => void

  onInspect: (event: ScheduleEvent) => void

}) {

  const { event, phase, chainSize, chainIndex } = row

  const isOverlay = event.media_lane !== null && OVERLAY_LANES.has(event.media_lane)

  const orphaned = event.media_item === null && event.action_type !== 'RECORD'

  const isRecording = event.action_type === 'RECORD'

  const tone = PHASE_TONE[phase]

  // One status vocabulary shared with the timeline chip. TESTING / INGESTING
  // arrive from TaskQue's file pipeline; the rest are clock-derived.
  const workflow = workflowStatus(event, now)

  // Same bar as the live row: how far through the on-air item we are, landing

  // on full exactly as it ends.

  const span = row.endMs - row.startMs

  const progress =

    phase === 'executing' && span > 0 ? Math.max(0, Math.min(1, (now - row.startMs) / span)) : null



  const badge = (

    <Badge

      tone={WORKFLOW_TONE[workflow]}

      className={cn('px-1 py-px text-[9px]', workflow === 'REC' && 'font-semibold tracking-wide')}

    >

      {WORKFLOW_LABEL[workflow]}

    </Badge>

  )



  return (

    <li

      ref={activeRef}

      aria-current={phase === 'executing' ? 'true' : undefined}

      className={cn(progress !== null && 'relative')}

    >

      <button

        type="button"

        onClick={() => onSelect(selected ? null : event.id)}

        onDoubleClick={() => onInspect(event)}

        data-testid={`rundown-event-${event.id}`}

        className={cn(

          'group flex w-full items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 py-1.5 text-left',

          'transition-colors',

          phase === 'executing' && 'bg-danger-soft',

          selected ? 'bg-accent-soft' : 'hover:bg-[var(--bg-hover)]',

        )}

      >

        <span

          className={cn(isRecording ? 'h-12' : 'h-6', 'w-0.5 shrink-0 rounded-full', phase === 'executing' && 'animate-onair')}

          style={{ background: tone }}

          aria-hidden

        />



        <span className="min-w-0 flex-1">

          <span className="flex items-baseline gap-2">

            <span

              className={cn(

                `min-w-0 flex-1 truncate ${isRecording ? 'text-sm' : 'text-[11px]'} leading-tight font-medium`,

                phase === 'executing' ? 'text-danger' : 'text-muted',

              )}

            >

              {orphaned ? 'Missing media' : displayTitle(event.media_title) || 'Untitled'}

            </span>

          </span>



          <span className="mt-0.5 flex items-baseline gap-2">

            <span className={`tnum min-w-0 flex-1 truncate ${isRecording ? "text-xs" : "text-[9px]"} leading-tight text-subtle`}>

              {formatClockMs(row.startMs)} → {formatClockMs(row.endMs)} ·{' '}

              {formatShortDuration((row.endMs - row.startMs) / 1000)}

              {event.template_name ? ` · ${event.template_name}` : ''}

            </span>



            {/* Status, chain position and lane tag share the bottom row so the

                title is never squeezed by a chip. */}

            <span className="flex shrink-0 items-center gap-1">

              {chainSize > 1 && (

                <Tooltip content={`File ${chainIndex + 1} of ${chainSize} in this ad break`}>

                  <Badge tone="muted" className="px-1 py-px text-[9px]">

                    {chainIndex + 1}/{chainSize}

                  </Badge>

                </Tooltip>

              )}

              {isOverlay && <Badge tone="accent" className="px-1 py-px text-[9px]">{event.media_lane}</Badge>}

              {badge}

            </span>

          </span>

        </span>

      </button>



      {progress !== null && <ProgressFill progress={progress} label="Item progress" />}

    </li>

  )

}



/**

 * Elapsed-time bar for whatever is on air right now.

 *

 * One component for live bands and file commercials so the two cannot drift

 * apart visually: an operator watching a break and then the programme that

 * follows it should see the same thing advancing at the same rate.

 */

function ProgressFill({ progress, label }: { progress: number; label: string }) {

  return (

    <div

      className="h-0.5 w-full bg-danger/20"

      role="progressbar"

      aria-label={label}

      aria-valuemin={0}

      aria-valuemax={100}

      aria-valuenow={Math.floor(progress * 100)}

    >

      <div className="h-full bg-danger" style={{ width: `${progress * 100}%` }} />

    </div>

  )

}



function LiveRow({

  row,

  now,

  activeRef,

}: {

  row: Extract<Row, { kind: 'live' }>

  now: number

  activeRef?: React.Ref<HTMLLIElement>

}) {

  const executing = row.phase === 'executing'

  const endsAt = row.endMs



  // The live programme has no scheduled end of its own; what bounds it is the

  // next file that takes the channel. Fill the bar in step with the clock so

  // it reads full exactly when the next programme starts.

  //

  // When the band's own start is unknown ("Channel start") there is no honest

  // duration to divide by, so the row anchors itself to the moment it was

  // first seen on air. The fill still lands on the next start, because both

  // ends of the ratio then advance against the same event.

  // Adjusted during render rather than in an effect: React re-runs the

  // component immediately, so the anchor is set before anything is committed

  // and the bar never paints against a null anchor.

  const [seenAt, setSeenAt] = useState<number | null>(null)

  if (executing && seenAt === null) setSeenAt(now)

  if (!executing && seenAt !== null) setSeenAt(null)



  const anchor = row.startMs === Number.NEGATIVE_INFINITY ? seenAt : row.startMs

  const span = endsAt - (anchor ?? Number.NaN)

  const progress =

    executing && anchor !== null && Number.isFinite(span) && span > 0

      ? Math.max(0, Math.min(1, (now - anchor) / span))

      : null



  return (

    <li

      ref={activeRef}

      data-testid="rundown-live"

      aria-current={executing ? 'true' : undefined}

      className="relative"

    >

      <div

        className={cn(

          'flex w-full items-center gap-2.5 border-y border-[var(--border-subtle)] px-3 py-2',

          executing ? 'bg-danger-soft' : 'bg-sunken',

        )}

      >

        <span

          className={cn('h-8 w-1 shrink-0 rounded-full', executing && 'animate-onair')}

          style={{ background: executing ? 'var(--danger)' : 'var(--info)' }}

          aria-hidden

        />

        <span className="min-w-0 flex-1">

          <span className="flex items-center gap-1.5">

            <ListVideo

              className={cn('h-3 w-3 shrink-0', executing ? 'text-danger' : 'text-info')}

              aria-hidden

            />

            <span

              className={cn(

                'truncate text-xs font-semibold',

                executing ? 'text-default' : 'text-muted',

              )}

            >

              Live programme

            </span>

            {executing && (

              <Badge tone="danger" className="shrink-0 font-semibold tracking-wide">

                ON AIR

              </Badge>

            )}

          </span>

          <span className="tnum mt-0.5 block truncate text-[10px] text-subtle">

            {row.startMs === -Infinity ? 'Channel start' : formatClockMs(row.startMs)} →{' '}

            {endsAt === Number.POSITIVE_INFINITY ? 'runs until stopped' : formatClockMs(endsAt)}

            {Number.isFinite(span) && ` · ${formatShortDuration(span / 1000)}`}

            {endsAt === Number.POSITIVE_INFINITY ? ' · buffered programme ingest' : ''}

          </span>

        </span>

      </div>



      {progress !== null && (

        <ProgressFill progress={progress} label="Live programme progress until the next item" />

      )}

    </li>

  )

}



// ---------------------------------------------------------------------------



const PHASE_TONE: Record<'executed' | 'executing' | 'upcoming' | 'failed', string> = {

  executed: 'var(--clip-done-border)',

  executing: 'var(--clip-live-border)',

  upcoming: 'var(--clip-scheduled-border)',

  failed: 'var(--clip-error-border)',

}

/** Badge colours for the shared workflow vocabulary. */
const WORKFLOW_TONE: Record<WorkflowStatus, BadgeTone> = {
  SCHEDULED: 'accent',
  QUEUED: 'warn',
  REC: 'danger',
  TESTING: 'warn',
  INGESTING: 'info',
  DONE: 'ok',
  FAILED: 'danger',
}



/**

 * Flatten the schedule into a time-ordered run-down.

 *

 * The inter-chunk rule mirrors the agent's: a gap greater than

 * CHAIN_GAP_SECONDS between one file's *end* and the next file's *start* means

 * the channel is carrying live programme in between. Using start-to-start

 * here would hide every route-back, which is the one thing an operator most

 * needs to see.

 */

function buildRows(events: ScheduleEvent[], now: number): Row[] {

  const nowMs = now



  const fileEvents = events

    .filter((event) => event.media_lane === 'FILE')

    .sort((a, b) => eventStartMs(a) - eventStartMs(b))



  const overlays = events

    .filter((event) => event.media_lane !== null && OVERLAY_LANES.has(event.media_lane))

    .sort((a, b) => eventStartMs(a) - eventStartMs(b))



  // Chain membership, so each row can say "2/3 in this break".

  const chains = groupIntoChains(fileEvents)

  const position = new Map<number, { size: number; index: number }>()

  chains.forEach((chain) =>

    chain.forEach((event, index) =>

      position.set(event.id, { size: chain.length, index }),

    ),

  )



  const rows: Row[] = []

  let cursorEnd = Number.NEGATIVE_INFINITY





  const firstStart = fileEvents.length > 0 ? eventStartMs(fileEvents[0]) : Infinity

  cursorEnd = firstStart



  for (const event of fileEvents) {

    const start = eventStartMs(event)

    const end = eventEndMs(event)

    if (start > nowMs + 12 * 60 * 60 * 1000) break // far future, not useful yet



    if (start - cursorEnd > 10_000) {

      rows.push({ kind: 'idle', key: `idle-${cursorEnd}-${start}`, startMs: cursorEnd, endMs: start })

    }



    const position_ = position.get(event.id)

    rows.push({

      kind: 'event',

      key: `event-${event.id}`,

      event,

      startMs: start,

      endMs: end,

      // The shared rule, not a local copy of it: the timeline colours items with

      // this same function, so the list and the blocks can never disagree about

      // what is on air right now.

      phase: playbackPhase(event, nowMs),

      chainSize: position_?.size ?? 1,

      chainIndex: position_?.index ?? 0,

    })

    cursorEnd = end



    // Overlays that start inside this file's window air *with* it.

    for (const overlay of overlays) {

      const overlayStart = eventStartMs(overlay)

      if (overlayStart >= start && overlayStart < end) {

        const overlayEnd = eventEndMs(overlay)

        rows.push({

          kind: 'event',

          key: `event-${overlay.id}`,

          event: overlay,

          startMs: overlayStart,

          endMs: overlayEnd,

          phase: playbackPhase(overlay, nowMs),

          chainSize: 1,

          chainIndex: 0,

        })

      }

    }

  }



  return rows.sort((a, b) => {

    // `Infinity` bounds sort to the end, which is what we want for the

    // unbounded leading/trailing live bands.

    const left = a.startMs === -Infinity ? -Infinity : a.startMs

    const right = b.startMs === -Infinity ? -Infinity : b.startMs

    if (left === right) return 0

    return left < right ? -1 : 1

  })

}





/**

 * Scroll offset that puts the on-air row ~25% down the list.

 *

 * Clamped at both ends: a row near the very bottom (the last item, or a break

 * with nothing after it) cannot reach 25% without scrolling past the end, so it

 * settles at the bottom instead of leaving the list half-blank below it.

 */

function scrollActiveIntoView(container: HTMLOListElement, active: HTMLElement): number {

  const containerHeight = container.clientHeight

  const activeTop =

    active.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop

  const maxScroll = container.scrollHeight - containerHeight

  return Math.max(0, Math.min(activeTop - containerHeight * 0.25, maxScroll))

}



function formatClockMs(ms: number): string {

  if (ms === -Infinity) return '—'

  return new Intl.DateTimeFormat('en-GB', {

    timeZone: CHANNEL_TIMEZONE,

    hour: '2-digit',

    minute: '2-digit',

    second: '2-digit',

    hour12: false,

  }).format(new Date(ms))

}