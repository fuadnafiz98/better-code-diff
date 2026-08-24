export interface MemorySample {
  atMs: number
  workingSetMegabytes: number
  rendererPrivateMegabytes: number
}

// 3s sampling, so this is an hour of history — long enough to see a leak trend
// without holding the samples of a whole workday.
const MAX_SAMPLES = 1_200
// Startup allocates fast; extrapolating those first seconds to an hour reports a
// leak that isn't there. Wait for a few minutes, then read only recent history so
// an old ramp stops dominating the slope.
const TREND_MIN_SPAN_MS = 180_000
const TREND_WINDOW_MS = 1_200_000

// Module state, not component state: the HUD remounts with the titlebar and the
// history is about the session, not the widget.
const samples: MemorySample[] = []

export function recordMemorySample(sample: MemorySample): readonly MemorySample[] {
  samples.push(sample)
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES)
  return samples
}

export function getMemorySamples(): readonly MemorySample[] {
  return samples
}

export function clearMemorySamples(): void {
  samples.length = 0
}

/**
 * Least-squares slope in MB per hour. Null until there is enough spread in time
 * for a slope to mean anything — two samples 3s apart extrapolate to nonsense.
 */
export function memoryTrendPerHour(history: readonly MemorySample[]): number | null {
  const newest = history[history.length - 1]
  if (newest == null) return null
  const window = history.filter((sample) => newest.atMs - sample.atMs <= TREND_WINDOW_MS)
  const first = window[0]
  if (first == null || window.length < 4) return null
  if (newest.atMs - first.atMs < TREND_MIN_SPAN_MS) return null

  const meanHours = window.reduce((total, sample) => total + sample.atMs, 0) / window.length / 3_600_000
  const meanValue = window.reduce((total, sample) => total + sample.workingSetMegabytes, 0) / window.length
  let covariance = 0
  let variance = 0
  for (const sample of window) {
    const hours = sample.atMs / 3_600_000 - meanHours
    covariance += hours * (sample.workingSetMegabytes - meanValue)
    variance += hours * hours
  }
  return variance === 0 ? null : covariance / variance
}

export function formatTrendPerHour(megabytesPerHour: number | null): string {
  if (megabytesPerHour == null) return 'Measuring…'
  const rounded = Math.round(megabytesPerHour)
  if (rounded === 0) return 'Flat'
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)} MB/h`
}

export function formatSpan(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder === 0 ? `${hours} h` : `${hours} h ${remainder} min`
}

export interface SparklineGeometry {
  line: string
  area: string
  low: number
  high: number
}

/**
 * Plots against wall-clock time rather than sample index: sampling pauses while
 * the window is hidden, and evenly spacing those samples would hide the gap.
 */
export function buildMemorySparkline(
  history: readonly MemorySample[],
  width: number,
  height: number
): SparklineGeometry | null {
  if (history.length < 2) return null
  const first = history[0]
  const last = history[history.length - 1]
  if (first == null || last == null) return null
  const values = history.map((sample) => sample.workingSetMegabytes)
  const low = Math.min(...values)
  const high = Math.max(...values)
  const startMs = first.atMs
  const spanMs = last.atMs - startMs
  if (spanMs <= 0) return null
  // A flat series would divide by zero; draw it down the middle instead.
  const range = high - low
  const points = history.map((sample) => {
    const x = ((sample.atMs - startMs) / spanMs) * width
    const y = range === 0
      ? height / 2
      : height - ((sample.workingSetMegabytes - low) / range) * height
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return {
    line: `M${points.join('L')}`,
    area: `M0,${height.toFixed(1)}L${points.join('L')}L${width.toFixed(1)},${height.toFixed(1)}Z`,
    low,
    high
  }
}
