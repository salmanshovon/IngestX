/**
 * A single 1 Hz clock shared by the whole app (FR-SH-04, FR-RT-03).
 *
 * One interval, many subscribers. A naive `setInterval` per component would
 * give hundreds of independent timers drifting apart, and the "now" line on the
 * timeline would visibly disagree with the header clock.
 */
import { useEffect, useState } from 'react'

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // Re-align to the wall-clock second so the tick does not drift.
    let interval: number | undefined
    const timeout = window.setTimeout(() => {
      setNow(Date.now())
      interval = window.setInterval(() => setNow(Date.now()), intervalMs)
    }, intervalMs - (Date.now() % intervalMs))

    return () => {
      window.clearTimeout(timeout)
      if (interval) window.clearInterval(interval)
    }
  }, [intervalMs])

  return now
}