import { memo, useEffect, useState } from 'react'

import type { PerformanceMetrics } from '../../shared/contracts'

const SAMPLE_INTERVAL_MS = 3_000

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)}%`
}

function formatMemory(megabytes: number): string {
  return megabytes >= 1_024
    ? `${(megabytes / 1_024).toFixed(1)} GB`
    : `${Math.round(megabytes)} MB`
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
    : `${metrics.production ? 'Production' : 'Development'} build. ${metrics.processCount} processes. CPU ${formatPercent(metrics.cpuPercent)}. Total application working set ${formatMemory(metrics.workingSetMegabytes)}. Renderer private memory ${formatMemory(metrics.rendererPrivateMegabytes)}.`

  return (
    <details className="performance-hud">
      <summary aria-label={description} title="Application performance">
        <span className="performance-status" aria-hidden="true">
          <span className={`performance-signal ${metrics?.production ? 'production' : ''}`} />
        </span>
        <span className="performance-metric"><small>CPU</small><strong>{metrics == null ? '—' : formatPercent(metrics.cpuPercent)}</strong></span>
        <span className="performance-metric"><small>GPU</small><strong>{metrics == null ? '—' : formatPercent(metrics.gpuProcessCpuPercent)}</strong></span>
        <span className="performance-memory"><strong>{metrics == null ? '—' : formatMemory(metrics.workingSetMegabytes)}</strong></span>
      </summary>
      <div className="performance-popover">
        <header><strong>Application performance</strong><span className="performance-live">Live</span></header>
        <dl>
          <div><dt>Build</dt><dd>{metrics?.production ? 'Production' : 'Development'}</dd></div>
          <div><dt>Processes</dt><dd>{metrics?.processCount ?? '—'}</dd></div>
          <div><dt>Total app working set</dt><dd>{metrics == null ? '—' : formatMemory(metrics.workingSetMegabytes)}</dd></div>
          <div><dt>Renderer private</dt><dd>{metrics == null ? '—' : formatMemory(metrics.rendererPrivateMegabytes)}</dd></div>
          <div><dt>Renderer V8 heap</dt><dd>{metrics == null ? '—' : `${formatMemory(metrics.rendererHeapUsedMegabytes)} / ${formatMemory(metrics.rendererHeapTotalMegabytes)}`}</dd></div>
          <div><dt>Blink allocated</dt><dd>{metrics == null ? '—' : `${formatMemory(metrics.rendererBlinkAllocatedMegabytes)} / ${formatMemory(metrics.rendererBlinkTotalMegabytes)}`}</dd></div>
          <div><dt>DOM nodes</dt><dd>{metrics?.rendererDomNodes.toLocaleString() ?? '—'}</dd></div>
          <div><dt>Main private</dt><dd>{metrics == null ? '—' : formatMemory(metrics.mainPrivateMegabytes)}</dd></div>
          {metrics?.memoryByProcessType.map((entry) => (
            <div key={entry.type}><dt>{entry.type} working set</dt><dd>{formatMemory(entry.megabytes)}</dd></div>
          ))}
          <div><dt>Measurement</dt><dd>All Electron processes</dd></div>
          <div><dt>Last renderer exit</dt><dd>{metrics?.lastRendererTermination == null ? 'None recorded' : `${metrics.lastRendererTermination.reason} (${metrics.lastRendererTermination.exitCode})`}</dd></div>
          <div><dt>Sample interval</dt><dd>3 seconds</dd></div>
          <div><dt>When hidden</dt><dd>Paused</dd></div>
        </dl>
      </div>
    </details>
  )
})
