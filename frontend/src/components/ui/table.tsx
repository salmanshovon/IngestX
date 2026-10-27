import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react'

import { cn } from '@/lib/cn'

/**
 * Data table primitives.
 *
 * A plain semantic table rather than a grid library: the exec log is 100% row
 * semantics and screen readers handle that better than ARIA grids.
 */

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-auto">
      <table className={cn('w-full border-collapse text-sm', className)} {...props} />
    </div>
  )
}

export function THead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <thead
      className={cn(
        'sticky top-0 z-10 border-b border-line bg-inset/95 backdrop-blur',
        className,
      )}
    >
      {children}
    </thead>
  )
}

export function TBody({ children, className }: { children: ReactNode; className?: string }) {
  return <tbody className={cn('divide-y divide-[var(--border-subtle)]', className)}>{children}</tbody>
}

export function TR({
  className,
  selected,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { selected?: boolean }) {
  return (
    <tr
      className={cn(
        'transition-colors',
        selected ? 'bg-accent-soft' : 'hover:bg-[var(--bg-hover)]',
        className,
      )}
      {...props}
    />
  )
}

interface CellProps {
  className?: string
  numeric?: boolean
}

export function TH({
  className,
  children,
  numeric,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & CellProps) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 text-left text-2xs font-semibold tracking-wide text-muted uppercase whitespace-nowrap',
        numeric && 'text-right',
        className,
      )}
      {...props}
    >
      {children}
    </th>
  )
}

export function TD({
  className,
  children,
  numeric,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & CellProps) {
  return (
    <td
      className={cn('px-3 py-2 align-middle text-default', numeric && 'text-right tnum', className)}
      {...props}
    >
      {children}
    </td>
  )
}

export function SortHeader({
  label,
  column,
  active,
  direction,
  onSort,
  className,
}: {
  label: string
  column: string
  active: boolean
  direction: 'asc' | 'desc'
  onSort: (column: string) => void
  className?: string
}) {
  return (
    <TH className={className}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          'inline-flex items-center gap-1 rounded transition-colors hover:text-default',
          active && 'text-default',
        )}
        aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        <span className={cn('text-[9px] leading-none', active ? 'text-accent' : 'text-subtle')}>
          {active ? (direction === 'asc' ? '▲' : '▼') : '▲'}
        </span>
      </button>
    </TH>
  )
}