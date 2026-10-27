import { ChevronLeft, ChevronRight, Crosshair, Lock, Pause, Play, TriangleAlert } from 'lucide-react'

import { CHANNEL_TIMEZONE, LOCK_WINDOW_LABEL } from '@/config'
import { cn } from '@/lib/cn'
import { formatClock, formatDate } from '@/lib/format'
import { HOUR, SHIFT_STEP_MS, ZOOM_LEVELS_MS } from '@/lib/timeline'
import { useUiStore } from '@/stores/ui-store'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'

/**
 * Timeline toolbar (FR-TL-01 .. FR-TL-03).
 *
 * Every action has a keyboard equivalent, because a broadcast operator working
 * at speed should never need the mouse (FR-A11-06).
 */
export interface ToolbarAlert {
  id: string
  tone: 'warn' | 'danger'
  message: string
}

export function TimelineToolbar({
  now,
  nowMode,
  offsetMs,
  alerts = [],
  onJumpToNow,
}: {
  now: number
  nowMode: 'marker' | 'timeline'
  offsetMs: number
  /** Urgent per-channel warnings, shown centred in the bar. */
  alerts?: ToolbarAlert[]
  onJumpToNow: () => void
}) {
  const zoomIndex = useUiStore((state) => state.zoomIndex)
  const zoomIn = useUiStore((state) => state.zoomIn)
  const zoomOut = useUiStore((state) => state.zoomOut)
  const shiftBy = useUiStore((state) => state.shiftBy)
  const toggleNowMode = useUiStore((state) => state.toggleNowMode)
  const showGrid = useUiStore((state) => state.showGrid)
  const setShowGrid = useUiStore((state) => state.setShowGrid)

  const zoomMs = ZOOM_LEVELS_MS[zoomIndex]
  const windowStart = new Date(offsetMs).toISOString()
  const windowEnd = new Date(offsetMs + zoomMs).toISOString()
  const follow = nowMode === 'timeline'

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-4 py-2">
      <div className="flex items-center gap-1">
        <Tooltip content="Shift left 6h (←)">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Shift left 6 hours"
            onClick={() => shiftBy(-SHIFT_STEP_MS)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </Tooltip>
        <Tooltip content="Jump to now">
          <Button size="icon" variant="ghost" aria-label="Jump to now" onClick={onJumpToNow}>
            <Crosshair className="h-4 w-4" />
          </Button>
        </Tooltip>
        <Tooltip content="Shift right 6h (→)">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Shift right 6 hours"
            onClick={() => shiftBy(SHIFT_STEP_MS)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </Tooltip>
      </div>

      <div className="flex items-center gap-1">
        <Tooltip content="Zoom in (+)">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Zoom in"
            disabled={zoomIndex === 0}
            onClick={zoomIn}
          >
            <PlusIcon />
          </Button>
        </Tooltip>
        <span className="tnum w-20 text-center text-xs font-semibold text-default">
          {zoomMs / 60_000}m
        </span>
        <Tooltip content="Zoom out (−)">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Zoom out"
            disabled={zoomIndex === ZOOM_LEVELS_MS.length - 1}
            onClick={zoomOut}
          >
            <MinusIcon />
          </Button>
        </Tooltip>
      </div>

      {/* The visible window, so an operator always knows what they are looking
          at even after panning far from the present. */}
      <div className="hidden items-baseline gap-1.5 border-l border-line pl-3 text-2xs text-muted lg:flex">
        <span className="tnum text-default">{formatClock(windowStart, CHANNEL_TIMEZONE)}</span>
        <span className="text-subtle">→</span>
        <span className="tnum text-default">{formatClock(windowEnd, CHANNEL_TIMEZONE)}</span>
        <span className="text-subtle">·</span>
        <span>{formatDate(windowStart, CHANNEL_TIMEZONE)}</span>
      </div>

      {/* Warnings belong in the middle of the bar, not on the left edge of a
          lane panel: they are about the channel, not about one strip, and an
          operator scanning the timeline reads centre-first. */}
      <div className="flex min-w-0 flex-1 justify-center">
        {alerts.slice(0, 2).map((alert) => (
          <span
            key={alert.id}
            role="status"
            className={cn(
              'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-2xs font-medium',
              alert.tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn',
            )}
          >
            {alert.tone === 'danger' ? (
              <TriangleAlert className="h-3 w-3 shrink-0" />
            ) : (
              <Lock className="h-3 w-3 shrink-0" />
            )}
            <span className="truncate">{alert.message}</span>
          </span>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <span
          className="hidden text-2xs text-subtle sm:inline"
          title="Items lock this long before their start time and can no longer be edited"
        >
          Lock {LOCK_WINDOW_LABEL} before start
        </span>

        <button
          type="button"
          onClick={() => setShowGrid(!showGrid)}
          aria-pressed={showGrid}
          className={cn(
            'rounded-md px-2 py-1 text-2xs font-medium transition-colors',
            showGrid ? 'text-muted hover:bg-hover' : 'text-subtle hover:bg-hover',
          )}
        >
          Grid
        </button>

        <Tooltip
          content={
            follow
              ? 'Now mode: the view follows the clock automatically. Dragging and the context menu are disabled.'
              : 'Now mode: the view is pinned. Dragging and the context menu are enabled.'
          }
        >
          <button
            type="button"
            onClick={toggleNowMode}
            aria-pressed={follow}
            data-testid="now-mode"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-2xs font-medium transition-colors',
              follow
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line text-muted hover:bg-hover',
            )}
          >
            {follow ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            {follow ? 'Following' : 'Pinned'}
          </button>
        </Tooltip>

        <span className="tnum hidden items-center gap-1.5 rounded-md bg-danger-soft px-2 py-1 text-2xs font-semibold text-danger sm:inline-flex">
          <span className="h-1.5 w-1.5 animate-onair rounded-full bg-danger" />
          {formatClock(new Date(now).toISOString(), CHANNEL_TIMEZONE)}
        </span>
      </div>
    </div>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
    </svg>
  )
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <path d="M3.5 8h9" strokeLinecap="round" />
    </svg>
  )
}

export { HOUR }