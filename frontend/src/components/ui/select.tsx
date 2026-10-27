import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'

import { cn } from '@/lib/cn'

const CONTROL =
  'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-line bg-inset px-2.5 ' +
  'text-sm text-default transition-colors hover:border-line-strong ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-subtle'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface SelectProps {
  value: string
  onValueChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  id?: string
  'aria-label'?: string
  disabled?: boolean
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  className,
  id,
  'aria-label': ariaLabel,
  disabled,
}: SelectProps) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger id={id} aria-label={ariaLabel} className={cn(CONTROL, className)}>
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-subtle" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="animate-in-fade z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line bg-raised shadow-lg"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  'relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm text-default',
                  'outline-none data-[highlighted]:bg-hover data-[highlighted]:text-default',
                  'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
                )}
              >
                <SelectPrimitive.ItemIndicator className="flex w-4 shrink-0 items-center">
                  <Check className="h-3.5 w-3.5 text-accent" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}