import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

interface ModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Hides the X and blocks the outside-click dismissal for critical prompts. */
  dismissible?: boolean
}

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-5xl',
}

/**
 * Modal dialog with a focus trap and focus restoration (FR-A11-02) -- Radix
 * handles both. Every destructive confirmation in the app goes through here
 * instead of `window.confirm` (FR-NF-04).
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: ModalProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-in-fade"
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
            'flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-lg',
            'data-[state=open]:animate-slide-up',
            SIZES[size],
          )}
          onEscapeKeyDown={(event) => {
            if (!dismissible) event.preventDefault()
          }}
          onPointerDownOutside={(event) => {
            if (!dismissible) event.preventDefault()
          }}
        >
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-sm font-semibold text-default">
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-0.5 text-xs text-muted">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            {dismissible && (
              <DialogPrimitive.Close
                className="rounded p-1 text-subtle transition-colors hover:bg-hover hover:text-default"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </DialogPrimitive.Close>
            )}
          </header>

          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>

          {footer && (
            <footer className="flex items-center justify-end gap-2 border-t border-line bg-inset px-5 py-3">
              {footer}
            </footer>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
  loading?: boolean
  onConfirm: () => void
  children?: ReactNode
}

/** FR-SH-08. Nothing destructive happens without one of these. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  loading,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-8 rounded-md border border-line px-3 text-xs font-medium text-muted transition-colors hover:bg-hover hover:text-default"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              'h-8 rounded-md px-3 text-xs font-semibold text-white transition-[filter,transform] active:translate-y-px disabled:opacity-50',
              tone === 'danger' ? 'bg-danger' : 'bg-accent text-accent-fg',
            )}
          >
            {loading ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-muted">{description}</p>
      {children && <div className="mt-3">{children}</div>}
    </Modal>
  )
}