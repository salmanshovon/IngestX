import { AlertTriangle, CircleDot, Clock3, Loader2 } from 'lucide-react'

import type { Pipeline } from '@/api/types'
import { CHANNEL_TIMEZONE } from '@/config'
import { cn } from '@/lib/cn'
import { formatClock } from '@/lib/format'
import { Tooltip } from '@/components/ui/tooltip'

/**
 * Scheduler footer (FR-TL-09).
 *
 * The four numbers an operator checks before signing off: engine state, what is
 * on air, what is queued, and how current this view's data is.
 */
export function StatusFooter({
  counters,
  pipelines,
  now,
  nowMode,
  scheduleStale,
  lastUpdated,
}: {
  counters: { onAir: number; scheduled: number; failed: number }
  pipelines: Pipeline[]
  now: number
  nowMode: 'marker' | 'timeline'
  scheduleStale: boolean
  lastUpdated: number
}) {
  const online = pipelines.filter((pipeline) => pipeline.engine_state === 'online').length
  const stale = pipelines.filter((pipeline) => pipeline.engine_state === 'stale').length
  const offline = pipelines.length - online - stale

  return (
    <footer className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-line bg-inset px-4 py-1.5 text-2xs">
      <span className="flex items-center gap-1.5">
        <span className="text-subtle">Agents</span>
        <span className="flex items-center gap-1.5 text-default">
          <EngineChip count={online} label="online" tone="ok" />
          {stale > 0 && <EngineChip count={stale} label="stale" tone="warn" />}
          {offline > 0 && <EngineChip count={offline} label="offline" tone="danger" />}
        </span>
      </span>

      <span className="flex items-center gap-1.5">
        <CircleDot className={cn('h-3 w-3', counters.onAir > 0 ? 'text-danger' : 'text-subtle')} />
        <span className="text-subtle">REC</span>
        <span className={cn('tnum font-semibold', counters.onAir > 0 ? 'text-danger' : 'text-default')}>
          {counters.onAir}
        </span>
      </span>

      <span className="flex items-center gap-1.5">
        <Clock3 className="h-3 w-3 text-subtle" />
        <span className="text-subtle">Scheduled</span>
        <span className="tnum font-semibold text-default">{counters.scheduled}</span>
      </span>

      {counters.failed > 0 && (
        <Tooltip content="Failed items are never retried automatically — an operator must reschedule them.">
          <span className="flex items-center gap-1.5 text-danger">
            <AlertTriangle className="h-3 w-3" />
            <span className="tnum font-semibold">{counters.failed}</span>
            <span>failed</span>
          </span>
        </Tooltip>
      )}

      <div className="ml-auto flex items-center gap-4">
        <span
          className="flex items-center gap-1.5 text-subtle"
          title="The schedule is refetched every 30 seconds regardless of realtime state, so this stays current."
        >
          {scheduleStale ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-ok" />
          )}
          Synced{' '}
          <span className="tnum">
            {lastUpdated ? formatClock(new Date(lastUpdated).toISOString(), CHANNEL_TIMEZONE) : '—'}
          </span>
        </span>

        <span className="tnum text-default">{formatClock(new Date(now).toISOString(), CHANNEL_TIMEZONE)}</span>

        {/* Read-only mirror of the toolbar toggle. This is status, not a
            control: two switches for one setting invite disagreement about
            which one the operator just moved. */}
        <span
          className={cn(
            'rounded border px-2 py-0.5 font-medium',
            nowMode === 'timeline'
              ? 'border-accent bg-accent-soft text-accent'
              : 'border-line text-muted',
          )}
          title={
            nowMode === 'timeline'
              ? 'The view is following the clock'
              : 'The view is pinned; dragging and the lane menu are enabled'
          }
        >
          Now: {nowMode === 'timeline' ? 'follow' : 'pinned'}
        </span>
      </div>
    </footer>
  )
}

function EngineChip({ count, label, tone }: { count: number; label: string; tone: 'ok' | 'warn' | 'danger' }) {
  const dot = tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : 'bg-danger'
  return (
    <span className="flex items-center gap-1">
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} aria-hidden />
      <span className="tnum font-semibold text-default">{count}</span>
      <span className="text-subtle">{label}</span>
    </span>
  )
}