/**
 * Realtime channel consumer (FR-RT-01 .. FR-RT-06).
 *
 * Backed by the Django Channels WebSocket at /ws/realtime/. The channel is
 * server-to-browser and **strictly optional** -- if it never connects the SPA
 * still polls and loses no correctness.
 */
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { RealtimeStatus } from '@/api/types'
import { REALTIME_PATH } from '@/config'
import { useAuth } from './use-auth'

export function useRealtime(): RealtimeStatus {
  const { isAuthenticated } = useAuth()
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<RealtimeStatus>('offline')

  const clientRef = useRef(queryClient)
  useEffect(() => { clientRef.current = queryClient }, [queryClient])

  useEffect(() => {
    if (!isAuthenticated) {
      setStatus('offline')
      return
    }

    let socket: WebSocket | null = null
    let retryTimer: number | undefined
    let attempt = 0
    let closed = false

    const connect = () => {
      if (closed) return
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting')

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = `${proto}//${window.location.host}${REALTIME_PATH}`
      socket = new WebSocket(url)

      socket.onopen = () => {
        attempt = 0
        setStatus('connected')
      }

      socket.onmessage = (event) => {
        try {
          JSON.parse(event.data)
        } catch {
          return
        }
        // Invalidate everything on any recording event; keeps UI in sync.
        clientRef.current.invalidateQueries()
      }

      socket.onclose = () => {
        socket = null
        if (closed) return
        attempt += 1
        setStatus('reconnecting')
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5))
        retryTimer = window.setTimeout(connect, delay)
      }

      socket.onerror = () => {
        socket?.close()
      }
    }

    connect()

    return () => {
      closed = true
      if (retryTimer) window.clearTimeout(retryTimer)
      socket?.close()
    }
  }, [isAuthenticated])

  return status
}