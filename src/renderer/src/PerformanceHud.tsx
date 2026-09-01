import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { IconCiWarningFill } from '@pierre/icons'

import type { PerformanceMetrics } from '../../shared/contracts'
import {
  formatPerformanceMemory,
  formatPerformancePercent,
  getMemorySamples,
  recordMemorySample
} from './performanceHistory'
import { getReviewMetrics, type ReviewMetrics } from './reviewMetrics'
import { isHighMemory } from './performanceHealth'
import { getRendererStartupMetrics } from './startupMetrics'

const PerformanceChart = lazy(async () => ({
  default: (await import('./PerformanceChart')).PerformanceChart
}))

// The lightweight sample uses Electron's in-process app metrics. Keep it fast
// enough to catch a short memory spike; expensive process detail remains gated
// behind the open Diagnostics disclosure.
const SAMPLE_INTERVAL_OPEN_MS = 2_000
const SAMPLE_INTERVAL_COLLAPSED_MS = 15_000
const SAMPLE_TIMEOUT_MS = 5_000
const sampledTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit'
})

type SamplingStatus = 'sampling' | 'live' | 'unavailable'

type ProcessStyle = CSSProperties & {
  '--performance-process-share': number
}

function sameReviewMetrics(left: ReviewMetrics, right: ReviewMetrics): boolean {
  return left.loadedItems === right.loadedItems &&
    left.hydratedFiles === right.hydratedFiles &&
    left.workspaceRenders === right.workspaceRenders &&
    left.agentStreamEvents === right.agentStreamEvents
}

function formatStartupTiming(milliseconds: number | null | undefined): string {
  return milliseconds == null ? '—' : `${Math.round(milliseconds)} ms`
}

export const PerformanceHud = memo(function PerformanceHud(): React.JSX.Element {
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null)
  const [reviewMetrics, setReviewMetrics] = useState<ReviewMetrics>(getReviewMetrics)
  const reviewMetricsRef = useRef(reviewMetrics)
  const history = getMemorySamples()
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [samplingStatus, setSamplingStatus] = useState<SamplingStatus>('sampling')

  useEffect(() => {
    const repository = window.repository
    if (repository == null) return
    let disposed = false
    let timeout: number | null = null
    const intervalMs = popoverOpen ? SAMPLE_INTERVAL_OPEN_MS : SAMPLE_INTERVAL_COLLAPSED_MS
    // The inner disclosure keeps its own open state when the popover collapses
    // around it, so both have to be open before the detail is worth collecting.
    const detailed = popoverOpen && diagnosticsOpen

    const scheduleSample = (): void => {
      if (disposed || document.hidden) return
      timeout = window.setTimeout(sample, intervalMs)
    }

    const sample = async (): Promise<void> => {
      if (disposed || document.hidden) return
      let sampleTimeout: number | null = null
      try {
        const nextMetrics = await Promise.race([
          repository.getPerformanceMetrics(detailed),
          new Promise<never>((_resolve, reject) => {
            sampleTimeout = window.setTimeout(() => reject(new Error('Performance sample timed out.')), SAMPLE_TIMEOUT_MS)
          })
        ])
        if (!disposed) {
          setMetrics(nextMetrics)
          setSamplingStatus('live')
          recordMemorySample({
            atMs: nextMetrics.sampledAt,
            workingSetMegabytes: nextMetrics.workingSetMegabytes,
            rendererPrivateMegabytes: nextMetrics.rendererPrivateMegabytes,
            cpuPercent: nextMetrics.cpuPercent,
            gpuProcessCpuPercent: nextMetrics.gpuProcessCpuPercent
          })
        }
      } catch {
        if (!disposed) setSamplingStatus('unavailable')
      } finally {
        if (sampleTimeout != null) window.clearTimeout(sampleTimeout)
        if (!disposed) {
          const nextReviewMetrics = getReviewMetrics()
          if (!sameReviewMetrics(reviewMetricsRef.current, nextReviewMetrics)) {
            reviewMetricsRef.current = nextReviewMetrics
            setReviewMetrics(nextReviewMetrics)
          }
        }
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
  }, [diagnosticsOpen, popoverOpen])

  const highMemory = isHighMemory(metrics?.workingSetMegabytes)
  const description = metrics == null
    ? 'Collecting application performance metrics.'
    : `${metrics.production ? 'Production' : 'Development'} build. ${metrics.processCount} processes. CPU ${formatPerformancePercent(metrics.cpuPercent)}. Total application working set ${formatPerformanceMemory(metrics.workingSetMegabytes)}.${highMemory ? ' High memory warning.' : ''}`
  const detail = metrics?.detail ?? null
  const rendererStartup = getRendererStartupMetrics()
  const processPeak = Math.max(1, ...(detail?.memoryByProcessType.map((entry) => entry.megabytes) ?? []))
  const statusLabel = samplingStatus === 'live'
    ? 'Live'
    : samplingStatus === 'sampling'
      ? 'Sampling'
      : metrics == null ? 'Unavailable' : 'Stale'

  return (
    <details className="performance-hud" onToggle={(event) => setPopoverOpen(event.currentTarget.open)}>
      <summary aria-label={description}>
        <span className={`performance-signal ${metrics?.production ? 'production' : ''} ${highMemory ? 'high-memory' : ''}`} aria-hidden="true" />
        <span className="performance-metric"><small>CPU</small><strong>{formatPerformancePercent(metrics?.cpuPercent)}</strong></span>
        <span className="performance-metric"><small>GPU</small><strong>{formatPerformancePercent(metrics?.gpuProcessCpuPercent)}</strong></span>
        <span className={`performance-memory ${highMemory ? 'high-memory' : ''}`}
          title={highMemory ? 'Working set is above 1 GB' : undefined}>
          {highMemory ? <IconCiWarningFill aria-hidden="true" /> : null}
          <strong>{metrics == null ? '—' : formatPerformanceMemory(metrics.workingSetMegabytes)}</strong>
        </span>
      </summary>

      <div className="performance-popover">
        <header className="performance-popover-header">
          <span>
            <strong>Performance</strong>
            <small>{metrics == null ? 'Detecting build' : metrics.production ? 'Production build' : 'Development build'}</small>
          </span>
          <span className={`performance-live ${samplingStatus}`}>
            <span>{statusLabel}</span>
            {metrics == null ? null : <time dateTime={new Date(metrics.sampledAt).toISOString()}>{sampledTimeFormatter.format(metrics.sampledAt)}</time>}
          </span>
        </header>

        <div className="performance-popover-body">
          <dl className="performance-kpis">
            <div><dt>App CPU</dt><dd>{formatPerformancePercent(metrics?.cpuPercent)}</dd><small>All processes</small></div>
            <div><dt>GPU</dt><dd>{formatPerformancePercent(metrics?.gpuProcessCpuPercent)}</dd><small>Graphics process</small></div>
            <div className={highMemory ? 'high-memory' : undefined}><dt>Working set</dt><dd>{metrics == null ? '—' : formatPerformanceMemory(metrics.workingSetMegabytes)}</dd><small>{metrics == null ? 'Sampling…' : highMemory ? `High · ${metrics.processCount} processes` : `${metrics.processCount} processes`}</small></div>
          </dl>

          {popoverOpen ? <Suspense fallback={null}>
            <PerformanceChart history={history} historyVersion={metrics?.sampledAt} />
          </Suspense> : null}

          <details className="performance-diagnostics" onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}>
            <summary>
              <span>
                <strong>Diagnostics</strong>
                <small>Runtime · Activity · Processes</small>
              </span>
            </summary>

            {diagnosticsOpen ? (
              <div className="performance-diagnostics-content">
                <div className="performance-details-grid">
                  <section className="performance-group">
                    <h3>Runtime</h3>
                    <dl>
                      <div><dt>Renderer private</dt><dd>{metrics == null ? '—' : formatPerformanceMemory(metrics.rendererPrivateMegabytes)}</dd></div>
                      <div><dt>Main private</dt><dd>{detail == null ? '—' : formatPerformanceMemory(detail.mainPrivateMegabytes)}</dd></div>
                      <div><dt>V8 heap</dt><dd>{detail == null ? '—' : `${formatPerformanceMemory(detail.rendererHeapUsedMegabytes)} / ${formatPerformanceMemory(detail.rendererHeapTotalMegabytes)}`}</dd></div>
                      <div><dt>DOM nodes</dt><dd>{detail?.rendererDomNodes.toLocaleString() ?? '—'}</dd></div>
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

                  <section className="performance-group">
                    <h3>Main startup</h3>
                    <dl>
                      <div><dt>App ready</dt><dd>{formatStartupTiming(detail?.mainStartup.appReady)}</dd></div>
                      <div><dt>Window created</dt><dd>{formatStartupTiming(detail?.mainStartup.windowCreated)}</dd></div>
                      <div><dt>Restore settled</dt><dd>{formatStartupTiming(detail?.mainStartup.restoreSettled)}</dd></div>
                    </dl>
                  </section>

                  <section className="performance-group">
                    <h3>Renderer startup</h3>
                    <dl>
                      <div><dt>Renderer loaded</dt><dd>{formatStartupTiming(rendererStartup.rendererLoaded)}</dd></div>
                      <div><dt>React committed</dt><dd>{formatStartupTiming(rendererStartup.reactCommitted)}</dd></div>
                      <div><dt>Snapshot ready</dt><dd>{formatStartupTiming(rendererStartup.snapshotReady)}</dd></div>
                      <div><dt>Explorer committed</dt><dd>{formatStartupTiming(rendererStartup.explorerCommitted)}</dd></div>
                      <div><dt>Viewer committed</dt><dd>{formatStartupTiming(rendererStartup.viewerCommitted)}</dd></div>
                    </dl>
                  </section>
                </div>

                {detail != null && detail.memoryByProcessType.length > 0 ? (
                  <section className="performance-processes">
                    <h3>Working set by process</h3>
                    <ul role="list">
                      {detail.memoryByProcessType.map((entry) => (
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
                  Samples every {SAMPLE_INTERVAL_OPEN_MS / 1_000} seconds while this popover is open, every {SAMPLE_INTERVAL_COLLAPSED_MS / 1_000} while it is closed.
                  {metrics?.lastRendererTermination == null
                    ? null
                    : ` Last renderer exit: ${metrics.lastRendererTermination.reason} (${metrics.lastRendererTermination.exitCode}).`}
                </footer>
              </div>
            ) : null}
          </details>
        </div>
      </div>
    </details>
  )
})
