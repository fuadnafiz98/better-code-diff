import { afterEach, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { PerformanceMetrics, RepositoryApi } from '../../shared/contracts'
import { PerformanceHud } from './PerformanceHud'
import { clearMemorySamples } from './performanceHistory'

afterEach(() => {
  cleanup()
  clearMemorySamples()
  delete window.repository
})

function metrics(sampledAt: number, workingSetMegabytes = 512): PerformanceMetrics {
  return {
    cpuPercent: 1.2,
    gpuProcessCpuPercent: 0.4,
    workingSetMegabytes,
    rendererPrivateMegabytes: 128,
    lastRendererTermination: null,
    processCount: 4,
    production: true,
    sampledAt,
    detail: null
  }
}

test('shows the latest sample time and stops claiming a failed sample is live', async () => {
  const sampledAt = Date.UTC(2026, 7, 26, 12, 34, 56)
  let requestCount = 0
  window.repository = {
    getPerformanceMetrics: async () => {
      requestCount += 1
      if (requestCount === 1) return metrics(sampledAt)
      throw new Error('sampling failed')
    }
  } as unknown as RepositoryApi

  render(<PerformanceHud />)

  await waitFor(() => expect(screen.getByText('Live')).toBeTruthy())
  expect(document.querySelector('time')?.dateTime).toBe(new Date(sampledAt).toISOString())

  fireEvent.click(document.querySelector<HTMLElement>('.performance-hud > summary')!)

  await waitFor(() => expect(screen.getByText('Stale')).toBeTruthy())
  expect(screen.queryByText('Live')).toBeNull()
})

test('shows a visible warning when the working set reaches 1 GB', async () => {
  window.repository = {
    getPerformanceMetrics: async () => metrics(Date.now(), 1_024)
  } as unknown as RepositoryApi

  render(<PerformanceHud />)

  await waitFor(() => expect(document.querySelector('.performance-memory.high-memory')).toBeTruthy())
  expect(document.querySelector('.performance-signal.high-memory')).toBeTruthy()
  expect(document.querySelector('.performance-hud > summary')?.getAttribute('aria-label')).toContain('High memory warning')

  fireEvent.click(document.querySelector<HTMLElement>('.performance-hud > summary')!)
  expect(await screen.findByText('High · 4 processes')).toBeTruthy()
})

test('keeps CPU and GPU out of the titlebar trigger', async () => {
  window.repository = {
    getPerformanceMetrics: async () => metrics(Date.now())
  } as unknown as RepositoryApi

  render(<PerformanceHud />)

  await waitFor(() => expect(document.querySelector('.performance-memory strong')?.textContent).toBe('512 MB'))
  expect(document.querySelector('.performance-hud > summary')?.textContent).not.toMatch(/CPU|GPU/)

  fireEvent.click(document.querySelector<HTMLElement>('.performance-hud > summary')!)
  expect(await screen.findByText('App CPU')).toBeTruthy()
})

test('closes when clicking outside or pressing Escape', async () => {
  window.repository = {
    getPerformanceMetrics: async () => metrics(Date.now())
  } as unknown as RepositoryApi

  render(
    <div>
      <button type="button">outside</button>
      <PerformanceHud />
    </div>
  )

  const hud = (): HTMLDetailsElement => document.querySelector<HTMLDetailsElement>('.performance-hud')!
  fireEvent.click(hud().querySelector('summary')!)
  await waitFor(() => expect(hud().open).toBe(true))

  fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }))
  await waitFor(() => expect(hud().open).toBe(false))

  fireEvent.click(hud().querySelector('summary')!)
  await waitFor(() => expect(hud().open).toBe(true))

  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(hud().open).toBe(false))
})
