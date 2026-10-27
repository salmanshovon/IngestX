/** Auth, users, roles and departments. */
import { api } from '@/lib/api-client'
import type {
  AccountUser,
  AuthSession,
  ChangePasswordInput,
  Department,
  LoginInput,
  OtpVerifyInput,
  OtpVerifyResult,
  Paginated,
  PasswordResetInput,
  Role,
  RolePermissionsMatrix,
  SessionPayload,
} from './types'

export const authApi = {
  login: (input: LoginInput) =>
    api.post<SessionPayload>('/auth/login', input),

  logout: () => api.post<void>('/auth/logout'),

  me: (signal?: AbortSignal) => api.get<SessionPayload>('/auth/me', undefined, signal),

  changePassword: (input: ChangePasswordInput) =>
    api.post<SessionPayload>('/auth/change-password', input),

  sessions: () => api.get<AuthSession[]>('/auth/sessions'),

  revokeSession: (id: string) => api.delete<void>(`/auth/sessions/${encodeURIComponent(id)}`),

  /**
   * Always 202 whether or not the address matches an account. The client must
   * not branch on the response (AC-09).
   */
  sendOtp: (email: string) => api.post<{ message: string }>('/auth/otp/send', { email }),

  verifyOtp: (input: OtpVerifyInput) => api.post<OtpVerifyResult>('/auth/otp/verify', input),

  resetPassword: (input: PasswordResetInput) =>
    api.post<{ message: string }>('/auth/password/reset', input),
}

export interface UserListParams {
  search?: string
  page?: number
  page_size?: number
}

export interface CreateUserInput {
  username: string
  email: string
  first_name?: string
  last_name?: string
  phone_number?: string
  address?: string
  department_id?: number | null
  roles?: number[]
}

export const usersApi = {
  list: (params: UserListParams = {}) =>
    api.get<Paginated<AccountUser>>('/users', {
      search: params.search,
      page: params.page,
      page_size: params.page_size,
    }),

  create: (input: CreateUserInput) =>
    api.post<{ message: string; username: string; email: string }>('/users', input),

  detail: (id: number) => api.get<{ user: AccountUser; roles: Array<{ id: number; name: string }> }>(`/users/${id}`),

  update: (id: number, input: Partial<CreateUserInput>) =>
    api.patch<AccountUser>(`/users/${id}`, input),

  remove: (id: number) => api.delete<void>(`/users/${id}`),

  usernameAvailable: (username: string) =>
    api.get<{ is_available: boolean; error: string | null }>('/users/username-available', {
      username,
    }),

  activate: (id: number) => api.post<AccountUser>(`/users/${id}/activate`),

  deactivate: (id: number) => api.post<AccountUser>(`/users/${id}/deactivate`),
}

export const rolesApi = {
  list: () => api.get<Role[]>('/roles'),

  create: (input: { name: string; description?: string; permissions?: number[] }) =>
    api.post<Role>('/roles', input),

  detail: (id: number) => api.get<Role>(`/roles/${id}`),

  update: (id: number, input: { name?: string; description?: string; permissions?: number[] }) =>
    api.patch<Role>(`/roles/${id}`, input),

  remove: (id: number, params: { force?: boolean; reassign_to?: number } = {}) =>
    api.delete<void>(`/roles/${id}`, undefined, {
      force: params.force || undefined,
      reassign_to: params.reassign_to,
    }),

  matrix: () => api.get<RolePermissionsMatrix>('/roles/permissions'),
}

export const departmentsApi = {
  list: () => api.get<Department[]>('/departments'),

  create: (input: Partial<Department>) => api.post<Department>('/departments', input),

  update: (id: number, input: Partial<Department>) => api.patch<Department>(`/departments/${id}`, input),

  remove: (id: number) => api.delete<void>(`/departments/${id}`),
}