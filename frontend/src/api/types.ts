/**
 * Wire types for the PlyOut browser API (`/api/v1/`).
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * 1. **Decimals arrive as strings.** The serializer deliberately formats them
 *    (`format(value, "f")`) so millisecond precision survives JSON. Nothing
 *    assumes a number arrives where the server sends a string.
 *
 * 2. **ScheduleEvent has no duration column.** An event is a START. Its length
 *    is always derived server-side (`duration_seconds` / `effective_end_time`).
 *    The UI never writes one (FR-INS-02).
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const MEDIA_TYPES = ['FILE', 'CG', 'SCG'] as const
export type MediaType = (typeof MEDIA_TYPES)[number]

export const MEDIA_LANES = ['FILE', 'CG', 'DOG', 'BUG', 'TICKER'] as const
export type MediaLane = (typeof MEDIA_LANES)[number]

/** Lanes that stay up until an explicit end_time (Spec §1.5.1). */
export const HELD_LANES: ReadonlySet<MediaLane> = new Set(['DOG', 'BUG', 'TICKER'])

export const SCHEDULE_STATUSES = [
  'PENDING',
  'PLAYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number]

/** Statuses the agent never re-processes (Spec §2.9). */
export const TERMINAL_STATUSES: ReadonlySet<ScheduleStatus> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
])

/** Statuses that count as open work. */
export const OPEN_STATUSES: ReadonlySet<ScheduleStatus> = new Set(['PENDING', 'PLAYING'])

export const TEMPLATE_TYPES = ['L_SHAPE', 'POPUP', 'LOWER_THIRD'] as const
export type TemplateType = (typeof TEMPLATE_TYPES)[number]

export const AGENT_STATES = ['online', 'stale', 'offline'] as const
export type AgentState = (typeof AGENT_STATES)[number]

export const DELIVERY_STATES = ['delivered', 'deferred'] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

/** Timeline display order (Spec §8.3). */
export const LANE_ORDER: readonly MediaLane[] = ['FILE', 'CG', 'DOG', 'BUG', 'TICKER']

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: number
  username: string
  email: string
  first_name: string
  last_name: string
  department: number | null
  is_new: boolean
  is_superuser: boolean
}

export interface SessionRole {
  id: number
  name: string
}

export interface SessionPayload {
  user: SessionUser
  roles: SessionRole[]
  permissions: string[]
  is_new: boolean
}

export interface AuthSession {
  id: string
  created_at: string
  expire_date: string
  is_current: boolean
}

export interface LoginInput {
  identifier: string
  password: string
}

export interface ChangePasswordInput {
  new_password: string
  confirm_password: string
}

export interface OtpVerifyInput {
  email: string
  code: string
}

export interface OtpVerifyResult {
  message: string
  tesseract: string
}

export interface PasswordResetInput {
  email: string
  tesseract: string
  new_password: string
  confirm_password: string
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface RoleSummary {
  id: number
  name: string
}

export interface AccountUser {
  id: number
  username: string
  email: string
  first_name: string
  last_name: string
  phone_number: string
  address: string
  profile_picture: string | null
  department: number | null
  department_name: string | null
  roles: RoleSummary[]
  role_ids: number[]
  permissions: string[]
  is_active: boolean
  is_new: boolean
  is_superuser: boolean
  date_joined: string
}

export interface Paginated<T> {
  count: number
  page: number
  page_size: number
  results: T[]
}

export interface Role {
  id: number
  name: string
  description: string
  permissions: number[]
  permission_codenames: string[]
  user_count: number
  is_protected: boolean
  created_at: string
  updated_at: string
}

export interface PermissionRecord {
  id: number
  name: string
  codename: string
  app_label: string
  model: string
}

export interface RolePermissionsMatrix {
  roles: Array<{
    id: number
    name: string
    description: string
    user_count: number
    is_protected: boolean
    permissions: number[]
  }>
  permissions: PermissionRecord[]
}

export interface Department {
  id: number
  name: string
  code: string
  description: string
  head: number | null
  head_username: string | null
  parent_department: number | null
  is_active: boolean
  created_at: string
  updated_at: string
}

// ---------------------------------------------------------------------------
// Playout
// ---------------------------------------------------------------------------

export interface Server {
  id: number
  name: string
  ip_address: string
  amcp_port: number
  is_active: boolean
  engine_heartbeat_at: string | null
  engine_version: string
  agent_state: AgentState
  pipeline_count: number
  created_at: string
  updated_at: string
}

export interface ServerEngineState {
  server: string
  state: AgentState
  heartbeat_at: string | null
  engine_version: string
  pending_deliveries: number
}

export interface Pipeline {
  id: number
  server: number
  server_name: string
  name: string
  primary_channel_number: number
  primary_playout_layer: number
  primary_graphics_layer: number
  secondary_channel_number: number
  secondary_receiver_layer: number
  stream_source_url: string
  output_destination_url: string
  preview_stream_url: string
  preview_embed_url: string
  is_on_air: boolean
  secondary_route_ref: string
  engine_state: AgentState
  created_at: string
  updated_at: string
}

export interface GraphicsTemplate {
  id: number
  name: string
  template_path: string
  template_type: TemplateType
  fps: number
  in_frames: number
  out_frames: number
  hold_seconds: string
  hold_frames: number
  squeeze_x: string
  squeeze_y: string
  squeeze_w: string
  squeeze_h: string
  total_duration_seconds: string
  media_item_count: number
  created_at: string
  updated_at: string
}

export interface MediaItem {
  id: number
  title: string
  media_type: MediaType
  server: number
  server_name: string
  active_status: boolean
  file_path: string
  duration_seconds: string
  duration_frames: number
  fps: string
  start_frame: number
  end_frame: number
  template: number | null
  template_name: string | null
  play_duration_seconds: string
  /** A CG item with no template cannot be scheduled (AC-21). */
  is_incomplete: boolean
  probe_error: string
  last_scanned_at: string | null
  created_at: string
  updated_at: string
}

export interface ScheduleEvent {
  id: number
  pipeline: number
  action_type: string
  media_item: number | null
  media_lane: MediaLane | null
  media_title: string
  media_type: MediaType | ''
  media_file_path: string
  template_name: string | null
  scheduled_time: string
  end_time: string | null
  effective_end_time: string | null
  duration_seconds: string
  status: ScheduleStatus
  /** Ingest stage reported by TaskQue; null until the capture is processed. */
  processing_status?: 'TESTING' | 'INGESTING' | 'DONE' | 'FAILED' | null
  hold_seconds: string | null
  version: number
  note: string
  is_locked: boolean
  is_on_air: boolean
  is_held: boolean
  created_by: number | null
  updated_by: number | null
  created_at: string
  updated_at: string
  /** Present on mutation responses only. */
  agent_delivery?: DeliveryState
}

export interface ScheduleListResponse {
  count: number
  offset: number
  limit: number
  results: ScheduleEvent[]
}

export interface CreateEventInput {
  pipeline: number
  action_type?: string
  media_item?: number | null
  media_lane?: MediaLane | null
  scheduled_time: string
  end_time?: string | null
  hold_seconds?: string | null
  note?: string
}

export interface CreateChainInput {
  pipeline: number
  scheduled_time: string
  items: Array<{ media_item: number; offset_ms?: number }>
}

export interface RetimeChange {
  id: number
  scheduled_time?: string
  end_time?: string | null
  version?: number
}

export interface BulkFailure {
  id: number
  error: string
  code: string
}

export interface BulkDeleteResult {
  deleted: number[]
  failed: BulkFailure[]
}

export interface RetimeResult {
  updated: Array<{ id: number; delivery: DeliveryState }>
  count: number
}

export interface ChainPreviewItem {
  index: number
  event_id: number
  media_item_id: number | null
  title: string
  media_type: MediaType | ''
  file_path: string
  duration_seconds: number
  scheduled_time: string
  end_time: string | null
  status: ScheduleStatus
  is_on_air: boolean
}

export interface ChainPreview {
  pipeline_id: number
  route_ref: string
  start_time: string | null
  end_time: string | null
  total_duration_seconds: number
  item_count: number
  is_on_air: boolean
  items: ChainPreviewItem[]
  synthetic_route: { event_id: number; kind: string; route_ref: string }
}

export interface ScanMediaResult {
  status: string
  server: string
  server_id: number
  count: number
  created: number
  updated: number
  unchanged: number
  deleted: number
  scanned_at: string
}

export interface ReinitResult {
  status: string
  pipeline_id: number
  kind: string
  delivery: DeliveryState
}

export interface BulkOperationResult {
  updated: number[]
  failed: BulkFailure[]
}

export interface BridgeDelivery {
  id: number
  server: string
  pipeline_id: number | null
  event_id: number | null
  command: string
  status: 'PENDING' | 'DELIVERED' | 'FAILED'
  attempts: number
  last_error: string
  created_at: string
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface ReportRow {
  id: number
  pipeline_id: number
  action_type: string
  media_lane: MediaLane | null
  status: ScheduleStatus
  scheduled_time: string
  end_time: string | null
  duration_seconds: number
  duration_display: string
  media_title: string
  media_type: MediaType | ''
  media_file_path: string
  template_name: string
  /** Ingest stage reported by the ingest engine (TESTING/INGESTING/DONE/FAILED). */
  processing_status?: 'TESTING' | 'INGESTING' | 'DONE' | 'FAILED' | '' | null
}

export interface LogReportResponse {
  pipeline_id: number
  pipeline_name: string
  server: string
  start_date: string | null
  end_date: string | null
  total_events: number
  offset: number
  limit: number
  truncated: boolean
  events: ReportRow[]
}

// ---------------------------------------------------------------------------
// Realtime (SSE)
// ---------------------------------------------------------------------------

export type RealtimeEventType =
  | 'snapshot'
  | 'schedule.changed'
  | 'schedule.deleted'
  | 'schedule.status'
  | 'media.scanned'
  | 'media.bulk_status'
  | 'agent.state'
  | 'bridge.delivery'

export interface RealtimeEvent {
  type: RealtimeEventType
  seq: number
  [key: string]: unknown
}

export type RealtimeStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline'