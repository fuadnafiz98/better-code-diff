import { afterEach, describe, expect, it } from 'bun:test'

import {
  buildMemorySparkline,
  clearMemorySamples,
  formatSpan,
  formatTrendPerHour,
  getMemorySamples,
  memoryTrendPerHour,
  recordMemorySample,
  type MemorySample
} from './performanceHistory'

function series(count: number, startMegabytes: number, stepMegabytes: number, stepMs = 3_000): MemorySample[] {
  return Array.from({ length: count }, (_unused, index) => ({
    atMs: index * stepMs,
    workingSetMegabytes: startMegabytes + index * stepMegabytes,
    rendererPrivateMegabytes: startMegabytes / 2
  }))
}

afterEach(() => clearMemorySamples())

describe('memoryTrendPerHour', () => {
  it('waits out the startup ramp before reporting a slope', () => {
    expect(memoryTrendPerHour(series(4, 500, 1))).toBeNull()
    expect(memoryTrendPerHour(series(40, 500, 1))).toBeNull()
  })

  it('reports megabytes per hour for a rising series', () => {
    // 1 MB every 3s is 1200 MB/h.
    expect(memoryTrendPerHour(series(80, 500, 1))).toBeCloseTo(1_200, 5)
  })

  it('reports zero for a flat series', () => {
    expect(memoryTrendPerHour(series(80, 500, 0))).toBeCloseTo(0, 5)
  })

  it('reads only recent history, so an old ramp stops dominating', () => {
    const ramp = series(120, 300, 5)
    const settledStart = ramp[ramp.length - 1]?.atMs ?? 0
    const settled = Array.from({ length: 500 }, (_unused, index) => ({
      atMs: settledStart + (index + 1) * 3_000,
      workingSetMegabytes: 900,
      rendererPrivateMegabytes: 400
    }))
    expect(memoryTrendPerHour([...ramp, ...settled])).toBeCloseTo(0, 5)
  })
})

describe('formatTrendPerHour', () => {
  it('labels the unmeasured, flat, rising and falling cases', () => {
    expect(formatTrendPerHour(null)).toBe('Measuring…')
    expect(formatTrendPerHour(0.2)).toBe('Flat')
    expect(formatTrendPerHour(18.6)).toBe('+19 MB/h')
    expect(formatTrendPerHour(-42)).toBe('−42 MB/h')
  })
})

describe('formatSpan', () => {
  it('formats sub-minute, minute and hour spans', () => {
    expect(formatSpan(20_000)).toBe('under a minute')
    expect(formatSpan(9 * 60_000)).toBe('9 min')
    expect(formatSpan(120 * 60_000)).toBe('2 h')
    expect(formatSpan(95 * 60_000)).toBe('1 h 35 min')
  })
})

describe('buildMemorySparkline', () => {
  it('returns null until two samples exist', () => {
    expect(buildMemorySparkline(series(1, 500, 1), 100, 40)).toBeNull()
  })

  it('spans the full box and plots against elapsed time', () => {
    const geometry = buildMemorySparkline(series(3, 500, 10), 100, 40)
    expect(geometry?.low).toBe(500)
    expect(geometry?.high).toBe(520)
    expect(geometry?.line).toBe('M0.0,40.0L50.0,20.0L100.0,0.0')
    expect(geometry?.area.endsWith('L100.0,40.0Z')).toBe(true)
  })

  it('draws a flat series down the middle', () => {
    expect(buildMemorySparkline(series(2, 500, 0), 100, 40)?.line).toBe('M0.0,20.0L100.0,20.0')
  })
})

describe('recordMemorySample', () => {
  it('keeps samples in order and caps the history', () => {
    for (const sample of series(1_300, 100, 1)) recordMemorySample(sample)
    const history = getMemorySamples()
    expect(history.length).toBe(1_200)
    expect(history[history.length - 1]?.workingSetMegabytes).toBe(1_399)
  })
})
