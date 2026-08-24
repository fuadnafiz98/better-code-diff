import { memo, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

import type { PerformanceMetrics } from '../../shared/contracts'
import { PerformanceChart } from './PerformanceChart'
import {
  formatPerformanceMemory,
  formatPerformancePercent,
  getMemorySamples,
  recordMemorySample,
  type MemorySample
} from './performanceHistory'
import { getReviewMetrics, type ReviewMetrics } from './reviewMetrics'

const SAMPLE_INTERVAL_MS = 3_000

type ProcessStyle = CSSProperties & {
  '--performance-process-share': number
}

export const PerformanceHud = memo(function PerformanceHud(): React.JSX.Element {
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null)
  const [reviewMetrics, setReviewMetrics] = useState<ReviewMetrics>(getReviewMetrics)
  const [history, setHistory] = useState<readonly MemorySample[]>(getMemorySamples)

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
        if (!disposed) {
          setMetrics(nextMetrics)
          setHistory([...recordMemorySample({
            atMs: nextMetrics.sampledAt,
            workingSetMegabytes: nextMetrics.workingSetMegabytes,
            rendererPrivateMegabytes: nextMetrics.rendererPrivateMegabytes,
            cpuPercent: nextMetrics.cpuPercent,
            gpuProcessCpuPercent: nextMetrics.gpuProcessCpuPercent
          })])
        }
      } catch {
        if (!disposed) setMetrics(null)
      } finally {
        if (!disposed) setReviewMetrics(getReviewMetrics())
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
    ? 'Collecting application performance metrics.'
    : `${metrics.production ? 'Production' : 'Development'} build. ${metrics.processCount} processes. CPU ${formatPerformancePercent(metrics.cpuPercent)}. Total application working set ${formatPerformanceMemory(metrics.workingSetMegabytes)}.`
  const processPeak = Math.max(1, ...(metrics?.memoryByProcessType.map((entry) => entry.megabytes) ?? []))

  return (
    <details className="performance-hud">
      <summary aria-label={description}>
        <span className={`performance-signal ${metrics?.production ? 'production' : ''}`} aria-hidden="true" />
        <span className="performance-metric"><small>CPU</small><strong>{formatPerformancePercent(metrics?.cpuPercent)}</strong></span>
        <span className="performance-metric"><small>GPU</small><strong>{formatPerformancePercent(metrics?.gpuProcessCpuPercent)}</strong></span>
        <span className="performance-memory"><strong>{metrics == null ? '—' : formatPerformanceMemory(metrics.workingSetMegabytes)}</strong></span>
      </summary>

      <div className="performance-popover">
        <header className="performance-popover-header">
          <span>
            <strong>Performance</strong>
            <small>{metrics?.production ? 'Production build' : 'Development build'}</small>
          </span>
          <span className="performance-live">Live</span>
        </header>

        <div className="performance-popover-body">
          <dl className="performance-kpis">
            <div><dt>App CPU</dt><dd>{formatPerformancePercent(metrics?.cpuPercent)}</dd><small>All processes</small></div>
            <div><dt>GPU</dt><dd>{formatPerformancePercent(metrics?.gpuProcessCpuPercent)}</dd><small>Graphics process</small></div>
            <div><dt>Working set</dt><dd>{metrics == null ? '—' : formatPerformanceMemory(metrics.workingSetMegabytes)}</dd><small>{metrics == null ? 'Sampling…' : `${metrics.processCount} processes`}</small></div>
          </dl>

          <PerformanceChart history={history} />

          <details className="performance-diagnostics">
            <summary>
              <span>
                <strong>Diagnostics</strong>
                <small>Runtime · Activity · Processes</small>
              </span>
            </summary>

            <div className="performance-diagnostics-content">
              <div className="performance-details-grid">
                <section className="performance-group">
                  <h3>Runtime</h3>
                  <dl>
                    <div><dt>Renderer private</dt><dd>{metrics == null ? '—' : formatPerformanceMemory(metrics.rendererPrivateMegabytes)}</dd></div>
                    <div><dt>Main private</dt><dd>{metrics == null ? '—' : formatPerformanceMemory(metrics.mainPrivateMegabytes)}</dd></div>
                    <div><dt>V8 heap</dt><dd>{metrics == null ? '—' : `${formatPerformanceMemory(metrics.rendererHeapUsedMegabytes)} / ${formatPerformanceMemory(metrics.rendererHeapTotalMegabytes)}`}</dd></div>
                    <div><dt>DOM nodes</dt><dd>{metrics?.rendererDomNodes.toLocaleString() ?? '—'}</dd></div>
                  </dl>
                </section>

                <section className="performance-group">
                  <h3>Review activity</h3>
                  <dl>
                    <div><dt>Files loaded</dt><dd>{reviewMetrics.loadedItems.toLocaleString()}</dd></div>
                    <div><dt>Files hydrated</dt><dd>{reviewMetrics.hydratedFiles.toLocaleString()}</dd></div>
                    <div><dt>Workspace renders</dt><dd>{reviewMetrics.workspaceRenders.toLocaleString()}</dd></div>
                    <div><dt>Agent events</dt><dd>{reviewMetrics.agentStreamEvents.toLocaleString()}</dd></div>
                  </dl>
                </section>
              </div>

              {metrics != null && metrics.memoryByProcessType.length > 0 ? (
                <section className="performance-processes">
                  <h3>Working set by process</h3>
                  <ul role="list">
                    {metrics.memoryByProcessType.map((entry) => (
                      <li key={entry.type}>
                        <span>{entry.type}</span>
                        <span className="performance-process-track" aria-hidden="true">
                          <span style={{ '--performance-process-share': entry.megabytes / processPeak } as ProcessStyle} />
                        </span>
                        <strong>{formatPerformanceMemory(entry.megabytes)}</strong>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <footer className="performance-footnote">
                Samples every 3 seconds while this window is visible.
                {metrics?.lastRendererTermination == null
                  ? null
                  : ` Last renderer exit: ${metrics.lastRendererTermination.reason} (${metrics.lastRendererTermination.exitCode}).`}
              </footer>
            </div>
          </details>
        </div>
      </div>
    </details>
  )
})
