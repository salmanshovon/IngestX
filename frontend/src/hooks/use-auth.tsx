/**
 * Auth + permission context.
 *
 * Auth is a Django session cookie, so the browser's own credential handling is
 * the whole story -- there is no token to store, refresh or leak through
 * localStorage. The provider's job is to hold the resolved identity, expose
 * `can()`, and broadcast session expiry when any request 401s.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { authApi } from '@/api/accounts'
import type { LoginInput, SessionPayload } from '@/api/types'
import { CHANNEL_TIMEZONE } from '@/config'
import { ApiError, isApiError, setUnauthorizedHandler } from '@/lib/api-client'
import { queryKeys } from '@/lib/format'

interface AuthContextValue {
  session: SessionPayload | null
  isLoading: boolean
  isAuthenticated: boolean
  isSuperuser: boolean
  /** Forces the first-login password change gate (FR-SH-03). */
  mustChangePassword: boolean
  login: (input: LoginInput) => Promise<SessionPayload>
  logout: () => Promise<void>
  /** Superuser, or holder of the exact permission codename. */
  can: (permission: string) => boolean
  canAny: (...permissions: string[]) => boolean
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()

  const sessionQuery = useQuery({
    queryKey: queryKeys.session,
    queryFn: ({ signal }) => authApi.me(signal),
    // "Not signed in" comes back as 401 *or* 403 depending on which DRF
    // authenticator ran; with session-only auth Django answers 403. Both are a
    // settled answer, not a fault worth retrying.
    retry: (failureCount, error) => {
      if (isApiError(error) && (error.status === 401 || error.status === 403)) return false
      return failureCount < 2
    },
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  })

  const loginMutation = useMutation({
    mutationFn: (input: LoginInput) => authApi.login(input),
    onSuccess: (payload) => {
      queryClient.setQueryData(queryKeys.session, payload)
      // A fresh sign-in must not show the previous operator's cached rows.
      queryClient.invalidateQueries()
    },
  })

  const logoutMutation = useMutation({
    mutationFn: () => authApi.logout(),
    onSettled: () => {
      queryClient.clear()
      queryClient.setQueryData(queryKeys.session, null)
    },
  })

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.session })
  }, [queryClient])

  // A 401 from any endpoint means the session died. Clearing the query cache is
// the honest response: every route guard then re-evaluates as signed-out.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      queryClient.setQueryData(queryKeys.session, null)
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' })
    })
    return () => setUnauthorizedHandler(null)
  }, [queryClient])

  const session = sessionQuery.data ?? null

  const can = useCallback(
    (permission: string): boolean => {
      if (!session) return false
      if (session.user.is_superuser) return true
      return session.permissions.includes('*') || session.permissions.includes(permission)
    },
    [session],
  )

  const canAny = useCallback(
    (...permissions: string[]): boolean => permissions.some(can),
    [can],
  )

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      isLoading: sessionQuery.isLoading,
      isAuthenticated: Boolean(session),
      isSuperuser: Boolean(session?.user.is_superuser),
      mustChangePassword: Boolean(session?.is_new),
      login: (input) => loginMutation.mutateAsync(input),
      logout: async () => {
        try {
          await logoutMutation.mutateAsync()
        } catch (error) {
          // A logout that fails server-side still ends the local session; the
          // cookie is gone either way once the tab closes.
          if (!isApiError(error) || !(error instanceof ApiError)) throw error
        }
      },
      can,
      canAny,
      refresh,
    }),
    [session, sessionQuery.isLoading, loginMutation, logoutMutation, can, canAny, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>.')
  return context
}

/** The channel timezone, resolved once and shared (FR-T-06). */
export const useChannelTimezone = (): string => CHANNEL_TIMEZONE