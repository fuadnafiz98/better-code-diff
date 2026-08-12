import { memo, useEffect, useState } from 'react'

import type { PerformanceMetrics } from '../../shared/contracts'

const SAMPLE_INTERVAL_MS = 1_500

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)}%`
}

function formatMemory(megabytes: number): string {
  return megabytes >= 1_024
    ? `${(megabytes / 1_024).toFixed(1)}G`
    : `${Math.round(megabytes)}M`
}

export const PerformanceHud = memo(function PerformanceHud(): React.JSX.Element {
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null)

  useEffect(() => {
    const repository = window.repository
    if (repository == null) return
    let disposed = false
    let timeout: number | null = null

    const scheduleSample = (): void => {
      if (disposed || document.hidden) return
      timeout = window.setTimeout(sample, SAMPLE_INTERVAL_MS)
    }

    const sample = async (): Promise<void> => {
      if (disposed || document.hidden) return
      try {
        const nextMetrics = await repository.getPerformanceMetrics()
        if (!disposed) setMetrics(nextMetrics)
      } catch {
        if (!disposed) setMetrics(null)
      } finally {
        scheduleSample()
      }
    }

    const handleVisibilityChange = (): void => {
      if (timeout != null) window.clearTimeout(timeout)
      timeout = null
      if (!document.hidden) void sample()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    void sample()
    return () => {
      disposed = true
      if (timeout != null) window.clearTimeout(timeout)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  const description = metrics == null
    ? 'Collecting application performance metrics'
    : `${metrics.production ? 'Production' : 'Development'} build. ${metrics.processCount} processes. CPU ${formatPercent(metrics.cpuPercent)}. GPU process CPU ${formatPercent(metrics.gpuProcessCpuPercent)}. Memory working set ${formatMemory(metrics.memoryMegabytes)}.`

  return (
    <div className="performance-hud" aria-label={description} title={description}>
      <span className={`performance-build ${metrics?.production ? 'production' : ''}`}>{metrics?.production ? 'P' : 'D'}</span>
      <span><small>CPU</small><strong>{metrics == null ? '—' : formatPercent(metrics.cpuPercent)}</strong></span>
      <span><small>GPU</small><strong>{metrics == null ? '—' : formatPercent(metrics.gpuProcessCpuPercent)}</strong></span>
      <span><small>MEM</small><strong>{metrics == null ? '—' : formatMemory(metrics.memoryMegabytes)}</strong></span>
    </div>
  )
})
