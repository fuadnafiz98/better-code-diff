import { useEffect, useRef, useState } from 'react'

const HIDDEN_VIEWER_RELEASE_DELAY_MS = 300_000

// The diff viewer holds worker and highlighter memory, so a window left hidden
// long enough releases it. Short window switches must never lose review state.
export function useViewerSuspension(): boolean {
  const [suspended, setSuspended] = useState(false)
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const clearReleaseTimer = (): void => {
      if (releaseTimerRef.current == null) return
      clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    const handleVisibility = (): void => {
      clearReleaseTimer()
      if (document.hidden) {
        releaseTimerRef.current = setTimeout(() => setSuspended(true), HIDDEN_VIEWER_RELEASE_DELAY_MS)
      } else {
        setSuspended(false)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    handleVisibility()
    return () => {
      clearReleaseTimer()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  return suspended
}
