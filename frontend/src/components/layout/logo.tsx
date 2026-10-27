import { cn } from '@/lib/cn'

/** The product mark. Pure SVG, no asset pipeline, no icon-font dependency. */
export function PlyoutLogo({ className, size = 26 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={cn('shrink-0', className)}
      aria-hidden
    >
      <defs>
        <linearGradient id="plyout-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--accent)" />
          <stop offset="100%" stopColor="var(--info)" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="4.5" width="29" height="23" rx="4.5" stroke="url(#plyout-mark)" strokeWidth="2" />
      {/* programme band */}
      <path d="M5 23V15.5l4.5 3 4.5-3V23" stroke="var(--fg-subtle)" strokeWidth="1.8" strokeLinejoin="round" />
      {/* ad break */}
      <rect x="16" y="15.5" width="11" height="7.5" rx="1.6" fill="var(--warn)" />
      {/* live dot */}
      <circle cx="25.5" cy="9" r="2.1" fill="var(--danger)" />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-baseline gap-1.5', className)}>
      <span className="text-sm font-bold tracking-tight text-default">Ingest</span>
      <span className="text-sm font-bold tracking-tight text-accent">X</span>
    </span>
  )
}