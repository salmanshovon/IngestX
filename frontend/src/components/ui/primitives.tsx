import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'
import type { AgentState, ScheduleStatus } from '@/api/types'
import { STATUS_LABEL, STATUS_TONE } from '@/lib/format'

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'muted'

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-sunken text-muted border-line',
  accent: 'bg-accent-soft text-accent border-transparent',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  info: 'bg-info-soft text-info border-transparent',
  muted: 'bg-transparent text-subtle border-line',
}

export function Badge({
  tone = 'neutral',
  className,
  children,
  icon,
}: {
  tone?: BadgeTone
  className?: string
  children: ReactNode
  icon?: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  )
}

/** Status is conveyed by text as well as colour (FR-A11-03). */
export function StatusBadge({ status, className }: { status: ScheduleStatus; className?: string }) {
  return (
    <Badge tone={STATUS_TONE[status]} className={className}>
      {STATUS_LABEL[status]}
    </Badge>
  )
}

// ---------------------------------------------------------------------------
// Agent state dot
// ---------------------------------------------------------------------------

const AGENT_TONE: Record<AgentState, BadgeTone> = {
  online: 'ok',
  stale: 'warn',
  offline: 'danger',
}

export function AgentDot({ state, className }: { state: AgentState; className?: string }) {
  return (
    <span
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', BADGE_DOT[AGENT_TONE[state]], className)}
      aria-hidden
    />
  )
}

const BADGE_DOT: Record<BadgeTone, string> = {
  neutral: 'bg-subtle',
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  muted: 'bg-subtle',
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-muted" role="status">
      <Loader2 className={cn('h-4 w-4 animate-spin', className)} aria-hidden />
      {label && <span className="text-xs">{label}</span>}
      <span className="sr-only">{label ?? 'Loading'}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Empty / error states
// ---------------------------------------------------------------------------

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-14 text-center', className)}>
      {icon && (
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-sunken text-subtle">
          {icon}
        </span>
      )}
      <div>
        <p className="text-sm font-medium text-default">{title}</p>
        {description && <p className="mt-1 max-w-md text-xs text-muted">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
  className,
}: {
  title?: string
  description?: string
  onRetry?: () => void
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-danger-soft text-danger">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        </svg>
      </span>
      <div>
        <p className="text-sm font-medium text-default">{title}</p>
        {description && <p className="mt-1 max-w-md text-xs text-muted">{description}</p>}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="h-8 rounded-md border border-line px-3 text-xs font-medium text-muted transition-colors hover:bg-hover hover:text-default"
        >
          Try again
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section scaffolding
// ---------------------------------------------------------------------------

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn('rounded-xl border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-default">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(bodyClassName)}>{children}</div>
    </section>
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    // Single row: title and description share a baseline, so the description
    // costs horizontal space instead of a second line of vertical space.
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-1.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className="shrink-0 text-sm font-semibold tracking-tight text-default">{title}</h1>
        {description && <p className="truncate text-2xs text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}