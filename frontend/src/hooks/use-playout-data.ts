/**
 * React Query bindings for the playout domain (FR-ST-01).
 *
 * Stale times are chosen per resource, not globally: pipelines change rarely
 * and a 30s window is fine, while a media scan must show up immediately.
 * Everything here is a thin, typed wrapper -- no component should call the API
 * modules directly.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query'

import { mediaApi, pipelinesApi, schedulesApi, serversApi, templatesApi, bridgeApi } from '@/api/playout'
import type {
  BridgeDelivery,
  ChainPreview,
  CreateEventInput,
  GraphicsTemplate,
  MediaItem,
  Pipeline,
  RetimeChange,
  ScheduleEvent,
  Server,
  ServerEngineState,
} from '@/api/types'
import { ApiError, api, isApiError, primeCsrfCookie } from '@/lib/api-client'
import { CHANNEL_TIMEZONE, SCHEDULE_POLL_MS } from '@/config'
import { queryKeys } from '@/lib/format'
import { notify } from '@/stores/notification-store'

/**
 * The engine is authoritative for execution state, so the schedule list is the
 * one query that must never sit stale. 30s polling is the contractual fallback
 * when realtime is down (FR-RT-02); it runs regardless so a missed SSE frame
 * self-heals.
 */
const SCHEDULE_STALE_MS = 10_000
const SERVER_STALE_MS = 20_000

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

export function useServers() {
  return useQuery({
    queryKey: queryKeys.servers,
    queryFn: () => serversApi.list(),
    staleTime: SERVER_STALE_MS,
    refetchInterval: 30_000,
  })
}

export function useServerEngineState(serverId: number | null) {
  return useQuery({
    queryKey: queryKeys.serverState(serverId ?? 0),
    queryFn: () => serversApi.engineState(serverId as number),
    enabled: serverId !== null,
    staleTime: 10_000,
    refetchInterval: 20_000,
  })
}

export function useScanMedia() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (serverId: number) => serversApi.scanMedia(serverId),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: queryKeys.media(result.server_id) })
      client.invalidateQueries({ queryKey: queryKeys.media() })
      notify.success(
        `Scan complete — ${result.count} file${result.count === 1 ? '' : 's'}`,
        `${result.created} new · ${result.updated} updated · ${result.deleted} removed`,
      )
    },
  })
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

export function usePipelines(serverId?: number) {
  return useQuery({
    queryKey: queryKeys.pipelines(serverId),
    queryFn: () => pipelinesApi.list(serverId ? { server: serverId } : {}),
    staleTime: 15_000,
  })
}

function useReinit(pipelineId: number, kind: 'stream' | 'preview') {
  const client = useQueryClient()
  const isStream = kind === 'stream'
  return useMutation({
    mutationFn: () =>
      isStream ? pipelinesApi.reinitStream(pipelineId) : pipelinesApi.reinitPreview(pipelineId),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: queryKeys.pipelines() })
      // "delivered" means the agent socket accepted it; "deferred" means the
      // push is queued for retry and the operator must know (FR-NF-02).
      if (result.delivery === 'deferred') {
        notify.warning(
          `${isStream ? 'Stream' : 'Preview'} re-init queued`,
          'The playout agent is unreachable. The command will be retried automatically.',
        )
      } else {
        notify.success(`${isStream ? 'Stream' : 'Preview'} re-init sent to the agent`)
      }
    },
    onError: (error) => {
      const apiError = error as ApiError
      if (isApiError(apiError) && apiError.code === 'AGENT_UNREACHABLE') {
        notify.warning('The playout agent is unreachable', 'The request was queued for retry.')
      } else {
        notify.error(`Re-init failed`, apiError.message)
      }
    },
  })
}

export const useReinitStream = (pipelineId: number) => useReinit(pipelineId, 'stream')
export const useReinitPreview = (pipelineId: number) => useReinit(pipelineId, 'preview')

// ---------------------------------------------------------------------------
// Media & templates
// ---------------------------------------------------------------------------

export interface MediaFilters {
  serverId?: number
  mediaType?: string
  search?: string
  activeOnly?: boolean
}

export function useMedia(filters: MediaFilters = {}) {
  return useQuery({
    queryKey: ['media', filters.serverId ?? 'all', filters.mediaType ?? 'all', filters.search ?? '', filters.activeOnly ?? false],
    queryFn: () =>
      mediaApi.list({
        server: filters.serverId,
        media_type: filters.mediaType as never,
        search: filters.search,
        active_status: filters.activeOnly ? true : undefined,
      }),
    staleTime: 20_000,
  })
}

export function useTemplates() {
  return useQuery({
    queryKey: queryKeys.templates,
    queryFn: () => templatesApi.list(),
    staleTime: 5 * 60_000,
  })
}

export function useBulkMediaStatus() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ ids, active }: { ids: number[]; active: boolean }) =>
      mediaApi.bulkStatus(ids, active),
    onSuccess: (result, variables) => {
      client.invalidateQueries({ queryKey: ['media'] })
      if (result.failed.length > 0) {
        notify.warning(
          `${result.updated.length} updated, ${result.failed.length} failed`,
          result.failed[0]?.error,
        )
      } else {
        notify.success(
          `${result.updated.length} item(s) ${variables.active ? 'activated' : 'deactivated'}`,
        )
      }
    },
    onError: (error) => notify.error('Bulk update failed', (error as ApiError).message),
  })
}

export function useBulkTemplate() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ ids, templateId }: { ids: number[]; templateId: number }) =>
      mediaApi.bulkTemplate(ids, templateId),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ['media'] })
      if (result.failed.length > 0) {
        notify.warning(
          `${result.updated.length} assigned, ${result.failed.length} failed`,
          result.failed[0]?.error,
        )
      } else {
        notify.success(`Template assigned to ${result.updated.length} item(s)`)
      }
    },
    onError: (error) => notify.error('Template assignment failed', (error as ApiError).message),
  })
}

export function useSaveTemplate(): UseMutationResult<GraphicsTemplate, ApiError, Partial<GraphicsTemplate> & { id?: number }> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }) =>
      id === undefined
        ? templatesApi.create(input as Partial<GraphicsTemplate>)
        : templatesApi.update(id, input as Partial<GraphicsTemplate>),
    onSuccess: (template) => {
      client.invalidateQueries({ queryKey: queryKeys.templates })
      client.invalidateQueries({ queryKey: ['media'] })
      notify.success(template.name ? `Saved “${template.name}”` : 'Template saved')
    },
    onError: (error) => notify.error('Could not save the template', error.message),
  }) as UseMutationResult<GraphicsTemplate, ApiError, Partial<GraphicsTemplate> & { id?: number }>
}

export function useDeleteTemplate() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, detach }: { id: number; detach: boolean }) =>
      templatesApi.remove(id, detach),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.templates })
      client.invalidateQueries({ queryKey: ['media'] })
      notify.success('Template deleted')
    },
  })
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export interface ScheduleFilters {
  pipelineId?: number
  from?: string
  to?: string
}

/**
 * Channel-wide recording default (`RecordingSetting`).
 *
 * The schedule modal and Start Record both read the duration from here, so a
 * change in Settings takes effect on the very next slot/recording instead of
 * being a number the UI never looks at.
 */
export function useRecordSettings() {
  return useQuery({
    queryKey: queryKeys.recordSettings,
    queryFn: () => api.get<{ default_duration_minutes: number }>('/record-settings'),
    staleTime: 5 * 60_000,
  })
}

export function useSchedules(filters: ScheduleFilters = {}) {
  const from = filters.from
  const to = filters.to

  return useQuery({
    queryKey: ['schedules', filters.pipelineId ?? 'all', from ?? '', to ?? ''],
    queryFn: ({ signal }) =>
      schedulesApi.list(
        {
          pipeline_id: filters.pipelineId,
          from,
          to,
          page_size: 500,
        },
        signal,
      ),
    staleTime: SCHEDULE_STALE_MS,
    refetchInterval: SCHEDULE_POLL_MS,
    refetchOnWindowFocus: true,
    placeholderData: (previous) => previous,
  })
}

export function useChainPreview(pipelineId: number | null, anchorId?: number) {
  return useQuery({
    queryKey: [...queryKeys.chainPreview(pipelineId ?? 0), anchorId ?? 'all'],
    queryFn: () => schedulesApi.chainPreview(pipelineId as number, anchorId),
    enabled: pipelineId !== null,
    staleTime: 10_000,
  })
}

export interface CreateEventVariables {
  event: CreateEventInput
  /** Optimistically render before the server confirms (FR-ST-06). */
  optimisticId?: number
}

export function useCreateEvent() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async ({ event }: CreateEventVariables) => {
      await primeCsrfCookie()
      return schedulesApi.create(event)
    },
    onSuccess: (created) => {
      client.invalidateQueries({ queryKey: ['schedules'] })
      client.invalidateQueries({ queryKey: queryKeys.pipelines() })
      if (created.agent_delivery === 'deferred') {
        notify.warning(
          'Scheduled, but the agent was not reachable',
          'The change is saved and will be pushed when the agent reconnects.',
        )
      }
    },
  })
}

export function useCreateChain() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (input: Parameters<typeof schedulesApi.createChain>[0]) => {
      await primeCsrfCookie()
      return schedulesApi.createChain(input)
    },
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ['schedules'] })
      client.invalidateQueries({ queryKey: queryKeys.pipelines() })
      notify.success(`${result.count} clip${result.count === 1 ? '' : 's'} scheduled`)
    },
  })
}

export function useUpdateEvent() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      ...input
    }: { id: number; scheduled_time?: string; end_time?: string | null; hold_seconds?: string | null; note?: string; version: number }) => {
      void primeCsrfCookie()
      return schedulesApi.update(id, input)
    },
    onSuccess: (updated) => {
      patchScheduleCache(client, updated)
      if (updated.agent_delivery === 'deferred') {
        notify.warning('Saved, but delivery to the agent was deferred')
      }
    },
  })
}

export function useRetimeBatch() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (changes: RetimeChange[]) => {
      await primeCsrfCookie()
      return schedulesApi.retimeBatch(changes)
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['schedules'] })
      client.invalidateQueries({ queryKey: queryKeys.pipelines() })
    },
  })
}

export function useDeleteEvents() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (ids: number[]) => {
      await primeCsrfCookie()
      return ids.length === 1
        ? schedulesApi.remove(ids[0])
        : schedulesApi.bulkDelete(ids)
    },
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ['schedules'] })
      client.invalidateQueries({ queryKey: queryKeys.pipelines() })
      if (result.failed.length > 0) {
        notify.warning(
          `${result.deleted.length} deleted, ${result.failed.length} kept`,
          `${result.failed[0]?.error ?? ''} ${result.failed[0]?.code === 'LOCKED' ? 'It is inside its lock window.' : ''}`.trim(),
        )
      } else {
        notify.success(`${result.deleted.length} item(s) deleted`)
      }
    },
  })
}

export function useStopEvent() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      await primeCsrfCookie()
      return schedulesApi.stop(id)
    },
    onSuccess: (event) => {
      patchScheduleCache(client, event)
      notify.success('Stopping', `${event.media_lane} ends in under a second.`)
    },
    onError: (error) => {
      const apiError = error as ApiError
      if (isApiError(apiError) && apiError.code === 'ON_AIR') {
        notify.warning('That item is not running', 'There is nothing to stop.')
      } else {
        notify.error('Could not stop the graphic', apiError.message)
      }
    },
  })
}

export function useCancelEvent() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      await primeCsrfCookie()
      return schedulesApi.cancel(id)
    },
    onSuccess: (event) => {
      patchScheduleCache(client, event)
      notify.success('Event cancelled')
    },
    onError: (error) => {
      const apiError = error as ApiError
      if (isApiError(apiError) && apiError.code === 'ON_AIR') {
        notify.warning('That item is on air', 'An item already on air cannot be cancelled.')
      } else {
        notify.error('Could not cancel the event', apiError.message)
      }
    },
  })
}

export function useBridgeDeliveries(serverId?: number) {
  return useQuery({
    queryKey: queryKeys.deliveries(serverId),
    queryFn: () => bridgeApi.deliveries({ server: serverId }),
    staleTime: 15_000,
    refetchInterval: 30_000,
  })
}

/**
 * Splice a single event into the cached list without a round-trip.
 *
 * A full invalidate after every drag frame would be absurd; the server is still
 * the source of truth and a background refetch reconciles any drift.
 */
type SchedulePage = { count: number; offset: number; limit: number; results: ScheduleEvent[] }

function patchScheduleCache(client: ReturnType<typeof useQueryClient>, event: ScheduleEvent) {
  client.setQueriesData<SchedulePage>({ queryKey: ['schedules'] }, (existing) => {
    if (!existing) return existing
    const index = existing.results.findIndex((row) => row.id === event.id)
    if (index === -1) {
      return {
        ...existing,
        count: existing.count + 1,
        results: [...existing.results, event].sort(
          (a, b) => Date.parse(a.scheduled_time) - Date.parse(b.scheduled_time),
        ),
      }
    }
    const results = [...existing.results]
    results[index] = event
    return { ...existing, results }
  })
}

// ---------------------------------------------------------------------------
// Convenience selectors
// ---------------------------------------------------------------------------

export function usePipelineMap(): Map<number, Pipeline> {
  const { data } = usePipelines()
  return new Map((data ?? []).map((pipeline) => [pipeline.id, pipeline]))
}

export function useServerMap(): Map<number, Server> {
  const { data } = useServers()
  return new Map((data ?? []).map((server) => [server.id, server]))
}

export type { BridgeDelivery, ChainPreview, MediaItem, ServerEngineState }

/** The channel timezone is a single shared constant (FR-T-06). */
export const channelTimezone = CHANNEL_TIMEZONE