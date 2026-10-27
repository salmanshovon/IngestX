import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import * as LabelPrimitive from '@radix-ui/react-label'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { Check, Minus } from 'lucide-react'

import { cn } from '@/lib/cn'

// ---------------------------------------------------------------------------
// Checkbox -- tri-state capable for the media library select-all column (FR-NAV-04)
// ---------------------------------------------------------------------------

export interface CheckboxProps {
  checked: boolean | 'indeterminate'
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
  className?: string
  id?: string
}

export function Checkbox({ checked, onCheckedChange, disabled, label, className, id }: CheckboxProps) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <CheckboxPrimitive.Root
        id={id}
        disabled={disabled}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className={cn(
          'peer flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
          'border-line-strong bg-inset',
          'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
          'data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent',
          'disabled:cursor-not-allowed disabled:opacity-40',
        )}
      >
        <CheckboxPrimitive.Indicator className="flex items-center text-accent-fg">
          {checked === 'indeterminate' ? (
            <Minus className="h-3 w-3" strokeWidth={3} />
          ) : (
            <Check className="h-3 w-3" strokeWidth={3} />
          )}
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      {label && (
        <LabelPrimitive.Root
          htmlFor={id}
          className="cursor-pointer text-sm text-default select-none data-[disabled]:opacity-50"
        >
          {label}
        </LabelPrimitive.Root>
      )}
    </span>
  )
}

export function Label({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('text-xs font-medium text-muted', className)}
      {...props}
    />
  )
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
  id?: string
  className?: string
}

export function Switch({ checked, onCheckedChange, disabled, label, id, className }: SwitchProps) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <SwitchPrimitive.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        className={cn(
          'relative h-[18px] w-8 shrink-0 rounded-full border border-transparent transition-colors',
          'data-[state=checked]:bg-accent data-[state=unchecked]:bg-line-strong',
          'disabled:cursor-not-allowed disabled:opacity-40',
        )}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            'block h-3.5 w-3.5 translate-x-0.5 rounded-full bg-white shadow transition-transform',
            'data-[state=checked]:translate-x-[15px]',
          )}
        />
      </SwitchPrimitive.Root>
      {label && (
        <LabelPrimitive.Root
          htmlFor={id}
          className="cursor-pointer text-sm text-default select-none"
        >
          {label}
        </LabelPrimitive.Root>
      )}
    </span>
  )
}