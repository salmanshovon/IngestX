/**
 * Toast + banner notifications (FR-SH-07, FR-NF-01).
 *
 * Zustand rather than context: a toast must be raisable from a React Query
 * `onError` deep in a mutation, and threading a context through every hook for
 * that is ceremony. The Radix Toast viewport reads this store directly.
 */
import { create } from 'zustand'

export type ToastTone = 'success' | 'error' | 'warning' | 'info'

export interface Toast {
  id: string
  tone: ToastTone
  title: string
  description?: string
  /** Milliseconds before auto-dismiss. `null` keeps it until dismissed. */
  duration: number | null
  action?: { label: string; onClick: () => void }
}

export interface Banner {
  id: string
  tone: Exclude<ToastTone, 'success'>
  title: string
  description?: string
  dismissible: boolean
}

interface NotificationState {
  toasts: Toast[]
  banners: Banner[]
  push: (toast: Omit<Toast, 'id' | 'duration'> & { duration?: number | null }) => string
  dismiss: (id: string) => void
  pushBanner: (banner: Omit<Banner, 'id'>) => string
  dismissBanner: (id: string) => void
  clearBanners: () => void
}

let counter = 0
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
}

export const useNotifications = create<NotificationState>((set) => ({
  toasts: [],
  banners: [],

  push: (toast) => {
    const id = nextId('toast')
    const duration = toast.duration === undefined ? 4000 : toast.duration
    set((state) => ({
      // Cap the stack: a burst of failures must not bury the screen.
      toasts: [...state.toasts.slice(-4), { ...toast, id, duration }],
    }))
    return id
  },

  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  pushBanner: (banner) => {
    const id = nextId('banner')
    // Same id twice = same condition, so a re-render does not stack duplicates.
    set((state) => ({
      banners: state.banners.some((existing) => existing.title === banner.title)
        ? state.banners
        : [...state.banners, { ...banner, id }],
    }))
    return id
  },

  dismissBanner: (id) => set((state) => ({ banners: state.banners.filter((b) => b.id !== id) })),

  clearBanners: () => set({ banners: [] }),
}))

/** Imperative helpers so non-React code (mutation callbacks) can raise them. */
export const notify = {
  success: (title: string, description?: string) =>
    useNotifications.getState().push({ tone: 'success', title, description }),
  error: (title: string, description?: string, action?: Toast['action']) =>
    useNotifications.getState().push({ tone: 'error', title, description, action, duration: 7000 }),
  warning: (title: string, description?: string, action?: Toast['action']) =>
    useNotifications.getState().push({ tone: 'warning', title, description, action, duration: 8000 }),
  info: (title: string, description?: string) =>
    useNotifications.getState().push({ tone: 'info', title, description }),
}

export const banner = {
  show: (input: Omit<Banner, 'id'>) => useNotifications.getState().pushBanner(input),
  dismiss: (id: string) => useNotifications.getState().dismissBanner(id),
  clear: () => useNotifications.getState().clearBanners(),
}