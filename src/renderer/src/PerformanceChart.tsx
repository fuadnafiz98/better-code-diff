import { memo, useId, useMemo, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'

import {
  buildPerformanceChart,
  findNearestSampleIndex,
  formatPerformanceMemory,
  formatPerformancePercent,
  formatSpan,
  formatTrendPerHour,
  memoryTrendPerHour,
  type MemorySample,
  type PerformanceChartMetric
} from './performanceHistory'

const CHART_WIDTH = 400
const CHART_HEIGHT = 136
const LEAK_WARNING_MEGABYTES_PER_HOUR = 120
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit'
})

type TooltipStyle = CSSProperties & {
  '--performance-tooltip-x': string
}

function formatChartValue(value: number, metric: PerformanceChartMetric): string {
  return metric === 'memory' ? formatPerformanceMemory(value) : formatPerformancePercent(value)
}

function sampleValue(sample: MemorySample, metric: PerformanceChartMetric, secondary = false): number | null {
  if (metric === 'memory') {
    return secondary ? sample.rendererPrivateMegabytes : sample.workingSetMegabytes
  }
  return secondary ? sample.gpuProcessCpuPercent ?? null : sample.cpuPercent ?? null
}

interface PerformanceChartProps {
  history: readonly MemorySample[]
}

export const PerformanceChart = memo(function PerformanceChart({ history }: PerformanceChartProps): React.JSX.Element {
  const [metric, setMetric] = useState<PerformanceChartMetric>('memory')
  const [metricInput, setMetricInput] = useState<'keyboard' | 'pointer'>('pointer')
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [keyboardExploring, setKeyboardExploring] = useState(false)
  const gradientId = useId().replaceAll(':', '')
  const trendPerHour = useMemo(() => memoryTrendPerHour(history), [history])
  const chart = useMemo(() => buildPerformanceChart(history, metric, CHART_WIDTH, CHART_HEIGHT), [history, metric])
  const firstSample = history[0]
  const latestSample = history[history.length - 1]
  const inspectedSample = activeIndex == null ? null : history[activeIndex] ?? null
  const displayedSample = inspectedSample ?? latestSample
  const sessionSpanMs = (latestSample?.atMs ?? 0) - (firstSample?.atMs ?? 0)
  const primaryLabel = metric === 'memory' ? 'Total' : 'App CPU'
  const secondaryLabel = metric === 'memory' ? 'Renderer' : 'GPU'
  const primaryValue = displayedSample == null ? null : sampleValue(displayedSample, metric)
  const secondaryValue = displayedSample == null ? null : sampleValue(displayedSample, metric, true)
  const leaking = trendPerHour != null && trendPerHour >= LEAK_WARNING_MEGABYTES_PER_HOUR

  const setPointFromPointer = (event: PointerEvent<HTMLDivElement>): void => {
    if (chart == null || firstSample == null || latestSample == null) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const svgX = ((event.clientX - bounds.left) / bounds.width) * CHART_WIDTH
    const ratio = Math.max(0, Math.min(1, (svgX - chart.plotLeft) / (chart.plotRight - chart.plotLeft)))
    const atMs = firstSample.atMs + ratio * (latestSample.atMs - firstSample.atMs)
    setKeyboardExploring(false)
    setActiveIndex(findNearestSampleIndex(history, atMs))
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (history.length === 0) return
    let nextIndex = activeIndex ?? history.length - 1
    if (event.key === 'ArrowLeft') nextIndex = Math.max(0, nextIndex - 1)
    else if (event.key === 'ArrowRight') nextIndex = Math.min(history.length - 1, nextIndex + 1)
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = history.length - 1
    else return
    event.preventDefault()
    setKeyboardExploring(true)
    setActiveIndex(nextIndex)
  }

  const primaryPoint = activeIndex == null ? null : chart?.primary.points[activeIndex] ?? null
  const secondaryPoint = activeIndex == null ? null : chart?.secondary.points[activeIndex] ?? null
  const tooltipStyle = primaryPoint == null
    ? undefined
    : { '--performance-tooltip-x': `${(primaryPoint.x / CHART_WIDTH) * 100}%` } as TooltipStyle

  return (
    <section className="performance-chart-panel" aria-labelledby="performance-chart-title">
      <div className="performance-chart-header">
        <div className="performance-chart-reading">
          <p id="performance-chart-title">Session trend</p>
          <div>
            <strong>{primaryValue == null ? '—' : formatChartValue(primaryValue, metric)}</strong>
            <span>{inspectedSample == null ? 'Latest sample' : timeFormatter.format(inspectedSample.atMs)}</span>
          </div>
        </div>
        <div className="performance-chart-tabs" role="group" aria-label="Chart metric" data-input={metricInput}>
          {(['memory', 'cpu'] as const).map((chartMetric) => (
            <button
              key={chartMetric}
              type="button"
              aria-pressed={metric === chartMetric}
              onPointerDown={() => setMetricInput('pointer')}
              onKeyDown={() => setMetricInput('keyboard')}
              onClick={() => {
                setMetric(chartMetric)
                setActiveIndex(null)
              }}
            >
              {chartMetric === 'memory' ? 'Memory' : 'CPU'}
            </button>
          ))}
        </div>
      </div>

      <div className="performance-chart-legend" aria-hidden="true">
        <span className="primary">{primaryLabel}</span>
        <span className="secondary">{secondaryLabel}</span>
        <span className={`performance-trend ${leaking ? 'warning' : ''}`}>
          {metric === 'memory' ? formatTrendPerHour(trendPerHour) : `${history.length} samples`}
        </span>
      </div>

      {chart == null || firstSample == null || latestSample == null ? (
        <div className="performance-chart-empty">
          <span aria-hidden="true" />
          <p>Building the session timeline.</p>
          <small>The first trend appears after two samples.</small>
        </div>
      ) : (
        <div
          id="performance-chart"
          className="performance-chart-stage"
          tabIndex={0}
          role="group"
          aria-label={`Interactive ${metric} chart over ${formatSpan(sessionSpanMs)}. Use the left and right arrow keys to inspect samples.`}
          onPointerMove={setPointFromPointer}
          onPointerLeave={() => {
            if (!keyboardExploring) setActiveIndex(null)
          }}
          onFocus={() => {
            setKeyboardExploring(true)
            setActiveIndex((current) => current ?? history.length - 1)
          }}
          onBlur={() => {
            setKeyboardExploring(false)
            setActiveIndex(null)
          }}
          onKeyDown={handleKeyDown}
        >
          <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id={`${gradientId}-fill`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" className="performance-chart-fill-start" />
                <stop offset="1" className="performance-chart-fill-end" />
              </linearGradient>
              <clipPath id={`${gradientId}-clip`}>
                <rect x={chart.plotLeft} y={chart.plotTop} width={chart.plotRight - chart.plotLeft} height={chart.plotBottom - chart.plotTop} />
              </clipPath>
            </defs>

            {chart.gridValues.map((value) => {
              const y = chart.plotBottom - ((value - chart.domainLow) / (chart.domainHigh - chart.domainLow)) * (chart.plotBottom - chart.plotTop)
              return (
                <g key={value} className="performance-chart-grid">
                  <line x1={chart.plotLeft} x2={chart.plotRight} y1={y} y2={y} />
                  <text x={chart.plotLeft - 7} y={y + 3} textAnchor="end">{formatChartValue(value, metric)}</text>
                </g>
              )
            })}

            <g clipPath={`url(#${gradientId}-clip)`}>
              <path className="performance-chart-area" d={`${chart.primary.path}L${chart.plotRight},${chart.plotBottom}L${chart.plotLeft},${chart.plotBottom}Z`} fill={`url(#${gradientId}-fill)`} />
              <path className="performance-chart-line secondary" d={chart.secondary.path} pathLength="1" />
              <path className="performance-chart-line primary" d={chart.primary.path} pathLength="1" />
            </g>

            <g className="performance-chart-time-axis">
              <text x={chart.plotLeft} y={CHART_HEIGHT - 4}>{timeFormatter.format(firstSample.atMs)}</text>
              <text x={(chart.plotLeft + chart.plotRight) / 2} y={CHART_HEIGHT - 4} textAnchor="middle">{formatSpan(sessionSpanMs)}</text>
              <text x={chart.plotRight} y={CHART_HEIGHT - 4} textAnchor="end">Now</text>
            </g>

            {primaryPoint != null && secondaryPoint != null ? (
              <g className="performance-chart-inspector">
                <line x1={primaryPoint.x} x2={primaryPoint.x} y1={chart.plotTop} y2={chart.plotBottom} />
                <circle className="secondary" cx={secondaryPoint.x} cy={secondaryPoint.y} r="3" />
                <circle className="primary" cx={primaryPoint.x} cy={primaryPoint.y} r="3.5" />
              </g>
            ) : null}
          </svg>

          {inspectedSample != null && primaryPoint != null ? (
            <div className={`performance-chart-tooltip ${primaryPoint.x > CHART_WIDTH * 0.67 ? 'align-right' : ''}`} style={tooltipStyle} aria-hidden="true">
              <time dateTime={new Date(inspectedSample.atMs).toISOString()}>{timeFormatter.format(inspectedSample.atMs)}</time>
              <dl>
                <div className="primary"><dt>{primaryLabel}</dt><dd>{primaryValue == null ? '—' : formatChartValue(primaryValue, metric)}</dd></div>
                <div className="secondary"><dt>{secondaryLabel}</dt><dd>{secondaryValue == null ? '—' : formatChartValue(secondaryValue, metric)}</dd></div>
              </dl>
            </div>
          ) : null}
          <p className="sr-only" aria-live="polite">
            {keyboardExploring && inspectedSample != null
              ? `${timeFormatter.format(inspectedSample.atMs)}. ${primaryLabel} ${primaryValue == null ? 'unavailable' : formatChartValue(primaryValue, metric)}. ${secondaryLabel} ${secondaryValue == null ? 'unavailable' : formatChartValue(secondaryValue, metric)}.`
              : ''}
          </p>
        </div>
      )}
    </section>
  )
})
