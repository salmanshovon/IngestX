import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, Copy, Film, Layers, Loader2, Plus, Search, Shapes, X } from 'lucide-react'

import type { MediaItem, MediaType } from '@/api/types'
import { cn } from '@/lib/cn'
import { displayTitle, fileExtension, formatShortDuration, toNumber } from '@/lib/format'
import { Badge, EmptyState } from '@/components/ui/primitives'
import { Checkbox, Label } from '@/components/ui/toggle'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'

type KindFilter = 'all' | MediaType

const KIND_TABS: Array<{ value: KindFilter; label: string; icon: typeof Film }> = [
  { value: 'all', label: 'All', icon: Layers },
  { value: 'FILE', label: 'Commercials', icon: Film },
  { value: 'CG', label: 'Graphics', icon: Shapes },
  { value: 'SCG', label: 'Standing CG', icon: Shapes },
]

export interface MediaPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: MediaItem[]
  isLoading: boolean
  /** Lanes the caller will accept; incompatible kinds are hidden up front. */
  acceptableTypes?: MediaType[]
  title?: string
  description?: string
  /** Multi-select turns the picker into the chain "add file" flow. */
  multiple?: boolean
  /** FR-PICK-05: CG items without a template are shown but disabled. */
  onResolve: (items: MediaItem[]) => void
}

/**
 * Media picker (FR-PICK-01 .. FR-PICK-05).
 *
 * Contract: resolves a selection, never mutates. The caller decides what to do
 * with the media; this component only filters and returns.
 *
 * Duration is always server-derived (`play_duration_seconds`) and shown
 * read-only -- for a CG that is the *template's* duration, because the CG file
 * itself reports zero (Spec §2.6). Typing a duration here would be a lie.
 */
export function MediaPicker({
  open,
  onOpenChange,
  items,
  isLoading,
  acceptableTypes,
  title = 'Select media',
  description,
  multiple,
  onResolve,
}: MediaPickerProps) {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [kind, setKind] = useState<KindFilter>(() => acceptableTypes?.[0] ?? 'all')
  const [activeOnly, setActiveOnly] = useState(true)
  // Ordered, and allowed to repeat: a commercial run can legitimately play
  // the same spot twice in one break, so this is a list of picks, not a set.
  const [picked, setPicked] = useState<number[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // 250 ms debounce (FR-PICK-01): a fast typist must not fire a request per
  // keystroke against a 91-row library, let alone a 10,000-row one.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search), 250)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    if (open) {
      setPicked([])
      setSearch('')
      setDebounced('')
      window.setTimeout(() => inputRef.current?.focus(), 60)
    }
  }, [open])

  const effectiveKinds = useMemo<KindFilter>(
    () => (acceptableTypes && acceptableTypes.length === 1 ? acceptableTypes[0] : 'all'),
    [acceptableTypes],
  )
  const activeKind = acceptableTypes && acceptableTypes.length === 1 ? effectiveKinds : kind

  const filtered = useMemo(() => {
    const needle = debounced.trim().toLowerCase()
    return items.filter((item) => {
      if (activeKind !== 'all' && item.media_type !== activeKind) return false
      if (activeOnly && !item.active_status) return false
      if (acceptableTypes && !acceptableTypes.includes(item.media_type)) return false
      if (!needle) return true
      return (
        item.title.toLowerCase().includes(needle) || item.file_path.toLowerCase().includes(needle)
      )
    })
  }, [items, activeKind, activeOnly, debounced, acceptableTypes])

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])

  function toggle(id: number) {
    if (!multiple) {
      setPicked((current) => (current.includes(id) ? [] : [id]))
      return
    }
    setPicked((current) => (current.includes(id) ? current.filter((v) => v !== id) : [...current, id]))
  }

  /** Append another copy of a spot already in the break. */
  function duplicate(index: number) {
    setPicked((current) => {
      const next = [...current]
      next.splice(index + 1, 0, next[index])
      return next
    })
  }

  function move(from: number, to: number) {
    setPicked((current) => {
      if (to < 0 || to >= current.length || from === to) return current
      const next = [...current]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
  }

  function removeAt(index: number) {
    setPicked((current) => current.filter((_, i) => i !== index))
  }

  function confirm() {
    const chosen = picked.map((id) => byId.get(id)).filter((item): item is MediaItem => Boolean(item))
    if (chosen.length === 0) return
    onResolve(chosen)
    onOpenChange(false)
  }

  // Running total, so the operator sees the break length before committing.
  const totalSeconds = picked.reduce(
    (sum, id) => sum + (toNumber(byId.get(id)?.play_duration_seconds) ?? 0),
    0,
  )

  const allVisiblePicked = filtered.length > 0 && filtered.every((item) => picked.includes(item.id))
  const someVisiblePicked = filtered.some((item) => picked.includes(item.id))

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="xl"
      footer={
        <>
          <span className="tnum mr-auto text-2xs text-subtle">
            {picked.length > 0
              ? `${picked.length} in the break · ${formatShortDuration(totalSeconds)}`
              : 'Pick items to build the break.'}
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-8 rounded-md border border-line px-3 text-xs font-medium text-muted transition-colors hover:bg-hover hover:text-default"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={picked.length === 0}
            className="h-8 rounded-md bg-accent px-3 text-xs font-semibold text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            {multiple ? `Add ${picked.length} to break` : 'Schedule'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            ref={inputRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by title or file path…"
            leading={<Search className="h-3.5 w-3.5" />}
            className="h-9 min-w-56 flex-1"
            aria-label="Search media"
          />

          {(!acceptableTypes || acceptableTypes.length > 1) && (
            <div className="flex items-center gap-1 rounded-md border border-line bg-inset p-0.5">
              {KIND_TABS.filter(
                (tab) => tab.value === 'all' || !acceptableTypes || acceptableTypes.includes(tab.value as MediaType),
              ).map(
                (tab) => (
                  <button
                    key={tab.value}
                    type="button"
                    onClick={() => setKind(tab.value)}
                    aria-pressed={activeKind === tab.value}
                    className={cn(
                      'rounded px-2.5 py-1 text-2xs font-medium transition-colors',
                      activeKind === tab.value
                        ? 'bg-accent text-accent-fg'
                        : 'text-muted hover:text-default',
                    )}
                  >
                    {tab.label}
                  </button>
                ),
              )}
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-muted">
            <Checkbox
              checked={activeOnly}
              onCheckedChange={setActiveOnly}
              id="picker-active-only"
            />
            Active only
          </label>
        </div>

        {/* Two panels, but only for the ad-break flow. "What can I use" and
            "what did I choose, in what order" are two different questions, and
            a break has to answer the second one. Scheduling a single CG has
            nothing to order, so it stays a plain list. */}
        <div className={cn('grid min-h-0 gap-3', multiple && 'md:grid-cols-[1fr_20rem]')}>
          {/* ---------- library ---------- */}
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line">
            <div className="flex items-center gap-3 border-b border-line bg-inset px-3 py-1.5">
              <Checkbox
                checked={allVisiblePicked ? true : someVisiblePicked ? 'indeterminate' : false}
                onCheckedChange={(checked) =>
                  setPicked(
                    checked
                      ? Array.from(new Set([...picked, ...filtered.map((item) => item.id)]))
                      : picked.filter((id) => !filtered.some((item) => item.id === id)),
                  )
                }
                disabled={filtered.length === 0}
                id="picker-select-all"
              />
              <Label htmlFor="picker-select-all">Select all</Label>
              <span className="tnum ml-auto text-2xs text-subtle">
                {filtered.length} of {items.length} shown
              </span>
            </div>

            <div className="max-h-[44vh] min-h-0 flex-1 overflow-auto">
              {isLoading && (
                <div className="flex items-center justify-center gap-2 py-10 text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-xs">Loading the media library…</span>
                </div>
              )}

              {!isLoading && filtered.length === 0 && (
                <EmptyState
                  icon={<Search className="h-5 w-5" />}
                  title="No media matched"
                  description={
                    activeOnly
                      ? 'Try clearing the “Active only” filter, or run a media scan from the Navigator.'
                      : 'Adjust the search term or the kind filter.'
                  }
                />
              )}

              {!isLoading &&
                filtered.map((item) => (
                  <MediaRow
                    key={item.id}
                    item={item}
                    picked={picked.includes(item.id)}
                    useCount={picked.filter((id) => id === item.id).length}
                    disabled={item.is_incomplete}
                    onToggle={() => toggle(item.id)}
                    onAdd={multiple && !item.is_incomplete ? () => setPicked((c) => [...c, item.id]) : undefined}
                  />
                ))}
            </div>
          </div>

          {/* ---------- chosen, in order (ad breaks only) ---------- */}
          {multiple && (
            <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line">
              <div className="flex items-center justify-between gap-2 border-b border-line bg-inset px-3 py-1.5">
                <span className="text-2xs font-semibold tracking-wide text-muted uppercase">
                  In this break
                </span>
                <span className="tnum text-2xs text-subtle">
                  {picked.length > 0 ? `${picked.length} · ${formatShortDuration(totalSeconds)}` : '—'}
                </span>
              </div>

              {picked.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 py-8 text-center">
                  <Layers className="h-5 w-5 text-subtle" />
                  <p className="text-2xs text-subtle">
                    Click an item on the left to add it. The order here is the order it will air.
                  </p>
                </div>
              ) : (
                <ol className="max-h-[44vh] min-h-0 flex-1 overflow-auto">
                  {picked.map((id, index) => {
                    const item = byId.get(id)
                    if (!item) return null
                    const duration = toNumber(item.play_duration_seconds) ?? 0
                    return (
                      <li
                        key={`${id}-${index}`}
                        className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 py-1.5"
                      >
                        <span className="tnum w-4 shrink-0 text-center text-2xs font-semibold text-subtle">
                          {index + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] leading-tight font-medium text-default">
                            {displayTitle(item.title)}
                          </span>
                          <span className="tnum block text-[10px] leading-tight text-subtle">
                            {formatShortDuration(duration)}
                          </span>
                        </span>
                        <div className="flex shrink-0 items-center gap-0.5">
                          <IconAction
                            label="Move up"
                            disabled={index === 0}
                            onClick={() => move(index, index - 1)}
                          >
                            <ChevronUp className="h-3.5 w-3.5" />
                          </IconAction>
                          <IconAction
                            label="Move down"
                            disabled={index === picked.length - 1}
                            onClick={() => move(index, index + 1)}
                          >
                            <ChevronDown className="h-3.5 w-3.5" />
                          </IconAction>
                          <IconAction label="Add another copy" onClick={() => duplicate(index)}>
                            <Copy className="h-3.5 w-3.5" />
                          </IconAction>
                          <IconAction label="Remove" onClick={() => removeAt(index)} danger>
                            <X className="h-3.5 w-3.5" />
                          </IconAction>
                        </div>
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

function MediaRow({
  item,
  picked,
  useCount,
  disabled,
  onToggle,
  onAdd,
}: {
  item: MediaItem
  picked: boolean
  /** How many times this spot is already in the break. */
  useCount: number
  disabled: boolean
  onToggle: () => void
  /** Multi-select only: append another copy instead of toggling. */
  onAdd?: () => void
}) {
  const duration = toNumber(item.play_duration_seconds) ?? 0
  const extension = fileExtension(item.file_path)

  return (
    // A `<div role="button">`, not a `<button>`: Radix Checkbox renders a real
    // `<button role="checkbox">`, and a button inside a button is invalid HTML
    // that browsers "repair" by hoisting one out — which silently breaks the
    // row's click target.
    <div
      role="button"
      tabIndex={0}
      onClick={disabled ? undefined : onToggle}
      onKeyDown={(event) => {
        if (disabled) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggle()
        }
      }}
      aria-pressed={picked}
      aria-label={`Select ${item.title}`}
      className={cn(
        'group flex w-full cursor-pointer items-center gap-3 border-b border-[var(--border-subtle)] px-3 py-2 text-left',
        'last:border-b-0',
        disabled
          ? 'cursor-not-allowed opacity-50'
          : picked
            ? 'bg-accent-soft'
            : 'hover:bg-[var(--bg-hover)]',
      )}
    >
      <Checkbox checked={picked} onCheckedChange={onToggle} disabled={disabled} />
      <Badge tone={item.media_type === 'FILE' ? 'info' : 'accent'}>{item.media_type}</Badge>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-default">
          {displayTitle(item.title)}
        </span>
        <span className="block truncate font-mono text-[10px] text-subtle">{item.file_path}</span>
      </span>

      {/* Already in the break: say how many times, and offer another. */}
      {useCount > 0 && <Badge tone="ok">×{useCount}</Badge>}
      {onAdd && (
        <button
          type="button"
          aria-label={`Add another ${item.title} to the break`}
          title="Add another copy"
          onClick={(event) => {
            event.stopPropagation()
            onAdd()
          }}
          className="hidden h-6 w-6 shrink-0 items-center justify-center rounded border border-line text-muted transition-colors hover:bg-hover hover:text-default group-hover:inline-flex"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}

      {item.is_incomplete && (
        <span className="inline-flex items-center gap-1 text-2xs text-warn" title="CG items require a GraphicsTemplate">
          <AlertTriangle className="h-3 w-3" /> No template
        </span>
      )}
      {item.template_name && (
        <Badge tone="muted" className="hidden sm:inline-flex">
          {item.template_name}
        </Badge>
      )}
      {!item.active_status && <Badge tone="muted">Inactive</Badge>}

      <span className="tnum w-16 shrink-0 text-right text-2xs text-muted">
        {formatShortDuration(duration)}
      </span>
      <span className="w-10 shrink-0 text-right text-[10px] uppercase text-subtle">{extension}</span>
    </div>
  )
}

/** Small square icon button used by the ordered panel. */
function IconAction({
  label,
  disabled,
  danger,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded transition-colors',
        'disabled:pointer-events-none disabled:opacity-25',
        danger ? 'text-subtle hover:bg-danger-soft hover:text-danger' : 'text-muted hover:bg-hover hover:text-default',
      )}
    >
      {children}
    </button>
  )
}
