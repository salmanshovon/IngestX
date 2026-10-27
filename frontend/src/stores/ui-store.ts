/**
 * Zustand stores for UI state only (FR-ST-02).
 *
 * Server state lives in React Query. Nothing in here holds schedule data: this
 * is viewport, selection, panels and preferences. That separation is what stops
 * a component quietly keeping a stale authoritative copy (FR-ST-07).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { MediaLane } from '@/api/types'
import {
  DEFAULT_ZOOM_INDEX,
  HOUR,
  MINUTES,
  ZOOM_LEVELS_MS,
  anchorNow,
  type Viewport,
} from '@/lib/timeline'

export type NowMode = 'marker' | 'timeline'

interface UiState {
  // --- timeline viewport (FR-ST-02 / FR-ST-05) ---
  offsetMs: number
  zoomIndex: number
  nowMode: NowMode
  /** Width of the lane area in px; owned by the timeline's resize observer. */
  laneWidthPx: number

  // --- selection ---
  selectedEventId: number | null
  focusedLane: { pipelineId: number; lane: MediaLane } | null
  inspectorOpen: boolean
  /** Run-down list. Mutually exclusive with the inspector (they share a rail). */
  rundownOpen: boolean
  inspectorAsDrawer: boolean

  // --- active server (navigator / system) ---
  activeServerId: number | null
  activePipelineId: number | null

  // --- preferences ---
  theme: 'light' | 'dark'
  showGrid: boolean
  /** Auto-refresh schedules even while the realtime stream is healthy. */
  pollRealtimeToo: boolean

  setViewport: (viewport: Partial<Pick<Viewport, 'offsetMs' | 'zoomMs' | 'widthPx'>>) => void
  setLaneWidth: (px: number) => void
  shiftBy: (deltaMs: number) => void
  zoomIn: () => void
  zoomOut: () => void
  setZoomIndex: (index: number) => void
  setNowMode: (mode: NowMode) => void
  toggleNowMode: () => void
  jumpToNow: (nowMs?: number) => void
  centreOn: (ms: number) => void

  selectEvent: (id: number | null) => void
  setFocusedLane: (lane: UiState['focusedLane']) => void
  setInspectorOpen: (open: boolean) => void
  toggleRundown: () => void
  setInspectorAsDrawer: (drawer: boolean) => void

  setActiveServerId: (id: number | null) => void
  setActivePipelineId: (id: number | null) => void

  setTheme: (theme: 'light' | 'dark') => void
  toggleTheme: () => void
  setShowGrid: (value: boolean) => void
  setPollRealtimeToo: (value: boolean) => void
}

/**
 * Re-anchor the viewport across a zoom change.
 *
 * Following the clock, "now" must stay at NOW_ANCHOR -- otherwise zooming
 * silently detaches the marker from the spot the follow interval is about to
 * re-anchor to, and the two disagree for up to a second. Pinned, the midpoint
 * of the window is the operator's chosen anchor and is what should survive.
 */
function applyZoom(state: UiState, nextIndex: number): Partial<UiState> {
  if (nextIndex === state.zoomIndex) return { zoomIndex: nextIndex }
  const fromMs = ZOOM_LEVELS_MS[state.zoomIndex]
  const toMs = ZOOM_LEVELS_MS[nextIndex]
  const offsetMs =
    state.nowMode === 'timeline'
      ? anchorNow(Date.now(), toMs)
      : state.offsetMs + fromMs / 2 - toMs / 2
  return { zoomIndex: nextIndex, offsetMs }
}

function clampZoomIndex(index: number): number {
  return Math.min(ZOOM_LEVELS_MS.length - 1, Math.max(0, index))
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      offsetMs: Date.now() - 30 * MINUTES,
      zoomIndex: DEFAULT_ZOOM_INDEX,
      nowMode: 'timeline',
      laneWidthPx: 1200,

      selectedEventId: null,
      focusedLane: null,
      inspectorOpen: true,
      rundownOpen: false,
      inspectorAsDrawer: false,

      activeServerId: null,
      activePipelineId: null,

      theme: 'dark',
      showGrid: true,
      pollRealtimeToo: false,

      setViewport: (partial) =>
        set((state) => ({
          offsetMs: partial.offsetMs ?? state.offsetMs,
          zoomIndex: partial.zoomMs !== undefined ? zoomIndexFor(partial.zoomMs) : state.zoomIndex,
          laneWidthPx: partial.widthPx ?? state.laneWidthPx,
        })),

      setLaneWidth: (px) => set({ laneWidthPx: Math.max(0, px) }),

      shiftBy: (deltaMs) => set((state) => ({ offsetMs: state.offsetMs + deltaMs })),

      // Zoom keeps the same instant under the same spot on screen. Changing
      // only the zoom level and leaving `offsetMs` alone slides the window to a
      // different stretch of time, which is what made "now" and every clip's
      // stage disagree with the zoom after a step.
      zoomIn: () => set((state) => applyZoom(state, clampZoomIndex(state.zoomIndex - 1))),

      zoomOut: () => set((state) => applyZoom(state, clampZoomIndex(state.zoomIndex + 1))),

      setZoomIndex: (index) => set((state) => applyZoom(state, clampZoomIndex(index))),

      setNowMode: (mode) => set({ nowMode: mode }),
      toggleNowMode: () => set((state) => ({ nowMode: state.nowMode === 'marker' ? 'timeline' : 'marker' })),

      jumpToNow: (nowMs) =>
        set((state) => ({
          offsetMs: anchorNow(nowMs ?? Date.now(), ZOOM_LEVELS_MS[state.zoomIndex]),
        })),

      centreOn: (ms) =>
        set((state) => ({ offsetMs: ms - ZOOM_LEVELS_MS[state.zoomIndex] / 2 })),

      selectEvent: (id) => set({ selectedEventId: id }),
      setFocusedLane: (lane) => set({ focusedLane: lane }),
      // The inspector and the run-down occupy the same side rail; opening one
      // closes the other rather than squeezing the timeline to half width.
      setInspectorOpen: (open) => set({ inspectorOpen: open, ...(open ? { rundownOpen: false } : null) }),
      toggleRundown: () =>
        set((state) => ({ rundownOpen: !state.rundownOpen, ...(state.rundownOpen ? null : { inspectorOpen: false }) })),
      setInspectorAsDrawer: (drawer) => set({ inspectorAsDrawer: drawer }),

      setActiveServerId: (id) => set({ activeServerId: id }),
      setActivePipelineId: (id) => set({ activePipelineId: id }),

      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
      setShowGrid: (value) => set({ showGrid: value }),
      setPollRealtimeToo: (value) => set({ pollRealtimeToo: value }),
    }),
    {
      name: 'plyout.ui',
      // Everything except the live offset is worth restoring on reload; the
      // offset is re-anchored to "now" instead (FR-ST-05).
      partialize: (state) => ({
        zoomIndex: state.zoomIndex,
        nowMode: state.nowMode,
        theme: state.theme,
        showGrid: state.showGrid,
        pollRealtimeToo: state.pollRealtimeToo,
        activeServerId: state.activeServerId,
        activePipelineId: state.activePipelineId,
        inspectorOpen: state.inspectorOpen,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        state.offsetMs = Date.now() - ZOOM_LEVELS_MS[state.zoomIndex] / 2
      },
    },
  ),
)

function zoomIndexFor(zoomMs: number): number {
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  ZOOM_LEVELS_MS.forEach((level, index) => {
    const distance = Math.abs(level - zoomMs)
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  })
  return best
}

export function useViewport(): Viewport {
  const offsetMs = useUiStore((state) => state.offsetMs)
  const zoomIndex = useUiStore((state) => state.zoomIndex)
  const laneWidthPx = useUiStore((state) => state.laneWidthPx)
  return {
    offsetMs,
    zoomMs: ZOOM_LEVELS_MS[zoomIndex] ?? 30 * MINUTES,
    widthPx: laneWidthPx,
  }
}

export { ZOOM_LEVELS_MS, HOUR, MINUTES }
