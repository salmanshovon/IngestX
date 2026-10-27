import { Link } from 'react-router-dom'
import { Compass } from 'lucide-react'

import { PRODUCT_NAME } from '@/config'

/** FR-ERR-04: a real 404, not a blank screen. */
export function NotFoundPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-sunken text-subtle">
        <Compass className="h-7 w-7" />
      </span>
      <div>
        <h1 className="text-lg font-semibold text-default">Page not found</h1>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">
          That route does not exist in {PRODUCT_NAME}. It may have been renamed, or the link that
          brought you here may be out of date.
        </p>
      </div>
      <Link
        to="/schedule"
        className="inline-flex h-9 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
      >
        Back to the Scheduler
      </Link>
    </div>
  )
}

/** FR-ERR-04: a real 403, used by the permission guards. */
export function ForbiddenPage({ permission }: { permission?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-danger-soft text-danger">
        <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <rect x="4" y="10" width="16" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      </span>
      <div>
        <h1 className="text-lg font-semibold text-default">Not permitted</h1>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">
          Your account does not hold the permission this view requires
          {permission ? (
            <>
              {' '}
              (<code className="font-mono">{permission}</code>)
            </>
          ) : null}
          . Ask an administrator to grant it.
        </p>
      </div>
      <Link
        to="/schedule"
        className="inline-flex h-9 items-center rounded-lg border border-line px-4 text-sm font-medium text-muted transition-colors hover:bg-hover hover:text-default"
      >
        Back to the Scheduler
      </Link>
    </div>
  )
}