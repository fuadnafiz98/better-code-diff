import { describe, expect, it } from 'vitest'

import { CENTERED_COLLAPSED_SEPARATOR_CSS } from './collapsedSeparator'
import {
  clampSplitPercentage,
  resistedSplitPercentage,
  splitPercentageFromPointer,
  syncSplitDiffResizeLifecycle
} from './splitDiffResize'

describe('split diff resizing', () => {
  it('keeps both code panes within useful limits', () => {
    expect(clampSplitPercentage(10)).toBe(25)
    expect(clampSplitPercentage(42)).toBe(42)
    expect(clampSplitPercentage(90)).toBe(75)
  })

  it('maps the pointer position to the diff surface', () => {
    expect(splitPercentageFromPointer(400, 200, 800)).toBe(25)
    expect(splitPercentageFromPointer(600, 200, 800)).toBe(50)
    expect(splitPercentageFromPointer(1_000, 200, 800)).toBe(75)
  })

  it('uses the balanced split when the surface has no width', () => {
    expect(splitPercentageFromPointer(400, 200, 0)).toBe(50)
  })

  it('answers overshoot with resistance during a drag', () => {
    expect(resistedSplitPercentage(15, 1_000)).toBeGreaterThan(15)
    expect(resistedSplitPercentage(85, 1_000)).toBeLessThan(85)
  })

  it('keeps wrapped unchanged-context labels clear of the divider', () => {
    expect(CENTERED_COLLAPSED_SEPARATOR_CSS).toContain(
      'width: var(--horus-split-before-width, 50cqi)'
    )

    const surface = document.createElement('div')
    surface.className = 'diff-panel'
    const viewer = document.createElement('div')
    surface.append(viewer)
    const root = viewer.attachShadow({ mode: 'open' })
    const splitDiff = document.createElement('pre')
    splitDiff.dataset.diffType = 'split'
    root.append(splitDiff)

    syncSplitDiffResizeLifecycle(viewer, 'mount')
    const handle = root.querySelector<HTMLElement>('[data-split-resize-handle]')
    handle?.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      composed: true,
      key: 'ArrowLeft'
    }))

    expect(surface.style.getPropertyValue('--horus-split-before-width')).toBe('48cqi')
    syncSplitDiffResizeLifecycle(viewer, 'unmount')
  })

  it('coalesces pointer moves and commits the final position on pointer-up', () => {
    const surface = document.createElement('div')
    surface.className = 'diff-panel'
    const viewer = document.createElement('div')
    surface.append(viewer)
    const root = viewer.attachShadow({ mode: 'open' })
    const splitDiff = document.createElement('pre')
    splitDiff.dataset.diffType = 'split'
    root.append(splitDiff)
    viewer.getBoundingClientRect = () => ({
      bottom: 400,
      height: 400,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })

    const originalRequestAnimationFrame = window.requestAnimationFrame
    const originalCancelAnimationFrame = window.cancelAnimationFrame
    let frame: FrameRequestCallback | null = null
    let nextFrame = 0
    const cancelled: number[] = []
    window.requestAnimationFrame = (callback) => {
      frame = callback
      nextFrame += 1
      return nextFrame
    }
    window.cancelAnimationFrame = (id) => { cancelled.push(id) }

    try {
      syncSplitDiffResizeLifecycle(viewer, 'mount')
      const handle = root.querySelector<HTMLElement>('[data-split-resize-handle]')!
      handle.setPointerCapture = () => undefined
      handle.hasPointerCapture = () => true
      handle.releasePointerCapture = () => undefined
      const pointer = (type: string, clientX: number) => new PointerEvent(type, {
        bubbles: true,
        composed: true,
        pointerId: 7,
        button: 0,
        clientX
      })

      handle.dispatchEvent(pointer('pointerdown', 400))
      handle.dispatchEvent(pointer('pointermove', 480))
      handle.dispatchEvent(pointer('pointermove', 560))
      expect(surface.style.getPropertyValue('--horus-split-before')).toBe('')

      const queuedFrame = frame as FrameRequestCallback | null
      expect(queuedFrame).not.toBeNull()
      queuedFrame?.(0)
      expect(surface.style.getPropertyValue('--horus-split-before')).toBe('70fr')

      handle.dispatchEvent(pointer('pointermove', 600))
      handle.dispatchEvent(pointer('pointerup', 600))
      expect(cancelled).toEqual([2])
      expect(surface.style.getPropertyValue('--horus-split-before')).toBe('75fr')
    } finally {
      syncSplitDiffResizeLifecycle(viewer, 'unmount')
      window.requestAnimationFrame = originalRequestAnimationFrame
      window.cancelAnimationFrame = originalCancelAnimationFrame
    }
  })
})
