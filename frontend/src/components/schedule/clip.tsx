import { memo, type CSSProperties, type ReactNode } from 'react'

import type { MediaLane, ScheduleEvent } from '@/api/types'
import { cn } from '@/lib/cn'
import { displayTitle, formatFull, formatShortDuration, toNumber } from '@/lib/format'
import { CHANNEL_TIMEZONE } from '@/config'
import type { ClipGeometry } from '@/lib/timeline'
import { LABEL_VISIBILITY_PX, PARTIAL_LABEL_VISIBILITY_PX } from '@/lib/timeline'

/**
 * Timeline block visual states.
 *
 * Mapped to CSS custom properties rather than inline `cssText`, so the whole
 * palette is themeable and no component hard-codes a hex (FR-DS-01/04).
 * `orphaned` is not decoration. Media sync is destructive (Spec §2.5): a file
 * deleted from the agent's disk deletes its MediaItem row, and ScheduleEvent
 * keeps a NULL media_item. Such an event has no duration and no title, so
 * rendered naively it collapses to an invisible one-pixel sliver the operator
 * cannot select, drag or delete — a trap. It gets its own treatment instead.
 */
type VisualState = 'scheduled' | 'locked' | 'live' | 'done' | 'error' | 'band' | 'orphaned'

const STATE_STYLES: Record<VisualState, CSSProperties> = {
  scheduled: {
    background: 'var(--clip-scheduled-bg)',
    borderColor: 'var(--clip-scheduled-border)',
    color: 'var(--clip-scheduled-fg)',
    borderStyle: 'dashed',
  },
  locked: {
    background: 'var(--clip-scheduled-bg)',
    borderColor: 'var(--clip-scheduled-border)',
    color: 'var(--clip-scheduled-fg)',
    borderStyle: 'solid',
  },
  live: {
    background: 'var(--clip-live-bg)',
    borderColor: 'var(--clip-live-border)',
    color: 'var(--clip-live-fg)',
    borderStyle: 'solid',
  },
  done: {
    background: 'var(--clip-done-bg)',
    borderColor: 'var(--clip-done-border)',
    color: 'var(--clip-done-fg)',
    borderStyle: 'solid',
  },
  error: {
    background: 'var(--clip-error-bg)',
    borderColor: 'var(--clip-error-border)',
    color: 'var(--clip-error-fg)',
    borderStyle: 'solid',
  },
  band: {
    background: 'var(--clip-band-bg)',
    borderColor: 'var(--clip-band-border)',
    color: 'var(--clip-band-fg)',
    borderStyle: 'solid',
  },
  orphaned: {
    background: 'var(--clip-error-bg)',
    borderColor: 'var(--clip-error-border)',
    color: 'var(--clip-error-fg)',
    borderStyle: 'dotted',
  },
}

/**
 * Which look a block gets right now.
 *
 * `status` is a lagging truth: the server only rewrites PENDING -> PLAYING ->
 * COMPLETED on its next poll, so branching on it alone left clips sitting in
 * "scheduled" styling for up to 30 seconds after they should have gone live,
 * and again after they should have finished.
 *
 * `geometry.isLocked` / `isOnAir` are clock-derived (see deriveLockState), so
 * they are checked first and the server status only has to supply the things
 * the clock cannot know: failure, and deliberate cancellation.
 */
export function visualStateFor(
  geometry: ClipGeometry,
  inAdGroup: boolean,
  orphaned = false,
  nowMs?: number,
): VisualState {
  if (orphaned) return 'orphaned'

  if (geometry.isOnAir) return 'live'
  if (geometry.status === 'FAILED') return 'error'
  // Clock-derived: the block's own window has closed, whatever the poll says.
  if (nowMs !== undefined && geometry.endMs <= nowMs && geometry.status !== 'CANCELLED') {
    return 'done'
  }

  if (inAdGroup) return geometry.isLocked ? 'locked' : 'scheduled'
  switch (geometry.status) {
    case 'COMPLETED':
    case 'CANCELLED':
      return 'done'
    case 'PLAYING':
      return 'live'
    default:
      return geometry.isLocked ? 'locked' : 'scheduled'
  }
}

const LANE_BADGE: Record<MediaLane, string> = {
  FILE: 'AD',
  CG: 'CG',
  DOG: 'DOG',
  BUG: 'BUG',
  TICKER: 'TKR',
}

export interface ClipProps {
  event: ScheduleEvent
  geometry: ClipGeometry
  /** Ticking clock, so live/done colouring does not wait for the next poll. */
  now?: number
  /** Rendered as a segment inside an ad group rather than a standalone block. */
  inAdGroup?: boolean
  selected?: boolean
  dragging?: boolean
  /** Ad-chain position, 1-based. */
  segmentIndex?: number
  segmentCount?: number
  loopCycles?: number
  onPointerDown?: (event: React.PointerEvent) => void
  onContextMenu?: (event: React.MouseEvent) => void
  onDoubleClick?: () => void
  children?: ReactNode
}

/**
 * A single timeline block.
 *
 * Memoised on geometry + status: during a pan the geometry of every visible
 * clip changes, so this is the hot path and must stay allocation-light. Below
 * `LABEL_VISIBILITY_PX` the text collapses to a coloured bar (FR-CL-10) --
 * at 30-minute zoom a 5-second commercial is four pixels wide and text is
 * just noise.
 */
export const Clip = memo(function Clip({
  event,
  geometry,
  now,
  inAdGroup = false,
  selected,
  dragging,
  segmentIndex,
  segmentCount,
  loopCycles,
  onPointerDown,
  onContextMenu,
  onDoubleClick,
}: ClipProps) {
  const widthPx = Math.max(1, geometry.widthPx)
  // An event whose MediaItem was removed by a destructive sync has no media
  // and no duration. Give it a usable floor so it stays reachable.
  const orphaned = event.media_item === null && event.action_type !== 'RECORD'
  const state = visualStateFor(geometry, inAdGroup, orphaned, now)
  const showFullText = widthPx >= LABEL_VISIBILITY_PX
  const showPartialText = !showFullText && widthPx >= PARTIAL_LABEL_VISIBILITY_PX
  const title = orphaned ? 'Missing media' : displayTitle(event.media_title) || 'Untitled'
  const duration = toNumber(event.duration_seconds) ?? (geometry.endMs - geometry.startMs) / 1000
  const isNarrow = widthPx < 14
  const lane = (event.media_lane ?? 'FILE') as MediaLane

  // A zero-length block still needs to be grabbable.
  const style: CSSProperties = {
    ...STATE_STYLES[state],
    left: `${geometry.left * 100}%`,
    width: `${Math.max(geometry.width * 100, orphaned ? 0.35 : 0.14)}%`,
    ...(dragging ? { zIndex: 30, boxShadow: 'var(--shadow-lg)', cursor: 'grabbing' } : null),
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={
        orphaned
          ? `Missing media, ${LANE_BADGE[lane]} event ${event.id}, cannot be played`
          : `${LANE_BADGE[lane]} ${title}, ${formatShortDuration(duration)}, ${event.status}`
      }
      data-testid={`clip-${event.id}`}
      data-status={event.status}
      data-lane={lane}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onKeyDown={(event_) => {
        if (event_.key === 'Enter' || event_.key === ' ') {
          event_.preventDefault()
          onDoubleClick?.()
        }
      }}
      className={cn(
        'group absolute top-1 bottom-1 overflow-hidden rounded-[4px] border',
        'transition-[box-shadow,filter] duration-100',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]',
        geometry.isOnAir && 'animate-onair',
        selected && 'ring-2 ring-[var(--accent)] ring-offset-1 ring-offset-[var(--bg-surface)]',
        !geometry.isOnAir && 'hover:brightness-110',
        !inAdGroup && 'cursor-grab active:cursor-grabbing',
      )}
      style={style}
    >
      {/* Live progress wash: reads as "running" without needing a timer. */}
      {state === 'live' && <LiveWash startMs={geometry.startMs} endMs={geometry.endMs} />}

      {/*
        Three densities rather than two. The old version drew nothing at all
        below 40px, so a 10-second commercial was an anonymous coloured sliver
        and the only way to identify it was to hover. Now even the narrowest
        case shows the opening of the title, which is enough to tell one spot
        from another; the tooltip carries the rest.
      */}
      {showFullText ? (
        <div className="relative flex h-full min-w-0 items-center gap-1.5 px-1.5">
          <span className="shrink-0 rounded bg-black/25 px-1 py-px text-[9px] font-bold tracking-wider opacity-80">
            {segmentIndex && segmentCount ? `${segmentIndex}/${segmentCount}` : LANE_BADGE[lane]}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-2xs font-semibold leading-tight">
              {title}
            </span>
            <span className="tnum block truncate text-[9px] leading-tight opacity-70">
              {orphaned ? 'cannot be played' : formatShortDuration(duration)}
              {!orphaned && loopCycles && loopCycles > 1 ? ` · ↻×${loopCycles}` : ''}
            </span>
          </span>
        </div>
      ) : showPartialText ? (
        // One line, no lane badge: at this width the badge would eat the whole
        // block and leave nothing for the name.
        <span className="relative block h-full overflow-hidden px-1 text-2xs leading-[1.7] font-semibold">
          {title}
        </span>
      ) : (
        <span className="sr-only">{title}</span>
      )}

      {/* Resize handles: pull either edge to change start/end time (FR-DND-06). */}
      {!isNarrow && (
        <>
          {/* An on-air held graphic cannot be pulled backwards (FR-DND-07) --
              that would cut the overlay off mid-broadcast -- so the left handle
              is hidden outright rather than shown as a dead control. The right
              one stays: extending a still-running DOG is the whole point. */}
          {!geometry.isOnAir && (
            <ResizeHandle
              side="left"
              eventId={event.id}
              locked={geometry.isLocked}
              active={Boolean(selected) || Boolean(dragging)}
            />
          )}
          <ResizeHandle
            side="right"
            eventId={event.id}
            locked={geometry.isLocked}
            active={Boolean(selected) || Boolean(dragging)}
          />
        </>
      )}
    </div>
  )
})

function LiveWash({ startMs, endMs }: { startMs: number; endMs: number }) {
  // Rendered once per clip; a CSS animation is cheaper than a 1 Hz React
  // update on every on-air block.
  const span = Math.max(1, endMs - startMs)
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 origin-left"
      style={{
        background: 'linear-gradient(90deg, transparent, color-mix(in srgb, var(--clip-live-border) 40%, transparent))',
        animation: `ply-sweep ${Math.min(span / 1000, 8)}s linear infinite`,
      }}
    />
  )
}

function ResizeHandle({
  side,
  eventId,
  locked,
  active = false,
}: {
  side: 'left' | 'right'
  eventId: number
  locked: boolean
  /** Selected or mid-drag: the edge stays lit so the target stays findable. */
  active?: boolean
}) {
  return (
    <span
      data-resize-handle={side}
      data-event-id={eventId}
      data-locked={locked ? 'true' : 'false'}
      aria-hidden
      className={cn(
        // 8px, not 6: this is the only hit target a duration change has, and it
        // has to survive a click on a 27px-tall lane row.
        'absolute top-0 bottom-0 w-2 touch-none',
        locked
          ? 'cursor-not-allowed'
          : cn(
              'cursor-ew-resize transition-opacity',
              active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            ),
        side === 'left' ? 'left-0' : 'right-0',
      )}
      // Painted through a style attribute on purpose: the reveal has to come
      // from a CLASS. The old version set `opacity` inline, and an inline
      // declaration beats any class, so `group-hover:opacity-100` never applied
      // and the handle stayed invisible at every zoom -- there was nothing on
      // screen to tell an operator the edge was draggable.
      style={{ background: 'color-mix(in srgb, currentColor 45%, transparent)' }}
    />
  )
}

/** FR-CL-08: the hover tooltip payload. */
export function clipTooltip(event: ScheduleEvent, geometry: ClipGeometry): ReactNode {
  // Held lanes carry an explicit end, so `duration_seconds` is the *media
  // file's* length -- frequently zero, and never what the operator actually
  // scheduled. Show the window the block occupies on the timeline instead,
  // which is what "how long is this on for" means here.
  const held = geometry.isHeld
  const duration = held
    ? Math.max(0, (geometry.endMs - geometry.startMs) / 1000)
    : toNumber(event.duration_seconds) ?? 0
  return (
    <div className="space-y-1">
      <p className="font-semibold text-default">{displayTitle(event.media_title) || 'Untitled'}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-2xs">
        <dt className="text-subtle">Type</dt>
        <dd className="text-default">
          {event.media_lane ?? '—'} · {event.media_type || '—'}
        </dd>
        <dt className="text-subtle">Start</dt>
        <dd className="tnum text-default">{formatFull(event.scheduled_time, CHANNEL_TIMEZONE)}</dd>
        <dt className="text-subtle">Duration</dt>
        <dd className="tnum text-default">{formatShortDuration(duration)}</dd>
        <dt className="text-subtle">Status</dt>
        <dd className="text-default">
          {(event.media_item === null && event.action_type !== 'RECORD') ? 'Missing media' : event.status}
          {geometry.isLocked ? ' · locked' : ''}
          {geometry.isOnAir ? ' · on air' : ''}
        </dd>
        {event.template_name && (
          <>
            <dt className="text-subtle">Template</dt>
            <dd className="text-default">{event.template_name}</dd>
          </>
        )}
        <dt className="text-subtle">File</dt>
        <dd className="truncate font-mono text-default" title={event.media_file_path}>
          {event.media_file_path || '—'}
        </dd>
      </dl>
    </div>
  )
}