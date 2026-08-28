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
})
