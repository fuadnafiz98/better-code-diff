import { memo, useEffect, useMemo, useState } from 'react'

import type { PerformanceMetrics } from '../../shared/contracts'
import { getReviewMetrics, type ReviewMetrics } from './reviewMetrics'
import {
  buildMemorySparkline,
  formatSpan,
  formatTrendPerHour,
  memoryTrendPerHour,
  recordMemorySample,
  type MemorySample
} from './performanceHistory'

const SAMPLE_INTERVAL_MS = 3_000
const CHART_WIDTH = 252
const CHART_HEIGHT = 46
// A leak is a sustained climb, not a spike from opening one big review, so the
// warning tone waits for a rate that would add a gigabyte over a working day.
const LEAK_WARNING_MEGABYTES_PER_HOUR = 120

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
  const [reviewMetrics, setReviewMetrics] = useState<ReviewMetrics>(getReviewMetrics)
  const [history, setHistory] = useState<readonly MemorySample[]>([])

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
            atMs: Date.now(),
            workingSetMegabytes: nextMetrics.workingSetMegabytes,
            rendererPrivateMegabytes: nextMetrics.rendererPrivateMegabytes
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

  const trendPerHour = useMemo(() => memoryTrendPerHour(history), [history])
  const sparkline = useMemo(() => buildMemorySparkline(history, CHART_WIDTH, CHART_HEIGHT), [history])
  const sessionSpanMs = (history[history.length - 1]?.atMs ?? 0) - (history[0]?.atMs ?? 0)
  const leaking = trendPerHour != null && trendPerHour >= LEAK_WARNING_MEGABYTES_PER_HOUR

  const description = metrics == null
    ? 'Collecting application performance metrics'
    : `${metrics.production ? 'Production' : 'Development'} build. ${metrics.processCount} processes. CPU ${formatPercent(metrics.cpuPercent)}. Total application working set ${formatMemory(metrics.workingSetMegabytes)}. Renderer private memory ${formatMemory(metrics.rendererPrivateMegabytes)}.`

  return (
    <details className="performance-hud">
      {/* No `title`: the OS tooltip rendered on top of the panel it opens, and the
          panel already names itself. */}
      <summary aria-label={description}>
        <span className={`performance-signal ${metrics?.production ? 'production' : ''}`} aria-hidden="true" />
        <span className="performance-metric"><small>CPU</small><strong>{metrics == null ? '—' : formatPercent(metrics.cpuPercent)}</strong></span>
        <span className="performance-metric"><small>GPU</small><strong>{metrics == null ? '—' : formatPercent(metrics.gpuProcessCpuPercent)}</strong></span>
        <span className="performance-memory"><strong>{metrics == null ? '—' : formatMemory(metrics.workingSetMegabytes)}</strong></span>
      </summary>
      <div className="performance-popover">
        <header>
          <strong>Performance</strong>
          <span className="performance-live">Live</span>
        </header>

        {/* The number the panel exists to answer leads, at a size the rows cannot
            compete with, so the rest reads as its breakdown. */}
        <div className="performance-headline">
          <span className="performance-headline-value">
            {metrics == null ? '—' : formatMemory(metrics.workingSetMegabytes)}
          </span>
          <span className="performance-headline-label">
            Total working set
            <small>{metrics == null ? 'Sampling…' : `${metrics.processCount} processes · ${metrics.production ? 'production' : 'development'}`}</small>
          </span>
        </div>

        {/* Working set over the session: the shape answers "is this leaking?",
            which no single reading can. */}
        <section className="performance-group performance-chart">
          <h3>Memory over time<span className={`performance-trend ${leaking ? 'warning' : ''}`}>{formatTrendPerHour(trendPerHour)}</span></h3>
          {sparkline == null ? (
            <p className="performance-chart-empty">Sampling — the trend appears after a few minutes.</p>
          ) : (
            <>
              <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" role="img"
                aria-label={`Working set from ${formatMemory(sparkline.low)} to ${formatMemory(sparkline.high)} over ${formatSpan(sessionSpanMs)}, trending ${formatTrendPerHour(trendPerHour)}`}>
                <path className="performance-chart-area" d={sparkline.area} />
                <path className="performance-chart-line" d={sparkline.line} />
              </svg>
              <div className="performance-chart-axis">
                <span>{formatMemory(sparkline.low)} low</span>
                <span>{formatSpan(sessionSpanMs)}</span>
                <span>{formatMemory(sparkline.high)} peak</span>
              </div>
            </>
          )}
        </section>

        <section className="performance-group">
          <h3>Memory</h3>
          <dl>
            <div><dt>Renderer private</dt><dd>{metrics == null ? '—' : formatMemory(metrics.rendererPrivateMegabytes)}</dd></div>
            <div><dt>Main private</dt><dd>{metrics == null ? '—' : formatMemory(metrics.mainPrivateMegabytes)}</dd></div>
            <div><dt>V8 heap</dt><dd>{metrics == null ? '—' : `${formatMemory(metrics.rendererHeapUsedMegabytes)} / ${formatMemory(metrics.rendererHeapTotalMegabytes)}`}</dd></div>
            <div><dt>Blink</dt><dd>{metrics == null ? '—' : `${formatMemory(metrics.rendererBlinkAllocatedMegabytes)} / ${formatMemory(metrics.rendererBlinkTotalMegabytes)}`}</dd></div>
          </dl>
        </section>

        <section className="performance-group">
          <h3>Review</h3>
          <dl>
            <div><dt>Files loaded</dt><dd>{reviewMetrics.loadedItems.toLocaleString()}</dd></div>
            <div><dt>Files hydrated</dt><dd>{reviewMetrics.hydratedFiles.toLocaleString()}</dd></div>
            <div><dt>Workspace renders</dt><dd>{reviewMetrics.workspaceRenders.toLocaleString()}</dd></div>
            <div><dt>Agent stream events</dt><dd>{reviewMetrics.agentStreamEvents.toLocaleString()}</dd></div>
            <div><dt>DOM nodes</dt><dd>{metrics?.rendererDomNodes.toLocaleString() ?? '—'}</dd></div>
          </dl>
        </section>

        {metrics != null && metrics.memoryByProcessType.length > 0 ? (
          <section className="performance-group">
            <h3>Processes</h3>
            <dl>
              {metrics.memoryByProcessType.map((entry) => (
                <div key={entry.type}><dt>{entry.type}</dt><dd>{formatMemory(entry.megabytes)}</dd></div>
              ))}
            </dl>
          </section>
        ) : null}

        <footer className="performance-footnote">
          Every Electron process, sampled every 3s, paused while hidden.
          {metrics?.lastRendererTermination == null
            ? null
            : ` Last renderer exit: ${metrics.lastRendererTermination.reason} (${metrics.lastRendererTermination.exitCode}).`}
        </footer>
      </div>
    </details>
  )
})
