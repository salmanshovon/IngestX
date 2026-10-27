import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Download, FileSpreadsheet, Filter, RefreshCw } from 'lucide-react'

import type { LogReportParams } from '@/api/reports'
import { reportsApi } from '@/api/reports'
import type { LogReportResponse, MediaType, ReportRow, ScheduleStatus } from '@/api/types'
import { CHANNEL_TIMEZONE } from '@/config'
import { usePipelines, useServers } from '@/hooks/use-playout-data'
import { isApiError } from '@/lib/api-client'
import { cn } from '@/lib/cn'
import {
  formatDate,
  displayTitle,
  formatDurationHhmmssmmm,
  formatFull,
  sanitiseFilename,
  STATUS_LABEL,
  toNumber,
} from '@/lib/format'
import { notify } from '@/stores/notification-store'
import { useUiStore } from '@/stores/ui-store'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Checkbox, Label } from '@/components/ui/toggle'
import {
  Badge,
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  Spinner,
  StatusBadge,
} from '@/components/ui/primitives'
import { SortHeader, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import { ErrorBoundary } from '@/components/layout/error-boundary'

type SortKey = 'scheduled_time' | 'duration_seconds' | 'media_title' | 'media_type' | 'template_name' | 'status'
type SortDirection = 'asc' | 'desc'

const TYPE_CHECKBOXES: Array<{ value: MediaType; label: string }> = [
  { value: 'FILE', label: 'Commercials' },
  { value: 'CG', label: 'Graphics' },
  { value: 'SCG', label: 'Standing CG' },
]

/**
 * As-run report (FR-XL-01 .. FR-XL-10).
 *
 * Two things here are not cosmetic:
 *
 * - **The default range is yesterday 00:00 → today 23:59** (FR-XL-02). A
 *   broadcast day is not the calendar day, and an operator opening this tab
 *   wants the last shift, not the epoch.
 * - **Out-of-order responses are discarded** (FR-XL-08). Changing a filter
 *   fires several requests; without a monotonic token a slow early request can
 *   land last and overwrite the newer result. The token is the only defence,
 *   because React Query will happily hand back the stale one.
 */
export function ExecLogPage() {
  const serversQuery = useServers()
  const servers = useMemo(() => serversQuery.data ?? [], [serversQuery.data])

  const activePipelineId = useUiStore((state) => state.activePipelineId)
  const setActivePipelineId = useUiStore((state) => state.setActivePipelineId)
  const pipelinesQuery = usePipelines()
  const pipelines = useMemo(() => pipelinesQuery.data ?? [], [pipelinesQuery.data])

  useEffect(() => {
    if (activePipelineId === null && pipelines.length > 0) setActivePipelineId(pipelines[0].id)
  }, [activePipelineId, pipelines, setActivePipelineId])

  const [serverId, setServerId] = useState<string>('')
  const [pipelineId, setPipelineId] = useState<string>('')
  const [startDate, setStartDate] = useState(() => daysAgo(1))
  const [endDate, setEndDate] = useState(() => today())
  const [types, setTypes] = useState<Set<MediaType>>(new Set(TYPE_CHECKBOXES.map((t) => t.value)))
  const [status, setStatus] = useState<string>('')

  const [sortKey, setSortKey] = useState<SortKey>('scheduled_time')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [manualRefresh, setManualRefresh] = useState(0)

  // Filter pipelines by the chosen server.
  useEffect(() => {
    if (serverId === '') return
    const filtered = pipelines.filter((pipeline) => String(pipeline.server) === serverId)
    if (filtered.length > 0 && !filtered.some((pipeline) => String(pipeline.id) === pipelineId)) {
      setPipelineId(String(filtered[0].id))
    }
  }, [serverId, pipelines, pipelineId])

  const effectivePipelineId = pipelineId === '' ? (activePipelineId ?? pipelines[0]?.id ?? null) : Number(pipelineId)

  const dateError = useMemo(() => {
    if (!startDate || !endDate) return null
    if (endDate < startDate) return 'The end date must not be earlier than the start date.'
    return null
  }, [startDate, endDate])

  const requestToken = useRef(0)
  const [report, setReport] = useState<LogReportResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const params: LogReportParams | null = useMemo(() => {
    if (effectivePipelineId === null || dateError) return null
    return {
      pipeline_id: effectivePipelineId,
      start_date: startDate,
      end_date: endDate,
      status: status === '' ? undefined : (status as ScheduleStatus),
    }
  }, [effectivePipelineId, startDate, endDate, status, dateError])

  useEffect(() => {
    if (!params) {
      setReport(null)
      return
    }
    const token = ++requestToken.current
    const controller = new AbortController()
    setLoading(true)
    setError(null)

    reportsApi
      .log(params, controller.signal)
      .then((response) => {
        // FR-XL-08: a later request has already started; this answer is stale.
        if (token !== requestToken.current) return
        setReport(response)
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        if (token !== requestToken.current) return
        setError(
          isApiError(cause)
            ? cause.message
            : 'Could not reach the IngestX server.',
        )
      })
      .finally(() => {
        if (token === requestToken.current) setLoading(false)
      })

    return () => controller.abort()
  }, [params, manualRefresh])

  const rows = useMemo(() => {
    const list = report?.events ?? []
    const filtered = list.filter((row) => types.has(row.media_type as MediaType))
    const direction = sortDirection === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const left = sortValue(a, sortKey)
      const right = sortValue(b, sortKey)
      if (left === right) return a.id - b.id
      return left < right ? -direction : direction
    })
  }, [report, types, sortKey, sortDirection])

  function handleSort(column: string) {
    const key = column as SortKey
    if (key === sortKey) setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDirection('asc')
    }
  }

  async function handleExport() {
    if (!params) return
    setExporting(true)
    try {
      // FR-XL-07: exports exactly the filtered, sorted view the operator sees.
      const csv = toCsv(rows, sortKey, sortDirection)
      const pipeline = pipelines.find((entry) => entry.id === params.pipeline_id)
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = sanitiseFilename(
        `asrun_${pipeline?.name ?? 'pipeline'}_${startDate}_${endDate}.csv`,
      )
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      notify.success(`Exported ${rows.length} row(s)`)
    } catch (cause) {
      notify.error('Export failed', cause instanceof Error ? cause.message : 'Unknown error')
    } finally {
      setExporting(false)
    }
  }

  async function handleServerExport() {
    if (!params) return
    setExporting(true)
    try {
      const blob = await reportsApi.exportCsv(params)
      const pipeline = pipelines.find((entry) => entry.id === params.pipeline_id)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = sanitiseFilename(
        `asrun_${pipeline?.name ?? 'pipeline'}_${startDate}_${endDate}.csv`,
      )
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      notify.success('Server-side export downloaded')
    } catch (cause) {
      notify.error('Server export failed', cause instanceof Error ? cause.message : 'Unknown error')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Execution Log"
        description="As-run report — what the engine actually put to air."
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              loading={loading}
              icon={<RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />}
              onClick={() => setManualRefresh((n) => n + 1)}
            >
              Refresh
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={rows.length === 0 || exporting}
              loading={exporting}
              icon={<Download className="h-3.5 w-3.5" />}
              onClick={handleExport}
            >
              Export CSV
            </Button>
          </>
        }
      />

      <div className="space-y-4 p-6">
        {/* --- filters --- */}
        <Panel bodyClassName="p-4">
          <div className="mb-3 flex items-center gap-2 text-2xs font-semibold tracking-wide text-muted uppercase">
            <Filter className="h-3.5 w-3.5" /> Filters
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Server">
              <Select
                value={serverId}
                onValueChange={setServerId}
                options={[
                  { value: '', label: 'All servers' },
                  ...servers.map((server) => ({ value: String(server.id), label: server.name })),
                ]}
                className="w-full"
                aria-label="Server"
              />
            </Field>

            <Field label="Channel">
              <Select
                value={pipelineId === '' ? (effectivePipelineId ? String(effectivePipelineId) : '') : pipelineId}
                onValueChange={setPipelineId}
                options={pipelines
                  .filter((pipeline) => serverId === '' || String(pipeline.server) === serverId)
                  .map((pipeline) => ({
                    value: String(pipeline.id),
                    label: `${pipeline.name} (Ch${pipeline.primary_channel_number})`,
                  }))}
                placeholder="Select a channel"
                className="w-full"
                aria-label="Channel"
              />
            </Field>

            <Field label="Start date">
              <input
                type="date"
                value={startDate}
                max={endDate || undefined}
                onChange={(event) => setStartDate(event.target.value)}
                className={cn(
                  'h-9 w-full rounded-md border bg-inset px-2.5 text-sm text-default',
                  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]',
                  dateError ? 'border-danger' : 'border-line',
                )}
              />
            </Field>

            <Field label="End date">
              <input
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={(event) => setEndDate(event.target.value)}
                className={cn(
                  'h-9 w-full rounded-md border bg-inset px-2.5 text-sm text-default',
                  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]',
                  dateError ? 'border-danger' : 'border-line',
                )}
              />
            </Field>

            <Field label="Status">
              <Select
                value={status}
                onValueChange={setStatus}
                options={[
                  { value: '', label: 'Any status' },
                  ...(['PENDING', 'PLAYING', 'COMPLETED', 'FAILED', 'CANCELLED'] as ScheduleStatus[]).map(
                    (value) => ({ value, label: STATUS_LABEL[value] }),
                  ),
                ]}
                className="w-full"
                aria-label="Status"
              />
            </Field>
          </div>

          {/* FR-XL-03: rejected inline, before any request is made. */}
          {dateError && (
            <p role="alert" className="mt-3 flex items-center gap-1.5 text-2xs text-danger">
              <AlertCircle className="h-3.5 w-3.5" />
              {dateError}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-3">
            <span className="text-2xs font-semibold tracking-wide text-muted uppercase">Type</span>
            {TYPE_CHECKBOXES.map((entry) => (
              <label key={entry.value} className="flex cursor-pointer items-center gap-1.5 text-2xs text-muted">
                <Checkbox
                  checked={types.has(entry.value)}
                  onCheckedChange={(checked) =>
                    setTypes((current) => {
                      const next = new Set(current)
                      if (checked) next.add(entry.value)
                      else next.delete(entry.value)
                      return next
                    })
                  }
                />
                {entry.label}
              </label>
            ))}

            <div className="ml-auto flex items-center gap-3">
              {/* FR-XL-04: "N of M" makes the type filter's effect legible. */}
              <span className="tnum text-2xs text-muted">
                <span className="font-semibold text-default">{rows.length}</span> of{' '}
                <span className="font-semibold text-default">{report?.total_events ?? 0}</span> event(s)
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleServerExport}
                disabled={exporting || !params}
                icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
                title="Download the full report from the server (for ranges too large to hold in the browser)"
              >
                Server export
              </Button>
            </div>
          </div>
        </Panel>

        {/* --- table --- */}
        <ErrorBoundary level="tab" label="Execution log">
          <Panel bodyClassName="max-h-[62vh] overflow-auto">
            {loading && !report ? (
              <div className="flex justify-center py-16">
                <Spinner label="Building the report…" />
              </div>
            ) : error ? (
              <ErrorState title="Could not load the report" description={error} onRetry={() => setManualRefresh((n) => n + 1)} />
            ) : rows.length === 0 ? (
              <EmptyState
                icon={<FileSpreadsheet className="h-5 w-5" />}
                title="No events in this range"
                description={
                  dateError
                    ? 'Fix the date range to run a report.'
                    : 'Widen the date range or clear the type filters.'
                }
              />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <SortHeader label="Scheduled" column="scheduled_time" active={sortKey === 'scheduled_time'} direction={sortDirection} onSort={handleSort} />
                    <SortHeader label="Duration" column="duration_seconds" active={sortKey === 'duration_seconds'} direction={sortDirection} onSort={handleSort} />
                    <SortHeader label="Title" column="media_title" active={sortKey === 'media_title'} direction={sortDirection} onSort={handleSort} />
                    <SortHeader label="Type" column="media_type" active={sortKey === 'media_type'} direction={sortDirection} onSort={handleSort} />
                    <TH>Template</TH>
                    <SortHeader label="Status" column="status" active={sortKey === 'status'} direction={sortDirection} onSort={handleSort} />
                    <TH className="w-14 text-right">Lane</TH>
                  </tr>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <ReportRowView key={row.id} row={row} />
                  ))}
                </TBody>
              </Table>
            )}
          </Panel>
        </ErrorBoundary>

        {report && (
          <p className="text-2xs text-subtle">
            Durations are derived server-side using the same precedence the engine uses, so a CG
            reports its template length rather than its (zero) file length. Times shown in{' '}
            {CHANNEL_TIMEZONE}.
          </p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function ReportRowView({ row }: { row: ReportRow }) {
  return (
    <TR>
      <TD>
        <span className="tnum block text-xs text-default">
          {formatFull(row.scheduled_time, CHANNEL_TIMEZONE)}
        </span>
        <span className="tnum block text-[10px] text-subtle">
          {formatDate(row.scheduled_time, CHANNEL_TIMEZONE)}
        </span>
      </TD>
      <TD numeric>
        {/* FR-XL-06: hh:mm:ss.mmm, exactly as the engine's own report renders. */}
        <span className="tnum text-2xs">{row.duration_display || formatDurationHhmmssmmm(row.duration_seconds)}</span>
      </TD>
      <TD>
        <span className="block truncate text-xs text-default">
          {row.media_title ? displayTitle(row.media_title) : '—'}
        </span>
        <span className="block truncate font-mono text-[10px] text-subtle">{row.media_file_path}</span>
      </TD>
      <TD>
        <Badge tone={row.media_type === 'FILE' ? 'info' : 'accent'}>
          {row.media_type || '—'}
        </Badge>
      </TD>
      <TD>
        <span className="text-2xs text-muted">{row.template_name || '—'}</span>
      </TD>
      <TD>
        <StatusBadge status={row.status} />
      </TD>
      <TD>
        <span className="text-2xs text-subtle">{row.media_lane ?? '—'}</span>
      </TD>
    </TR>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <Label className="mb-1.5 block">{label}</Label>
      {children}
    </label>
  )
}

function sortValue(row: ReportRow, key: SortKey): string | number {
  switch (key) {
    case 'scheduled_time':
      return Date.parse(row.scheduled_time)
    case 'duration_seconds':
      return toNumber(row.duration_seconds) ?? 0
    case 'media_title':
      return (row.media_title ?? '').toLowerCase()
    case 'media_type':
      return row.media_type ?? ''
    case 'template_name':
      return (row.template_name ?? '').toLowerCase()
    case 'status':
      return row.status
    default:
      return 0
  }
}

/** CSV with the server's own column set, in the operator's current sort order. */
function toCsv(rows: ReportRow[], sortKey: SortKey, direction: SortDirection): string {
  const header = [
    'scheduled_time',
    'duration_display',
    'duration_seconds',
    'media_title',
    'media_type',
    'template_name',
    'media_lane',
    'status',
    'media_file_path',
  ]
  const sorted = [...rows].sort((a, b) => {
    const left = sortValue(a, sortKey)
    const right = sortValue(b, sortKey)
    if (left === right) return 0
    return (left < right ? -1 : 1) * (direction === 'asc' ? 1 : -1)
  })

  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

  return [
    header.join(','),
    ...sorted.map((row) =>
      [
        row.scheduled_time,
        row.duration_display,
        row.duration_seconds,
        displayTitle(row.media_title),
        row.media_type,
        row.template_name,
        row.media_lane,
        row.status,
        row.media_file_path,
      ]
        .map(escape)
        .join(','),
    ),
  ].join('\n')
}

// --- date helpers (channel-agnostic; the browser's calendar is the operator's) ---
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysAgo(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return date.toISOString().slice(0, 10)
}


