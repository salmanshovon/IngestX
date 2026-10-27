import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
type Size = 'xs' | 'sm' | 'md' | 'lg' | 'icon'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-fg hover:bg-accent-hover shadow-sm active:translate-y-px disabled:hover:bg-accent',
  secondary:
    'bg-raised text-default border border-line hover:bg-hover hover:border-line-strong active:translate-y-px',
  ghost: 'text-muted hover:bg-hover hover:text-default',
  subtle: 'bg-sunken text-muted hover:bg-hover hover:text-default border border-transparent',
  danger: 'bg-danger text-white hover:brightness-110 shadow-sm active:translate-y-px',
}

const SIZES: Record<Size, string> = {
  xs: 'h-6 px-2 text-2xs gap-1 rounded',
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-sm gap-2 rounded-lg',
  icon: 'h-8 w-8 rounded-md justify-center',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', loading, icon, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center font-medium whitespace-nowrap select-none',
        'transition-[background-color,color,border-color,box-shadow,transform] duration-100',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        icon
      )}
      {children}
    </button>
  )
})