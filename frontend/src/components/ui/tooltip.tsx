import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

/**
 * Tooltip provider. `delayDuration` is kept short: an operator moving across
 * clips wants the hint now, not after a beat (FR-CL-08).
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={180} skipDelayDuration={300}>
      {children}
    </TooltipPrimitive.Provider>
  )
}

export function Tooltip({
  children,
  content,
  side = 'top',
  align = 'center',
  className,
}: {
  children: ReactNode
  content: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  className?: string
}) {
  if (!content) return <>{children}</>
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          className={cn(
            'animate-in-fade z-[60] max-w-xs rounded-lg border border-line bg-raised px-2.5 py-1.5',
            'text-xs leading-relaxed text-default shadow-md',
            className,
          )}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-[var(--border-default)]" width={10} height={5} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}