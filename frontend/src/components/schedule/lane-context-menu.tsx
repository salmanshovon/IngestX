import { CalendarPlus, Square, Trash2 } from 'lucide-react'

import type { MediaLane } from '@/api/types'
import { CHANNEL_TIMEZONE } from '@/config'
import { formatDateTime } from '@/lib/format'
import { LANE_LABEL } from '@/lib/format'

export interface LaneMenuState {
  pipelineId: number
  lane: MediaLane
  clientX: number
  clientY: number
  startMs: number
  /** Nearby clips that pass the delete rules right now. */
  deletableIds: number[]
  /**
   * The held graphic currently on air, if this lane has one. Drives the
   * "Stop now" item, which only makes sense for something already running.
   */
  onAirHeldId?: number | null
}

export interface LaneContextMenuProps {
  state: LaneMenuState | null
  onClose: () => void
  onSchedule: () => void
  onDeleteNearby: (ids: number[]) => void
  /** End the lane's on-air held graphic immediately. */
  onStopNow?: (id: number) => void
}

/**
 * Lane-aware context menu (FR-CTX-01 .. FR-CTX-06).
 *
 * Hand-rolled rather than Radix `ContextMenu` for one reason: the menu has to
 * open at an arbitrary point chosen by the operator on a canvas, with content
 * that depends on *where* they clicked. Radix anchors to the event target,
 * which is the lane, not the cursor.
 *
 * Suppression rules are enforced upstream (the caller does not open it while
 * following the clock or over a locked position) and repeated here as guards,
 * because a menu that offers an action the server will refuse is worse than no
 * menu at all.
 */
export function LaneContextMenu({
  state,
  onClose,
  onSchedule,
  onDeleteNearby,
  onStopNow,
}: LaneContextMenuProps) {
  if (!state) return null

  const label = LANE_LABEL[state.lane]
  const at = formatDateTime(new Date(state.startMs).toISOString(), CHANNEL_TIMEZONE)

  // Keep the menu inside the viewport on a right-click near the right edge.
  const left = Math.min(state.clientX, window.innerWidth - 236)
  const top = Math.min(state.clientY, window.innerHeight - 140)

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        aria-hidden
        onPointerDown={onClose}
        onContextMenu={(event) => {
          event.preventDefault()
          onClose()
        }}
      />
      <div
        role="menu"
        aria-label={`${label} actions`}
        data-testid="lane-menu"
        className="animate-in-fade fixed z-50 min-w-56 overflow-hidden rounded-lg border border-line bg-raised p-1 shadow-lg"
        style={{ left, top }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <p className="px-2 py-1.5 text-2xs text-subtle">
          {label} · <span className="tnum text-muted">{at}</span>
        </p>

        {state.onAirHeldId !== null && state.onAirHeldId !== undefined && onStopNow && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onStopNow(state.onAirHeldId as number)
              onClose()
            }}
            className="flex w-full items-center gap-2.5 rounded-md bg-danger-soft px-2 py-1.5 text-left text-xs font-semibold text-danger transition-colors hover:brightness-110"
          >
            <Square className="h-3.5 w-3.5" />
            Stop now
          </button>
        )}

        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onSchedule()
            onClose()
          }}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs text-default transition-colors hover:bg-hover"
        >
          <CalendarPlus className="h-3.5 w-3.5 text-accent" />
          {state.lane === 'FILE' ? 'Schedule record here' : `Schedule ${label.toLowerCase()} here`}
        </button>

        {state.deletableIds.length > 0 && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onDeleteNearby(state.deletableIds)
              onClose()
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs text-danger transition-colors hover:bg-danger-soft"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete {state.deletableIds.length === 1 ? 'scheduled item' : `${state.deletableIds.length} items`}
          </button>
        )}
      </div>
    </>
  )
}