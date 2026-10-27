import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { GripVertical, Plus, Route, Trash2, Unlock, Lock } from 'lucide-react'

import type { MediaItem, ScheduleEvent } from '@/api/types'
import { CHANNEL_TIMEZONE } from '@/config'
import { cn } from '@/lib/cn'
import { displayTitle, formatClock, formatShortDuration } from '@/lib/format'
import { Modal } from '@/components/ui/modal'
import { EmptyState, StatusBadge } from '@/components/ui/primitives'
import { Button } from '@/components/ui/button'

export interface ChainMember {
  event: ScheduleEvent
  durationSeconds: number
}

export interface ChainModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The exact grouping the agent will compute (AC-35). */
  members: ChainMember[]
  routeRef: string
  isSaving: boolean
  /** Returns the new ordering, or null when the operator cancelled. */
  onCommit: (order: number[]) => void
  onDeleteMember: (ids: number[]) => void
  onAddMember: () => void
}

/** Pointer travel before a press becomes a drag, in px. */
const DRAG_THRESHOLD_PX = 4
/** Fallback row height, only used before the first measurement lands. */
const FALLBACK_ROW_PX = 46

interface DragSession {
  id: number
  /** Slot the row started in, so Escape can put it back. */
  fromIndex: number
  startY: number
  /** True once the pointer has travelled past the threshold. */
  active: boolean
}

/**
 * Ad-break editor (FR-CHAIN-01 .. FR-CHAIN-05).
 *
 * Reordering issues **one** batched `PATCH /schedules/times/` with the whole
 * new layout, because the server validates atomically: a half-applied reorder
 * would leave a break with a gap, and a gap larger than 1s splits it into two
 * separate breaks that each air their own route-back.
 *
 * Reorder by dragging a row, or with ↑/↓ on a focused row. What this is *not*
 * is a timeline drag (FR-DND-09): picking a segment up on the lanes moves the
 * whole break, and an operator cannot reason about "which of these five is about
 * to change places" while watching it slide. Inside the editor the break is
 * already isolated, the new order is previewed in place with the clock times
 * relaying out beneath each title, and nothing is written until Apply.
 */
export function ChainModal({
  open,
  onOpenChange,
  members,
  routeRef,
  isSaving,
  onCommit,
  onDeleteMember,
  onAddMember,
}: ChainModalProps) {
  const [order, setOrder] = useState<number[]>(() => members.map((m) => m.event.id))
  /** The row the operator last pressed, highlighted until they press another. */
  const [selectedId, setSelectedId] = useState<number | null>(null)

  /**
   * Re-sync when the server's grouping changes underneath us -- but key the
   * effect on WHICH members there are, not on the array itself.
   *
   * Keying it on `members` meant every 30-second poll threw the operator's
   * in-progress reorder away and put the Apply button back to "Saved": the poll
   * hands back a brand-new array every time even when nothing about the break
   * has changed, so an edit that took longer than one poll interval simply
   * vanished. Keying on the id sequence re-syncs only when the break is
   * genuinely a different set of commercials.
   */
  const memberKey = useMemo(() => members.map((m) => m.event.id).join(','), [members])

  useEffect(() => {
    if (!open) return
    setOrder(memberKey === '' ? [] : memberKey.split(',').map(Number))
    setSelectedId(null)
  }, [open, memberKey])

  const byId = useMemo(() => new Map(members.map((m) => [m.event.id, m])), [members])

  const ordered = useMemo(
    () => order.map((id) => byId.get(id)).filter((m): m is ChainMember => Boolean(m)),
    [order, byId],
  )

  /**
   * FR-CHAIN-04: the modal closes itself the moment any member enters its lock
   * window. Editing a break that is about to fire is how commercials get
   * dropped on air.
   */
  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => {
      const now = Date.now()
      const locked = ordered.find(
        (m) => Date.parse(m.event.scheduled_time) - now <= 30_000 && m.event.status === 'PENDING',
      )
      if (locked) {
        onOpenChange(false)
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [open, onOpenChange, ordered])

  // --- drag to reorder -----------------------------------------------------

  const listRef = useRef<HTMLOListElement>(null)
  const sessionRef = useRef<DragSession | null>(null)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  /** Pointer travel since the press, in px -- the lifted card rides on this. */
  const [dragDy, setDragDy] = useState(0)
  /**
   * Row heights captured once per gesture, in state rather than a ref because
   * the render reads them to place the lifted card.
   *
   * The card is positioned by summing the heights of the rows above it, which
   * is exact for any permutation -- and unlike reading offsets back out of the
   * DOM on every frame, it does not care that the card itself is out of flow.
   */
  const [rowHeights, setRowHeights] = useState<Map<number, number>>(() => new Map())

  /** Where a card sits inside the list, for the current order. */
  const slotTopFor = useCallback(
    (id: number): number => {
      let top = 0
      for (const member of ordered) {
        if (member.event.id === id) return top
        top += rowHeights.get(member.event.id) ?? FALLBACK_ROW_PX
      }
      return top
    },
    [ordered, rowHeights],
  )

  /**
   * Measured once per pointer move, and only over a handful of rows in a
   * dialog -- so unlike the lanes, a little DOM reading here is cheaper than
   * the bookkeeping it would take to avoid it.
   */
  const readRows = useCallback((): { id: number; top: number; height: number }[] => {
    const list = listRef.current
    if (!list) return []
    return Array.from(list.querySelectorAll<HTMLElement>('li[data-chain-id]'), (el) => ({
      id: Number(el.dataset.chainId),
      top: el.getBoundingClientRect().top,
      height: el.getBoundingClientRect().height,
    }))
  }, [])

  const onDragMove = useCallback(
    (nativeEvent: PointerEvent) => {
      const session = sessionRef.current
      if (!session) return

      if (!session.active) {
        if (Math.abs(nativeEvent.clientY - session.startY) < DRAG_THRESHOLD_PX) return
        session.active = true
        setDraggingId(session.id)
      }

      setDragDy(nativeEvent.clientY - session.startY)
      const target = insertionIndexFor(nativeEvent.clientY, readRows(), session.id)
      setOrder((current) => moveIdTo(current, session.id, target))
    },
    [readRows],
  )

  /**
   * Teardown lives in a ref so that the move/up/key handlers can all reach it
   * without referring to each other -- `onDragUp` needs to detach the very
   * listener it is itself registered as.
   */
  const teardownRef = useRef<() => void>(() => {})

  const onDragUp = useCallback(() => {
    teardownRef.current()
  }, [])

  /** Escape abandons an in-flight reorder and puts the row back where it began. */
  const onDragKeyDown = useCallback((nativeEvent: KeyboardEvent) => {
    if (nativeEvent.key !== 'Escape') return
    const session = sessionRef.current
    if (!session) return
    nativeEvent.preventDefault()
    setOrder((current) => moveIdTo(current, session.id, session.fromIndex))
    teardownRef.current()
  }, [])

  /**
   * Attached at pointer-down rather than when the drag "starts": the move that
   * crosses the threshold is the first move, so waiting for it to set state
   * before listening would mean never seeing it and never starting a drag.
   */
  const attachDrag = useCallback(() => {
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragUp)
    window.addEventListener('keydown', onDragKeyDown)
    teardownRef.current = () => {
      window.removeEventListener('pointermove', onDragMove)
      window.removeEventListener('pointerup', onDragUp)
      window.removeEventListener('keydown', onDragKeyDown)
      sessionRef.current = null
      setDraggingId(null)
      setDragDy(0)
    }
  }, [onDragMove, onDragUp, onDragKeyDown])

  // A drag in flight must not outlive the dialog.
  useEffect(() => () => teardownRef.current(), [])

  const onRowPointerDown = useCallback(
    (nativeEvent: React.PointerEvent, index: number, member: ChainMember) => {
      setSelectedId(member.event.id)
      if (nativeEvent.button !== 0) return
      // The delete button is its own control; a press there must not start a drag.
      if ((nativeEvent.target as HTMLElement).closest('button')) return
      if (member.event.is_locked || member.event.is_on_air) return

      // Snapshot the layout before anything moves, so the lifted card has a
      // height to travel within.
      setRowHeights(new Map(readRows().map((row) => [row.id, row.height])))

      sessionRef.current = {
        id: member.event.id,
        fromIndex: index,
        startY: nativeEvent.clientY,
        active: false,
      }
      attachDrag()
    },
    [attachDrag, readRows],
  )

  /**
   * Keyboard equivalent of the drag. Without it the reorder would be a
   * pointer-only feature, which is not an acceptable trade for removing two
   * small buttons.
   */
  const onRowKeyDown = useCallback(
    (nativeEvent: React.KeyboardEvent, index: number, member: ChainMember) => {
      if (nativeEvent.key === 'ArrowUp' || nativeEvent.key === 'ArrowDown') {
        if (member.event.is_locked || member.event.is_on_air) return
        const target = index + (nativeEvent.key === 'ArrowUp' ? -1 : 1)
        if (target < 0 || target >= order.length) return
        nativeEvent.preventDefault()
        setSelectedId(member.event.id)
        setOrder((current) => {
          const next = [...current]
          ;[next[index], next[target]] = [next[target], next[index]]
          return next
        })
        // The row must keep focus, or a second keypress acts on whatever the
        // browser moved focus to.
        window.requestAnimationFrame(() => {
          listRef.current
            ?.querySelector<HTMLElement>(`li[data-chain-id="${member.event.id}"]`)
            ?.focus()
        })
        return
      }
      if (nativeEvent.key === 'Enter' || nativeEvent.key === ' ') {
        nativeEvent.preventDefault()
        setSelectedId((current) => (current === member.event.id ? null : member.event.id))
      }
    },
    [order.length],
  )

  /**
   * FLIP: the rows reorder instantly in the DOM, and this slides them from
   * where they were to where they now are.
   *
   * Without it the list snaps -- every neighbour teleports one slot the moment
   * the pointer crosses a midpoint -- and the row the operator is holding looks
   * like it is jumping rather than being carried.
   */
  const previousTops = useRef(new Map<number, number>())
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    for (const el of list.querySelectorAll<HTMLElement>('li[data-chain-id]')) {
      const id = Number(el.dataset.chainId)
      const top = el.offsetTop
      const previous = previousTops.current.get(id)
      if (previous !== undefined && previous !== top) {
        el.style.transform = `translateY(${previous - top}px)`
        // Force the browser to commit that start position before releasing it,
        // otherwise both values land in the same frame and nothing animates.
        void el.offsetHeight
        el.style.transform = ''
      }
      previousTops.current.set(id, top)
    }
  }, [order])

  const totalSeconds = ordered.reduce((sum, m) => sum + m.durationSeconds, 0)
  const startMs = ordered.length > 0 ? Date.parse(ordered[0].event.scheduled_time) : Date.now()
  const lifted = draggingId !== null ? byId.get(draggingId) : undefined

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Edit ad break"
      description={`${ordered.length} commercial${ordered.length === 1 ? '' : 's'} · ${formatShortDuration(totalSeconds)} total`}
      size="lg"
      footer={
        <>
          <span className="mr-auto inline-flex items-center gap-1.5 text-2xs text-subtle">
            <Route className="h-3 w-3" />
            Returns to live via <code className="font-mono text-muted">{routeRef}</code>
          </span>
          <Button variant="ghost" size="sm" onClick={onAddMember}>
            <Plus className="h-3.5 w-3.5" /> Add file
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={isSaving}
            disabled={!dirty(order, members)}
            onClick={() => onCommit(order)}
          >
            {dirty(order, members) ? 'Apply new order' : 'Saved'}
          </Button>
        </>
      }
    >
      {ordered.length === 0 ? (
        <EmptyState
          icon={<Trash2 className="h-5 w-5" />}
          title="This break is empty"
          description="Add a commercial to start a new break."
          action={
            <Button variant="primary" size="sm" onClick={onAddMember}>
              <Plus className="h-3.5 w-3.5" /> Add file
            </Button>
          }
        />
      ) : (
        <ol
          ref={listRef}
          className={cn(
            'relative rounded-lg border border-line',
            // While a card is lifted the list must stop clipping it, or the row
            // being carried is sliced off the moment it leaves the box.
            draggingId === null ? 'overflow-hidden' : 'overflow-visible',
          )}
        >
          {ordered.map((member, index) => {
            const locked = member.event.is_locked || member.event.is_on_air
            const position = `Commercial ${index + 1} of ${ordered.length}`

            if (draggingId === member.event.id) {
              // The hole the lifted card came out of.
              return (
                <li
                  key={member.event.id}
                  aria-hidden
                  className="rounded-[5px] border border-dashed border-[var(--accent)] bg-[var(--accent-soft)]"
                  style={{ height: rowHeights.get(member.event.id) ?? FALLBACK_ROW_PX }}
                />
              )
            }

            return (
              <li
                key={member.event.id}
                data-chain-id={member.event.id}
                tabIndex={locked ? -1 : 0}
                aria-label={`${position}: ${displayTitle(member.event.media_title) || 'Untitled'}`}
                aria-current={selectedId === member.event.id ? 'true' : undefined}
                onPointerDown={(nativeEvent) => onRowPointerDown(nativeEvent, index, member)}
                onKeyDown={(nativeEvent) => onRowKeyDown(nativeEvent, index, member)}
                className={cn(
                  'transition-transform duration-200 ease-out',
                  'border-b border-[var(--border-subtle)] last:border-b-0',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]',
                  // `select-none` so a drag across several rows does not paint
                  // a selection through the titles; `touch-none` so a long press
                  // on a tablet scrolls the list instead of picking a row up.
                  locked ? 'cursor-not-allowed' : 'cursor-grab touch-none select-none',
                  draggingId !== null && 'opacity-70',
                  member.event.is_on_air && 'bg-danger-soft',
                )}
              >
                <ChainRow
                  member={member}
                  index={index}
                  total={ordered.length}
                  airTime={startMs + cumulativeBefore(ordered, index) * 1000}
                  locked={locked}
                  selected={selectedId === member.event.id}
                  dimmed={draggingId !== null}
                  onDelete={() => onDeleteMember([member.event.id])}
                />
              </li>
            )
          })}

          {lifted && (
            <li
              aria-hidden
              style={{
                top: slotTopFor(lifted.event.id),
                height: rowHeights.get(lifted.event.id) ?? FALLBACK_ROW_PX,
                // The standalone `translate` property rather than `transform`:
                // Tailwind's `scale-*` writes `scale`, so the card can tilt and
                // travel at the same time without either one clobbering the other.
                translate: `0 ${dragDy}px`,
              }}
              className="absolute inset-x-0 z-30 cursor-grabbing pointer-events-none origin-center scale-[1.012] rounded-[5px] shadow-[0_18px_36px_-10px_rgb(0_0_0/0.55)] ring-1 ring-[var(--accent)]"
            >
              <ChainRow
                member={lifted}
                index={ordered.findIndex((m) => m.event.id === lifted.event.id)}
                total={ordered.length}
                airTime={
                  startMs + cumulativeBefore(ordered, ordered.findIndex((m) => m.event.id === lifted.event.id)) * 1000
                }
                locked={false}
                selected={selectedId === lifted.event.id}
                dimmed={false}
                lifted
              />
            </li>
          )}
        </ol>
      )}

      {ordered.length > 1 && (
        <p className="mt-3 text-2xs text-subtle">
          Drag a commercial to reorder it, or focus a row and press{' '}
          <kbd className="rounded border border-line px-1 font-mono">↑</kbd>{' '}
          <kbd className="rounded border border-line px-1 font-mono">↓</kbd>. Start times relayout
          automatically; nothing is written until you apply.
        </p>
      )}

      {ordered.some((member) => member.event.is_locked) && (
        <p className="mt-3 inline-flex items-center gap-1.5 text-2xs text-warn">
          <Unlock className="h-3 w-3" />
          Items inside the lock window cannot be reordered or removed.
        </p>
      )}
    </Modal>
  )
}

/**
 * The contents of one row. Rendered twice while a drag is in flight -- once in
 * the list and once as the lifted card -- which is why it is its own component.
 */
function ChainRow({
  member,
  index,
  total,
  airTime,
  locked,
  selected,
  dimmed,
  lifted = false,
  onDelete,
}: {
  member: ChainMember
  index: number
  total: number
  airTime: number
  locked: boolean
  selected: boolean
  dimmed: boolean
  lifted?: boolean
  onDelete?: () => void
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-3 py-2',
        'transition-colors duration-150',
        // Selection: a wash plus a hard edge on the leading side, so the picked
        // row is unmistakable even when a drag dims everything around it.
        //
        // Deliberately `bg-accent-soft` with no `/60` modifier: that token is
        // declared with its own alpha inside `@theme inline`, and Tailwind emits
        // the plain utility but silently drops the modifier -- so `bg-accent-soft/60`
        // compiles to nothing and the row stays invisible.
        selected && !lifted && 'bg-accent-soft shadow-[inset_3px_0_0_0_var(--accent)]',
        dimmed && !selected && 'opacity-70',
        lifted && 'bg-raised',
      )}
    >
      <GripVertical
        className={cn('h-4 w-4 shrink-0', locked ? 'text-subtle opacity-40' : 'text-subtle')}
        aria-hidden
      />

      <span
        className={cn(
          'tnum w-5 shrink-0 text-center text-xs font-semibold',
          selected ? 'text-accent' : 'text-subtle',
        )}
      >
        {index + 1}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-default">
          {displayTitle(member.event.media_title) || 'Untitled'}
        </p>
        <p className="tnum truncate font-mono text-[10px] text-subtle">
          {formatClock(new Date(airTime).toISOString(), CHANNEL_TIMEZONE)}
          {' · '}
          {member.event.media_file_path}
        </p>
      </div>

      <span className="tnum w-16 shrink-0 text-right text-2xs text-muted">
        {formatShortDuration(member.durationSeconds)}
      </span>

      <StatusBadge status={member.event.status} className="w-20 justify-center" />

      {locked ? (
        <span
          className="inline-flex w-8 items-center justify-center text-subtle"
          title={member.event.is_on_air ? 'On air — locked' : 'Inside the lock window'}
        >
          {member.event.is_on_air ? (
            <Lock className="h-3.5 w-3.5 text-danger" />
          ) : (
            <Lock className="h-3.5 w-3.5" />
          )}
        </span>
      ) : (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Remove ${member.event.media_title}`}
          className="inline-flex w-8 items-center justify-center rounded text-subtle transition-colors hover:bg-danger-soft hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}

      <span className="sr-only">
        {`${index + 1} of ${total}. ${locked ? 'Locked.' : ''}`}
      </span>
    </div>
  )
}

/**
 * Where a dragged row would land, counted in the slots left by every OTHER row.
 *
 * Measuring against the list-minus-the-dragged-row is what keeps this stable.
 * Against the whole list, a row that has just been moved down sits under the
 * pointer's own old midpoint and immediately swaps back, and the list jitters
 * between two orders instead of settling in one.
 */
function insertionIndexFor(
  pointerY: number,
  rows: { id: number; top: number; height: number }[],
  skipId: number,
): number {
  let slot = 0
  for (const { id, top, height } of rows) {
    if (id === skipId) continue
    if (pointerY < top + height / 2) return slot
    slot += 1
  }
  return slot
}

/** Move `id` to slot `to`, leaving the rest in order. */
function moveIdTo(current: readonly number[], id: number, to: number): number[] {
  const from = current.indexOf(id)
  if (from === -1 || from === to) return current as number[]
  const next = [...current]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

/** Cumulative duration of every member before `index` -- gapless relayout. */
function cumulativeBefore(members: ChainMember[], index: number): number {
  let total = 0
  for (let i = 0; i < index; i += 1) total += members[i].durationSeconds
  return total
}

/** Has the order moved away from what the server gave us? */
function dirty(order: readonly number[], members: readonly ChainMember[]): boolean {
  return (
    order.length !== members.length ||
    order.some((id, index) => members[index]?.event.id !== id)
  )
}

export type { MediaItem }