import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react'

import { cn } from '@/lib/cn'

const CONTROL =
  'w-full rounded-md border border-line bg-inset px-2.5 text-sm text-default ' +
  'placeholder:text-subtle transition-colors ' +
  'hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: ReactNode
  error?: string
  leading?: ReactNode
  trailing?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, label, hint, error, leading, trailing, id, ...props },
  ref,
) {
  const generated = useId()
  const inputId = id ?? generated
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-xs font-medium text-muted">
          {label}
        </label>
      )}
      <div className="relative">
        {leading && (
          <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-subtle">
            {leading}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            CONTROL,
            'h-9',
            leading && 'pl-8',
            trailing && 'pr-8',
            error && 'border-danger focus:border-danger focus:ring-[color-mix(in_srgb,var(--danger)_40%,transparent)]',
            className,
          )}
          {...props}
        />
        {trailing && (
          <span className="absolute inset-y-0 right-2 flex items-center text-subtle">{trailing}</span>
        )}
      </div>
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="mt-1 text-xs text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  )
})

// ---------------------------------------------------------------------------

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  hint?: ReactNode
  error?: string
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, label, hint, error, id, ...props },
  ref,
) {
  const generated = useId()
  const fieldId = id ?? generated

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={fieldId} className="mb-1.5 block text-xs font-medium text-muted">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={fieldId}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL, 'min-h-20 py-2 font-mono text-xs leading-relaxed', error && 'border-danger', className)}
        {...props}
      />
      {error ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-subtle">{hint}</p>
      ) : null}
    </div>
  )
})