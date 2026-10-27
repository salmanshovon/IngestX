import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, type ReactNode } from 'react'

import { cn } from '@/lib/cn'
import { useNotifications, type Toast, type ToastTone } from '@/stores/notification-store'

const TONE_STYLES: Record<ToastTone, { icon: ReactNode; accent: string; label: string }> = {
  success: { icon: <CheckCircle2 className="h-4 w-4 text-ok" />, accent: 'border-l-ok', label: 'Success' },
  error: { icon: <XCircle className="h-4 w-4 text-danger" />, accent: 'border-l-danger', label: 'Error' },
  warning: { icon: <AlertTriangle className="h-4 w-4 text-warn" />, accent: 'border-l-warn', label: 'Warning' },
  info: { icon: <Info className="h-4 w-4 text-info" />, accent: 'border-l-info', label: 'Information' },
}

/**
 * Toast + banner host (FR-SH-07, FR-NF-01, FR-A11-04).
 *
 * Hand-rolled rather than Radix `Toast`: Radix's toast collection depends on
 * a provider/viewport pairing whose lifecycle is easy to get subtly wrong, and
 * a control room cannot afford notifications that silently fail to appear. This
 * is ~60 lines, has no such indirection, and gives us:
 *
 * - `role="status"` + `aria-live="polite"` so results are announced without
 *   stealing focus from what the operator is doing;
 * - a per-toast auto-dismiss timer that pauses on hover/focus, so a message is
 *   not yanked away while it is being read or while its action is being used;
 * - a hard cap on the stack so a burst of failures cannot bury the screen.
 */
export function Toaster() {
  const toasts = useNotifications((state) => state.toasts)
  const dismiss = useNotifications((state) => state.dismiss)

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  )
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const tone = TONE_STYLES[toast.tone]
  const remaining = useRef(toast.duration)
  const startedAt = useRef<number | null>(null)
  const paused = useRef(false)

  const close = useCallback(() => onDismiss(), [onDismiss])

  useEffect(() => {
    if (toast.duration === null) return
    const tick = () => {
      if (startedAt.current === null) startedAt.current = Date.now()
      if (paused.current) return
      const elapsed = Date.now() - startedAt.current
      if (elapsed >= (remaining.current ?? 0)) close()
    }
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [close, toast.duration])

  const hold = () => {
    paused.current = true
  }
  const release = () => {
    paused.current = false
    startedAt.current = Date.now()
  }

  return (
    <div
      role={toast.tone === 'error' ? 'alert' : undefined}
      aria-label={`${tone.label}: ${toast.title}`}
      onMouseEnter={hold}
      onMouseLeave={release}
      onFocus={hold}
      onBlur={release}
      className={cn(
        'animate-slide-up pointer-events-auto relative flex items-start gap-3',
        'rounded-lg border border-line border-l-2 bg-raised p-3 shadow-lg',
        tone.accent,
      )}
    >
      <span className="mt-px shrink-0">{tone.icon}</span>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-default">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted">{toast.description}</p>
        )}
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick()
              close()
            }}
            className="mt-2 text-xs font-semibold text-accent hover:underline"
          >
            {toast.action.label}
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={close}
        aria-label="Dismiss notification"
        className="shrink-0 rounded p-0.5 text-subtle transition-colors hover:bg-hover hover:text-default"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dismissible banners (FR-NAV-08, FR-RT-05)
// ---------------------------------------------------------------------------

/**
 * Dismissible banners (FR-NAV-08, FR-RT-05).
 *
 * Rendered as a normal flow child of the shell (`shrink-0`), not an overlay:
 * it pushes content down when present and disappears entirely when not, so
 * there is never a reserved-but-empty band under the top bar.
 */
export function BannerHost() {
  const banners = useNotifications((state) => state.banners)
  const dismissBanner = useNotifications((state) => state.dismissBanner)

  if (banners.length === 0) return null

  return (
    <div className="z-40 flex shrink-0 flex-col gap-2 border-b border-line bg-surface px-4 py-2">
      {banners.map((item) => {
        const tone = TONE_STYLES[item.tone]
        return (
          <div
            key={item.id}
            role="status"
            className={cn(
              'animate-slide-up pointer-events-auto flex w-full max-w-3xl items-start gap-3',
              'rounded-lg border border-line border-l-2 bg-raised/95 px-4 py-2.5 shadow-md backdrop-blur',
              tone.accent,
            )}
          >
            <span className="mt-px shrink-0">{tone.icon}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-default">{item.title}</p>
              {item.description && (
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{item.description}</p>
              )}
            </div>
            {item.dismissible && (
              <button
                type="button"
                onClick={() => dismissBanner(item.id)}
                aria-label="Dismiss"
                className="shrink-0 rounded p-1 text-subtle transition-colors hover:bg-hover hover:text-default"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}