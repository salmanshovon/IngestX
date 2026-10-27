import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, Check, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router-dom'
import { z } from 'zod'

import { authApi } from '@/api/accounts'
import { PRODUCT_NAME } from '@/config'
import { useAuth } from '@/hooks/use-auth'
import { ApiError, isApiError, primeCsrfCookie } from '@/lib/api-client'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { AuthLayout } from './login-page'

/**
 * Client mirror of the server password policy
 * (`AUTH_PASSWORD_VALIDATORS` in core/settings.py).
 *
 * This is a convenience, not a control: the server runs `validate_password` and
 * returns the authoritative list of failures. Showing them inline avoids a
 * pointless round-trip; it never replaces the check.
 */
const PASSWORD_RULES = [
  { id: 'length', label: 'At least 12 characters', test: (v: string) => v.length >= 12 },
  { id: 'upper', label: 'An uppercase letter', test: (v: string) => /[A-Z]/.test(v) },
  { id: 'lower', label: 'A lowercase letter', test: (v: string) => /[a-z]/.test(v) },
  { id: 'digit', label: 'A number', test: (v: string) => /\d/.test(v) },
  { id: 'symbol', label: 'A symbol', test: (v: string) => /[^A-Za-z0-9]/.test(v) },
  {
    id: 'notcommon',
    label: 'Not a commonly used password',
    test: (v: string) => !['password', 'password123', '12345678', 'qwerty', 'letmein'].includes(v.toLowerCase()),
  },
]

const schema = z
  .object({
    new_password: z.string().min(1, 'Choose a password.'),
    confirm_password: z.string().min(1, 'Repeat the password.'),
  })
  .refine((values) => values.new_password === values.confirm_password, {
    message: 'Passwords do not match.',
    path: ['confirm_password'],
  })

type FormValues = z.infer<typeof schema>

/** WF-02 / FR-SH-03: the forced first-login change and the voluntary one. */
export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const { session, refresh } = useAuth()
  const navigate = useNavigate()
  const [formError, setFormError] = useState<string | null>(null)
  const [policyErrors, setPolicyErrors] = useState<string[]>([])
  const [done, setDone] = useState(false)

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { new_password: '', confirm_password: '' },
  })

  const password = watch('new_password') ?? ''

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    setPolicyErrors([])
    try {
      // A fresh session may not have primed the CSRF cookie yet (for example a
      // deep link straight into /change-password on a cold load).
      await primeCsrfCookie()
      await authApi.changePassword(values)
      setDone(true)
      await refresh()
      window.setTimeout(() => navigate('/schedule', { replace: true }), 900)
    } catch (error) {
      if (isApiError(error)) {
        const apiError = error as ApiError
        if (apiError.code === 'WEAK_PASSWORD') {
          const errorsField = apiError.body.errors
          if (Array.isArray(errorsField)) setPolicyErrors(errorsField.filter((e): e is string => typeof e === 'string'))
          setFormError('That password does not meet the policy.')
        } else if (apiError.code === 'PASSWORD_MISMATCH') {
          setFormError('Passwords do not match.')
        } else {
          setFormError(apiError.message)
        }
      } else if (error instanceof TypeError) {
        setFormError('Could not reach the IngestX server.')
      } else {
        setFormError('Something went wrong.')
      }
    }
  })

  return (
    <AuthLayout
      title={forced ? 'Choose a new password' : 'Change password'}
      subtitle={forced ? 'Your account requires a password change before you continue' : undefined}
    >
      {done ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ok-soft text-ok">
            <Check className="h-6 w-6" />
          </span>
          <p className="text-sm font-medium text-default">Password updated</p>
          <p className="text-xs text-muted">
            Every other session has been signed out. Redirecting to the console…
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {forced && (
            <div className="flex items-start gap-2.5 rounded-lg border border-line border-l-2 border-l-warn bg-warn-soft px-3 py-2.5">
              <ShieldCheck className="mt-px h-4 w-4 shrink-0 text-warn" />
              <p className="text-xs leading-relaxed text-default">
                You are signed in as <strong>{session?.user.username}</strong> using a temporary
                password. Set a personal one to continue.
              </p>
            </div>
          )}

          {formError && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-lg border border-line border-l-2 border-l-danger bg-danger-soft px-3 py-2.5"
            >
              <AlertCircle className="mt-px h-4 w-4 shrink-0 text-danger" />
              <div className="min-w-0">
                <p className="text-xs leading-relaxed text-default">{formError}</p>
                {policyErrors.length > 0 && (
                  <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-2xs text-muted">
                    {policyErrors.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          <div>
            <label htmlFor="new_password" className="mb-1.5 block text-xs font-medium text-muted">
              New password
            </label>
            <input
              id="new_password"
              type="password"
              autoComplete="new-password"
              autoFocus
              {...register('new_password')}
              className={cn(
                'h-10 w-full rounded-md border bg-inset px-3 text-sm text-default',
                'focus:outline-none focus:ring-2',
                errors.new_password
                  ? 'border-danger focus:border-danger'
                  : 'border-line focus:border-accent focus:ring-[var(--accent-ring)]',
              )}
            />
          </div>

          <ul className="space-y-1">
            {PASSWORD_RULES.map((rule) => {
              const passed = rule.test(password)
              return (
                <li
                  key={rule.id}
                  className={cn(
                    'flex items-center gap-1.5 text-2xs transition-colors',
                    passed ? 'text-ok' : 'text-subtle',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-3.5 w-3.5 items-center justify-center rounded-full border text-[8px]',
                      passed ? 'border-ok bg-ok-soft' : 'border-line',
                    )}
                    aria-hidden
                  >
                    {passed && <Check className="h-2 w-2" strokeWidth={4} />}
                  </span>
                  {rule.label}
                </li>
              )
            })}
          </ul>

          <div>
            <label htmlFor="confirm_password" className="mb-1.5 block text-xs font-medium text-muted">
              Confirm password
            </label>
            <input
              id="confirm_password"
              type="password"
              autoComplete="new-password"
              {...register('confirm_password')}
              className={cn(
                'h-10 w-full rounded-md border bg-inset px-3 text-sm text-default',
                'focus:outline-none focus:ring-2',
                errors.confirm_password
                  ? 'border-danger focus:border-danger'
                  : 'border-line focus:border-accent focus:ring-[var(--accent-ring)]',
              )}
            />
            {errors.confirm_password && (
              <p role="alert" className="mt-1 text-xs text-danger">
                {errors.confirm_password.message}
              </p>
            )}
          </div>

          <Button type="submit" variant="primary" className="h-10 w-full" loading={isSubmitting}>
            {isSubmitting ? 'Updating…' : 'Update password'}
          </Button>

          {!forced && (
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="w-full text-center text-xs text-muted hover:text-default"
            >
              Cancel
            </button>
          )}
        </form>
      )}

      {!forced && (
        <p className="mt-4 text-center text-2xs text-subtle">
          Changing your password signs out every other session for {PRODUCT_NAME}.
        </p>
      )}
    </AuthLayout>
  )
}
