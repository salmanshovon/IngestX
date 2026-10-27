import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertOctagon, RotateCcw } from 'lucide-react'

import { PRODUCT_NAME } from '@/config'
import { cn } from '@/lib/cn'

interface Props {
  children: ReactNode
  /** Shell / tab / widget level (FR-ERR-03). */
  level?: 'shell' | 'tab' | 'widget'
  label?: string
  onReset?: () => void
}

interface State {
  error: Error | null
  componentStack: string | null
}

/**
 * Error boundary at three levels (FR-ERR-03).
 *
 * A crash in the timeline must not blank the whole console, and a crash in one
 * card on the System tab must not blank the tab. `level` decides how much UI is
 * sacrificed.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // FR-ERR-05: a Sentry-compatible hook. Nothing is shipped in this build,
    // but the call site exists so wiring a reporter is a one-line change.
    console.error(`[${PRODUCT_NAME}] unhandled error`, error, info)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).__PLYOUT_LAST_ERROR__ = { error, info }
  }

  private readonly reset = () => {
    this.setState({ error: null, componentStack: null })
    this.props.onReset?.()
  }

  override render(): ReactNode {
    const { error, componentStack } = this.state
    if (!error) return this.props.children

    if (this.props.level === 'widget') {
      return (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-line bg-surface p-3">
          <p className="text-xs font-medium text-danger">
            {this.props.label ?? 'This panel'} failed to render
          </p>
          <p className="text-2xs text-muted">{error.message}</p>
          <button
            type="button"
            onClick={this.reset}
            className="inline-flex items-center gap-1 text-2xs font-medium text-accent hover:underline"
          >
            <RotateCcw className="h-3 w-3" /> Retry
          </button>
        </div>
      )
    }

    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-canvas px-6">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-danger-soft text-danger">
          <AlertOctagon className="h-6 w-6" />
        </span>
        <div className="max-w-md text-center">
          <h1 className="text-base font-semibold text-default">
            {this.props.label ?? `${PRODUCT_NAME} hit an unexpected error`}
          </h1>
          <p className="mt-2 text-xs leading-relaxed text-muted">{error.message}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={this.reset}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg',
              'transition-colors hover:bg-accent-hover',
            )}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reload view
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex h-9 items-center rounded-lg border border-line px-4 text-sm font-medium text-muted transition-colors hover:bg-hover hover:text-default"
          >
            Reload app
          </button>
        </div>
        {componentStack && (
          <details className="mt-2 max-w-2xl text-2xs text-subtle">
            <summary className="cursor-pointer select-none">Technical detail</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-sunken p-3 text-[10px] leading-relaxed">
              {error.stack}
            </pre>
          </details>
        )}
      </div>
    )
  }
}