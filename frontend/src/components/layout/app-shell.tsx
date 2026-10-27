import { useEffect, type ReactNode } from 'react'
import { Outlet, useLocation } from 'react-router-dom'

import { PRODUCT_NAME } from '@/config'
import { cn } from '@/lib/cn'
import { useUiStore } from '@/stores/ui-store'
import { BannerHost } from '@/components/ui/toaster'
import { ErrorBoundary } from './error-boundary'
import { TopBar } from './top-bar'

/**
 * Authenticated layout (FR-SH-02): persistent top bar + scrolling content area.
 *
 * Banners are a `shrink-0` sibling of `<main>`, not an overlay with reserved
 * padding. An absolute overlay needs permanent top padding on the content,
 * which shows up as a dead band under the top bar whenever no banner is
 * showing -- exactly the gap a user notices first.
 */
export function AppShell() {
  const location = useLocation()
  const setNowMode = useUiStore((state) => state.setNowMode)

  // A freshly loaded page (or a reload) must open pinned, not following: the
  // following mode re-centres the viewport every second and refuses every edit,
  // so landing in it on load left the operator with a timeline they could read
  // but not touch. Follow is opt-in via the toolbar toggle.
  useEffect(() => {
    if (location.pathname === '/schedule') setNowMode('marker')
  }, [location.pathname, setNowMode])

  return (
    <div className="flex h-full flex-col bg-canvas">
      <TopBar />
      <ErrorBoundary level="shell" label={`${PRODUCT_NAME} console`}>
        <BannerHost />
        <main className="min-h-0 flex-1 overflow-auto">
          <ErrorBoundary level="tab">
            <Outlet />
          </ErrorBoundary>
        </main>
      </ErrorBoundary>
    </div>
  )
}

/** Page container: consistent gutters and a max width for dense data views. */
export function PageShell({
  children,
  className,
  wide,
}: {
  children: ReactNode
  className?: string
  wide?: boolean
}) {
  return (
    <div className={cn('flex min-h-full flex-col', wide ? 'w-full' : 'mx-auto w-full max-w-[1600px]', className)}>
      {children}
    </div>
  )
}