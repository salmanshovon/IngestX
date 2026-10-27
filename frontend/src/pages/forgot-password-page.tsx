import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, ArrowLeft, Check } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link } from 'react-router-dom'
import { z } from 'zod'

import { authApi } from '@/api/accounts'
import { ApiError, isApiError } from '@/lib/api-client'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AuthLayout } from './login-page'

/**
 * Password reset (WF-03): email → OTP code → tesseract → new password.
 *
 * Two quirks of the legacy contract are preserved deliberately:
 *
 * - `otp/send` **always** answers 202, whether or not the address exists. The
 *   UI must not branch on the response or it becomes an account-enumeration
 *   oracle (AC-09).
 * - `otp/verify` returns a `tesseract`, which is a *different* value from the
 *   emailed code: the code is discarded and replaced by this token, which the
 *   reset then consumes (AC-07). Single use -- consuming it clears it.
 */

type Step = 'email' | 'code' | 'tesseract' | 'reset' | 'done'

const emailSchema = z.object({ email: z.string().trim().email('Enter a valid email address.') })
const codeSchema = z.object({ code: z.string().trim().min(4, 'Enter the code from the email.') })
const resetSchema = z
  .object({
    new_password: z.string().min(12, 'At least 12 characters.'),
    confirm_password: z.string().min(1, 'Repeat the password.'),
  })
  .refine((values) => values.new_password === values.confirm_password, {
    message: 'Passwords do not match.',
    path: ['confirm_password'],
  })

export function ForgotPasswordPage() {
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [tesseract, setTesseract] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const sendForm = useForm<z.infer<typeof emailSchema>>({ resolver: zodResolver(emailSchema) })
  const codeForm = useForm<z.infer<typeof codeSchema>>({ resolver: zodResolver(codeSchema) })
  const resetForm = useForm<z.infer<typeof resetSchema>>({ resolver: zodResolver(resetSchema) })

  async function handleSendEmail(values: z.infer<typeof emailSchema>) {
    setFormError(null)
    setBusy(true)
    try {
      await authApi.sendOtp(values.email)
      setEmail(values.email)
      setStep('code')
    } catch (error) {
      setFormError(
        isApiError(error)
          ? (error as ApiError).message
          : 'Could not reach the IngestX server.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleVerifyCode(values: z.infer<typeof codeSchema>) {
    setFormError(null)
    setBusy(true)
    try {
      const result = await authApi.verifyOtp({ email, code: values.code })
      setTesseract(result.tesseract)
      setStep('reset')
    } catch (error) {
      setFormError(
        isApiError(error)
          ? (error as ApiError).code === 'RATE_LIMITED'
            ? 'Too many attempts. Wait a few minutes.'
            : (error as ApiError).message
          : 'Could not reach the IngestX server.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleReset(values: z.infer<typeof resetSchema>) {
    setFormError(null)
    setBusy(true)
    try {
      await authApi.resetPassword({ email, tesseract, ...values })
      setStep('done')
    } catch (error) {
      const apiError = error as ApiError
      setFormError(
        isApiError(apiError)
          ? apiError.code === 'INVALID_TOKEN'
            ? 'This reset link is no longer valid. Start again.'
            : apiError.message
          : 'Could not reach the IngestX server.',
      )
      if (isApiError(apiError) && apiError.code === 'INVALID_TOKEN') {
        setTimeout(() => setStep('email'), 1800)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      footer={
        <Link to="/login" className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">
          <ArrowLeft className="h-3 w-3" /> Back to sign in
        </Link>
      }
    >
      <Steps current={step} />

      {formError && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2.5 rounded-lg border border-line border-l-2 border-l-danger bg-danger-soft px-3 py-2.5"
        >
          <AlertCircle className="mt-px h-4 w-4 shrink-0 text-danger" />
          <p className="text-xs leading-relaxed text-default">{formError}</p>
        </div>
      )}

      {step === 'email' && (
        <form onSubmit={sendForm.handleSubmit(handleSendEmail)} className="mt-5 space-y-4" noValidate>
          <Input
            label="Email address"
            type="email"
            autoComplete="email"
            autoFocus
            placeholder="you@channel.com"
            error={sendForm.formState.errors.email?.message}
            {...sendForm.register('email')}
          />
          <p className="text-2xs leading-relaxed text-subtle">
            We will send a one-time code to the address on your account. If it does not match an
            account, you will not be told -- that is deliberate.
          </p>
          <Button type="submit" variant="primary" className="h-10 w-full" loading={busy}>
            Send code
          </Button>
        </form>
      )}

      {step === 'code' && (
        <form onSubmit={codeForm.handleSubmit(handleVerifyCode)} className="mt-5 space-y-4" noValidate>
          <p className="text-xs text-muted">
            Enter the 6-digit code sent to <span className="text-default">{email}</span>.
          </p>
          <Input
            label="Verification code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            placeholder="123456"
            className="tnum tracking-[0.3em]"
            error={codeForm.formState.errors.code?.message}
            {...codeForm.register('code')}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStep('email')}
              className="flex-1"
            >
              Back
            </Button>
            <Button type="submit" variant="primary" className="h-9 flex-1" loading={busy}>
              Verify
            </Button>
          </div>
        </form>
      )}

      {step === 'reset' && (
        <form onSubmit={resetForm.handleSubmit(handleReset)} className="mt-5 space-y-4" noValidate>
          <p className="text-xs text-muted">Choose a new password for your account.</p>
          <Input
            label="New password"
            type="password"
            autoComplete="new-password"
            autoFocus
            error={resetForm.formState.errors.new_password?.message}
            {...resetForm.register('new_password')}
          />
          <Input
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            error={resetForm.formState.errors.confirm_password?.message}
            {...resetForm.register('confirm_password')}
          />
          <Button type="submit" variant="primary" className="h-10 w-full" loading={busy}>
            Set new password
          </Button>
        </form>
      )}

      {step === 'done' && (
        <div className="mt-6 flex flex-col items-center gap-3 py-4 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ok-soft text-ok">
            <Check className="h-6 w-6" />
          </span>
          <p className="text-sm font-medium text-default">Password updated</p>
          <p className="text-xs text-muted">You can sign in with your new password now.</p>
          <Link
            to="/login"
            className="mt-1 inline-flex h-9 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
          >
            Go to sign in
          </Link>
        </div>
      )}
    </AuthLayout>
  )
}

const STEP_ORDER: Step[] = ['email', 'code', 'reset']

function Steps({ current }: { current: Step }) {
  if (current === 'done') return null
  const activeIndex = STEP_ORDER.indexOf(current === 'tesseract' ? 'reset' : current)
  if (activeIndex < 0) return null

  const labels = ['Email', 'Verify', 'Reset']
  return (
    <ol className="mb-1 flex items-center gap-1.5" aria-label="Progress">
      {labels.map((label, index) => (
        <li key={label} className="flex flex-1 items-center gap-1.5">
          <span
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold transition-colors',
              index < activeIndex && 'bg-ok text-white',
              index === activeIndex && 'bg-accent text-accent-fg',
              index > activeIndex && 'bg-sunken text-subtle',
            )}
          >
            {index < activeIndex ? <Check className="h-3 w-3" strokeWidth={3} /> : index + 1}
          </span>
          <span
            className={cn(
              'text-2xs font-medium',
              index <= activeIndex ? 'text-default' : 'text-subtle',
            )}
          >
            {label}
          </span>
          {index < labels.length - 1 && (
            <span className="ml-auto h-px flex-1 bg-line" aria-hidden />
          )}
        </li>
      ))}
    </ol>
  )
}


