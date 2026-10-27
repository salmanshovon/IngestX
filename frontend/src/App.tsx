import { lazy, Suspense, useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { PRODUCT_NAME } from '@/config'
import { useAuth } from '@/hooks/use-auth'
import { primeCsrfCookie } from '@/lib/api-client'
import { useUiStore } from '@/stores/ui-store'
import { AppShell } from '@/components/layout/app-shell'
import { ErrorBoundary } from '@/components/layout/error-boundary'
import { Spinner } from '@/components/ui/primitives'
import { LoginPage } from '@/pages/login-page'
import { ChangePasswordPage } from '@/pages/change-password-page'
import { ForgotPasswordPage } from '@/pages/forgot-password-page'
import { SchedulePage } from '@/pages/schedule-page'
import { ExecLogPage } from '@/pages/exec-log-page'
import { SettingsPage } from '@/pages/settings-page'
import { SystemPage } from '@/pages/system-page'
import { NotFoundPage } from '@/pages/not-found-page'

/**
 * Route table (FR-SH-01).
 *
 * The four operator tabs are eagerly imported -- they are the product and a
 * control room should never show a loading spinner for the main view. The
 * configuration tabs are code-split; an operator who only ever runs the
 * Scheduler should not download the role matrix.
 */
const AdminPipelinesPage = lazy(() =>
  import('@/pages/admin-pipelines-page').then((m) => ({ default: m.AdminPipelinesPage })),
)
const AdminUsersPage = lazy(() =>
  import('@/pages/admin-users-page').then((m) => ({ default: m.AdminUsersPage })),
)
const AdminRolesPage = lazy(() =>
  import('@/pages/admin-roles-page').then((m) => ({ default: m.AdminRolesPage })),
)

function FullPageSpinner({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-canvas">
      <Spinner label={label} />
    </div>
  )
}

/**
 * Route guard (FR-SH-03).
 *
 * Three gates, in order: not signed in -> `/login`; `is_new` -> the forced
 * password change, with everything else blocked; otherwise the requested route.
 *
 * The `is_new` gate is a convenience only. The server rejects every business
 * endpoint for such an account with 403 `PASSWORD_CHANGE_REQUIRED`, so a user
 * who bypasses this still gets nothing useful.
 */
function RequireAuth({ children, allowPasswordChange = false }: { children: React.ReactNode; allowPasswordChange?: boolean }) {
  const { isLoading, isAuthenticated, mustChangePassword } = useAuth()
  const location = useLocation()

  if (isLoading) return <FullPageSpinner label={`Loading ${PRODUCT_NAME}…`} />

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  if (mustChangePassword && !allowPasswordChange) {
    return <Navigate to="/change-password" replace />
  }

  return <>{children}</>
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated, mustChangePassword } = useAuth()
  if (isLoading) return <FullPageSpinner label={`Loading ${PRODUCT_NAME}…`} />
  if (isAuthenticated) return <Navigate to={mustChangePassword ? '/change-password' : '/schedule'} replace />
  return <>{children}</>
}

/**
 * Reads `is_new` for the page. Kept as its own component so the hook call is
 * not smuggled into the element tree, where it would run conditionally.
 */
function ChangePasswordRoute() {
  const { mustChangePassword } = useAuth()
  return <ChangePasswordPage forced={mustChangePassword} />
}

export function AppRoutes() {
  const theme = useUiStore((state) => state.theme)

  // FR-SH-10 / FR-DS-02: reflect the stored preference on <html>, where the
  // pre-paint script and the CSS variable swap both look for it.
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    root.dataset.theme = theme
  }, [theme])

  // FR-SH-09: make sure a CSRF cookie exists before the first mutation,
  // including on a cold load straight into a protected route.
  useEffect(() => {
    void primeCsrfCookie()
  }, [])

  // Keep the document title in step with the route (FR-SH-11: PlyOut only).
  const location = useLocation()
  useEffect(() => {
    const TITLES: Record<string, string> = {
      '/schedule': 'Scheduler',
      '/execlog': 'Execution Log',
      '/system': 'System',
      '/admin/users': 'Users',
      '/admin/roles': 'Roles',
      '/admin/pipelines': 'Pipelines',
    }
    const title = TITLES[location.pathname]
    document.title = title ? `${title} · ${PRODUCT_NAME}` : PRODUCT_NAME
  }, [location.pathname])

  return (
    <ErrorBoundary level="shell">
      <Routes>
        <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
        <Route path="/forgot-password" element={<PublicOnly><ForgotPasswordPage /></PublicOnly>} />

        <Route
          path="/change-password"
          element={
            <RequireAuth allowPasswordChange>
              <ChangePasswordRoute />
            </RequireAuth>
          }
        />

        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/schedule" replace />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/execlog" element={<ExecLogPage />} />
          <Route path="/settings" element={<SettingsPage />} />

          <Route path="/system" element={<SystemPage />} />
          <Route
            path="/admin"
            element={
              <Suspense fallback={<FullPageSpinner label="Loading…" />}>
                <Navigate to="/admin/pipelines" replace />
              </Suspense>
            }
          />
          <Route
            path="/admin/pipelines"
            element={
              <Suspense fallback={<FullPageSpinner label="Loading pipelines…" />}>
                <AdminPipelinesPage />
              </Suspense>
            }
          />
          <Route
            path="/admin/users"
            element={
              <Suspense fallback={<FullPageSpinner label="Loading users…" />}>
                <AdminUsersPage />
              </Suspense>
            }
          />
          <Route
            path="/admin/roles"
            element={
              <Suspense fallback={<FullPageSpinner label="Loading roles…" />}>
                <AdminRolesPage />
              </Suspense>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  )
}
