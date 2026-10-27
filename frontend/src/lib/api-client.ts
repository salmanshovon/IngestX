/**
 * Typed API client for the IngestX browser API.
 *
 * Responsibilities, in order of importance:
 *
 * 1. **Carry the session cookie on every call.** Auth is a Django session
 *    cookie (`IngestX_session`), not a bearer token. `credentials: 'include'` is
 *    not optional.
 * 2. **Carry the CSRF token on every unsafe call.** Django's
 *    `CsrfViewMiddleware` + DRF's `SessionAuthentication` reject POST/PATCH/
 *    DELETE with 403 unless `X-CSRFToken` matches the `csrftoken` cookie. There
 *    is no `{% csrf_token %}` in a SPA, so we read the cookie directly.
 * 3. **Turn every failure into a typed `ApiError`** carrying the server's
 *    stable `code`, so callers branch on a machine value and never on prose.
 */

import { API_PREFIX } from '@/config'

/**
 * Server error codes (SRS Appendix B). Declared as a union plus a `string`
 * fallback: an unrecognised code must still surface cleanly rather than
 * crashing a `switch`.
 */
export const ERROR_CODES = [
  'PASSWORD_CHANGE_REQUIRED',
  'OVERLAP',
  'IN_PAST',
  'LOCKED',
  'ON_AIR',
  'DELETE_BLOCKED',
  'STOP_TOO_SOON',
  'MEDIA_INACTIVE',
  'TEMPLATE_MISSING',
  'LANE_TYPE_MISMATCH',
  'END_TIME_REQUIRED',
  'END_BEFORE_START',
  'VERSION_MISMATCH',
  'AGENT_UNREACHABLE',
  'AGENT_PROTOCOL_ERROR',
  'IDEMPOTENCY_CONFLICT',
  'RATE_LIMITED',
  'ACCOUNT_INACTIVE',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID',
  'METHOD_NOT_ALLOWED',
  'UNSUPPORTED_MEDIA_TYPE',
  'SERVICE_UNAVAILABLE',
  'SERVER_ERROR',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number] | (string & {})

/** Shape every error response from this API takes (apps/playout/exceptions.py). */
interface ErrorBody {
  detail?: string
  code?: string
  /** DRF field errors, present on 400 validation failures. */
  errors?: unknown
  [key: string]: unknown
}

export class ApiError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly body: ErrorBody
  /** True when retrying the identical request could plausibly succeed. */
  readonly retryable: boolean

  constructor(status: number, body: ErrorBody) {
    super(body.detail || `Request failed (${status})`)
    this.name = 'ApiError'
    this.status = status
    this.code = body.code || statusForCode(status)
    this.body = body
    this.retryable = status === 0 || status === 429 || status >= 500
  }

  /** DRF field errors flattened to `field: message` for inline form errors. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {}
    const raw = this.body.errors

    const push = (field: string, message: string) => {
      if (!out[field]) out[field] = message
    }

    if (Array.isArray(raw)) {
      raw.forEach((entry) => {
        if (typeof entry === 'string') push('__all__', entry)
      })
      return out
    }
    if (raw && typeof raw === 'object') {
      for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          const first = value.find((v) => typeof v === 'string')
          push(field, first ?? 'Invalid value.')
        } else if (typeof value === 'string') {
          push(field, value)
        }
      }
    }
    return out
  }
}

function statusForCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'INVALID'
    case 401:
      return 'UNAUTHENTICATED'
    case 403:
      return 'PERMISSION_DENIED'
    case 404:
      return 'NOT_FOUND'
    case 405:
      return 'METHOD_NOT_ALLOWED'
    case 409:
      return 'CONFLICT'
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE'
    case 429:
      return 'RATE_LIMITED'
    case 500:
      return 'SERVER_ERROR'
    case 503:
      return 'SERVICE_UNAVAILABLE'
    default:
      return 'ERROR'
  }
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const target = `${name}=`
  for (const part of document.cookie.split(';')) {
    const entry = part.trimStart()
    if (entry.startsWith(target)) return decodeURIComponent(entry.slice(target.length))
  }
  return null
}

export function hasCsrfCookie(): boolean {
  return readCookie('csrftoken') !== null
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

interface RequestOptions {
  method?: string
  body?: unknown
  query?: Record<string, string | number | boolean | undefined | null>
  signal?: AbortSignal
  /** Skip the 401 -> session-expiry broadcast (used by the login call itself). */
  skipAuthBroadcast?: boolean
}

/** Handlers registered by the auth provider; fired on an unauthenticated 401. */
type UnauthorizedHandler = () => void
let onUnauthorized: UnauthorizedHandler | null = null
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler
}

export function buildQuery(query?: RequestOptions['query']): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const serialised = params.toString()
  return serialised ? `?${serialised}` : ''
}

/**
 * Prime the CSRF cookie.
 *
 * Django only writes `csrftoken` on a response that needed it. On a cold load
 * with no session the SPA may hold no cookie at all, and the first mutation
 * would then fail with "CSRF cookie not set". A cheap authenticated GET forces
 * the middleware to emit it.
 */
export async function primeCsrfCookie(): Promise<void> {
  if (hasCsrfCookie()) return
  try {
    await request<unknown>('/auth/me', { skipAuthBroadcast: true })
  } catch {
    // 401/403 here is expected and irrelevant -- the cookie is still set.
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = { Accept: 'application/json' }

  if (!SAFE_METHODS.has(method)) {
    headers['X-CSRFToken'] = readCookie('csrftoken') ?? ''
  }

  let payload: string | undefined
  if (options.body instanceof FormData) {
    payload = undefined // let the browser set the multipart boundary
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(options.body)
  }

  // Django's URL patterns all end in a trailing slash. Normalise here so
  // callers can pass either form and never trigger an APPEND_SLASH redirect
  // (which breaks POST/PUT/PATCH bodies).
  const normalisedPath = path.endsWith('/') ? path : `${path}/`
  let response: Response
  try {
    response = await fetch(`${API_PREFIX}${normalisedPath}${buildQuery(options.query)}`, {
      method,
      headers,
      body: payload,
      credentials: 'include',
      signal: options.signal,
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    // status 0 is our marker for "never reached the server".
    throw new ApiError(0, {
      detail: 'Cannot reach the IngestX API. Check your connection.',
      code: 'SERVICE_UNAVAILABLE',
    })
  }

  if (response.status === 204) return undefined as T

  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.includes('application/json')
  const body: unknown = isJson ? await response.json().catch(() => null) : await response.text()

  if (!response.ok) {
    const errorBody: ErrorBody =
      isJson && body && typeof body === 'object'
        ? (body as ErrorBody)
        : { detail: typeof body === 'string' && body ? body.slice(0, 400) : undefined }

    if (response.status === 401 && !options.skipAuthBroadcast) onUnauthorized?.()
    throw new ApiError(response.status, errorBody)
  }

  return body as T
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    request<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown, query?: RequestOptions['query']) =>
    request<T>(path, { method: 'POST', body, query }),
  patch: <T>(path: string, body?: unknown, query?: RequestOptions['query']) =>
    request<T>(path, { method: 'PATCH', body, query }),
  put: <T>(path: string, body?: unknown, query?: RequestOptions['query']) =>
    request<T>(path, { method: 'PUT', body, query }),
  delete: <T>(path: string, body?: unknown, query?: RequestOptions['query']) =>
    request<T>(path, { method: 'DELETE', body, query }),
}

/** Narrowing helper for `catch` blocks that only care about API failures. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

/** The set of engine/domain codes worth showing verbatim to an operator. */
export const DOMAIN_CODES: ReadonlySet<string> = new Set([
  'OVERLAP',
  'IN_PAST',
  'LOCKED',
  'ON_AIR',
  'DELETE_BLOCKED',
  'STOP_TOO_SOON',
  'MEDIA_INACTIVE',
  'TEMPLATE_MISSING',
  'LANE_TYPE_MISMATCH',
  'END_TIME_REQUIRED',
  'END_BEFORE_START',
  'VERSION_MISMATCH',
  'AGENT_UNREACHABLE',
  'AGENT_PROTOCOL_ERROR',
  'RATE_LIMITED',
  'ACCOUNT_INACTIVE',
  'TEMPLATE_IN_USE',
  'ROLE_IN_USE',
  'PROTECTED_ROLE',
  'REASSIGNMENT_REQUIRED',
])
