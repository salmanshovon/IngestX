import { useEffect, useState } from 'react'

import type { ScheduleEvent } from '@/api/types'
import { DEFAULT_RECORD_MS, MIN_RECORD_MS, RECORD_GAP_MS } from '@/config'
import { api } from '@/lib/api-client'
import { nextScheduledStart } from '@/lib/recording'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toLocalInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fromLocalInput(value: string): string {
  return new Date(value).toISOString()
}

function buildPrefix(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return 'BTI_'
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const hms = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `BTI_${ymd}_${hms}_`
}

/**
 * Preferred end for a new slot.
 *
 * Default length, unless the next scheduled item is closer than that. A break
 * that starts 8 minutes before the next recording gets 7m50s, not an overlap --
 * the 10s keep-clear is the same gap the duplicate action uses.
 */
function defaultEndMs(
  startMs: number,
  nextStartMs?: number | null,
  defaultDurationMs: number = DEFAULT_RECORD_MS,
): number {
  const preferred = startMs + defaultDurationMs
  if (nextStartMs === null || nextStartMs === undefined) return preferred
  return Math.min(preferred, nextStartMs - RECORD_GAP_MS)
}

export interface RecordModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  pipelineId: number
  startMs: number
  /** Start of the next scheduled item on this channel, when there is one. */
  nextStartMs?: number | null
  /** `RecordingSetting.default_duration_minutes` in ms. */
  defaultDurationMs?: number
  /** Full schedule, so a changed Start re-bounds the End against the right recording. */
  events: readonly ScheduleEvent[]
  onSuccess?: () => void
}

export function RecordModal({
  open,
  onOpenChange,
  pipelineId,
  startMs,
  nextStartMs,
  defaultDurationMs = DEFAULT_RECORD_MS,
  events,
  onSuccess,
}: RecordModalProps) {
  const [startValue, setStartValue] = useState(toLocalInput(startMs))
  const [endValue, setEndValue] = useState(toLocalInput(defaultEndMs(startMs, nextStartMs, defaultDurationMs)))
  const [endTouched, setEndTouched] = useState(false)
  const [suffix, setSuffix] = useState(`CH${pipelineId}`)
  const [durationMinutes, setDurationMinutes] = useState(String(Math.round(defaultDurationMs / 60_000)))

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setStartValue(toLocalInput(startMs))
    const end = defaultEndMs(startMs, nextStartMs, defaultDurationMs)
    setEndValue(toLocalInput(end))
    setEndTouched(false)
    setSuffix(`CH${pipelineId}`)
    setDurationMinutes(String(Math.round((end - startMs) / 60_000)))
    setError(null)
  }, [open, startMs, pipelineId, nextStartMs, defaultDurationMs])

  const prefix = buildPrefix(startValue)

  /**
   * The next recording after a candidate start.
   *
   * The parent's `nextStartMs` is correct for the position that was
   * right-clicked, but the operator can move Start. Recompute from the schedule
   * so the End follows the new start instead of snapping to a time before it.
   */
  const nextStartFor = (value: number): number | null =>
    nextScheduledStart(events, pipelineId, value)

  async function submit() {
    const startMs = new Date(startValue).getTime()
    const endMs = new Date(endValue).getTime()
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      setError('Enter valid start and end times.')
      return
    }
    if (startMs <= Date.now() || endMs <= Date.now()) {
      setError('Start and end must be in the future.')
      return
    }
    if (endMs <= startMs) {
      setError('End must be after start.')
      return
    }
    if (endMs - startMs < MIN_RECORD_MS) {
      setError('No room before the next item — a recording needs at least 10 seconds.')
      return
    }
    const nextStart = nextStartFor(startMs)
    if (nextStart !== null && endMs > nextStart - RECORD_GAP_MS) {
      setError('The next item starts too soon. Leave at least 10 seconds after this recording.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.post('/recordings/', {
        port: pipelineId,
        filename: `${prefix}${suffix}`,
        filepath: 'ITV-SAN-FTP',
        start_time: fromLocalInput(startValue),
        end_time: fromLocalInput(endValue),
        status: 'SCHEDULED',
      })
      onSuccess?.()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not schedule the recording.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Schedule record" description={`${prefix}${suffix}`} size="md">
      <div className="space-y-4">
        <div className="grid grid-cols-[88px_1fr] items-start gap-2">
          <span className="pt-1 text-2xs text-subtle">Prefix</span>
          <span className="truncate font-mono text-xs text-muted">{prefix}</span>
        </div>
        <div className="grid grid-cols-[88px_1fr] items-start gap-2">
          <span className="pt-1 text-2xs text-subtle">Name</span>
          <Input value={suffix} onChange={(e) => setSuffix(e.target.value)} className="h-8 text-xs" />
        </div>
        <div className="grid grid-cols-[88px_1fr] items-start gap-2">
          <span className="pt-1 text-2xs text-subtle">File path</span>
          <span className="text-xs text-muted">ITV-SAN-FTP</span>
        </div>
        <div className="grid grid-cols-[88px_1fr] items-start gap-2">
          <span className="pt-1 text-2xs text-subtle">Start</span>
          <Input
            type="datetime-local"
            step={1}
            value={startValue}
            onChange={(e) => {
              const value = e.target.value
              setStartValue(value)
              // Keep the default length in step with the start until the
              // operator takes over the end field themselves.
              if (!endTouched) {
                const parsed = new Date(value).getTime()
                if (!Number.isNaN(parsed)) {
                  const end = defaultEndMs(parsed, nextStartFor(parsed), defaultDurationMs)
                  setEndValue(toLocalInput(end))
                  setDurationMinutes(String(Math.round((end - parsed) / 60_000)))
                }
              }
            }}
            className="h-8 text-xs"
          />
        </div>
        <div className="grid grid-cols-[88px_1fr] items-start gap-2">
          <span className="pt-1 text-2xs text-subtle">End</span>
          <Input
            type="datetime-local"
            step={1}
            value={endValue}
            onChange={(e) => {
              setEndTouched(true)
              setEndValue(e.target.value)
              const startMs = new Date(startValue).getTime()
              const endMs = new Date(e.target.value).getTime()
              if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs) {
                setDurationMinutes(String(Math.round((endMs - startMs) / 60_000)))
              }
            }}
            className="h-8 text-xs"
          />
        </div>
        <div className="grid grid-cols-[88px_1fr] items-start gap-2">
          <span className="pt-1 text-2xs text-subtle">Duration</span>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              step={1}
              value={durationMinutes}
              onChange={(e) => {
                setDurationMinutes(e.target.value)
                const mins = Number(e.target.value)
                const startMs = new Date(startValue).getTime()
                if (!Number.isNaN(mins) && mins > 0 && !Number.isNaN(startMs)) {
                  setEndValue(toLocalInput(startMs + mins * 60_000))
                  setEndTouched(true)
                }
              }}
              className="h-8 w-24 text-xs"
            />
            <span className="text-2xs text-subtle">minutes</span>
          </div>
        </div>
        {error && <p className="text-2xs text-danger">{error}</p>}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" loading={saving} onClick={submit}>
          Schedule
        </Button>
      </div>
    </Modal>
  )
}