import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import './index.css'
import { AppRoutes } from './App'
import { ApiError } from '@/lib/api-client'
import { AuthProvider } from '@/hooks/use-auth'
import { Toaster } from '@/components/ui/toaster'
import { TooltipProvider } from '@/components/ui/tooltip'

/**
 * Query defaults (FR-ST-01).
 *
 * `refetchOnWindowFocus` is off: the console runs for hours on a wall display,
 * and refetching the moment an operator alt-tabs would fight the timeline's
 * viewport. Realtime plus the 30s poll is the intended refresh path.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // 4xx is a fact, not a transient fault -- retrying it just delays the
        // message the operator needs to see.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
        return failureCount < 2
      },
    },
    mutations: { retry: false },
  },
})

const container = document.getElementById('root')
if (!container) throw new Error('Root container #root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <TooltipProvider>
          <AuthProvider>
            <div className="h-full">
              <AppRoutes />
            </div>
            <Toaster />
          </AuthProvider>
        </TooltipProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)