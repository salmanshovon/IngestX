/** Playout domain: servers, pipelines, media, templates, schedule, bridge. */
import { api } from '@/lib/api-client'
import type {
  BridgeDelivery,
  BulkDeleteResult,
  BulkOperationResult,
  ChainPreview,
  CreateChainInput,
  CreateEventInput,
  GraphicsTemplate,
  MediaItem,
  MediaType,
  Pipeline,
  ReinitResult,
  RetimeChange,
  RetimeResult,
  ScanMediaResult,
  ScheduleEvent,
  ScheduleListResponse,
  ScheduleStatus,
  Server,
  ServerEngineState,
} from './types'

export const serversApi = {
  list: () => api.get<Server[]>('/servers'),

  create: (input: Partial<Server>) => api.post<Server>('/servers', input),

  detail: (id: number) => api.get<Server>(`/servers/${id}`),

  update: (id: number, input: Partial<Server>) => api.patch<Server>(`/servers/${id}`, input),

  remove: (id: number) => api.delete<void>(`/servers/${id}`),

  engineState: (id: number) => api.get<ServerEngineState>(`/servers/${id}/engine-state`),

  /** Raw token, shown exactly once. Never stored. */
  issueEngineToken: (id: number) =>
    api.post<{ token: string; server: string }>(`/servers/${id}/issue-engine-token`),

  /** WF-06: asks the agent for its media list over the WebSocket bridge. */
  scanMedia: (id: number) => api.post<ScanMediaResult>(`/servers/${id}/scan-media`),
}

export const pipelinesApi = {
  list: (params: { server?: number } = {}) =>
    api.get<Pipeline[]>('/playout-channels', { server: params.server }),

  create: (input: Partial<Pipeline>) => api.post<Pipeline>('/playout-channels', input),

  detail: (id: number) => api.get<Pipeline>(`/playout-channels/${id}`),

  update: (id: number, input: Partial<Pipeline>) =>
    api.patch<Pipeline>(`/playout-channels/${id}`, input),

  remove: (id: number) => api.delete<void>(`/playout-channels/${id}`),

  reinitStream: (id: number) => api.post<ReinitResult>(`/playout-channels/${id}/reinit`),

  reinitPreview: (id: number) => api.post<ReinitResult>(`/playout-channels/${id}/reinit_preview`),
}

export interface MediaListParams {
  server?: number
  media_type?: MediaType
  active_status?: boolean
  search?: string
}

export const mediaApi = {
  list: (params: MediaListParams = {}) =>
    api.get<MediaItem[]>('/media-items', {
      server: params.server,
      media_type: params.media_type,
      active_status: params.active_status,
      search: params.search,
    }),

  create: (input: Partial<MediaItem>) => api.post<MediaItem>('/media-items', input),

  detail: (id: number) => api.get<MediaItem>(`/media-items/${id}`),

  update: (id: number, input: Partial<MediaItem>) => api.patch<MediaItem>(`/media-items/${id}`, input),

  remove: (id: number) => api.delete<void>(`/media-items/${id}`),

  /** WF-08 / BR-MED-04. Partial success is reported per id. */
  bulkStatus: (ids: number[], active_status: boolean) =>
    api.patch<BulkOperationResult>('/media-items/bulk-status', { ids, active_status }),

  /** WF-09 / BR-MED-05. Distinguishes "not found" from "Not a CG item". */
  bulkTemplate: (ids: number[], templateId: number) =>
    api.patch<BulkOperationResult>('/media-items/bulk-template', {
      ids,
      template_id: templateId,
    }),
}

export const templatesApi = {
  list: () => api.get<GraphicsTemplate[]>('/graphics-templates'),

  create: (input: Partial<GraphicsTemplate>) => api.post<GraphicsTemplate>('/graphics-templates', input),

  detail: (id: number) => api.get<GraphicsTemplate>(`/graphics-templates/${id}`),

  update: (id: number, input: Partial<GraphicsTemplate>) =>
    api.patch<GraphicsTemplate>(`/graphics-templates/${id}`, input),

  /** Blocked with 409 TEMPLATE_IN_USE while referenced, unless `detach`. */
  remove: (id: number, detach = false) =>
    api.delete<void>(`/graphics-templates/${id}`, undefined, { detach: detach || undefined }),
}

export interface ScheduleListParams {
  pipeline_id?: number
  from?: string
  to?: string
  lane?: string
  status?: ScheduleStatus
  media_type?: MediaType
  offset?: number
  page_size?: number
}

export const schedulesApi = {
  list: (params: ScheduleListParams = {}, signal?: AbortSignal) =>
    api.get<ScheduleListResponse>(
      '/schedules',
      {
        pipeline_id: params.pipeline_id,
        from: params.from,
        to: params.to,
        lane: params.lane,
        status: params.status,
        media_type: params.media_type,
        offset: params.offset,
        page_size: params.page_size,
      },
      signal,
    ),

  create: (input: CreateEventInput) => api.post<ScheduleEvent>('/schedules', input),

  /** BR-SCH-14: a whole ad break in one atomic request. */
  createChain: (input: CreateChainInput) =>
    api.post<{ created: ScheduleEvent[]; count: number }>('/schedules', input),

  detail: (id: number) => api.get<ScheduleEvent>(`/schedules/${id}`),

  /**
   * Partial update. `version` is the optimistic-concurrency token (AP-6): send
   * the version you read or the server refuses the write with VERSION_MISMATCH.
   */
  update: (
    id: number,
    input: Partial<{
      scheduled_time: string
      end_time: string | null
      hold_seconds: string | null
      note: string
      media_lane: string
      media_item: number
      version: number
    }>,
  ) => api.patch<ScheduleEvent>(`/schedules/${id}`, input),

  remove: (id: number) => api.delete<BulkDeleteResult>(`/schedules/${id}`),

  /** BR-SCH-16: prefer this over a hard delete for anything not yet fired. */
  cancel: (id: number) => api.post<ScheduleEvent>(`/schedules/${id}/cancel`),
  /** End a running held graphic right now. */
  stop: (id: number) => api.post<ScheduleEvent>(`/schedules/${id}/stop`),

  /** BR-SCH-07: all-or-nothing batch retime. This is chain reordering. */
  retimeBatch: (changes: RetimeChange[]) =>
    api.patch<RetimeResult>('/schedules/times', { changes }),

  bulkDelete: (ids: number[]) => api.delete<BulkDeleteResult>('/schedules/bulk', { ids }),

  /** AC-35: grouping exactly as the agent will compute it. */
  chainPreview: (pipelineId: number, anchorId?: number) =>
    api.get<ChainPreview[]>('/schedules/chain-preview', {
      pipeline_id: pipelineId,
      anchor_id: anchorId,
    }),
}

export const bridgeApi = {
  deliveries: (params: { server?: number; status?: string } = {}) =>
    api.get<BridgeDelivery[]>('/bridge/deliveries', {
      server: params.server,
      status: params.status,
    }),
}