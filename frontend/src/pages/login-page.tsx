import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, ArrowRight, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { z } from 'zod'

import { CHANNEL_TIMEZONE, PRODUCT_NAME, PRODUCT_TAGLINE } from '@/config'
import { useAuth } from '@/hooks/use-auth'
import { ApiError, isApiError } from '@/lib/api-client'
import { cn } from '@/lib/cn'
import { PlyoutLogo } from '@/components/layout/logo'

const schema = z.object({
  identifier: z.string().trim().min(1, 'Enter your username.'),
  password: z.string().min(1, 'Enter your password.'),
})

type FormValues = z.infer<typeof schema>

/**
 * Sign in (WF-01).
 *
 * **Username, not email.** The field is labelled "Username" and the backend's
 * `resolve_identifier` happens to also accept an email, but the product
 * decision is that operators authenticate by username; the UI says so and
 * validates as such.
 */
export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [showPassword, setShowPassword] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const from = (location.state as { from?: string } | null)?.from ?? '/schedule'

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { identifier: '', password: '' },
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      const session = await login(values)
      // FR-SH-03: `is_new` forces the password change gate, server-side too.
      navigate(session.is_new ? '/change-password' : from, { replace: true })
    } catch (error) {
      if (isApiError(error)) {
        const apiError = error as ApiError
        if (apiError.status === 401) {
          // AC-02: the server returns the same message for an unknown user and
          // a wrong password. We must not try to be cleverer than that here.
          setFormError('Incorrect username or password.')
        } else if (apiError.code === 'ACCOUNT_INACTIVE') {
          setFormError('This account has been deactivated. Contact an administrator.')
        } else if (apiError.code === 'RATE_LIMITED') {
          setFormError('Too many attempts. Wait a few minutes and try again.')
        } else if (apiError.status === 403) {
          setFormError('Sign-in is blocked. Check your browser cookies allow this site.')
        } else {
          setFormError(apiError.message)
        }
        if (apiError.status === 401) {
          setError('password', { message: ' ' })
        }
      } else {
        setFormError('Could not reach the IngestX server.')
      }
    }
  })

  return (
    <AuthLayout
      title="Sign in"
      subtitle={`${PRODUCT_TAGLINE} · ${CHANNEL_TIMEZONE}`}
      footer={
        <>
          <span className="text-muted">Forgot your password?</span>
          <Link to="/forgot-password" className="font-medium text-accent hover:underline">
            Reset it
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {formError && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg border border-line border-l-2 border-l-danger bg-danger-soft px-3 py-2.5"
          >
            <AlertCircle className="mt-px h-4 w-4 shrink-0 text-danger" />
            <p className="text-xs leading-relaxed text-default">{formError}</p>
          </div>
        )}

        <div>
          <label htmlFor="identifier" className="mb-1.5 block text-xs font-medium text-muted">
            Username
          </label>
          <input
            id="identifier"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            placeholder="admin"
            {...register('identifier')}
            aria-invalid={errors.identifier ? true : undefined}
            className={cn(
              'h-10 w-full rounded-md border bg-inset px-3 text-sm text-default',
              'placeholder:text-subtle focus:outline-none focus:ring-2',
              errors.identifier
                ? 'border-danger focus:border-danger'
                : 'border-line focus:border-accent focus:ring-[var(--accent-ring)]',
            )}
          />
          {errors.identifier && (
            <p role="alert" className="mt-1 text-xs text-danger">
              {errors.identifier.message}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-muted">
            Password
          </label>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="••••••••"
              {...register('password')}
              aria-invalid={errors.password ? true : undefined}
              className={cn(
                'h-10 w-full rounded-md border bg-inset px-3 pr-10 text-sm text-default',
                'placeholder:text-subtle focus:outline-none focus:ring-2',
                errors.password
                  ? 'border-danger focus:border-danger'
                  : 'border-line focus:border-accent focus:ring-[var(--accent-ring)]',
              )}
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-subtle transition-colors hover:text-default"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {errors.password?.message ? (
            <p role="alert" className="mt-1 text-xs text-danger">
              {errors.password.message}
            </p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className={cn(
            'flex h-10 w-full items-center justify-center gap-2 rounded-md bg-accent text-sm font-semibold text-accent-fg',
            'transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60',
          )}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Signing in…
            </>
          ) : (
            <>
              Sign in <ArrowRight className="h-4 w-4" />
            </>
          )}
        </button>

        <p className="flex items-center justify-center gap-1.5 pt-1 text-2xs text-subtle">
          <KeyRound className="h-3 w-3" />
          Session-protected · No password is stored in this browser
        </p>
      </form>
    </AuthLayout>
  )
}

// ---------------------------------------------------------------------------

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden bg-canvas px-4 py-10">
      {/* Ambient gradient wash: keeps the sign-in page from reading as a bare
          form floating on grey. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.55]"
        style={{
          background:
            'radial-gradient(60rem 32rem at 18% -10%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%),' +
            'radial-gradient(48rem 30rem at 92% 108%, color-mix(in srgb, var(--info) 14%, transparent), transparent 70%)',
        }}
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <PlyoutLogo size={40} />
          <div>
            <h1 className="text-xl font-bold tracking-tight text-default">{PRODUCT_NAME}</h1>
            <p className="mt-0.5 text-xs text-muted">{subtitle ?? PRODUCT_TAGLINE}</p>
          </div>
        </div>

        <div className="rounded-xl border border-line bg-surface p-6 shadow-lg">
          <h2 className="mb-5 text-sm font-semibold text-default">{title}</h2>
          {children}
        </div>

        {footer && (
          <div className="mt-5 flex items-center justify-center gap-1.5 text-xs">{footer}</div>
        )}
      </div>
    </div>
  )
}
