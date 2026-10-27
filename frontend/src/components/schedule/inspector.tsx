import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Ban,
  FileText,
  Info,
  Layers3,
  Lock,
  Save,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react'

import type { Pipeline, ScheduleEvent } from '@/api/types'
import { CHANNEL_TIMEZONE, LOCK_WINDOW_LABEL } from '@/config'
import { cn } from '@/lib/cn'
import {
  displayTitle,
  formatDurationHhmmssmmm,
  formatFull,
  formatShortDuration,
  toNumber,
} from '@/lib/format'
import { canStopRecording, recordingStopInMs } from '@/lib/recording'
import { deleteBlock, deleteBlockMessage, eventEndMs, eventStartMs, isLiveAt } from '@/lib/timeline'
import { StatusBadge } from '@/components/ui/primitives'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip } from '@/components/ui/tooltip'

/** `YYYY-MM-DDTHH:MM:SS` in the channel zone, for `<input type=datetime-local>`. */
function toLocalInput(iso: string, offsetMs = 0): string {
  const date = new Date(Date.parse(iso) + offsetMs)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

/**
 * Channel timezone offset at a given instant.
 *
 * The inspector edits wall-clock time in the *channel's* zone, not the
 * operator's. A show in Dhaka running from a laptop in London must be scheduled
 * at 20:00 Dhaka regardless of where the browser thinks it is.
 */
function channelOffsetMs(iso: string): number {
  const utcGuess = Date.parse(iso)
  if (Number.isNaN(utcGuess)) return 0
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: CHANNEL_TIMEZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(utcGuess)).map((part) => [part.type, part.value]),
  )
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  )
  return asUtc - utcGuess
}

function splitFilename(fn: string | null | undefined): { prefix: string; suffix: string } {
  const m = (fn || '').match(/^(BTI_\d{8}_\d{6}_)(.*)/)
  return m ? { prefix: m[1], suffix: m[2] } : { prefix: '', suffix: fn || '' }
}

function fromLocalInput(value: string, referenceIso: string): string | null {
  const parsed = Date.parse(`${value}Z`)
  if (Number.isNaN(parsed)) return null
  return new Date(parsed - channelOffsetMs(referenceIso)).toISOString()
}

/** Wall-clock milliseconds back to a `<input type=datetime-local>` value. */
function fromWallMs(ms: number): string {
  return toLocalInput(new Date(ms).toISOString(), 0)
}

/** `HH:MM:SS` — the editable duration format, no milliseconds. */
function toDurationInput(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const pad = (value: number) => String(value).padStart(2, '0')
  const h = Math.floor(total / 3_600)
  const m = Math.floor((total % 3_600) / 60)
  const s = total % 60
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

/**
 * Parse `HH:MM:SS`, `MM:SS` or plain seconds.
 *
 * Operators think in timecode, not in a number spinner. Anything unparseable
 * returns null so the current end time is left alone rather than snapped to 0.
 */
function parseDurationInput(value: string): number | null {
  const parts = value.trim().split(':')
  if (parts.length === 0 || parts.length > 3) return null
  const numbers = parts.map((part) => Number(part))
  if (numbers.some((number) => !Number.isFinite(number) || number < 0)) return null
  const seconds = numbers.reduce((total, number) => total * 60 + number, 0)
  return Math.round(seconds * 1000)
}

export interface InspectorProps {
  event: ScheduleEvent | null
  pipeline: Pipeline | null
  chainSize: number
  /** Shared 1 Hz clock, so the delete/stop windows keep moving while open. */
  now: number
  isSaving: boolean
  onSave: (patch: { scheduled_time?: string; end_time?: string | null; note?: string; filename?: string }) => void
  onDelete: () => void
  onStopNow?: () => void
  onCancel: () => void
  onOpenChain: () => void
}

/**
 * Clip inspector (FR-INS-01 .. FR-INS-08).
 *
 * Two rules are absolute:
 *
 * - **Duration is read-only and server-derived.** An event is a START; there is
 *   no duration column. FR-INS-02 forbids editing it and the API would silently
 *   ignore it anyway.
 * - **Start is editable only while unlocked**, and End only for held lanes.
 *   These are not just disabled states: the server refuses both with `LOCKED`
 *   and they are checked again on write.
 */
export function Inspector({
  event,
  pipeline,
  chainSize,
  now,
  isSaving,
  onSave,
  onDelete,
  onCancel,
  onOpenChain,
  onStopNow,
}: InspectorProps) {
  const [startValue, setStartValue] = useState('')
  const [endValue, setEndValue] = useState('')
  const [durationValue, setDurationValue] = useState('')
  const [noteValue, setNoteValue] = useState('')
  const [suffixValue, setSuffixValue] = useState('')
  const [touched, setTouched] = useState(false)
  const durationFocused = useRef(false)

  const offset = useMemo(() => (event ? channelOffsetMs(event.scheduled_time) : 0), [event])

  useEffect(() => {
    if (!event) return
    setStartValue(toLocalInput(event.scheduled_time, offset))
    setEndValue(event.end_time ? toLocalInput(event.end_time, offset) : '')
    setNoteValue(event.note ?? '')
    setSuffixValue(splitFilename(event.media_title).suffix)
    setTouched(false)
    durationFocused.current = false
    setDurationValue(
      event.end_time
        ? toDurationInput(Date.parse(event.end_time) - Date.parse(event.scheduled_time))
        : '',
    )
  }, [event, offset])

  // Keep Duration in step with whatever End currently says — unless the
  // operator is mid-edit in the Duration field itself, in which case rewriting
  // it from the derived value would eat their keystrokes.
  useEffect(() => {
    if (durationFocused.current) return
    const startWall = Date.parse(`${startValue}Z`)
    const endWall = Date.parse(`${endValue}Z`)
    if (Number.isNaN(startWall) || Number.isNaN(endWall)) return
    setDurationValue(toDurationInput(endWall - startWall))
  }, [startValue, endValue])

  if (!event) {
    return (
      <aside className="flex w-full flex-col items-center justify-center gap-2 border-l border-line bg-surface px-6 py-12 text-center">
        <Info className="h-5 w-5 text-subtle" />
        <p className="text-xs font-medium text-muted">Nothing selected</p>
        <p className="max-w-52 text-2xs leading-relaxed text-subtle">
          Click a clip on the timeline to inspect and edit it. Right-click a lane to schedule
          something new.
        </p>
      </aside>
    )
  }

  const locked = event.is_locked
  const onAir = event.is_on_air
  const isHeld = event.is_held
  const isRecording = event.action_type === 'RECORD'
  // Clock-derived, not the server flag: an item is live the moment the clock
  // crosses its start, and a recording stays live until the engine says
  // otherwise. The delete/stop rules follow the clock for the same reason.
  const live = isLiveAt(event, now)
  const deleteBlocked = deleteBlock(event, now)
  const canDelete = deleteBlocked === null
  const canStop = isRecording && live
  const stopAllowed = canStop && canStopRecording(event, now)
  const stopInMs = canStop ? recordingStopInMs(event, now) : 0
  const { prefix: filenamePrefix } = splitFilename(event.media_title)
  const terminal = event.status === 'COMPLETED' || event.status === 'FAILED' || event.status === 'CANCELLED'
  const canEditStart = !locked && !onAir && event.status === 'PENDING'
  // A recording's end is its stop time, so it stays editable while it is still
  // running — that is exactly when an operator needs to extend or trim it.
  // Held graphics keep the old rule and go read-only once on air.
  const canEditEnd = !terminal && (isRecording || (isHeld && !onAir))
  const canEditNote = !locked && !onAir
  const LockIcon = Lock

  const startIso = fromLocalInput(startValue, event.scheduled_time)
  const endIso = endValue ? fromLocalInput(endValue, event.end_time ?? event.scheduled_time) : null
  // The inputs are second-resolution; compare at the same resolution so a
  // sub-second round trip does not look like an operator edit and rewrite a
  // start/end the operator never touched.
  const startChanged =
    startIso !== null &&
    Math.floor(Date.parse(startIso) / 1000) !== Math.floor(eventStartMs(event) / 1000)
  const endChanged =
    canEditEnd &&
    endIso !== null &&
    Math.floor(Date.parse(endIso) / 1000) !== Math.floor(eventEndMs(event) / 1000)
  const noteChanged = noteValue !== (event.note ?? '')
  const suffixChanged = isRecording && suffixValue !== splitFilename(event.media_title).suffix
  const dirty = touched && (startChanged || endChanged || noteChanged || suffixChanged)

  const minDurationMs = isRecording ? 10_000 : 0
  const previewDurationMs =
    (endChanged && endIso ? Date.parse(endIso) : eventEndMs(event)) -
    (startChanged && startIso ? Date.parse(startIso) : eventStartMs(event))

  const validation = validateInspector({
    startIso,
    endIso,
    canEditStart,
    canEditEnd,
    previewDurationMs,
    minDurationMs,
  })

  function save() {
    setTouched(true)
    if (validation) return
    const patch: { scheduled_time?: string; end_time?: string | null; note?: string; filename?: string } = {}
    if (startChanged && startIso) patch.scheduled_time = startIso
    if (endChanged) patch.end_time = endIso
    if (noteChanged) patch.note = noteValue
    if (suffixChanged) patch.filename = `${filenamePrefix}${suffixValue}`
    if (Object.keys(patch).length === 0) return
    onSave(patch)
    setTouched(false)
  }

  // The Duration row shows a padlock to make "not editable" explicit (FR-INS-02).
  return (
    <aside
      aria-label="Clip inspector"
      className="flex w-full flex-col overflow-hidden border-l border-line bg-surface"
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Inspector</h2>
        <Button size="icon" variant="ghost" aria-label="Clear selection" onClick={onCancel}>
          <XCircle className="h-4 w-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {/* --- identity --- */}
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-default">
                {displayTitle(event.media_title) || 'Untitled'}
              </p>
              <p className="mt-0.5 truncate font-mono text-2xs text-subtle" title={event.media_file_path}>
                {event.media_file_path || '—'}
              </p>
            </div>
            <StatusBadge status={event.status} />
          </div>

          {(locked || live || (event.media_item === null && event.action_type !== 'RECORD')) && (
            <div
              className={cn(
                'flex items-start gap-2 rounded-md border border-line px-2.5 py-2 text-2xs leading-relaxed',
                live
                  ? 'border-l-danger bg-danger-soft text-default'
                  : 'border-l-warn bg-warn-soft text-default',
              )}
            >
              {live ? (
                <Ban className="mt-px h-3.5 w-3.5 shrink-0 text-danger" />
              ) : (
                <LockIcon className="mt-px h-3.5 w-3.5 shrink-0 text-warn" />
              )}
              <span>
                {live
                  ? isRecording
                    ? 'Recording now — the end time and duration can still be adjusted, but it cannot be moved or deleted. Use Stop now to end it.'
                    : 'On air — this item cannot be moved, retimed or deleted.'
                  : locked
                    ? `Inside the ${LOCK_WINDOW_LABEL} lock window — changes are refused by the server.`
                    : 'The media file behind this event no longer exists on the agent. It cannot be played; delete it or re-point it at a current file.'}
              </span>
            </div>
          )}
        </div>

        <Divider />

        {/* --- fields --- */}
        <dl className="space-y-2.5">
          <Row label="Channel">
            <span className="text-xs font-bold text-accent">
              {pipeline?.name ?? '—'}
              <span className="text-2xs font-normal text-subtle">
                {' '}
                · Ch{pipeline?.primary_channel_number ?? '—'}
              </span>
            </span>
          </Row>

          {event.media_lane === 'FILE' && chainSize > 1 && (
            <Row label="Ad break">
              <button
                type="button"
                onClick={onOpenChain}
                className="inline-flex items-center gap-1 text-2xs font-medium text-accent hover:underline"
              >
                <Layers3 className="h-3 w-3" />
                {chainSize} commercials in this break
              </button>
            </Row>
          )}

          {isRecording && (
            <>
              <Row label="Prefix">
                <span className="truncate font-mono text-2xs text-muted">{filenamePrefix || '—'}</span>
              </Row>
              <Row label="Name">
                <Input
                  value={suffixValue}
                  disabled={locked || onAir}
                  onChange={(event_) => {
                    setTouched(true)
                    setSuffixValue(event_.target.value)
                  }}
                  className="h-8 text-xs"
                />
              </Row>
            </>
          )}

          <Row label="Start">
            <Input
              type="datetime-local"
              step={1}
              value={startValue}
              disabled={!canEditStart}
              onChange={(event_) => {
                setTouched(true)
                setStartValue(event_.target.value)
              }}
              className="tnum h-8 text-xs"
              hint={
                canEditStart
                  ? undefined
                  : onAir
                    ? 'Read-only while on air'
                    : terminal
                      ? 'Finished items cannot be retimed'
                      : `Locks ${LOCK_WINDOW_LABEL} before start`
              }
            />
          </Row>

          <Row label="End">
            {isRecording || isHeld ? (
              <Input
                type="datetime-local"
                step={1}
                value={endValue}
                disabled={!canEditEnd}
                onChange={(event_) => {
                  setTouched(true)
                  setEndValue(event_.target.value)
                }}
                className="tnum h-8 text-xs"
                hint={
                  canEditEnd
                    ? isRecording
                      ? 'Sets when the recording stops'
                      : 'Held graphics run until this time'
                    : terminal
                      ? 'Finished items cannot be retimed'
                      : 'Read-only while on air'
                }
              />
            ) : (
              <span className="text-2xs text-default">
                <span className="text-subtle">Derived · </span>
                {formatFull(event.effective_end_time ?? null, CHANNEL_TIMEZONE)}
              </span>
            )}
          </Row>

          <Row label="Duration">
            {isRecording || isHeld ? (
              <Input
                value={durationValue}
                disabled={!canEditEnd}
                inputMode="numeric"
                title="HH:MM:SS — editing this moves the end time"
                onChange={(event_) => {
                  const value = event_.target.value
                  setDurationValue(value)
                  setTouched(true)
                  const nextDuration = parseDurationInput(value)
                  const startWall = Date.parse(`${startValue}Z`)
                  if (nextDuration !== null && !Number.isNaN(startWall)) {
                    setEndValue(fromWallMs(startWall + nextDuration))
                  }
                }}
                onFocus={() => {
                  durationFocused.current = true
                }}
                onBlur={() => {
                  durationFocused.current = false
                  const startWall = Date.parse(`${startValue}Z`)
                  const endWall = Date.parse(`${endValue}Z`)
                  if (!Number.isNaN(startWall) && !Number.isNaN(endWall)) {
                    setDurationValue(toDurationInput(endWall - startWall))
                  }
                }}
                className="tnum h-8 text-xs"
              />
            ) : (
              <span
                className="tnum text-2xs text-default"
                title="Always derived on the server. An event is a start, not a block."
              >
                {formatDurationHhmmssmmm(previewDurationMs / 1000)}
                <Lock className="ml-1.5 inline h-2.5 w-2.5 text-subtle" />
              </span>
            )}
          </Row>

          <Row label="Note">
            <textarea
              value={noteValue}
              disabled={locked || onAir}
              onChange={(event_) => {
                setTouched(true)
                setNoteValue(event_.target.value)
              }}
              rows={2}
              placeholder="Optional operator note"
              className="w-full rounded-md border border-line bg-inset px-2 py-1.5 text-xs text-default placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] disabled:opacity-50"
            />
          </Row>
        </dl>

        <Divider />

        <dl className="space-y-1.5 text-2xs">
          <Row label="Event ID">
            <span className="tnum font-mono text-muted">#{event.id}</span>
          </Row>
          <Row label="Version">
            <span className="tnum font-mono text-muted">v{event.version}</span>
          </Row>
          <Row label="Duration (server)">
            <span className="tnum text-muted">
              {formatShortDuration(toNumber(event.duration_seconds) ?? 0)}
            </span>
          </Row>
          <Row label="Last updated">
            <span className="text-muted">{formatFull(event.updated_at, CHANNEL_TIMEZONE)}</span>
          </Row>
        </dl>

        {validation && touched && (
          <p role="alert" className="mt-3 rounded-md bg-danger-soft px-2.5 py-2 text-2xs text-danger">
            {validation}
          </p>
        )}
      </div>

      {/* --- actions --- */}
      <footer className="flex items-center gap-2 border-t border-line bg-inset px-4 py-3">
        {canStop && onStopNow && (
          <Tooltip
            content={
              stopAllowed
                ? 'Stop this recording now'
                : `Stoppable in ${Math.ceil(stopInMs / 1000)}s — a recording must run for at least 10 seconds`
            }
          >
            <Button
              variant="danger"
              size="sm"
              disabled={!stopAllowed}
              onClick={onStopNow}
              icon={<Square className="h-3.5 w-3.5" />}
            >
              Stop now
            </Button>
          </Tooltip>
        )}

        <Tooltip content={deleteBlocked ? deleteBlockMessage(deleteBlocked) : 'Delete this item'}>
          <Button
            variant="danger"
            size="sm"
            disabled={!canDelete}
            onClick={onDelete}
            icon={<Trash2 className="h-3.5 w-3.5" />}
          >
            Delete
          </Button>
        </Tooltip>

        <Button variant="ghost" size="sm" onClick={onCancel}>
          Close
        </Button>

        <Button
          variant="primary"
          size="sm"
          className="ml-auto"
          loading={isSaving}
          disabled={!dirty || (!canEditStart && !canEditEnd && !canEditNote)}
          onClick={save}
          icon={<Save className="h-3.5 w-3.5" />}
        >
          Save
        </Button>
      </footer>

      {!canEditStart && !canEditEnd && !canEditNote && dirty && (
        <p className="border-t border-line bg-warn-soft px-4 py-2 text-2xs text-warn">
          <FileText className="mr-1 inline h-3 w-3" />
          {onAir
            ? 'On-air items are read-only.'
            : 'This item has finished and can no longer be edited.'}
        </p>
      )}
    </aside>
  )
}

// ---------------------------------------------------------------------------

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-start gap-2">
      <dt className="pt-1 text-2xs text-subtle">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function Divider() {
  return <div className="my-4 h-px bg-line" />
}

/** WF-18 client mirror. The server is the control; this only saves a round-trip. */
function validateInspector({
  startIso,
  endIso,
  canEditStart,
  canEditEnd,
  previewDurationMs,
  minDurationMs,
}: {
  startIso: string | null
  endIso: string | null
  canEditStart: boolean
  canEditEnd: boolean
  previewDurationMs: number
  minDurationMs: number
}): string | null {
  if (!startIso) return 'Enter a valid start time.'
  if (canEditStart && Date.parse(startIso) < Date.now() - 1000) {
    return 'The start time is in the past.'
  }
  // A read-only end is not an operator change: validating it would block an
  // unrelated Note edit on every finished item.
  if (canEditEnd && endIso) {
    if (Date.parse(endIso) <= Date.parse(startIso)) return 'The end time must be after the start time.'
    if (Date.parse(endIso) < Date.now() - 1000) return 'The end time must be in the future.'
    if (minDurationMs > 0 && previewDurationMs < minDurationMs) {
      return `A recording must be at least ${Math.round(minDurationMs / 1000)} seconds long.`
    }
  }
  return null
}